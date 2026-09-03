import { useEffect } from "react";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import Editor from "../../features/gantt/Editor";
import { signOut } from "../../features/auth/api/auth";
import { useStore } from "../../features/projects/store";

/* The editor, deep-linkable. The URL is what says which project is open —
   `app_state.active_project` has degraded to "last opened", written here so
   `/` has something to resolve to next time. */

const VIEW_KEYS = ["day", "week", "month"] as const;
type ViewKey = (typeof VIEW_KEYS)[number];
const isView = (v: unknown): v is ViewKey => typeof v === "string" && (VIEW_KEYS as readonly string[]).includes(v);

export const Route = createFileRoute("/_authed/p/$projectId")({
  /* the only search param, and it is validated: anything else is dropped
     rather than handed to the widget as a scale it does not have */
  validateSearch: (search: Record<string, unknown>): { view?: ViewKey } =>
    isView(search.view) ? { view: search.view } : {},
  component: EditorRoute,
});

function EditorRoute() {
  const { projectId } = Route.useParams();
  const { view } = Route.useSearch();
  const st = useStore();
  const navigate = useNavigate();
  const project = st.projects.find((p) => p.id === projectId);
  const found = !!project;

  useEffect(() => { if (found) st.markOpened(projectId); }, [found, projectId, st.markOpened]);

  /* a stale link, or a project deleted in another tab */
  if (!project) return <Navigate to="/" replace />;

  return (
    <Editor
      /* keyed so a project switch remounts with a clean widget, undo stack and
         row tagger rather than trying to reconcile two timelines */
      key={projectId}
      projectId={projectId}
      view={view ?? (isView(project.view) ? project.view : "day")}
      onView={(v) => { void navigate({ to: "/p/$projectId", params: { projectId }, search: { view: isView(v) ? v : undefined }, replace: true }); }}
      onOpenProject={(id) => { void navigate({ to: "/p/$projectId", params: { projectId: id }, search: {} }); }}
      onNewProject={async () => {
        const id = await st.createProject("New project");
        await navigate({ to: "/p/$projectId", params: { projectId: id }, search: {} });
      }}
      onDeleteProject={async (id) => {
        await st.removeProject(id);
        if (id === projectId) await navigate({ to: "/", replace: true });
      }}
      onSignOut={async () => {
        await st.flushSave();
        await signOut();
        await navigate({ to: "/login", replace: true });
      }}
    />
  );
}
