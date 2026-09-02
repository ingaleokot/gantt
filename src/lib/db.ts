import { supabase } from "./supabase";
import type { Tables, TablesInsert } from "./database.types";

/* Supabase is the only store. Every read and write goes through supabase-js
   table queries under the signed-in user's JWT; RLS is owner-scoped, so
   `projects`, `people` and `app_state` must carry `owner = session.user.id`
   on insert. `tasks` and `links` inherit ownership through `project_id`. */

/* Ids are text in Postgres, but the widget mints numeric ids for rows added
   in-session (SVAR's uid() is an incrementing number), so the in-memory shape
   carries the union and PostgREST coerces on the way out. */
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
  activeProject: string;
  projects: StoreProject[];
  people: Person[];
}

export type DbError = { state: "err"; message: string };
export type DbLoadResult = { state: "ok"; data: StoreData | null } | DbError;
export type DbSaveResult = { state: "ok" } | DbError;

const STATE_ID = "main";

function fail(error: { message?: string } | null | undefined): DbError {
  return { state: "err", message: (error && error.message) || "Supabase request failed" };
}

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

export async function dbLoad(): Promise<DbLoadResult> {
  const [projects, tasks, links, people, state] = await Promise.all([
    supabase.from("projects").select("id,name,view,position").order("position", { ascending: true }),
    supabase.from("tasks").select("*").order("sort_order", { ascending: true }),
    supabase.from("links").select("id,project_id,source,target,type"),
    supabase.from("people").select("id,name,position").order("position", { ascending: true }),
    supabase.from("app_state").select("id,active_project").eq("id", STATE_ID).maybeSingle(),
  ]);
  const results: { error: { message?: string } | null }[] = [projects, tasks, links, people, state];
  for (const r of results) {
    if (r.error) return fail(r.error);
  }
  if (!projects.data || !projects.data.length) return { state: "ok", data: null };

  const list: StoreProject[] = projects.data.map((p) => ({
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
  const active = list.some((p) => p.id === wanted) ? wanted! : list[0].id;
  const roster: Person[] = (people.data || [])
    .filter((x) => x && x.id)
    .map((x) => ({ id: x.id, name: x.name || "" }));
  return { state: "ok", data: { version: 2, activeProject: active, projects: list, people: roster } };
}

/* the row shapes we send, with the id columns widened to the ids the widget
   actually mints (see TaskId above) */
type TaskRow = Omit<TablesInsert<"tasks">, "id" | "parent_id" | "project_id"> & {
  id: TaskId;
  parent_id: TaskId | null;
  project_id: string;
};
type LinkRow = Omit<TablesInsert<"links">, "id" | "source" | "target"> & {
  id?: TaskId;
  source?: TaskId;
  target?: TaskId;
};

/* tasks carry a self-FK, so a child can never be inserted before its parent */
function parentsFirst(rows: TaskRow[]): TaskRow[] {
  const byId = new Map<TaskId, TaskRow>(rows.map((r) => [r.id, r]));
  const out: TaskRow[] = [];
  const done = new Set<TaskId>();
  const visit = (r: TaskRow | undefined, guard: Set<TaskId>) => {
    if (!r || done.has(r.id) || guard.has(r.id)) return;
    guard.add(r.id);
    if (r.parent_id !== null && r.parent_id !== undefined) visit(byId.get(r.parent_id), guard);
    if (done.has(r.id)) return;
    done.add(r.id);
    out.push(r);
  };
  rows.forEach((r) => visit(r, new Set<TaskId>()));
  return out;
}

export async function dbSave(data: StoreData, ownerId: string | undefined): Promise<DbSaveResult> {
  if (!ownerId) return { state: "err", message: "Not signed in" };
  const projects = data.projects || [];
  const ids = projects.map((p) => p.id);

  const projectRows: TablesInsert<"projects">[] = projects.map((p, i) => ({
    id: p.id,
    name: p.name || "Untitled project",
    view: p.view || "day",
    position: i,
    owner: ownerId,
  }));
  if (projectRows.length) {
    const r = await supabase.from("projects").upsert(projectRows);
    if (r.error) return fail(r.error);
  }

  /* drop projects that were deleted in this session (diffed, not filtered
     server-side, so no ids ever end up inside a query string) */
  const existing = await supabase.from("projects").select("id");
  if (existing.error) return fail(existing.error);
  const dead = (existing.data || []).map((r) => r.id).filter((id) => !ids.includes(id));
  if (dead.length) {
    const r = await supabase.from("projects").delete().in("id", dead);
    if (r.error) return fail(r.error);
  }

  /* tasks and links are rewritten wholesale for the surviving projects */
  const taskRows: TaskRow[] = [];
  const linkRows: LinkRow[] = [];
  projects.forEach((p) => {
    (p.tasks || []).forEach((t, i) => {
      taskRows.push({
        id: t.id,
        project_id: p.id,
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
      });
    });
    (p.links || []).forEach((l) => {
      if (l.source === undefined || l.target === undefined) return;
      linkRows.push({ id: l.id, project_id: p.id, source: l.source, target: l.target, type: l.type || "e2s" });
    });
  });
  if (ids.length) {
    let r = await supabase.from("links").delete().in("project_id", ids);
    if (r.error) return fail(r.error);
    r = await supabase.from("tasks").delete().in("project_id", ids);
    if (r.error) return fail(r.error);
    if (taskRows.length) {
      /* ESCAPE: the id columns are text in Postgres while the widget can hand
         us numeric ids; the values go over the wire exactly as before and
         PostgREST coerces them, so only the declared type is bent here. */
      r = await supabase.from("tasks").insert(parentsFirst(taskRows) as unknown as TablesInsert<"tasks">[]);
      if (r.error) return fail(r.error);
    }
    if (linkRows.length) {
      /* ESCAPE: same widened-id story as the task rows above. */
      r = await supabase.from("links").insert(linkRows as unknown as TablesInsert<"links">[]);
      if (r.error) return fail(r.error);
    }
  }

  const people = data.people || [];
  if (people.length) {
    const r = await supabase
      .from("people")
      .upsert(people.map((h, i) => ({ id: h.id, name: h.name || "", position: i, owner: ownerId })));
    if (r.error) return fail(r.error);
  }
  const havePeople = await supabase.from("people").select("id");
  if (havePeople.error) return fail(havePeople.error);
  const deadPeople = (havePeople.data || []).map((r) => r.id).filter((id) => !people.some((h) => h.id === id));
  if (deadPeople.length) {
    const r = await supabase.from("people").delete().in("id", deadPeople);
    if (r.error) return fail(r.error);
  }

  const st = await supabase
    .from("app_state")
    .upsert({ id: STATE_ID, active_project: data.activeProject || null, owner: ownerId });
  if (st.error) return fail(st.error);

  return { state: "ok" };
}
