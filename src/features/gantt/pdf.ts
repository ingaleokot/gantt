/* jsPDF is loaded on demand — see buildGanttPdf. A static import would put the
   whole library (and its html2canvas/canvg friends) in the editor's route
   chunk, paid on every project open rather than on the one click that needs
   it, so the only thing imported here at module scope is its type. */
import type { jsPDF } from "jspdf";
import type { StoreLink, StoreTask, TaskId } from "../../lib/db";
import { isTierType, releaseSummaryText, releaseTotals, scopeOf } from "./lib/taxonomy";
import type { FilterRow } from "./lib/taxonomy";

const DAY = 24 * 60 * 60 * 1000;
/* jsPDF's colour setters take three channels, so the palette entries are
   fixed-length tuples and can be spread straight into them */
type Rgb = readonly [number, number, number];
type ColorName =
  | "ink" | "muted" | "line" | "zebra" | "weekend" | "accent"
  | "progress" | "summary" | "story" | "milestone" | "link" | "today" | "headerBg"
  | "relMvp" | "relFull";
const C: Record<ColorName, Rgb> = {
  ink: [28, 42, 46],
  muted: [98, 119, 122],
  line: [220, 227, 226],
  zebra: [244, 247, 246],
  weekend: [238, 242, 241],
  accent: [16, 118, 127],
  progress: [10, 82, 89],
  summary: [47, 107, 223],
  /* the story tier's rail, matching --color-story-rail in the light theme */
  story: [109, 91, 208],
  milestone: [192, 124, 30],
  link: [160, 175, 177],
  today: [196, 69, 60],
  headerBg: [241, 245, 244],
  relMvp: [156, 79, 22],
  relFull: [63, 95, 125],
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

/* ── the embedded font ───────────────────────────────────────────────────────
   jsPDF's built-in Helvetica is a standard PDF Type1 face: WinAnsi only, so a
   Cyrillic name came out as one wrong Latin glyph per byte ("Поиск" printed as
   "> 8 A :"). DejaVu Sans is the fix — Latin, Latin Extended, Greek, Cyrillic,
   Armenian, Georgian, Hebrew, Arabic and the punctuation in between, under a
   licence that allows redistribution and embedding (fonts/LICENSE.txt).

   The two faces are ~1.4 MB, so they are Vite *assets*, fetched on the first
   export and kept in a module-scope promise for every export after it. Nothing
   about them reaches the editor chunk. */
const PDF_FONT = "DejaVuSans";
const FALLBACK_FONT = "helvetica";
type FontFaces = { regular: string; bold: string };
let facesPromise: Promise<FontFaces> | null = null;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000; /* fromCharCode is called with one chunk of arguments */
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

async function fetchFace(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("font " + url + " → HTTP " + res.status);
  return toBase64(await res.arrayBuffer());
}

function loadFaces(): Promise<FontFaces> {
  if (!facesPromise) {
    facesPromise = (async () => {
      const [regular, bold] = await Promise.all([
        fetchFace(new URL("./fonts/DejaVuSans.ttf", import.meta.url).href),
        fetchFace(new URL("./fonts/DejaVuSans-Bold.ttf", import.meta.url).href),
      ]);
      return { regular, bold };
    })();
    /* a failed fetch must not poison every later export */
    facesPromise.catch(() => { facesPromise = null; });
  }
  return facesPromise;
}

/* Returns the family to draw with. If the faces cannot be fetched (offline,
   asset missing) the export still happens in Helvetica rather than failing —
   Latin text is fine there, and a PDF with a warning beats no PDF at all. */
async function installFont(doc: jsPDF): Promise<string> {
  try {
    const faces = await loadFaces();
    doc.addFileToVFS("DejaVuSans.ttf", faces.regular);
    doc.addFont("DejaVuSans.ttf", PDF_FONT, "normal");
    doc.addFileToVFS("DejaVuSans-Bold.ttf", faces.bold);
    doc.addFont("DejaVuSans-Bold.ttf", PDF_FONT, "bold");
    return PDF_FONT;
  } catch (e) {
    console.warn("gantt: Unicode PDF font unavailable, falling back to Helvetica", e);
    return FALLBACK_FONT;
  }
}

/* ── cell fitting ────────────────────────────────────────────────────────────
   Every string drawn into the table is clipped to its column. The ID column
   used to draw at a fixed offset with no truncation at all, so PRODUCT-2907
   (19.8 mm at 7.2 pt) ran straight through the 19 mm column and collided with
   START. Measure against the font that is actually set, then ellipsize. */
const ELLIPSIS = "…";
function fitText(doc: jsPDF, text: string, maxW: number): string {
  if (!text || maxW <= 0) return "";
  if (doc.getTextWidth(text) <= maxW) return text;
  /* split into code points so a surrogate pair is never cut in half */
  const chars = Array.from(text);
  const fits = (n: number) => doc.getTextWidth(chars.slice(0, n).join("") + ELLIPSIS) <= maxW;
  let lo = 0, hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  if (lo > 0) return chars.slice(0, lo).join("") + ELLIPSIS;
  return doc.getTextWidth(ELLIPSIS) <= maxW ? ELLIPSIS : "";
}

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

/* one page's worth of chart furniture, computed once and replayed per page:
   none of it depends on which rows are on the page, only on how many. */
type Band = { x0: number; x1: number };
type Tick = { text: string; x: number };
type ScalePlan = {
  weekends: Band[];   /* Saturday+Sunday already coalesced into one band */
  unitLines: number[];/* week/month separators inside the grid */
  ticks: Tick[];      /* bottom scale labels */
  topTicks: Tick[];   /* month (or year) labels in the upper band */
  topLines: number[];
};

export async function buildGanttPdf(name: string, tasks: StoreTask[], links: StoreLink[]): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import("jspdf");
  const doc = new JsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const F = await installFont(doc);
  const PW = 297, PH = 210, M = 12;
  const rows = orderTasks(tasks).map((t): PdfRow => {
    const start = toDate(t.start);
    let end = toDate(t.end);
    if (!end && start) end = new Date(start.getTime() + Math.max(1, t.duration || 1) * DAY);
    if (t.type === "milestone" && start) end = start;
    return { ...t, _s: start, _e: end };
  }).filter((t): t is PlacedRow => !!t._s);

  /* An end date is EXCLUSIVE everywhere in this app: a one-day task starting
     on the 7th ends on the 8th. The screen already subtracts a day before it
     shows one; the PDF did not, so every printed end — and the range in the
     header — read a day late. Milestones are exempt: `_e` was collapsed onto
     `_s` above, and there is no span to close. */
  const lastDay = (t: PlacedRow): Date =>
    t.type === "milestone" || !t._e || t._e.getTime() <= t._s.getTime()
      ? t._s
      : new Date(t._e.getTime() - DAY);

  /* time span. The geometry keeps the exclusive end — that is where the bar
     actually stops — while the printed dates use the inclusive one. */
  let min = Infinity, max = -Infinity, lastPrinted = -Infinity;
  rows.forEach((t) => {
    min = Math.min(min, t._s.getTime());
    max = Math.max(max, (t._e || t._s).getTime());
    lastPrinted = Math.max(lastPrinted, lastDay(t).getTime());
  });
  const firstPrinted = min;
  if (!isFinite(min)) { const today = Date.now(); min = today; max = today + 30 * DAY; }
  min -= 2 * DAY; max += 3 * DAY;
  const spanDays = Math.max(7, Math.round((max - min) / DAY));
  const unit = spanDays <= 62 ? "day" : spanDays <= 260 ? "week" : "month";

  /* geometry */
  /* The hours column is EFFORT, not the length of the bar beside it, so it
     says so. Every width here is measured against the widest thing it has to
     hold at its own font size: ID takes PRODUCT-nnnn (19.8 mm), the date
     columns "31 Aug" (9 mm) under a "START" header (9 mm), EFFORT its own
     13.4 mm header — plus 2 mm of padding on each side. */
  const PAD = 2;
  /* SCOPE holds "MVP" or "FULL" under a 12.5 mm header, so 16 mm with padding */
  const nameW = 50, idW = 25, scopeW = 16, dateW = 17, hrsW = 18;
  const tableW = nameW + idW + scopeW + dateW * 2 + hrsW;
  const colX = {
    name: M,
    id: M + nameW,
    scope: M + nameW + idW,
    start: M + nameW + idW + scopeW,
    end: M + nameW + idW + scopeW + dateW,
    hrs: M + nameW + idW + scopeW + dateW * 2,
  };
  /* Release lives on epics and stories only, so a task prints the scope of the
     nearest tier above it — the same roll-up the app's own totals use. The map
     is built from every task, not just the ones with dates, or a parent that
     never got scheduled would break the chain. */
  const byId = new Map<string, FilterRow>();
  tasks.forEach((t) => byId.set(String(t.id), t));
  const scopeLookup = (id: string | number): FilterRow | null => byId.get(String(id)) || null;
  const tid = (url: string | undefined) => { const m = /([A-Za-z][A-Za-z0-9_]*-\d+)\/?(?:[?#].*)?$/.exec(url || ""); return m ? m[1].toUpperCase() : null; };
  /* every task, not just the dated ones the chart draws: the totals are the
     project's, exactly as the header's are */
  const relTotals = releaseTotals(tasks, (t) => Number(t.hours) || 0);
  const releaseLine = relTotals.fullRelease || relTotals.unscoped ? releaseSummaryText(relTotals) : "";
  const chartX = M + tableW, chartW = PW - M - chartX;
  const pxDay = chartW / spanDays;
  const topY = 30, scaleH = 13, rowH = 7.4, barH = 4.2;
  const rowsPerPage = Math.floor((PH - M - topY - scaleH) / rowH);
  const X = (t: number) => chartX + ((t - min) / DAY) * pxDay;

  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));

  const drawHeader = (page: number) => {
    /* the legend is measured first: it is right-aligned, and the meta line
       below the title has to stop before it rather than run underneath */
    const used = Object.keys(TYPE_COLORS).filter((k) => rows.some((t) => t.type === k));
    let legendLeft = PW - M;
    if (used.length) {
      doc.setFont(F, "normal"); doc.setFontSize(7.5);
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
      legendLeft = lx + 5.5;
    }

    doc.setFont(F, "bold"); doc.setFontSize(15); doc.setTextColor(...C.ink);
    doc.text(fitText(doc, name || "Project timeline", PW - 2 * M), M, 17);
    doc.setFont(F, "normal"); doc.setFontSize(8.5); doc.setTextColor(...C.muted);
    /* the same two dates the app header shows: first start, last inclusive end */
    const from = isFinite(firstPrinted) ? new Date(firstPrinted) : new Date(min + 2 * DAY);
    const to = isFinite(lastPrinted) ? new Date(lastPrinted) : new Date(max - 3 * DAY);
    const meta = fmtFull(from) + "  –  " + fmtFull(to)
      + "     ·     exported " + fmtFull(new Date())
      + (pageCount > 1 ? "     ·     page " + page + " of " + pageCount : "");
    doc.text(fitText(doc, meta, legendLeft - 4 - M), M, 22.5);

    /* The same release line the editor header and the projects cards show,
       word for word, out of releaseSummaryText — "MVP 56h · Full 98h incl.
       MVP". The SCOPE column below prints which release each row is in; this
       says what each one costs, and the "incl. MVP" is what stops the two
       numbers reading as disjoint buckets that fail to add up. */
    if (releaseLine) {
      doc.setFontSize(7.5); doc.setTextColor(...C.muted);
      doc.text(fitText(doc, releaseLine, PW - 2 * M), M, 27);
    }
  };

  /* The chart furniture is the same on every page, so the date walk that
     produces it runs once instead of once per page. Weekend shading also
     coalesces: Saturday and Sunday are adjacent bands of one colour, so they
     go down as a single rect — half the fills, identical ink. */
  const planScale = (): ScalePlan => {
    const weekends: Band[] = [];
    const unitLines: number[] = [];
    const ticks: Tick[] = [];
    /* scale labels are centred in their band, and a band clipped by the edge of
       the chart is narrower than its label: without this the first week label
       hung 0.4 mm over the chart's left rule and into the EFFORT column */
    const centred = (list: Tick[], text: string, x: number) => {
      const w = doc.getTextWidth(text) / 2;
      if (x - w >= chartX && x + w <= PW - M) list.push({ text, x });
    };
    doc.setFont(F, "normal"); doc.setFontSize(6.6);
    const cursor0 = new Date(min);
    cursor0.setHours(0, 0, 0, 0);
    const labelEvery = unit === "day" ? (pxDay >= 3.2 ? 1 : pxDay >= 1.7 ? 2 : 7) : 1;
    let cursor = cursor0;
    let i = 0;
    while (cursor.getTime() < max) {
      const t0 = cursor.getTime();
      let next: Date;
      if (unit === "day") next = new Date(t0 + DAY);
      else if (unit === "week") next = new Date(t0 + 7 * DAY);
      else next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      const x0 = Math.max(chartX, X(t0)), x1 = Math.min(PW - M, X(next.getTime()));
      if (x1 > x0) {
        if (unit === "day") {
          const dow = cursor.getDay();
          if (dow === 0 || dow === 6) {
            const prev = weekends[weekends.length - 1];
            if (prev && Math.abs(prev.x1 - x0) < 0.001) prev.x1 = x1; /* Sat + Sun */
            else weekends.push({ x0, x1 });
          }
          if (i % labelEvery === 0 && x1 - x0 >= 1.6) centred(ticks, String(cursor.getDate()), (x0 + x1) / 2);
        } else if (unit === "week") {
          if (x1 - x0 >= 7) centred(ticks, fmtShort(cursor), (x0 + x1) / 2);
          unitLines.push(x0);
        } else {
          if (x1 - x0 >= 8) centred(ticks, MONTHS[cursor.getMonth()], (x0 + x1) / 2);
          unitLines.push(x0);
        }
      }
      cursor = next; i++;
    }

    const topTicks: Tick[] = [];
    const topLines: number[] = [];
    doc.setFont(F, "bold"); doc.setFontSize(7);
    let mCur = unit === "month" ? new Date(new Date(min).getFullYear(), 0, 1) : new Date(new Date(min).getFullYear(), new Date(min).getMonth(), 1);
    while (mCur.getTime() < max) {
      const mNext = unit === "month" ? new Date(mCur.getFullYear() + 1, 0, 1) : new Date(mCur.getFullYear(), mCur.getMonth() + 1, 1);
      const x0 = Math.max(chartX, X(mCur.getTime())), x1 = Math.min(PW - M, X(mNext.getTime()));
      if (x1 - x0 >= 12) {
        const label = unit === "month" ? String(mCur.getFullYear()) : MONTHS[mCur.getMonth()] + " " + mCur.getFullYear();
        centred(topTicks, label, (x0 + x1) / 2);
      }
      topLines.push(x0);
      mCur = mNext;
    }
    return { weekends, unitLines, ticks, topTicks, topLines };
  };
  const plan = planScale();

  const drawScale = (nRows: number) => {
    const gridBottom = topY + scaleH + nRows * rowH;
    const gridH = nRows * rowH;
    /* header band */
    doc.setFillColor(...C.headerBg);
    doc.rect(M, topY, PW - 2 * M, scaleH, "F");

    /* table headers, each clipped to its own column like every other cell */
    doc.setFont(F, "bold"); doc.setFontSize(7); doc.setTextColor(...C.muted);
    doc.text(fitText(doc, "TASK", nameW - PAD * 2), colX.name + PAD, topY + 8.6);
    doc.text(fitText(doc, "ID", idW - PAD * 2), colX.id + PAD, topY + 8.6);
    doc.text(fitText(doc, "SCOPE", scopeW - PAD * 2), colX.scope + PAD, topY + 8.6);
    doc.text(fitText(doc, "START", dateW - PAD * 2), colX.start + PAD, topY + 8.6);
    doc.text(fitText(doc, "END", dateW - PAD * 2), colX.end + PAD, topY + 8.6);
    doc.text(fitText(doc, "EFFORT h", hrsW - PAD * 2), colX.hrs + PAD, topY + 8.6);

    /* weekend shading, then the bottom scale labels */
    doc.setFillColor(...C.weekend);
    for (const b of plan.weekends) doc.rect(b.x0, topY + scaleH, b.x1 - b.x0, gridH, "F");

    doc.setFont(F, "normal"); doc.setFontSize(6.6); doc.setTextColor(...C.muted);
    for (const t of plan.ticks) doc.text(t.text, t.x, topY + scaleH - 2.2, { align: "center" });

    doc.setDrawColor(...C.line); doc.setLineWidth(0.15);
    for (const x of plan.unitLines) doc.line(x, topY + scaleH, x, gridBottom);

    /* top scale: months (day/week units) or years (month unit) */
    doc.setFont(F, "bold"); doc.setFontSize(7); doc.setTextColor(...C.ink);
    const half = topY + scaleH / 2;
    for (const t of plan.topTicks) doc.text(t.text, t.x, half - 1.2, { align: "center" });
    doc.setDrawColor(...C.line); doc.setLineWidth(0.2);
    const topLineBottom = unit === "day" ? gridBottom : topY + scaleH;
    for (const x of plan.topLines) doc.line(x, topY, x, topLineBottom);

    /* frame lines */
    doc.setDrawColor(...C.line); doc.setLineWidth(0.25);
    doc.line(M, topY, PW - M, topY);
    doc.line(M, topY + scaleH, PW - M, topY + scaleH);
    doc.line(colX.id, topY, colX.id, gridBottom);
    doc.line(colX.scope, topY, colX.scope, gridBottom);
    doc.line(colX.start, topY, colX.start, gridBottom);
    doc.line(colX.end, topY, colX.end, gridBottom);
    doc.line(colX.hrs, topY, colX.hrs, gridBottom);
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
      /* a story is a container like an epic — bold row, bracket bar — and only
         its colour and its SCOPE cell tell them apart */
      const isSummary = isTierType(t.type);
      const isStory = t.type === "story";
      doc.setFont(F, isSummary ? "bold" : "normal");
      doc.setFontSize(8); doc.setTextColor(...C.ink);
      const indent = PAD + (t.$level || 0) * 3.5;
      const label = fitText(doc, String(t.text || "Untitled"), nameW - indent - PAD);
      if (t.url && /^https?:\/\//i.test(t.url)) doc.textWithLink(label, colX.name + indent, yc + 1.1, { url: t.url });
      else doc.text(label, colX.name + indent, yc + 1.1);
      doc.setFont(F, "normal"); doc.setFontSize(7.2); doc.setTextColor(...C.muted);
      const ticket = t.url ? tid(t.url) : null;
      if (ticket) {
        doc.setTextColor(...C.summary);
        /* clipped like everything else: PRODUCT-2907 used to run into START */
        doc.textWithLink(fitText(doc, ticket, idW - PAD * 2), colX.id + PAD, yc + 1.05, { url: t.url });
        doc.setTextColor(...C.muted);
      }
      /* SCOPE: bold and coloured on the tier that OWNS the release, muted on
         the rows that merely inherit it */
      const owned = isTierType(t.type) && (t.release === "mvp" || t.release === "full");
      const scope = scopeOf(t, scopeLookup);
      if (scope === "mvp" || scope === "full") {
        const label = scope === "mvp" ? "MVP" : "FULL";
        doc.setFont(F, owned ? "bold" : "normal");
        doc.setTextColor(...(scope === "mvp" ? C.relMvp : C.relFull));
        doc.text(fitText(doc, label, scopeW - PAD * 2), colX.scope + PAD, yc + 1.05);
        doc.setFont(F, "normal");
        doc.setTextColor(...C.muted);
      }
      doc.text(fitText(doc, fmtShort(t._s), dateW - PAD * 2), colX.start + PAD, yc + 1.05);
      if (t.type !== "milestone") doc.text(fitText(doc, fmtShort(lastDay(t)), dateW - PAD * 2), colX.end + PAD, yc + 1.05);
      if (t.type !== "milestone" && t.hours) {
        doc.text(fitText(doc, String(t.hours), hrsW - PAD * 2), colX.hrs + PAD, yc + 1.05);
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
        doc.setFillColor(...(isStory ? C.story : C.summary));
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
    doc.setFont(F, "normal"); doc.setFontSize(10); doc.setTextColor(...C.muted);
    doc.text("No scheduled tasks yet.", M, topY + scaleH + 10);
  }

  return doc; /* caller saves it: doc.save(name) */
}
