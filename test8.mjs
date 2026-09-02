import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const errors = [];

/* A) DB has data: page must load it (no static data anywhere) */
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
p.on("pageerror", (e) => errors.push("A: " + e.message));
await p.addInitScript(() => {
  window.__ganttProbe = (api) => { window.__api = api; };
  window.__dbStore = {
    active: "prj1",
    projects: [{ id: "prj1", name: "New platform", view: "day" }, { id: "prj2", name: "Second", view: "week" }],
    tasks: [
      { id: "e1", project: "prj1", parent: null, text: "Авторизация и регистрация", type: "summary", start: "2026-08-18", end: "2026-08-25", duration: 7, hours: 59.5, days: 8.5, progress: 0, details: "", open: true },
      { id: "t1", project: "prj1", parent: "e1", text: "Frontend", type: "frontend", start: "2026-08-18", end: "2026-08-25", duration: 7, hours: 31.5, days: 4.5, progress: 0, details: "", open: null },
      { id: "t2", project: "prj1", parent: "e1", text: "Backend", type: "backend", start: "2026-08-18", end: "2026-08-22", duration: 4, hours: 28, days: 4, progress: 38, details: "", open: null },
    ],
    links: [{ id: "l1", project: "prj1", source: "t1", target: "t2", type: "e2s" }],
  };
});
await p.goto("file:///home/claude/gantt/out/test.html");
await p.waitForTimeout(2200);
console.log("A project name:", (await p.locator(".project-name").textContent()).trim());
console.log("A epic visible:", await p.getByText("Авторизация и регистрация").count());
console.log("A frontend task:", await p.getByText("Frontend", { exact: true }).count());
await p.locator(".proj-toggle").click();
await p.waitForTimeout(300);
console.log("A projects in menu:", await p.locator(".proj-row").count());
await p.keyboard.press("Escape");
await p.evaluate(() => document.body.click());
await p.waitForTimeout(300);

/* edit -> relational save SQL */
await p.evaluate(() => { window.__api.exec("add-task", { task: { id: "t3", text: "QA işi", start: new Date(2026, 7, 24), hours: 7, type: "testing", parent: "e1" } }); });
await p.waitForTimeout(2400);
const sqls = await p.evaluate(() => (window.__sql || []).map((s) => s.query));
const save = sqls.find((q) => q.includes("insert into public.tasks"));
console.log("A save has projects upsert:", sqls.some((q) => q.includes("insert into public.projects")));
console.log("A save has tasks insert:", !!save);
console.log("A save keeps both projects:", save && save.includes("'prj2'") || sqls.some((q) => q.includes("'Second'")));
console.log("A save has QA row:", sqls.some((q) => q.includes("QA i")));
console.log("A save has app_state:", sqls.some((q) => q.includes("app_state")));
console.log("A save has link row:", sqls.some((q) => q.includes("insert into public.links") && q.includes("'l1'")));
console.log("A no gantt_store refs:", !sqls.some((q) => q.includes("gantt_store")));
console.log("A chip:", await p.locator(".save-chip").textContent().catch(() => "none"));
console.log("A no static data in page:", await p.evaluate(() => !document.getElementById("gantt-data")));
console.log("A localStorage untouched:", await p.evaluate(() => localStorage.getItem("gantt-local") === null));

/* B) empty DB: default empty project, first save inserts it */
const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
p2.on("pageerror", (e) => errors.push("B: " + e.message));
await p2.addInitScript(() => { window.__ganttProbe = (api) => { window.__api = api; }; try { localStorage.clear(); } catch (e) {} });
await p2.goto("file:///home/claude/gantt/out/test.html");
await p2.waitForTimeout(1800);
console.log("B empty hint:", await p2.locator(".empty-card").count());
await p2.getByText("New task", { exact: true }).click();
await p2.waitForTimeout(2400);
const sqls2 = await p2.evaluate(() => (window.__sql || []).map((s) => s.query));
console.log("B first save creates project:", sqls2.some((q) => q.includes("insert into public.projects")));
console.log("B first save inserts task:", sqls2.some((q) => q.includes("insert into public.tasks")));

console.log("ERRORS:", errors.slice(0, 8));
await browser.close();
