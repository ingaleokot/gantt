import React, { useMemo, useRef, useState, useEffect, useCallback, memo } from "react";
import { createRoot } from "react-dom/client";
import { Gantt, Toolbar, ContextMenu, Editor } from "@svar-ui/react-gantt";
import { Willow as CoreWillow } from "@svar-ui/react-core";
import { Willow as GridWillow } from "@svar-ui/react-grid";
import { buildGanttPdf } from "./pdf.js";

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
const LEGEND = [
  { id: "backend", label: "Backend" },
  { id: "frontend", label: "Frontend" },
  { id: "design", label: "Design" },
  { id: "testing", label: "Testing" },
];

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

/* ---------- capabilities ---------- */
const downloadsReady = (async () => {
  try {
    if (window.claude && window.claude.use) return await window.claude.use("downloads");
  } catch (e) { /* fall through */ }
  return null;
})();
const mcpReady = (async () => {
  try {
    if (window.claude && window.claude.use) return await window.claude.use("mcp");
  } catch (e) { /* fall through */ }
  return null;
})();

/* ---------- Supabase persistence (relational, through the viewer's connector) ---------- */
const SUPA = { server: "Supabase", tool: "execute_sql", projectId: "wouvkkaxehwuhtgpersx" };
const SHARE_URL = "https://wouvkkaxehwuhtgpersx.supabase.co/functions/v1/shared/09b3dbcb-ca6b-4bca-bdc8-f0243049ac30";

function sqlStr(s) { return s === null || s === undefined ? "null" : "'" + String(s).replace(/'/g, "''") + "'"; }
function sqlNum(n) { const v = Number(n); return n === null || n === undefined || isNaN(v) ? "null" : String(v); }
function sqlBool(b) { return b === true ? "true" : b === false ? "false" : "null"; }

const LOAD_SQL = `select json_build_object(
  'active', (select active_project from public.app_state where id = 'main'),
  'projects', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'view', p.view) order by p.position, p.created_at) from public.projects p), '[]'::json),
  'tasks', coalesce((select json_agg(json_build_object('id', t.id, 'project', t.project_id, 'parent', t.parent_id, 'text', t.text, 'type', t.type, 'start', t.start_date, 'end', t.end_date, 'duration', t.duration, 'hours', t.hours, 'days', t.days, 'progress', t.progress, 'details', t.details, 'open', t.open, 'url', t.url, 'status', t.status, 'assignees', t.assignees) order by t.sort_order) from public.tasks t), '[]'::json),
  'links', coalesce((select json_agg(json_build_object('id', l.id, 'project', l.project_id, 'source', l.source, 'target', l.target, 'type', l.type)) from public.links l), '[]'::json),
  'people', coalesce((select json_agg(json_build_object('id', pe.id, 'name', pe.name) order by pe.position, pe.name) from public.people pe), '[]'::json)
) as store;`;

function buildSaveSql(data) {
  const ids = data.projects.map((p) => sqlStr(p.id)).join(",");
  let sql = "";
  data.projects.forEach((p, i) => {
    sql += `insert into public.projects (id,name,view,position) values (${sqlStr(p.id)},${sqlStr(p.name || "Untitled project")},${sqlStr(p.view || "day")},${i}) on conflict (id) do update set name=excluded.name, view=excluded.view, position=excluded.position, updated_at=now();\n`;
  });
  sql += `delete from public.projects where id not in (${ids});\n`;
  sql += `delete from public.tasks where project_id in (${ids});\n`;
  const taskRows = [];
  data.projects.forEach((p) => {
    (p.tasks || []).forEach((t, i) => {
      const parent = t.parent !== undefined && t.parent !== null && t.parent !== 0 ? t.parent : null;
      taskRows.push("(" + [
        sqlStr(t.id), sqlStr(p.id), sqlStr(parent), sqlStr(t.text || ""), sqlStr(t.type || "task"),
        sqlStr(t.start || null), sqlStr(t.end || null), sqlNum(t.duration), sqlNum(t.hours), sqlNum(t.days),
        String(Math.round(Number(t.progress) || 0)), sqlStr(t.details || ""), sqlBool(t.open), String(i),
        sqlStr(t.url || null), sqlStr(t.status || "todo"), sqlStr(t.assignees || null),
      ].join(",") + ")");
    });
  });
  if (taskRows.length) {
    sql += "insert into public.tasks (id,project_id,parent_id,text,type,start_date,end_date,duration,hours,days,progress,details,open,sort_order,url,status,assignees) values\n" + taskRows.join(",\n") + ";\n";
  }
  const linkRows = [];
  data.projects.forEach((p) => {
    (p.links || []).forEach((l) => {
      if (l.source === undefined || l.target === undefined) return;
      linkRows.push(`(${sqlStr(l.id)},${sqlStr(p.id)},${sqlStr(l.source)},${sqlStr(l.target)},${sqlStr(l.type || "e2s")})`);
    });
  });
  if (linkRows.length) {
    sql += "insert into public.links (id,project_id,source,target,type) values\n" + linkRows.join(",\n") + " on conflict (id) do nothing;\n";
  }
  const people = data.people || [];
  people.forEach((h, i) => {
    sql += `insert into public.people (id,name,position) values (${sqlStr(h.id)},${sqlStr(h.name || "")},${i}) on conflict (id) do update set name=excluded.name, position=excluded.position, updated_at=now();\n`;
  });
  sql += people.length
    ? `delete from public.people where id not in (${people.map((h) => sqlStr(h.id)).join(",")});\n`
    : "delete from public.people;\n";
  sql += `insert into public.app_state (id, active_project) values ('main', ${sqlStr(data.activeProject)}) on conflict (id) do update set active_project=excluded.active_project, updated_at=now();`;
  return sql;
}

function parseSqlPayload(res) {
  let p = res && res.payload;
  if (Array.isArray(p)) return p;
  if (p && typeof p === "object" && typeof p.result === "string") p = p.result;
  if (typeof p !== "string") { try { p = JSON.stringify(p ?? ""); } catch (e) { return null; } }
  const m = p.match(/<untrusted-data-[^>]*>\s*([\s\S]*?)\s*<\/untrusted-data-[^>]*>/);
  const body = m ? m[1] : p;
  try { const v = JSON.parse(body); return Array.isArray(v) ? v : null; } catch (e) {}
  const i = body.indexOf("["), j = body.lastIndexOf("]");
  if (i >= 0 && j > i) { try { const v = JSON.parse(body.slice(i, j + 1)); return Array.isArray(v) ? v : null; } catch (e) {} }
  return null;
}
async function dbLoad() {
  const mcp = await mcpReady;
  if (!mcp) return { state: "off" };
  try {
    const res = await mcp.callTool(SUPA.server, SUPA.tool, { project_id: SUPA.projectId, query: LOAD_SQL });
    const rows = parseSqlPayload(res);
    const s = rows && rows[0] && rows[0].store;
    if (!s || !Array.isArray(s.projects) || !s.projects.length) return { state: "ok", data: null };
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
        if (t.open !== null && t.open !== undefined) o.open = t.open;
        if (t.url) o.url = t.url;
        if (t.assignees) o.assignees = t.assignees;
        o.status = t.status || "todo";
        return o;
      }),
      links: (s.links || []).filter((l) => l.project === p.id).map((l) => ({ id: l.id, source: l.source, target: l.target, type: l.type || "e2s" })),
    }));
    const active = projects.some((p) => p.id === s.active) ? s.active : projects[0].id;
    const people = (s.people || []).filter((x) => x && x.id).map((x) => ({ id: x.id, name: x.name || "" }));
    return { state: "ok", data: { version: 2, activeProject: active, projects, people } };
  } catch (e) {
    return { state: "err", code: e && e.code };
  }
}
async function dbSave(data) {
  const mcp = await mcpReady;
  if (!mcp) return { state: "off" };
  try {
    await mcp.callTool(SUPA.server, SUPA.tool, { project_id: SUPA.projectId, query: buildSaveSql(data) });
    return { state: "ok" };
  } catch (e) {
    return { state: "err", code: e && e.code };
  }
}
/* ---- share view template sync: uploads the read-only page into Supabase
   (base64 chunks) so the gantt-view edge function can serve it live ---- */
const VIEW_CHUNK = 60000;
async function ensureViewPage(onProgress) {
  const b64 = window.__VIEW_TPL_B64, hash = window.__VIEW_TPL_HASH;
  if (!b64 || !hash) return { state: "ok" };
  const mcp = await mcpReady;
  if (!mcp) return { state: "off" };
  const q = (query) => mcp.callTool(SUPA.server, SUPA.tool, { project_id: SUPA.projectId, query });
  try {
    const rows = parseSqlPayload(await q("select hash from public.view_page where id='main';"));
    if (rows && rows[0] && rows[0].hash === hash) return { state: "ok" };
    const chunks = [];
    for (let i = 0; i < b64.length; i += VIEW_CHUNK) chunks.push(b64.slice(i, i + VIEW_CHUNK));
    for (let i = 0; i < chunks.length; i++) {
      if (onProgress) onProgress(i + 1, chunks.length);
      await q(
        "insert into public.view_chunks (idx,hash,data) values (" + i + ",'" + hash + "','" + chunks[i] + "')" +
        " on conflict (idx) do update set hash=excluded.hash, data=excluded.data;"
      );
    }
    await q(
      "delete from public.view_chunks where idx >= " + chunks.length + ";" +
      "insert into public.view_page (id,hash,chunk_count) values ('main','" + hash + "'," + chunks.length + ")" +
      " on conflict (id) do update set hash=excluded.hash, chunk_count=excluded.chunk_count, updated_at=now();"
    );
    return { state: "ok" };
  } catch (e) {
    return { state: "err", code: e && e.code };
  }
}

function dbErrorText(code) {
  if (code === "needs_reauth") return "reconnect Supabase in claude.ai Settings → Connectors";
  if (code === "server_not_connected") return "add Supabase in claude.ai Settings → Connectors";
  if (code === "selection_required") return "choose a Supabase connector when prompted";
  if (code === "not_granted" || code === "not_in_manifest") return "Supabase access not allowed for this page";
  return "Supabase sync failed";
}

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
        host.onclick = (e) => {
          e.stopPropagation();
          if (pickHook) pickHook(t.id, host.getBoundingClientRect());
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
function App() {
  const storeRef = useRef(loadData());
  const store = storeRef.current;
  const [activeId, setActiveId] = useState(store.activeProject);
  const activeProject = () => storeRef.current.projects.find((p) => p.id === storeRef.current.activeProject) || storeRef.current.projects[0];

  const [api, setApi] = useState(null);
  const [view, setView] = useState(VIEWS[activeProject().view] ? activeProject().view : "day");
  const [status, setStatus] = useState("idle");
  const [taskCount, setTaskCount] = useState(activeProject().tasks.length);
  const [seed, setSeed] = useState(0);
  const [canExport, setCanExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [stats, setStats] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [people, setPeople] = useState(() => storeRef.current.people || []);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [newPerson, setNewPerson] = useState("");
  const peopleRef = useRef(null);
  const [picker, setPicker] = useState(null); /* { taskId, rect } */
  const pickerRef = useRef(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareState, setShareState] = useState("idle"); /* idle | sync | ready | err */
  const [shareProg, setShareProg] = useState("");
  const shareRef = useRef(null);
  const shareSyncRef = useRef(false);
  const [armDelete, setArmDelete] = useState(null);
  const [dbState, setDbState] = useState({ state: "off" });
  const [, forceRender] = useState(0);
  const nameRef = useRef(activeProject().name);
  const clipRef = useRef(null);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const snapTimer = useRef(null);
  const saveTimer = useRef(null);
  const apiRef = useRef(null);
  const menuRef = useRef(null);
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
    const r = await dbSave(data);
    setDbState(r);
    setStatus(r.state === "ok" ? "saved" : "local");
  }, [view, snapshotActive]);

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
      if (r.state === "off") return;
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

  useEffect(() => {
    let alive = true;
    downloadsReady.then((ns) => { if (alive && ns) setCanExport(true); });
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

  /* first time the share popover opens, make sure the view page is in Supabase */
  useEffect(() => {
    if (!shareOpen || shareSyncRef.current) return;
    shareSyncRef.current = true;
    setShareState("sync");
    setShareProg("");
    ensureViewPage((i, n) => setShareProg(i + "/" + n)).then((r) => {
      if (r.state === "ok") { setShareState("ready"); return; }
      shareSyncRef.current = false; /* allow retry on next open */
      setShareState("err");
    });
  }, [shareOpen]);

  /* close share popover on outside click */
  useEffect(() => {
    if (!shareOpen) return;
    const close = (e) => { if (shareRef.current && !shareRef.current.contains(e.target)) { setShareOpen(false); setCopied(false); } };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [shareOpen]);

  const copyShareLink = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(SHARE_URL); ok = true; } catch (e) {}
    if (!ok) {
      const inp = shareRef.current && shareRef.current.querySelector("input");
      if (inp) { inp.focus(); inp.select(); try { ok = document.execCommand("copy"); } catch (e) {} }
    }
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2500);
  };

  /* close project menu on outside click */
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) { setMenuOpen(false); setArmDelete(null); } };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const exportPdf = useCallback(async () => {
    if (exporting) return;
    const p = snapshotActive();
    setExporting(true);
    try {
      const buf = buildGanttPdf(p.name, p.tasks, p.links);
      const ns = await downloadsReady;
      if (!ns) { setCanExport(false); return; }
      const safe = (p.name || "gantt").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "gantt";
      await ns.save({ filename: safe + ".pdf", data: buf });
    } catch (e) {
      const code = e && e.code;
      if (code === "unavailable" || code === "not_granted" || code === "capability_disabled" || code === "capability_removed") setCanExport(false);
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
    pickHook = (taskId, rect) => {
      let ids = [];
      try { ids = parseAssignees(apiRef.current.getTask(taskId).assignees); } catch (e) { /* unassigned */ }
      setPicker({ taskId, rect, ids });
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

  useEffect(() => {
    if (!peopleOpen) return undefined;
    const close = (e) => { if (peopleRef.current && !peopleRef.current.contains(e.target)) setPeopleOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [peopleOpen]);

  useEffect(() => {
    if (!picker) return undefined;
    const close = (e) => { if (pickerRef.current && !pickerRef.current.contains(e.target)) setPicker(null); };
    const esc = (e) => { if (e.key === "Escape") setPicker(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc, true); };
  }, [picker]);

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
    setMenuOpen(false);
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
    setMenuOpen(false);
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
  if (statusText && dbState.state === "err") statusText += " · " + dbErrorText(dbState.code);
  const projects = storeRef.current.projects;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand" aria-hidden="true"><span className="brand-mark" /></div>
        <div className="proj" ref={menuRef}>
          <h1
            key={activeId}
            className="project-name"
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onInput={onName}
            onBlur={onName}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
          >{activeProject().name}</h1>
          <button className="proj-toggle" type="button" aria-label="Switch project"
            onClick={() => { setMenuOpen((o) => !o); setArmDelete(null); }}>
            <span className="chev" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="proj-menu" role="menu">
              <div className="proj-menu-label">Projects</div>
              {projects.map((p) => (
                <div key={p.id} className={"proj-row" + (p.id === activeId ? " on" : "")}>
                  <button className="proj-open" type="button" onClick={() => openProject(p.id)}>
                    <span className="proj-dot" aria-hidden="true" />
                    <span className="proj-title">{p.name}</span>
                    <span className="proj-count">{p.tasks.length || ""}</span>
                  </button>
                  {projects.length > 1 && (
                    <button
                      className={"proj-del" + (armDelete === p.id ? " armed" : "")}
                      type="button"
                      onClick={() => deleteProject(p.id)}
                      title={armDelete === p.id ? "Click again to delete" : "Delete project"}
                    >{armDelete === p.id ? "Sure?" : "×"}</button>
                  )}
                </div>
              ))}
              <button className="proj-new" type="button" onClick={createProject}>+ New project</button>
            </div>
          )}
        </div>
        {statusText && <span className={"save-chip save-" + status}>{statusText}</span>}
        {stats && stats.min && stats.max && (
          <span className="proj-stats">
            {fmtD(stats.min)} – {fmtD(new Date(stats.max.getTime() - DAY))}
            {" · "}<strong>{stats.h}h</strong> / {stats.d}d
            {stats.epics > 0 && " · " + stats.epics + (stats.epics === 1 ? " epic" : " epics")}
          </span>
        )}
        <div className="spacer" />
        <div className="people" ref={peopleRef}>
          <button className="export-btn" type="button" onClick={() => setPeopleOpen((o) => !o)}>
            <span className="people-icon" aria-hidden="true" />
            People{people.length ? " · " + people.length : ""}
          </button>
          {peopleOpen && (
            <div className="people-pop">
              <div className="share-title">People</div>
              <p className="share-hint">Anyone on this list can be assigned to a task or an epic.</p>
              {people.length > 0 && (
                <ul className="people-list">
                  {people.map((h) => (
                    <li key={h.id}>
                      <span className="who-chip" style={{ "--who-hue": nameHue(h.name) }}>{initialsOf(h.name)}</span>
                      <input
                        value={h.name}
                        aria-label="Name"
                        onChange={(e) => renamePerson(h.id, e.target.value)}
                      />
                      <button type="button" className="people-del" title={"Remove " + h.name}
                        onClick={() => removePerson(h.id)}>×</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="share-row">
                <input
                  value={newPerson}
                  placeholder="Add a person"
                  onChange={(e) => setNewPerson(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPerson(); } }}
                />
                <button type="button" className="share-copy" onClick={addPerson}>Add</button>
              </div>
            </div>
          )}
        </div>
        <div className="share" ref={shareRef}>
          <button className="export-btn" type="button" onClick={() => { setShareOpen((o) => !o); setCopied(false); }}>
            <span className="share-icon" aria-hidden="true" />
            Share
          </button>
          {shareOpen && (
            <div className="share-pop">
              <div className="share-title">View-only link</div>
              <p className="share-hint">Anyone with this link can see the chart live — data loads fresh on every open, no editing.</p>
              <div className="share-row">
                <input readOnly value={SHARE_URL} onFocus={(e) => e.target.select()} />
                <button type="button" className="share-copy" onClick={copyShareLink}>{copied ? "Copied!" : "Copy"}</button>
              </div>
              {shareState === "sync" && <p className="share-status">Preparing the view page{shareProg ? " · " + shareProg : ""}…</p>}
              {shareState === "ready" && <p className="share-status ok">Link is live and up to date.</p>}
              {shareState === "err" && <p className="share-status bad">Couldn't prepare the view page — check the Supabase connection and reopen this popover.</p>}
            </div>
          )}
        </div>
        {canExport && (
          <button className="export-btn" type="button" onClick={exportPdf} disabled={exporting}>
            <span className="export-icon" aria-hidden="true" />
            {exporting ? "Exporting…" : "Export PDF"}
          </button>
        )}
        <div className="seg" role="group" aria-label="Timeline scale">
          {Object.entries(VIEWS).map(([k, v]) => (
            <button key={k} className={"seg-btn" + (view === k ? " on" : "")}
              onClick={() => changeView(k)} type="button">{v.label}</button>
          ))}
        </div>
      </header>
      <div className="board">
        <CoreWillow fonts={false}>
        <GridWillow fonts={false}>
          <div className="toolbar-row">
            <MToolbar api={api} items={TOOLBAR_ITEMS} />
            <div className="legend" aria-hidden="true">
              {LEGEND.map((t) => (
                <span key={t.id} className="legend-item">
                  <span className={"legend-dot type-" + t.id} />{t.label}
                </span>
              ))}
            </div>
          </div>
          <MContextMenu api={api} />
          <div className="gantt-holder" key={seed + "-" + view + "-" + activeId}>
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
          <div className="empty-hint">
            <div className="empty-card">
              <div className="empty-title">Plan your first task</div>
              <p>Use <strong>“+”</strong> in the toolbar to add a task, then drag its bar to
              reschedule, drag its edge to resize, and double&#8209;click it to edit details.
              Double&#8209;click a task&#8217;s name in the list to rename it in place. Make a
              task an <strong>Epic</strong> and indent tasks under it — its length follows its
              tasks automatically.</p>
            </div>
          </div>
        )}
      </div>
      {picker && (
        <div className="who-pop" ref={pickerRef}
          style={{ left: Math.max(8, Math.min(picker.rect.left - 60, window.innerWidth - 236)), top: picker.rect.bottom + 8 }}>
          <div className="share-title">Assign</div>
          {people.length === 0 ? (
            <p className="share-hint">No people yet — add them under <strong>People</strong> in the header.</p>
          ) : (
            <ul className="who-pick">
              {people.map((h) => {
                const on = picker.ids.includes(h.id);
                return (
                  <li key={h.id}>
                    <button type="button" className={"who-pick-row" + (on ? " on" : "")}
                      onClick={() => toggleAssignee(picker.taskId, h.id)}>
                      <span className="who-chip" style={{ "--who-hue": nameHue(h.name) }}>{initialsOf(h.name)}</span>
                      <span className="who-pick-name">{h.name}</span>
                      <span className="who-pick-check" aria-hidden="true">{on ? "\u2713" : ""}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("app"));
root.render(<App />);
