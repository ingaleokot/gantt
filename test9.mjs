/* share feature: (a) view page renders read-only from injected data,
   (b) editor page syncs the view template to Supabase when Share opens */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";

const data = {
  active: "p1",
  projects: [{ id: "p1", name: "Rocket", view: "day" }, { id: "p2", name: "Side", view: "week" }],
  tasks: [
    { id: 1, project: "p1", parent: null, text: "Launch epic", type: "summary", start: null, end: null, duration: null, hours: null, days: null, progress: 0, details: "", url: "https://tracker.yandex.ru/PRODUCT-1234", status: "progress" },
    { id: 2, project: "p1", parent: 1, text: "API work", type: "backend", start: "2026-09-01", end: "2026-09-03", duration: 2, hours: 14, days: 2, progress: 40, details: "", url: "https://tracker.yandex.ru/PRODUCT-777", status: "progress" },
    { id: 3, project: "p1", parent: 1, text: "UI polish", type: "frontend", start: "2026-09-03", end: "2026-09-04", duration: 1, hours: 7, days: 1, progress: 0, details: "", url: null, status: "todo" },
    { id: 4, project: "p2", parent: null, text: "Solo task", type: "design", start: "2026-09-02", end: "2026-09-03", duration: 1, hours: 7, days: 1, progress: 100, details: "", url: null, status: "done" },
  ],
  links: [{ id: 9, project: "p1", source: 2, target: 3, type: "e2s" }],
};

const tpl = readFileSync("out/view-template.html", "utf8");
if (!tpl.includes('"__GANTT_VIEW_DATA__"')) throw new Error("placeholder missing from template");
writeFileSync("out/view-test.html", tpl.replace('"__GANTT_VIEW_DATA__"', JSON.stringify(data).replace(/</g, "\\u003c")));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("file:///home/claude/gantt/out/view-test.html");
await page.waitForTimeout(1600);

const view = await page.evaluate(() => ({
  rows: document.querySelectorAll(".wx-table .wx-row, .wx-grid .wx-row").length,
  bars: document.querySelectorAll(".wx-bar").length,
  epicBar: !!document.querySelector(".wx-bar.wx-summary"),
  crown: !!document.querySelector(".ti-summary"),
  dots: document.querySelectorAll(".status-dot").length,
  tracker: Array.from(document.querySelectorAll(".tracker-link")).map((a) => a.textContent).join(","),
  chip: (document.body.textContent || "").includes("View only"),
  name: document.querySelector(".project-name") && document.querySelector(".project-name").textContent,
  pills: Array.from(document.querySelectorAll(".proj-pills .seg-btn, .view-projects .seg-btn")).map((b) => b.textContent),
  toolbarBtns: document.querySelectorAll(".wx-toolbar button").length,
  editors: document.querySelectorAll(".wx-sidearea, .editor-okay").length,
  addCol: (document.querySelector("[data-header-id]") || {}).textContent,
}));
console.log("view:", JSON.stringify(view), "errors:", errors);
if (errors.length) throw new Error("page errors: " + errors.join(" | "));
if (view.bars < 3) throw new Error("bars missing");
if (!view.epicBar || !view.crown) throw new Error("epic decoration missing");
if (!view.tracker.includes("PRODUCT-1234") || !view.tracker.includes("PRODUCT-777")) throw new Error("tracker ids missing: " + view.tracker);
if (!view.chip) throw new Error("'View only' chip missing");
if (view.name !== "Rocket") throw new Error("project name wrong: " + view.name);
if (view.toolbarBtns || view.editors) throw new Error("editing UI leaked into view");

/* double-click a task name — must NOT open an inline editor in readOnly mode */
const cell = await page.$(".wx-row .wx-text");
if (cell) {
  await cell.dblclick();
  await page.waitForTimeout(400);
  const editing = await page.evaluate(() => !!document.querySelector(".wx-table input, .wx-grid input, .wx-editor"));
  if (editing) throw new Error("double-click opened an editor in view mode");
}
await page.screenshot({ path: "out/shot-view.png" });

/* --- (b) editor page: Share click syncs template chunks --- */
const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs2 = [];
page2.on("pageerror", (e) => errs2.push(String(e)));
await page2.goto("file:///home/claude/gantt/out/test.html");
await page2.waitForTimeout(1800);
await page2.click("button:has-text('Share')");
await page2.waitForFunction(() => {
  const q = window.__sql || [];
  return q.some((s) => (s.query || "").includes("insert into public.view_page"));
}, null, { timeout: 30000 });
const share = await page2.evaluate(() => {
  const q = (window.__sql || []).map((s) => s.query || "");
  const chunkInserts = q.filter((s) => s.startsWith("insert into public.view_chunks"));
  const totalB64 = chunkInserts.map((s) => { const m = s.match(/,'([A-Za-z0-9+/=]+)'\)/); return m ? m[1].length : 0; }).reduce((a, b) => a + b, 0);
  return {
    checked: q.some((s) => s.includes("select hash from public.view_page")),
    chunks: chunkInserts.length,
    totalB64,
    meta: q.some((s) => s.includes("insert into public.view_page")),
    status: (document.querySelector(".share-status") || {}).textContent,
    tplLen: (window.__VIEW_TPL_B64 || "").length,
  };
});
console.log("share sync:", JSON.stringify(share), "errors:", errs2);
if (errs2.length) throw new Error("editor page errors: " + errs2.join(" | "));
if (!share.checked || !share.meta || !share.chunks) throw new Error("template sync did not run");
if (share.totalB64 !== share.tplLen) throw new Error("chunk bytes mismatch: " + share.totalB64 + " vs " + share.tplLen);
await page2.waitForTimeout(300);
const finalStatus = await page2.evaluate(() => (document.querySelector(".share-status") || {}).textContent);
if (!/live and up to date/.test(finalStatus || "")) throw new Error("share status not ready: " + finalStatus);

await browser.close();
console.log("test9 OK");
