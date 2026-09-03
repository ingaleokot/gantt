/* The two halves of the auth gate that a redirect cannot express.

   The gate itself is a `beforeLoad` redirect on the pathless `_authed` layout,
   which means nothing re-renders when the session changes underneath it. So the
   sign-in / sign-up / forgot-password pages watch for a session appearing and
   move to `/`, and the authed shell watches for one disappearing and moves to
   `/login`. Remove either and the user signs in successfully and stays put.

   /reset-password deliberately uses NEITHER: it is reached *with* a recovery
   session, and redirecting away from it would make the page impossible to use. */
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { watchSession } from "../api/auth";

/* a session turning up (this form, a sign-up that returns one, another tab) */
export function useRedirectWhenSignedIn(): void {
  const navigate = useNavigate();
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | null = null;
    /* watchSession resolves the client dynamically, so the unsubscribe can
       arrive after this effect has already been torn down */
    void watchSession((s) => { if (s) void navigate({ to: "/", replace: true }); }).then((off) => {
      if (alive) stop = off; else off();
    });
    return () => { alive = false; if (stop) stop(); };
  }, [navigate]);
}

/* signing out in another tab, or a refresh token that finally expired */
export function useRedirectWhenSignedOut(): void {
  const navigate = useNavigate();
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | null = null;
    void watchSession((s) => { if (!s) void navigate({ to: "/login", replace: true }); }).then((off) => {
      if (alive) stop = off; else off();
    });
    return () => { alive = false; if (stop) stop(); };
  }, [navigate]);
}
