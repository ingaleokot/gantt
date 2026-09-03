import { Outlet, getRouteApi } from "@tanstack/react-router";
import { useRedirectWhenSignedOut } from "../features/auth/hooks/useSessionRedirect";
import { StoreProvider } from "../features/projects/store";

const route = getRouteApi("/_authed");

/* Everything behind the gate shares one loaded store: the React Query snapshot
   of what Postgres holds plus the draft the editor writes into. It lives here,
   on the layout route, so switching between projects navigates without
   throwing the loaded data away. */
export default function AuthedShell() {
  const { session } = route.useRouteContext();
  /* the gate is a beforeLoad redirect, so nothing re-renders when the session
     goes away underneath us — signing out in another tab, or a refresh token
     that finally expired */
  useRedirectWhenSignedOut();

  return (
    <StoreProvider ownerId={session.userId}>
      <Outlet />
    </StoreProvider>
  );
}
