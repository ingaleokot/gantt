import { supabase } from "./supabase";
import type { Tables, TablesInsert } from "./database.types";

/* Supabase is the only store. Every read and write goes through supabase-js
   table queries under the signed-in user's JWT; RLS is owner-scoped, so
   `projects`, `people` and `app_state` must carry `owner = session.user.id`
   on insert. `tasks` and `links` inherit ownership through `project_id`.

   Writes are PER ROW. `saveStore` diffs the state the user is looking at
   against the snapshot of what is actually in Postgres (React Query holds that
   snapshot — see lib/store.ts) and emits only the rows that genuinely changed:
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

const STATE_ID = "main";

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
      tasks: p.tasks.map((t) => ({ ...t })),
      links: p.links.map((l) => ({ ...l })),
    })),
  };
}

/* every call site throws rather than returning a result object: React Query is
   what carries the failure to the UI now */
function check(error: { message?: string } | null, what: string): void {
  if (error) throw new Error(what + ": " + (error.message || "Supabase request failed"));
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
  o.status = t.status || "todo";
  return o;
}

/* one round trip per table; the result is both what the app renders and the
   snapshot every later diff is measured against */
export async function fetchStore(): Promise<StoreData> {
  const [projects, tasks, links, people, state] = await Promise.all([
    supabase.from("projects").select("id,name,view,position").order("position", { ascending: true }),
    supabase.from("tasks").select("*").order("sort_order", { ascending: true }),
    supabase.from("links").select("id,project_id,source,target,type"),
    supabase.from("people").select("id,name,position").order("position", { ascending: true }),
    supabase.from("app_state").select("id,active_project").eq("id", STATE_ID).maybeSingle(),
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
    .map((x) => ({ id: x.id, name: x.name || "" }));
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
  };
}
const TASK_KEYS: (keyof TaskRow)[] = [
  "id", "project_id", "parent_id", "text", "type", "start_date", "end_date", "duration",
  "hours", "days", "progress", "details", "open", "sort_order", "url", "status", "assignees",
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
function rowsOf(store: StoreData, ownerId: string, skip: Set<string>): Rows {
  const projects = new Map<string, ProjectRow>();
  const tasks = new Map<string, TaskRow>();
  const links = new Map<string, LinkRow>();
  const people = new Map<string, PersonRow>();
  store.projects.forEach((p, i) => {
    if (skip.has(p.id)) return;
    projects.set(p.id, { id: p.id, name: p.name || "Untitled project", view: p.view || "day", position: i, owner: ownerId });
    (p.tasks || []).forEach((t, j) => tasks.set(key(t.id), taskRow(t, p.id, j)));
    (p.links || []).forEach((l) => {
      if (l.id === undefined || l.source === undefined || l.target === undefined) return;
      links.set(key(l.id), { id: l.id, project_id: p.id, source: l.source, target: l.target, type: l.type || "e2s" });
    });
  });
  (store.people || []).forEach((h, i) => people.set(h.id, { id: h.id, name: h.name || "", position: i, owner: ownerId }));
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

/* ESCAPE (x4 below): the id columns are text in Postgres while the widget can
   hand us numeric ids; the values go over the wire exactly as they always did
   and PostgREST coerces them, so only the declared type is bent here. */
async function writeTasks(c: Write<TaskRow>) {
  if (c.insert.length) {
    const { error } = await supabase.from("tasks").insert(parentsFirst(c.insert) as unknown as TablesInsert<"tasks">[]);
    check(error, "insert tasks");
  }
  if (c.update.length === 1) {
    const row = c.update[0];
    const { error } = await supabase.from("tasks").update(row as unknown as TablesInsert<"tasks">).eq("id", key(row.id));
    check(error, "update task");
  } else if (c.update.length) {
    /* a roll-up, a reorder or an undo touches many rows at once: one upsert of
       exactly those rows, still per row, still nothing else touched */
    const { error } = await supabase.from("tasks").upsert(parentsFirst(c.update) as unknown as TablesInsert<"tasks">[]);
    check(error, "update tasks");
  }
}
async function writeLinks(c: Write<LinkRow>) {
  if (c.insert.length) {
    const { error } = await supabase.from("links").insert(c.insert as unknown as TablesInsert<"links">[]);
    check(error, "insert links");
  }
  if (c.update.length === 1) {
    const row = c.update[0];
    const { error } = await supabase.from("links").update(row as unknown as TablesInsert<"links">).eq("id", key(row.id));
    check(error, "update link");
  } else if (c.update.length) {
    const { error } = await supabase.from("links").upsert(c.update as unknown as TablesInsert<"links">[]);
    check(error, "update links");
  }
}
async function writeProjects(c: Write<ProjectRow>) {
  if (c.insert.length) {
    const { error } = await supabase.from("projects").insert(c.insert);
    check(error, "insert projects");
  }
  if (c.update.length === 1) {
    const { error } = await supabase.from("projects").update(c.update[0]).eq("id", c.update[0].id);
    check(error, "update project");
  } else if (c.update.length) {
    const { error } = await supabase.from("projects").upsert(c.update);
    check(error, "update projects");
  }
}
async function writePeople(c: Write<PersonRow>) {
  if (c.insert.length) {
    const { error } = await supabase.from("people").insert(c.insert);
    check(error, "insert people");
  }
  if (c.update.length === 1) {
    const { error } = await supabase.from("people").update(c.update[0]).eq("id", c.update[0].id);
    check(error, "update person");
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

/* `prev` is what Postgres holds; `next` is what the user is looking at. */
export async function saveStore(next: StoreData, prev: StoreData, ownerId: string): Promise<SaveCounts> {
  if (!ownerId) throw new Error("Not signed in");

  const nextIds = new Set(next.projects.map((p) => p.id));
  const deadProjects = prev.projects.map((p) => p.id).filter((id) => !nextIds.has(id));
  const skip = new Set(deadProjects);

  const a = rowsOf(prev, ownerId, skip);
  const b = rowsOf(next, ownerId, skip);

  const projects = diffRows(a.projects, b.projects, PROJECT_KEYS);
  const tasks = diffRows(a.tasks, b.tasks, TASK_KEYS);
  const links = diffRows(a.links, b.links, LINK_KEYS);
  const people = diffRows(a.people, b.people, PERSON_KEYS);

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
   which project is on screen. One upsert, and only when it actually moved. */
export async function setActiveProject(id: string, ownerId: string): Promise<void> {
  if (!ownerId) throw new Error("Not signed in");
  const { error } = await supabase
    .from("app_state")
    .upsert({ id: STATE_ID, active_project: id || null, owner: ownerId });
  check(error, "app_state");
}
