import type { StoreProject, StoreTask } from "../../lib/db";

/* What one project adds up to, computed from the draft rather than from a
   mounted widget — the projects list has no gantt to ask.

   `type` imports only, so nothing here reaches lib/supabase at runtime.

   The arithmetic is deliberately the same as the editor's own header totals
   (features/gantt/Editor.tsx, computeStats), which reads the live widget:
     · epics (`summary`) are counted, but contribute no effort of their own —
       their hours are the roll-up of the tasks underneath them, so adding both
       would double-count;
     · milestones are moments, not work: neither a task nor effort;
     · the span ignores epic rows for the same reason — an epic's dates are
       derived from its children, so they can only repeat what is already there
       (and an epic with no children carries dates that are its own invention). */

/* the working-time model: 7 hours is one work day. The editor imports this
   rather than keeping a second copy. */
export const HOURS_PER_DAY = 7;

export interface ProjectSummary {
  tasks: number;
  epics: number;
  /* effort — the work inside the bars, not the length of the span */
  hours: number;
  days: number;
  /* inclusive first day and last day, or null when nothing is scheduled */
  start: Date | null;
  end: Date | null;
}

const DAY = 24 * 60 * 60 * 1000;

/* ISO day strings sort lexicographically, so the extremes need no parsing */
export function summarize(tasks: StoreTask[]): ProjectSummary {
  let hours = 0, count = 0, epics = 0;
  let min: string | null = null, max: string | null = null;
  tasks.forEach((t) => {
    if (t.type === "summary") epics++;
    else if (t.type !== "milestone") { count++; hours += Number(t.hours) || 0; }
    if (t.type !== "summary") {
      if (t.start && (!min || t.start < min)) min = t.start;
      const e = t.end || t.start;
      if (e && (!max || e > max)) max = e;
    }
  });
  return {
    tasks: count,
    epics,
    hours: Math.round(hours * 2) / 2,
    days: Math.round((hours / HOURS_PER_DAY) * 10) / 10,
    start: min ? new Date(min + "T00:00:00") : null,
    /* `end` is stored exclusive (the day after the last working day), so the
       day the user thinks of as the end is one before it */
    end: max ? new Date(new Date(max + "T00:00:00").getTime() - DAY) : null,
  };
}

export const summarizeProject = (p: StoreProject): ProjectSummary => summarize(p.tasks || []);

/* "3 Feb" / "3 Feb 2027" — the year only when it is not the current one, so
   two same-named projects in different years are told apart at a glance */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(d: Date, thisYear: number): string {
  const y = d.getFullYear();
  return d.getDate() + " " + MON[d.getMonth()] + (y === thisYear ? "" : " " + y);
}

export function formatSpan(s: ProjectSummary, now: Date = new Date()): string {
  if (!s.start || !s.end) return "No dates yet";
  const y = now.getFullYear();
  const a = fmtDay(s.start, y), b = fmtDay(s.end, y);
  return a === b ? a : a + " – " + b;
}

/* how many calendar days the span covers, both ends included */
export function spanDays(s: ProjectSummary): number | null {
  if (!s.start || !s.end) return null;
  return Math.round((s.end.getTime() - s.start.getTime()) / DAY) + 1;
}
