import { useMemo, useRef, useState, useEffect, useCallback, memo } from "react";
import { Gantt } from "@svar-ui/react-gantt";
import type { IApi, IColumnConfig, IScaleConfig, ITask, TID } from "@svar-ui/react-gantt";
import { Willow as CoreWillow } from "@svar-ui/react-core";
import { Willow as GridWillow } from "@svar-ui/react-grid";
import { Popover } from "@ark-ui/react/popover";
import { Portal } from "@ark-ui/react/portal";
import { Funnel, X } from "@phosphor-icons/react";
import { setGlyph, type GlyphHost } from "./icons";
import { installWxiMasks } from "./lib/wxi-masks";
import { trackerId } from "./lib/tracker";
import { initialsOf, nameHue, parseAssignees } from "../people/roster";
import {
  EMPTY_FILTER, RELEASE_INCLUSION_NOTE, RELEASES, TASK_TYPES, UNSET, asWidgetType, effectiveType,
  filterActive, filterCount, filterKey, isTierType, makeFilter, releaseLabel, releaseTitle,
  releaseTotals, scopeOf, usableFilter,
} from "./lib/taxonomy";
import type { FilterRow, FilterState, ReleaseTotals } from "./lib/taxonomy";

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
  /* null | "mvp" | "full" — carried only by the two container tiers */
  release?: string;
  /* the widget-only tier marker: SVAR has exactly one parent type ("summary"),
     so a story is presented as one and `kind` is what still says it is a story.
     See ./lib/taxonomy — the editor does exactly the same thing. */
  kind?: string;
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
  /* the people this project's tasks name, for the Who filter's chips */
  people: Person[];
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
    /* the same coercion the editor makes, and for the same reason: SVAR only
       treats a row as a parent when its type is exactly "summary". This page
       never writes, but it must not turn a story into an epic on screen either
       — the real tier travels in `kind`, which the decorator reads back. */
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
/* ITask has an index signature, so `t.kind` would arrive as `any`; the tier is
   read through these instead, exactly as in Editor.tsx */
const kindOf = (t: unknown): string | undefined => {
  if (!t || typeof t !== "object") return undefined;
  const k = (t as { kind?: unknown }).kind;
  return typeof k === "string" ? k : undefined;
};
const tierOf = (t: unknown): string => {
  const o = t && typeof t === "object" ? (t as { type?: unknown }) : null;
  const ty = o && typeof o.type === "string" ? o.type : undefined;
  return effectiveType(ty, kindOf(t));
};
/* parseAssignees / initialsOf / nameHue live in features/people/roster.ts and
   trackerId in ./lib/tracker — both editor and viewer had the same copy. */

/* the Scope column, decorated the same way the editor's is: `scopeOf` in
   ./lib/taxonomy is the one implementation of "a leaf inherits the nearest
   tier's scope", so the column, the filter and the totals cannot disagree */
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
  const lookup = (id: string | number): FilterRow | null => {
    try { return asFilterRow(api.getTask(id)); } catch (e) { return null; }
  };
  return scopeOf(asFilterRow(t), lookup);
}
/* every branch spelled out: a class assembled from parts survives dev and
   vanishes from the production build */
function scopeCellClass(scope: string, owned: boolean): string {
  if (scope === "mvp") return owned ? "release-tag rel-mvp" : "release-tag rel-mvp rel-soft";
  return owned ? "release-tag rel-full" : "release-tag rel-full rel-soft";
}

/* the release dimension is reachable from the Scope column header here too;
   these bridge the tagger-built trigger back to React, as in Editor.tsx */
let releaseFilterRef: string[] = [];
let scopeFilterHook: ((hostEl: HTMLElement) => void) | null = null;
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
  const cls = n ? "col-filter is-on" : "col-filter";
  if (btn.className !== cls) btn.className = cls;
  const label = n ? "Filter by release scope — " + n + " selected" : "Filter by release scope";
  if (btn.title !== label) { btn.title = label; btn.setAttribute("aria-label", label); }
}

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
  /* Optional on purpose. `release` is a real column, but the SECURITY DEFINER
     function the edge endpoint calls (public.share_feed) has to name it before
     it appears here, and that is a migration the owner applies — see README.
     Until then every shared row simply reads as unscoped. */
  release?: string | null;
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
      if (t.release === "mvp" || t.release === "full") o.release = t.release;
      o.status = t.status || "todo";
      return o;
    }),
    links: (s.links || []).filter((l) => l.project === p.id).map((l) => ({ id: l.id, source: l.source, target: l.target, type: l.type || "e2s" })),
  }));
  /* `some` proves s.active is one of the ids, which the compiler cannot see */
  const active = projects.some((p) => p.id === s.active) ? s.active! : projects.length ? projects[0].id! : null;
  return { projects, active, people: rosterRef };
}

/* One scale, days — the editor dropped the Day / Week / Month switcher and the
   read-only page follows it, so a shared link and the editor it came from draw
   the same timeline. `projects.view` is left unread. */
const DAY_SCALES: IScaleConfig[] = [
  { unit: "month", step: 1, format: "%F %Y" },
  { unit: "day", step: 1, format: "%j" },
];
const DAY_CELL_WIDTH = 36;
const HIGHLIGHT = (d: Date, u: "day" | "hour") => (u === "day" && (d.getDay() === 0 || d.getDay() === 6) ? "wx-weekend" : "");
const COLUMNS: IColumnConfig[] = [
  { id: "text", header: "Task name", width: 183, flexgrow: 1, sort: true },
  /* the editor's Scope column, so the two grids agree. Filled by the decorator
     below: solid on the tier that owns the release, ghosted on the rows that
     inherit it. `sort: false` — the header hosts the release filter's trigger. */
  { id: "scope", header: "Scope", width: 72, align: "center", sort: false },
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
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const BTN =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-line bg-surface px-[0.8125rem] py-1.5 font-ui text-small font-medium text-muted hover:bg-surface-hover hover:text-ink ${FOCUS} disabled:cursor-default disabled:opacity-60`;
const BTN_ON =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-accent bg-accent-hover px-[0.8125rem] py-1.5 font-ui text-small font-semibold text-accent hover:brightness-[1.04] ${FOCUS}`;
const POP = "pop-anim material-pop border border-line outline-none";
const POP_TITLE = "mb-1 text-body font-semibold";
const POP_HINT = "m-0 mb-2.5 text-mini text-muted";
/* both states written out in full — Tailwind only keeps class names it can read
   verbatim in the source */
const CHIP_OFF =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-[0.1875rem] font-ui text-mini text-muted hover:bg-surface-hover hover:text-ink ${FOCUS}`;
const CHIP_ON =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-accent bg-accent-hover px-2.5 py-[0.1875rem] font-ui text-mini font-semibold text-accent ${FOCUS}`;
const GROUP_LABEL = "m-0 mt-3 mb-1.5 text-label font-semibold text-faint uppercase";
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
    const tier = tierOf(t);
    const nested = !isTierType(tier) && (t.$level || 1) > 1;
    let parentTier: string | null = null;
    if (nested && t.parent !== undefined && t.parent !== null && t.parent !== 0) {
      try { parentTier = tierOf(api.getTask(t.parent)); } catch (e) {}
    }
    row.classList.toggle("is-epic", tier === "summary");
    row.classList.toggle("is-story", tier === "story");
    row.classList.toggle("in-epic", nested);
    row.classList.toggle("in-story", nested && parentTier === "story");
    const status = t.status === "done" || t.status === "progress" ? t.status : "todo";
    ["st-todo", "st-progress", "st-done"].forEach((c) => row.classList.remove(c));
    row.classList.add("st-" + status);
    const content = row.querySelector<HTMLElement>('[data-col-id=":text"] .wx-content');
    if (content) {
      let dot = content.querySelector<HTMLElement>(".status-dot");
      if (!dot) { dot = document.createElement("span"); dot.className = "status-dot"; content.appendChild(dot); }
      const dc = "status-dot sd-" + status;
      if (dot.className !== dc) dot.className = dc;
      const typeKey = "ti-" + tier;
      const iconCls = "type-icon " + typeKey;
      let ic = content.querySelector<GlyphHost>(".type-icon");
      if (!ic) { ic = document.createElement("span"); ic.className = iconCls; content.appendChild(ic); }
      else if (ic.className !== iconCls) ic.className = iconCls;
      setGlyph(ic, typeKey); /* cached Phosphor SVG, rendered once at module scope */
    }
    /* release scope, in its own column exactly as the editor draws it */
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
    bar.classList.toggle("is-story", tierOf(t) === "story");
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
      /* both class strings spelled out in full */
      const cls = tierOf(t) === "story" ? "epic-band band-story" : "epic-band";
      html += '<div class="' + cls + '" style="top:' + i * ch + "px;height:" + (j - i) * ch + 'px"></div>';
    }
    if (layer.__html !== html) { layer.innerHTML = html; layer.__html = html; }
  }
  syncScopeFilterButton();
  /* project span line */
  const scaleEl = document.querySelector<HTMLElement>(".gantt-holder .wx-chart > .wx-scale");
  if (scaleEl) {
    let el = scaleEl.querySelector<HTMLElement>(":scope > .project-span");
    let min: string | null = null, max: string | null = null;
    project.tasks.forEach((t) => {
      /* a tier's dates are its children's; counting them repeats the span */
      if (isTierType(t.type)) return;
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
  stories: number;
  release: ReleaseTotals;
}
/* the editor's own header arithmetic, kept in step by hand: both container
   tiers are counted but contribute no effort of their own */
function computeStats(tasks: ViewTask[]): Stats {
  let h = 0, epics = 0, stories = 0, min: string | null = null, max: string | null = null;
  tasks.forEach((t) => {
    /* `tasks` carries the STORED type, so a story is "story" here */
    if (t.type === "summary") { epics++; return; }
    if (t.type === "story") { stories++; return; }
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
    stories,
    release: releaseTotals(tasks, (t) => Number(t.hours) || 0),
  };
}

/* ---------- the same filter as the editor ----------
   It reuses the editor's predicate through ./lib/taxonomy, and applies it the
   same way: SVAR's `filter-tasks` records which ids are visible and leaves the
   underlying tree alone. There is nothing to write from here, but `open: false`
   is kept so the library does not mutate rows either. Returns how many rows
   match, for the empty state. */
function applyViewFilter(api: GanttApi, f: FilterState, tasks: ViewTask[], people: Person[]): number {
  const usable = usableFilter(f, new Set(people.map((h) => h.id)));
  if (!filterActive(usable)) {
    try { api.exec("filter-tasks", {}); } catch (e) {}
    return tasks.length;
  }
  const by = new Map<string, FilterRow>();
  tasks.forEach((t) => by.set(String(t.id), t));
  const match = makeFilter(usable, (id) => by.get(String(id)) || null);
  try { api.exec("filter-tasks", { filter: match, open: false }); } catch (e) {}
  return tasks.filter((t) => match(t)).length;
}

function Board({ store, activeId }: { store: ViewStore; activeId: string | null }) {
  const apiRef = useRef<GanttApi | null>(null);
  /* the Scope column header's own filter trigger, built by the decorator and
     anchored through Ark's getAnchorRect — the same bridge the editor uses */
  const [scopePick, setScopePick] = useState<HTMLElement | null>(null);
  const lastScopeRef = useRef<{ el: HTMLElement | null; rect: DOMRect | null }>({ el: null, rect: null });

  /* ShareViewer only mounts Board once the feed has at least one project */
  const project: ViewProject = store.projects.find((p) => p.id === activeId) || store.projects[0];
  const revivedTasks = useMemo(() => prepareTasks(project.tasks), [activeId]);
  const links = useMemo(() => project.links.slice(), [activeId]);
  const stats = useMemo(() => computeStats(project.tasks), [activeId]);

  /* the same three filter dimensions as the editor, on local state: this route
     takes no search params today, so a filtered view here is not a link */
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const people = store.people;
  const fKey = filterKey(filter);
  const liveFilter = useMemo(() => usableFilter(filter, new Set(people.map((h) => h.id))), [fKey, people]);
  const filterOn = filterActive(liveFilter);
  const [shown, setShown] = useState(project.tasks.length);
  const toggleFilter = (dim: "types" | "releases" | "people", id: string) => {
    const next: FilterState = { types: filter.types, releases: filter.releases, people: filter.people };
    const cur = next[dim];
    next[dim] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setFilter(next);
  };

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
  }, [activeId]);

  /* `appliedRef` keeps an unfiltered page inert rather than re-running a
     clearing `filter-tasks` on every render pass. */
  const appliedRef = useRef(false);
  useEffect(() => {
    const a = apiRef.current;
    if (!a) return;
    if (!filterOn && !appliedRef.current) { setShown(project.tasks.length); return; }
    appliedRef.current = filterOn;
    setShown(applyViewFilter(a, filter, project.tasks, people));
  }, [fKey, activeId, people, project.tasks, filterOn]);

  /* the Scope column header's trigger reads the release dimension from module
     scope, the way the decorator reads the roster */
  useEffect(() => {
    releaseFilterRef = liveFilter.releases;
  }, [liveFilter]);
  useEffect(() => {
    scopeFilterHook = (hostEl) => {
      lastScopeRef.current = { el: hostEl, rect: hostEl ? hostEl.getBoundingClientRect() : null };
      setScopePick((cur) => (cur === hostEl ? null : hostEl));
    };
    return () => { scopeFilterHook = null; };
  }, []);

  /* one definition of the release dimension, shared by the header popover and
     the Scope column's trigger, with the inclusion rule on screen rather than
     behind a hover */
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

  return (
    <div className="flex h-full flex-col">
      {/* same material topbar as the editor (§12): translucent layer, bright top
          edge, soft scroll edge where it meets the board */}
      <header className="material-chrome edge-fade relative z-10 flex flex-none items-center gap-3 py-2 pr-[18px] pl-4">
        <div aria-hidden="true"><span className={BRAND_MARK} /></div>
        {/* identity, with the quiet run of state and totals underneath it —
            laid out exactly as the editor's, so a shared link reads the same */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-px">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="m-0 min-w-0 cursor-default overflow-hidden rounded-[7px] px-1.5 py-[0.0625rem] font-display text-display font-semibold text-ellipsis whitespace-nowrap">{project.name}</h1>
            <span className="flex-none rounded-full border border-line bg-surface px-2 py-0 text-mini whitespace-nowrap text-muted">View only</span>
          </div>
          <div className="flex min-w-0 items-center gap-x-3 overflow-hidden pl-1.5 text-mini whitespace-nowrap text-muted tabular-nums">
            {filterOn && (
              <button
                type="button"
                className={`press inline-flex flex-none cursor-pointer items-center gap-1 rounded-full border border-accent bg-accent-hover px-2 py-0 text-mini whitespace-nowrap text-accent ${FOCUS}`}
                title="Clear the filter"
                onClick={() => setFilter(EMPTY_FILTER)}
              >
                <Funnel size={10} weight="fill" aria-hidden="true" />
                {shown} of {project.tasks.length}
                <X size={10} aria-hidden="true" />
              </button>
            )}
            {stats && stats.min && stats.max && (
              <>
                <span className="flex-none max-[860px]:hidden">
                  {fmtD(stats.min)} – {fmtD(new Date(stats.max.getTime() - DAY))}
                </span>
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
                {/* the same wording as the editor and the projects cards: MVP is
                    PART of the full release, so the full figure says so */}
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
        <div className="flex flex-none items-center gap-1.5">
        <Popover.Root positioning={{ placement: "bottom-end", gutter: 8 }}>
          <Popover.Trigger className={filterOn ? BTN_ON : BTN} title="Filter by type, release scope and assignee">
            <Funnel size={13} weight={filterOn ? "fill" : "regular"} aria-hidden="true" />
            <span className="max-[1080px]:sr-only">Filter</span>
            {filterOn && <span className="tabular-nums">{filterCount(liveFilter)}</span>}
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner style={{ zIndex: 60 }}>
              <Popover.Content className={`${POP} w-[286px] rounded-xl p-3.5`}>
                <Popover.Title className={POP_TITLE}>Filter</Popover.Title>
                <Popover.Description className={POP_HINT}>
                  Hides rows on screen only — the totals above still count the whole project.
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
                {people.length > 0 && (
                  <>
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
                  </>
                )}
                <div className="mt-3.5 flex items-center gap-2 border-t border-t-line-soft pt-3">
                  <button type="button" className={BTN} disabled={!filterOn} onClick={() => setFilter(EMPTY_FILTER)}>
                    Clear all
                  </button>
                  {filterOn && (
                    <span className="text-mini text-muted tabular-nums">{shown} of {project.tasks.length} rows</span>
                  )}
                </div>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
        </div>
      </header>
      {/* the Scope column header's own release filter, anchored to the button
          the decorator appended into that header cell */}
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
                  onClick={() => setFilter({ types: filter.types, releases: [], people: filter.people })}
                >Clear</button>
                {filterOn && (
                  <span className="text-mini text-muted tabular-nums">{shown} of {project.tasks.length}</span>
                )}
              </div>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
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
          <div className="gantt-holder min-h-0 flex-1" key={project.id || "none"}>
            <MGantt
              init={init}
              tasks={revivedTasks}
              links={links}
              columns={COLUMNS}
              scales={DAY_SCALES}
              cellWidth={DAY_CELL_WIDTH}
              cellHeight={38}
              scaleHeight={36}
              /* as in the editor: the grid grows by less than the new column,
                 so the chart keeps most of its width */
              gridWidth={668}
              start={range.start}
              end={range.end}
              autoScale={true}
              readonly={true}
              highlightTime={HIGHLIGHT}
            />
          </div>
        </GridWillow>
        </CoreWillow>
        {project.tasks.length > 0 && filterOn && shown === 0 && (
          <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
            <div className="material-pop pointer-events-auto max-w-[380px] rounded-[14px] border border-line px-[1.625rem] py-[1.375rem] text-center motion-safe:animate-rise">
              <div className="mb-1.5 font-display text-title font-semibold">Nothing matches this filter</div>
              <p className="m-0 mb-3.5 text-copy text-muted">
                All {project.tasks.length} rows are still here — the filter only hides them on screen.
              </p>
              <button type="button" className={BTN} onClick={() => setFilter(EMPTY_FILTER)}>Clear filter</button>
            </div>
          </div>
        )}
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
