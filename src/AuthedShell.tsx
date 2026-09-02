import { useEffect } from "react";
import { Outlet, getRouteApi, useNavigate } from "@tanstack/react-router";
import { watchSession } from "./lib/auth";
import { StoreProvider } from "./lib/store";

const route = getRouteApi("/_authed");

/* Everything behind the gate shares one loaded store: the React Query snapshot
   of what Postgres holds plus the draft the editor writes into. It lives here,
   on the layout route, so switching between projects navigates without
   throwing the loaded data away. */
export default function AuthedShell() {
  const { session } = route.useRouteContext();
  const navigate = useNavigate();

  /* signing out in another tab, or a refresh token that finally expired */
  useEffect(() => {
    let stop: (() => void) | null = null;
    let alive = true;
    watchSession((s) => { if (!s) void navigate({ to: "/login", replace: true }); }).then((off) => {
      if (alive) stop = off; else off();
    });
    return () => { alive = false; if (stop) stop(); };
  }, [navigate]);

  return (
    <StoreProvider ownerId={session.userId}>
      <Outlet />
    </StoreProvider>
  );
}
