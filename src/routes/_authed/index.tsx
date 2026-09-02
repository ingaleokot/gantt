import { useState } from "react";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { SignOut } from "@phosphor-icons/react";
import { signOut } from "../../lib/auth";
import { useStore } from "../../lib/store";

/* `/` is only a resolver: it forwards to the project `app_state` remembers as
   last opened, and otherwise shows a genuinely empty account. Nothing is
   invented here — a project exists because the user asked for one. */
export const Route = createFileRoute("/_authed/")({ component: Home });

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

function Home() {
  const st = useStore();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const remembered = st.projects.some((p) => p.id === st.draft.activeProject) ? st.draft.activeProject : "";
  const open = remembered || (st.projects.length ? st.projects[0].id : "");
  if (open) return <Navigate to="/p/$projectId" params={{ projectId: open }} replace />;

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await st.createProject("New project");
      await navigate({ to: "/p/$projectId", params: { projectId: id } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-ground p-6 font-ui text-ink">
      <div className="material-pop max-w-[420px] rounded-[14px] border border-line px-[1.625rem] py-[1.375rem] text-center motion-safe:animate-rise">
        <div className="mb-3 flex justify-center" aria-hidden="true">
          <span className="block h-3.5 w-3.5 rounded-[4px] bg-[linear-gradient(135deg,var(--color-accent)_0_50%,var(--color-summary-fill)_50%_100%)]" />
        </div>
        <div className="mb-1.5 font-display text-title font-semibold">No projects yet</div>
        <p className="m-0 mb-4 text-copy text-muted">
          A project holds one timeline — its epics, tasks, links and people. Create one to start planning.
        </p>
        <button
          type="button"
          className={`press cursor-pointer rounded-lg border-0 bg-accent px-3.5 py-[0.5rem] font-ui text-body font-semibold text-accent-ink hover:brightness-[1.08] active:brightness-[0.94] disabled:cursor-default disabled:opacity-60 ${FOCUS}`}
          onClick={create}
          disabled={busy}
        >{busy ? "Creating…" : "New project"}</button>
        {st.error && <p className="m-0 mt-3 text-mini text-danger">{st.error}</p>}
        <div className="mt-4 border-t border-t-line-soft pt-3">
          <button
            type="button"
            className={`press cursor-pointer rounded-md border-0 bg-transparent p-1 font-ui text-mini text-muted hover:text-ink ${FOCUS}`}
            onClick={async () => { await signOut(); await navigate({ to: "/login", replace: true }); }}
          ><SignOut size={12} aria-hidden="true" /> Sign out</button>
        </div>
      </div>
    </div>
  );
}
