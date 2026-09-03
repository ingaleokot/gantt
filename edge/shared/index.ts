import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Public data endpoint for the read-only share page.
//
// It returns EXACTLY ONE project. A caller identifies it with either
//   ?token=<share token>   preferred; may be password-gated, may be revoked
//   ?project=<project id>  links handed out before tokens existed
// With neither, nothing comes back. There is deliberately no "everything" mode:
// an earlier version returned every project to any caller.
//
// The payload is assembled by the SECURITY DEFINER function public.share_feed,
// which runs as its owner. This function therefore does not depend on its key
// resolving to service_role — when that stopped being true, every read silently
// returned zero rows and the share page reported "not found" for real projects.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* PostgREST intermittently rejected a request with 401 despite a valid key, so
   the call is retried with backoff. */
async function rpc(fn: string, args: Record<string, unknown>, attempts = 4): Promise<unknown> {
  let lastStatus = 0;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json", Accept: "application/json",
      },
      body: JSON.stringify(args),
    });
    if (r.ok) return await r.json();
    lastStatus = r.status;
    await r.body?.cancel();
    if (r.status !== 401 && r.status < 500) break;
    await sleep(120 * (i + 1));
  }
  throw new Error(`rpc ${fn} -> ${lastStatus}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  if (!url.searchParams.has("raw")) {
    return new Response(
      "This is the data endpoint for the shared Gantt view. Open the share page URL instead.",
      { headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  try {
    const feed = await rpc("share_feed", {
      p_token: url.searchParams.get("token"),
      p_password: url.searchParams.get("password"),
      p_project: url.searchParams.get("project"),
    }) as { status?: string } | null;

    const status = feed && typeof feed.status === "string" ? feed.status : "not_found";
    if (status === "ok") return json(feed);
    if (status === "password_required" || status === "bad_password") return json({ status }, 401);
    if (status === "no_target") return json({ status, error: "a token or project is required" }, 400);
    return json({ status: "not_found" }, 404);
  } catch (e) {
    return json({ status: "error", error: (e as Error).message }, 500);
  }
});
