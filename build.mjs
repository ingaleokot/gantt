import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";

const r = await build({
  entryPoints: ["src/app.jsx"],
  bundle: true,
  minify: true,
  format: "iife",
  jsx: "automatic",
  write: false,
  loader: { ".jsx": "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = r.outputFiles[0].text;
if (/<\/script/.test(js)) {
  throw new Error("bundle contains raw </script — would break inline embedding");
}

const shellCss = readFileSync("style.css", "utf8");
const wxCss = readFileSync("node_modules/@svar-ui/react-gantt/dist-full/index.css", "utf8")
  .replace(/@font-face{[^}]*}/g, ""); // external cdn fonts are CSP-blocked; our own faces apply
const wxOverrides = readFileSync("wx-overrides.css", "utf8") + "\n" + readFileSync("icons.css", "utf8");

/* ---------- read-only view page (served by the Supabase edge function) ---------- */
const rv = await build({
  entryPoints: ["src/view.jsx"],
  bundle: true,
  minify: true,
  format: "iife",
  jsx: "automatic",
  write: false,
  loader: { ".jsx": "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const viewJs = rv.outputFiles[0].text;
if (/<\/script/.test(viewJs)) throw new Error("view bundle contains raw </script");
const viewHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Project timelines</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;600;700&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<style>
:root{color-scheme:light dark}
${shellCss}
</style>
<style>
${wxCss}
</style>
<style>
${wxOverrides}
.view-name{cursor:default}
.view-toolbar{min-height:44px;justify-content:flex-end}
</style>
</head>
<body>
<script type="application/json" id="view-data">"__GANTT_VIEW_DATA__"</script>
<div id="app"></div>
<script>
${viewJs}
</script>
</body>
</html>`;
mkdirSync("out", { recursive: true });
writeFileSync("out/view-template.html", viewHtml);
console.log("view template bytes:", viewHtml.length);

/* base64 + hash of the view template — the editor page syncs this into Supabase
   (view_page/view_chunks) so the edge function can serve it without bundling it */
const tplB64 = Buffer.from(viewHtml, "utf8").toString("base64");
const tplHash = createHash("sha256").update(viewHtml, "utf8").digest("hex").slice(0, 16);
console.log("view template b64 chars:", tplB64.length, "hash:", tplHash);

const fragment = `<title>Project timelines</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;600;700&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<style>
${shellCss}
</style>
<style>
${wxCss}
</style>
<style>
${wxOverrides}
</style>
<div id="app"></div>
<script>window.__VIEW_TPL_HASH=${JSON.stringify(tplHash)};window.__VIEW_TPL_B64=${JSON.stringify(tplB64)};</script>
<script>
${js}
</script>
`;

writeFileSync("out/gantt-chart.html", fragment);

// local test harness: skeleton wrapper + claude stub
const testPage = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light dark}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>
<script>
window.__published = [];
window.__saved = [];
window.claude = { use: async (name) => {
  if (name === "artifact") return { publish: async (html) => { window.__published.push(html); } };
  if (name === "mcp") return { callTool: async (server, tool, input) => {
    window.__sql = window.__sql || [];
    window.__sql.push({ server, tool, query: input && input.query });
    const q = (input && input.query) || "";
    let rows = [];
    if (q.includes("json_build_object")) rows = [{ store: window.__dbStore || { active: null, projects: [], tasks: [], links: [] } }];
    return { payload: { result: "Below is the result.\\n<untrusted-data-abc>\\n" + JSON.stringify(rows) + "\\n</untrusted-data-abc>\\ndone" } };
  } };
  if (name === "downloads") return { save: async (req) => {
    window.__saved.push({ filename: req.filename, bytes: req.data.byteLength || req.data.length,
      data: Array.from(new Uint8Array(req.data instanceof ArrayBuffer ? req.data : req.data.buffer || new ArrayBuffer(0))) });
    return { status: "saved" };
  } };
  return null;
} };
</script>
</head><body>
${fragment}
</body></html>`;
writeFileSync("out/test.html", testPage);
/* GitHub Pages serves docs/ on the default branch; the share page is the only
   file it needs, generated here so it can never drift from hosting/ */
mkdirSync("docs", { recursive: true });
const sharePage = readFileSync("hosting/gantt-share.html", "utf8");
writeFileSync("docs/index.html", sharePage);
writeFileSync("docs/.nojekyll", "");
console.log("docs/index.html bytes:", sharePage.length);

console.log("bundle bytes:", js.length, "| fragment bytes:", fragment.length);
