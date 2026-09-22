/* ---------------------------------------------------------------------------
   The timeline scale, shared by the editor and the public viewer.

   Still ONE scale — days. The Day / Week / Month switcher is gone and is not
   coming back; what changed is what the two header rows say.

     was   [{ unit: "month", format: "%F %Y" }, { unit: "day", format: "%j" }]
     now   [{ unit: "week",  format: weekBand }, { unit: "day", format: dayCell }]

   A month band over bare day numbers ("14 15 16 17…") gave the eye nothing to
   hold on to: you could see which month you were in and, four columns later,
   had lost count of which week. A WEEK band reading `W29 Jul 12 – 18` over day
   cells reading `Mon 13` answers both without anyone counting — which is the
   reference's whole point, and why it is the one place the app's own scale had
   to change rather than just be recoloured.

   Both formats are FUNCTIONS, which `IScaleConfig.format` accepts alongside a
   pattern string. That matters for the week band: no strftime pattern can
   produce a range, and the second argument is the next cell's start, so the
   range is exact whatever SVAR decides a week starts on.

   `projects.view` is still in the schema, still unread and still unwritten.
   `pdf.ts` still picks day / week / month from the project's own span; that is
   a different problem (an A4 page) and is untouched.

   Nothing here may import from `src/lib/` — `ShareViewer.tsx` imports this
   module, and the public page must never load the Supabase client.
--------------------------------------------------------------------------- */
import type { IScaleConfig } from "@svar-ui/react-gantt";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ISO-8601 week number, computed in UTC so a local DST shift cannot move a
   date across midnight on the way. */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - start) / 86400000 + 1) / 7);
}

/* `W29 Jul 12 – 18`, and `W31 Jul 26 – Aug 1` when the week crosses a month.
   The end is derived from `next` — the following cell's start — by stepping
   back one calendar day through the date parts rather than by subtracting 24
   hours, which is an hour short (or long) on the two DST weekends a year. */
function weekBand(date: Date, next?: Date): string {
  const end = next
    ? new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1)
    : new Date(date.getFullYear(), date.getMonth(), date.getDate() + 6);
  const from = MON[date.getMonth()] + " " + date.getDate();
  const to = end.getMonth() === date.getMonth()
    ? String(end.getDate())
    : MON[end.getMonth()] + " " + end.getDate();
  return "W" + isoWeek(date) + " " + from + " – " + to;
}

/* `Mon 13` — the weekday is what makes a weekend readable as a weekend even
   where the column's own shading is washed out by an epic band over it. */
function dayCell(date: Date): string {
  return DOW[date.getDay()] + " " + date.getDate();
}

export const DAY_SCALES: IScaleConfig[] = [
  { unit: "week", step: 1, format: weekBand },
  { unit: "day", step: 1, format: dayCell },
];

/* Wide enough for `Mon 13` at the widget's 12px scale font. Worth knowing:
   `autoScale` clamps the cell to `minCellWidth` (50) at the low end, so the 36
   this used to pass was never what the chart drew — it was 50 all along. This
   is the real number, and it is above the clamp, so it is the one used. */
export const DAY_CELL_WIDTH = 52;

/* Saturday and Sunday. The class is SVAR's own hook; `wx-overrides.css` gives
   it the wash and the 135° hatch. */
export const WEEKEND_HIGHLIGHT = (d: Date, u: "day" | "hour"): string =>
  u === "day" && (d.getDay() === 0 || d.getDay() === 6) ? "wx-weekend" : "";

/* ---------- the today line ----------
   NOT `markers`. SVAR's config does declare `markers?: IMarker[]`, and passing
   one looks like it should work — but this package's `init(config)` overwrites
   it: `t.markers = []; t._markers = []`, in the same breath as `t.undo = false`
   and `t.criticalPath = null`. Markers are one of the PRO features this build
   disables, exactly like the history the app already reimplements by hand. A
   marker prop is therefore silently dropped, which is worth writing down
   because nothing errors and nothing warns — the line simply never appears.

   So it is drawn the way the epic bands and the project span are: one element
   the row tagger owns, appended to `.wx-area` (never inserted), positioned in
   the same pixel space the scale gives every other decoration. Appended last,
   so it reads ON TOP of the bars as the reference's does, with
   `pointer-events: none` so it cannot swallow a click meant for one.

   `x` is null when today is outside the drawn range, and the line is removed
   rather than clamped to an edge it does not mean. */
export function setTodayLine(area: HTMLElement | null, x: number | null): void {
  if (!area) return;
  const existing = area.querySelector<HTMLElement>(":scope > .today-line");
  if (x === null) {
    if (existing) existing.remove();
    return;
  }
  const el = existing || document.createElement("div");
  if (!existing) {
    el.className = "today-line";
    el.title = "Today";
    el.setAttribute("aria-hidden", "true");
    area.appendChild(el);
  }
  const left = Math.round(x) + "px";
  if (el.style.left !== left) el.style.left = left;
}

/* Today at local midnight — the value both screens measure against the scale. */
export function todayStart(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
