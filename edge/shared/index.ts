import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Public data endpoint for the read-only share page (/gantt/share/).
// `?raw=1` returns the whole store as JSON with CORS open; the static page
// fetches it at runtime and renders it. Deployed with verify_jwt: false and
// the service role key, so it can read past the owner-scoped RLS policies.
//
// Optional `?owner=<uuid>` narrows the payload to one account's data.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

async function rest(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path.split("?")[0]} -> ${r.status}`);
  return r.json();
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
  const owner = url.searchParams.get("owner");
  const byOwner = owner ? `owner=eq.${encodeURIComponent(owner)}&` : "";
  try {
    const [projects, links, state, people] = await Promise.all([
      rest(`projects?${byOwner}select=id,name,view&order=position.asc`),
      rest("links?select=id,project_id,source,target,type"),
      rest(`app_state?${byOwner}select=active_project&id=eq.main`),
      rest(`people?${byOwner}select=id,name&order=position.asc`),
    ]);
    const ids = new Set(projects.map((p: { id: string }) => p.id));
    const allTasks = await rest("tasks?select=*&order=sort_order.asc");

    const data = {
      active: state.length ? state[0].active_project : null,
      projects,
      tasks: allTasks
        .filter((t: { project_id: string }) => ids.has(t.project_id))
        .map((t: Record<string, unknown>) => ({
          id: t.id, project: t.project_id, parent: t.parent_id, text: t.text, type: t.type,
          start: t.start_date, end: t.end_date, duration: t.duration, hours: t.hours, days: t.days,
          progress: t.progress, details: t.details, url: t.url, status: t.status,
          assignees: t.assignees,
        })),
      links: links
        .filter((l: { project_id: string }) => ids.has(l.project_id))
        .map((l: Record<string, unknown>) => ({
          id: l.id, project: l.project_id, source: l.source, target: l.target, type: l.type,
        })),
      people,
    };
    return new Response(JSON.stringify(data), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: JSON_HEADERS });
  }
});
