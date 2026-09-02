import React, { useMemo, useRef, useState, useCallback, memo } from "react";
import { createRoot } from "react-dom/client";
import { Gantt } from "@svar-ui/react-gantt";
import { Willow as CoreWillow } from "@svar-ui/react-core";
import { Willow as GridWillow } from "@svar-ui/react-grid";

const DAY = 24 * 60 * 60 * 1000;
const HOURS_PER_DAY = 7;
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
function rollForward(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (isWeekend(x)) x.setDate(x.getDate() + 1);
  return x;
}
function addWorkDays(start, n) {
  const x = new Date(start.getTime());
  let left = Math.max(1, n);
  while (left > 1) { x.setDate(x.getDate() + 1); if (!isWeekend(x)) left--; }
  const e = new Date(x.getTime());
  e.setDate(e.getDate() + 1);
  return e;
}
function workDaysBetween(s, e) {
  let c = 0;
  const x = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  while (x < e) { if (!isWeekend(x)) c++; x.setDate(x.getDate() + 1); }
  return Math.max(1, c);
}
const isBar = (t) => t && t.type !== "summary" && t.type !== "milestone";
function scheduleFromHours(hours, startLike) {
  const start = rollForward(startLike instanceof Date ? startLike : new Date());
  const h = Math.max(0.5, Math.round((Number(hours) || HOURS_PER_DAY) * 2) / 2);
  const end = addWorkDays(start, Math.ceil(h / HOURS_PER_DAY));
  const days = Math.round((h / HOURS_PER_DAY) * 10) / 10;
  return { hours: h, days, start, end, duration: Math.round((end - start) / DAY) };
}
function reviveTask(t) {
  const out = { ...t };
  if (out.start) out.start = new Date(out.start + "T00:00:00");
  if (out.end) out.end = new Date(out.end + "T00:00:00");
  return out;
}
function prepareTasks(tasks) {
  const parents = new Set(tasks.map((t) => t.parent).filter((p) => p !== undefined && p !== null && p !== 0));
  return tasks.map((t) => {
    const r = reviveTask(t);
    if (parents.has(r.id) && r.type !== "summary") r.type = "summary";
    if (r.type === "summary" && parents.has(r.id)) { delete r.start; delete r.end; delete r.duration; return r; }
    if (r.type === "summary" && !r.start) {
      r.start = rollForward(new Date());
      r.end = addWorkDays(r.start, 1);
      r.duration = Math.round((r.end - r.start) / DAY);
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
function trackerId(url) {
  const m = /([A-Za-z][A-Za-z0-9_]*-\d+)\/?(?:[?#].*)?$/.exec(url || "");
  return m ? m[1].toUpperCase() : null;
}

/* ---------- load embedded data ---------- */
function loadStore() {
  let raw = null;
  try { raw = JSON.parse(document.getElementById("view-data").textContent); } catch (e) {}
  const empty = { active: null, projects: [], tasks: [], links: [] };
  const s = raw && Array.isArray(raw.projects) ? raw : empty;
  const projects = s.projects.map((p) => ({
    id: p.id,
    name: p.name,
    view: p.view || "day",
    tasks: (s.tasks || []).filter((t) => t.project === p.id).map((t) => {
      const o = { id: t.id, text: t.text || "", type: t.type || "task", progress: t.progress || 0, details: t.details || "" };
      if (t.parent !== null && t.parent !== undefined) o.parent = t.parent;
      if (t.start) o.start = t.start;
      if (t.end) o.end = t.end;
      if (t.duration !== null && t.duration !== undefined) o.duration = t.duration;
      if (t.hours !== null && t.hours !== undefined) o.hours = Number(t.hours);
      if (t.days !== null && t.days !== undefined) o.days = Number(t.days);
      if ((s.tasks || []).some((c) => c.parent === t.id)) o.open = true; /* branches start expanded for viewers */
      if (t.url) o.url = t.url;
      o.status = t.status || "todo";
      return o;
    }),
    links: (s.links || []).filter((l) => l.project === p.id).map((l) => ({ id: l.id, source: l.source, target: l.target, type: l.type || "e2s" })),
  }));
  const active = projects.some((p) => p.id === s.active) ? s.active : projects.length ? projects[0].id : null;
  return { projects, active };
}

const VIEWS = {
  day:   { label: "Day",   cellWidth: 36,  scales: [{ unit: "month", step: 1, format: "%F %Y" }, { unit: "day", step: 1, format: "%j" }] },
  week:  { label: "Week",  cellWidth: 74,  scales: [{ unit: "month", step: 1, format: "%M %Y" }, { unit: "week", step: 1, format: "w%W" }] },
  month: { label: "Month", cellWidth: 110, scales: [{ unit: "year", step: 1, format: "%Y" }, { unit: "month", step: 1, format: "%M" }] },
};
const HIGHLIGHT = (d, u) => (u === "day" && (d.getDay() === 0 || d.getDay() === 6) ? "wx-weekend" : "");
const COLUMNS = [
  { id: "text", header: "Task name", width: 183, flexgrow: 1, sort: true },
  { id: "tracker", header: "ID", width: 100, align: "center", sort: false },
  { id: "start", header: "Start", width: 92, align: "center", sort: true },
  { id: "hours", header: "Hrs", width: 62, align: "center", sort: true },
  { id: "days", header: "Days", width: 58, align: "center", sort: true },
];
const LEGEND = [
  { id: "backend", label: "Backend" },
  { id: "frontend", label: "Frontend" },
  { id: "design", label: "Design" },
  { id: "testing", label: "Testing" },
];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtD = (d) => d.getDate() + " " + MON[d.getMonth()];

/* ---------- visual decorations (same look as the editor app) ---------- */
let rowTagObserver = null;
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
function decorate(api, project) {
  document.querySelectorAll(".gantt-holder .wx-row[data-id]").forEach((row) => {
    const raw = row.getAttribute("data-id") || "";
    const id = raw.startsWith(":") ? raw.slice(1) : raw;
    let t = null;
    try { t = api.getTask(id); } catch (e) {}
    if (!t && /^\d+$/.test(id)) { try { t = api.getTask(Number(id)); } catch (e) {} }
    if (!t) return;
    row.classList.toggle("is-epic", t.type === "summary");
    row.classList.toggle("in-epic", t.type !== "summary" && (t.$level || 1) > 1);
    const status = t.status === "done" || t.status === "progress" ? t.status : "todo";
    ["st-todo", "st-progress", "st-done"].forEach((c) => row.classList.remove(c));
    row.classList.add("st-" + status);
    const content = row.querySelector('[data-col-id=":text"] .wx-content');
    if (content) {
      let dot = content.querySelector(".status-dot");
      if (!dot) { dot = document.createElement("span"); dot.className = "status-dot"; content.appendChild(dot); }
      const dc = "status-dot sd-" + status;
      if (dot.className !== dc) dot.className = dc;
      const iconCls = "type-icon ti-" + (t.type || "task");
      let ic = content.querySelector(".type-icon");
      if (!ic) { ic = document.createElement("span"); ic.className = iconCls; content.appendChild(ic); }
      else if (ic.className !== iconCls) ic.className = iconCls;
    }
    const rawUrl = typeof t.url === "string" && /^https?:\/\//i.test(t.url.trim()) ? t.url.trim() : null;
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
          (cell.querySelector(".wx-content") || cell).appendChild(a2);
        }
        if (a2.getAttribute("href") !== rawUrl) { a2.setAttribute("href", rawUrl); a2.title = rawUrl; }
        if (a2.textContent !== tid) a2.textContent = tid;
      } else if (a2) a2.remove();
    }
  });
  document.querySelectorAll(".gantt-holder .wx-bar[data-task-id]").forEach((bar) => {
    const raw = bar.getAttribute("data-task-id") || "";
    const id = raw.startsWith(":") ? raw.slice(1) : raw;
    let t = null;
    try { t = api.getTask(id); } catch (e) {}
    if (!t) return;
    const status = t.status === "done" || t.status === "progress" ? t.status : "todo";
    ["st-todo", "st-progress", "st-done"].forEach((c) => bar.classList.remove(c));
    bar.classList.add("st-" + status);
  });
  /* epic bands */
  const area = document.querySelector(".gantt-holder .wx-area");
  if (area) {
    let layer = area.querySelector(":scope > .epic-bands");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "epic-bands";
      const hol = area.querySelector(":scope > .wx-gantt-holidays");
      if (hol) hol.after(layer); else area.prepend(layer);
    }
    let rows = [], ch = 38;
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
  const scaleEl = document.querySelector(".gantt-holder .wx-chart > .wx-scale");
  if (scaleEl) {
    let el = scaleEl.querySelector(":scope > .project-span");
    let min = null, max = null;
    project.tasks.forEach((t) => {
      if (t.type === "summary") return;
      if (t.start && (!min || t.start < min)) min = t.start;
      const e = t.end || t.start;
      if (e && (!max || e > max)) max = e;
    });
    const sc = (() => { try { return api.getState()._scales; } catch (e) { return null; } })();
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
function watchDecorations(api, project) {
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

function computeStats(tasks) {
  let h = 0, epics = 0, min = null, max = null;
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

function App() {
  const store = useMemo(loadStore, []);
  const [activeId, setActiveId] = useState(store.active);
  const [view, setView] = useState("day");
  const [seed, setSeed] = useState(0);
  const apiRef = useRef(null);

  const project = store.projects.find((p) => p.id === activeId) || store.projects[0] || { name: "Project timeline", tasks: [], links: [] };
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

  const init = useCallback((a) => {
    apiRef.current = a;
    setTimeout(() => watchDecorations(a, project), 0);
  }, [activeId, seed]);

  const vd = VIEWS[view];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand" aria-hidden="true"><span className="brand-mark" /></div>
        <h1 className="project-name view-name">{project.name}</h1>
        <span className="save-chip">View only</span>
        {stats && stats.min && stats.max && (
          <span className="proj-stats">
            {fmtD(stats.min)} – {fmtD(new Date(stats.max.getTime() - DAY))}
            {" · "}<strong>{stats.h}h</strong> / {stats.d}d
            {stats.epics > 0 && " · " + stats.epics + (stats.epics === 1 ? " epic" : " epics")}
          </span>
        )}
        <div className="spacer" />
        {store.projects.length > 1 && (
          <div className="seg" role="group" aria-label="Projects">
            {store.projects.map((p) => (
              <button key={p.id} className={"seg-btn" + (p.id === project.id ? " on" : "")}
                onClick={() => { setActiveId(p.id); setSeed((s) => s + 1); }} type="button">{p.name}</button>
            ))}
          </div>
        )}
        <div className="seg" role="group" aria-label="Timeline scale">
          {Object.entries(VIEWS).map(([k, v]) => (
            <button key={k} className={"seg-btn" + (view === k ? " on" : "")}
              onClick={() => { setView(k); setSeed((s) => s + 1); }} type="button">{v.label}</button>
          ))}
        </div>
      </header>
      <div className="board">
        <CoreWillow fonts={false}>
        <GridWillow fonts={false}>
          <div className="toolbar-row view-toolbar">
            <div className="legend" aria-hidden="true">
              {LEGEND.map((t) => (
                <span key={t.id} className="legend-item">
                  <span className={"legend-dot type-" + t.id} />{t.label}
                </span>
              ))}
            </div>
          </div>
          <div className="gantt-holder" key={seed + "-" + view + "-" + (project.id || "none")}>
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
          <div className="empty-hint">
            <div className="empty-card">
              <div className="empty-title">Nothing here yet</div>
              <p>This project has no scheduled tasks.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("app")).render(<App />);
