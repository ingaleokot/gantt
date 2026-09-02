import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentSession } from "../lib/auth";
import AuthedShell from "../AuthedShell";

/* The auth gate is a redirect, not a conditional render: every route nested
   under this pathless layout is unreachable without a session, and the session
   it resolves is handed down through the route context. */
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const session = await currentSession();
    if (!session) throw redirect({ to: "/login" });
    return { session };
  },
  component: AuthedShell,
});
