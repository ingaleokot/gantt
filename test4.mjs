import { chromium } from "playwright";
import { writeFileSync } from "fs";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.addInitScript(() => { window.__ganttProbe = (api) => { window.__api = api; }; });
await page.goto("file:///home/claude/gantt/out/test.html");
await page.waitForTimeout(1500);

/* 1) seed epic + typed tasks */
await page.evaluate(() => {
  const api = window.__api;
  const d = (y, m, dd) => new Date(y, m, dd);
  const add = (task) => api.exec("add-task", { task });
  add({ id: "e1", text: "Launch epic", type: "summary", open: true });
  add({ id: "t1", text: "API endpoints", start: d(2026, 8, 2), duration: 5, type: "backend", parent: "e1", progress: 60 });
  add({ id: "t2", text: "UI components", start: d(2026, 8, 4), duration: 6, type: "frontend", parent: "e1" });
  add({ id: "t3", text: "Mockups", start: d(2026, 8, 1), duration: 3, type: "design", parent: "e1", progress: 100 });
  add({ id: "t4", text: "QA pass", start: d(2026, 8, 10), duration: 4, type: "testing", parent: "e1" });
});
await page.waitForTimeout(800);

/* epic auto-dates check */
const epic = await page.evaluate(() => {
  const t = window.__api.getTask("e1");
  return { start: t.start && t.start.toISOString().slice(0, 10), end: t.end && t.end.toISOString().slice(0, 10) };
});
console.log("epic dates (want 09-01..09-14):", JSON.stringify(epic));

/* drag simulation: extend QA pass via update-task, epic should follow */
await page.evaluate(() => {
  const api = window.__api;
  api.exec("update-task", { id: "t4", task: { duration: 10, end: null } });
});
await page.waitForTimeout(500);
const epic2 = await page.evaluate(() => {
  const t = window.__api.getTask("e1");
  return { start: t.start && t.start.toISOString().slice(0, 10), end: t.end && t.end.toISOString().slice(0, 10) };
});
console.log("epic after extend (want end 09-20):", JSON.stringify(epic2));

/* typed bar colors present? */
const barClasses = await page.evaluate(() =>
  [...document.querySelectorAll(".wx-bar")].map((b) => b.className).filter((c) => /backend|frontend|design|testing/.test(c)).length
);
console.log("typed bars rendered:", barClasses);
const barColor = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".wx-bar")].find((b) => /backend/.test(b.className));
  return el ? getComputedStyle(el).backgroundColor : "none";
});
console.log("backend bar color (want 68,103,168):", barColor);
await page.screenshot({ path: "out/shot-types.png" });

/* 2) inline rename via double-click on name cell */
const cell = page.locator('[data-row-id][data-col-id=":text"]', { hasText: "API endpoints" }).first();
await cell.dblclick();
await page.waitForTimeout(500);
const editInput = page.locator('[data-col-id=":text"] input, .wx-cell input');
console.log("inline editor input count:", await editInput.count());
if (await editInput.count()) {
  await editInput.first().fill("API endpoints v2");
  await editInput.first().press("Enter");
  await page.waitForTimeout(400);
}
console.log("renamed cell visible:", await page.getByText("API endpoints v2").count());

/* editor type dropdown shows custom types */
await page.locator('[data-row-id][data-col-id=":text"]', { hasText: "QA pass" }).first().dblclick({ delay: 400 });
await page.waitForTimeout(300);

/* 3) projects: create new project, switch back */
await page.locator(".proj-toggle").click();
await page.waitForTimeout(300);
await page.screenshot({ path: "out/shot-menu.png" });
console.log("menu rows:", await page.locator(".proj-row").count());
await page.locator(".proj-new").click();
await page.waitForTimeout(800);
console.log("empty hint on new project:", await page.locator(".empty-card").count());
// rename new project
const h1 = page.locator(".project-name");
await h1.click();
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("Second project");
await page.keyboard.press("Enter");
// add a task in project 2
await page.getByText("New task", { exact: true }).click();
await page.waitForTimeout(2200);

// switch back to first project
await page.locator(".proj-toggle").click();
await page.waitForTimeout(300);
console.log("menu rows now:", await page.locator(".proj-row").count());
await page.locator(".proj-open", { hasText: "Project timeline" }).first().click();
await page.waitForTimeout(900);
console.log("back in p1, epic visible:", await page.getByText("Launch epic").count());
console.log("p1 has typed bars:", await page.evaluate(() => [...document.querySelectorAll(".wx-bar")].filter((b) => /backend|frontend/.test(b.className)).length));

/* 4) saved payload sanity */
await page.waitForTimeout(1800);
const saved = await page.evaluate(() => window.__published[window.__published.length - 1] || "");
const m = saved.match(/<script type="application\/json" id="gantt-data">([\s\S]*?)<\/script>/);
const data = m ? JSON.parse(m[1]) : null;
console.log("saved projects:", data && data.projects.map((p) => ({ n: p.name, t: p.tasks.length })));
console.log("saved title:", (saved.match(/<title>[^<]*<\/title>/) || [])[0]);
writeFileSync("out/roundtrip2.html", saved);

/* 5) reload round-trip with both projects */
const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
p2.on("pageerror", (e) => errors.push("p2: " + e.message));
await p2.goto("file:///home/claude/gantt/out/roundtrip2.html");
await p2.waitForTimeout(1500);
console.log("roundtrip epic:", await p2.getByText("Launch epic").count());
await p2.locator(".proj-toggle").click();
await p2.waitForTimeout(300);
console.log("roundtrip menu rows:", await p2.locator(".proj-row").count());
await p2.locator(".proj-open", { hasText: "Second project" }).click();
await p2.waitForTimeout(800);
console.log("roundtrip second project task:", await p2.getByText("New Task").count());
await p2.screenshot({ path: "out/shot-p2.png" });

/* 6) PDF with types */
await p2.locator(".proj-toggle").click();
await p2.waitForTimeout(200);
await p2.locator(".proj-open", { hasText: "Project timeline" }).click();
await p2.waitForTimeout(800);
await p2.getByRole("button", { name: /Export PDF/ }).click();
await p2.waitForTimeout(2200);
const savedPdf = await p2.evaluate(() => window.__saved[0] && window.__saved[0].data);
if (savedPdf) writeFileSync("out/export2.pdf", Buffer.from(savedPdf));
console.log("pdf exported:", !!savedPdf);

console.log("ERRORS:", errors.slice(0, 8));
await browser.close();
