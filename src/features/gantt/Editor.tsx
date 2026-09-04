import React, { useMemo, useRef, useState, useEffect, useCallback, memo } from "react";
import { Gantt, Toolbar, ContextMenu, Editor as TaskEditor } from "@svar-ui/react-gantt";
import type { IApi, IColumnConfig, ILink, IScaleConfig, ITask, TID } from "@svar-ui/react-gantt";
import { Willow as CoreWillow } from "@svar-ui/react-core";
import { Willow as GridWillow } from "@svar-ui/react-grid";
import { Popover } from "@ark-ui/react/popover";
import { Portal } from "@ark-ui/react/portal";
import { Link } from "@tanstack/react-router";
import { CaretLeft, Check, DownloadSimple, Funnel, ShareNetwork, SignOut, Users, X } from "@phosphor-icons/react";
import { buildGanttPdf } from "./pdf";
import type { Person, StoreLink, StoreProject, StoreTask, TaskId } from "../../lib/db";
import { uid, useStore } from "../projects/store";
import { setGlyph, type GlyphHost } from "./icons";
import { installWxiMasks } from "./lib/wxi-masks";
import { trackerId } from "./lib/tracker";
import { initialsOf, nameHue, parseAssignees } from "../people/roster";
import { HOURS_PER_DAY } from "../projects/summary";
import {
  EMPTY_FILTER, RELEASE_INCLUSION_NOTE, RELEASES, TASK_TYPES, UNSET, asWidgetType, effectiveType,
  filterActive, filterCount, filterKey, isTierType, makeFilter, releaseLabel, releaseTitle,
  releaseTotals, scopeOf, usableFilter,
} from "./lib/taxonomy";
import type { FilterRow, FilterState, ReleaseTotals } from "./lib/taxonomy";

/* The stylesheets are imported once by src/main.tsx — the order between them
   is load-bearing, so it lives in one place rather than per screen. */

/* SVAR's own <i class="wxi-…"> icons are masked from custom properties this
   generates out of @phosphor-icons/react. Idempotent, and it runs as the chunk
   loads (never inside a render) so the variables are on :root before the widget
   draws. See ./lib/wxi-masks. */
installWxiMasks();

const DAY = 24 * 60 * 60 * 1000;

/* ---------- library types we have to narrow ----------
   IApi declares getTask as ITask (every field optional), but the store hands
   back a parsed task with id/parent/$level always present, which is what every
   caller below relies on. Only that one member is re-declared — the rest of the
   imperative api keeps the shipped types. */
type GanttApi = Omit<IApi, "getTask"> & { getTask: (id: TID) => ParsedTask };

/* @svar-ui/gantt-store keeps ParsedTask out of its package index, so the
   shape the store actually hands back is spelled out here */
type ParsedTask = ITask & { id: TID; parent: TID; $level: number };

/* the rendered scale cells carry the date each column starts at; the shipped
   GanttScaleCell type only describes width/value/css, so xForDate works
   against this narrower local shape instead */
type ScaleCell = { width: number; date: Date };
type ScaleRow = { cells: ScaleCell[] };
type ScaleData = { rows: ScaleRow[] } | null | undefined;

/* ---------- the three tiers, and the one seam where they are translated ----------
   epic → story → task. SVAR only makes a row a PARENT when its `type` is
   exactly "summary", and there is no second parent type to reach for, so a
   story is handed to the widget as a summary carrying `kind: "story"`.
   `kind` never reaches Postgres — prepareTasks writes it on the way in and
   cleanTask turns it back into `type: "story"` on the way out. The mapping
   itself lives in ./lib/taxonomy so the viewer, the PDF and the projects list
   read it from the same place. */
type WidgetTask = StoreTask & { kind?: string };

/* store tasks with their dates revived: what the widget is handed */
interface RevivedTask extends Omit<WidgetTask, "start" | "end"> {
  start?: Date;
  end?: Date;
}

/* ITask carries an index signature, so `t.kind` would arrive as `any`. These two
   take `unknown` and narrow with a real runtime check instead, so nothing here
   widens and no assertion is made about a shape that was not verified. */
const kindOf = (t: unknown): string | undefined => {
  if (!t || typeof t !== "object") return undefined;
  const k = (t as { kind?: unknown }).kind;
  return typeof k === "string" ? k : undefined;
};
/* the row's REAL tier, whichever side of the seam it came from */
const tierOf = (t: unknown): string => {
  const o = t && typeof t === "object" ? (t as { type?: unknown }) : null;
  const ty = o && typeof o.type === "string" ? o.type : undefined;
  return effectiveType(ty, kindOf(t));
};
/* `dot` has to be a complete literal class string — Tailwind's scanner only
   sees class names that appear verbatim in the source, never ones assembled
   at runtime. Same rule everywhere below. */
const LEGEND = [
  { id: "backend", label: "Backend", dot: "bg-type-backend" },
  { id: "frontend", label: "Frontend", dot: "bg-type-frontend" },
  { id: "design", label: "Design", dot: "bg-type-design" },
  { id: "testing", label: "Testing", dot: "bg-type-testing" },
];

/* ---------- shared utility-class recipes for the app shell ----------
   `press` (style.css, @layer components) is the §1 house default: transform
   feedback that latches on pointer-down, degrading to a brightness step under
   prefers-reduced-motion. `FOCUS` is spelled into every interactive recipe so
   keyboard focus is never the state nobody styled. Sizes come from the rem
   type ramp; arbitrary spacing is rem too, so a larger text setting scales the
   whole control rather than bursting it. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const BTN =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-line bg-surface px-[0.8125rem] py-1.5 font-ui text-small font-medium text-muted hover:bg-surface-hover hover:text-ink ${FOCUS} disabled:cursor-default disabled:opacity-60`;
/* no radius here: each popover sets its own, and two rounded-* utilities on
   one element would race inside @layer utilities. `material-pop` owns the
   background and the shadow (§12), `pop-anim` the anchored entry/exit (§7). */
const POP = "pop-anim material-pop border border-line outline-none";
const POP_TITLE = "mb-1 text-body font-semibold";
const POP_HINT = "m-0 mb-2.5 text-mini text-muted";
const POP_INPUT =
  `min-w-0 flex-1 rounded-lg border border-line bg-surface-alt px-[0.5625rem] py-[0.4375rem] font-ui text-mini text-ink focus:outline-2 focus:outline-accent ${FOCUS}`;
const POP_ACTION =
  `press flex-none cursor-pointer rounded-lg border-0 bg-accent px-3.5 py-[0.4375rem] font-ui text-small font-semibold text-accent-ink hover:brightness-[1.08] active:brightness-[0.94] ${FOCUS}`;
/* an action reduced to its glyph. It still carries an accessible name and a
   tooltip — an icon-only control with neither was the finding this replaces —
   and it keeps the same height as the labelled buttons beside it. */
const BTN_ICON =
  `press press-sm inline-flex h-[30px] w-[30px] flex-none cursor-pointer items-center justify-center rounded-[9px] border border-line bg-surface p-0 text-muted hover:bg-surface-hover hover:text-ink ${FOCUS} disabled:cursor-default disabled:opacity-60`;
const BRAND_MARK =
  "block h-3.5 w-3.5 rounded-[4px] bg-[linear-gradient(135deg,var(--color-accent)_0_50%,var(--color-summary-fill)_50%_100%)]";
/* the filter trigger while something is filtered: a control the user forgot is
   on is worse than no control, so it does not look like the others */
const BTN_ON =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-accent bg-accent-hover px-[0.8125rem] py-1.5 font-ui text-small font-semibold text-accent hover:brightness-[1.04] ${FOCUS}`;
/* both states written out in full: Tailwind only keeps class names it can read
   verbatim, so a conditional spells out the whole list per branch */
const CHIP_OFF =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-[0.1875rem] font-ui text-mini text-muted hover:bg-surface-hover hover:text-ink ${FOCUS}`;
const CHIP_ON =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-accent bg-accent-hover px-2.5 py-[0.1875rem] font-ui text-mini font-semibold text-accent ${FOCUS}`;
const GROUP_LABEL = "m-0 mt-3 mb-1.5 text-label font-semibold text-faint uppercase";

const COLUMNS: IColumnConfig[] = [
  { id: "text", header: "Task name", width: 183, flexgrow: 1, sort: true, editor: "text" },
  /* Release scope, out of the name cell and into a column of its own. It used
     to be appended after the text, in a cell that already carries the tree
     toggle, the type icon, the status dot, the name and the edit pencil — six
     things competing for the width the name needs. The column carries no task
     field (the widget renders it empty, exactly like Who and ID) and the row
     tagger fills it: the pill is solid on the tier that OWNS the scope and
     ghosted on the rows that merely inherit it, which is the same distinction
     the PDF's SCOPE column draws. `sort: false` matters — the header hosts the
     release filter's own trigger, and a sortable header would fight it. */
  { id: "scope", header: "Scope", width: 72, align: "center", sort: false },
  { id: "who", header: "Who", width: 78, align: "center", sort: false },
  { id: "tracker", header: "ID", width: 100, align: "center", sort: false },
  { id: "start", header: "Start", width: 92, align: "center", sort: true },
  /* "Effort", not "Hrs"/"Days": these are how much work the row contains, and
     for an epic they are the sum of its tasks' work — a number that sits next
     to a calendar bar of a completely different length. Labelling them by unit
     alone read as duration. The arithmetic is untouched. */
  { id: "hours", header: "Effort h", width: 84, align: "center", sort: true, editor: "text" },
  { id: "days", header: "Effort d", width: 78, align: "center", sort: true, editor: "text" },
  { id: "add-task", header: "", width: 37, align: "center", sort: false, resize: false },
];

/* ---------- working-time model: estimates in hours, 7h = 1 work day, weekends skipped ----------
   The ratio lives in features/projects/summary.ts because the projects list
   totals effort too, and two copies of it would be two answers. */
const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
function rollForward(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (isWeekend(x)) x.setDate(x.getDate() + 1);
  return x;
}
/* end date (exclusive) after consuming n working days from a working start */
function addWorkDays(start: Date, n: number) {
  const x = new Date(start.getTime());
  let left = Math.max(1, n);
  while (left > 1) {
    x.setDate(x.getDate() + 1);
    if (!isWeekend(x)) left--;
  }
  const e = new Date(x.getTime());
  e.setDate(e.getDate() + 1);
  return e;
}
function workDaysBetween(s: Date, e: Date) {
  let c = 0;
  const x = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  while (x < e) {
    if (!isWeekend(x)) c++;
    x.setDate(x.getDate() + 1);
  }
  return Math.max(1, c);
}
const isBar = (t: { type?: string } | null | undefined) => t && t.type !== "summary" && t.type !== "milestone";
/* returns corrected {hours, start, end, duration} for a plain task */
function scheduleFromHours(hours: number | undefined, startLike: Date | undefined) {
  const start = rollForward(startLike instanceof Date ? startLike : new Date());
  const h = Math.max(0.5, Math.round((Number(hours) || HOURS_PER_DAY) * 2) / 2);
  const end = addWorkDays(start, Math.ceil(h / HOURS_PER_DAY));
  const days = Math.round((h / HOURS_PER_DAY) * 10) / 10;
  return { hours: h, days, start, end, duration: Math.round((+end - +start) / DAY) };
}

const TOOLBAR_ITEMS = [
  { id: "add-task", comp: "button", icon: "wxi-plus", text: "New task", type: "primary" },
  { id: "edit-task", comp: "icon", icon: "wxi-edit", menuText: "Edit", text: "Ctrl+E" },
  { id: "delete-task", comp: "icon", icon: "wxi-delete", menuText: "Delete", text: "Ctrl+D, Backspace" },
  { comp: "separator" },
  { id: "move-task:up", comp: "icon", icon: "wxi-angle-up", menuText: "Move up" },
  { id: "move-task:down", comp: "icon", icon: "wxi-angle-down", menuText: "Move down" },
];

/* "" rather than null: SVAR's select needs a value for the empty choice, and
   db.ts maps anything that is not "mvp"/"full" back to a NULL column.

   These labels are NOT the filter's labels, on purpose. In the filter, picking
   "Full release" asks for the whole release and therefore returns the MVP rows
   too; here the same two ids are being ASSIGNED to a tier, where `full` means
   "ships in the full release and not in the MVP". Saying that out loud is the
   difference between a scope the user can reason about and one they guess at. */
const RELEASE_OPTIONS = [
  { id: "", label: "Unassigned" },
  { id: "mvp", label: "MVP — also in the full release" },
  { id: "full", label: "Full release only — not in the MVP" },
];

const EDITOR_ITEMS = [
  { key: "text", comp: "text", label: "Name", config: { placeholder: "Add task name" } },
  { key: "details", comp: "textarea", label: "Description", config: { placeholder: "Add description" } },
  /* `kind`, not `type`: the widget's `type` is "summary" for both container
     tiers, so a select bound to it would show a story as an epic. The modal
     edits the real tier and the update-task intercept derives `type` from it. */
  { key: "kind", comp: "select", label: "Type", options: TASK_TYPES },
  /* only the two tiers can be scoped — a leaf task inherits the scope of the
     nearest one above it rather than carrying its own */
  { key: "release", comp: "select", label: "Release scope", options: RELEASE_OPTIONS,
    /* the tier, not the drawn type — an empty nested story is handed to the
       widget as a plain bar and must still be scopeable */
    isHidden: (t: ITask) => !isTierType(tierOf(t)) },
  { key: "status", comp: "select", label: "Status", options: [
    { id: "todo", label: "Not started" },
    { id: "progress", label: "In progress" },
    { id: "done", label: "Done" },
  ] },
  { key: "url", comp: "text", label: "Link (e.g. Yandex Tracker)", config: { placeholder: "https://tracker.yandex.com/PRODUCT-123" } },
  { key: "start", comp: "date", label: "Start date", config: { format: "%d-%m-%Y" }, isHidden: (t: ITask) => t.type === "summary" },
  /* effort, not elapsed time — 7 h of effort is one working day of it */
  { key: "hours", comp: "counter", label: "Effort (hours of work)", config: { min: 1 }, isHidden: (t: ITask) => !isBar(t) },
  { key: "days", comp: "text", label: "Effort (working days, 7 h each)", config: { placeholder: "e.g. 1.5" }, isHidden: (t: ITask) => !isBar(t) },
  { key: "progress", comp: "slider", label: "Progress", config: { min: 0, max: 100 }, isHidden: (t: ITask) => t.type === "milestone" },
  { key: "links", comp: "links", label: "", batch: "links" },
];

function reviveTask(t: StoreTask): RevivedTask {
  /* start/end come in as ISO day strings and leave as Dates, so the copy is
     retyped once here rather than rebuilt field by field */
  const out = { ...t } as unknown as RevivedTask;
  if (t.start) out.start = new Date(t.start + "T00:00:00");
  if (t.end) out.end = new Date(t.end + "T00:00:00");
  return out;
}
/* epics and stories recalculate from their children when parsed without dates;
   plain tasks are normalized to the hours model (weekends skipped) */
function prepareTasks(tasks: StoreTask[]): RevivedTask[] {
  const parents = new Set(tasks.map((t) => t.parent).filter((p) => p !== undefined && p !== null && p !== 0));
  return tasks.map((t) => {
    const r = reviveTask(t);
    /* `open` belongs to a branch and nothing else. A leaf that carries it —
       an epic emptied of its tasks, then reloaded — sends the store's tree
       walker into `null.forEach` and takes the whole editor down before it
       draws. Only what has children may keep it, which is what the read-only
       viewer already derives rather than trusts. */
    if (!parents.has(r.id)) delete r.open;
    /* THE tier seam, inbound. This line used to be
         if (parents.has(r.id) && r.type !== "summary") r.type = "summary";
       which overwrote the stored type in place — and since cleanTask's KEEP
       list round-trips `type`, the coercion was written straight back to
       Postgres. Every story would have become an epic on the first save.
       Now the real tier is kept in `kind` and only the widget-facing `type`
       is coerced: a story stays a story in the database for ever. */
    const stored = r.type || "task";
    const tier = isTierType(stored) || parents.has(r.id)
      ? (stored === "story" ? "story" : "summary")
      : stored;
    r.kind = tier;
    /* An empty container cannot be a widget summary while it is NESTED. SVAR's
       date roll-up (normalizeDates → getSummaryDates) recurses into every
       descendant of a summary that has no dates of its own, and throws
       "Summary tasks must have start and end dates if they have no subtasks"
       the moment it reaches one with nothing inside — the empty row's own dates
       do not save it, and neither does its parent's. So an empty nested tier is
       handed over as a plain bar: `kind` still says which tier it is, the row
       still shows its icon, rail and release marker, the STORED type is
       untouched, and it becomes a summary again the second it gains a child.
       A top-level empty tier is not reachable by that recursion and keeps the
       behaviour it has always had. */
    const nestedRow = r.parent !== undefined && r.parent !== null && r.parent !== 0;
    r.type = isTierType(tier) && (parents.has(r.id) || !nestedRow) ? "summary"
      : isTierType(tier) ? "task"
      : asWidgetType(tier);
    if (r.type === "summary" && parents.has(r.id)) { delete r.start; delete r.end; delete r.duration; return r; }
    if (r.type === "summary" && !r.start) {
      /* a childless epic — or a childless story — must carry dates or the
         widget throws on parse */
      r.start = rollForward(new Date());
      r.end = addWorkDays(r.start, 1);
      r.duration = Math.round((+r.end - +r.start) / DAY);
      return r;
    }
    if (isBar(r)) {
      if (!r.hours) {
        r.hours = (r.start && r.end ? workDaysBetween(r.start, r.end) : Math.max(1, r.duration || 1)) * HOURS_PER_DAY;
      }
      const fixed = scheduleFromHours(r.hours, r.start || new Date());
      r.hours = fixed.hours; r.start = fixed.start; r.end = fixed.end; r.duration = fixed.duration;
      /* a row stored before `days` existed has none; derive it from the hours
         exactly as the viewer does, so the same task never reads differently
         on the two pages */
      if (!r.days) r.days = fixed.days;
    }
    return r;
  });
}
function fmtDate(d: Date | undefined): string | undefined {
  if (!(d instanceof Date) || isNaN(+d)) return undefined;
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/* ---------- serialize widget state back to plain data ---------- */
const KEEP = ["id", "text", "start", "end", "duration", "hours", "days", "progress", "parent", "type", "open", "details", "url", "status", "assignees", "kind", "release"];
function cleanTask(t: ITask): StoreTask {
  const out: Partial<WidgetTask> = {};
  for (const k of KEEP) {
    if (t[k] === undefined || t[k] === null) continue;
    /* the KEEP loop copies by dynamic key, so the write side is untyped and
       the whole object is asserted once on the way out */
    (out as Record<string, unknown>)[k] = t[k];
  }
  if (out.start) out.start = fmtDate(t.start);
  if (out.end) out.end = fmtDate(t.end);
  if (out.parent === 0) delete out.parent;
  /* THE tier seam, outbound: the widget only ever knows "summary", so what goes
     to Postgres is the real tier `kind` names. `kind` itself is never stored —
     it is reconstructed from `type` on the next load. */
  out.type = effectiveType(out.type, out.kind);
  delete out.kind;
  return out as StoreTask;
}
function extractTasks(api: GanttApi): StoreTask[] {
  const st = api.getState();
  const tasks = st.tasks;
  const out: StoreTask[] = [];
  const seen = new Set<TaskId>();
  const push = (t: ITask) => {
    if (!t || t.id === undefined || t.id === 0 || seen.has(t.id)) return;
    seen.add(t.id);
    out.push(cleanTask(t));
  };
  const walk = (arr: ITask[] | undefined) => { if (arr) arr.forEach((t) => { push(t); walk(t.data); }); };
  if (Array.isArray(tasks)) walk(tasks);
  else if (tasks && tasks._pool instanceof Map) tasks._pool.forEach(push);
  else if (tasks && typeof tasks.forEach === "function") tasks.forEach(push);
  return out;
}
function extractLinks(api: GanttApi): StoreLink[] {
  const st = api.getState();
  const links = st.links;
  const out: StoreLink[] = [];
  const push = (l: ILink) => { if (l && l.id !== undefined) out.push({ id: l.id, source: l.source, target: l.target, type: l.type }); };
  if (Array.isArray(links)) links.forEach(push);
  else if (links && typeof links.map === "function") links.map(push);
  else if (links && typeof links.forEach === "function") links.forEach(push);
  return out;
}
function serializeSide(api: GanttApi, kind: "tasks"): StoreTask[];
function serializeSide(api: GanttApi, kind: "links"): StoreLink[];
function serializeSide(api: GanttApi, kind: "tasks" | "links"): StoreTask[] | StoreLink[] {
  try {
    /* serialize's return type is a union keyed by the runtime `data` option,
       which the compiler cannot follow — narrow it to the side we asked for */
    const arr = api.serialize({ data: kind }) as unknown[] | null;
    if (Array.isArray(arr)) {
      return kind === "tasks"
        ? (arr as ITask[]).map(cleanTask)
        : (arr as ILink[]).map((l) => ({ id: l.id, source: l.source, target: l.target, type: l.type }));
    }
  } catch (e) { /* fall through */ }
  return kind === "tasks" ? extractTasks(api) : extractLinks(api);
}

/* ---------- share link: the public read-only route, per project ---------- */
const shareUrl = (projectId: string) =>
  new URL(import.meta.env.BASE_URL + "share/" + projectId, window.location.origin).href;

/* project totals: effort over all tasks, span over all dates */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtD = (d: Date) => d.getDate() + " " + MON[d.getMonth()];
interface Stats {
  h: number;
  d: number;
  min: Date | null;
  max: Date | null;
  tasks: number;
  epics: number;
  stories: number;
  /* the same effort split by the scope each task inherits, so "what does MVP
     cost" is answerable without opening every epic */
  release: ReleaseTotals;
}
/* Totals are always the WHOLE project, filter or no filter: serializeSide reads
   the widget's full tree (see applyFilterTo), and a number that silently meant
   something different depending on a filter would be worse than no number. */
function computeStats(api: GanttApi): Stats | null {
  let list: StoreTask[] = [];
  try { list = serializeSide(api, "tasks"); } catch (e) { return null; }
  let h = 0, tasks = 0, epics = 0, stories = 0, min: string | null = null, max: string | null = null;
  list.forEach((t) => {
    /* `list` carries STORED types, so a story is "story" here */
    const ty = t.type || "task";
    if (ty === "summary") { epics++; }
    else if (ty === "story") { stories++; }
    else if (ty !== "milestone") { tasks++; h += Number(t.hours) || 0; }
    /* a tier's dates are its children's, so counting them would only repeat
       what those children already contributed */
    if (!isTierType(ty)) {
      if (t.start && (!min || t.start < min)) min = t.start;
      const e = t.end || t.start;
      if (e && (!max || e > max)) max = e;
    }
  });
  return {
    h: Math.round(h * 2) / 2,
    d: Math.round((h / HOURS_PER_DAY) * 10) / 10,
    min: min ? new Date(min + "T00:00:00") : null,
    max: max ? new Date(max + "T00:00:00") : null,
    tasks, epics, stories,
    release: releaseTotals(list, (t) => Number(t.hours) || 0),
  };
}

/* ---------- filtering: a view, never a write ----------
   The trap here is specific and fatal. The editor serializes the widget into the
   draft on every change, and the save diffs that draft against the snapshot —
   a row that is in the snapshot and not in the draft is emitted as a DELETE. So
   handing the widget a reduced dataset would make the next save delete every
   filtered-out task.

   Nothing here reduces the dataset. SVAR's own `filter-tasks` action calls
   `tree.filterTree()`, which does one thing: it records the set of ids that
   should be VISIBLE (`_filteredIds`). `tree.toArray()` — the rendered rows —
   honours it; `tree.serialize()`, which is what `api.serialize({data:"tasks"})`
   returns and therefore what every save, roll-up, total and undo entry is built
   from, walks the full pool and never looks at it. The draft keeps every row
   while the screen shows some of them.

   `open: false` is deliberate as well: with `open: true` the library sets
   `task.open = true` on every ancestor of a match, `open` IS a persisted
   column, and merely applying a filter would have dirtied rows. The cost is
   that a collapsed epic containing a match stays collapsed — the epic itself is
   still shown, because SVAR keeps any branch with a surviving descendant, so
   the hierarchy above a match is never orphaned.

   Returns how many rows match, for the header count and the empty state. */
function applyFilterTo(api: GanttApi, f: FilterState, roster: Person[]): { shown: number; total: number } {
  let list: StoreTask[] = [];
  try { list = serializeSide(api, "tasks"); } catch (e) { return { shown: 0, total: 0 }; }
  /* a person removed from the roster while their id sat in the URL must not
     hide the whole timeline — usableFilter drops ids nobody holds any more */
  const usable = usableFilter(f, new Set(roster.map((h) => h.id)));
  if (!filterActive(usable)) {
    try { api.exec("filter-tasks", {}); } catch (e) {}
    return { shown: list.length, total: list.length };
  }
  const by = new Map<string, FilterRow>();
  list.forEach((t) => by.set(String(t.id), t));
  const lookup = (id: string | number): FilterRow | null => by.get(String(id)) || null;
  /* one predicate for both shapes: it reads the tier through effectiveType, so
     the stored rows in `list` ("story") and the parsed rows the widget hands it
     ("summary" + kind) answer identically */
  const match = makeFilter(usable, lookup);
  const shown = list.filter((t) => match(t)).length;
  try { api.exec("filter-tasks", { filter: match, open: false }); } catch (e) {}
  return { shown, total: list.length };
}

/* map a date to an x position using the rendered scale cells */
function xForDate(sc: ScaleData, date: Date): number | null {
  const row = sc && sc.rows && sc.rows[sc.rows.length - 1];
  if (!row || !row.cells.length) return null;
  const t = date.getTime();
  let x = 0;
  for (let i = 0; i < row.cells.length; i++) {
    const c = row.cells[i];
    const cs = c.date.getTime();
    let ce;
    if (i + 1 < row.cells.length) ce = row.cells[i + 1].date.getTime();
    else ce = cs + (i > 0 ? cs - row.cells[i - 1].date.getTime() : DAY);
    if (t < cs) return x;
    if (t < ce) return x + ((t - cs) / (ce - cs)) * c.width;
    x += c.width;
  }
  return x;
}
function renderProjectSpan(api: GanttApi) {
  const scaleEl = document.querySelector<HTMLElement>(".gantt-holder .wx-chart > .wx-scale");
  if (!scaleEl) return;
  let el = scaleEl.querySelector<HTMLElement>(":scope > .project-span");
  const stats = computeStats(api);
  const sc = api.getState()._scales as unknown as ScaleData;
  if (!stats || !stats.min || !stats.max || !sc) { if (el) el.remove(); return; }
  const x0 = xForDate(sc, stats.min), x1 = xForDate(sc, stats.max);
  if (x0 === null || x1 === null || x1 - x0 < 2) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.className = "project-span";
    el.title = "Project span";
    scaleEl.appendChild(el);
  }
  el.style.left = Math.round(x0) + "px";
  el.style.width = Math.round(x1 - x0) + "px";
}

/* ---------- what a bar drag actually commits ----------
   The widget does not hand the intercept the dates the user dragged to. On
   pointer-up it reads the task back UNCHANGED and sends those values together
   with a separate `diff` in whole scale units, and its own handler is what
   applies the diff afterwards:

     mode "move"  → task {start, end} (both current) + diff  → shift both
     mode "start" → task {start}      (current)      + diff  → left edge moves
     mode "end"   → task {end}        (current)      + diff  → right edge moves

   The intercept runs BEFORE that handler, so comparing ev.task.start/end to
   the stored task always said "unchanged" and the resize branch below was
   unreachable. Worse, writing a normalized {start, end} pair into ev.task made
   the store take its two-endpoint path for every mode, so dragging either edge
   moved the whole bar instead of resizing it.

   So a drag is left alone on the way in and normalized on the way out, in the
   `update-task` handler that runs after the store has applied the diff. The
   mode is read off the shape of the event, which is the only place it survives.
   Moving keeps the estimate and re-rolls the start off a weekend; resizing
   takes the new span as the new estimate and snaps it back onto working days. */
type DragMode = "move" | "start" | "end";
function dragModeOf(ev: { diff?: number; task?: Partial<ITask> | null }): DragMode | null {
  if (!ev.diff || !ev.task) return null;
  const hasStart = ev.task.start !== undefined;
  const hasEnd = ev.task.end !== undefined;
  if (hasStart && hasEnd) return "move";
  if (hasStart) return "start";
  if (hasEnd) return "end";
  return null;
}
/* set by the intercept, consumed by the handler that runs after the store has
   applied the diff — the only place the drag's mode is still known */
let pendingDrag: { id: TID; mode: DragMode; hours: number } | null = null;

/* Epic and story estimates roll up from what is inside them, however deep:
   an epic of stories of tasks totals its tasks exactly once, because a tier
   contributes its children's sum rather than its own stored hours. */
let ROLLUP_WRITE = false;
function rollupEpics(api: GanttApi) {
  let list: StoreTask[] = [];
  try { list = serializeSide(api, "tasks"); } catch (e) { return; }
  const byParent: Record<string, StoreTask[]> = {};
  list.forEach((t) => { const p = t.parent === undefined ? 0 : t.parent; (byParent[p] = byParent[p] || []).push(t); });
  /* plan the derived writes first */
  const writes: { id: TaskId; task: Partial<ITask> }[] = [];
  list.forEach((t) => {
    /* a plain row that has gained children becomes an epic; a story already IS
       a container, so it keeps its tier instead of being promoted out of it */
    if (!isTierType(t.type) && (byParent[t.id] || []).length) {
      writes.push({ id: t.id, task: { type: "summary", kind: "summary" } });
      t.type = "summary";
    }
  });
  const sumOf = (id: TaskId): number => {
    let s = 0;
    (byParent[id] || []).forEach((c) => {
      /* both tiers recurse, so nesting never double-counts */
      if (isTierType(c.type)) s += sumOf(c.id);
      else if (c.type !== "milestone") s += Number(c.hours) || 0;
    });
    return s;
  };
  /* An epic with nothing under it has no roll-up to compute: the sum would be
     0, and because the update-task intercept refuses manual hours on a summary
     the user could never put the number back. Converting a task to an epic used
     to erase its estimate that way, silently and permanently. Leave a childless
     epic's stored estimate exactly where it is — the moment it gains a task the
     roll-up takes over again. The same is true of a childless story. */
  list.filter((t) => isTierType(t.type) && (byParent[String(t.id)] || []).length > 0).forEach((e) => {
    const h = Math.round(sumOf(e.id) * 2) / 2;
    const d = Math.round((h / HOURS_PER_DAY) * 10) / 10;
    if (Number(e.hours) !== h || Number(e.days) !== d) writes.push({ id: e.id, task: { hours: h, days: d } });
  });
  if (!writes.length) return;
  ROLLUP_WRITE = true;
  writes.forEach((w) => { try { api.exec("update-task", w); } catch (err) {} });
  ROLLUP_WRITE = false;
}

/* tag grid rows and paint epic bands on the chart so the epic → task
   hierarchy is visible on both sides; rows/bars are re-rendered by the
   widget, so redo the work whenever the gantt's DOM changes */
let rowTagObserver: MutationObserver | null = null;
let retagHook: (() => void) | null = null;
/* the row tagger lives outside React; these bridge it back to the app */
let rosterRef: Person[] = [];
let pickHook: ((taskId: TID, hostEl: HTMLElement) => void) | null = null;
/* what the release dimension of the filter currently holds, so the Scope
   column's own header control can show whether it is constraining. Written by
   an effect, read by the tagger — the same bridge `rosterRef` uses. */
let releaseFilterRef: string[] = [];
let scopeFilterHook: ((hostEl: HTMLElement) => void) | null = null;
const personById = (id: string): Person | null => rosterRef.find((h) => h.id === id) || null;

/* ---------- the row's release scope, for the Scope column ----------
   `scopeOf` in ./lib/taxonomy is the one implementation of "a leaf inherits the
   nearest tier's scope", and it is what the filter, the totals and the PDF all
   read. The tagger reaches it through this adapter rather than walking parents
   itself, so the column can never disagree with the filter that sits above it.
   ITask carries an index signature, so every field is narrowed by a real
   runtime check on the way across. */
function asFilterRow(t: ParsedTask): FilterRow {
  return {
    id: t.id,
    parent: t.parent,
    type: typeof t.type === "string" ? t.type : null,
    kind: kindOf(t) ?? null,
    release: typeof t.release === "string" ? t.release : null,
  };
}
function scopeOfTask(api: GanttApi, t: ParsedTask): string {
  const lookup = (id: TaskId): FilterRow | null => {
    try { return asFilterRow(api.getTask(id)); } catch (e) { return null; }
  };
  return scopeOf(asFilterRow(t), lookup);
}
/* Both branches, and both weights, written out in full: Tailwind aside, these
   are CSS-backed semantic names and a class assembled from parts is the one
   mistake that works in dev and vanishes from the production build. `rel-soft`
   is the inherited weight — the pill is ghosted on a row that merely sits under
   a scoped tier, solid on the tier that carries the scope itself. */
function scopeCellClass(scope: string, owned: boolean): string {
  if (scope === "mvp") return owned ? "release-tag rel-mvp" : "release-tag rel-mvp rel-soft";
  return owned ? "release-tag rel-full" : "release-tag rel-full rel-soft";
}
function setAllEpicsOpen(api: GanttApi, open: boolean) {
  let list: StoreTask[] = [];
  try { list = serializeSide(api, "tasks"); } catch (e) { return; }
  const parents = new Set(list.map((t) => t.parent).filter((p) => p !== undefined && p !== null && p !== 0));
  list.forEach((t) => {
    if (parents.has(t.id) && Boolean(t.open) !== open) {
      try { api.exec("open-task", { id: t.id, mode: open }); } catch (e) {}
    }
  });
}
function syncFoldAllButton(api: GanttApi) {
  const headerCell = document.querySelector<HTMLElement>('.gantt-holder [data-header-id=":text"]');
  if (!headerCell) return;
  let btn = headerCell.querySelector<HTMLButtonElement>(".fold-all");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fold-all";
    const icon = document.createElement("span");
    icon.className = "ci";
    btn.appendChild(icon);
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setAllEpicsOpen(api, btn!.dataset.next === "expand");
    });
    headerCell.appendChild(btn);
  }
  let anyOpen = false;
  try {
    const list = serializeSide(api, "tasks");
    const parents = new Set(list.map((t) => t.parent).filter((p) => p !== undefined && p !== null && p !== 0));
    anyOpen = list.some((t) => parents.has(t.id) && Boolean(t.open));
    btn.hidden = !parents.size;
  } catch (e) {}
  btn.dataset.next = anyOpen ? "collapse" : "expand";
  btn.title = anyOpen ? "Collapse all epics and stories" : "Expand all epics and stories";
  /* the button is built just above with exactly one <span class="ci"> child */
  const icon = btn.firstChild as GlyphHost;
  const name = anyOpen ? "ci-collapse" : "ci-expand";
  const cls = "ci " + name;
  if (icon.className !== cls) icon.className = cls;
  setGlyph(icon, name); /* cached Phosphor SVG, rendered once at module scope */
}
/* ---------- the release filter, reachable from the column it filters ----------
   The Scope column's header carries its own trigger, so the dimension is one
   click from the data instead of only inside the header popover. It is built
   the way `.fold-all` is and for the same reasons: APPENDED into the header
   cell (never inserted between React-managed nodes), positioned by CSS, with
   pointerdown stopped so the grid's own header handlers do not see it. The
   column is declared `sort: false`, so there is no sorting for it to fight.
   The popover itself is React's — this only hands the element over. */
function syncScopeFilterButton() {
  const headerCell = document.querySelector<HTMLElement>('.gantt-holder [data-header-id=":scope"]');
  if (!headerCell) return;
  let btn = headerCell.querySelector<HTMLButtonElement>(".col-filter");
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "col-filter";
    btn.type = "button";
    const icon = document.createElement("span");
    icon.className = "ci ci-filter";
    setGlyph(icon, "ci-filter");
    btn.appendChild(icon);
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (scopeFilterHook && btn) scopeFilterHook(btn);
    });
    headerCell.appendChild(btn);
  }
  const n = releaseFilterRef.length;
  /* both class strings spelled out */
  const cls = n ? "col-filter is-on" : "col-filter";
  if (btn.className !== cls) btn.className = cls;
  const label = n ? "Filter by release scope — " + n + " selected" : "Filter by release scope";
  if (btn.title !== label) { btn.title = label; btn.setAttribute("aria-label", label); }
}
/* assignees (a comma-separated list of people ids, shown as initials) and the
   tracker-id extraction are imported at the top: features/people/roster and
   ./lib/tracker, shared verbatim with the public viewer. */
/* the tagger stamps a signature onto the nodes it owns so a re-run can skip
   the ones already showing the right thing */
type KeyedHost = HTMLElement & { __key?: string };
type BandLayer = HTMLElement & { __html?: string };
function renderEpicBands(api: GanttApi) {
  const area = document.querySelector<HTMLElement>(".gantt-holder .wx-area");
  if (!area) return;
  let layer = area.querySelector<BandLayer>(":scope > .epic-bands");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "epic-bands";
    const hol = area.querySelector(":scope > .wx-gantt-holidays");
    if (hol) hol.after(layer); else area.prepend(layer);
  }
  let rows: ParsedTask[] = [];
  let ch = 38;
  try {
    const st = api.getState();
    ch = st.cellHeight || 38;
    rows = (st._tasks || []).filter((t) => !t.$skip);
  } catch (e) { return; }
  let html = "";
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    /* both tiers are "summary" to the widget; the class is what separates them */
    if (t.type !== "summary") continue;
    let j = i + 1;
    while (j < rows.length && rows[j].$level > t.$level) j++;
    if (j === i + 1) continue; /* collapsed or childless: no band */
    /* literal class strings, both branches spelled out — Tailwind aside, these
       are CSS-backed semantic names and must never be assembled from parts */
    const cls = tierOf(t) === "story" ? "epic-band band-story" : "epic-band";
    html += '<div class="' + cls + '" style="top:' + i * ch + "px;height:" + (j - i) * ch + 'px"></div>';
  }
  if (layer.__html !== html) { layer.innerHTML = html; layer.__html = html; }
}
function watchRowTags(api: GanttApi) {
  if (rowTagObserver) { rowTagObserver.disconnect(); rowTagObserver = null; }
  let raf = 0;
  const tag = () => {
    raf = 0;
    document.querySelectorAll<HTMLElement>(".gantt-holder .wx-row[data-id]").forEach((row) => {
      const raw = row.getAttribute("data-id") || "";
      const id = raw.startsWith(":") ? raw.slice(1) : raw;
      let t: ParsedTask | null = null;
      try { t = api.getTask(id); } catch (e) {}
      if (!t && /^\d+$/.test(id)) { try { t = api.getTask(Number(id)); } catch (e) {} }
      if (!t) return;
      /* the row's real tier, not the widget's coerced one */
      const tier = tierOf(t);
      const nested = !isTierType(tier) && (t.$level || 1) > 1;
      let parentTier: string | null = null;
      if (nested && t.parent !== undefined && t.parent !== null && t.parent !== 0) {
        try { parentTier = tierOf(api.getTask(t.parent)); } catch (e) {}
      }
      row.classList.toggle("is-epic", tier === "summary");
      row.classList.toggle("is-story", tier === "story");
      /* `in-epic` owns the nesting connector's shape for every nested row;
         `in-story` only recolours it when the container is a story */
      row.classList.toggle("in-epic", nested);
      row.classList.toggle("in-story", nested && parentTier === "story");
      /* status: classes + dot in the list */
      const status = t.status === "done" || t.status === "progress" ? t.status : "todo";
      ["st-todo", "st-progress", "st-done"].forEach((c) => row.classList.remove(c));
      row.classList.add("st-" + status);
      const content0 = row.querySelector<HTMLElement>('[data-col-id=":text"] .wx-content');
      if (content0) {
        let dot = content0.querySelector<HTMLElement>(".status-dot");
        if (!dot) { dot = document.createElement("span"); dot.className = "status-dot"; content0.appendChild(dot); }
        const dc = "status-dot sd-" + status;
        if (dot.className !== dc) dot.className = dc;
        dot.title = status === "done" ? "Done" : status === "progress" ? "In progress" : "Not started";
      }
      /* type icon in front of the name (appended, repositioned via flex order —
         never inserted between React-managed nodes) */
      const typeKey = "ti-" + tier;
      const iconCls = "type-icon " + typeKey;
      let ic = row.querySelector<GlyphHost>(".type-icon");
      if (!ic) {
        const content = row.querySelector<HTMLElement>('[data-col-id=":text"] .wx-content');
        if (content) {
          ic = document.createElement("span");
          ic.className = iconCls;
          content.appendChild(ic);
        }
      } else if (ic.className !== iconCls) {
        ic.className = iconCls;
      }
      if (ic) setGlyph(ic, typeKey);
      /* Release scope, in the Scope column rather than crowded into the name.
         Every row that is in scope says so — the tier that carries the release
         with a solid pill, the rows under it with a ghosted one — which is what
         makes the column readable as a column instead of a sparse row of marks
         only epics carry. */
      const scopeCell = row.querySelector<HTMLElement>('[data-col-id=":scope"]');
      if (scopeCell) {
        const rel = typeof t.release === "string" ? t.release : "";
        const owned = isTierType(tier) && (rel === "mvp" || rel === "full");
        const scope = scopeOfTask(api, t);
        const relText = releaseLabel(scope);
        const host = scopeCell.querySelector<HTMLElement>(".wx-content") || scopeCell;
        let tag = host.querySelector<HTMLElement>(".release-tag");
        if (relText) {
          if (!tag) { tag = document.createElement("span"); host.appendChild(tag); }
          const tc = scopeCellClass(scope, owned);
          if (tag.className !== tc) tag.className = tc;
          if (tag.textContent !== relText) tag.textContent = relText;
          const own = releaseTitle(scope) || "";
          const title = owned ? own : own + " (inherited from the tier above)";
          if (tag.title !== title) tag.title = title;
        } else if (tag) {
          tag.remove();
        }
      }
      /* Who column: assignee initials from the roster; click opens the picker.
         The host is appended, never inserted between React-managed nodes. */
      const whoCell = row.querySelector<HTMLElement>('[data-col-id=":who"]');
      if (whoCell) {
        let host = whoCell.querySelector<HTMLButtonElement & KeyedHost>(".who-chips");
        if (!host) {
          host = document.createElement("button");
          host.className = "who-chips";
          host.type = "button";
          host.addEventListener("pointerdown", (e) => e.stopPropagation());
          host.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
          (whoCell.querySelector(".wx-content") || whoCell).appendChild(host);
        }
        const assigned = parseAssignees(t.assignees).map(personById).filter((h): h is Person => !!h);
        const key = assigned.map((h) => h.id + "\u0000" + h.name).join("|");
        if (host.__key !== key) {
          host.__key = key;
          host.textContent = "";
          if (!assigned.length) {
            const ph = document.createElement("span");
            ph.className = "who-empty";
            setGlyph(ph, "who-add");
            host.appendChild(ph);
          }
          const shown = assigned.slice(0, 3);
          for (const h of shown) {
            const chip = document.createElement("span");
            chip.className = "who-chip";
            chip.style.setProperty("--who-hue", String(nameHue(h.name)));
            chip.textContent = initialsOf(h.name);
            host.appendChild(chip);
          }
          if (assigned.length > shown.length) {
            const more = document.createElement("span");
            more.className = "who-chip who-more";
            more.textContent = "+" + (assigned.length - shown.length);
            host.appendChild(more);
          }
        }
        const label = assigned.length ? assigned.map((h) => h.name).join(", ") : "Assign people";
        if (host.title !== label) { host.title = label; host.setAttribute("aria-label", label); }
        /* the tagger owns this node, so hand React the element itself — the
           Who popover anchors to it through Ark's getAnchorRect */
        host.onclick = (e) => {
          e.stopPropagation();
          if (pickHook) pickHook(t.id, host);
        };
      }
      const rawUrl = typeof t.url === "string" && /^https?:\/\//i.test(t.url.trim()) ? t.url.trim() : null;
      /* ID column: ticket id extracted from the link, clickable */
      const cell = row.querySelector<HTMLElement>('[data-col-id=":tracker"]');
      if (cell) {
        const tid = rawUrl ? trackerId(rawUrl) : null;
        let a2 = cell.querySelector<HTMLAnchorElement>(".tracker-link");
        if (tid) {
          if (!a2) {
            a2 = document.createElement("a");
            a2.className = "tracker-link";
            a2.target = "_blank";
            a2.rel = "noopener noreferrer";
            ["click", "pointerdown"].forEach((ev) => a2!.addEventListener(ev, (e) => e.stopPropagation()));
            a2.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
            (cell.querySelector(".wx-content") || cell).appendChild(a2);
          }
          /* tid is only non-null when rawUrl was, which the compiler misses */
          if (a2.getAttribute("href") !== rawUrl) { a2.setAttribute("href", rawUrl!); a2.title = rawUrl!; }
          if (a2.textContent !== tid) a2.textContent = tid;
        } else if (a2) {
          a2.remove();
        }
      }
      /* hover-only edit (pencil) icon on every row — opens that row's editor */
      let bEl = row.querySelector<GlyphHost & HTMLButtonElement>(".row-edit");
      if (!bEl) {
        bEl = document.createElement("button");
        bEl.className = "row-edit";
        bEl.type = "button";
        bEl.addEventListener("pointerdown", (e) => e.stopPropagation());
        bEl.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
        const content = row.querySelector<HTMLElement>('[data-col-id=":text"] .wx-content');
        if (content) { setGlyph(bEl, "row-edit"); content.appendChild(bEl); } else bEl = null;
      }
      if (bEl) {
        const label = tier === "summary" ? "Edit epic" : tier === "story" ? "Edit story" : "Edit task";
        if (bEl.title !== label) { bEl.title = label; bEl.setAttribute("aria-label", label); }
        bEl.onclick = (e) => {
          e.stopPropagation();
          try { api.exec("show-editor", { id: t.id }); } catch (err) {}
        };
      }
    });
    document.querySelectorAll<HTMLElement>(".gantt-holder .wx-bar[data-task-id]").forEach((bar) => {
      const raw = bar.getAttribute("data-task-id") || "";
      const id = raw.startsWith(":") ? raw.slice(1) : raw;
      let t: ParsedTask | null = null;
      try { t = api.getTask(id); } catch (e) {}
      if (!t && /^\d+$/.test(id)) { try { t = api.getTask(Number(id)); } catch (e) {} }
      if (!t) return;
      const status = t.status === "done" || t.status === "progress" ? t.status : "todo";
      ["st-todo", "st-progress", "st-done"].forEach((c) => bar.classList.remove(c));
      bar.classList.add("st-" + status);
      bar.classList.toggle("is-story", tierOf(t) === "story");
    });
    syncFoldAllButton(api);
    syncScopeFilterButton();
    renderEpicBands(api);
    renderProjectSpan(api);
    if (rowTagObserver) rowTagObserver.takeRecords(); /* our own writes must not retrigger */
  };
  const sched = () => { if (!raf) raf = requestAnimationFrame(tag); };
  retagHook = sched;
  const target = document.querySelector(".gantt-holder");
  if (target) {
    rowTagObserver = new MutationObserver(sched);
    rowTagObserver.observe(target, { childList: true, subtree: true });
  }
  sched();
}

/* widgets are memoized so header/status re-renders can never reset
   in-progress edits inside the editor or the grid */
const MGantt = memo(Gantt);
const MToolbar = memo(Toolbar);
const MContextMenu = memo(ContextMenu);
const MEditor = memo(TaskEditor);
const HIGHLIGHT = (d: Date, u: "day" | "hour") => (u === "day" && (d.getDay() === 0 || d.getDay() === 6) ? "wx-weekend" : "");
const SUMMARY_CFG = { autoConvert: true, autoProgress: true };

/* ---------- the timeline scale ----------
   One scale, days. The Day / Week / Month switcher is gone: it was three
   segments of chrome in a header that had run out of room, and the two scales
   nobody was choosing cost more than they paid for.

   `projects.view` stays in the schema and is left exactly as stored — nothing
   here writes it any more, so no project row is dirtied by the removal, and a
   row that still says "week" simply goes unread.

   The PDF is NOT this: `pdf.ts` picks day / week / month from the project's own
   span, because a nine-month timeline in day columns is unreadable on A4. That
   logic is untouched and must stay. */
const DAY_SCALES: IScaleConfig[] = [
  { unit: "month", step: 1, format: "%F %Y" },
  { unit: "day", step: 1, format: "%j" },
];
const DAY_CELL_WIDTH = 36;

interface Picker {
  taskId: TID;
  el: HTMLElement | null;
  rect: DOMRect | null;
  ids: string[];
}
interface Clipboard {
  op: "cut" | "copy";
  id: TID;
  project: string;
}

export interface EditorProps {
  /* the route guarantees this project exists in the loaded store */
  projectId: string;
  /* the three filter dimensions, parsed and validated out of the URL by the
     route so a filtered timeline is shareable and survives a reload */
  filter: FilterState;
  onFilter: (f: FilterState) => void;
  onSignOut: () => Promise<void>;
}

/* ---------- the editor for one project ----------
   There is no project switcher here any more: the open project's view does not
   carry tabs for every other one. `/` is the list, and the mark at the top left
   is the way back to it. */
export default function GanttEditor({
  projectId, filter, onFilter, onSignOut,
}: EditorProps) {
  /* the draft the whole app shares; mutate it, then scheduleSave() diffs it
     against what Postgres holds and writes only the rows that moved */
  const st = useStore();
  const stRef = useRef(st);
  stRef.current = st;
  const activeProject = useCallback(
    () => stRef.current.draft.projects.find((p) => p.id === projectId) as StoreProject,
    [projectId],
  );

  const [api, setApi] = useState<GanttApi | null>(null);
  const [taskCount, setTaskCount] = useState(activeProject().tasks.length);
  const [seed, setSeed] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  /* editor-side failures that used to be swallowed: a refused PDF download, a
     widget that would not serialize, an unreadable undo entry. They belong
     next to the save status, because "Saved" on its own is a half-truth while
     any of them is true. */
  const [notice, setNotice] = useState<string | null>(null);
  const people = st.people;
  const [newPerson, setNewPerson] = useState("");
  const [picker, setPicker] = useState<Picker | null>(null); /* { taskId, el, rect, ids } */
  const pickerKeyRef = useRef("none");                       /* last opened row: see the popover below */
  const lastPickerRef = useRef<Picker | null>(null);
  /* the Scope column header's own filter trigger, anchored the same way the Who
     picker is: the button is tagger-built, so React never renders it and the
     popover has to be told where it is */
  const [scopePick, setScopePick] = useState<HTMLElement | null>(null);
  const lastScopeRef = useRef<{ el: HTMLElement | null; rect: DOMRect | null }>({ el: null, rect: null });
  const [copied, setCopied] = useState(false);
  const shareInputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef(activeProject().name);
  const clipRef = useRef<Clipboard | null>(null);
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const snapTimer = useRef<number | null>(null);
  const apiRef = useRef<GanttApi | null>(null);

  /* ---------- the filter ----------
     It hides rows and touches nothing else — see applyFilterTo above for why
     that is structurally true rather than a promise. The refs are what let the
     widget's own event handlers re-apply it (a row added while a filter is on
     would otherwise stay outside the visible set) without rebuilding `init`. */
  const [filterInfo, setFilterInfo] = useState<{ shown: number; total: number }>({ shown: 0, total: 0 });
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const peopleRef = useRef(people);
  peopleRef.current = people;
  /* `appliedRef` is what keeps an unfiltered editor completely inert: without
     it every draft bump would exec a clearing `filter-tasks` and re-render the
     widget for nothing */
  const appliedRef = useRef(false);
  const runFilter = useCallback(() => {
    const a = apiRef.current;
    if (!a) return;
    const on = filterActive(filterRef.current);
    if (!on && !appliedRef.current) return;
    appliedRef.current = on;
    setFilterInfo(applyFilterTo(a, filterRef.current, peopleRef.current));
  }, []);
  const fKey = filterKey(filter);
  const knownPeople = useMemo(() => new Set(people.map((h) => h.id)), [people]);
  /* what the filter actually constrains, once ids nobody holds any more are
     dropped — a deleted person left in the URL must not hide everything */
  const liveFilter = useMemo(() => usableFilter(filter, knownPeople), [fKey, knownPeople]);
  const filterOn = filterActive(liveFilter);

  /* `st.storeRev` is in here for the same reason it is in the holder's key: an
     adopted snapshot replaces the draft object wholesale, and neither `seed`
     nor `projectId` moves when it does */
  const revivedTasks = useMemo(() => prepareTasks(activeProject().tasks), [seed, activeProject, st.storeRev]);
  const links = useMemo(() => activeProject().links.slice(), [seed, activeProject, st.storeRev]);

  const range = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let min = Infinity, max = -Infinity;
    revivedTasks.forEach((t) => {
      if (t.start) min = Math.min(min, t.start.getTime());
      const e = t.end ? t.end.getTime() : t.start ? t.start.getTime() + (t.duration || 1) * DAY : 0;
      if (e) max = Math.max(max, e);
    });
    if (!isFinite(min)) { min = today.getTime() - 7 * DAY; max = today.getTime() + 38 * DAY; }
    return { start: new Date(min - 7 * DAY), end: new Date(max + 21 * DAY) };
  }, [revivedTasks]);

  /* pull the live widget state into the active project record */
  const snapshotActive = useCallback(() => {
    const a = apiRef.current;
    const p = activeProject();
    if (a) {
      try {
        p.tasks = serializeSide(a, "tasks");
        p.links = serializeSide(a, "links");
      } catch (e) {
        /* the draft now silently lags what is on screen, and the save that
           follows would report "Saved" for edits it never captured. Say so
           instead of quietly substituting the previous draft. */
        console.error("gantt: could not read the widget's state", e);
        setNotice("Could not read your latest edits from the timeline, so they are not being saved. Reload the page.");
      }
    }
    p.name = nameRef.current;
    return p;
  }, [activeProject]);

  /* the draft is brought up to date immediately; only the write to Postgres is
     debounced, and what it writes is the diff — never a rewrite of the store */
  const scheduleSave = useCallback(() => {
    const p = snapshotActive();
    setTaskCount(p.tasks.length);
    stRef.current.scheduleSave();
  }, [snapshotActive]);

  /* ---------- snapshot-based undo/redo (the library's history is pro-only) ----------
     The payload is everything a step can change, not just the two lists it used
     to hold. Removing a person mutates the roster AND strips that id from every
     task, so a snapshot of tasks alone let undo put the assignment back while
     the person stayed deleted — and the next save wrote that dangling id to
     Postgres. Renaming the project is in here for the same reason. */
  const serializeActive = useCallback(() => {
    const p = snapshotActive();
    return JSON.stringify({ t: p.tasks, l: p.links, h: stRef.current.draft.people, n: p.name });
  }, [snapshotActive]);
  const seedSnapshot = useCallback(() => {
    const s = serializeActive();
    const u = undoRef.current;
    if (!u.length || u[u.length - 1] !== s) u.push(s);
    if (u.length > 60) u.shift();
  }, [serializeActive]);
  const flushSnapshot = useCallback(() => {
    if (snapTimer.current) { clearTimeout(snapTimer.current); snapTimer.current = null; }
    const s = serializeActive();
    const u = undoRef.current;
    if (!u.length || u[u.length - 1] !== s) {
      u.push(s);
      redoRef.current = [];
      if (u.length > 60) u.shift();
    }
  }, [serializeActive]);
  const scheduleSnapshot = useCallback(() => {
    clearTimeout(snapTimer.current ?? undefined);
    snapTimer.current = setTimeout(() => { snapTimer.current = null; flushSnapshot(); }, 350);
  }, [flushSnapshot]);
  const restoreSnapshot = useCallback((json: string) => {
    try {
      const d = JSON.parse(json) as { t: StoreTask[]; l: StoreLink[]; h?: Person[]; n?: string };
      const p = activeProject();
      p.tasks = d.t;
      p.links = d.l;
      /* the roster moves with the step that changed it, so an undone removal
         puts the person back rather than leaving tasks pointing at nobody */
      if (Array.isArray(d.h)) stRef.current.draft.people = d.h;
      if (typeof d.n === "string") { p.name = d.n; nameRef.current = d.n; }
      setTaskCount(d.t.length);
      setSeed((s) => s + 1);
      stRef.current.bump();
      /* a restored snapshot is a bulk change: the diff turns it into the rows
         that actually differ from what is stored, not a rewrite */
      stRef.current.scheduleSave();
    } catch (e) {
      /* an entry that will not parse is a bug in what we wrote, and swallowing
         it leaves the user pressing undo at a stack that does nothing */
      console.error("gantt: undo entry could not be read", e);
      setNotice("That undo step could not be restored — the history entry was unreadable.");
    }
  }, [activeProject]);

  /* keyboard shortcuts: ⌘/Ctrl+C copy, +X cut, +V paste (into epics), +Z undo, +Shift+Z redo */
  useEffect(() => {
    if (!api) return;
    const onKey = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (!["c", "v", "x", "z"].includes(k)) return;
      const el = e.target;
      if (el instanceof Element && el.closest('input, textarea, [contenteditable="true"]')) return;
      if (document.querySelector(".wx-gantt-editor")) return; /* editor modal open: keep native behavior */
      /* `gs`, not `st`: the gantt's state, not the store api above */
      const gs = api.getState();
      const sel = gs.selected && gs.selected.length ? gs.selected[gs.selected.length - 1] : null;

      if (k === "z") {
        e.preventDefault(); e.stopPropagation();
        flushSnapshot();
        const u = undoRef.current, r = redoRef.current;
        if (e.shiftKey) {
          if (!r.length) return;
          const next = r.pop()!;
          u.push(next);
          restoreSnapshot(next);
        } else {
          if (u.length < 2) return;
          r.push(u.pop()!);
          restoreSnapshot(u[u.length - 1]);
        }
        return;
      }
      if (k === "c" || k === "x") {
        if (sel === null || sel === undefined) return;
        e.preventDefault(); e.stopPropagation();
        clipRef.current = { op: k === "x" ? "cut" : "copy", id: sel, project: projectId };
        return;
      }
      if (k === "v") {
        const clip = clipRef.current;
        if (!clip) return;
        e.preventDefault(); e.stopPropagation();
        if (clip.project !== projectId) return; /* clipboard is per project */
        let srcOk: ParsedTask | null = null;
        try { srcOk = api.getTask(clip.id); } catch (err) {}
        if (!srcOk) return;
        let selTask: ParsedTask | null = null;
        try { selTask = sel !== null && sel !== undefined ? api.getTask(sel) : null; } catch (err) {}
        if (sel === clip.id && clip.op === "cut") return;
        const cfg: { id: TID; target?: TID; mode?: "child" | "after" } = { id: clip.id };
        /* a non-null selTask proves sel was a real id */
        if (selTask && selTask.type === "summary" && sel !== clip.id) { cfg.target = sel!; cfg.mode = "child"; }
        else if (selTask) { cfg.target = sel!; cfg.mode = "after"; }
        else { cfg.target = clip.id; cfg.mode = "after"; }
        try {
          await api.exec(clip.op === "cut" ? "move-task" : "copy-task", cfg);
          if (clip.op === "cut") clipRef.current = null;
          const newId = clip.op === "cut" ? clip.id : cfg.id;
          if (newId !== undefined) api.exec("select-task", { id: newId });
          setTimeout(() => { try { rollupEpics(api); } catch (err) {} }, 0);
        } catch (err) {}
        return;
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [api, projectId, flushSnapshot, restoreSnapshot]);

  /* editor modal: close (with autosave) on backdrop click; inject an Okay button */
  useEffect(() => {
    if (!api) return;
    const commitAndClose = () => {
      const ed = document.querySelector(".wx-gantt-editor");
      /* activeElement is typed Element, which has no blur — the runtime check
         below is what actually decides, exactly as before */
      const ae = document.activeElement as (Element & { blur?: () => void }) | null;
      if (ed && ae && ed.contains(ae) && typeof ae.blur === "function") ae.blur(); /* commit the field being edited */
      /* null closes the editor; the shipped type only models opening one */
      setTimeout(() => { try { api.exec("show-editor", { id: null as unknown as TID }); } catch (e) {} }, 60);
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      const side = e.target.closest(".wx-sidearea.wx-pos-right");
      if (side && !e.target.closest(".wx-gantt-editor")) commitAndClose();
    };
    const ensureOkay = () => {
      const ed = document.querySelector(".wx-gantt-editor");
      if (!ed || ed.querySelector(".editor-okay")) return;
      const bar = document.createElement("div");
      bar.className = "editor-okay-bar";
      const btn = document.createElement("button");
      btn.className = "editor-okay";
      btn.type = "button";
      btn.textContent = "Okay";
      btn.onclick = commitAndClose;
      bar.appendChild(btn);
      ed.appendChild(bar);
    };
    document.addEventListener("mousedown", onDown, true);
    const mo = new MutationObserver(ensureOkay);
    mo.observe(document.body, { childList: true, subtree: true });
    ensureOkay();
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      mo.disconnect();
    };
  }, [api]);

  /* Ark's Popover owns dismissal (outside click + Escape) and placement */
  const copyShareLink = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(shareUrl(projectId)); ok = true; } catch (e) {}
    if (!ok) {
      const inp = shareInputRef.current;
      if (inp) { inp.focus(); inp.select(); try { ok = document.execCommand("copy"); } catch (e) {} }
    }
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2500);
  };

  const exportPdf = useCallback(async () => {
    if (exporting) return;
    const p = snapshotActive();
    setExporting(true);
    setNotice(null);
    try {
      /* async now: it fetches jsPDF and the Unicode font on demand */
      const doc = await buildGanttPdf(p.name, p.tasks, p.links);
      const safe = (p.name || "gantt").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "gantt";
      doc.save(safe + ".pdf"); /* plain browser download */
    } catch (e) {
      /* there is nothing to fall back to, but the button going quiet and
         nothing arriving is the worst of both — say what happened */
      console.error("gantt: PDF export failed", e);
      setNotice("The PDF could not be created: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setExporting(false);
    }
  }, [exporting, snapshotActive]);

  const init = useCallback((raw: IApi) => {
    /* the one place the shipped IApi is narrowed (see GanttApi above) */
    const a = raw as GanttApi;
    apiRef.current = a;
    setApi(a);

    /* enforce the hours/working-day model on every change */
    a.intercept("add-task", (ev) => {
      const t = ev.task || (ev.task = {});
      /* the tier seam again: a row may arrive asking to be a story (the context
         menu's Convert list is built from TASK_TYPES), and every new row needs
         a `kind` or the editor modal's Type select would open blank */
      const asked = kindOf(t) ?? (typeof t.type === "string" ? t.type : "task");
      t.kind = asked;
      t.type = asWidgetType(asked);
      if (t.type === "summary") {
        if (!t.start) {
          /* the enclosing guard narrows t.start to undefined, so the Date
             branch below reads as dead to the compiler but not at runtime */
          const given = t.start as Date | undefined;
          t.start = rollForward(given instanceof Date ? given : new Date());
          t.end = addWorkDays(t.start, 1);
          t.duration = Math.round((+t.end - +t.start) / DAY);
        }
        return;
      }
      if (t.type === "milestone") return;
      const fixed = scheduleFromHours(t.hours || (t.duration || 1) * HOURS_PER_DAY, t.start || new Date());
      Object.assign(t, fixed);
    });
    a.intercept("update-task", (ev) => {
      const t = ev.task;
      if (!t) return;
      let prev: ITask = {};
      try { prev = a.getTask(ev.id) || {}; } catch (e) {}
      /* THE tier seam, live. Two things can ask for a type change:
           · the editor modal, which edits `kind` (the real tier) — `type` is
             derived from it here, so picking Story makes a widget summary;
           · the context menu's Convert list, which sends `type` alone — `kind`
             follows it, so converting a story to a task really does drop the
             tier instead of leaving a stale marker behind.
         Doing this first matters: every branch below reads `merged.type`. */
      const asked = kindOf(t) ?? (typeof t.type === "string" ? t.type : undefined);
      if (asked !== undefined) {
        t.kind = asked;
        t.type = asWidgetType(asked);
      }
      const merged = { ...prev, ...t };
      if (merged.type === "summary" && !ROLLUP_WRITE) {
        /* epic estimates are derived from their tasks — ignore manual edits */
        delete t.hours; delete t.days;
        return;
      }
      if (!isBar(merged)) return;
      /* a bar drag: hand it to the store untouched and finish the job in the
         `update-task` handler below, once the diff has actually been applied */
      const mode = dragModeOf(ev);
      if (mode) {
        pendingDrag = { id: ev.id, mode, hours: Number(prev.hours) || 0 };
        return;
      }
      if (merged.type !== prev.type && isBar(merged) && !merged.hours) {
        /* converted from milestone/summary: give it a default estimate */
        t.hours = HOURS_PER_DAY;
      }
      const startChanged = t.start && (!prev.start || +t.start !== +prev.start);
      const endChanged = t.end && (!prev.end || +t.end !== +prev.end);
      const nHours = t.hours !== undefined ? Number(t.hours) : NaN;
      const nDays = t.days !== undefined ? parseFloat(t.days) : NaN;
      const hoursChanged = !isNaN(nHours) && nHours > 0 && nHours !== Number(prev.hours);
      const daysChanged = !isNaN(nDays) && nDays > 0 && nDays !== Number(prev.days);
      let hours;
      if (hoursChanged) hours = nHours;                          /* hours entered → days follow */
      else if (daysChanged) hours = nDays * HOURS_PER_DAY;       /* days entered → hours follow */
      else if (endChanged && !startChanged && merged.start) {
        hours = workDaysBetween(merged.start, t.end!) * HOURS_PER_DAY; /* bar resized */
      } else hours = Number(prev.hours);
      if (!hours || isNaN(hours)) hours = Math.max(1, merged.duration || 1) * HOURS_PER_DAY;
      const fixed = scheduleFromHours(hours, merged.start || new Date());
      t.hours = fixed.hours; t.days = fixed.days; t.start = fixed.start; t.end = fixed.end; t.duration = fixed.duration;
    });

    /* the second half of the drag fix: by the time this runs the store has
       applied `diff`, so the task carries the dates the user actually dragged
       to. Registered before the generic handlers below so the correction and
       the save it triggers happen in one pass. */
    a.on("update-task", (ev) => {
      const drag = pendingDrag;
      pendingDrag = null;
      if (!drag || drag.id !== ev.id) return;
      let t: ParsedTask | null = null;
      try { t = a.getTask(ev.id); } catch (e) { return; }
      if (!t || !isBar(t) || !(t.start instanceof Date)) return;
      const end = t.end instanceof Date ? t.end : t.start;
      /* a move carries the estimate with it; a resize IS the new estimate */
      const hours = drag.mode === "move" ? drag.hours : workDaysBetween(t.start, end) * HOURS_PER_DAY;
      const fixed = scheduleFromHours(hours || undefined, t.start);
      const unchanged =
        +t.start === +fixed.start && +end === +fixed.end &&
        Number(t.hours) === fixed.hours && Number(t.days) === fixed.days;
      if (unchanged) return; /* also what stops this from re-entering forever */
      try {
        a.exec("update-task", {
          id: ev.id,
          task: { hours: fixed.hours, days: fixed.days, start: fixed.start, end: fixed.end, duration: fixed.duration },
        });
      } catch (e) { /* the widget rejected it; the bar keeps the dragged dates */ }
    });

    const finalEvents = [
      "add-task", "update-task", "delete-task", "move-task", "copy-task",
      "indent-task", "add-link", "update-link", "delete-link", "open-task",
    ];
    const touched = () => {
      if (!ROLLUP_WRITE) { try { rollupEpics(a); } catch (e) {} }
      scheduleSave();
      scheduleSnapshot();
      try {
        setTaskCount(serializeSide(a, "tasks").length);
        setStats(computeStats(a));
      } catch (e) {}
      /* a row added, moved or retyped while a filter is on is not in the
         visible set yet; re-running the filter is a pure read of the same tree
         and emits no event, so it cannot loop */
      if (filterActive(filterRef.current)) runFilter();
      if (retagHook) retagHook();
    };
    finalEvents.forEach((ev) => a.on(ev, () => { touched(); }));
    a.on("drag-task", (ev) => { if (!ev || !ev.inProgress) scheduleSave(); });
    const mountProject = projectId;
    setTimeout(() => {
      /* a project switch may have superseded this mount */
      if (apiRef.current !== a || projectId !== mountProject) return;
      watchRowTags(a);
      try { rollupEpics(a); setStats(computeStats(a)); } catch (e) {}
      try { seedSnapshot(); } catch (e) {}
    }, 0);
    if (window.__ganttProbe) window.__ganttProbe(a);
  }, [scheduleSave, scheduleSnapshot, seedSnapshot, projectId, runFilter]);

  /* The widget is remounted by a scale change, a project change and an adopted
     snapshot, and a fresh tree carries no filter — so re-apply on all of them,
     as well as when the filter itself moves. Clearing goes through here too:
     `filter-tasks` with no handler is what drops SVAR's visible-id set. */
  useEffect(() => { runFilter(); }, [api, fKey, seed, projectId, st.storeRev, people, runFilter]);

  /* ---------- people roster ---------- */
  /* the tagger reads the roster from module scope; keep it in step and repaint */
  useEffect(() => {
    rosterRef = people;
    if (retagHook) retagHook();
  }, [people]);

  /* the Scope column header's trigger reads the release dimension the same way,
     so it can say whether it is constraining without a React render inside the
     widget's DOM */
  useEffect(() => {
    releaseFilterRef = liveFilter.releases;
    if (retagHook) retagHook();
  }, [liveFilter]);

  useEffect(() => {
    scopeFilterHook = (hostEl) => {
      lastScopeRef.current = { el: hostEl, rect: hostEl ? hostEl.getBoundingClientRect() : null };
      /* a second click on the trigger closes it, as the button reads */
      setScopePick((cur) => (cur === hostEl ? null : hostEl));
    };
    return () => { scopeFilterHook = null; };
  }, []);

  useEffect(() => {
    pickHook = (taskId, hostEl) => {
      let ids: string[] = [];
      /* the ref is guaranteed by the time a row can be clicked; the try/catch
         is what covers an unassigned or vanished task, as before */
      try { ids = parseAssignees(apiRef.current!.getTask(taskId).assignees); } catch (e) { /* unassigned */ }
      /* keep a rect snapshot: the widget may re-render the cell away while the
         popover is open, and a detached node measures as 0×0 */
      const rect = hostEl ? hostEl.getBoundingClientRect() : null;
      setPicker({ taskId, el: hostEl, rect, ids });
    };
    return () => { pickHook = null; };
  }, []);

  /* the roster is one list for the whole account, so it lives on the shared
     draft; a rename is one people-row update once the diff has run */
  const commitPeople = useCallback((next: Person[]) => {
    stRef.current.draft.people = next;
    stRef.current.bump();
    scheduleSave();
    /* a roster change is an undoable step like any other; without this the
       stack has no entry that knows the roster ever looked different */
    scheduleSnapshot();
  }, [scheduleSave, scheduleSnapshot]);

  const addPerson = useCallback(() => {
    const name = newPerson.trim();
    if (!name) return;
    /* a discrete act, so pin the state it starts from rather than hoping the
       debounced snapshot already fired */
    flushSnapshot();
    const next = [...stRef.current.draft.people, { id: uid(), name }];
    setNewPerson("");
    commitPeople(next);
  }, [newPerson, commitPeople, flushSnapshot]);

  const renamePerson = useCallback((id: string, name: string) => {
    commitPeople(stRef.current.draft.people.map((h) => (h.id === id ? { ...h, name } : h)));
  }, [commitPeople]);

  /* removing a person also clears them from every task that referenced them */
  const removePerson = useCallback((id: string) => {
    /* before anything moves: this one step changes both the roster and every
       task that referenced it, and undo has to be able to come back to both */
    flushSnapshot();
    const strip = (v: unknown) => parseAssignees(v).filter((x) => x !== id).join(",") || null;
    stRef.current.draft.projects.forEach((pr) => {
      (pr.tasks || []).forEach((t) => { if (t.assignees) t.assignees = strip(t.assignees); });
    });
    const a = apiRef.current;
    if (a) {
      try {
        (a.getState()._tasks || []).forEach((t) => {
          if (t.assignees && parseAssignees(t.assignees).includes(id)) {
            a.exec("update-task", { id: t.id, task: { assignees: strip(t.assignees) } });
          }
        });
      } catch (e) { /* the store copy above is still correct */ }
    }
    commitPeople(stRef.current.draft.people.filter((h) => h.id !== id));
  }, [commitPeople, flushSnapshot]);

  const toggleAssignee = useCallback((taskId: TID, personId: string) => {
    const a = apiRef.current;
    if (!a) return;
    let t: ParsedTask | null = null;
    try { t = a.getTask(taskId); } catch (e) {}
    if (!t) return;
    const cur = parseAssignees(t.assignees);
    const next = cur.includes(personId) ? cur.filter((x) => x !== personId) : [...cur, personId];
    a.exec("update-task", { id: taskId, task: { assignees: next.join(",") || null } });
    setPicker((cur) => (cur && cur.taskId === taskId ? { ...cur, ids: next } : cur));
    if (retagHook) setTimeout(() => retagHook!(), 0);
  }, []);

  /* one dimension at a time; the three are ANDed by makeFilter */
  const toggleFilter = (dim: "types" | "releases" | "people", id: string) => {
    const next: FilterState = { types: filter.types, releases: filter.releases, people: filter.people };
    const cur = next[dim];
    next[dim] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    onFilter(next);
  };

  const onName = (e: React.SyntheticEvent<HTMLHeadingElement>) => {
    nameRef.current = e.currentTarget.textContent?.trim() || "Untitled project";
    activeProject().name = nameRef.current;
    scheduleSave();
  };

  /* The release dimension, rendered once and used by both of its entry points:
     the header's Filter popover and the Scope column header's own trigger. One
     definition, so the two can never drift — and the inclusion note is part of
     it, on screen rather than behind a hover, because a user who filters by
     Full and sees MVP rows come back would otherwise read it as a bug. */
  const releaseChips = (
    <>
      <div className="flex flex-wrap gap-1.5">
        {RELEASES.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={filter.releases.includes(r.id)}
            className={filter.releases.includes(r.id) ? CHIP_ON : CHIP_OFF}
            onClick={() => toggleFilter("releases", r.id)}
          >{r.label}</button>
        ))}
        <button
          type="button"
          aria-pressed={filter.releases.includes(UNSET)}
          className={filter.releases.includes(UNSET) ? CHIP_ON : CHIP_OFF}
          onClick={() => toggleFilter("releases", UNSET)}
        >Unassigned</button>
      </div>
      <p className="m-0 mt-1.5 text-tiny text-faint">{RELEASE_INCLUSION_NOTE}</p>
    </>
  );

  /* the Who popover's remount key and anchor both survive the close, so the
     exit animation has a stable origin to collapse into; both are plain refs
     updated during render, which is idempotent under StrictMode */
  if (picker) {
    pickerKeyRef.current = String(picker.taskId);
    lastPickerRef.current = picker;
  }

  /* The pill sits on the quiet second line now, so it says the short thing and
     keeps the sentence in its tooltip — "Saved · Supabase" was 110px of a row
     the project's own name was being clipped out of. */
  const statusText = {
    idle: "", saving: "Saving…", saved: "Saved", local: "Not saved",
  }[st.status];
  let statusTitle = {
    idle: "", saving: "Saving to Supabase…", saved: "Saved to Supabase",
    local: "Not saved — Supabase unavailable",
  }[st.status];
  /* only a failed save belongs on the save pill; a failed create, delete or
     "last opened" write is its own thing and gets its own pill below */
  if (st.status === "local" && st.error) statusTitle += " · " + st.error;
  /* everything the user has to be told, in the order it matters: a write that
     failed, a timeline that moved under them, then anything the editor itself
     could not do */
  const alerts: { key: string; text: string; dismiss?: () => void }[] = [
    /* a failed save already reads on the pill above; these are the ones that
       had nowhere to go: a failed create/delete/"last opened" write, a
       timeline that moved elsewhere, and the editor's own failures */
    st.status !== "local" && st.error ? { key: "store", text: st.error } : null,
    st.warning ? { key: "remote", text: st.warning } : null,
    notice ? { key: "editor", text: notice, dismiss: () => setNotice(null) } : null,
  ].filter((x): x is { key: string; text: string; dismiss?: () => void } => !!x);

  return (
    <div className="flex h-full flex-col">
      {/* the topbar is a material, not a painted strip: a translucent layer with
          a bright top edge, closed off by a soft scroll edge instead of a rule */}
      {/* ---------- the header, in two groups ----------
          Identity on the left — back, the project's name, and the quiet line of
          state and totals under it — and the actions on the right. It used to
          be one undifferentiated run of nine things at the same weight, in
          which the project's own name was the item that got clipped to four
          characters while an eight-fact stats string beside it took full width.
          The stats moved under the title, the two scale-switcher segments are
          gone, and Share and Export PDF are icons, which is what bought the
          name the room it needed. */}
      <header className="material-chrome edge-fade relative z-10 flex flex-none items-center gap-3 py-2 pr-[18px] pl-3">
        {/* the way back to the list. It is a real link, so the browser's own
            open-in-a-new-tab still works, and it serializes the widget into the
            draft on the way out — leaving the editor must not lose the edit
            that is still sitting in the debounce. */}
        <Link
          to="/"
          onClick={() => scheduleSave()}
          className={`press inline-flex flex-none cursor-pointer items-center gap-1.5 rounded-[9px] border border-transparent bg-transparent px-2 py-1.5 font-ui text-small font-medium text-muted no-underline hover:border-line hover:bg-surface hover:text-ink ${FOCUS}`}
          title="All projects"
        >
          <span className={BRAND_MARK} aria-hidden="true" />
          <CaretLeft size={11} weight="bold" aria-hidden="true" />
          <span className="max-[900px]:sr-only">Projects</span>
        </Link>

        {/* identity: the name, with everything subordinate to it underneath.
            `min-w-0` is what lets the title ellipsize instead of pushing the
            actions off a page that cannot scroll. */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-px">
          <div className="flex min-w-0 items-center gap-2">
            {/* the title carries no `press`: it is a text field, so a scale on
                pointer-down would fight the caret rather than confirm a commit */}
            <h1
              key={projectId}
              className="m-0 min-w-0 overflow-hidden rounded-[7px] px-1.5 py-[0.0625rem] font-display text-display font-semibold text-ellipsis whitespace-nowrap outline-none transition-colors duration-[130ms] ease-out hover:bg-surface-hover focus-visible:bg-surface focus-visible:shadow-[0_0_0_2px_var(--color-accent)]"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              onInput={onName}
              onBlur={onName}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
            >{activeProject().name}</h1>
            {/* not decoration: each of these is something that did not happen,
                which is why they sit on the title's own line rather than in the
                quiet run below. Clicking one dismisses it — the underlying
                state re-raises it if it is still true. */}
            {alerts.map((a) =>
              a.dismiss ? (
                <button
                  key={a.key}
                  type="button"
                  title={a.text + " — click to dismiss"}
                  onClick={a.dismiss}
                  className={`press max-w-[24vw] flex-none cursor-pointer overflow-hidden rounded-full border border-danger bg-surface px-2.5 py-[0.1875rem] text-left text-mini text-ellipsis whitespace-nowrap text-danger ${FOCUS}`}
                >{a.text}</button>
              ) : (
                /* not dismissible: it clears itself when the thing it reports does */
                <span
                  key={a.key}
                  role="status"
                  title={a.text}
                  className="max-w-[24vw] flex-none overflow-hidden rounded-full border border-danger bg-surface px-2.5 py-[0.1875rem] text-mini text-ellipsis whitespace-nowrap text-danger"
                >{a.text}</span>
              ),
            )}
          </div>

          {/* the quiet line: save state, then the totals. Smaller, muted, and
              subordinate — it answers questions, it does not announce itself.
              The segments that matter least give way first as the window
              narrows, so effort and the release split survive down to ~700px
              rather than the whole line disappearing at 1100 as it used to. */}
          <div className="flex min-w-0 items-center gap-x-3 overflow-hidden pl-1.5 text-mini whitespace-nowrap text-muted tabular-nums">
            {statusText && (
              <span
                title={statusTitle}
                className={
                  st.status === "saved"
                    ? "flex-none text-accent"
                    : st.status === "local"
                      ? "flex-none font-semibold text-danger"
                      : "flex-none text-muted"
                }
              >{statusText}</span>
            )}
            {/* a filter is a mode, and a mode nobody can see is a trap: this
                says how much is hidden and clears it in one click */}
            {filterOn && (
              <button
                type="button"
                className={`press inline-flex flex-none cursor-pointer items-center gap-1 rounded-full border border-accent bg-accent-hover px-2 py-0 text-mini whitespace-nowrap text-accent ${FOCUS}`}
                title="Clear the filter"
                onClick={() => onFilter(EMPTY_FILTER)}
              >
                <Funnel size={10} weight="fill" aria-hidden="true" />
                {filterInfo.shown} of {filterInfo.total}
                <X size={10} aria-hidden="true" />
              </button>
            )}
            {stats && stats.min && stats.max && (
              <>
                <span className="flex-none max-[860px]:hidden">
                  {fmtD(stats.min)} – {fmtD(new Date(stats.max.getTime() - DAY))}
                </span>
                {/* hours and days are EFFORT — the work inside the bar — not the
                    length of the bar. An epic's pair is the sum of its tasks'
                    effort sitting next to a calendar span that is nothing like
                    it, so the word has to be on screen. */}
                <span className="flex-none">
                  effort <strong className="font-semibold text-ink">{stats.h}h</strong> / {stats.d}d
                </span>
                {(stats.epics > 0 || stats.stories > 0) && (
                  <span className="flex-none max-[1180px]:hidden">
                    {stats.epics > 0 && stats.epics + (stats.epics === 1 ? " epic" : " epics")}
                    {stats.epics > 0 && stats.stories > 0 && " · "}
                    {stats.stories > 0 && stats.stories + (stats.stories === 1 ? " story" : " stories")}
                  </span>
                )}
                {/* what each release costs, from the same roll-up the projects
                    list and the PDF show — and always the whole project, never
                    the filtered view. "incl. MVP" is on screen rather than in a
                    tooltip because MVP ⊂ Full: without it, 56 and 98 read as
                    two separate buckets that happen not to add up. */}
                {stats.release.mvp > 0 && (
                  <span className="inline-flex flex-none items-center gap-1">
                    <span className="release-tag rel-lead rel-mvp" title={releaseTitle("mvp") ?? undefined}>MVP</span>
                    {stats.release.mvp}h
                  </span>
                )}
                {stats.release.fullRelease > 0 && (
                  <span className="inline-flex flex-none items-center gap-1">
                    <span className="release-tag rel-lead rel-full" title="The full release, MVP included">Full</span>
                    {stats.release.fullRelease}h
                    {stats.release.mvp > 0 && <span className="text-faint">incl. MVP</span>}
                  </span>
                )}
                {stats.release.unscoped > 0 && (
                  <span className="flex-none max-[1180px]:hidden">unscoped {stats.release.unscoped}h</span>
                )}
              </>
            )}
          </div>
        </div>

        {/* actions: one group, right-aligned, and none of them ever wraps */}
        <div className="flex flex-none items-center gap-1.5">
        <Popover.Root positioning={{ placement: "bottom-end", gutter: 8 }}>
          <Popover.Trigger className={BTN} title="People on this account">
            <Users size={14} aria-hidden="true" />
            <span className="max-[1080px]:sr-only">People</span>
            {people.length > 0 && <span className="tabular-nums">{people.length}</span>}
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner style={{ zIndex: 40 }}>
              <Popover.Content className={`${POP} w-[288px] rounded-xl p-3.5`}>
                <Popover.Title className={POP_TITLE}>People</Popover.Title>
                <Popover.Description className={POP_HINT}>Anyone on this list can be assigned to a task or an epic.</Popover.Description>
                {people.length > 0 && (
                  <ul className="m-0 mb-2.5 max-h-[240px] list-none overflow-y-auto p-0">
                    {people.map((h) => (
                      <li key={h.id} className="flex items-center gap-2 py-[0.1875rem]">
                        {/* .who-chip is styled unscoped in wx-overrides.css, so the pill
                            looks identical here, in the Who picker and in the grid */}
                        <span className="who-chip" style={{ "--who-hue": nameHue(h.name) }}>{initialsOf(h.name)}</span>
                        <input
                          className={`min-w-0 flex-1 rounded-[7px] border border-transparent bg-transparent px-2 py-[0.3125rem] font-ui text-body text-ink transition-colors duration-[130ms] ease-out hover:border-line-soft focus:border-accent focus:bg-surface-alt focus:outline-none ${FOCUS}`}
                          value={h.name}
                          aria-label="Name"
                          onChange={(e) => renamePerson(h.id, e.target.value)}
                        />
                        <button
                          type="button"
                          className={`press press-sm inline-flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 leading-none text-faint hover:bg-surface-hover hover:text-danger ${FOCUS}`}
                          title={"Remove " + h.name}
                          onClick={() => removePerson(h.id)}
                        ><X size={14} aria-hidden="true" /></button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-1.5">
                  <input
                    className={POP_INPUT}
                    value={newPerson}
                    placeholder="Add a person"
                    onChange={(e) => setNewPerson(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPerson(); } }}
                  />
                  <button type="button" className={POP_ACTION} onClick={addPerson}>Add</button>
                </div>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
        <Popover.Root
          positioning={{ placement: "bottom-end", gutter: 8 }}
          onOpenChange={(e) => { if (!e.open) setCopied(false); }}
        >
          {/* icon-only, but never nameless: the label moves to `aria-label` and
              `title` rather than disappearing */}
          <Popover.Trigger className={BTN_ICON} title="Share a view-only link" aria-label="Share a view-only link">
            <ShareNetwork size={15} aria-hidden="true" />
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner style={{ zIndex: 60 }}>
              <Popover.Content className={`${POP} w-[380px] rounded-xl px-4 py-3.5`}>
                <Popover.Title className={POP_TITLE}>View-only link</Popover.Title>
                <Popover.Description className={POP_HINT}>Anyone with this link can see the chart live — data loads fresh on every open, no editing.</Popover.Description>
                <div className="flex gap-1.5">
                  <input ref={shareInputRef} className={POP_INPUT} readOnly value={shareUrl(projectId)} onFocus={(e) => e.target.select()} />
                  <button type="button" className={POP_ACTION} onClick={copyShareLink}>{copied ? "Copied!" : "Copy"}</button>
                </div>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
        <button
          className={BTN_ICON}
          type="button"
          onClick={exportPdf}
          disabled={exporting}
          title={exporting ? "Exporting the PDF…" : "Export PDF"}
          aria-label={exporting ? "Exporting the PDF…" : "Export PDF"}
        >
          <DownloadSimple size={15} aria-hidden="true" />
        </button>
        <Popover.Root positioning={{ placement: "bottom-end", gutter: 8 }}>
          <Popover.Trigger className={filterOn ? BTN_ON : BTN} title="Filter by type, release scope and assignee">
            <Funnel size={13} weight={filterOn ? "fill" : "regular"} aria-hidden="true" />
            {/* the label gives way before the control does — every action stays
                reachable on a page that cannot scroll */}
            <span className="max-[1080px]:sr-only">Filter</span>
            {filterOn && <span className="tabular-nums">{filterCount(liveFilter)}</span>}
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner style={{ zIndex: 60 }}>
              <Popover.Content className={`${POP} w-[286px] rounded-xl p-3.5`}>
                <Popover.Title className={POP_TITLE}>Filter</Popover.Title>
                <Popover.Description className={POP_HINT}>
                  Hides rows on screen only. Nothing is deleted, and the totals above still count the whole project.
                </Popover.Description>
                <p className={GROUP_LABEL}>Type</p>
                <div className="flex flex-wrap gap-1.5">
                  {TASK_TYPES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={filter.types.includes(t.id)}
                      className={filter.types.includes(t.id) ? CHIP_ON : CHIP_OFF}
                      onClick={() => toggleFilter("types", t.id)}
                    >{t.label}</button>
                  ))}
                </div>
                <p className={GROUP_LABEL}>Release</p>
                {releaseChips}
                <p className={GROUP_LABEL}>Who</p>
                <div className="flex flex-wrap gap-1.5">
                  {people.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      aria-pressed={filter.people.includes(h.id)}
                      className={filter.people.includes(h.id) ? CHIP_ON : CHIP_OFF}
                      onClick={() => toggleFilter("people", h.id)}
                    >
                      {/* the same chip as the Who column, so it reads as the
                          same concept rather than a second list of names */}
                      <span className="who-chip" style={{ "--who-hue": nameHue(h.name) }}>{initialsOf(h.name)}</span>
                      <span className="max-w-[9rem] overflow-hidden text-ellipsis whitespace-nowrap">{h.name}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-pressed={filter.people.includes(UNSET)}
                    className={filter.people.includes(UNSET) ? CHIP_ON : CHIP_OFF}
                    onClick={() => toggleFilter("people", UNSET)}
                  >Unassigned</button>
                </div>
                <div className="mt-3.5 flex items-center gap-2 border-t border-t-line-soft pt-3">
                  <button type="button" className={BTN} disabled={!filterOn} onClick={() => onFilter(EMPTY_FILTER)}>
                    Clear all
                  </button>
                  {filterOn && (
                    <span className="text-mini text-muted tabular-nums">{filterInfo.shown} of {filterInfo.total} rows</span>
                  )}
                </div>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
        <button
          className={BTN}
          type="button"
          title="Sign out"
          onClick={() => { void onSignOut(); }}
        >
          <SignOut size={13} aria-hidden="true" />
          <span className="max-[1080px]:sr-only">Sign out</span>
        </button>
        </div>
      </header>
      <div className="board relative mx-[14px] mb-[14px] flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
        <CoreWillow fonts={false}>
        <GridWillow fonts={false}>
          <div className="toolbar-row flex flex-none items-center border-b border-b-line-soft">
            {/* api is null until the widget mounts; the toolbar handles that, its
                prop type just does not model it */}
            <MToolbar api={api!} items={TOOLBAR_ITEMS} />
            <div className="flex flex-none items-center gap-[14px] px-4 text-tiny whitespace-nowrap text-muted max-[900px]:hidden" aria-hidden="true">
              {LEGEND.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-[5px]">
                  <span className={`h-2 w-2 rounded-[3px] ${t.dot}`} />{t.label}
                </span>
              ))}
            </div>
          </div>
          <MContextMenu api={api!} />
          {/* `storeRev` joins the key so that when the store adopts a newer
              snapshot from Postgres (another tab wrote while this one was
              idle) the widget remounts around it instead of showing rows that
              no longer exist */}
          {/* `seed` is still in the key: undo/redo restores a snapshot and has
              to remount the widget around it. Only the scale left. */}
          <div className="gantt-holder min-h-0 flex-1" key={seed + "-" + projectId + "-" + st.storeRev}>
              <MGantt
                init={init}
                tasks={revivedTasks}
                links={links}
                taskTypes={TASK_TYPES}
                columns={COLUMNS}
                scales={DAY_SCALES}
                cellWidth={DAY_CELL_WIDTH}
                cellHeight={38}
                scaleHeight={36}
                /* The Scope column is 72px but the grid only grew by 48, so the
                   chart gives up less than the new column costs and the task
                   name gives up the remaining 24. Fixed rather than responsive
                   on purpose: SVAR re-runs `init(config)` on ANY prop change,
                   so a gridWidth that tracked the window would re-initialise
                   the store — and drop the filter — on every resize tick. The
                   widget's own draggable resizer is how this is adjusted. */
                gridWidth={748}
                start={range.start}
                end={range.end}
                autoScale={true}
                undo={true}
                summary={SUMMARY_CFG}
                highlightTime={HIGHLIGHT}
              />
          </div>
          {api && <MEditor api={api} items={EDITOR_ITEMS} />}
        </GridWillow>
        </CoreWillow>
        {/* a blank chart with no explanation is the one thing a filter must
            never leave behind */}
        {taskCount > 0 && filterOn && filterInfo.shown === 0 && (
          <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
            <div className="material-pop pointer-events-auto max-w-[380px] rounded-[14px] border border-line px-[1.625rem] py-[1.375rem] text-center motion-safe:animate-rise">
              <div className="mb-1.5 font-display text-title font-semibold">Nothing matches this filter</div>
              <p className="m-0 mb-3.5 text-copy text-muted">
                All {filterInfo.total} rows are still here — the filter only hides them on screen.
              </p>
              <button type="button" className={BTN} onClick={() => onFilter(EMPTY_FILTER)}>Clear filter</button>
            </div>
          </div>
        )}
        {taskCount === 0 && (
          <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
            <div className="material-pop pointer-events-auto max-w-[380px] rounded-[14px] border border-line px-[1.625rem] py-[1.375rem] text-center motion-safe:animate-rise">
              <div className="mb-1.5 font-display text-title font-semibold">Plan your first task</div>
              <p className="m-0 text-copy text-muted">Use <strong>“+”</strong> in the toolbar to add a task, then drag its bar to
              reschedule, drag its edge to resize, and double&#8209;click it to edit details.
              Double&#8209;click a task&#8217;s name in the list to rename it in place. Make a
              task an <strong>Epic</strong> and indent tasks under it — its length follows its
              tasks automatically.</p>
            </div>
          </div>
        )}
      </div>
      {/* The Scope column's own filter. Same bridge as the Who picker: the
          trigger is a node the tagger appended into a header cell the widget
          owns, so React cannot render the popover inside it — it anchors to the
          element through Ark's getAnchorRect instead. The stored rect is the
          fallback for when the widget re-renders the header away mid-flight. */}
      <Popover.Root
        open={!!scopePick}
        onOpenChange={(e) => { if (!e.open) setScopePick(null); }}
        positioning={{
          placement: "bottom",
          gutter: 6,
          getAnchorRect: () => {
            const p = scopePick || lastScopeRef.current.el;
            const r = p && p.isConnected ? p.getBoundingClientRect() : lastScopeRef.current.rect;
            return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
          },
        }}
      >
        <Portal>
          <Popover.Positioner style={{ zIndex: 60 }}>
            <Popover.Content className={`${POP} w-[254px] rounded-xl p-3`}>
              <Popover.Title className={POP_TITLE}>Release scope</Popover.Title>
              <Popover.Description className={POP_HINT}>
                Hides rows on screen only — the totals still count the whole project.
              </Popover.Description>
              {releaseChips}
              <div className="mt-3 flex items-center gap-2 border-t border-t-line-soft pt-2.5">
                <button
                  type="button"
                  className={BTN}
                  disabled={!liveFilter.releases.length}
                  onClick={() => onFilter({ types: filter.types, releases: [], people: filter.people })}
                >Clear</button>
                {filterOn && (
                  <span className="text-mini text-muted tabular-nums">{filterInfo.shown} of {filterInfo.total}</span>
                )}
              </div>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
      {/* the Who cell is built by the tagger, so this popover is controlled and
          anchored to that DOM node through getAnchorRect; the key remounts it
          per row so Ark re-measures instead of reusing the old placement.
          The key tracks the last *opened* row rather than the live one: closing
          would otherwise remount and cut the exit animation off mid-flight, and
          the anchor has to stay put for those 130ms so the panel collapses back
          into the cell it came out of (§7). */}
      <Popover.Root
        key={pickerKeyRef.current}
        open={!!picker}
        onOpenChange={(e) => { if (!e.open) setPicker(null); }}
        positioning={{
          placement: "bottom-start",
          gutter: 8,
          getAnchorRect: () => {
            const p = picker || lastPickerRef.current;
            if (!p) return null;
            const el = p.el;
            const r = el && el.isConnected ? el.getBoundingClientRect() : p.rect;
            return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
          },
        }}
      >
        <Portal>
          <Popover.Positioner style={{ zIndex: 60 }}>
            <Popover.Content className={`${POP} w-[228px] rounded-xl p-3`}>
              <Popover.Title className={POP_TITLE}>Assign</Popover.Title>
              {people.length === 0 ? (
                <Popover.Description className={POP_HINT}>No people yet — add them under <strong>People</strong> in the header.</Popover.Description>
              ) : (
                <ul className="m-0 mt-1.5 max-h-[260px] list-none overflow-y-auto p-0">
                  {people.map((h) => {
                    const on = picker ? picker.ids.includes(h.id) : false;
                    return (
                      <li key={h.id}>
                        <button
                          type="button"
                          className={`press flex w-full cursor-pointer items-center gap-2 rounded-lg border-0 px-1.5 py-[0.3125rem] text-left font-ui text-body text-ink hover:bg-surface-hover ${FOCUS} ${on ? "bg-accent-hover" : "bg-transparent"}`}
                          onClick={() => toggleAssignee(picker!.taskId, h.id)}
                        >
                          <span className="who-chip" style={{ "--who-hue": nameHue(h.name) }}>{initialsOf(h.name)}</span>
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{h.name}</span>
                          <span className="flex-none text-accent" aria-hidden="true">{on ? <Check size={13} weight="bold" /> : null}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
    </div>
  );
}
