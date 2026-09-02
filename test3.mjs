import { chromium } from "playwright";
import { writeFileSync } from "fs";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.addInitScript(() => { window.__ganttProbe = (api) => { window.__api = api; }; });
await page.goto("file:///home/claude/gantt/out/test.html");
await page.waitForTimeout(1500);

// seed a realistic project via api
await page.evaluate(() => {
  const api = window.__api;
  const d = (y, m, dd) => new Date(y, m, dd);
  const add = (task) => api.exec("add-task", { task });
  add({ id: "p1", text: "Design phase", start: d(2026, 8, 1), end: d(2026, 8, 15), type: "summary" });
  add({ id: "t1", text: "Wireframes", start: d(2026, 8, 1), duration: 4, progress: 100, parent: "p1" });
  add({ id: "t2", text: "Visual design", start: d(2026, 8, 5), duration: 6, progress: 45, parent: "p1" });
  add({ id: "m1", text: "Design sign-off", start: d(2026, 8, 15), type: "milestone", parent: "p1" });
  add({ id: "p2", text: "Build phase", start: d(2026, 8, 14), end: d(2026, 9, 2), type: "summary" });
  add({ id: "t3", text: "Frontend", start: d(2026, 8, 14), duration: 10, progress: 10, parent: "p2" });
  add({ id: "t4", text: "Backend API", start: d(2026, 8, 16), duration: 9, parent: "p2" });
  api.exec("add-link", { link: { source: "t1", target: "t2", type: "e2s" } });
  api.exec("add-link", { link: { source: "t2", target: "m1", type: "e2s" } });
  api.exec("add-link", { link: { source: "m1", target: "t3", type: "e2s" } });
});
await page.waitForTimeout(2200);
await page.screenshot({ path: "out/shot-project.png" });

const btn = page.getByRole("button", { name: /Export PDF/ });
console.log("export button visible:", await btn.count());
await btn.click();
await page.waitForTimeout(2500);
const saved = await page.evaluate(() => window.__saved.map((s) => ({ f: s.filename, b: s.bytes })));
console.log("saved:", JSON.stringify(saved));
if (saved.length) {
  const data = await page.evaluate(() => window.__saved[0].data);
  const buf = Buffer.from(data);
  writeFileSync("out/export.pdf", buf);
  console.log("pdf magic:", buf.slice(0, 5).toString());
}
console.log("ERRORS:", errors.slice(0, 6));
await browser.close();
