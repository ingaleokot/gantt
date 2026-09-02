import { useEffect } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import Login from "../Login";
import { currentSession, watchSession } from "../lib/auth";

/* the other half of the gate in _authed.tsx: a live session has no business
   sitting on the sign-in screen */
export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if (await currentSession()) throw redirect({ to: "/" });
  },
  component: LoginScreen,
});

function LoginScreen() {
  const navigate = useNavigate();
  /* the gate is a redirect now, not a conditional render, so something has to
     move once Supabase hands over a session — from this form, from a sign-up
     that returns one straight away, or from another tab */
  useEffect(() => {
    let stop: (() => void) | null = null;
    let alive = true;
    watchSession((s) => { if (s) void navigate({ to: "/", replace: true }); }).then((off) => {
      if (alive) stop = off; else off();
    });
    return () => { alive = false; if (stop) stop(); };
  }, [navigate]);

  return <Login />;
}
