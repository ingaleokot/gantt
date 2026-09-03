import { useMemo, useRef, useState, useEffect, useCallback, memo } from "react";
import { Gantt } from "@svar-ui/react-gantt";
import type { IApi, IColumnConfig, IScaleConfig, ITask, TID } from "@svar-ui/react-gantt";
import { Willow as CoreWillow } from "@svar-ui/react-core";
import { Willow as GridWillow } from "@svar-ui/react-grid";
import { SegmentGroup } from "@ark-ui/react/segment-group";
import { setGlyph, type GlyphHost } from "./icons";
import { installWxiMasks } from "./lib/wxi-masks";
import { trackerId } from "./lib/tracker";
import { initialsOf, nameHue, parseAssignees } from "../people/roster";

/* The stylesheets are imported once by src/main.tsx, in the order that matters.
   This module must not reach lib/ — pulling the Supabase client into the
   public page is exactly what the split is there to prevent. */

/* the masks for SVAR's own <i class="wxi-…"> icons, generated once from
   @phosphor-icons/react as this chunk loads — see ./lib/wxi-masks */
installWxiMasks();

/* ---------- the library shapes this page narrows, same reasons as app.tsx:
   IApi types getTask as ITask, the store returns a parsed task; the shipped
   GanttScaleCell omits the `date` the rendered cells carry ---------- */
type ParsedTask = ITask & { id: TID; parent: TID; $level: number };
type GanttApi = Omit<IApi, "getTask"> & { getTask: (id: TID) => ParsedTask };
type ScaleCell = { width: number; date: Date };
type ScaleRow = { cells: ScaleCell[] };
type ScaleData = { rows: ScaleRow[] } | null | undefined;

interface Person {
  id: string;
  name: string;
}
/* the read-only page's own task shape: ids and dates are the text columns the
   edge function serves, never the numeric ids the editor's widget mints */
interface ViewTask {
  id: string;
  text: string;
  type: string;
  progress: number;
  details: string;
  parent?: string | number;
  start?: string;
  end?: string;
  duration?: number;
  hours?: number;
  days?: number;
  open?: boolean;
  url?: string;
  assignees?: string;
  /* written just after the object literal in shapeStore, hence optional */
  status?: string;
}
interface ViewLink {
  id: string;
  source: string;
  target: string;
  type: string;
}
interface ViewProject {
  id?: string;
  name: string;
  view?: string;
  tasks: ViewTask[];
  links: ViewLink[];
}
interface ViewStore {
  projects: ViewProject[];
  active: string | null;
}
interface RevivedTask extends Omit<ViewTask, "start" | "end"> {
  start?: Date;
  end?: Date;
}

const DAY = 24 * 60 * 60 * 1000;
const HOURS_PER_DAY = 7;
const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
function rollForward(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (isWeekend(x)) x.setDate(x.getDate() + 1);
  return x;
}
function addWorkDays(start: Date, n: number) {
  const x = new Date(start.getTime());
  let left = Math.max(1, n);
  while (left > 1) { x.setDate(x.getDate() + 1); if (!isWeekend(x)) left--; }
  const e = new Date(x.getTime());
  e.setDate(e.getDate() + 1);
  return e;
}
function workDaysBetween(s: Date, e: Date) {
  let c = 0;
  const x = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  while (x < e) { if (!isWeekend(x)) c++; x.setDate(x.getDate() + 1); }
  return Math.max(1, c);
}
const isBar = (t: { type?: string } | null | undefined) => t && t.type !== "summary" && t.type !== "milestone";
function scheduleFromHours(hours: number | undefined, startLike: Date | undefined) {
  const start = rollForward(startLike instanceof Date ? startLike : new Date());
  const h = Math.max(0.5, Math.round((Number(hours) || HOURS_PER_DAY) * 2) / 2);
  const end = addWorkDays(start, Math.ceil(h / HOURS_PER_DAY));
  const days = Math.round((h / HOURS_PER_DAY) * 10) / 10;
  return { hours: h, days, start, end, duration: Math.round((+end - +start) / DAY) };
}
function reviveTask(t: ViewTask): RevivedTask {
  /* start/end come in as ISO day strings and leave as Dates */
  const out = { ...t } as unknown as RevivedTask;
  if (t.start) out.start = new Date(t.start + "T00:00:00");
  if (t.end) out.end = new Date(t.end + "T00:00:00");
  return out;
}
function prepareTasks(tasks: ViewTask[]): RevivedTask[] {
  const parents = new Set(tasks.map((t) => t.parent).filter((p) => p !== undefined && p !== null && p !== 0));
  return tasks.map((t) => {
    const r = reviveTask(t);
    if (parents.has(r.id) && r.type !== "summary") r.type = "summary";
    if (r.type === "summary" && parents.has(r.id)) { delete r.start; delete r.end; delete r.duration; return r; }
    if (r.type === "summary" && !r.start) {
      r.start = rollForward(new Date());
      r.end = addWorkDays(r.start, 1);
      r.duration = Math.round((+r.end - +r.start) / DAY);
      return r;
    }
    if (isBar(r)) {
      if (!r.hours) r.hours = (r.start && r.end ? workDaysBetween(r.start, r.end) : Math.max(1, r.duration || 1)) * HOURS_PER_DAY;
      const fixed = scheduleFromHours(r.hours, r.start || new Date());
      r.hours = fixed.hours; r.start = fixed.start; r.end = fixed.end; r.duration = fixed.duration;
      if (!r.days) r.days = fixed.days;
    }
    return r;
  });
}
let rosterRef: Person[] = [];
const personById = (id: string): Person | null => rosterRef.find((h) => h.id === id) || null;
/* parseAssignees / initialsOf / nameHue live in features/people/roster.ts and
   trackerId in ./lib/tracker — both editor and viewer had the same copy. */

/* ---------- data comes from the `shared` edge function at runtime ---------- */
/* One project per request. The endpoint refuses to answer without a target,
   so a link can never expose anything but the timeline it points at. */
const dataUrl = (projectId: string) =>
  import.meta.env.VITE_SUPABASE_URL +
  "/functions/v1/shared?raw=1&project=" + encodeURIComponent(projectId);

/* the JSON the edge function publishes: the same rows Postgres holds, so every
   id is text. shapeStore re-checks `projects` before trusting any of it. */
interface FeedTask {
  id: string;
  project?: string;
  parent?: string | number | null;
  text?: string;
  type?: string;
  progress?: number;
  details?: string;
  start?: string;
  end?: string;
  duration?: number | null;
  hours?: number | null;
  days?: number | null;
  url?: string;
  assignees?: string;
  status?: string;
}
interface FeedLink {
  id: string;
  project?: string;
  source: string;
  target: string;
  type?: string;
}
interface FeedProject {
  id: string;
  name: string;
  view?: string;
}
interface Feed {
  active?: string | null;
  projects: FeedProject[];
  tasks?: FeedTask[];
  links?: FeedLink[];
  people?: { id: string; name?: string }[];
}

async function fetchStore(projectId: string): Promise<Feed> {
  const r = await fetch(dataUrl(projectId), { cache: "no-store" });
  if (!r.ok) throw new Error((await r.text()) || "HTTP " + r.status);
  return r.json();
}

function shapeStore(raw: Feed | null): ViewStore {
  const empty: Feed = { active: null, projects: [], tasks: [], links: [], people: [] };
  const s = raw && Array.isArray(raw.projects) ? raw : empty;
  rosterRef = (s.people || []).filter((h) => h && h.id).map((h) => ({ id: h.id, name: h.name || "" }));
  const projects: ViewProject[] = s.projects.map((p) => ({
    id: p.id,
    name: p.name,
    view: p.view || "day",
    tasks: (s.tasks || []).filter((t) => t.project === p.id).map((t) => {
      const o: ViewTask = { id: t.id, text: t.text || "", type: t.type || "task", progress: t.progress || 0, details: t.details || "" };
      if (t.parent !== null && t.parent !== undefined) o.parent = t.parent;
      if (t.start) o.start = t.start;
      if (t.end) o.end = t.end;
      if (t.duration !== null && t.duration !== undefined) o.duration = t.duration;
      if (t.hours !== null && t.hours !== undefined) o.hours = Number(t.hours);
      if (t.days !== null && t.days !== undefined) o.days = Number(t.days);
      if ((s.tasks || []).some((c) => c.parent === t.id)) o.open = true; /* branches start expanded for viewers */
      if (t.url) o.url = t.url;
      if (t.assignees) o.assignees = t.assignees;
      o.status = t.status || "todo";
      return o;
    }),
    links: (s.links || []).filter((l) => l.project === p.id).map((l) => ({ id: l.id, source: l.source, target: l.target, type: l.type || "e2s" })),
  }));
  /* `some` proves s.active is one of the ids, which the compiler cannot see */
  const active = projects.some((p) => p.id === s.active) ? s.active! : projects.length ? projects[0].id! : null;
  return { projects, active };
}

interface ViewPreset {
  label: string;
  cellWidth: number;
  scales: IScaleConfig[];
}
/* keyed by string, not a literal union: the stored `view` is whatever came out
   of Postgres */
const VIEWS: Record<string, ViewPreset> = {
  day:   { label: "Day",   cellWidth: 36,  scales: [{ unit: "month", step: 1, format: "%F %Y" }, { unit: "day", step: 1, format: "%j" }] },
  week:  { label: "Week",  cellWidth: 74,  scales: [{ unit: "month", step: 1, format: "%M %Y" }, { unit: "week", step: 1, format: "w%W" }] },
  month: { label: "Month", cellWidth: 110, scales: [{ unit: "year", step: 1, format: "%Y" }, { unit: "month", step: 1, format: "%M" }] },
};
const HIGHLIGHT = (d: Date, u: "day" | "hour") => (u === "day" && (d.getDay() === 0 || d.getDay() === 6) ? "wx-weekend" : "");
const COLUMNS: IColumnConfig[] = [
  { id: "text", header: "Task name", width: 183, flexgrow: 1, sort: true },
  { id: "who", header: "Who", width: 78, align: "center", sort: false },
  { id: "tracker", header: "ID", width: 100, align: "center", sort: false },
  { id: "start", header: "Start", width: 92, align: "center", sort: true },
  /* "Effort", not "Hrs"/"Days" — the editor labels the same two columns the
     same way. They are how much work a row contains, and on an epic they are
     the sum of its tasks' work, which is nothing like the length of its bar. */
  { id: "hours", header: "Effort h", width: 84, align: "center", sort: true },
  { id: "days", header: "Effort d", width: 78, align: "center", sort: true },
];
/* `dot` is a complete literal class string: Tailwind's scanner only sees class
   names spelled out in the source, never ones assembled at runtime */
const LEGEND = [
  { id: "backend", label: "Backend", dot: "bg-type-backend" },
  { id: "frontend", label: "Frontend", dot: "bg-type-frontend" },
  { id: "design", label: "Design", dot: "bg-type-design" },
  { id: "testing", label: "Testing", dot: "bg-type-testing" },
];

/* the shell recipes the editor uses, kept in step by hand */
const SEG_ROOT = "flex gap-0.5 rounded-[9px] border border-line bg-surface p-0.5";
const SEG_ITEM =
  "press flex cursor-pointer select-none items-center rounded-[7px] border-0 bg-transparent px-3.5 py-[0.3125rem] font-ui text-small font-medium text-muted hover:bg-surface-hover hover:text-ink data-[state=checked]:bg-accent data-[state=checked]:text-accent-ink data-[state=checked]:hover:bg-accent data-[state=checked]:hover:text-accent-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent";
const BRAND_MARK =
  "block h-3.5 w-3.5 rounded-[4px] bg-[linear-gradient(135deg,var(--color-accent)_0_50%,var(--color-summary-fill)_50%_100%)]";
const BOOT = "grid min-h-screen place-items-center bg-ground font-ui text-body text-muted";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtD = (d: Date) => d.getDate() + " " + MON[d.getMonth()];

/* ---------- visual decorations (same look as the editor app) ---------- */
let rowTagObserver: MutationObserver | null = null;
/* the tagger stamps a signature onto the nodes it owns so a re-run can skip
   the ones already showing the right thing */
type KeyedHost = HTMLElement & { __key?: string };
type BandLayer = HTMLElement & { __html?: string };
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
function decorate(api: GanttApi, project: ViewProject) {
  document.querySelectorAll<HTMLElement>(".gantt-holder .wx-row[data-id]").forEach((row) => {
    const raw = row.getAttribute("data-id") || "";
    const id = raw.startsWith(":") ? raw.slice(1) : raw;
    let t: ParsedTask | null = null;
    try { t = api.getTask(id); } catch (e) {}
    if (!t && /^\d+$/.test(id)) { try { t = api.getTask(Number(id)); } catch (e) {} }
    if (!t) return;
    row.classList.toggle("is-epic", t.type === "summary");
    row.classList.toggle("in-epic", t.type !== "summary" && (t.$level || 1) > 1);
    const status = t.status === "done" || t.status === "progress" ? t.status : "todo";
    ["st-todo", "st-progress", "st-done"].forEach((c) => row.classList.remove(c));
    row.classList.add("st-" + status);
    const content = row.querySelector<HTMLElement>('[data-col-id=":text"] .wx-content');
    if (content) {
      let dot = content.querySelector<HTMLElement>(".status-dot");
      if (!dot) { dot = document.createElement("span"); dot.className = "status-dot"; content.appendChild(dot); }
      const dc = "status-dot sd-" + status;
      if (dot.className !== dc) dot.className = dc;
      const typeKey = "ti-" + (t.type || "task");
      const iconCls = "type-icon " + typeKey;
      let ic = content.querySelector<GlyphHost>(".type-icon");
      if (!ic) { ic = document.createElement("span"); ic.className = iconCls; content.appendChild(ic); }
      else if (ic.className !== iconCls) ic.className = iconCls;
      setGlyph(ic, typeKey); /* cached Phosphor SVG, rendered once at module scope */
    }
    const whoCell = row.querySelector<HTMLElement>('[data-col-id=":who"]');
    if (whoCell) {
      const assigned = parseAssignees(t.assignees).map(personById).filter((h): h is Person => !!h);
      let wrap = whoCell.querySelector<HTMLSpanElement & KeyedHost>(".who-chips");
      if (!assigned.length) {
        if (wrap) wrap.remove();
      } else {
        if (!wrap) {
          wrap = document.createElement("span");
          wrap.className = "who-chips";
          (whoCell.querySelector(".wx-content") || whoCell).appendChild(wrap);
        }
        const key = assigned.map((h) => h.id + "\u0000" + h.name).join("|");
        if (wrap.__key !== key) {
          wrap.__key = key;
          wrap.textContent = "";
          const shown = assigned.slice(0, 3);
          for (const h of shown) {
            const chip = document.createElement("span");
            chip.className = "who-chip";
            chip.style.setProperty("--who-hue", String(nameHue(h.name)));
            chip.textContent = initialsOf(h.name);
            chip.title = h.name;
            wrap.appendChild(chip);
          }
          if (assigned.length > shown.length) {
            const more = document.createElement("span");
            more.className = "who-chip who-more";
            more.textContent = "+" + (assigned.length - shown.length);
            more.title = assigned.slice(shown.length).map((h) => h.name).join(", ");
            wrap.appendChild(more);
          }
        }
        wrap.title = assigned.map((h) => h.name).join(", ");
      }
    }
    const rawUrl = typeof t.url === "string" && /^https?:\/\//i.test(t.url.trim()) ? t.url.trim() : null;
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
          (cell.querySelector(".wx-content") || cell).appendChild(a2);
        }
        /* tid is only non-null when rawUrl was, which the compiler misses */
        if (a2.getAttribute("href") !== rawUrl) { a2.setAttribute("href", rawUrl!); a2.title = rawUrl!; }
        if (a2.textContent !== tid) a2.textContent = tid;
      } else if (a2) a2.remove();
    }
  });
  document.querySelectorAll<HTMLElement>(".gantt-holder .wx-bar[data-task-id]").forEach((bar) => {
    const raw = bar.getAttribute("data-task-id") || "";
    const id = raw.startsWith(":") ? raw.slice(1) : raw;
    let t: ParsedTask | null = null;
    try { t = api.getTask(id); } catch (e) {}
    if (!t) return;
    const status = t.status === "done" || t.status === "progress" ? t.status : "todo";
    ["st-todo", "st-progress", "st-done"].forEach((c) => bar.classList.remove(c));
    bar.classList.add("st-" + status);
  });
  /* epic bands */
  const area = document.querySelector<HTMLElement>(".gantt-holder .wx-area");
  if (area) {
    let layer = area.querySelector<BandLayer>(":scope > .epic-bands");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "epic-bands";
      const hol = area.querySelector(":scope > .wx-gantt-holidays");
      if (hol) hol.after(layer); else area.prepend(layer);
    }
    let rows: ParsedTask[] = [], ch = 38;
    try {
      const st = api.getState();
      ch = st.cellHeight || 38;
      rows = (st._tasks || []).filter((t) => !t.$skip);
    } catch (e) { rows = []; }
    let html = "";
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      if (t.type !== "summary") continue;
      let j = i + 1;
      while (j < rows.length && rows[j].$level > t.$level) j++;
      if (j === i + 1) continue;
      html += '<div class="epic-band" style="top:' + i * ch + "px;height:" + (j - i) * ch + 'px"></div>';
    }
    if (layer.__html !== html) { layer.innerHTML = html; layer.__html = html; }
  }
  /* project span line */
  const scaleEl = document.querySelector<HTMLElement>(".gantt-holder .wx-chart > .wx-scale");
  if (scaleEl) {
    let el = scaleEl.querySelector<HTMLElement>(":scope > .project-span");
    let min: string | null = null, max: string | null = null;
    project.tasks.forEach((t) => {
      if (t.type === "summary") return;
      if (t.start && (!min || t.start < min)) min = t.start;
      const e = t.end || t.start;
      if (e && (!max || e > max)) max = e;
    });
    const sc = (() => { try { return api.getState()._scales as unknown as ScaleData; } catch (e) { return null; } })();
    if (min && max && sc) {
      const x0 = xForDate(sc, new Date(min + "T00:00:00")), x1 = xForDate(sc, new Date(max + "T00:00:00"));
      if (x0 !== null && x1 !== null && x1 - x0 >= 2) {
        if (!el) { el = document.createElement("div"); el.className = "project-span"; scaleEl.appendChild(el); }
        el.style.left = Math.round(x0) + "px";
        el.style.width = Math.round(x1 - x0) + "px";
      } else if (el) el.remove();
    } else if (el) el.remove();
  }
}
function watchDecorations(api: GanttApi, project: ViewProject) {
  if (rowTagObserver) { rowTagObserver.disconnect(); rowTagObserver = null; }
  let raf = 0;
  const run = () => {
    raf = 0;
    decorate(api, project);
    if (rowTagObserver) rowTagObserver.takeRecords();
  };
  const sched = () => { if (!raf) raf = requestAnimationFrame(run); };
  const target = document.querySelector(".gantt-holder");
  if (target) {
    rowTagObserver = new MutationObserver(sched);
    rowTagObserver.observe(target, { childList: true, subtree: true });
  }
  sched();
}

const MGantt = memo(Gantt);

interface Stats {
  h: number;
  d: number;
  min: Date | null;
  max: Date | null;
  epics: number;
}
function computeStats(tasks: ViewTask[]): Stats {
  let h = 0, epics = 0, min: string | null = null, max: string | null = null;
  tasks.forEach((t) => {
    if (t.type === "summary") { epics++; return; }
    if (t.type !== "milestone") h += Number(t.hours) || 0;
    if (t.start && (!min || t.start < min)) min = t.start;
    const e = t.end || t.start;
    if (e && (!max || e > max)) max = e;
  });
  return {
    h: Math.round(h * 2) / 2,
    d: Math.round((h / HOURS_PER_DAY) * 10) / 10,
    min: min ? new Date(min + "T00:00:00") : null,
    max: max ? new Date(max + "T00:00:00") : null,
    epics,
  };
}

function Board({ store, activeId }: { store: ViewStore; activeId: string | null }) {
  const [view, setView] = useState("day");
  const [seed, setSeed] = useState(0);
  const apiRef = useRef<GanttApi | null>(null);

  /* ShareViewer only mounts Board once the feed has at least one project */
  const project: ViewProject = store.projects.find((p) => p.id === activeId) || store.projects[0];
  const revivedTasks = useMemo(() => prepareTasks(project.tasks), [activeId, seed]);
  const links = useMemo(() => project.links.slice(), [activeId, seed]);
  const stats = useMemo(() => computeStats(project.tasks), [activeId]);

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

  const init = useCallback((raw: IApi) => {
    /* the one place the shipped IApi is narrowed (see GanttApi above) */
    const a = raw as GanttApi;
    apiRef.current = a;
    setTimeout(() => watchDecorations(a, project), 0);
  }, [activeId, seed]);

  const vd = VIEWS[view];

  return (
    <div className="flex h-full flex-col">
      {/* same material topbar as the editor (§12): translucent layer, bright top
          edge, soft scroll edge where it meets the board */}
      <header className="material-chrome edge-fade relative z-10 flex flex-none items-center gap-3 pt-2.5 pr-[18px] pb-2.5 pl-4">
        <div aria-hidden="true"><span className={BRAND_MARK} /></div>
        <h1 className="m-0 max-w-[46vw] min-w-[60px] cursor-default overflow-hidden rounded-[7px] px-2 py-[0.1875rem] font-display text-display font-semibold text-ellipsis whitespace-nowrap">{project.name}</h1>
        <span className="rounded-full border border-line bg-surface px-2.5 py-[0.1875rem] text-mini whitespace-nowrap text-muted">View only</span>
        {stats && stats.min && stats.max && (
          <span className="pl-1 text-mini whitespace-nowrap text-muted tabular-nums max-[1100px]:hidden">
            {fmtD(stats.min)} – {fmtD(new Date(stats.max.getTime() - DAY))}
            {" · effort "}<strong className="font-semibold text-ink">{stats.h}h</strong> / {stats.d}d
            {stats.epics > 0 && " · " + stats.epics + (stats.epics === 1 ? " epic" : " epics")}
          </span>
        )}
        <div className="flex-1" />
        <SegmentGroup.Root
          className={SEG_ROOT}
          aria-label="Timeline scale"
          value={view}
          onValueChange={(d) => { if (d.value) { setView(d.value); setSeed((s) => s + 1); } }}
        >
          {Object.entries(VIEWS).map(([k, v]) => (
            <SegmentGroup.Item key={k} value={k} className={SEG_ITEM}>
              <SegmentGroup.ItemText>{v.label}</SegmentGroup.ItemText>
              <SegmentGroup.ItemHiddenInput />
            </SegmentGroup.Item>
          ))}
        </SegmentGroup.Root>
      </header>
      <div className="board relative mx-[14px] mb-[14px] flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
        <CoreWillow fonts={false}>
        <GridWillow fonts={false}>
          <div className="toolbar-row flex min-h-[44px] flex-none items-center justify-end border-b border-b-line-soft">
            <div className="flex flex-none items-center gap-[14px] px-4 text-tiny whitespace-nowrap text-muted max-[900px]:hidden" aria-hidden="true">
              {LEGEND.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-[5px]">
                  <span className={`h-2 w-2 rounded-[3px] ${t.dot}`} />{t.label}
                </span>
              ))}
            </div>
          </div>
          <div className="gantt-holder min-h-0 flex-1" key={seed + "-" + view + "-" + (project.id || "none")}>
            <MGantt
              init={init}
              tasks={revivedTasks}
              links={links}
              columns={COLUMNS}
              scales={vd.scales}
              cellWidth={vd.cellWidth}
              cellHeight={38}
              scaleHeight={36}
              gridWidth={620}
              start={range.start}
              end={range.end}
              autoScale={true}
              readonly={true}
              highlightTime={HIGHLIGHT}
            />
          </div>
        </GridWillow>
        </CoreWillow>
        {!project.tasks.length && (
          <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
            <div className="material-pop pointer-events-auto max-w-[380px] rounded-[14px] border border-line px-[1.625rem] py-[1.375rem] text-center motion-safe:animate-rise">
              <div className="mb-1.5 font-display text-title font-semibold">Nothing here yet</div>
              <p className="m-0 text-copy text-muted">This project has no scheduled tasks.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type BootState =
  | { phase: "loading" }
  | { phase: "ready"; store: ViewStore }
  | { phase: "error"; message: string };

/* The page is public and holds no Supabase client: it just pulls the JSON the
   edge function publishes and renders it read-only. `projectId` comes from the
   route (/share/$projectId); /share with no id falls back to whatever the feed
   reports as active, which is what the links handed out before still use. */
export default function ShareViewer({ projectId }: { projectId: string | null }) {
  const [state, setState] = useState<BootState>({ phase: "loading" });

  useEffect(() => {
    if (!projectId) { setState({ phase: "error", message: "this link does not name a timeline" }); return; }
    let alive = true;
    fetchStore(projectId)
      .then((raw) => { if (alive) setState({ phase: "ready", store: shapeStore(raw) }); })
      .catch((e: unknown) => {
        if (alive) setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => { alive = false; };
  }, [projectId]);

  if (state.phase === "loading") return <div className={BOOT}>Loading timeline…</div>;
  if (state.phase === "error") {
    return <div className={BOOT}>Could not load the chart: {state.message} — refresh to retry.</div>;
  }
  const { store } = state;
  if (!store.projects.length) return <div className={BOOT}>Nothing has been shared yet.</div>;
  const known = projectId && store.projects.some((p) => p.id === projectId) ? projectId : null;
  if (projectId && !known) {
    return <div className={BOOT}>That timeline is not shared, or no longer exists.</div>;
  }
  return (
    <Board
      key={known || store.active || "none"}
      store={store}
      activeId={known || store.active}
    />
  );
}
