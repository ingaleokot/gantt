/* Resolve the recovery session /reset-password is reached with.

   The emailed link lands here with the token in the URL fragment. The Supabase
   client is created with `detectSessionInUrl: true`, so merely importing it
   exchanges that fragment for a session, scrubs the URL and emits
   PASSWORD_RECOVERY. Two paths therefore have to be covered, and this hook
   covers both:

     - the session is already established by the time we look — getSession()
       awaits the client's own initialisation, so that is what it reports;
     - PASSWORD_RECOVERY arrives afterwards — the subscription flips the phase.

   An expired or reused link produces neither: it comes back as error params in
   the fragment, which recoveryLinkError() reads without needing a client. */
import { useEffect, useState } from "react";
import { recoveryLinkError, recoverySession, watchPasswordRecovery } from "../api/auth";

export type RecoveryPhase = "checking" | "ready" | "invalid";

export interface Recovery {
  phase: RecoveryPhase;
  /* only set when phase is "invalid" */
  reason: string;
}

const NO_LINK =
  "This page is opened from the link in a password reset email, and there is no valid link in this URL.";

export function useRecoverySession(): Recovery {
  const [state, setState] = useState<Recovery>({ phase: "checking", reason: "" });

  useEffect(() => {
    const linkError = recoveryLinkError();
    if (linkError) { setState({ phase: "invalid", reason: linkError }); return; }

    let alive = true;
    let stop: (() => void) | null = null;

    /* the late-arriving event; harmless if the session was already there */
    void watchPasswordRecovery(() => { if (alive) setState({ phase: "ready", reason: "" }); }).then((off) => {
      if (alive) stop = off; else off();
    });

    void recoverySession().then((s) => {
      if (!alive) return;
      /* only downgrade to invalid if the event has not already said otherwise */
      setState((prev) => (prev.phase === "ready" ? prev : s ? { phase: "ready", reason: "" } : { phase: "invalid", reason: NO_LINK }));
    });

    return () => { alive = false; if (stop) stop(); };
  }, []);

  return state;
}
