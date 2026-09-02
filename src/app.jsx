import React, { useMemo, useRef, useState, useEffect, useCallback, memo } from "react";
import { createRoot } from "react-dom/client";
import { Gantt, Toolbar, ContextMenu, Editor } from "@svar-ui/react-gantt";
import { Willow as CoreWillow } from "@svar-ui/react-core";
import { Willow as GridWillow } from "@svar-ui/react-grid";
import { Menu } from "@ark-ui/react/menu";
import { Popover } from "@ark-ui/react/popover";
import { Portal } from "@ark-ui/react/portal";
import { SegmentGroup } from "@ark-ui/react/segment-group";
import { CaretDown, Check, DownloadSimple, ShareNetwork, SignOut, Users, X } from "@phosphor-icons/react";
import { buildGanttPdf } from "./pdf.js";
import { supabase } from "./lib/supabase.js";
import { dbLoad, dbSave } from "./lib/db.js";
import Login from "./Login.jsx";

/* stylesheet order matters: shell tokens, then the widget theme, then our
   re-skin on top of it */
import "../style.css";
import "@svar-ui/react-gantt/all.css";
import "../wx-overrides.css";
import "../icons.css";

const DAY = 24 * 60 * 60 * 1000;
const uid = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

/* ---------- shared utility-class recipes for the app shell ---------- */
const BTN =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-line bg-surface px-[13px] py-1.5 font-ui text-[12.5px] font-medium text-muted hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-default disabled:opacity-60";
/* no radius here: each popover sets its own, and two rounded-* utilities on
   one element would race inside @layer utilities */
const POP = "border border-line bg-surface shadow-pop outline-none";
const POP_TITLE = "mb-1 text-[13.5px] font-semibold";
const POP_HINT = "m-0 mb-2.5 text-xs leading-[1.5] text-muted";
const POP_INPUT =
  "min-w-0 flex-1 rounded-lg border border-line bg-surface-alt px-[9px] py-[7px] font-ui text-xs text-ink focus:outline-2 focus:outline-accent";
const POP_ACTION =
  "flex-none cursor-pointer rounded-lg border-0 bg-accent px-3.5 py-[7px] font-ui text-[12.5px] font-semibold text-accent-ink hover:brightness-[1.08]";
const SEG_ROOT = "flex gap-0.5 rounded-[9px] border border-line bg-surface p-0.5";
const SEG_ITEM =
  "flex cursor-pointer select-none items-center rounded-[7px] border-0 bg-transparent px-3.5 py-[5px] font-ui text-[12.5px] font-medium tracking-[0.01em] text-muted hover:bg-surface-hover hover:text-ink data-[state=checked]:bg-accent data-[state=checked]:text-accent-ink data-[state=checked]:hover:bg-accent data-[state=checked]:hover:text-accent-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent";
const BRAND_MARK =
  "block h-3.5 w-3.5 rounded-[4px] bg-[linear-gradient(135deg,var(--color-accent)_0_50%,var(--color-summary-fill)_50%_100%)]";

const COLUMNS = [
  { id: "text", header: "Task name", width: 183, flexgrow: 1, sort: true, editor: "text" },
  { id: "who", header: "Who", width: 78, align: "center", sort: false },
  { id: "tracker", header: "ID", width: 100, align: "center", sort: false },
  { id: "start", header: "Start", width: 92, align: "center", sort: true },
  { id: "hours", header: "Hrs", width: 62, align: "center", sort: true, editor: "text" },
  { id: "days", header: "Days", width: 58, align: "center", sort: true, editor: "text" },
  { id: "add-task", header: "", width: 37, align: "center", sort: false, resize: false },
];

/* ---------- working-time model: estimates in hours, 7h = 1 work day, weekends skipped ---------- */
const HOURS_PER_DAY = 7;
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
function rollForward(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (isWeekend(x)) x.setDate(x.getDate() + 1);
  return x;
}
/* end date (exclusive) after consuming n working days from a working start */
function addWorkDays(start, n) {
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
function workDaysBetween(s, e) {
  let c = 0;
  const x = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  while (x < e) {
    if (!isWeekend(x)) c++;
    x.setDate(x.getDate() + 1);
  }
  return Math.max(1, c);
}
const isBar = (t) => t && t.type !== "summary" && t.type !== "milestone";
/* returns corrected {hours, start, end, duration} for a plain task */
function scheduleFromHours(hours, startLike) {
  const start = rollForward(startLike instanceof Date ? startLike : new Date());
  const h = Math.max(0.5, Math.round((Number(hours) || HOURS_PER_DAY) * 2) / 2);
  const end = addWorkDays(start, Math.ceil(h / HOURS_PER_DAY));
  const days = Math.round((h / HOURS_PER_DAY) * 10) / 10;
  return { hours: h, days, start, end, duration: Math.round((end - start) / DAY) };
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
  { key: "start", comp: "date", label: "Start date", config: { format: "%d-%m-%Y" }, isHidden: (t) => t.type === "summary" },
  { key: "hours", comp: "counter", label: "Estimate (hours)", config: { min: 1 }, isHidden: (t) => !isBar(t) },
  { key: "days", comp: "text", label: "Estimate (days)", config: { placeholder: "e.g. 1.5" }, isHidden: (t) => !isBar(t) },
  { key: "progress", comp: "slider", label: "Progress", config: { min: 0, max: 100 }, isHidden: (t) => t.type === "milestone" },
  { key: "links", comp: "links", label: "", batch: "links" },
];

/* ---------- initial in-memory store; ALL real data lives in Supabase ---------- */
function loadData() {
  const p = { id: uid(), name: "Project timeline", view: "day", tasks: [], links: [] };
  return { version: 2, activeProject: p.id, projects: [p], people: [] };
}

function reviveTask(t) {
  const out = { ...t };
  if (out.start) out.start = new Date(out.start + "T00:00:00");
  if (out.end) out.end = new Date(out.end + "T00:00:00");
  return out;
}
/* epics recalculate from their children when parsed without dates;
   plain tasks are normalized to the hours model (weekends skipped) */
function prepareTasks(tasks) {
  const parents = new Set(tasks.map((t) => t.parent).filter((p) => p !== undefined && p !== null && p !== 0));
  return tasks.map((t) => {
    const r = reviveTask(t);
    /* anything with tasks under it is an epic */
    if (parents.has(r.id) && r.type !== "summary") r.type = "summary";
    if (r.type === "summary" && parents.has(r.id)) { delete r.start; delete r.end; delete r.duration; return r; }
    if (r.type === "summary" && !r.start) {
      /* a childless epic must carry dates or the widget throws */
      r.start = rollForward(new Date());
      r.end = addWorkDays(r.start, 1);
      r.duration = Math.round((r.end - r.start) / DAY);
      return r;
    }
    if (isBar(r)) {
      if (!r.hours) {
        r.hours = (r.start && r.end ? workDaysBetween(r.start, r.end) : Math.max(1, r.duration || 1)) * HOURS_PER_DAY;
      }
      const fixed = scheduleFromHours(r.hours, r.start || new Date());
      r.hours = fixed.hours; r.start = fixed.start; r.end = fixed.end; r.duration = fixed.duration;
    }
    return r;
  });
}
function fmtDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return undefined;
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/* ---------- serialize widget state back to plain data ---------- */
const KEEP = ["id", "text", "start", "end", "duration", "hours", "days", "progress", "parent", "type", "open", "details", "url", "status", "assignees"];
function cleanTask(t) {
  const out = {};
  for (const k of KEEP) {
    if (t[k] === undefined || t[k] === null) continue;
    out[k] = t[k];
  }
  if (out.start) out.start = fmtDate(t.start);
  if (out.end) out.end = fmtDate(t.end);
  if (out.parent === 0) delete out.parent;
  return out;
}
function extractTasks(api) {
  const st = api.getState();
  const tasks = st.tasks;
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!t || t.id === undefined || t.id === 0 || seen.has(t.id)) return;
    seen.add(t.id);
    out.push(cleanTask(t));
  };
  const walk = (arr) => { if (arr) arr.forEach((t) => { push(t); walk(t.data); }); };
  if (Array.isArray(tasks)) walk(tasks);
  else if (tasks && tasks._pool instanceof Map) tasks._pool.forEach(push);
  else if (tasks && typeof tasks.forEach === "function") tasks.forEach(push);
  return out;
}
function extractLinks(api) {
  const st = api.getState();
  const links = st.links;
  const out = [];
  const push = (l) => { if (l && l.id !== undefined) out.push({ id: l.id, source: l.source, target: l.target, type: l.type }); };
  if (Array.isArray(links)) links.forEach(push);
  else if (links && typeof links.map === "function") links.map(push);
  else if (links && typeof links.forEach === "function") links.forEach(push);
  return out;
}
function serializeSide(api, kind) {
  try {
    const arr = api.serialize({ data: kind });
    if (Array.isArray(arr)) {
      return kind === "tasks"
        ? arr.map(cleanTask)
        : arr.map((l) => ({ id: l.id, source: l.source, target: l.target, type: l.type }));
    }
  } catch (e) { /* fall through */ }
  return kind === "tasks" ? extractTasks(api) : extractLinks(api);
}

/* ---------- share link: the static read-only page next to this app ---------- */
const SHARE_URL = new URL(import.meta.env.BASE_URL + "share/", window.location.origin).href;

/* project totals: effort over all tasks, span over all dates */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtD = (d) => d.getDate() + " " + MON[d.getMonth()];
function computeStats(api) {
  let list = [];
  try { list = serializeSide(api, "tasks"); } catch (e) { return null; }
  let h = 0, tasks = 0, epics = 0, min = null, max = null;
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
function xForDate(sc, date) {
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
function renderProjectSpan(api) {
  const scaleEl = document.querySelector(".gantt-holder .wx-chart > .wx-scale");
  if (!scaleEl) return;
  let el = scaleEl.querySelector(":scope > .project-span");
  const stats = computeStats(api);
  const sc = api.getState()._scales;
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

/* epic estimates roll up from the tasks inside them */
let ROLLUP_WRITE = false;
function rollupEpics(api) {
  let list = [];
  try { list = serializeSide(api, "tasks"); } catch (e) { return; }
  const byParent = {};
  list.forEach((t) => { const p = t.parent === undefined ? 0 : t.parent; (byParent[p] = byParent[p] || []).push(t); });
  /* plan the derived writes first */
  const writes = [];
  list.forEach((t) => {
    if (t.type !== "summary" && (byParent[t.id] || []).length) {
      writes.push({ id: t.id, task: { type: "summary" } });
      t.type = "summary";
    }
  });
  const sumOf = (id) => {
    let s = 0;
    (byParent[id] || []).forEach((c) => {
      if (c.type === "summary") s += sumOf(c.id);
      else if (c.type !== "milestone") s += Number(c.hours) || 0;
    });
    return s;
  };
  list.filter((t) => t.type === "summary").forEach((e) => {
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
let rowTagObserver = null;
let retagHook = null;
/* the row tagger lives outside React; these bridge it back to the app */
let rosterRef = [];
let pickHook = null;
const personById = (id) => rosterRef.find((h) => h.id === id) || null;
function setAllEpicsOpen(api, open) {
  let list = [];
  try { list = serializeSide(api, "tasks"); } catch (e) { return; }
  const parents = new Set(list.map((t) => t.parent).filter((p) => p !== undefined && p !== null && p !== 0));
  list.forEach((t) => {
    if (parents.has(t.id) && Boolean(t.open) !== open) {
      try { api.exec("open-task", { id: t.id, mode: open }); } catch (e) {}
    }
  });
}
function syncFoldAllButton(api) {
  const headerCell = document.querySelector('.gantt-holder [data-header-id=":text"]');
  if (!headerCell) return;
  let btn = headerCell.querySelector(".fold-all");
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
      setAllEpicsOpen(api, btn.dataset.next === "expand");
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
  const icon = btn.firstChild;
  const cls = "ci " + (anyOpen ? "ci-collapse" : "ci-expand");
  if (icon.className !== cls) icon.className = cls;
}
/* ---------- assignees: a comma-separated list of people ids, shown as initials ---------- */
function parseAssignees(v) {
  return String(v || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}
/* "Inga Kot" → "IK"; "Inga" → "IN" */
function initialsOf(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
/* stable per-name hue so the same person keeps the same chip color */
function nameHue(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
/* "…/PRODUCT-1234" → "PRODUCT-1234" */
function trackerId(url) {
  const m = /([A-Za-z][A-Za-z0-9_]*-\d+)\/?(?:[?#].*)?$/.exec(url || "");
  return m ? m[1].toUpperCase() : null;
}
function renderEpicBands(api) {
  const area = document.querySelector(".gantt-holder .wx-area");
  if (!area) return;
  let layer = area.querySelector(":scope > .epic-bands");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "epic-bands";
    const hol = area.querySelector(":scope > .wx-gantt-holidays");
    if (hol) hol.after(layer); else area.prepend(layer);
  }
  let rows = [];
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
function watchRowTags(api) {
  if (rowTagObserver) { rowTagObserver.disconnect(); rowTagObserver = null; }
  let raf = 0;
  const tag = () => {
    raf = 0;
    document.querySelectorAll(".gantt-holder .wx-row[data-id]").forEach((row) => {
      const raw = row.getAttribute("data-id") || "";
      const id = raw.startsWith(":") ? raw.slice(1) : raw;
      let t = null;
      try { t = api.getTask(id); } catch (e) {}
      if (!t && /^\d+$/.test(id)) { try { t = api.getTask(Number(id)); } catch (e) {} }
      if (!t) return;
      row.classList.toggle("is-epic", t.type === "summary");
      row.classList.toggle("in-epic", t.type !== "summary" && (t.$level || 1) > 1);
      /* status: classes + dot in the list */
      const status = t.status === "done" || t.status === "progress" ? t.status : "todo";
      ["st-todo", "st-progress", "st-done"].forEach((c) => row.classList.remove(c));
      row.classList.add("st-" + status);
      const content0 = row.querySelector('[data-col-id=":text"] .wx-content');
      if (content0) {
        let dot = content0.querySelector(".status-dot");
        if (!dot) { dot = document.createElement("span"); dot.className = "status-dot"; content0.appendChild(dot); }
        const dc = "status-dot sd-" + status;
        if (dot.className !== dc) dot.className = dc;
        dot.title = status === "done" ? "Done" : status === "progress" ? "In progress" : "Not started";
      }
      /* type icon in front of the name (appended, repositioned via flex order —
         never inserted between React-managed nodes) */
      const iconCls = "type-icon ti-" + (t.type || "task");
      let ic = row.querySelector(".type-icon");
      if (!ic) {
        const content = row.querySelector('[data-col-id=":text"] .wx-content');
        if (content) {
          ic = document.createElement("span");
          ic.className = iconCls;
          content.appendChild(ic);
        }
      } else if (ic.className !== iconCls) {
        ic.className = iconCls;
      }
      /* Who column: assignee initials from the roster; click opens the picker.
         The host is appended, never inserted between React-managed nodes. */
      const whoCell = row.querySelector('[data-col-id=":who"]');
      if (whoCell) {
        let host = whoCell.querySelector(".who-chips");
        if (!host) {
          host = document.createElement("button");
          host.className = "who-chips";
          host.type = "button";
          host.addEventListener("pointerdown", (e) => e.stopPropagation());
          host.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
          (whoCell.querySelector(".wx-content") || whoCell).appendChild(host);
        }
        const assigned = parseAssignees(t.assignees).map(personById).filter(Boolean);
        const key = assigned.map((h) => h.id + "\u0000" + h.name).join("|");
        if (host.__key !== key) {
          host.__key = key;
          host.textContent = "";
          if (!assigned.length) {
            const ph = document.createElement("span");
            ph.className = "who-empty";
            ph.textContent = "+";
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
      const cell = row.querySelector('[data-col-id=":tracker"]');
      if (cell) {
        const tid = rawUrl ? trackerId(rawUrl) : null;
        let a2 = cell.querySelector(".tracker-link");
        if (tid) {
          if (!a2) {
            a2 = document.createElement("a");
            a2.className = "tracker-link";
            a2.target = "_blank";
            a2.rel = "noopener noreferrer";
            ["click", "pointerdown"].forEach((ev) => a2.addEventListener(ev, (e) => e.stopPropagation()));
            a2.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
            (cell.querySelector(".wx-content") || cell).appendChild(a2);
          }
          if (a2.getAttribute("href") !== rawUrl) { a2.setAttribute("href", rawUrl); a2.title = rawUrl; }
          if (a2.textContent !== tid) a2.textContent = tid;
        } else if (a2) {
          a2.remove();
        }
      }
      /* hover-only edit (pencil) icon on every row — opens that row's editor */
      let bEl = row.querySelector(".row-edit");
      if (!bEl) {
        bEl = document.createElement("button");
        bEl.className = "row-edit";
        bEl.type = "button";
        bEl.addEventListener("pointerdown", (e) => e.stopPropagation());
        bEl.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
        const content = row.querySelector('[data-col-id=":text"] .wx-content');
        if (content) content.appendChild(bEl); else bEl = null;
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
    document.querySelectorAll(".gantt-holder .wx-bar[data-task-id]").forEach((bar) => {
      const raw = bar.getAttribute("data-task-id") || "";
      const id = raw.startsWith(":") ? raw.slice(1) : raw;
      let t = null;
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
const MEditor = memo(Editor);
const HIGHLIGHT = (d, u) => (u === "day" && (d.getDay() === 0 || d.getDay() === 6) ? "wx-weekend" : "");
const SUMMARY_CFG = { autoConvert: true, autoProgress: true };

/* ---------- view presets ---------- */
const VIEWS = {
  day:   { label: "Day",   cellWidth: 36,  scales: [{ unit: "month", step: 1, format: "%F %Y" }, { unit: "day", step: 1, format: "%j" }] },
  week:  { label: "Week",  cellWidth: 74,  scales: [{ unit: "month", step: 1, format: "%M %Y" }, { unit: "week", step: 1, format: "w%W" }] },
  month: { label: "Month", cellWidth: 110, scales: [{ unit: "year", step: 1, format: "%Y" }, { unit: "month", step: 1, format: "%M" }] },
};

/* ---------- app ---------- */
function App({ session }) {
  const ownerId = session.user.id;
  const storeRef = useRef(loadData());
  const store = storeRef.current;
  const [activeId, setActiveId] = useState(store.activeProject);
  const activeProject = () => storeRef.current.projects.find((p) => p.id === storeRef.current.activeProject) || storeRef.current.projects[0];

  const [api, setApi] = useState(null);
  const [view, setView] = useState(VIEWS[activeProject().view] ? activeProject().view : "day");
  const [status, setStatus] = useState("idle");
  const [taskCount, setTaskCount] = useState(activeProject().tasks.length);
  const [seed, setSeed] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [stats, setStats] = useState(null);
  const [people, setPeople] = useState(() => storeRef.current.people || []);
  const [newPerson, setNewPerson] = useState("");
  const [picker, setPicker] = useState(null); /* { taskId, el, rect, ids } */
  const [copied, setCopied] = useState(false);
  const shareInputRef = useRef(null);
  const [armDelete, setArmDelete] = useState(null);
  const [dbState, setDbState] = useState({ state: "idle" });
  const [, forceRender] = useState(0);
  const nameRef = useRef(activeProject().name);
  const clipRef = useRef(null);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const snapTimer = useRef(null);
  const saveTimer = useRef(null);
  const apiRef = useRef(null);
  const dirtyRef = useRef(false);

  const revivedTasks = useMemo(() => prepareTasks(activeProject().tasks), [seed, activeId]);
  const links = useMemo(() => activeProject().links.slice(), [seed, activeId]);

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
      } catch (e) { /* keep previous */ }
    }
    p.name = nameRef.current;
    return p;
  }, []);

  const doSave = useCallback(async () => {
    const p = snapshotActive();
    p.view = view;
    setTaskCount(p.tasks.length);
    const s = storeRef.current;
    const data = { version: 2, activeProject: s.activeProject, projects: s.projects, people: s.people || [] };
    setStatus("saving");
    const r = await dbSave(data, ownerId);
    setDbState(r);
    setStatus(r.state === "ok" ? "saved" : "local");
  }, [view, snapshotActive, ownerId]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; doSave(); }, 1400);
  }, [doSave]);

  /* ---------- snapshot-based undo/redo (the library's history is pro-only) ---------- */
  const serializeActive = useCallback(() => {
    const p = snapshotActive();
    return JSON.stringify({ t: p.tasks, l: p.links });
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
    clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => { snapTimer.current = null; flushSnapshot(); }, 350);
  }, [flushSnapshot]);
  const restoreSnapshot = useCallback((json) => {
    try {
      const d = JSON.parse(json);
      const p = activeProject();
      p.tasks = d.t;
      p.links = d.l;
      setTaskCount(d.t.length);
      setSeed((s) => s + 1);
      dirtyRef.current = true;
      scheduleSave();
    } catch (e) {}
  }, [scheduleSave]);

  /* on open: everything comes from Supabase (unless the user already started editing) */
  useEffect(() => {
    let alive = true;
    dbLoad().then((r) => {
      if (!alive) return;
      if (r.state === "err") { setDbState(r); return; }
      setDbState({ state: "ok" });
      if (r.data && !dirtyRef.current) {
        undoRef.current = []; redoRef.current = [];
        storeRef.current = r.data;
        setPeople(r.data.people || []);
        const p = r.data.projects.find((x) => x.id === r.data.activeProject) || r.data.projects[0];
        nameRef.current = p.name;
        setActiveId(p.id);
        setView(VIEWS[p.view] ? p.view : "day");
        setTaskCount(p.tasks.length);
        setSeed((s) => s + 1);
      }
    });
    return () => { alive = false; };
  }, []);

  /* keyboard shortcuts: ⌘/Ctrl+C copy, +X cut, +V paste (into epics), +Z undo, +Shift+Z redo */
  useEffect(() => {
    if (!api) return;
    const onKey = async (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (!["c", "v", "x", "z"].includes(k)) return;
      const el = e.target;
      if (el instanceof Element && el.closest('input, textarea, [contenteditable="true"]')) return;
      if (document.querySelector(".wx-gantt-editor")) return; /* editor modal open: keep native behavior */
      const st = api.getState();
      const sel = st.selected && st.selected.length ? st.selected[st.selected.length - 1] : null;

      if (k === "z") {
        e.preventDefault(); e.stopPropagation();
        flushSnapshot();
        const u = undoRef.current, r = redoRef.current;
        if (e.shiftKey) {
          if (!r.length) return;
          const next = r.pop();
          u.push(next);
          restoreSnapshot(next);
        } else {
          if (u.length < 2) return;
          r.push(u.pop());
          restoreSnapshot(u[u.length - 1]);
        }
        return;
      }
      if (k === "c" || k === "x") {
        if (sel === null || sel === undefined) return;
        e.preventDefault(); e.stopPropagation();
        clipRef.current = { op: k === "x" ? "cut" : "copy", id: sel, project: storeRef.current.activeProject };
        return;
      }
      if (k === "v") {
        const clip = clipRef.current;
        if (!clip) return;
        e.preventDefault(); e.stopPropagation();
        if (clip.project !== storeRef.current.activeProject) return; /* clipboard is per project */
        let srcOk = null;
        try { srcOk = api.getTask(clip.id); } catch (err) {}
        if (!srcOk) return;
        let selTask = null;
        try { selTask = sel !== null && sel !== undefined ? api.getTask(sel) : null; } catch (err) {}
        if (sel === clip.id && clip.op === "cut") return;
        const cfg = { id: clip.id };
        if (selTask && selTask.type === "summary" && sel !== clip.id) { cfg.target = sel; cfg.mode = "child"; }
        else if (selTask) { cfg.target = sel; cfg.mode = "after"; }
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
  }, [api]);

  /* editor modal: close (with autosave) on backdrop click; inject an Okay button */
  useEffect(() => {
    if (!api) return;
    const commitAndClose = () => {
      const ed = document.querySelector(".wx-gantt-editor");
      const ae = document.activeElement;
      if (ed && ae && ed.contains(ae) && typeof ae.blur === "function") ae.blur(); /* commit the field being edited */
      setTimeout(() => { try { api.exec("show-editor", { id: null }); } catch (e) {} }, 60);
    };
    const onDown = (e) => {
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

  useEffect(() => {
    const flush = () => {
      if (document.hidden && saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        doSave();
      }
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [doSave]);

  /* Ark's Popover owns dismissal (outside click + Escape) and placement */
  const copyShareLink = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(SHARE_URL); ok = true; } catch (e) {}
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
    try {
      const doc = buildGanttPdf(p.name, p.tasks, p.links);
      const safe = (p.name || "gantt").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "gantt";
      doc.save(safe + ".pdf"); /* plain browser download */
    } catch (e) {
      /* nothing to fall back to — the browser refused the download */
    } finally {
      setExporting(false);
    }
  }, [exporting, snapshotActive]);

  const init = useCallback((a) => {
    apiRef.current = a;
    setApi(a);

    /* enforce the hours/working-day model on every change */
    a.intercept("add-task", (ev) => {
      const t = ev.task || (ev.task = {});
      if (t.type === "summary") {
        if (!t.start) {
          t.start = rollForward(t.start instanceof Date ? t.start : new Date());
          t.end = addWorkDays(t.start, 1);
          t.duration = Math.round((t.end - t.start) / DAY);
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
      let prev = {};
      try { prev = a.getTask(ev.id) || {}; } catch (e) {}
      const merged = { ...prev, ...t };
      if (merged.type === "summary" && !ROLLUP_WRITE) {
        /* epic estimates are derived from their tasks — ignore manual edits */
        delete t.hours; delete t.days;
        return;
      }
      if (!isBar(merged)) return;
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
        hours = workDaysBetween(merged.start, t.end) * HOURS_PER_DAY; /* bar resized */
      } else hours = Number(prev.hours);
      if (!hours || isNaN(hours)) hours = Math.max(1, merged.duration || 1) * HOURS_PER_DAY;
      const fixed = scheduleFromHours(hours, merged.start || new Date());
      t.hours = fixed.hours; t.days = fixed.days; t.start = fixed.start; t.end = fixed.end; t.duration = fixed.duration;
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
    const mountProject = storeRef.current.activeProject;
    setTimeout(() => {
      /* a Supabase adoption or project switch may have superseded this mount */
      if (apiRef.current !== a || storeRef.current.activeProject !== mountProject) return;
      watchRowTags(a);
      try { rollupEpics(a); setStats(computeStats(a)); } catch (e) {}
      try { seedSnapshot(); } catch (e) {}
    }, 0);
    if (window.__ganttProbe) window.__ganttProbe(a);
  }, [scheduleSave, scheduleSnapshot, seedSnapshot]);

  /* ---------- people roster ---------- */
  /* the tagger reads the roster from module scope; keep it in step and repaint */
  useEffect(() => {
    rosterRef = people;
    if (retagHook) retagHook();
  }, [people]);

  useEffect(() => {
    pickHook = (taskId, hostEl) => {
      let ids = [];
      try { ids = parseAssignees(apiRef.current.getTask(taskId).assignees); } catch (e) { /* unassigned */ }
      /* keep a rect snapshot: the widget may re-render the cell away while the
         popover is open, and a detached node measures as 0×0 */
      const rect = hostEl ? hostEl.getBoundingClientRect() : null;
      setPicker({ taskId, el: hostEl, rect, ids });
    };
    return () => { pickHook = null; };
  }, []);

  const commitPeople = useCallback((next) => {
    storeRef.current.people = next;
    setPeople(next);
    scheduleSave();
  }, [scheduleSave]);

  const addPerson = useCallback(() => {
    const name = newPerson.trim();
    if (!name) return;
    const next = [...(storeRef.current.people || []), { id: uid(), name }];
    setNewPerson("");
    commitPeople(next);
  }, [newPerson, commitPeople]);

  const renamePerson = useCallback((id, name) => {
    commitPeople((storeRef.current.people || []).map((h) => (h.id === id ? { ...h, name } : h)));
  }, [commitPeople]);

  /* removing a person also clears them from every task that referenced them */
  const removePerson = useCallback((id) => {
    const strip = (v) => parseAssignees(v).filter((x) => x !== id).join(",") || null;
    storeRef.current.projects.forEach((pr) => {
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
    commitPeople((storeRef.current.people || []).filter((h) => h.id !== id));
  }, [commitPeople]);

  const toggleAssignee = useCallback((taskId, personId) => {
    const a = apiRef.current;
    if (!a) return;
    let t = null;
    try { t = a.getTask(taskId); } catch (e) {}
    if (!t) return;
    const cur = parseAssignees(t.assignees);
    const next = cur.includes(personId) ? cur.filter((x) => x !== personId) : [...cur, personId];
    a.exec("update-task", { id: taskId, task: { assignees: next.join(",") || null } });
    setPicker((cur) => (cur && cur.taskId === taskId ? { ...cur, ids: next } : cur));
    if (retagHook) setTimeout(() => retagHook(), 0);
  }, []);

  /* ---------- project actions ---------- */
  const openProject = (id) => {
    if (id !== storeRef.current.activeProject) {
      const prev = snapshotActive();
      prev.view = view;
      storeRef.current.activeProject = id;
      undoRef.current = []; redoRef.current = [];
      const next = activeProject();
      nameRef.current = next.name;
      setActiveId(id);
      setView(VIEWS[next.view] ? next.view : "day");
      setTaskCount(next.tasks.length);
      setSeed((s) => s + 1);
      scheduleSave();
    }
    setArmDelete(null);
  };
  const createProject = () => {
    const prev = snapshotActive();
    prev.view = view;
    const p = { id: uid(), name: "New project", view: "day", tasks: [], links: [] };
    storeRef.current.projects.push(p);
    storeRef.current.activeProject = p.id;
    undoRef.current = []; redoRef.current = [];
    nameRef.current = p.name;
    setActiveId(p.id);
    setView("day");
    setTaskCount(0);
    setSeed((s) => s + 1);
    setArmDelete(null);
    scheduleSave();
  };
  const deleteProject = (id) => {
    if (armDelete !== id) { setArmDelete(id); return; }
    const s = storeRef.current;
    if (s.projects.length <= 1) return;
    s.projects = s.projects.filter((p) => p.id !== id);
    setArmDelete(null);
    if (s.activeProject === id) {
      undoRef.current = []; redoRef.current = [];
      s.activeProject = s.projects[0].id;
      const next = activeProject();
      nameRef.current = next.name;
      setActiveId(next.id);
      setView(VIEWS[next.view] ? next.view : "day");
      setTaskCount(next.tasks.length);
      setSeed((v) => v + 1);
    } else {
      forceRender((n) => n + 1);
    }
    scheduleSave();
  };

  const changeView = (v) => {
    const p = snapshotActive();
    p.view = v;
    setView(v);
    setSeed((s) => s + 1);
    setTimeout(scheduleSave, 0);
  };

  const onName = (e) => {
    nameRef.current = e.currentTarget.textContent.trim() || "Untitled project";
    activeProject().name = nameRef.current;
    scheduleSave();
  };

  const vd = VIEWS[view];
  let statusText = {
    idle: "", saving: "Saving…", saved: "Saved · Supabase", local: "Not saved — Supabase unavailable",
  }[status];
  if (statusText && dbState.state === "err" && dbState.message) statusText += " · " + dbState.message;
  const projects = storeRef.current.projects;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-none items-center gap-3 pt-2.5 pr-[18px] pb-2.5 pl-4">
        <div aria-hidden="true"><span className={BRAND_MARK} /></div>
        <div className="flex items-center gap-0.5">
          <h1
            key={activeId}
            className="m-0 max-w-[46vw] min-w-[60px] overflow-hidden rounded-[7px] px-2 py-[3px] font-display text-[19px] font-semibold tracking-[-0.01em] text-ellipsis whitespace-nowrap outline-none hover:bg-surface-hover focus-visible:bg-surface focus-visible:shadow-[0_0_0_2px_var(--color-accent)]"
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
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="Switch project"
            >
              <CaretDown size={12} weight="bold" aria-hidden="true" />
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner style={{ zIndex: 40 }}>
                <Menu.Content className={`${POP} min-w-[240px] rounded-[11px] p-1.5`}>
                  <div className="px-2.5 pt-[5px] pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-faint uppercase">Projects</div>
                  {projects.map((p) => (
                    <div key={p.id} className="group flex items-center gap-0.5 rounded-lg hover:bg-surface-hover">
                      <Menu.Item
                        value={p.id}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-[7px] text-left font-ui text-[13.5px] text-ink data-[highlighted]:bg-surface-hover"
                      >
                        <span
                          className={`h-[7px] w-[7px] flex-none rounded-full ${p.id === activeId ? "bg-accent" : "bg-line"}`}
                          aria-hidden="true"
                        />
                        <span className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${p.id === activeId ? "font-semibold text-accent" : ""}`}>{p.name}</span>
                        <span className="text-[11.5px] text-faint tabular-nums">{p.tasks.length || ""}</span>
                      </Menu.Item>
                      {projects.length > 1 && (
                        /* two-step confirm, not a modal: the second click deletes */
                        <button
                          className={
                            armDelete === p.id
                              ? "flex-none cursor-pointer rounded-[7px] border-0 bg-transparent px-2 py-[5px] font-ui text-[11.5px] leading-none font-semibold text-danger opacity-100"
                              : "flex-none cursor-pointer rounded-[7px] border-0 bg-transparent px-2 py-[5px] font-ui text-[14px] leading-none text-faint opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 hover:text-danger"
                          }
                          type="button"
                          onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}
                          title={armDelete === p.id ? "Click again to delete" : "Delete project"}
                        >{armDelete === p.id ? "Sure?" : <X size={13} aria-hidden="true" />}</button>
                      )}
                    </div>
                  ))}
                  <Menu.Item
                    value="::new"
                    className="mt-1 block w-full cursor-pointer rounded-b-lg border-0 border-t border-t-line-soft bg-transparent px-2.5 py-[7px] text-left font-ui text-[13px] font-medium text-accent hover:rounded-lg hover:bg-accent-hover data-[highlighted]:rounded-lg data-[highlighted]:bg-accent-hover"
                  >+ New project</Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        </div>
        {statusText && (
          <span
            className={
              status === "saved"
                ? "rounded-full border border-transparent bg-accent-hover px-2.5 py-[3px] text-xs whitespace-nowrap text-accent"
                : "rounded-full border border-line bg-surface px-2.5 py-[3px] text-xs whitespace-nowrap text-muted"
            }
          >{statusText}</span>
        )}
        {stats && stats.min && stats.max && (
          <span className="pl-1 text-xs whitespace-nowrap text-muted tabular-nums max-[1100px]:hidden">
            {fmtD(stats.min)} – {fmtD(new Date(stats.max.getTime() - DAY))}
            {" · "}<strong className="font-semibold text-ink">{stats.h}h</strong> / {stats.d}d
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
                      <li key={h.id} className="flex items-center gap-2 py-[3px]">
                        {/* .who-chip is scoped to .wx-willow-theme in wx-overrides.css, so
                            outside the widget it renders as bare initials — unchanged from
                            before this migration, and a candidate for the design pass */}
                        <span className="who-chip" style={{ "--who-hue": nameHue(h.name) }}>{initialsOf(h.name)}</span>
                        <input
                          className="min-w-0 flex-1 rounded-[7px] border border-transparent bg-transparent px-2 py-[5px] font-ui text-[13px] text-ink hover:border-line-soft focus:border-accent focus:bg-surface-alt focus:outline-none"
                          value={h.name}
                          aria-label="Name"
                          onChange={(e) => renamePerson(h.id, e.target.value)}
                        />
                        <button
                          type="button"
                          className="inline-flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 leading-none text-faint hover:bg-surface-hover hover:text-danger"
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
                  <input ref={shareInputRef} className={POP_INPUT} readOnly value={SHARE_URL} onFocus={(e) => e.target.select()} />
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
          title={session.user.email || "Signed in"}
          onClick={() => supabase.auth.signOut()}
        >
          <SignOut size={13} aria-hidden="true" />
          Sign out
        </button>
      </header>
      <div className="board relative mx-[14px] mb-[14px] flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
        <CoreWillow fonts={false}>
        <GridWillow fonts={false}>
          <div className="toolbar-row flex flex-none items-center border-b border-b-line-soft">
            <MToolbar api={api} items={TOOLBAR_ITEMS} />
            <div className="flex flex-none items-center gap-[14px] px-4 text-[11.5px] whitespace-nowrap text-muted max-[900px]:hidden" aria-hidden="true">
              {LEGEND.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-[5px]">
                  <span className={`h-2 w-2 rounded-[3px] ${t.dot}`} />{t.label}
                </span>
              ))}
            </div>
          </div>
          <MContextMenu api={api} />
          <div className="gantt-holder min-h-0 flex-1" key={seed + "-" + view + "-" + activeId}>
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
            <div className="pointer-events-auto max-w-[380px] rounded-[14px] border border-line bg-surface px-[26px] py-[22px] text-center shadow-pop motion-safe:animate-rise">
              <div className="mb-1.5 font-display text-[17px] font-semibold">Plan your first task</div>
              <p className="m-0 leading-[1.55] text-muted">Use <strong>“+”</strong> in the toolbar to add a task, then drag its bar to
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
          per row so Ark re-measures instead of reusing the old placement */}
      <Popover.Root
        key={picker ? String(picker.taskId) : "none"}
        open={!!picker}
        onOpenChange={(e) => { if (!e.open) setPicker(null); }}
        positioning={{
          placement: "bottom-start",
          gutter: 8,
          getAnchorRect: () => {
            if (!picker) return null;
            const el = picker.el;
            const r = el && el.isConnected ? el.getBoundingClientRect() : picker.rect;
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
                          className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border-0 px-1.5 py-[5px] text-left font-ui text-[13px] text-ink hover:bg-surface-hover ${on ? "bg-accent-hover" : "bg-transparent"}`}
                          onClick={() => toggleAssignee(picker.taskId, h.id)}
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

/* ---------- auth gate: the editor only mounts with a live session ---------- */
function Root() {
  const [session, setSession] = useState(undefined); /* undefined = still checking */

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => { if (alive) setSession(data.session || null); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { if (alive) setSession(s || null); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  if (session === undefined) return <div className="grid min-h-screen place-items-center bg-ground font-ui text-[13px] text-muted">Loading…</div>;
  if (!session) return <Login />;
  /* keyed on the user so switching accounts remounts with a clean store */
  return <App key={session.user.id} session={session} />;
}

/* the root is cached on the container so a dev hot-reload of this module
   re-renders instead of creating a second root */
const container = document.getElementById("app");
container.__root = container.__root || createRoot(container);
container.__root.render(<Root />);
