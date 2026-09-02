import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
let reloads = 0;
p.on("load", () => reloads++);
await p.addInitScript(() => { window.__ganttProbe = (api) => { window.__api = api; }; });
await p.goto("file:///home/claude/gantt/out/test.html");
await p.waitForTimeout(1500);

/* seed a task with 10h -> 1.4 days */
await p.evaluate(() => {
  window.__api.exec("add-task", { task: { id: "t1", text: "Half task", start: new Date(2026, 8, 2), hours: 10, type: "design" } });
});
await p.waitForTimeout(400);

/* grid shows Days column */
const headers = await p.evaluate(() => [...document.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent.trim()));
console.log("headers:", headers);
const daysCell = await p.evaluate(() => {
  const c = document.querySelector('[data-row-id=":t1"][data-col-id=":days"]');
  return c && c.textContent.trim();
});
console.log("days cell for 10h (want 1.5? no — 1.4):", daysCell);

/* open editor, type into name, wait past autosave debounce, editor must stay open and keep value */
await p.evaluate(() => { window.__api.exec("show-editor", { id: "t1" }); });
await p.waitForTimeout(600);
const nameInput = p.locator(".wx-gantt-editor input").first();
await nameInput.fill("Renamed while saving");
await p.waitForTimeout(3000); // > debounce + save
console.log("reloads during edit (want 1 = initial):", reloads);
console.log("editor still open:", await p.locator(".wx-gantt-editor").count());
console.log("input kept value:", await nameInput.inputValue());
const sql = await p.evaluate(() => (window.__sql || []).filter((s) => s.query.includes("insert")).length);
console.log("supabase upserts fired:", sql > 0);
const published = await p.evaluate(() => (window.__published || []).length);
console.log("self-publishes (want 0):", published);
console.log("chip:", await p.locator(".save-chip").textContent().catch(() => "none"));
await p.screenshot({ path: "out/shot-editor-card.png" });

/* editor blur -> task actually updated */
await p.keyboard.press("Tab");
await p.waitForTimeout(400);
console.log("task text:", await p.evaluate(() => window.__api.getTask("t1").text));

/* saved payload has days */
await p.waitForTimeout(2000);
const lastInsert = await p.evaluate(() => {
  const ins = (window.__sql || []).filter((s) => s.query.includes("insert"));
  return ins.length ? ins[ins.length - 1].query : "";
});
console.log("payload has days field:", /\"days\":/.test(lastInsert.replace(/''/g, "'")));

const dark = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
await dark.addInitScript(() => { window.__ganttProbe = (api) => { window.__api = api; }; });
await dark.goto("file:///home/claude/gantt/out/test.html");
await dark.waitForTimeout(1300);
await dark.evaluate(() => {
  window.__api.exec("add-task", { task: { id: "t1", text: "Dark check", start: new Date(2026, 8, 2), hours: 14, type: "frontend" } });
  window.__api.exec("show-editor", { id: "t1" });
});
await dark.waitForTimeout(800);
await dark.screenshot({ path: "out/shot-editor-card-dark.png" });

console.log("ERRORS:", errors.slice(0, 6));
await browser.close();
