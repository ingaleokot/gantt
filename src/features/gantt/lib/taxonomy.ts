/* ---------------------------------------------------------------------------
   The task taxonomy — the three tiers, the release scopes, and the filter that
   reads them. Pure data and pure functions, shared by the editor, the public
   viewer, the projects list and the PDF export so none of them can disagree.

   Nothing here may import from src/lib/: ShareViewer.tsx uses this module, and
   the public page must never reach the Supabase client. (Only
   ../../people/roster is pulled in, which is under the same rule.)

   ---- the story tier and SVAR ------------------------------------------------
   The hierarchy is epic → story → task. SVAR's widget only treats a row as a
   PARENT — tree toggle, rolled-up bracket bar — when its `type` is exactly
   "summary"; there is no second parent type and no way to add one. So a story
   is:

     stored in Postgres as   tasks.type = "story"
     handed to the widget as type = "summary"  +  kind = "story"

   `kind` is a widget-only field: it never reaches a database row (cleanTask
   strips it) and it exists so that everything downstream of the widget — the
   row tagger, the roll-ups, the header totals, the filter — can still tell a
   story from an epic. Whenever the widget's type is "summary", `kind` is the
   whole answer; whenever it is not, `kind` is irrelevant. That is exactly what
   `effectiveType` below encodes, and it is the ONLY place the mapping lives.

   The failure this replaces: `prepareTasks` used to coerce every parent to
   "summary" in place, and `cleanTask`'s KEEP list round-trips `type`, so the
   coercion was written straight back to Postgres. A story would have become an
   epic permanently on the next save.
--------------------------------------------------------------------------- */

import { parseAssignees } from "../../people/roster";

export interface Option {
  id: string;
  label: string;
}

/* The values `tasks.type` may hold. `story` sits between `summary` (Epic) and
   the leaf types. The column is plain text with no check constraint, so adding
   a tier needed no migration. */
export const TASK_TYPES: Option[] = [
  { id: "task", label: "Task" },
  { id: "backend", label: "Backend" },
  { id: "frontend", label: "Frontend" },
  { id: "design", label: "Design" },
  { id: "testing", label: "Testing" },
  { id: "story", label: "Story" },
  { id: "summary", label: "Epic" },
  { id: "milestone", label: "Milestone" },
];
export const TASK_TYPE_IDS: string[] = TASK_TYPES.map((t) => t.id);

/* `tasks.release`, constrained in Postgres to null | 'mvp' | 'full'. Only the
   two container tiers carry one; a leaf task inherits its nearest tier's.

   ---- MVP is a SUBSET of the full release ------------------------------------
   The two ids are not two disjoint buckets. Marking a tier `mvp` says "this
   ships in the MVP", and everything in the MVP is also in the full release;
   marking one `full` says "this ships in the full release and NOT in the MVP".
   So `full` is really "full release only", and the full release as a whole is
   mvp + full. Everything downstream reads that from `releaseMatches` and
   `releaseTotals` rather than restating it, so no screen can disagree. */
export const RELEASES: Option[] = [
  { id: "mvp", label: "MVP" },
  { id: "full", label: "Full release" },
];
export const RELEASE_IDS: string[] = RELEASES.map((r) => r.id);
/* the pseudo-value the filter uses for "nothing assigned" — never stored */
export const UNSET = "none";

/* Said in one place and spelled out on screen wherever the filter offers the
   two scopes, because a user filtering by Full and seeing MVP rows come back
   would otherwise read it as a bug. Never a tooltip: it has to be visible. */
export const RELEASE_INCLUSION_NOTE = "Full release includes everything marked MVP.";

export const releaseLabel = (r: string | null | undefined): string | null =>
  r === "mvp" ? "MVP" : r === "full" ? "Full" : null;
/* what a marker on a row actually means, for its title attribute */
export const releaseTitle = (r: string | null | undefined): string | null =>
  r === "mvp" ? "MVP scope — also part of the full release"
    : r === "full" ? "Full release only — not in the MVP"
      : null;

/* Does a row whose inherited scope is `scope` survive a filter that selected
   `selected`? The one asymmetry: choosing the full release brings the MVP rows
   with it, because they are part of it. Choosing MVP does not bring full-only
   rows back — the MVP is the smaller set. */
export function releaseMatches(selected: string[], scope: string): boolean {
  if (!selected.length) return true;
  if (selected.includes(scope)) return true;
  return scope === "mvp" && selected.includes("full");
}

/* the two tiers that contain other rows: both are parents to the widget, both
   roll their effort up from their children, and both can carry a release */
export const isTierType = (t: string | null | undefined): t is "summary" | "story" =>
  t === "summary" || t === "story";

/* stored type → the type the widget is allowed to see */
export const asWidgetType = (stored: string | null | undefined): string =>
  isTierType(stored) ? "summary" : stored || "task";

/* widget type + kind → the real tier. Used on the way back out (cleanTask), by
   the row tagger, and by every total.

   `kind` wins whenever it names a tier, because a tier is not always DRAWN as
   one: SVAR throws on a summary that is nested and has nothing inside it (its
   date roll-up recurses into every descendant), so an empty nested tier is
   handed over as a plain bar while `kind` keeps saying what it is. Everything
   else falls back to the widget's own type, which is what an auto-promoted
   parent and every ordinary task carry. */
export function effectiveType(widgetType: string | null | undefined, kind?: string | null): string {
  if (isTierType(kind)) return kind;
  if (widgetType === "summary") return "summary";
  return widgetType || "task";
}

/* ---------- the filter ------------------------------------------------------
   Three independent dimensions, ANDed; an empty dimension constrains nothing.
   The filter is a VIEW: it is applied through SVAR's own `filter-tasks`, which
   only marks which ids are visible and leaves `tree.serialize()` returning the
   complete set — so nothing about it can ever reach a write. See Editor.tsx. */

export interface FilterState {
  /* effective types (task/backend/…/story/summary/milestone) */
  types: string[];
  /* "mvp" | "full" | UNSET */
  releases: string[];
  /* people ids, plus UNSET for "nobody assigned" */
  people: string[];
}

export const EMPTY_FILTER: FilterState = { types: [], releases: [], people: [] };

export const filterCount = (f: FilterState): number =>
  f.types.length + f.releases.length + f.people.length;
export const filterActive = (f: FilterState): boolean => filterCount(f) > 0;
/* a stable identity for effects and for the URL */
export const filterKey = (f: FilterState): string =>
  f.types.join(",") + "|" + f.releases.join(",") + "|" + f.people.join(",");

/* the shape the filter needs off a task, whichever screen it came from */
export interface FilterRow {
  id?: string | number;
  parent?: string | number | null;
  /* the widget's type ("summary" for both tiers) */
  type?: string | null;
  /* the widget-only tier marker */
  kind?: string | null;
  release?: string | null;
  assignees?: string | null;
}

/* Release lives on epics and stories only, so a task's scope is the scope of
   the nearest tier above it. Without this, filtering by MVP would show the
   marked epics and none of the work inside them. The depth guard is there
   because `parent` comes out of a widget the user can drag rows around in. */
export function scopeOf(row: FilterRow, lookup: (id: string | number) => FilterRow | null): string {
  let cur: FilterRow | null = row;
  for (let i = 0; i < 64 && cur; i++) {
    if (cur.release === "mvp" || cur.release === "full") return cur.release;
    const p = cur.parent;
    if (p === undefined || p === null || p === 0 || p === "0") break;
    cur = lookup(p);
  }
  return UNSET;
}

/* `people` may hold ids that are no longer on the roster — a filter kept in the
   URL outlives the person it names. `known` drops those rather than letting a
   stale id hide every row; when nothing is left the dimension is simply off. */
export function usableFilter(f: FilterState, known: Set<string>): FilterState {
  return {
    types: f.types.filter((t) => TASK_TYPE_IDS.includes(t)),
    releases: f.releases.filter((r) => r === UNSET || RELEASE_IDS.includes(r)),
    people: f.people.filter((p) => p === UNSET || known.has(p)),
  };
}

/* Does this row itself match? Ancestors of a match are kept visible by SVAR's
   own tree walk (a branch survives when any descendant survives), which is the
   rule this app wants: hiding an epic whose story matched would orphan the row
   and make the hierarchy unreadable. */
export function makeFilter(
  f: FilterState,
  lookup: (id: string | number) => FilterRow | null,
): (row: FilterRow) => boolean {
  const types = f.types, releases = f.releases, people = f.people;
  return (row: FilterRow): boolean => {
    if (types.length && !types.includes(effectiveType(row.type, row.kind))) return false;
    /* releaseMatches, not `includes`: MVP ⊂ Full, so filtering by the full
       release must keep the MVP rows that are part of it */
    if (releases.length && !releaseMatches(releases, scopeOf(row, lookup))) return false;
    if (people.length) {
      const ids = parseAssignees(row.assignees);
      /* epics and stories carry their own assignees, independently of the rows
         under them — so they match on their own, and their children match on
         theirs, exactly as the other two dimensions work */
      const hit = ids.length ? ids.some((id) => people.includes(id)) : people.includes(UNSET);
      if (!hit) return false;
    }
    return true;
  };
}

/* ---------- release roll-up -------------------------------------------------
   Effort lives on leaf tasks; the release lives on the tier above them. So
   "what does MVP cost" is the sum of every leaf's hours grouped by the scope it
   inherits. Tiers contribute nothing of their own — their hours ARE the sum of
   their children, and counting both would double.

   The field names carry the MVP ⊂ Full rule so a caller cannot add the wrong
   two numbers together: `fullOnly` is what is scoped `full` and NOT in the MVP,
   and `fullRelease` is the whole release, MVP included. There is deliberately
   no field called plain `full` — that name is what made "MVP 21h · Full 7h"
   read as two disjoint buckets. */
export interface ReleaseTotals {
  /* effort whose nearest tier is scoped MVP — part of the full release too */
  mvp: number;
  /* effort scoped `full`, i.e. in the full release but NOT in the MVP */
  fullOnly: number;
  /* mvp + fullOnly: what the full release costs altogether */
  fullRelease: number;
  /* effort under no scoped tier at all */
  unscoped: number;
}
export function releaseTotals<T extends FilterRow>(rows: T[], hoursOf: (row: T) => number): ReleaseTotals {
  const by = new Map<string, FilterRow>();
  rows.forEach((r) => { if (r.id !== undefined) by.set(String(r.id), r); });
  const lookup = (id: string | number): FilterRow | null => by.get(String(id)) || null;
  let mvp = 0, fullOnly = 0, unscoped = 0;
  rows.forEach((r) => {
    const t = effectiveType(r.type, r.kind);
    if (isTierType(t) || t === "milestone") return;
    const scope = scopeOf(r, lookup);
    const h = hoursOf(r) || 0;
    if (scope === "mvp") mvp += h;
    else if (scope === "full") fullOnly += h;
    else unscoped += h;
  });
  const round = (n: number) => Math.round(n * 2) / 2;
  return {
    mvp: round(mvp),
    fullOnly: round(fullOnly),
    fullRelease: round(mvp + fullOnly),
    unscoped: round(unscoped),
  };
}

/* The one wording for the two numbers, used by the editor header, the public
   viewer, the projects cards and the PDF so none of them can appear to
   disagree: "MVP 56h · Full 98h incl. MVP · unscoped 65h". The "incl. MVP" is
   dropped only when there is no MVP effort to include, because then the phrase
   would be answering a question nobody asked. */
export function releaseSummaryText(t: ReleaseTotals): string {
  const parts: string[] = [];
  if (t.mvp) parts.push("MVP " + t.mvp + "h");
  if (t.fullRelease) parts.push("Full " + t.fullRelease + "h" + (t.mvp ? " incl. MVP" : ""));
  if (!parts.length) return "Not scoped";
  if (t.unscoped) parts.push("unscoped " + t.unscoped + "h");
  return parts.join(" · ");
}
