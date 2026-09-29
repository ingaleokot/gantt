/* ---------------------------------------------------------------------------
   The testing buffer — a TAIL drawn on each task's bar, and the one calendar
   the whole app schedules against.

   Testing used to be ROWS: for every story and every epic the app maintained a
   real `tasks` row (`type = 'testing'`, `auto_test = true`, titled
   `TEST: <parent>`), scheduled through a queue. That is gone. A plan that
   doubles in length the moment you switch the feature on is a plan nobody can
   read, and the generated rows fought every hand edit — hence the lock flag,
   the "Reset to auto" button, the burst guard and the `delete-task` bypass,
   all of which went with them.

   What replaced it is arithmetic and a drawn overlay: every LEAF development
   task gets a testing tail immediately after its own bar, sized from the
   project's buffer percentage. Nothing is stored, so nothing can drift, and
   turning the drawing off changes no data at all.

   `projects.test_buffer_pct` is still read and written — it is the per-task
   percentage now. `tasks.auto_test`, `tasks.auto_test_locked` and
   `projects.test_queue_mode` are dead columns that nothing in `src/` writes
   any more, left in the schema exactly as `projects.view` is.

   ---- why this module is pure ------------------------------------------------
   Everything here takes plain serializable values and returns plain values: no
   widget api, no React, no Supabase and no DOM. The editor's tagger converts
   the numbers to pixels; the header converts the dates to text.

   Nothing here may import from src/lib/ — this sits under features/gantt/lib/,
   which the public ShareViewer imports from. `HOURS_PER_DAY` comes from
   features/projects/summary.ts, whose only runtime import is the taxonomy.

   ---- the calendar ------------------------------------------------------------
   These five helpers used to live in Editor.tsx and, byte for byte, again in
   ShareViewer.tsx. The tail needs exactly the same working-time model — 7 h is
   one working day, weekends are skipped, and **`end` is EXCLUSIVE** (it is the
   day AFTER the last working day) — and a second copy of a calendar is the one
   class of bug this codebase keeps paying for. Editor.tsx imports them back
   from here.
--------------------------------------------------------------------------- */

import { HOURS_PER_DAY } from "../../projects/summary";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const isWeekend = (d: Date): boolean => d.getDay() === 0 || d.getDay() === 6;

/* the first working day on or after `d`, normalised to local midnight */
export function rollForward(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (isWeekend(x)) x.setDate(x.getDate() + 1);
  return x;
}

/* end date (EXCLUSIVE) after consuming n working days from a working start */
export function addWorkDays(start: Date, n: number): Date {
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

export function workDaysBetween(s: Date, e: Date): number {
  let c = 0;
  const x = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  while (x < e) {
    if (!isWeekend(x)) c++;
    x.setDate(x.getDate() + 1);
  }
  return Math.max(1, c);
}

/* the corrected {hours, days, start, end, duration} for one plain bar */
export function scheduleFromHours(hours: number | undefined, startLike: Date | undefined) {
  const start = rollForward(startLike instanceof Date ? startLike : new Date());
  const h = Math.max(0.5, Math.round((Number(hours) || HOURS_PER_DAY) * 2) / 2);
  const end = addWorkDays(start, Math.ceil(h / HOURS_PER_DAY));
  const days = Math.round((h / HOURS_PER_DAY) * 10) / 10;
  return { hours: h, days, start, end, duration: Math.round((+end - +start) / MS_PER_DAY) };
}

/* ---------- ISO day strings, which is the wire format on both sides --------
   `tasks.start_date` / `tasks.end_date` are day strings in Postgres and in the
   draft; Dates only exist inside the widget. Everything below takes and
   returns strings so its input and its output stay plain JSON. */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
export function parseDay(v: string | null | undefined): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v.slice(0, 10) + "T00:00:00");
  return isNaN(+d) ? null : d;
}

/* ---------- the sizing rule, in ONE place ---------------------------------- */

export const DEFAULT_TEST_BUFFER_PCT = 20;
/* Below this a testing tail is not worth drawing as a plan: half a working day
   is the smallest unit of testing anyone schedules. */
export const MIN_TESTING_HOURS = 3.5;

export const ceilToHalf = (n: number): number => Math.ceil(n * 2) / 2;

/* 0–100, and anything that is not a number at all falls back to the default
   rather than poisoning every tail in the project with NaN */
export function clampPct(v: unknown): number {
  const n = Number(v);
  if (!isFinite(n)) return DEFAULT_TEST_BUFFER_PCT;
  return Math.min(100, Math.max(0, n));
}

/* THE sizing rule. `devHours` is one leaf task's own estimate; a task with no
   estimate gets no tail at all, which is decided by the callers below before
   this is reached (the floor would otherwise hand every zero-hour row 3.5 h). */
export function testingHours(devHours: number, pct: number): number {
  return Math.max(MIN_TESTING_HOURS, ceilToHalf((Number(devHours) || 0) * clampPct(pct) / 100));
}

/* the same figure as whole working days, which is what a tail is drawn in.
   Zero when the project's buffer is 0%: the 3.5 h floor above is what stops a
   real buffer from rounding down to nothing, and it must not turn "we are not
   budgeting for testing" into a day on every task in the plan. */
export function testingDays(devHours: number, pct: number): number {
  if (clampPct(pct) <= 0) return 0;
  return Math.ceil(testingHours(devHours, pct) / HOURS_PER_DAY);
}

/* ---------- what counts as development ------------------------------------
   A LEAF task of one of these four types. Not `testing` (a test the user wrote
   by hand already IS the testing), not `milestone` (a moment, not work), and
   not a tier — an epic's or a story's bar already spans its children, whose
   tails are drawn one by one underneath it. */
export const DEV_TYPES: string[] = ["backend", "frontend", "design", "task"];
/* the two container tiers; `story` is stored, `summary` is the epic */
const TIER_TYPES: string[] = ["story", "summary"];

/* ---------- where one task's testing finishes ------------------------------
   `end` is EXCLUSIVE everywhere in this app: a task that finishes on Friday
   stores `end = Saturday`, so the exclusive end IS already the first day on
   which the work is done and its testing can start. Rolling it forward over a
   weekend is the whole correction — adding a day on top of it would insert a
   phantom idle day between the last commit and the first test, every time.

   Returns an EXCLUSIVE end again, so it is directly comparable with `end`, or
   null when this row gets no testing at all (a 0% buffer). */
export function testingEndOf(end: Date, devHours: number, pct: number): Date | null {
  const days = testingDays(devHours, pct);
  if (days <= 0) return null;
  return addWorkDays(rollForward(end), days);
}

/* ---------- when the project is done, with and without testing -------------
   Exactly the rows the editor's own `computeStats` measures the span from:
   tiers are skipped (their dates are their children's, so counting them would
   only repeat what those children already contributed) and everything else
   answers for itself.

   **No queueing is implied.** Each task's buffer runs alongside that task, so
   `tested` is "when the last piece of work, including its own testing, is
   done" — NOT "when one tester has finished testing everything". There is no
   tester calendar here and deliberately so: the queue the generated rows used
   to maintain is what made the feature unreadable, and a single shared tester
   is an assumption this app has no way to check.

   Both values are EXCLUSIVE ISO day strings, like every stored `end`. */
export interface ProjectEndRow {
  id: string | number;
  parent?: string | number | null;
  /* the STORED type: "story" and "summary" are the two tiers */
  type?: string | null;
  hours?: number | null;
  start?: string | null;
  end?: string | null;
}
export interface ProjectEnds {
  /* the latest end across the project's non-tier rows */
  plain: string | null;
  /* the latest of end + that row's own testing, over the same rows */
  tested: string | null;
}

const rowKey = (id: string | number | null | undefined): string =>
  id === null || id === undefined ? "" : String(id);

export function projectEndDates(rows: ProjectEndRow[], pct: number): ProjectEnds {
  const list = (rows || []).filter((t) => t && t.id !== undefined && t.id !== null);
  /* a row that has children is a container whatever its stored type says —
     `rollupEpics` retypes it to `summary` on the next pass, and until then it
     must not be given a tail of its own either */
  const parents = new Set<string>();
  list.forEach((t) => { if (t.parent !== undefined && t.parent !== null) parents.add(rowKey(t.parent)); });

  let plain: string | null = null;
  let tested: string | null = null;
  list.forEach((t) => {
    const ty = t.type || "task";
    if (TIER_TYPES.includes(ty)) return;
    const endStr = t.end || t.start;
    if (!endStr) return;
    if (!plain || endStr > plain) plain = endStr;

    let mine = endStr;
    const hours = Number(t.hours) || 0;
    if (DEV_TYPES.includes(ty) && !parents.has(rowKey(t.id)) && hours > 0) {
      const e = parseDay(endStr);
      const tail = e ? testingEndOf(e, hours, pct) : null;
      if (tail) mine = isoDay(tail);
    }
    if (!tested || mine > tested) tested = mine;
  });
  return { plain, tested };
}

/* ---------- "Show test estimates": a per-window display preference ---------
   The same argument features/gantt/lib/columns.ts makes for the column choice.
   Whether the tails are drawn is a statement about THIS window on THIS machine
   — not about the plan — so it is neither a search param (every copied link
   would carry it) nor a database column (nothing about it belongs to the
   project). localStorage, validated, and every read and write swallowed:
   Safari private mode throws outright, and a viewing preference is never worth
   taking the screen down for.

   It governs the DRAWING only. The project's "with testing" end date is
   arithmetic over the stored estimates and is shown either way — the switch
   decides what is on the chart, not what the numbers mean.

   Guarded on `window` as well as try/caught, so the module stays importable
   from a plain script — which is the whole point of keeping it pure. */
export const SHOW_TESTING_KEY = "gantt.testing.show";

export function readShowTesting(key: string = SHOW_TESTING_KEY): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(key);
    /* nothing stored means shown — the tails are the feature, and a user who
       has never turned them off must not have to find the switch first */
    return raw === null ? true : raw !== "0";
  } catch (e) { return true; }
}

export function writeShowTesting(show: boolean, key: string = SHOW_TESTING_KEY): void {
  if (typeof window === "undefined") return;
  try {
    if (show) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, "0");
  } catch (e) { /* see above: a preference is not worth an exception */ }
}
