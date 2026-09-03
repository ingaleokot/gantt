import { jsPDF } from "jspdf";
import type { StoreLink, StoreTask, TaskId } from "../../lib/db";

const DAY = 24 * 60 * 60 * 1000;
/* jsPDF's colour setters take three channels, so the palette entries are
   fixed-length tuples and can be spread straight into them */
type Rgb = readonly [number, number, number];
type ColorName =
  | "ink" | "muted" | "line" | "zebra" | "weekend" | "accent"
  | "progress" | "summary" | "milestone" | "link" | "today" | "headerBg";
const C: Record<ColorName, Rgb> = {
  ink: [28, 42, 46],
  muted: [98, 119, 122],
  line: [220, 227, 226],
  zebra: [244, 247, 246],
  weekend: [238, 242, 241],
  accent: [16, 118, 127],
  progress: [10, 82, 89],
  summary: [47, 107, 223],
  milestone: [192, 124, 30],
  link: [160, 175, 177],
  today: [196, 69, 60],
  headerBg: [241, 245, 244],
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type TypeColor = { bar: Rgb; deep: Rgb; label: string };
const TYPE_COLORS: Record<string, TypeColor> = {
  backend:  { bar: [168, 195, 236], deep: [125, 163, 220], label: "Backend" },
  frontend: { bar: [165, 218, 216], deep: [111, 191, 187], label: "Frontend" },
  design:   { bar: [212, 188, 228], deep: [181, 146, 206], label: "Design" },
  testing:  { bar: [191, 224, 168], deep: [151, 200, 119], label: "Testing" },
};

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === "string") {
    const d = new Date(v.length <= 10 ? v + "T00:00:00" : v);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  return null;
}
function fmtShort(d: Date) { return d.getDate() + " " + MONTHS[d.getMonth()]; }
function fmtFull(d: Date) { return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }

type LeveledTask = StoreTask & { $level: number };
/* the rows actually drawn: `_s` is proven by the filter below, and `_e` is
   always written alongside it in the same map step */
type PdfRow = LeveledTask & { _s: Date | null; _e: Date | null };
type PlacedRow = LeveledTask & { _s: Date; _e: Date | null };

/* order tasks as a tree (parents before children), compute levels */
function orderTasks(tasks: StoreTask[]): LeveledTask[] {
  const kids = new Map<TaskId, StoreTask[]>();
  const ids = new Set<TaskId>(tasks.map((t) => t.id));
  tasks.forEach((t) => {
    const p = t.parent !== undefined && t.parent !== null && ids.has(t.parent) ? t.parent : 0;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(t); /* set on the line above */
  });
  const out: LeveledTask[] = [];
  const walk = (pid: TaskId, level: number) => {
    (kids.get(pid) || []).forEach((t) => {
      out.push({ ...t, $level: level });
      walk(t.id, level + 1);
    });
  };
  walk(0, 0);
  return out;
}

export function buildGanttPdf(name: string, tasks: StoreTask[], links: StoreLink[]): jsPDF {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const PW = 297, PH = 210, M = 12;
  const rows = orderTasks(tasks).map((t): PdfRow => {
    const start = toDate(t.start);
    let end = toDate(t.end);
    if (!end && start) end = new Date(start.getTime() + Math.max(1, t.duration || 1) * DAY);
    if (t.type === "milestone" && start) end = start;
    return { ...t, _s: start, _e: end };
  }).filter((t): t is PlacedRow => !!t._s);

  /* time span */
  let min = Infinity, max = -Infinity;
  rows.forEach((t) => { min = Math.min(min, t._s.getTime()); max = Math.max(max, (t._e || t._s).getTime()); });
  if (!isFinite(min)) { const today = Date.now(); min = today; max = today + 30 * DAY; }
  min -= 2 * DAY; max += 3 * DAY;
  const spanDays = Math.max(7, Math.round((max - min) / DAY));
  const unit = spanDays <= 62 ? "day" : spanDays <= 260 ? "week" : "month";

  /* geometry */
  const nameW = 46, idW = 19, dateW = 17, hrsW = 12;
  const tableW = nameW + idW + dateW * 2 + hrsW;
  const tid = (url: string | undefined) => { const m = /([A-Za-z][A-Za-z0-9_]*-\d+)\/?(?:[?#].*)?$/.exec(url || ""); return m ? m[1].toUpperCase() : null; };
  const chartX = M + tableW, chartW = PW - M - chartX;
  const pxDay = chartW / spanDays;
  const topY = 30, scaleH = 13, rowH = 7.4, barH = 4.2;
  const rowsPerPage = Math.floor((PH - M - topY - scaleH) / rowH);
  const X = (t: number) => chartX + ((t - min) / DAY) * pxDay;

  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));

  const drawHeader = (page: number) => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(...C.ink);
    doc.text(name || "Project timeline", M, 17);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...C.muted);
    const meta = fmtFull(new Date(min + 2 * DAY)) + "  –  " + fmtFull(new Date(max - 3 * DAY))
      + "     ·     exported " + fmtFull(new Date())
      + (pageCount > 1 ? "     ·     page " + page + " of " + pageCount : "");
    doc.text(meta, M, 22.5);

    /* type legend, right-aligned, only for types in use */
    const used = Object.keys(TYPE_COLORS).filter((k) => rows.some((t) => t.type === k));
    if (used.length) {
      doc.setFontSize(7.5);
      let lx = PW - M;
      for (let u = used.length - 1; u >= 0; u--) {
        const tc = TYPE_COLORS[used[u]];
        const w = doc.getTextWidth(tc.label);
        lx -= w;
        doc.setTextColor(...C.muted);
        doc.text(tc.label, lx, 22.5);
        lx -= 3.4;
        doc.setFillColor(...tc.bar);
        doc.roundedRect(lx, 20.2, 2.4, 2.4, 0.6, 0.6, "F");
        lx -= 5.5;
      }
    }
  };

  const drawScale = (nRows: number) => {
    const gridBottom = topY + scaleH + nRows * rowH;
    /* header band */
    doc.setFillColor(...C.headerBg);
    doc.rect(M, topY, PW - 2 * M, scaleH, "F");

    /* table headers */
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(...C.muted);
    doc.text("TASK", M + 2, topY + 8.6);
    doc.text("ID", M + nameW + 2, topY + 8.6);
    doc.text("START", M + nameW + idW + 2, topY + 8.6);
    doc.text("END", M + nameW + idW + dateW + 2, topY + 8.6);
    doc.text("HRS", M + nameW + idW + dateW * 2 + 2, topY + 8.6);

    /* weekend / unit shading + bottom scale labels */
    doc.setFontSize(6.6);
    const half = topY + scaleH / 2;
    let cursor = new Date(min);
    cursor.setHours(0, 0, 0, 0);
    const labelEvery = unit === "day" ? (pxDay >= 3.2 ? 1 : pxDay >= 1.7 ? 2 : 7) : 1;
    let i = 0;
    while (cursor.getTime() < max) {
      const t0 = cursor.getTime();
      let next = new Date(t0);
      if (unit === "day") next = new Date(t0 + DAY);
      else if (unit === "week") next = new Date(t0 + 7 * DAY);
      else { next = new Date(next.getFullYear(), next.getMonth() + 1, 1); }
      const x0 = Math.max(chartX, X(t0)), x1 = Math.min(PW - M, X(next.getTime()));
      if (x1 > x0) {
        if (unit === "day") {
          const dow = cursor.getDay();
          if (dow === 0 || dow === 6) { doc.setFillColor(...C.weekend); doc.rect(x0, topY + scaleH, x1 - x0, nRows * rowH, "F"); }
          if (i % labelEvery === 0 && x1 - x0 >= 1.6) {
            doc.setFont("helvetica", "normal"); doc.setTextColor(...C.muted);
            doc.text(String(cursor.getDate()), (x0 + x1) / 2, topY + scaleH - 2.2, { align: "center" });
          }
        } else if (unit === "week") {
          doc.setFont("helvetica", "normal"); doc.setTextColor(...C.muted);
          if (x1 - x0 >= 7) doc.text(fmtShort(cursor), (x0 + x1) / 2, topY + scaleH - 2.2, { align: "center" });
          doc.setDrawColor(...C.line); doc.setLineWidth(0.15);
          doc.line(x0, topY + scaleH, x0, gridBottom);
        } else {
          doc.setFont("helvetica", "normal"); doc.setTextColor(...C.muted);
          if (x1 - x0 >= 8) doc.text(MONTHS[cursor.getMonth()], (x0 + x1) / 2, topY + scaleH - 2.2, { align: "center" });
          doc.setDrawColor(...C.line); doc.setLineWidth(0.15);
          doc.line(x0, topY + scaleH, x0, gridBottom);
        }
      }
      cursor = next; i++;
    }

    /* top scale: months (day/week units) or years (month unit) */
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(...C.ink);
    let mCur = unit === "month" ? new Date(new Date(min).getFullYear(), 0, 1) : new Date(new Date(min).getFullYear(), new Date(min).getMonth(), 1);
    while (mCur.getTime() < max) {
      const mNext = unit === "month" ? new Date(mCur.getFullYear() + 1, 0, 1) : new Date(mCur.getFullYear(), mCur.getMonth() + 1, 1);
      const x0 = Math.max(chartX, X(mCur.getTime())), x1 = Math.min(PW - M, X(mNext.getTime()));
      if (x1 - x0 >= 12) {
        const label = unit === "month" ? String(mCur.getFullYear()) : MONTHS[mCur.getMonth()] + " " + mCur.getFullYear();
        doc.text(label, (x0 + x1) / 2, half - 1.2, { align: "center" });
      }
      doc.setDrawColor(...C.line); doc.setLineWidth(0.2);
      doc.line(x0, topY, x0, unit === "day" ? gridBottom : topY + scaleH);
      mCur = mNext;
    }

    /* frame lines */
    doc.setDrawColor(...C.line); doc.setLineWidth(0.25);
    doc.line(M, topY, PW - M, topY);
    doc.line(M, topY + scaleH, PW - M, topY + scaleH);
    doc.line(M + nameW, topY, M + nameW, gridBottom);
    doc.line(M + nameW + idW, topY, M + nameW + idW, gridBottom);
    doc.line(M + nameW + idW + dateW, topY, M + nameW + idW + dateW, gridBottom);
    doc.line(M + nameW + idW + dateW * 2, topY, M + nameW + idW + dateW * 2, gridBottom);
    doc.line(chartX, topY, chartX, gridBottom);
    doc.line(M, gridBottom, PW - M, gridBottom);

    /* today marker */
    const now = Date.now();
    if (now > min && now < max) {
      doc.setDrawColor(...C.today); doc.setLineWidth(0.35);
      doc.setLineDashPattern([1.2, 1.2], 0);
      doc.line(X(now), topY + scaleH, X(now), gridBottom);
      doc.setLineDashPattern([], 0);
    }
  };

  const barGeom = new Map<TaskId | undefined, { x0: number; x1: number; yc: number }>(); // id -> {x0,x1,yc,pageIdx}

  for (let p = 0; p < pageCount; p++) {
    if (p > 0) doc.addPage("a4", "landscape");
    drawHeader(p + 1);
    const slice = rows.slice(p * rowsPerPage, (p + 1) * rowsPerPage);
    drawScale(slice.length);

    slice.forEach((t, r) => {
      const y = topY + scaleH + r * rowH;
      const yc = y + rowH / 2;
      if (r % 2 === 1) { doc.setFillColor(...C.zebra); doc.rect(M, y, tableW, rowH, "F"); }
      doc.setDrawColor(...C.line); doc.setLineWidth(0.12);
      doc.line(M, y + rowH, PW - M, y + rowH);

      /* table cells */
      const isSummary = t.type === "summary";
      doc.setFont("helvetica", isSummary ? "bold" : "normal");
      doc.setFontSize(8); doc.setTextColor(...C.ink);
      const indent = 2 + (t.$level || 0) * 3.5;
      let label = String(t.text || "Untitled");
      while (doc.getTextWidth(label) > nameW - indent - 3 && label.length > 4) label = label.slice(0, -2);
      if (label !== String(t.text || "Untitled")) label += "…";
      if (t.url && /^https?:\/\//i.test(t.url)) doc.textWithLink(label, M + indent, yc + 1.1, { url: t.url });
      else doc.text(label, M + indent, yc + 1.1);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); doc.setTextColor(...C.muted);
      const ticket = t.url ? tid(t.url) : null;
      if (ticket) {
        doc.setTextColor(...C.summary);
        doc.textWithLink(ticket, M + nameW + 2, yc + 1.05, { url: t.url });
        doc.setTextColor(...C.muted);
      }
      doc.text(fmtShort(t._s), M + nameW + idW + 2, yc + 1.05);
      if (t.type !== "milestone") doc.text(fmtShort(t._e!), M + nameW + idW + dateW + 2, yc + 1.05);
      if (t.type !== "milestone" && t.hours) {
        doc.text(String(t.hours), M + nameW + idW + dateW * 2 + 2, yc + 1.05);
      }

      /* bar */
      /* `_e` is written for every row that has an `_s`, which the filter proved */
      const x0 = X(t._s.getTime()), x1 = X(t._e!.getTime());
      barGeom.set(t.id, { x0, x1, yc });
      if (t.type === "milestone") {
        const s = 2.1;
        doc.setFillColor(...C.milestone);
        doc.triangle(x0, yc - s, x0 + s, yc, x0, yc + s, "F");
        doc.triangle(x0, yc - s, x0 - s, yc, x0, yc + s, "F");
      } else if (isSummary) {
        /* Merlin-style bracket: bar with down-pointing wings at both ends */
        const w = Math.max(x1 - x0, 2);
        const yTop = yc - 2.1, barH2 = 2.2, wing = Math.min(2.2, w / 3);
        doc.setFillColor(...C.summary);
        doc.rect(x0, yTop, w, barH2, "F");
        doc.triangle(x0, yTop + barH2, x0 + wing, yTop + barH2, x0, yTop + barH2 + 2.2, "F");
        doc.triangle(x1 - wing, yTop + barH2, x1, yTop + barH2, x1, yTop + barH2 + 2.2, "F");
      } else {
        const w = Math.max(x1 - x0, 1.2);
        const tc = TYPE_COLORS[t.type || ""];
        doc.setFillColor(...(tc ? tc.bar : C.accent));
        doc.roundedRect(x0, yc - barH / 2, w, barH, 1, 1, "F");
        const pr = Math.max(0, Math.min(100, t.progress || 0)) / 100;
        if (pr > 0) {
          doc.setFillColor(...(tc ? tc.deep : C.progress));
          doc.roundedRect(x0, yc - barH / 2, Math.max(w * pr, 1), barH, 1, 1, "F");
        }
      }
    });

    /* links between bars on this page */
    (links || []).forEach((l) => {
      const a = barGeom.get(l.source), b = barGeom.get(l.target);
      if (!a || !b) return;
      const fromEnd = !l.type || l.type === "e2s" || l.type === "e2e";
      const toStart = !l.type || l.type === "e2s" || l.type === "s2s" ? true : false;
      const sx = fromEnd ? a.x1 : a.x0;
      const tx = toStart ? b.x0 : b.x1;
      doc.setDrawColor(...C.link); doc.setLineWidth(0.25);
      const midX = sx + 2;
      doc.line(sx, a.yc, midX, a.yc);
      doc.line(midX, a.yc, midX, b.yc);
      doc.line(midX, b.yc, tx - 1.4, b.yc);
      doc.setFillColor(...C.link);
      const dir = tx >= midX ? 1 : -1;
      doc.triangle(tx - 1.4 * dir, b.yc - 0.9, tx - 1.4 * dir, b.yc + 0.9, tx, b.yc, "F");
    });
    barGeom.clear();
  }

  if (!rows.length) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(...C.muted);
    doc.text("No scheduled tasks yet.", M, topY + scaleH + 10);
  }

  return doc; /* caller saves it: doc.save(name) */
}
