/* validate the xhtml-shell + srcdoc bootstrap end to end against a local server */
import { chromium } from "playwright";
import { readFileSync } from "fs";
import http from "http";

const shell = readFileSync("edge/shell.svg", "utf8");
const tpl = readFileSync("out/view-template.html", "utf8");
const data = {
  active: "p1",
  projects: [{ id: "p1", name: "Rocket", view: "day" }],
  tasks: [
    { id: 1, project: "p1", parent: null, text: "Launch epic", type: "summary", start: null, end: null, duration: null, hours: null, days: null, progress: 0, details: "", url: "https://tracker.yandex.ru/PRODUCT-1234", status: "progress" },
    { id: 2, project: "p1", parent: 1, text: "API & <script> \"quotes\" $& test", type: "backend", start: "2026-09-01", end: "2026-09-03", duration: 2, hours: 14, days: 2, progress: 40, details: "", url: null, status: "progress" },
  ],
  links: [],
};
const html = tpl.replace('"__GANTT_VIEW_DATA__"', () => JSON.stringify(data).replace(/</g, "\\u003c"));

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.searchParams.has("raw")) {
    res.writeHead(200, { "Content-Type": "text/plain" }); /* same rewrite supabase applies */
    res.end(html);
  } else {
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
    res.end(shell);
  }
});
await new Promise((ok) => srv.listen(8931, ok));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on("pageerror", (e) => errs.push("top:" + String(e).slice(0, 150)));
await page.goto("http://127.0.0.1:8931/functions/v1/gantt-view");
await page.waitForTimeout(2500);
const frame = page.frames().find((f) => f !== page.mainFrame());
if (!frame) throw new Error("iframe never got a document");
const res = await frame.evaluate(() => ({
  bars: document.querySelectorAll(".wx-bar").length,
  epic: !!document.querySelector(".wx-bar.wx-summary"),
  crown: !!document.querySelector(".ti-summary"),
  chip: (document.body.textContent || "").includes("View only"),
  name: (document.querySelector(".project-name") || {}).textContent,
  weird: Array.from(document.querySelectorAll(".wx-row")).some((r) => (r.textContent || "").includes('"quotes" $& test')),
}));
console.log("frame:", JSON.stringify(res), "errors:", errs);
await page.screenshot({ path: "out/shot-shell.png" });
await browser.close();
srv.close();
if (errs.length) throw new Error(errs.join(" | "));
if (res.bars < 2 || !res.epic || !res.crown || !res.chip || res.name !== "Rocket") throw new Error("frame render incomplete");
if (!res.weird) throw new Error("special-character task text lost");
console.log("shell bootstrap OK");
