import { supabase } from "./supabase";
import type { Tables, TablesInsert } from "./database.types";

/* Supabase is the only store. Every read and write goes through supabase-js
   table queries under the signed-in user's JWT; RLS is owner-scoped, so
   `projects`, `people` and `app_state` must carry `owner = session.user.id`
   on insert. `tasks` and `links` inherit ownership through `project_id`.

   Writes are PER ROW. `saveStore` diffs the state the user is looking at
   against the snapshot of what is actually in Postgres (React Query holds that
   snapshot — see features/projects/store.tsx) and emits only the rows that genuinely changed:
   insert on add, update on edit, delete on delete. Nothing here ever deletes a
   whole table or a whole project's rows to re-insert them: an interrupted save
   used to lose every task in every loaded project, and a debounce that runs
   while the user types is exactly where that goes wrong. */

/* Ids are text in Postgres, but the widget mints numeric ids for rows added
   in-session (SVAR's uid() is an incrementing number), so the in-memory shape
   carries the union and PostgREST coerces on the way out. Comparisons below
   go through `key()` so a numeric 7 and the text "7" it became in Postgres are
   the same row — the wire format is left alone. */
export type TaskId = string | number;

export interface Person {
  id: string;
  name: string;
  /* as above: what `people.position` holds, carried on the snapshot side only */
  position?: number;
}

/* the in-memory task shape: dates are ISO day strings here and only become
   Date objects once the widget revives them */
export interface StoreTask {
  id: TaskId;
  text?: string;
  type?: string;
  progress?: number;
  details?: string;
  parent?: TaskId;
  start?: string;
  end?: string;
  duration?: number;
  hours?: number;
  days?: number;
  open?: boolean;
  url?: string;
  assignees?: string | null;
  status?: string;
  /* `tasks.release`: null | "mvp" | "full", constrained in Postgres. Only the
     two container tiers (an epic, a story) ever carry one — a leaf task takes
     the scope of the nearest tier above it, which is a read-side roll-up and
     never a stored value. */
  release?: string | null;
  /* what `tasks.sort_order` actually holds for this row. Only the snapshot side
     carries it — the draft's order is its array order — and it exists so the
     diff can see that the two disagree. See rowsOf(). */
  sortOrder?: number;
}

export interface StoreLink {
  id?: TaskId;
  source?: TaskId;
  target?: TaskId;
  type?: string;
}

export interface StoreProject {
  id: string;
  name: string;
  view: string;
  tasks: StoreTask[];
  links: StoreLink[];
  /* what `projects.position` actually holds — the snapshot's copy of reality,
     which the draft's array index is measured against */
  position?: number;
}

export interface StoreData {
  version: number;
  /* the project `app_state` remembers as last opened; "" when there is none.
     The URL decides which project is open — this is only how `/` resolves. */
  activeProject: string;
  projects: StoreProject[];
  people: Person[];
}

export const EMPTY_STORE: StoreData = { version: 2, activeProject: "", projects: [], people: [] };

/* plain data all the way down, so a structural copy is enough. The draft the
   editor mutates and the snapshot the diff reads must never share objects. */
export function cloneStore(s: StoreData): StoreData {
  return {
    version: s.version,
    activeProject: s.activeProject,
    people: s.people.map((h) => ({ ...h })),
    projects: s.projects.map((p) => ({
      id: p.id,
      name: p.name,
      view: p.view,
      position: p.position,
      tasks: p.tasks.map((t) => ({ ...t })),
      links: p.links.map((l) => ({ ...l })),
    })),
  };
}

/* A save has just written index-derived ordering to Postgres, so the snapshot
   it becomes must say so — otherwise every later diff would keep re-reporting
   the stored values it has already replaced, and rewrite them forever. */
export function normalizeOrder(s: StoreData): StoreData {
  s.projects.forEach((p, i) => {
    p.position = i;
    p.tasks.forEach((t, j) => { t.sortOrder = j; });
  });
  s.people.forEach((h, i) => { h.position = i; });
  return s;
}

/* every call site throws rather than returning a result object: React Query is
   what carries the failure to the UI now */
function check(error: { message?: string } | null, what: string): void {
  if (error) throw new Error(what + ": " + (error.message || "Supabase request failed"));
}

/* An `update … eq(id)` against a row that is no longer there is not an error to
   PostgREST: it matches nothing, returns 204 and reports success. The write
   went nowhere and the UI used to say "Saved". Ask for the affected ids back
   and treat an empty answer as what it is — the row was changed or deleted
   somewhere else, and this tab is looking at a timeline that has moved on. */
export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}
export const isConflict = (e: unknown): boolean => e instanceof StoreConflictError;

function missing(rows: { id: unknown }[] | null, what: string, id: string): void {
  if (rows && rows.length) return;
  throw new StoreConflictError(
    `This ${what} (${id}) is no longer in the database — it was changed or deleted somewhere else. ` +
    "Your copy is still on screen; reload to see the current timeline.",
  );
}

/* ---------- read ---------- */

/* row → the in-memory task shape the widget consumes */
function toTask(t: Tables<"tasks">): StoreTask {
  const o: StoreTask = {
    id: t.id,
    text: t.text || "",
    type: t.type || "task",
    progress: t.progress || 0,
    details: t.details || "",
  };
  if (t.parent_id !== null && t.parent_id !== undefined) o.parent = t.parent_id;
  if (t.start_date) o.start = t.start_date;
  if (t.end_date) o.end = t.end_date;
  if (t.duration !== null && t.duration !== undefined) o.duration = t.duration;
  if (t.hours !== null && t.hours !== undefined) o.hours = Number(t.hours);
  if (t.days !== null && t.days !== undefined) o.days = Number(t.days);
  if (t.open !== null && t.open !== undefined) o.open = t.open;
  if (t.url) o.url = t.url;
  if (t.assignees) o.assignees = t.assignees;
  if (t.release) o.release = t.release;
  o.status = t.status || "todo";
  if (t.sort_order !== null && t.sort_order !== undefined) o.sortOrder = t.sort_order;
  return o;
}

/* one round trip per table; the result is both what the app renders and the
   snapshot every later diff is measured against */
export async function fetchStore(): Promise<StoreData> {
  /* every ordered read carries `id` as a secondary key. `position` and
     `sort_order` are not unique — two projects really do sit on position 0
     today — and Postgres is free to return tied rows in any order it likes, so
     without a tie-break the list could reorder itself between two loads of the
     same unchanged data. */
  const [projects, tasks, links, people, state] = await Promise.all([
    supabase.from("projects").select("id,name,view,position")
      .order("position", { ascending: true }).order("id", { ascending: true }),
    supabase.from("tasks").select("*")
      .order("sort_order", { ascending: true }).order("id", { ascending: true }),
    supabase.from("links").select("id,project_id,source,target,type"),
    supabase.from("people").select("id,name,position")
      .order("position", { ascending: true }).order("id", { ascending: true }),
    /* no `id` filter: RLS already scopes app_state to this account's row, and
       that is the one identity the table has both before and after the
       migration that re-keys it on `owner` (see setActiveProject) */
    supabase.from("app_state").select("id,active_project").limit(1).maybeSingle(),
  ]);
  check(projects.error, "projects");
  check(tasks.error, "tasks");
  check(links.error, "links");
  check(people.error, "people");
  check(state.error, "app_state");

  const list: StoreProject[] = (projects.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    view: p.view || "day",
    position: p.position ?? undefined,
    tasks: (tasks.data || []).filter((t) => t.project_id === p.id).map(toTask),
    links: (links.data || [])
      .filter((l) => l.project_id === p.id)
      .map((l) => ({ id: l.id, source: l.source, target: l.target, type: l.type || "e2s" })),
  }));
  const wanted = state.data && state.data.active_project;
  /* `some` proves `wanted` is one of the ids, which the compiler cannot see */
  const active = list.some((p) => p.id === wanted) ? wanted! : "";
  const roster: Person[] = (people.data || [])
    .filter((x) => x && x.id)
    .map((x) => ({ id: x.id, name: x.name || "", position: x.position ?? undefined }));
  return { version: 2, activeProject: active, projects: list, people: roster };
}

/* ---------- the row shapes we send ----------
   the id columns are widened to the ids the widget actually mints (see TaskId) */
type TaskRow = Omit<TablesInsert<"tasks">, "id" | "parent_id" | "project_id"> & {
  id: TaskId;
  parent_id: TaskId | null;
  project_id: string;
};
type LinkRow = Omit<TablesInsert<"links">, "id" | "source" | "target"> & {
  id: TaskId;
  source: TaskId;
  target: TaskId;
};
type ProjectRow = TablesInsert<"projects">;
type PersonRow = TablesInsert<"people">;

/* tasks carry a self-FK, so a child can never be inserted before its parent */
function parentsFirst(rows: TaskRow[]): TaskRow[] {
  const byId = new Map<string, TaskRow>(rows.map((r) => [key(r.id), r]));
  const out: TaskRow[] = [];
  const done = new Set<string>();
  const visit = (r: TaskRow | undefined, guard: Set<string>) => {
    if (!r || done.has(key(r.id)) || guard.has(key(r.id))) return;
    guard.add(key(r.id));
    if (r.parent_id !== null && r.parent_id !== undefined) visit(byId.get(key(r.parent_id)), guard);
    if (done.has(key(r.id))) return;
    done.add(key(r.id));
    out.push(r);
  };
  rows.forEach((r) => visit(r, new Set<string>()));
  return out;
}

const key = (id: TaskId | null | undefined): string => (id === null || id === undefined ? "" : String(id));

function taskRow(t: StoreTask, projectId: string, i: number): TaskRow {
  return {
    id: t.id,
    project_id: projectId,
    parent_id: t.parent === undefined || t.parent === null || t.parent === 0 ? null : t.parent,
    text: t.text || "",
    type: t.type || "task",
    start_date: t.start || null,
    end_date: t.end || null,
    duration: t.duration ?? null,
    hours: t.hours ?? null,
    days: t.days ?? null,
    progress: Math.round(Number(t.progress) || 0),
    details: t.details || "",
    open: t.open ?? null,
    sort_order: i,
    url: t.url || null,
    status: t.status || "todo",
    assignees: t.assignees || null,
    /* "" is what the editor's select sends for "unassigned"; the column's check
       constraint only allows null, 'mvp' and 'full' */
    release: t.release === "mvp" || t.release === "full" ? t.release : null,
  };
}
const TASK_KEYS: (keyof TaskRow)[] = [
  "id", "project_id", "parent_id", "text", "type", "start_date", "end_date", "duration",
  "hours", "days", "progress", "details", "open", "sort_order", "url", "status", "assignees",
  "release",
];
const LINK_KEYS: (keyof LinkRow)[] = ["id", "project_id", "source", "target", "type"];
const PROJECT_KEYS: (keyof ProjectRow)[] = ["id", "name", "view", "position", "owner"];
const PERSON_KEYS: (keyof PersonRow)[] = ["id", "name", "position", "owner"];

/* a numeric 7 and the text "7" Postgres handed back are the same value; every
   other column is a scalar, so one stringify is the whole comparison */
function same<T extends object>(a: T, b: T, keys: (keyof T)[]): boolean {
  for (const k of keys) {
    const x = a[k], y = b[k];
    const nx = x === null || x === undefined ? null : String(x);
    const ny = y === null || y === undefined ? null : String(y);
    if (nx !== ny) return false;
  }
  return true;
}

interface Write<T> {
  insert: T[];
  update: T[];
}
interface Change<T> extends Write<T> {
  dead: string[];
}
function diffRows<T extends object>(prev: Map<string, T>, next: Map<string, T>, keys: (keyof T)[]): Change<T> {
  const insert: T[] = [];
  const update: T[] = [];
  const dead: string[] = [];
  next.forEach((row, id) => {
    const before = prev.get(id);
    if (!before) insert.push(row);
    else if (!same(before, row, keys)) update.push(row);
  });
  prev.forEach((_row, id) => { if (!next.has(id)) dead.push(id); });
  return { insert, update, dead };
}

/* the whole store as rows, keyed the way the diff compares them. `skip` drops
   the projects that are being deleted: their tasks and links go with them
   through ON DELETE CASCADE, so emitting per-row deletes for them is noise. */
interface Rows {
  projects: Map<string, ProjectRow>;
  tasks: Map<string, TaskRow>;
  links: Map<string, LinkRow>;
  people: Map<string, PersonRow>;
}
/* `ordering` is the whole point of the split. The draft is measured by its
   ARRAY INDEX, because the order the user sees is the order it should have.
   The snapshot is measured by the values Postgres actually returned, because
   that is what the draft has to be compared against. Deriving both sides from
   the index — which is what this used to do — made ordering drift structurally
   invisible: two projects stored on position 0 stayed there forever, because
   position 0 and position 1 were never what the diff was looking at. */
function rowsOf(store: StoreData, ownerId: string, skip: Set<string>, ordering: "index" | "stored"): Rows {
  const projects = new Map<string, ProjectRow>();
  const tasks = new Map<string, TaskRow>();
  const links = new Map<string, LinkRow>();
  const people = new Map<string, PersonRow>();
  const stored = ordering === "stored";
  store.projects.forEach((p, i) => {
    if (skip.has(p.id)) return;
    const pos = stored && p.position !== undefined ? p.position : i;
    projects.set(p.id, { id: p.id, name: p.name || "Untitled project", view: p.view || "day", position: pos, owner: ownerId });
    (p.tasks || []).forEach((t, j) => {
      const order = stored && t.sortOrder !== undefined ? t.sortOrder : j;
      tasks.set(key(t.id), taskRow(t, p.id, order));
    });
    (p.links || []).forEach((l) => {
      if (l.id === undefined || l.source === undefined || l.target === undefined) return;
      links.set(key(l.id), { id: l.id, project_id: p.id, source: l.source, target: l.target, type: l.type || "e2s" });
    });
  });
  (store.people || []).forEach((h, i) => {
    const pos = stored && h.position !== undefined ? h.position : i;
    people.set(h.id, { id: h.id, name: h.name || "", position: pos, owner: ownerId });
  });
  return { projects, tasks, links, people };
}

/* ---------- write ---------- */

/* PostgREST puts `.in()` ids in the query string, so long lists are chunked */
function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
const CHUNK = 150;

/* A save is a sequence of requests, and any one of them can be the last one
   that lands: a dropped connection, a 500, a closed laptop. What follows must
   therefore be safe to run again from the top.

   `insert` was not. One failed step after a successful insert left rows in
   Postgres that the snapshot did not know about, so every later save re-sent
   the same ids and Postgres answered `23505 duplicate key` — for ever, until
   the page was reloaded. Every row here carries its full primary key, so an
   `upsert` writes exactly the same thing the insert would have and re-running
   it is a no-op. Nothing is ever written that the diff did not ask for. */
async function writeTasks(c: Write<TaskRow>) {
  if (c.insert.length) {
    const { error } = await supabase.from("tasks").upsert(parentsFirst(c.insert) as unknown as TablesInsert<"tasks">[]);
    check(error, "insert tasks");
  }
  if (c.update.length === 1) {
    const row = c.update[0];
    const { data, error } = await supabase
      .from("tasks").update(row as unknown as TablesInsert<"tasks">).eq("id", key(row.id)).select("id");
    check(error, "update task");
    missing(data, "task", key(row.id));
  } else if (c.update.length) {
    /* a roll-up, a reorder or an undo touches many rows at once: one upsert of
       exactly those rows, still per row, still nothing else touched */
    const { error } = await supabase.from("tasks").upsert(parentsFirst(c.update) as unknown as TablesInsert<"tasks">[]);
    check(error, "update tasks");
  }
}
async function writeLinks(c: Write<LinkRow>) {
  if (c.insert.length) {
    const { error } = await supabase.from("links").upsert(c.insert as unknown as TablesInsert<"links">[]);
    check(error, "insert links");
  }
  if (c.update.length === 1) {
    const row = c.update[0];
    const { data, error } = await supabase
      .from("links").update(row as unknown as TablesInsert<"links">).eq("id", key(row.id)).select("id");
    check(error, "update link");
    missing(data, "link", key(row.id));
  } else if (c.update.length) {
    const { error } = await supabase.from("links").upsert(c.update as unknown as TablesInsert<"links">[]);
    check(error, "update links");
  }
}
async function writeProjects(c: Write<ProjectRow>) {
  if (c.insert.length) {
    const { error } = await supabase.from("projects").upsert(c.insert);
    check(error, "insert projects");
  }
  if (c.update.length === 1) {
    const { data, error } = await supabase
      .from("projects").update(c.update[0]).eq("id", c.update[0].id).select("id");
    check(error, "update project");
    missing(data, "project", c.update[0].id);
  } else if (c.update.length) {
    const { error } = await supabase.from("projects").upsert(c.update);
    check(error, "update projects");
  }
}
async function writePeople(c: Write<PersonRow>) {
  if (c.insert.length) {
    const { error } = await supabase.from("people").upsert(c.insert);
    check(error, "insert people");
  }
  if (c.update.length === 1) {
    const { data, error } = await supabase
      .from("people").update(c.update[0]).eq("id", c.update[0].id).select("id");
    check(error, "update person");
    missing(data, "person", c.update[0].id);
  } else if (c.update.length) {
    const { error } = await supabase.from("people").upsert(c.update);
    check(error, "update people");
  }
}
async function deleteByIds(table: "tasks" | "links" | "projects" | "people", ids: string[]) {
  for (const part of chunk(ids, CHUNK)) {
    /* by id, never by project_id: this removes exactly the rows the user
       removed, and nothing that merely happens to sit next to them */
    const { error } = await supabase.from(table).delete().in("id", part);
    check(error, "delete " + table);
  }
}

export interface SaveCounts {
  inserted: number;
  updated: number;
  deleted: number;
}

interface StorePlan {
  projects: Change<ProjectRow>;
  tasks: Change<TaskRow>;
  links: Change<LinkRow>;
  people: Change<PersonRow>;
  deadProjects: string[];
}

/* `prev` is what Postgres holds; `next` is what the user is looking at. */
function planWrites(next: StoreData, prev: StoreData, ownerId: string): StorePlan {
  const nextIds = new Set(next.projects.map((p) => p.id));
  const deadProjects = prev.projects.map((p) => p.id).filter((id) => !nextIds.has(id));
  const skip = new Set(deadProjects);

  const a = rowsOf(prev, ownerId, skip, "stored");
  const b = rowsOf(next, ownerId, skip, "index");

  return {
    projects: diffRows(a.projects, b.projects, PROJECT_KEYS),
    tasks: diffRows(a.tasks, b.tasks, TASK_KEYS),
    links: diffRows(a.links, b.links, LINK_KEYS),
    people: diffRows(a.people, b.people, PERSON_KEYS),
    deadProjects,
  };
}

const planSize = (p: StorePlan): number =>
  p.projects.insert.length + p.projects.update.length +
  p.tasks.insert.length + p.tasks.update.length +
  p.links.insert.length + p.links.update.length +
  p.people.insert.length + p.people.update.length +
  p.projects.dead.length + p.tasks.dead.length + p.links.dead.length + p.people.dead.length +
  p.deadProjects.length;

/* how many rows a save would write right now — 0 means the draft and the
   snapshot agree, which is what makes it safe to adopt a newer snapshot */
export function pendingWrites(next: StoreData, prev: StoreData, ownerId: string): number {
  return planSize(planWrites(next, prev, ownerId));
}

/* do two *stored* states differ? Both sides read their own ordering, so this
   answers "has Postgres moved on since we loaded it", not "has the user
   edited anything". */
export function storesDiffer(a: StoreData, b: StoreData, ownerId: string): boolean {
  const none = new Set<string>();
  const x = rowsOf(a, ownerId, none, "stored");
  const y = rowsOf(b, ownerId, none, "stored");
  return planSize({
    projects: diffRows(x.projects, y.projects, PROJECT_KEYS),
    tasks: diffRows(x.tasks, y.tasks, TASK_KEYS),
    links: diffRows(x.links, y.links, LINK_KEYS),
    people: diffRows(x.people, y.people, PERSON_KEYS),
    deadProjects: [],
  }) > 0;
}

export async function saveStore(next: StoreData, prev: StoreData, ownerId: string): Promise<SaveCounts> {
  if (!ownerId) throw new Error("Not signed in");

  const { projects, tasks, links, people, deadProjects } = planWrites(next, prev, ownerId);

  /* order matters. Parents before children (the tasks self-FK), tasks before
     the links that point at them, and every re-parenting written before any
     delete — a task dragged out of an epic must be saved before that epic is
     removed, or ON DELETE CASCADE takes it along. */
  await writeProjects({ insert: projects.insert, update: [] });
  await writeTasks(tasks);
  await writeLinks(links);
  await writeProjects({ insert: [], update: projects.update });
  await writePeople(people);

  if (links.dead.length) await deleteByIds("links", links.dead);
  if (tasks.dead.length) await deleteByIds("tasks", tasks.dead);
  if (deadProjects.length) await deleteByIds("projects", deadProjects);
  if (people.dead.length) await deleteByIds("people", people.dead);

  return {
    inserted: projects.insert.length + tasks.insert.length + links.insert.length + people.insert.length,
    updated: projects.update.length + tasks.update.length + links.update.length + people.update.length,
    deleted: deadProjects.length + tasks.dead.length + links.dead.length + people.dead.length,
  };
}

/* ---------- explicit single-row actions ---------- */

/* creating a project is a deliberate act by the user, so it is its own insert
   rather than something a diff infers. Nothing invents a project on load. */
export async function insertProject(p: StoreProject, position: number, ownerId: string): Promise<void> {
  if (!ownerId) throw new Error("Not signed in");
  const { error } = await supabase
    .from("projects")
    .insert({ id: p.id, name: p.name, view: p.view, position, owner: ownerId });
  check(error, "insert project");
}

/* deleting a project takes its tasks and links with it through the cascades
   already declared on those foreign keys */
export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from("projects").delete().eq("id", id);
  check(error, "delete project");
}

/* `app_state.active_project` is only "last opened" now — the URL is what says
   which project is on screen.

   It used to be a global singleton keyed `id = 'main'`: every account upserted
   the same row, so the second account to try collided on the primary key with
   a row it is not allowed to see, and RLS rejected the write. Sign-up is open,
   so that was reachable.

   The row is identified by its OWNER here, never by a fixed id — the one
   column that names it both under today's `primary key (id)` and under the
   migration that re-keys the table on `owner` (the SQL is in the report).
   Update-then-insert rather than an upsert for the same reason: an upsert has
   to name a conflict target, and the conflict target is exactly what the
   migration changes. Nothing here writes another account's row under either
   schema, and it needs no coordination with the migration to be correct. */
export async function setActiveProject(id: string, ownerId: string): Promise<void> {
  if (!ownerId) throw new Error("Not signed in");
  const value = id || null;
  const upd = await supabase
    .from("app_state")
    .update({ active_project: value })
    .eq("owner", ownerId)
    .select("owner");
  check(upd.error, "app_state");
  if (upd.data && upd.data.length) return;
  /* no row for this account yet — `id` is this account's own uuid, so it can
     never be the id another account is using */
  const ins = await supabase
    .from("app_state")
    .insert({ id: ownerId, active_project: value, owner: ownerId });
  check(ins.error, "app_state");
}
