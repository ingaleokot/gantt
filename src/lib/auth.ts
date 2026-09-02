/* The auth surface the router's `beforeLoad` uses.

   Every reference to the Supabase client in here is a DYNAMIC import on
   purpose. The route tree is eager — it is what decides which route matches —
   so anything a route file imports at the top level lands in the entry bundle
   and would follow the public `/share/$projectId` page around. Importing the
   client from inside these functions keeps supabase-js in its own chunk that is
   only fetched once an authenticated route actually matches. */

export interface SessionInfo {
  userId: string;
  email: string | null;
}

export async function currentSession(): Promise<SessionInfo | null> {
  const { supabase } = await import("./supabase");
  const { data } = await supabase.auth.getSession();
  const s = data.session;
  return s ? { userId: s.user.id, email: s.user.email ?? null } : null;
}

export async function signOut(): Promise<void> {
  const { supabase } = await import("./supabase");
  await supabase.auth.signOut();
}

/* fires on sign-in, sign-out and token refresh, including from another tab */
export async function watchSession(cb: (s: SessionInfo | null) => void): Promise<() => void> {
  const { supabase } = await import("./supabase");
  const { data } = supabase.auth.onAuthStateChange((_e, s) => {
    cb(s ? { userId: s.user.id, email: s.user.email ?? null } : null);
  });
  return () => data.subscription.unsubscribe();
}
