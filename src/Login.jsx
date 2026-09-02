import React, { useState } from "react";
import { supabase } from "./lib/supabase.js";

/* Email + password gate. Supabase Auth owns the session; the app only
   renders once onAuthStateChange has handed us one. */
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
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand" aria-hidden="true"><span className="brand-mark" /></div>
        <h1 className="auth-title">Project timelines</h1>
        <p className="auth-hint">
          {mode === "signup" ? "Create an account to start planning." : "Sign in to open your Gantt charts."}
        </p>
        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        {notice && <p className="auth-notice">{notice}</p>}
        <button className="auth-submit" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "signup" ? "Sign up" : "Sign in"}
        </button>
        <button
          className="auth-switch"
          type="button"
          onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); setNotice(""); }}
        >
          {mode === "signup" ? "Already have an account? Sign in" : "No account yet? Sign up"}
        </button>
      </form>
    </div>
  );
}
