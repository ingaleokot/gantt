import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const errors = [];

/* A) empty remote: edits should upsert to supabase */
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
p.on("pageerror", (e) => errors.push("A: " + e.message));
await p.addInitScript(() => { window.__ganttProbe = (api) => { window.__api = api; }; });
await p.goto("file:///home/claude/gantt/out/test.html");
await p.waitForTimeout(1500);
await p.getByText("New task", { exact: true }).click();
await p.waitForTimeout(2400);
const sql = await p.evaluate(() => window.__sql || []);
console.log("A queries:", sql.map((s) => s.query.slice(0, 60)));
const upsert = sql.find((s) => s.query.includes("insert into public.gantt_store"));
console.log("A upsert present:", !!upsert, "| escaped ok:", upsert && upsert.query.includes("'main'"));
console.log("A chip:", await p.locator(".save-chip").textContent().catch(() => "none"));

/* B) remote newer: page should adopt supabase copy */
const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
p2.on("pageerror", (e) => errors.push("B: " + e.message));
await p2.addInitScript(() => {
  window.__ganttProbe = (api) => { window.__api = api; };
  try { localStorage.clear(); } catch (e) {}
  window.__sqlSelect = [{
    saved_at: 99999999999999,
    data: {
      version: 2,
      activeProject: "px",
      savedAt: 99999999999999,
      projects: [{
        id: "px", name: "From Supabase", view: "day",
        tasks: [{ id: "s1", text: "Synced task", start: "2026-09-03", duration: 4, type: "backend" }],
        links: [],
      }],
    },
  }];
});
await p2.goto("file:///home/claude/gantt/out/test.html");
await p2.waitForTimeout(2000);
console.log("B project name:", await p2.locator(".project-name").textContent());
console.log("B synced task visible:", await p2.getByText("Synced task").count());

/* it's-a-quote escaping round trip through dbSave */
await p2.evaluate(() => {
  window.__api.exec("add-task", { task: { text: "it's O'Brien's task", start: new Date(2026, 8, 8), duration: 2 } });
});
await p2.waitForTimeout(2400);
const sql2 = await p2.evaluate(() => (window.__sql || []).filter((s) => s.query.includes("insert")));
const last = sql2[sql2.length - 1];
console.log("B upsert has escaped quotes:", last && last.query.includes("it''s O''Brien''s"));

console.log("ERRORS:", errors.slice(0, 8));
await browser.close();
