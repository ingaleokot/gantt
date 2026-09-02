/* cross-origin integration test: share page on one origin, raw endpoint on another */
import { chromium } from "playwright";
import { readFileSync } from "fs";
import http from "http";

const tpl = readFileSync("out/view-template.html", "utf8");
const data = {
  active: "p1",
  projects: [{ id: "p1", name: "Rocket", view: "day" }],
  tasks: [
    { id: 1, project: "p1", parent: null, text: "Launch epic", type: "summary", start: null, end: null, duration: null, hours: null, days: null, progress: 0, details: "", url: "https://tracker.yandex.ru/PRODUCT-1234", status: "progress" },
    { id: 2, project: "p1", parent: 1, text: "API work", type: "backend", start: "2026-09-01", end: "2026-09-03", duration: 2, hours: 14, days: 2, progress: 40, details: "", url: null, status: "todo" },
  ],
  links: [],
};
const html = tpl.replace('"__GANTT_VIEW_DATA__"', () => JSON.stringify(data).replace(/</g, "\\u003c"));

/* "supabase" on :8941 with the function's exact headers */
const api = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(html);
});
await new Promise((ok) => api.listen(8941, ok));

/* her host on :8942, serving the actual deliverable with the URL swapped to the local "supabase" */
const sharePage = readFileSync("out/gantt-share.html", "utf8")
  .replace(/var SRC = "[^"]+";/, 'var SRC = "http://127.0.0.1:8941/functions/v1/shared/x?raw=1";');
if (sharePage.includes("supabase.co")) throw new Error("URL swap failed");
const host = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(sharePage); });
await new Promise((ok) => host.listen(8942, ok));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 150)));
await page.goto("http://127.0.0.1:8942/share");
await page.waitForTimeout(2500);
const frame = page.frames().find((f) => f !== page.mainFrame());
if (!frame) throw new Error("no iframe document");
const res = await frame.evaluate(() => ({
  bars: document.querySelectorAll(".wx-bar").length,
  epic: !!document.querySelector(".wx-bar.wx-summary"),
  chip: (document.body.textContent || "").includes("View only"),
  name: (document.querySelector(".project-name") || {}).textContent,
}));
console.log("cross-origin frame:", JSON.stringify(res), "errors:", errs);
await page.screenshot({ path: "out/shot-host.png" });
await browser.close(); api.close(); host.close();
if (errs.length) throw new Error(errs.join(" | "));
if (res.bars < 2 || !res.epic || !res.chip || res.name !== "Rocket") throw new Error("render incomplete");
console.log("hosted share page OK");
