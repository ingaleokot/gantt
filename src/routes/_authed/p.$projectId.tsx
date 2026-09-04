import { useEffect, useMemo } from "react";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import Editor from "../../features/gantt/Editor";
import { signOut } from "../../features/auth/api/auth";
import { useStore } from "../../features/projects/store";
import { RELEASE_IDS, TASK_TYPE_IDS, UNSET } from "../../features/gantt/lib/taxonomy";
import type { FilterState } from "../../features/gantt/lib/taxonomy";

/* The editor, deep-linkable. The URL is what says which project is open —
   `app_state.active_project` has degraded to "last opened", written here so
   `/` has something to resolve to next time.

   Nothing this file imports may reach lib/supabase: the route tree is eager, so
   a static import here would ship supabase-js to the public share pages.
   ../../features/gantt/lib/taxonomy is pure data and pure functions, which is
   also why the viewer can share it. */

const VIEW_KEYS = ["day", "week", "month"] as const;
type ViewKey = (typeof VIEW_KEYS)[number];
const isView = (v: unknown): v is ViewKey => typeof v === "string" && (VIEW_KEYS as readonly string[]).includes(v);

/* The filter travels as three comma-separated params — `?type=story,backend` —
   so a filtered timeline is a link somebody else can open. Each one is
   validated the way `view` is: unknown tokens are dropped rather than handed on. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
function parseList(raw: unknown, ok: (v: string) => boolean): string[] {
  if (typeof raw !== "string" || !raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (v && ok(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

interface Search {
  view?: ViewKey;
  /* effective task types */
  type?: string;
  /* release scopes, plus "none" for unassigned */
  rel?: string;
  /* people ids, plus "none" for unassigned */
  who?: string;
}

const listParam = (xs: string[]): string | undefined => (xs.length ? xs.join(",") : undefined);
const searchOf = (f: FilterState): Pick<Search, "type" | "rel" | "who"> => ({
  type: listParam(f.types),
  rel: listParam(f.releases),
  who: listParam(f.people),
});

export const Route = createFileRoute("/_authed/p/$projectId")({
  /* every search param is validated: anything else is dropped rather than
     handed to the widget as a scale, a type or a scope it does not have */
  validateSearch: (search: Record<string, unknown>): Search => {
    const out: Search = {};
    if (isView(search.view)) out.view = search.view;
    out.type = listParam(parseList(search.type, (v) => TASK_TYPE_IDS.includes(v)));
    out.rel = listParam(parseList(search.rel, (v) => v === UNSET || RELEASE_IDS.includes(v)));
    /* people ids cannot be checked against the roster here — it is not loaded
       yet, and a link may name someone who has since been removed. Only the
       shape is validated; the editor drops ids nobody holds any more, so a
       stale one is ignored rather than hiding every row. */
    out.who = listParam(parseList(search.who, (v) => v === UNSET || ID_SHAPE.test(v)));
    return out;
  },
  component: EditorRoute,
});

function EditorRoute() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const st = useStore();
  const navigate = useNavigate();
  const project = st.projects.find((p) => p.id === projectId);
  const found = !!project;

  useEffect(() => { if (found) st.markOpened(projectId); }, [found, projectId, st.markOpened]);

  const filter = useMemo<FilterState>(() => ({
    types: search.type ? search.type.split(",") : [],
    releases: search.rel ? search.rel.split(",") : [],
    people: search.who ? search.who.split(",") : [],
  }), [search.type, search.rel, search.who]);

  /* a stale link, or a project deleted in another tab */
  if (!project) return <Navigate to="/" replace />;

  const go = (next: Search) => {
    void navigate({ to: "/p/$projectId", params: { projectId }, search: next, replace: true });
  };

  return (
    <Editor
      /* keyed so a project switch remounts with a clean widget, undo stack and
         row tagger rather than trying to reconcile two timelines */
      key={projectId}
      projectId={projectId}
      view={search.view ?? (isView(project.view) ? project.view : "day")}
      onView={(v) => go({ ...searchOf(filter), view: isView(v) ? v : undefined })}
      filter={filter}
      onFilter={(f) => go({ view: search.view, ...searchOf(f) })}
      onSignOut={async () => {
        /* signing out throws the draft away with the page. flushSave used to
           swallow its own failure, so unsaved work went with it in silence —
           it now reports, and this asks before discarding anything. */
        const saved = await st.flushSave();
        if (!saved && !window.confirm(
          "Your latest changes have not reached the database yet, and signing out discards them. Sign out anyway?",
        )) return;
        await signOut();
        await navigate({ to: "/login", replace: true });
      }}
    />
  );
}
