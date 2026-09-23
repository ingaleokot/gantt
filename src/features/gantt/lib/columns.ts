/* ---------- which grid columns the list shows ----------
   The grid carries eight columns and an `add-task` gutter, and it is wide: the
   fixed `gridWidth` starts pushing the chart off a ~825px viewport. Hiding the
   ones a particular person does not need is what gives that width back.

   Pure data and pure functions, deliberately: ShareViewer.tsx imports this, so
   nothing here may reach `lib/` — that would drag the Supabase client onto the
   public page.

   ## Where the choice lives, and why it is NOT in the URL

   The filter is three search params because a *filtered timeline* is a thing
   worth sending someone: "here is the MVP backend work" is a statement about
   the plan. Which columns are on screen is not a statement about the plan at
   all — it is a statement about this window on this machine. Two consequences
   decided it:

     · every link copied out of the address bar would start carrying a viewing
       preference the recipient never chose, and would silently reshape their
       grid;
     · the right answer differs per device. A laptop wants fewer columns than a
       wide monitor, and one URL cannot hold both answers at once.

   So it is `localStorage`, per device, under the keys below — and deliberately
   NOT a database column: nothing about it belongs to the project, and the
   `tasks`/`projects` schema is shared with the public feed. */

import type { IApi, IGanttColumn } from "@svar-ui/react-gantt";

export interface HideableColumn {
  id: string;
  label: string;
  /* one line in the popover, so the choice is not made from a bare word */
  hint: string;
}

/* In grid order. `text` (Task name) is absent ON PURPOSE — a list of rows with
   no names is not a list — and so is `add-task`, which is chrome rather than
   data and is the only way to add a child row in place. */
export const HIDEABLE_COLUMNS: HideableColumn[] = [
  { id: "state", label: "Status", hint: "To do / In progress / Done" },
  { id: "scope", label: "Scope", hint: "MVP or full release" },
  { id: "who", label: "Who", hint: "Assignees, as initials" },
  { id: "tracker", label: "ID", hint: "The ticket behind the link" },
  { id: "start", label: "Start", hint: "The day the row starts" },
  { id: "hours", label: "Effort h", hint: "Hours of work" },
  { id: "days", label: "Effort d", hint: "The same effort in 7 h days" },
];
export const HIDEABLE_IDS: string[] = HIDEABLE_COLUMNS.map((c) => c.id);

/* Two keys, not one. The editor's grid is the owner's own workspace; the share
   page is somebody else's screen, and a column the owner hid while planning has
   no business disappearing from a link they hand out. */
export const EDITOR_COLUMNS_KEY = "gantt.columns.editor";
export const VIEWER_COLUMNS_KEY = "gantt.columns.share";

/* The grid must keep something to be: Task name (183) + the add gutter (37). */
const MIN_GRID_WIDTH = 220;

/* localStorage throws outright in a few real configurations (Safari private
   mode, third-party-blocked iframes, a user who turned site data off), and a
   viewing preference is never worth taking the screen down for. Both sides
   swallow and carry on — the cost of a failed read is "all columns shown",
   which is exactly the right default. */
export function readHiddenColumns(key: string): string[] {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(key); } catch (e) { return []; }
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { return []; }
  if (!Array.isArray(parsed)) return [];
  /* validated against the known ids the same way the route validates the
     filter: a stale or hand-edited entry is dropped, never handed on */
  const out: string[] = [];
  for (const v of parsed) {
    if (typeof v === "string" && HIDEABLE_IDS.includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

export function writeHiddenColumns(key: string, hidden: readonly string[]): void {
  try {
    if (!hidden.length) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(hidden));
  } catch (e) { /* see above: a preference is not worth an exception */ }
}

/* the id list, in grid order, so two sets that differ only in click order
   compare equal and the effect below does not re-run for nothing */
export function hiddenKey(hidden: readonly string[]): string {
  return HIDEABLE_IDS.filter((id) => hidden.includes(id)).join(",");
}

export function toggleHiddenColumn(hidden: readonly string[], id: string): string[] {
  if (!HIDEABLE_IDS.includes(id)) return hidden.slice();
  const off = hidden.includes(id);
  const next = off ? hidden.filter((x) => x !== id) : [...hidden, id];
  return HIDEABLE_IDS.filter((x) => next.includes(x));
}

/* ---------- applying it to a live widget, WITHOUT re-initialising it --------
   This is the whole reason the feature is safe. `columns` and `gridWidth` are
   props, and react-gantt re-runs `init(config)` on ANY prop change — which
   rebuilds the store and drops the active filter, the selection and the scroll
   position with it. So neither prop moves. Both values are changed through the
   store's own actions instead:

     · `set-columns` copies `width`, `hidden` and `flexgrow` onto the columns
       already in state and calls setState — nothing else;
     · `resize-grid` is a one-line setState on `gridWidth`, the same action the
       widget's own draggable resizer fires.

   Neither is in `finalEvents`, neither is intercepted, and neither touches a
   task — so a toggle emits no write of any kind, and the filter survives it
   because nothing re-initialises.

   `set-columns` copies the width off what it is HANDED, so the live columns go
   back in rather than a literal rebuilt from the constant: that is what stops a
   toggle from undoing a width the user has dragged. */
export function applyColumnVisibility(
  api: Pick<IApi, "getState" | "exec">,
  hidden: readonly string[],
  baseGridWidth: number,
): void {
  let cols: IGanttColumn[] | undefined;
  let currentWidth: number | undefined;
  try {
    const s = api.getState();
    cols = s.columns;
    currentWidth = s.gridWidth;
  } catch (e) { return; }
  if (!cols || !cols.length) return;

  let lost = 0;
  let changed = false;
  const next: IGanttColumn[] = cols.map((c) => {
    const id = typeof c.id === "string" ? c.id : "";
    const off = id !== "" && HIDEABLE_IDS.includes(id) && hidden.includes(id);
    if (off) lost += c.width || 0;
    if (Boolean(c.hidden) !== off) changed = true;
    return { id: c.id, width: c.width, flexgrow: c.flexgrow, hidden: off };
  });
  if (changed) {
    try { void api.exec("set-columns", { columns: next }); } catch (e) { return; }
  }
  /* The payoff: three hidden columns are ~240px handed back to the chart. The
     base is the number the screen ships with, so showing everything lands on
     exactly the width it always had. A width the user dragged themselves
     survives until the next toggle, which then re-derives it — the widget's
     resizer and this control are two ways to say the same thing, and the last
     one used wins. */
  const width = Math.max(MIN_GRID_WIDTH, baseGridWidth - lost);
  if (currentWidth !== width) {
    try { void api.exec("resize-grid", { width }); } catch (e) { /* keep the columns */ }
  }
}
