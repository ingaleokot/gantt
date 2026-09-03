import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY — copy .env.example to .env and fill it in.",
  );
}

export const SUPABASE_URL = url;
/* typed against src/lib/database.types.ts, so every .from("…") call below is
   checked against the real columns of the cloud project */
/* `detectSessionInUrl` is on because /reset-password is reached from an emailed
   link that carries the recovery token in the URL fragment: the client reads it
   as it initialises, exchanges it for a session, emits PASSWORD_RECOVERY and
   scrubs the fragment. Without it that page has no session and updateUser()
   would have nothing to update. It is inert on every other route — there is
   nothing to detect in a normal URL. */
export const supabase = createClient<Database>(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
