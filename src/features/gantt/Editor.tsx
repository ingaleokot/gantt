import React, { useMemo, useRef, useState, useEffect, useCallback, memo } from "react";
import { Gantt, Toolbar, ContextMenu, Editor as TaskEditor } from "@svar-ui/react-gantt";
import type { IApi, IColumnConfig, ILink, IScaleConfig, ITask, TID } from "@svar-ui/react-gantt";
import { Willow as CoreWillow } from "@svar-ui/react-core";
import { Willow as GridWillow } from "@svar-ui/react-grid";
import { Menu } from "@ark-ui/react/menu";
import { Popover } from "@ark-ui/react/popover";
import { Portal } from "@ark-ui/react/portal";
import { SegmentGroup } from "@ark-ui/react/segment-group";
import { CaretDown, Check, DownloadSimple, ShareNetwork, SignOut, Users, X } from "@phosphor-icons/react";
import { buildGanttPdf } from "./pdf";
import type { Person, StoreLink, StoreProject, StoreTask, TaskId } from "../../lib/db";
import { uid, useStore } from "../projects/store";
import { setGlyph, type GlyphHost } from "./icons";
import { installWxiMasks } from "./lib/wxi-masks";
import { trackerId } from "./lib/tracker";
import { initialsOf, nameHue, parseAssignees } from "../people/roster";

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

/* store tasks with their dates revived: what the widget is handed */
interface RevivedTask extends Omit<StoreTask, "start" | "end"> {
  start?: Date;
  end?: Date;
}

export const TASK_TYPES = [
  { id: "task", label: "Task" },
  { id: "backend", label: "Backend" },
  { id: "frontend", label: "Frontend" },
  { id: "design", label: "Design" },
  { id: "testing", label: "Testing" },
  { id: "summary", label: "Epic" },
  { id: "milestone", label: "Milestone" },
];
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
const SEG_ROOT = "flex gap-0.5 rounded-[9px] border border-line bg-surface p-0.5";
const SEG_ITEM =
  "press flex cursor-pointer select-none items-center rounded-[7px] border-0 bg-transparent px-3.5 py-[0.3125rem] font-ui text-small font-medium text-muted hover:bg-surface-hover hover:text-ink data-[state=checked]:bg-accent data-[state=checked]:text-accent-ink data-[state=checked]:hover:bg-accent data-[state=checked]:hover:text-accent-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent";
const BRAND_MARK =
  "block h-3.5 w-3.5 rounded-[4px] bg-[linear-gradient(135deg,var(--color-accent)_0_50%,var(--color-summary-fill)_50%_100%)]";

const COLUMNS: IColumnConfig[] = [
  { id: "text", header: "Task name", width: 183, flexgrow: 1, sort: true, editor: "text" },
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

/* ---------- working-time model: estimates in hours, 7h = 1 work day, weekends skipped ---------- */
const HOURS_PER_DAY = 7;
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

const EDITOR_ITEMS = [
  { key: "text", comp: "text", label: "Name", config: { placeholder: "Add task name" } },
  { key: "details", comp: "textarea", label: "Description", config: { placeholder: "Add description" } },
  { key: "type", comp: "select", label: "Type", options: TASK_TYPES },
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
/* epics recalculate from their children when parsed without dates;
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
    /* anything with tasks under it is an epic */
    if (parents.has(r.id) && r.type !== "summary") r.type = "summary";
    if (r.type === "summary" && parents.has(r.id)) { delete r.start; delete r.end; delete r.duration; return r; }
    if (r.type === "summary" && !r.start) {
      /* a childless epic must carry dates or the widget throws */
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
const KEEP = ["id", "text", "start", "end", "duration", "hours", "days", "progress", "parent", "type", "open", "details", "url", "status", "assignees"];
function cleanTask(t: ITask): StoreTask {
  const out: Partial<StoreTask> = {};
  for (const k of KEEP) {
    if (t[k] === undefined || t[k] === null) continue;
    /* the KEEP loop copies by dynamic key, so the write side is untyped and
       the whole object is asserted once on the way out */
    (out as Record<string, unknown>)[k] = t[k];
  }
  if (out.start) out.start = fmtDate(t.start);
  if (out.end) out.end = fmtDate(t.end);
  if (out.parent === 0) delete out.parent;
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
}
function computeStats(api: GanttApi): Stats | null {
  let list: StoreTask[] = [];
  try { list = serializeSide(api, "tasks"); } catch (e) { return null; }
  let h = 0, tasks = 0, epics = 0, min: string | null = null, max: string | null = null;
  list.forEach((t) => {
    if (t.type === "summary") { epics++; }
    else if (t.type !== "milestone") { tasks++; h += Number(t.hours) || 0; }
    if (t.type !== "summary") {
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
    tasks, epics,
  };
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

/* epic estimates roll up from the tasks inside them */
let ROLLUP_WRITE = false;
function rollupEpics(api: GanttApi) {
  let list: StoreTask[] = [];
  try { list = serializeSide(api, "tasks"); } catch (e) { return; }
  const byParent: Record<string, StoreTask[]> = {};
  list.forEach((t) => { const p = t.parent === undefined ? 0 : t.parent; (byParent[p] = byParent[p] || []).push(t); });
  /* plan the derived writes first */
  const writes: { id: TaskId; task: Partial<ITask> }[] = [];
  list.forEach((t) => {
    if (t.type !== "summary" && (byParent[t.id] || []).length) {
      writes.push({ id: t.id, task: { type: "summary" } });
      t.type = "summary";
    }
  });
  const sumOf = (id: TaskId): number => {
    let s = 0;
    (byParent[id] || []).forEach((c) => {
      if (c.type === "summary") s += sumOf(c.id);
      else if (c.type !== "milestone") s += Number(c.hours) || 0;
    });
    return s;
  };
  /* An epic with nothing under it has no roll-up to compute: the sum would be
     0, and because the update-task intercept refuses manual hours on a summary
     the user could never put the number back. Converting a task to an epic used
     to erase its estimate that way, silently and permanently. Leave a childless
     epic's stored estimate exactly where it is — the moment it gains a task the
     roll-up takes over again. */
  list.filter((t) => t.type === "summary" && (byParent[String(t.id)] || []).length > 0).forEach((e) => {
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
const personById = (id: string): Person | null => rosterRef.find((h) => h.id === id) || null;
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
  btn.title = anyOpen ? "Collapse all epics" : "Expand all epics";
  /* the button is built just above with exactly one <span class="ci"> child */
  const icon = btn.firstChild as GlyphHost;
  const name = anyOpen ? "ci-collapse" : "ci-expand";
  const cls = "ci " + name;
  if (icon.className !== cls) icon.className = cls;
  setGlyph(icon, name); /* cached Phosphor SVG, rendered once at module scope */
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
    if (t.type !== "summary") continue;
    let j = i + 1;
    while (j < rows.length && rows[j].$level > t.$level) j++;
    if (j === i + 1) continue; /* collapsed or childless epic: no band */
    html += '<div class="epic-band" style="top:' + i * ch + "px;height:" + (j - i) * ch + 'px"></div>';
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
      row.classList.toggle("is-epic", t.type === "summary");
      row.classList.toggle("in-epic", t.type !== "summary" && (t.$level || 1) > 1);
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
      const typeKey = "ti-" + (t.type || "task");
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
        const label = t.type === "summary" ? "Edit epic" : "Edit task";
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
    });
    syncFoldAllButton(api);
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

/* ---------- view presets ---------- */
interface ViewPreset {
  label: string;
  cellWidth: number;
  scales: IScaleConfig[];
}
/* keyed by string, not a literal union: the stored `view` is whatever came out
   of Postgres, and every read below already falls back to "day" */
const VIEWS: Record<string, ViewPreset> = {
  day:   { label: "Day",   cellWidth: 36,  scales: [{ unit: "month", step: 1, format: "%F %Y" }, { unit: "day", step: 1, format: "%j" }] },
  week:  { label: "Week",  cellWidth: 74,  scales: [{ unit: "month", step: 1, format: "%M %Y" }, { unit: "week", step: 1, format: "w%W" }] },
  month: { label: "Month", cellWidth: 110, scales: [{ unit: "year", step: 1, format: "%Y" }, { unit: "month", step: 1, format: "%M" }] },
};

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
  /* resolved from ?view= first, the project's stored scale second */
  view: string;
  onView: (v: string) => void;
  onOpenProject: (id: string) => void;
  onNewProject: () => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}

/* ---------- the editor for one project ---------- */
export default function GanttEditor({
  projectId, view, onView, onOpenProject, onNewProject, onDeleteProject, onSignOut,
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
  const [copied, setCopied] = useState(false);
  const shareInputRef = useRef<HTMLInputElement>(null);
  const [armDelete, setArmDelete] = useState<string | null>(null);
  const nameRef = useRef(activeProject().name);
  const clipRef = useRef<Clipboard | null>(null);
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const snapTimer = useRef<number | null>(null);
  const apiRef = useRef<GanttApi | null>(null);

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
      const doc = buildGanttPdf(p.name, p.tasks, p.links);
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
  }, [scheduleSave, scheduleSnapshot, seedSnapshot, projectId]);

  /* ---------- people roster ---------- */
  /* the tagger reads the roster from module scope; keep it in step and repaint */
  useEffect(() => {
    rosterRef = people;
    if (retagHook) retagHook();
  }, [people]);

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

  /* ---------- project actions: the URL is what changes, not local state ----------
     every one of them serializes the widget into the draft first, so nothing
     in flight is lost when this component unmounts on the navigation */
  const openProject = (id: string) => {
    setArmDelete(null);
    if (id === projectId) return;
    scheduleSave();
    onOpenProject(id);
  };
  const createProject = () => {
    setArmDelete(null);
    scheduleSave();
    void onNewProject();
  };
  const deleteProject = (id: string) => {
    if (armDelete !== id) { setArmDelete(id); return; }
    setArmDelete(null);
    scheduleSave();
    void onDeleteProject(id);
  };

  const changeView = (v: string) => {
    const p = snapshotActive();
    p.view = v;
    /* the holder is keyed on seed+view+project, so the widget remounts; bump
       the seed too or it would remount around the previous serialization */
    setSeed((s) => s + 1);
    stRef.current.scheduleSave();
    onView(v);
  };

  const onName = (e: React.SyntheticEvent<HTMLHeadingElement>) => {
    nameRef.current = e.currentTarget.textContent?.trim() || "Untitled project";
    activeProject().name = nameRef.current;
    scheduleSave();
  };

  /* the Who popover's remount key and anchor both survive the close, so the
     exit animation has a stable origin to collapse into; both are plain refs
     updated during render, which is idempotent under StrictMode */
  if (picker) {
    pickerKeyRef.current = String(picker.taskId);
    lastPickerRef.current = picker;
  }

  const vd = VIEWS[view] || VIEWS.day;
  let statusText = {
    idle: "", saving: "Saving…", saved: "Saved · Supabase", local: "Not saved — Supabase unavailable",
  }[st.status];
  /* only a failed save belongs on the save pill; a failed create, delete or
     "last opened" write is its own thing and gets its own pill below */
  if (st.status === "local" && st.error) statusText += " · " + st.error;
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
  const projects = st.projects;

  return (
    <div className="flex h-full flex-col">
      {/* the topbar is a material, not a painted strip: a translucent layer with
          a bright top edge, closed off by a soft scroll edge instead of a rule */}
      <header className="material-chrome edge-fade relative z-10 flex flex-none items-center gap-3 pt-2.5 pr-[18px] pb-2.5 pl-4">
        <div aria-hidden="true"><span className={BRAND_MARK} /></div>
        {/* the title carries no `press`: it is a text field, so a scale on
            pointer-down would fight the caret rather than confirm a commit */}
        <div className="flex items-center gap-0.5">
          <h1
            key={projectId}
            className="m-0 max-w-[46vw] min-w-[60px] overflow-hidden rounded-[7px] px-2 py-[0.1875rem] font-display text-display font-semibold text-ellipsis whitespace-nowrap outline-none transition-colors duration-[130ms] ease-out hover:bg-surface-hover focus-visible:bg-surface focus-visible:shadow-[0_0_0_2px_var(--color-accent)]"
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onInput={onName}
            onBlur={onName}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
          >{activeProject().name}</h1>
          <Menu.Root
            positioning={{ placement: "bottom-start", gutter: 6 }}
            onOpenChange={(e) => { if (!e.open) setArmDelete(null); }}
            onSelect={(d) => (d.value === "::new" ? createProject() : openProject(d.value))}
          >
            <Menu.Trigger
              className={`press press-sm flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-surface-hover hover:text-ink ${FOCUS}`}
              aria-label="Switch project"
            >
              <CaretDown size={12} weight="bold" aria-hidden="true" />
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner style={{ zIndex: 40 }}>
                <Menu.Content className={`${POP} min-w-[240px] rounded-[11px] p-1.5`}>
                  <div className="px-2.5 pt-[0.3125rem] pb-1 text-label font-semibold text-faint uppercase">Projects</div>
                  {projects.map((p) => (
                    <div key={p.id} className="group flex items-center gap-0.5 rounded-lg transition-colors duration-[130ms] ease-out hover:bg-surface-hover">
                      <Menu.Item
                        value={p.id}
                        className={`press flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-[0.4375rem] text-left font-ui text-body text-ink data-[highlighted]:bg-surface-hover ${FOCUS}`}
                      >
                        <span
                          className={`h-[7px] w-[7px] flex-none rounded-full ${p.id === projectId ? "bg-accent" : "bg-line"}`}
                          aria-hidden="true"
                        />
                        <span className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${p.id === projectId ? "font-semibold text-accent" : ""}`}>{p.name}</span>
                        <span className="text-tiny text-faint tabular-nums">{p.tasks.length || ""}</span>
                      </Menu.Item>
                      {/* two-step confirm, not a modal: the second click deletes.
                          Deleting the last project is allowed now — `/` has a
                          real empty state instead of inventing one. */}
                      <button
                        className={
                          armDelete === p.id
                            ? `press press-sm flex-none cursor-pointer rounded-[7px] border-0 bg-transparent px-2 py-[0.3125rem] font-ui text-tiny leading-none font-semibold text-danger opacity-100 ${FOCUS}`
                            : `press press-sm flex-none cursor-pointer rounded-[7px] border-0 bg-transparent px-2 py-[0.3125rem] font-ui text-copy leading-none text-faint opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100 ${FOCUS}`
                        }
                        type="button"
                        onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}
                        title={armDelete === p.id ? "Click again to delete" : "Delete project"}
                      >{armDelete === p.id ? "Sure?" : <X size={13} aria-hidden="true" />}</button>
                    </div>
                  ))}
                  <Menu.Item
                    value="::new"
                    className={`press mt-1 block w-full cursor-pointer rounded-b-lg border-0 border-t border-t-line-soft bg-transparent px-2.5 py-[0.4375rem] text-left font-ui text-body font-medium text-accent hover:rounded-lg hover:bg-accent-hover data-[highlighted]:rounded-lg data-[highlighted]:bg-accent-hover ${FOCUS}`}
                  >+ New project</Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        </div>
        {statusText && (
          <span
            className={
              st.status === "saved"
                ? "rounded-full border border-transparent bg-accent-hover px-2.5 py-[0.1875rem] text-mini whitespace-nowrap text-accent"
                : "rounded-full border border-line bg-surface px-2.5 py-[0.1875rem] text-mini whitespace-nowrap text-muted"
            }
          >{statusText}</span>
        )}
        {/* not decoration: each of these is something that did not happen.
            Clicking one dismisses it — the underlying state re-raises it if it
            is still true. */}
        {alerts.map((a) =>
          a.dismiss ? (
            <button
              key={a.key}
              type="button"
              title={a.text + " — click to dismiss"}
              onClick={a.dismiss}
              className={`press max-w-[34vw] cursor-pointer overflow-hidden rounded-full border border-danger bg-surface px-2.5 py-[0.1875rem] text-left text-mini text-ellipsis whitespace-nowrap text-danger ${FOCUS}`}
            >{a.text}</button>
          ) : (
            /* not dismissible: it clears itself when the thing it reports does */
            <span
              key={a.key}
              role="status"
              title={a.text}
              className="max-w-[34vw] overflow-hidden rounded-full border border-danger bg-surface px-2.5 py-[0.1875rem] text-mini text-ellipsis whitespace-nowrap text-danger"
            >{a.text}</span>
          ),
        )}
        {stats && stats.min && stats.max && (
          /* hours and days are EFFORT — the work inside the bar — not the
             length of the bar. An epic's pair is the sum of its tasks' effort
             sitting next to a calendar span that is nothing like it, so the
             word has to be on screen. */
          <span className="pl-1 text-mini whitespace-nowrap text-muted tabular-nums max-[1100px]:hidden">
            {fmtD(stats.min)} – {fmtD(new Date(stats.max.getTime() - DAY))}
            {" · effort "}<strong className="font-semibold text-ink">{stats.h}h</strong> / {stats.d}d
            {stats.epics > 0 && " · " + stats.epics + (stats.epics === 1 ? " epic" : " epics")}
          </span>
        )}
        <div className="flex-1" />
        <Popover.Root positioning={{ placement: "bottom-end", gutter: 8 }}>
          <Popover.Trigger className={BTN}>
            <Users size={14} aria-hidden="true" />
            People{people.length ? " · " + people.length : ""}
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
          <Popover.Trigger className={BTN}>
            <ShareNetwork size={13} aria-hidden="true" />
            Share
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
        <button className={BTN} type="button" onClick={exportPdf} disabled={exporting}>
          <DownloadSimple size={13} aria-hidden="true" />
          {exporting ? "Exporting…" : "Export PDF"}
        </button>
        <SegmentGroup.Root
          className={SEG_ROOT}
          aria-label="Timeline scale"
          value={view}
          onValueChange={(d) => { if (d.value) changeView(d.value); }}
        >
          {Object.entries(VIEWS).map(([k, v]) => (
            <SegmentGroup.Item key={k} value={k} className={SEG_ITEM}>
              <SegmentGroup.ItemText>{v.label}</SegmentGroup.ItemText>
              <SegmentGroup.ItemHiddenInput />
            </SegmentGroup.Item>
          ))}
        </SegmentGroup.Root>
        <button
          className={BTN}
          type="button"
          title="Sign out"
          onClick={() => { void onSignOut(); }}
        >
          <SignOut size={13} aria-hidden="true" />
          Sign out
        </button>
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
          <div className="gantt-holder min-h-0 flex-1" key={seed + "-" + view + "-" + projectId + "-" + st.storeRev}>
              <MGantt
                init={init}
                tasks={revivedTasks}
                links={links}
                taskTypes={TASK_TYPES}
                columns={COLUMNS}
                scales={vd.scales}
                cellWidth={vd.cellWidth}
                cellHeight={38}
                scaleHeight={36}
                gridWidth={700}
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
