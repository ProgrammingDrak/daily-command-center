/* global window, document, scheduled, moveTaskViaPlacement, _schedPickDay, closeSchedulePicker, _schedCommitting, Event */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
const base = process.argv[2] || "http://127.0.0.1:3996";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const checks = [], errors = [];
page.on("pageerror", e => errors.push(e.message));
const date = "2099-11-02";
async function boot() { await page.goto(base); await page.waitForFunction(() => window.blockStore && typeof moveTaskViaPlacement === "function" && scheduled.some(e => e.id === "browser-move")); }
async function open() { await page.evaluate(date => moveTaskViaPlacement("browser-move", date), date); await page.waitForSelector(".sched-block-list"); }
async function config(blocks) { const r = await page.request.post(base + "/api/time-block-review/config", { data: { blocks } }); assert.equal(r.status(), 200); }
async function row() { return (await page.request.get(base + "/api/blocks/browser-move")).json(); }
try {
  await boot(); await open();
  await page.getByRole("button", { name: "Focus & planning · 9 AM", exact: true }).waitFor();
  assert.equal(await page.locator("#sched-after-chips").getByRole("button", { name: "8 AM", exact: true }).count(), 0);
  checks.push("configured name/start list replaces hard-coded move presets");
  fs.mkdirSync("test-results/time-block-placement", { recursive: true });
  await page.screenshot({ path: "test-results/time-block-placement/mobile.png", fullPage: true });
  await page.locator("#sched-picker-title").fill("Edited synthetic task");
  await page.getByRole("button", { name: "Focus & planning · 9 AM", exact: true }).dblclick();
  await page.waitForFunction(() => !document.getElementById("sched-picker-overlay").classList.contains("open"));
  let saved = await row(); assert.equal(saved.properties.start, "10:00"); assert.equal(saved.properties.title, "Edited synthetic task");
  assert.equal(await page.evaluate(() => scheduled.find(e => e.id === "browser-move").untimed), false);
  checks.push("double click appends once after existing work and persists edited title");
  await boot(); saved = await row(); assert.equal(saved.properties.start, "10:00"); assert.equal(await page.evaluate(() => scheduled.find(e => e.id === "browser-move").untimed), false);
  checks.push("reload keeps same task timed at persisted placement");
  await open(); assert.equal(await page.locator("#sched-after-back").isEnabled(), true); assert.equal(await page.locator("#sched-custom-go").isEnabled(), true);
  await page.locator("#sched-after-back").click(); await page.evaluate(() => _schedPickDay("2099-11-02"));
  await page.keyboard.press("Escape"); await open(); await page.getByRole("button", { name: "Focus & planning · 9 AM", exact: true }).waitFor();
  checks.push("back, cancel, reopen keep controls usable");
  await page.evaluate(() => closeSchedulePicker());
  await config([{ id: "full", name: "Full block", start: "09:00", end: "09:15" }]); await open();
  await page.getByRole("button", { name: "Full block · 9 AM", exact: true }).click();
  await page.waitForFunction(() => !_schedCommitting);
  assert.equal(await page.locator("#sched-picker-overlay").evaluate(e => e.classList.contains("open")), true);
  assert.equal((await row()).properties.start, "10:00");
  await page.locator("#sched-block-error").filter({ hasText: "Not enough space" }).waitFor();
  checks.push("insufficient space is explained inline, keeps dialog open and task unchanged");
  await page.evaluate(() => closeSchedulePicker());
  await config([{ id: "a", name: "Same start A", start: "14:00", end: "16:00" }, { id: "b", name: "Same start B", start: "14:00", end: "15:00" }, { id: "off", name: "Disabled", enabled: false }]); await open();
  await page.getByRole("button", { name: "Same start A · 2 PM", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Same start B · 2 PM", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /Disabled ·/ }).count(), 0);

  checks.push("changed config and repeated starts retain distinct choices; disabled blocks hidden");
  await page.evaluate(() => closeSchedulePicker()); await config([]); await open();
  await page.getByText("No active time blocks on this day. Set a time manually or choose another day.", { exact: true }).waitFor();
  await page.evaluate(() => { const e = document.getElementById("sched-custom-time"); e.value = "15:15"; e.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.locator("#sched-custom-go").click();
  await page.waitForFunction(() => scheduled.find(e => e.id === "browser-move")?.start === "15:15");
  await boot(); assert.equal((await row()).properties.start, "15:15");
  checks.push("empty config preserves custom manual entry and durable same-day scheduling");
  await config([{ id: "focus" }]); await open(); await page.getByRole("button", { name: "Focus · 9 AM", exact: true }).waitFor();
  await page.route("**/api/blocks/browser-move/reschedule", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic save failed" }) }));
  await page.getByRole("button", { name: "Focus · 9 AM", exact: true }).click(); await page.waitForFunction(() => !_schedCommitting);
  assert.equal(await page.locator("#sched-picker-overlay").evaluate(e => e.classList.contains("open")), true); assert.equal((await row()).properties.start, "15:15");
  checks.push("failed save keeps picker open, no success or deferred capacity write");
  assert.deepEqual(errors, []);
  fs.writeFileSync("test-results/time-block-placement/browser.json", JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally { await browser.close(); }
