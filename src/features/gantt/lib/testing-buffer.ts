/* ---------------------------------------------------------------------------
   The testing buffer — the generated `TEST:` bars, and the one calendar the
   whole app schedules against.

   Every project carries a testing buffer percentage (`projects.test_buffer_pct`,
   default 20) and a queue mode (`projects.test_queue_mode`, 'queued' | 'parallel').
   For each STORY and each EPIC that has development work DIRECTLY under it, the
   app maintains a real row in `tasks` — `type = 'testing'`, `auto_test = true` —
   sized from that percentage and scheduled after the development it tests.

   ---- why this module is pure ------------------------------------------------
   `planTestingBars` takes plain serializable rows and returns plain serializable
   rows. It touches no widget api, no React, no Supabase and no DOM, so the same
   function that keeps the editor in step can be run from a script over rows read
   straight out of Postgres and produce byte-identical output. Everything that
   knows about the live widget stays in Editor.tsx.

   Nothing here may import from src/lib/ — this sits under features/gantt/lib/,
   which the public ShareViewer imports from. `HOURS_PER_DAY` comes from
   features/projects/summary.ts, whose only runtime import is the taxonomy.

   ---- the calendar ------------------------------------------------------------
   These five helpers used to live in Editor.tsx and, byte for byte, again in
   ShareViewer.tsx. The testing buffer needs exactly the same working-time model —
   7 h is one working day, weekends are skipped, and **`end` is EXCLUSIVE** (it is
   the day AFTER the last working day) — and a second copy of a calendar is the
   one class of bug this codebase keeps paying for. Editor.tsx imports them back
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
   draft; Dates only exist inside the widget. The planner takes and returns
   strings so its input and its output are plain JSON. */
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
/* Below this a testing bar is not worth drawing as a plan: half a working day
   is the smallest unit of testing anyone schedules. */
export const MIN_TESTING_HOURS = 3.5;

export const ceilToHalf = (n: number): number => Math.ceil(n * 2) / 2;

/* 0–100, and anything that is not a number at all falls back to the default
   rather than poisoning every bar in the project with NaN */
export function clampPct(v: unknown): number {
  const n = Number(v);
  if (!isFinite(n)) return DEFAULT_TEST_BUFFER_PCT;
  return Math.min(100, Math.max(0, n));
}

/* THE sizing rule. `devHours` is the sum of the DIRECT development children's
   estimates; a parent whose development totals 0 gets no bar at all, which is
   decided by the caller before this is reached. */
export function testingHours(devHours: number, pct: number): number {
  return Math.max(MIN_TESTING_HOURS, ceilToHalf((Number(devHours) || 0) * clampPct(pct) / 100));
}

/* ---------- what counts as development ------------------------------------
   A LEAF child of one of these four types. Not `testing` (that is the buffer
   itself, or a test the user wrote by hand), not `milestone` (a moment, not
   work), and not a tier — an epic whose direct children are all stories gets no
   bar of its own, because each of those stories gets one. */
export const DEV_TYPES: string[] = ["backend", "frontend", "design", "task"];
/* the two container tiers; `story` is stored, `summary` is the epic */
const TIER_TYPES: string[] = ["story", "summary"];

export type TestQueueMode = "queued" | "parallel";
export const asQueueMode = (v: unknown): TestQueueMode => (v === "parallel" ? "parallel" : "queued");

/* one line each, printed in the Testing popover so the choice is not made from
   a bare word */
export const QUEUE_MODES: { id: TestQueueMode; label: string; hint: string }[] = [
  { id: "queued", label: "Queued", hint: "One tester at a time — the bars never overlap each other." },
  { id: "parallel", label: "Parallel", hint: "Every bar starts as soon as its own development ends." },
];

/* ---------- the shapes the planner speaks ---------------------------------- */

/* Exactly the fields the algorithm reads, and nothing else — so a script can
   hand it rows built from `select id, parent_id, type, text, hours, start_date,
   end_date, assignees, auto_test, auto_test_locked from tasks order by
   sort_order, id` without inventing anything. */
export interface BufferTask {
  id: string | number;
  parent?: string | number | null;
  /* the STORED type: "story" and "summary" are the two tiers, never the
     widget's "summary"-for-both coercion */
  type?: string | null;
  text?: string | null;
  hours?: number | null;
  /* ISO day strings; `end` is EXCLUSIVE */
  start?: string | null;
  end?: string | null;
  assignees?: string | null;
  autoTest?: boolean | null;
  autoTestLocked?: boolean | null;
}

export interface TestingPlanOptions {
  /* projects.test_buffer_pct */
  pct: number;
  /* projects.test_queue_mode */
  mode: TestQueueMode;
  /* the id of the person whose role is `tester`, or null. A roster with no
     tester still gets its bars — the buffer is real work whoever does it — they
     are simply created unassigned. */
  testerId?: string | null;
  /* the day a bar falls back to when its development carries no dates at all.
     An ISO day string; defaults to today. Passing it is what makes the function
     reproducible from a script. */
  today?: string | null;
}

export interface PlannedTestingBar {
  /* set when this updates the auto bar already under that parent; absent when
     the bar has to be created */
  id?: string | number;
  parent: string | number;
  text: string;
  type: "testing";
  hours: number;
  days: number;
  /* ISO day strings; `end` is EXCLUSIVE, exactly as every other row stores it */
  start: string;
  end: string;
  duration: number;
  assignees: string | null;
  autoTest: true;
  autoTestLocked: false;
}

export interface TestingPlan {
  /* the desired set: create the ones with no `id`, update the ones that have
     one — and write NOTHING for a bar that already matches. The caller diffs. */
  bars: PlannedTestingBar[];
  /* unlocked auto bars that should no longer exist: their parent lost its
     development, or they were never under a tier at all */
  removeIds: (string | number)[];
  /* auto bars the user has pinned. They are never moved and never removed; in
     `queued` mode they still occupy the tester's calendar, so an auto bar is
     scheduled AROUND them rather than straight through them. */
  lockedIds: (string | number)[];
}

const key = (id: string | number | null | undefined): string =>
  id === null || id === undefined ? "" : String(id);
const isRoot = (p: string | number | null | undefined): boolean =>
  p === null || p === undefined || p === 0 || p === "0" || p === "";

/* `tasks.assignees` is a comma-separated list; the queue is keyed by WHOSE
   calendar a bar sits on, so two testers would each get their own queue. "" is
   the unassigned queue, which is a real queue: two unassigned bars still cannot
   be done by the same nobody at the same time. */
const queueKeyOf = (assignees: string | null): string => {
  const first = String(assignees || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean)[0];
  return first || "";
};

/* when a row carries no end, one working day from its start; `end` is exclusive
   on both sides of that, so the value means the same thing either way */
function finishOf(t: BufferTask): Date | null {
  const e = parseDay(t.end);
  if (e) return e;
  const s = parseDay(t.start);
  return s ? addWorkDays(rollForward(s), 1) : null;
}

interface Candidate {
  parent: string | number;
  parentOrder: number;
  existing: BufferTask | null;
  text: string;
  hours: number;
  devFinish: Date;
  assignees: string | null;
}
interface Block { start: Date; end: Date }

/* ---------- THE algorithm --------------------------------------------------
   Pure: same rows in, same rows out, whatever order the caller's objects happen
   to iterate in. Row order is taken from the INPUT ARRAY (the widget serializes
   in tree order; Postgres is read `order by sort_order, id`), never from a Map's
   insertion order or an object's keys. */
export function planTestingBars(tasks: BufferTask[], opts: TestingPlanOptions): TestingPlan {
  const pct = clampPct(opts.pct);
  const mode = asQueueMode(opts.mode);
  const testerId = opts.testerId || null;
  const fallbackFinish = rollForward(parseDay(opts.today) || new Date());

  const rows = (tasks || []).filter((t) => t && t.id !== undefined && t.id !== null);
  const order = new Map<string, number>();
  rows.forEach((t, i) => { if (!order.has(key(t.id))) order.set(key(t.id), i); });

  const kids = new Map<string, BufferTask[]>();
  rows.forEach((t) => {
    if (isRoot(t.parent)) return;
    const p = key(t.parent);
    const list = kids.get(p);
    if (list) list.push(t); else kids.set(p, [t]);
  });
  const childrenOf = (id: string | number): BufferTask[] => kids.get(key(id)) || [];
  const hasKids = (id: string | number): boolean => childrenOf(id).length > 0;

  const isAuto = (t: BufferTask): boolean => t.autoTest === true;
  const isLocked = (t: BufferTask): boolean => t.autoTestLocked === true;
  /* a LEAF of a development type — see DEV_TYPES */
  const isDevLeaf = (t: BufferTask): boolean =>
    !isAuto(t) && DEV_TYPES.includes(t.type || "task") && !hasKids(t.id);

  const candidates: Candidate[] = [];
  const removeIds: (string | number)[] = [];
  const lockedIds: (string | number)[] = [];
  const blocks = new Map<string, Block[]>();
  /* every auto bar this pass has already accounted for; whatever is left over
     at the end is an orphan */
  const handled = new Set<string>();

  const block = (t: BufferTask) => {
    const s = parseDay(t.start);
    const e = parseDay(t.end);
    if (!s || !e || e <= s) return;
    const qk = queueKeyOf(t.assignees || null);
    const list = blocks.get(qk);
    if (list) list.push({ start: s, end: e }); else blocks.set(qk, [{ start: s, end: e }]);
  };

  rows.forEach((p) => {
    if (!TIER_TYPES.includes(p.type || "")) return;
    const children = childrenOf(p.id);
    const autoBars = children.filter(isAuto);
    autoBars.forEach((b) => handled.add(key(b.id)));

    const dev = children.filter(isDevLeaf);
    const devHours = dev.reduce((s, c) => s + (Number(c.hours) || 0), 0);

    /* no development directly under this tier — an epic made only of stories,
       or a tier that has just been emptied. The bar goes, unless the user
       pinned it. */
    if (!dev.length || devHours <= 0) {
      autoBars.forEach((b) => {
        if (isLocked(b)) { lockedIds.push(b.id); block(b); }
        else removeIds.push(b.id);
      });
      return;
    }

    /* one bar per tier: the first auto bar under it is THE bar, and any
       further one is a duplicate left behind by an old run */
    const keep = autoBars.length ? autoBars[0] : null;
    autoBars.slice(1).forEach((b) => {
      if (isLocked(b)) { lockedIds.push(b.id); block(b); }
      else removeIds.push(b.id);
    });

    if (keep && isLocked(keep)) {
      /* pinned by hand: it keeps its dates, its hours and its parent's
         roll-up contribution, and it still takes up the tester's calendar */
      lockedIds.push(keep.id);
      block(keep);
      return;
    }

    let devFinish: Date | null = null;
    dev.forEach((c) => {
      const f = finishOf(c);
      if (f && (!devFinish || f > devFinish)) devFinish = f;
    });

    candidates.push({
      parent: p.id,
      parentOrder: order.get(key(p.id)) ?? 0,
      existing: keep,
      text: "TEST: " + (p.text || "Untitled"),
      hours: testingHours(devHours, pct),
      devFinish: devFinish || fallbackFinish,
      /* a bar the user reassigned by hand keeps that assignment; one that has
         nobody on it picks the tester up the moment the roster gains one */
      assignees: (keep && keep.assignees) ? keep.assignees : testerId,
    });
  });

  /* auto bars that are not under a tier any more (dragged out, or their parent
     was retyped): the same rule, and the lock still protects them */
  rows.forEach((t) => {
    if (!isAuto(t) || handled.has(key(t.id))) return;
    handled.add(key(t.id));
    if (isLocked(t)) { lockedIds.push(t.id); block(t); }
    else removeIds.push(t.id);
  });

  /* ---- scheduling -------------------------------------------------------
     Earliest development finish first, so the queue is built in the order the
     work actually becomes testable. The two tie-breaks are what make the
     result independent of iteration order: the parent's own row position, then
     its id as a string. */
  candidates.sort((a, b) =>
    (+a.devFinish - +b.devFinish)
    || (a.parentOrder - b.parentOrder)
    || (key(a.parent) < key(b.parent) ? -1 : key(a.parent) > key(b.parent) ? 1 : 0));

  const freeFrom = new Map<string, Date>();
  const bars: PlannedTestingBar[] = [];

  candidates.forEach((c) => {
    const span = Math.ceil(c.hours / HOURS_PER_DAY);
    const qk = queueKeyOf(c.assignees);

    /* THE start rule, and the +1 nobody should add.
       `end` is EXCLUSIVE everywhere in this app: a task that finishes on Friday
       stores `end = Saturday`, so the exclusive end IS already the first day on
       which no sibling development remains. Rolling it forward over a weekend
       is the whole correction — adding a day on top of it would insert a
       phantom idle day between the last commit and the first test, every time. */
    let from = c.devFinish;
    if (mode === "queued") {
      const busy = freeFrom.get(qk);
      if (busy && busy > from) from = busy;
    }
    let start = rollForward(from);
    let end = addWorkDays(start, span);

    if (mode === "queued") {
      /* A locked bar is never moved, so the auto bars move around it. Without
         this a queued bar would be scheduled straight through a bar the user
         pinned, which is exactly what `queued` promises will not happen. */
      const pinned = (blocks.get(qk) || []).slice().sort((a, b) => +a.start - +b.start);
      for (let i = 0; i <= pinned.length; i++) {
        const hit = pinned.find((b) => start < b.end && b.start < end);
        if (!hit) break;
        start = rollForward(hit.end);
        end = addWorkDays(start, span);
      }
      freeFrom.set(qk, end);
    }

    const bar: PlannedTestingBar = {
      parent: c.parent,
      text: c.text,
      type: "testing",
      hours: c.hours,
      days: Math.round((c.hours / HOURS_PER_DAY) * 10) / 10,
      start: isoDay(start),
      end: isoDay(end),
      duration: Math.round((+end - +start) / MS_PER_DAY),
      assignees: c.assignees || null,
      autoTest: true,
      autoTestLocked: false,
    };
    if (c.existing) bar.id = c.existing.id;
    bars.push(bar);
  });

  return { bars, removeIds, lockedIds };
}

/* ---------- "Show testing": a per-window display preference ----------------
   The same argument features/gantt/lib/columns.ts makes for the column choice.
   Whether the generated bars are on screen is a statement about THIS window on
   THIS machine — not about the plan — so it is neither a search param (every
   copied link would carry it) nor a database column (nothing about it belongs
   to the project). localStorage, validated, and every read and write swallowed:
   Safari private mode throws outright, and a viewing preference is never worth
   taking the screen down for.

   Guarded on `window` as well as try/caught, so the module stays importable
   from a plain script — which is the whole point of keeping it pure. */
export const SHOW_TESTING_KEY = "gantt.testing.show";

export function readShowTesting(key: string = SHOW_TESTING_KEY): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(key);
    /* nothing stored means shown — a generated bar the user has never hidden
       must not be missing from the timeline it was generated into */
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
