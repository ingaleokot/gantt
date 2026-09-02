import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Serves the view-only Gantt page composed with live data (?raw=1), with CORS
// open so a static page on any host can fetch and render it. Supabase's
// gateway won't serve renderable pages from *.supabase.co (HTML is rewritten
// to text/plain), so a plain GET returns a pointer note instead of the page.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

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
  try {
    const page = await rest("view_page?id=eq.main&select=hash,chunk_count");
    if (!page.length) {
      return new Response(
        "This share link isn't ready yet. Open the Gantt editor and click Share once to prepare it.",
        { status: 503, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    const chunks = await rest("view_chunks?select=idx,data&order=idx.asc");
    const b64 = chunks.map((c: { data: string }) => c.data).join("");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const tpl = new TextDecoder().decode(bytes);

    const [projects, tasks, links, state, people] = await Promise.all([
      rest("projects?select=*&order=position.asc"),
      rest("tasks?select=*&order=sort_order.asc"),
      rest("links?select=*"),
      rest("app_state?id=eq.main&select=active_project"),
      rest("people?select=*&order=position.asc"),
    ]);
    const data = {
      active: state.length ? state[0].active_project : null,
      projects: projects.map((p: any) => ({ id: p.id, name: p.name, view: p.view })),
      tasks: tasks.map((t: any) => ({
        id: t.id, project: t.project_id, parent: t.parent_id, text: t.text, type: t.type,
        start: t.start_date, end: t.end_date, duration: t.duration, hours: t.hours, days: t.days,
        progress: t.progress, details: t.details, url: t.url, status: t.status,
        assignees: t.assignees,
      })),
      links: links.map((l: any) => ({ id: l.id, project: l.project_id, source: l.source, target: l.target, type: l.type })),
      people: people.map((h: any) => ({ id: h.id, name: h.name })),
    };
    const json = JSON.stringify(data).replace(/</g, "\\u003c");
    const html = tpl.replace('"__GANTT_VIEW_DATA__"', () => json);
    return new Response(html, {
      headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return new Response("View unavailable: " + (e as Error).message, {
      status: 500,
      headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
});
