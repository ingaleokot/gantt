/* The auth surface: every `supabase.auth.*` call in the app goes through here.

   Every reference to the Supabase client in this file is a DYNAMIC import on
   purpose. The route tree is eager — it is what decides which route matches —
   so anything a route file imports at the top level lands in the entry bundle
   and would follow the public `/share/$projectId` page around. Importing the
   client from inside these functions keeps supabase-js in its own chunk that is
   only fetched once an auth or authenticated route actually runs.

   The rule is easy to break by accident: `src/Login.tsx` used to `import
   { supabase }` at the top and was pulled in by the login route. Nothing in
   features/auth/components/ may talk to supabase-js directly — it calls these
   functions instead. */

/* Supabase's own floor. Enforced client-side so the user is told before a
   round trip, and the server's message is still surfaced if it disagrees. */
export const PASSWORD_MIN_LENGTH = 6;

export interface SessionInfo {
  userId: string;
  email: string | null;
}

const info = (s: { user: { id: string; email?: string } } | null): SessionInfo | null =>
  s ? { userId: s.user.id, email: s.user.email ?? null } : null;

/* Supabase's raw strings are accurate but terse, and two of them are worth
   rewriting because the user can act on them. Anything unrecognised is passed
   through rather than flattened into "Something went wrong". */
export function authErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = raw.toLowerCase();
  if (m.includes("invalid login credentials")) return "That email and password do not match an account.";
  if (m.includes("email not confirmed")) return "Confirm your email address first — check your inbox for the link.";
  if (m.includes("user already registered")) return "That address already has an account. Sign in instead.";
  if (m.includes("email rate limit") || m.includes("rate limit")) return "Too many attempts just now. Wait a minute and try again.";
  return raw || "Something went wrong. Try again.";
}

export async function currentSession(): Promise<SessionInfo | null> {
  const { supabase } = await import("../../../lib/supabase");
  const { data } = await supabase.auth.getSession();
  return info(data.session);
}

export async function signIn(email: string, password: string): Promise<void> {
  const { supabase } = await import("../../../lib/supabase");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export interface SignUpResult {
  /* the project requires email confirmation: signUp returned no session, so
     there is nothing to sign the user into yet */
  needsConfirmation: boolean;
}

export async function signUp(email: string, password: string): Promise<SignUpResult> {
  const { supabase } = await import("../../../lib/supabase");
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return { needsConfirmation: !data.session };
}

/* Where the emailed recovery link has to land. Built from the Vite base
   ("/gantt/") against the current origin, so the same code produces
   http://localhost:5173/gantt/reset-password in dev and
   https://ingaleokot.github.io/gantt/reset-password in production.

   Supabase only honours a redirect it recognises: the URL has to be the Site
   URL or match a Redirect URL pattern in the dashboard (Authentication → URL
   Configuration), otherwise the mail arrives pointing at the Site URL instead. */
export function resetRedirectUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}reset-password`, window.location.origin).toString();
}

/* Deliberately says nothing about whether the address exists — the caller
   shows the same neutral message either way. */
export async function requestPasswordReset(email: string): Promise<void> {
  const { supabase } = await import("../../../lib/supabase");
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: resetRedirectUrl() });
  if (error) throw error;
}

export async function updatePassword(password: string): Promise<void> {
  const { supabase } = await import("../../../lib/supabase");
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { supabase } = await import("../../../lib/supabase");
  await supabase.auth.signOut();
}

/* fires on sign-in, sign-out and token refresh, including from another tab */
export async function watchSession(cb: (s: SessionInfo | null) => void): Promise<() => void> {
  const { supabase } = await import("../../../lib/supabase");
  const { data } = supabase.auth.onAuthStateChange((_e, s) => cb(info(s)));
  return () => data.subscription.unsubscribe();
}

/* ---------------------------------------------------------------------------
   Password recovery

   The link in the email goes to Supabase's /auth/v1/verify, which redirects to
   `redirectTo` with the recovery token in the URL fragment. The client is
   created with `detectSessionInUrl: true`, so simply importing it is what
   exchanges that fragment for a session and emits PASSWORD_RECOVERY.

   `getSession()` awaits the client's own initialisation, which includes that
   exchange — so by the time it resolves the session is either there or the link
   was no good. The event listener below is the other half: it catches the case
   where PASSWORD_RECOVERY lands after the page has already decided.
--------------------------------------------------------------------------- */

/* Resolves once the client has finished reading the URL. A session means the
   link was valid and a new password can be set. */
export async function recoverySession(): Promise<SessionInfo | null> {
  const { supabase } = await import("../../../lib/supabase");
  const { data } = await supabase.auth.getSession();
  return info(data.session);
}

export async function watchPasswordRecovery(cb: (s: SessionInfo) => void): Promise<() => void> {
  const { supabase } = await import("../../../lib/supabase");
  const { data } = supabase.auth.onAuthStateChange((event, s) => {
    if (s && (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
      cb({ userId: s.user.id, email: s.user.email ?? null });
    }
  });
  return () => data.subscription.unsubscribe();
}

/* An expired or already-used link comes back as error params in the fragment
   (`#error=access_denied&error_code=otp_expired&…`) instead of a token, and
   supabase-js has no session to hand us in that case. Reading them here needs
   no client at all, so the page can say what actually happened. */
export function recoveryLinkError(): string | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const code = hash.get("error_code") || query.get("error_code");
  const desc = hash.get("error_description") || query.get("error_description");
  const err = hash.get("error") || query.get("error");
  if (!code && !desc && !err) return null;
  if (code && code.includes("expired")) return "That reset link has expired. Ask for a new one.";
  return desc ? desc.replace(/\+/g, " ") : "That reset link is no longer valid. Ask for a new one.";
}
