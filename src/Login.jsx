import React, { useState } from "react";
import { Field } from "@ark-ui/react/field";
import { supabase } from "./lib/supabase.js";

/* Email + password gate. Supabase Auth owns the session; the app only
   renders once onAuthStateChange has handed us one. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const FIELD = "flex flex-col gap-1 font-ui text-mini text-muted";
const INPUT =
  `rounded-lg border border-line bg-surface-alt px-2.5 py-2 font-ui text-body text-ink transition-colors duration-[130ms] ease-out ${FOCUS}`;

export default function Login() {
  const [mode, setMode] = useState("signin"); /* signin | signup */
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "signup") {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        if (!data.session) setNotice("Check your inbox to confirm the address, then sign in.");
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
    } catch (err) {
      setError(err && err.message ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-ground p-6 font-ui text-ink">
      <form
        className="flex w-full max-w-[340px] flex-col gap-2.5 rounded-[14px] border border-line bg-surface px-6 pt-[26px] pb-5 shadow-pop"
        onSubmit={submit}
      >
        <div className="mb-0.5" aria-hidden="true">
          <span className="block h-3.5 w-3.5 rounded-[4px] bg-[linear-gradient(135deg,var(--color-accent)_0_50%,var(--color-summary-fill)_50%_100%)]" />
        </div>
        <h1 className="m-0 font-display text-hero font-semibold">Project timelines</h1>
        <p className="m-0 mb-1.5 text-small text-muted">
          {mode === "signup" ? "Create an account to start planning." : "Sign in to open your Gantt charts."}
        </p>
        <Field.Root className={FIELD}>
          <Field.Label>Email</Field.Label>
          <Field.Input
            className={INPUT}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field.Root>
        {/* the sign-in error belongs to the credentials as a pair, so it hangs
            off the password field rather than getting its own paragraph */}
        <Field.Root className={FIELD} invalid={!!error}>
          <Field.Label>Password</Field.Label>
          <Field.Input
            className={INPUT}
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Field.ErrorText className="m-0 mt-1.5 text-mini text-danger">{error}</Field.ErrorText>
        </Field.Root>
        {notice && <p className="m-0 text-mini text-accent">{notice}</p>}
        <button
          className={`press mt-1.5 cursor-pointer rounded-lg border-0 bg-accent px-3 py-[0.5625rem] font-ui text-body font-semibold text-accent-ink hover:brightness-[1.08] active:brightness-[0.94] disabled:cursor-default disabled:opacity-60 ${FOCUS}`}
          type="submit"
          disabled={busy}
        >
          {busy ? "Working…" : mode === "signup" ? "Sign up" : "Sign in"}
        </button>
        <button
          className={`press cursor-pointer rounded-md border-0 bg-transparent p-1 font-ui text-mini text-muted hover:text-ink ${FOCUS}`}
          type="button"
          onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); setNotice(""); }}
        >
          {mode === "signup" ? "Already have an account? Sign in" : "No account yet? Sign up"}
        </button>
      </form>
    </div>
  );
}
