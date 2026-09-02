import { chromium } from "playwright";
import { fileURLToPath } from "url";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

// probe hook: capture api
await page.addInitScript(() => {
  window.__probe = {};
  window.__ganttProbe = (api) => {
    window.__api = api;
    const st = api.getState();
    window.__probe.stateKeys = Object.keys(st);
    window.__probe.tasksType = Object.prototype.toString.call(st.tasks);
    window.__probe.tasksCtor = st.tasks && st.tasks.constructor && st.tasks.constructor.name;
    window.__probe.hasPool = !!(st.tasks && st.tasks._pool);
    window.__probe.isArray = Array.isArray(st.tasks);
    window.__probe.linksType = Object.prototype.toString.call(st.links);
    window.__probe.linksIsArray = Array.isArray(st.links);
  };
});

await page.goto("file://" + fileURLToPath(new URL("./out/test.html", import.meta.url)));
await page.waitForTimeout(2500);

console.log("PROBE:", JSON.stringify(await page.evaluate(() => window.__probe), null, 1));
console.log("empty hint visible:", await page.locator(".empty-card").count());
await page.screenshot({ path: "out/shot-empty.png" });

// add a task via api.exec
await page.evaluate(() => {
  const api = window.__api;
  api.exec("add-task", { task: { text: "Design homepage", start: new Date(2026, 8, 1), duration: 5, progress: 30, type: "task" } });
  api.exec("add-task", { task: { text: "Build backend", start: new Date(2026, 8, 4), duration: 8, progress: 0, type: "task" } });
});
await page.waitForTimeout(2500); // allow debounce save
const pub = await page.evaluate(() => window.__published.length);
console.log("published count after adds:", pub);
if (pub > 0) {
  const html = await page.evaluate(() => window.__published[window.__published.length - 1]);
  const m = html.match(/<script type="application\/json" id="gantt-data">([\s\S]*?)<\/script>/);
  console.log("saved JSON:", m ? m[1].slice(0, 600) : "NOT FOUND");
  console.log("title in saved html:", (html.match(/<title>[\s\S]*?<\/title>/) || [])[0]);
  console.log("saved html length:", html.length, "vs orig fragment ~553k");
}
console.log("task rows rendered:", await page.locator(".wx-bar, [class*=wx-bar]").count());
await page.screenshot({ path: "out/shot-tasks.png" });

// serialization shape check
const ser = await page.evaluate(() => {
  const api = window.__api;
  const st = api.getState();
  let raw;
  try { raw = JSON.parse(JSON.stringify(st.tasks, (k, v) => v instanceof Date ? v.toISOString() : v)); } catch (e) { raw = "unserializable: " + e.message; }
  return raw;
});
console.log("raw state.tasks sample:", JSON.stringify(ser).slice(0, 800));

console.log("ERRORS:", errors.slice(0, 10));
await browser.close();
