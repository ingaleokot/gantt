import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.addInitScript(() => { window.__ganttProbe = (api) => { window.__api = api; }; });
await p.goto("file:///home/claude/gantt/out/test.html");
await p.waitForTimeout(1500);

const iso = (d) => d && new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const get = (id) => p.evaluate((tid) => {
  const t = window.__api.getTask(tid);
  const f = (d) => d && (d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"));
  return { start: f(t.start), end: f(t.end), hours: t.hours, duration: t.duration };
}, id);

/* 2026-09-04 is a Friday; 2026-09-05/06 weekend */
await p.evaluate(() => {
  const api = window.__api;
  api.exec("add-task", { task: { id: "t1", text: "Crosses weekend", start: new Date(2026, 8, 4), hours: 21, type: "backend" } });
});
await p.waitForTimeout(400);
console.log("21h from Fri 4 Sep (want end 2026-09-09, Wed):", JSON.stringify(await get("t1")));

/* default add: 7h, one day */
await p.getByText("New task", { exact: true }).click();
await p.waitForTimeout(400);
const t2 = await p.evaluate(() => {
  const rows = [];
  const st = window.__api.getState();
  st.tasks._pool.forEach((t) => { if (t.id !== 0 && t.id !== "t1") rows.push(t.id); });
  return rows[0];
});
console.log("new task default:", JSON.stringify(await get(t2)));

/* start on Saturday rolls to Monday */
await p.evaluate((tid) => {
  window.__api.exec("update-task", { id: tid, task: { start: new Date(2026, 8, 5) } });
}, t2);
await p.waitForTimeout(300);
console.log("moved to Sat 5 Sep (want start 2026-09-07 Mon):", JSON.stringify(await get(t2)));

/* resize: extend end over the weekend -> hours from working days only */
await p.evaluate(() => {
  window.__api.exec("update-task", { id: "t1", task: { end: new Date(2026, 8, 11) } }); // Fri 4 .. Fri 11 excl = Fri,Mon..Thu = 5 wd
});
await p.waitForTimeout(300);
console.log("resized to end Fri 11 (want 35h, end 2026-09-11):", JSON.stringify(await get("t1")));

/* editor: open and check fields */
await p.locator('[data-row-id][data-col-id=":text"]', { hasText: "Crosses weekend" }).first().dblclick();
await p.waitForTimeout(700);
const labels = await p.evaluate(() => [...document.querySelectorAll(".wx-willow-theme label")].map((l) => l.textContent.trim()).filter(Boolean));
console.log("editor labels:", labels.slice(0, 8));
const hasHours = labels.some((l) => /Estimate/.test(l));
const noDuration = !labels.some((l) => /^Duration$/.test(l)) && !labels.some((l) => /End date/.test(l));
console.log("editor has hours field:", hasHours, "| no duration/end:", noDuration);
await p.keyboard.press("Escape");

/* grid Hours column */
const headers = await p.evaluate(() => [...document.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent.trim()));
console.log("grid headers:", headers);
await p.waitForTimeout(2000);
const saved = await p.evaluate(() => window.__published[window.__published.length - 1] || "");
const m = saved.match(/<script type="application\/json" id="gantt-data">([\s\S]*?)<\/script>/);
const data = m ? JSON.parse(m[1]) : null;
const st1 = data && data.projects[0].tasks.find((t) => t.id === "t1");
console.log("saved t1:", JSON.stringify(st1));
await p.screenshot({ path: "out/shot-hours.png" });
console.log("ERRORS:", errors.slice(0, 6));
await browser.close();
