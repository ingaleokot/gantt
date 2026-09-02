import { chromium } from "playwright";
import { writeFileSync } from "fs";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.addInitScript(() => { window.__ganttProbe = (api) => { window.__api = api; }; });
await page.goto("file:///home/claude/gantt/out/test.html");
await page.waitForTimeout(1500);

await page.getByText("New task", { exact: true }).click();
await page.waitForTimeout(800);
console.log("tasks after toolbar add:", await page.evaluate(() => JSON.stringify(window.__api.serialize({ data: "tasks" }))));
await page.screenshot({ path: "out/shot-after-add.png" });

// double-click the task bar or grid cell to open editor
const cell = page.locator(".wx-table .wx-cell, .wx-row .wx-cell, [class*=wx-text]").filter({ hasText: /New task/i }).first();
if (await cell.count()) { await cell.dblclick(); } else {
  const bar = page.locator("[class*=wx-bar]").first();
  await bar.dblclick();
}
await page.waitForTimeout(900);
const inputs = await page.locator("input, textarea").count();
console.log("editor inputs:", inputs);
if (inputs > 0) {
  const nameInput = page.locator("input").first();
  await nameInput.fill("Kickoff meeting");
  await nameInput.press("Enter");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
}
await page.waitForTimeout(2500);
console.log("published:", await page.evaluate(() => window.__published.length));
const saved = await page.evaluate(() => window.__published[window.__published.length - 1] || "");
console.log("saved contains Kickoff:", saved.includes("Kickoff meeting"));
await page.screenshot({ path: "out/shot-ui.png" });

if (saved) {
  writeFileSync("out/roundtrip.html", saved);
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  p2.on("pageerror", (e) => errors.push("p2 pageerror: " + e.message));
  await p2.goto("file:///home/claude/gantt/out/roundtrip.html");
  await p2.waitForTimeout(1800);
  console.log("roundtrip empty hint (want 0):", await p2.locator(".empty-card").count());
  console.log("roundtrip Kickoff visible:", await p2.getByText("Kickoff meeting").count());
  await p2.getByRole("button", { name: "Month" }).click();
  await p2.waitForTimeout(1200);
  console.log("month view Kickoff visible:", await p2.getByText("Kickoff meeting").count());
  await p2.screenshot({ path: "out/shot-month.png" });

  const p3 = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await p3.goto("file:///home/claude/gantt/out/roundtrip.html");
  await p3.waitForTimeout(1500);
  await p3.screenshot({ path: "out/shot-dark.png" });
}
console.log("ERRORS:", errors.slice(0, 8));
await browser.close();
