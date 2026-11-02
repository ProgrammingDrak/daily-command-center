/* global document, window, switchToDate, sessionStorage, localStorage */
// Actual toggle and relocated recovery, against the disposable review server only.
// Start it with: DCC_REVIEW_ACTUAL=1 PORT=18781 node scripts/ui-review-server.mjs
// The browser runs with a UTC device clock while the app zone is New York, so a
// device-zone reading of an ISO entry would move it and fail these checks.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const base = process.env.DCC_ACTUAL_REVIEW_URL || "http://127.0.0.1:18781";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "loopback review server only");
assert.equal((await fetch(base + "/api/health").then((r) => r.json())).reviewOnly, true, "review-only server");
const out = process.env.DCC_ACTUAL_REVIEW_OUT || "test-results/task-workspace-actual";
await fs.mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", acceptDownloads: true });
await context.route("**/*", (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
const page = await context.newPage();
const errors = [], checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (name) => { checks.push(name); console.log("PASS " + name); };
const HOUR_PX = 48;
const chip = (id) => page.locator(`#list-view .it-list-item[data-id="${id}"] .it-actual`);
const ready = () => page.waitForFunction(() => !!window.DCC?.nav && !!window.DCC?.ActualProjection);

try {
  await page.goto(base + "/");
  await ready();
  assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "UTC", "device clock is UTC");
  const today = await page.evaluate(() => window.DCC.dates.todayKey());
  const seeded = await fetch(base + "/api/review/actual/seed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ today }) }).then((r) => r.json());
  assert.equal(seeded.today, today);

  // ── List ──
  await page.goto(base + "/?tab=tasks&view=list");
  await ready();
  await page.waitForSelector('#list-view .it-list-item[data-id="actual-a"]');
  assert.equal(await page.locator("#actual-summary").isHidden(), true, "no evidence while Actual is off");
  assert.equal(await chip("actual-a").count(), 0);
  await page.locator("#task-actual-toggle").click();
  await page.waitForSelector("#actual-summary:not([hidden])");
  assert.equal(new URL(page.url()).searchParams.get("actual"), "1");
  assert.equal((await chip("actual-a").innerText()).trim(), "Actual 30m · 9:15 AM to 9:35 AM · 10m without a clock time", "app-zone clock, not UTC");
  assert.equal((await chip("actual-b").innerText()).trim(), "Actual time unknown");
  assert.equal((await chip("actual-c").innerText()).trim(), "Actual 15m · 15m without a clock time", "other-day instant is never placed");
  assert.equal((await chip("actual-d1").innerText()).trim(), "No recorded actual", "an earlier same-title task does not claim the entry");
  assert.equal((await chip("actual-d2").innerText()).trim(), "Actual 15m · 1:05 PM to 1:20 PM");
  assert.equal((await chip("actual-e").innerText()).trim(), "Actual 10m · 11:40 PM to 11:50 PM", "near-midnight entry stays on its New York day");
  const summary = await page.locator("#actual-summary").innerText();
  assert.match(summary, /1h 10m\s*Known actual/);
  assert.match(summary, /25m\s*Without a clock time/);
  assert.match(summary, /7m\s*Unknown time \(not focused\)/);
  assert.equal(await page.locator('#actual-summary [data-completion-review]').count(), 1);
  assert.equal(await page.locator("#actual-view").isHidden(), true, "Day review is not shown in place of the List");
  assert.equal(await page.locator("#list-view").isVisible(), true);
  check("List Actual chips and totals for positioned, unplaced, unknown, other-day, duplicate-title and near-midnight evidence");

  await page.locator(".actual-review-toggle").click();
  await page.waitForSelector("#actual-view .dr-root");
  assert.equal(await page.locator("#list-view").isVisible(), true);
  await page.locator(".actual-review-toggle").click();
  assert.equal(await page.locator("#actual-view").isHidden(), true);
  check("Day review opens only as an explicit panel above the List");

  // ── Date switch keeps the toggle and re-reads that day's evidence ──
  await page.evaluate((d) => switchToDate(d), seeded.yesterday);
  await page.waitForSelector('#list-view .it-list-item[data-id="actual-y"] .it-actual');
  assert.equal((await chip("actual-y").innerText()).trim(), "Actual 30m · 8:10 AM to 8:40 AM");
  assert.equal(await chip("actual-a").count(), 0);
  await page.evaluate((d) => switchToDate(d), today);
  await page.waitForSelector('#list-view .it-list-item[data-id="actual-a"] .it-actual');
  check("date switch re-reads Actual evidence for the viewed day");

  // ── Calendar ──
  await page.locator("#task-view-calendar").click();
  await page.waitForSelector(`.iwc-day-col[data-day="${today}"] .iwc-actual-seg`);
  const segments = await page.locator(`.iwc-day-col[data-day="${today}"] .iwc-actual-seg`).evaluateAll((nodes) => nodes.map((n) => ({ top: parseFloat(n.style.top), height: parseFloat(n.style.height), label: n.getAttribute("aria-label") })));
  const expectTop = (h, m) => (h * 60 + m) / 60 * HOUR_PX;
  assert.deepEqual(segments.map((s) => s.top), [expectTop(9, 15), expectTop(13, 5), expectTop(23, 40)], JSON.stringify(segments));
  assert.deepEqual(segments.map((s) => Math.round(s.height)), [16, 12, 8]);
  assert.match(segments[0].label, /^Recorded 20m at 9:15 AM on Actual focus/);
  const dayNote = await page.locator(`.iwc-all-day[data-day="${today}"] .iwc-actual-day`).innerText();
  assert.match(dayNote, /25m without a clock time/);
  assert.match(dayNote, /7m unknown/);
  assert.equal(await page.locator(`.iwc-day-col[data-day="${today}"] .iwc-actual-seg[aria-label*="Actual other day"]`).count(), 0, "no segment at a planned time");
  check("Calendar plots only positioned segments at their app-zone clock and totals the rest per day");

  await page.locator(`.iwc-day-col[data-day="${today}"] [data-event-id="actual-a"]`).click();
  await page.waitForSelector(".iwc-inspector:not([hidden]) .iwc-actual");
  await page.locator('.iwc-inspector [name="title"]').fill("Actual focus draft");
  await page.locator("#task-actual-toggle").click();
  assert.equal(await page.locator(".iwc-actual-seg").count(), 0, "toggle off clears the layer");
  assert.equal(await page.locator('.iwc-inspector [name="title"]').inputValue(), "Actual focus draft", "toggle repaints without rebuilding the inspector");
  assert.equal(await page.locator(".iwc-inspector .iwc-actual").count(), 0);
  await page.locator("#task-actual-toggle").click();
  await page.waitForSelector(`.iwc-day-col[data-day="${today}"] .iwc-actual-seg`);
  assert.equal(await page.locator(".iwc-inspector .iwc-actual").count(), 1);
  await page.locator('.iwc-inspector [name="title"]').fill("Actual focus");
  check("Calendar toggle off/on repaints the layer and keeps inspector fields");
  // Captured while the Calendar with Actual on is still showing.
  await page.screenshot({ path: path.join(out, "actual-calendar-1440.png") });

  // ── Relocated recovery: synthetic in-memory commitment adapter ──
  // Installed after load each time, backed by sessionStorage so it survives reload.
  await context.addInitScript(() => {
    window.addEventListener("load", () => {
      const read = () => JSON.parse(sessionStorage.getItem("review-commitment-outbox") || "[]");
      const write = (rows) => sessionStorage.setItem("review-commitment-outbox", JSON.stringify(rows));
      const calls = () => JSON.parse(sessionStorage.getItem("review-commitment-calls") || "[]");
      const log = (entry) => sessionStorage.setItem("review-commitment-calls", JSON.stringify(calls().concat([entry])));
      if (!sessionStorage.getItem("review-commitment-outbox")) write([{ actionId: "review-action-1", status: 409, error: "This changed elsewhere", body: { kind: "check_in", note: "Retained synthetic evidence" } }]);
      window.DCCCommitmentSync = Object.assign({}, window.DCCCommitmentSync, {
        pending: async () => read(),
        retry: async (id) => { log({ op: "retry", id }); },
        discard: async (id) => { log({ op: "discard", id }); write(read().filter((row) => row.actionId !== id)); },
        get summary() { return { pending: read().length, attention: read().some((r) => r.error) }; }
      });
    });
  });
  await page.goto(base + "/?tab=tasks&view=queue");
  await ready();
  // The overlay fades before it detaches and restores focus, so every close is
  // awaited before asserting focus or reopening; every locator is scoped to
  // the one open overlay.
  const overlayClosed = () => page.waitForFunction(() => !document.querySelector(".dcc-overlay"));
  const statusPanel = () => page.locator(".dcc-overlay");
  const openStatus = async (keyboard = false) => {
    await overlayClosed();
    if (keyboard) { await page.locator("#save-status").focus(); await page.keyboard.press("Enter"); }
    else await page.locator("#save-status").click();
    await page.waitForSelector(".dcc-overlay .dcc-save-commitments");
    assert.equal(await statusPanel().count(), 1, "exactly one status overlay");
  };
  await openStatus(true);
  assert.match(await statusPanel().locator(".dcc-save-commitments").innerText(), /check_in[\s\S]*This changed elsewhere/);
  await page.keyboard.press("Escape");
  await overlayClosed();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "save-status", "focus returns to the dot");
  await page.locator('[data-page="budget"]').click();
  await page.reload();
  await ready();
  await openStatus();
  await statusPanel().locator(".dcc-save-commitment").getByRole("button", { name: "Retry same change" }).click();
  await overlayClosed();
  await openStatus();
  const [download] = await Promise.all([page.waitForEvent("download"), statusPanel().locator("[data-export-pending]").click()]);
  const exported = JSON.parse(await fs.readFile(await download.path(), "utf8"));
  assert.deepEqual(exported.commitments.map((r) => [r.actionId, r.body.note]), [["review-action-1", "Retained synthetic evidence"]]);
  const discard = statusPanel().locator(".dcc-save-commitment").getByRole("button", { name: /discard/i });
  await discard.click();
  assert.equal(await discard.innerText(), "Confirm discard");
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("review-commitment-calls") || "[]")), [{ op: "retry", id: "review-action-1" }], "first Discard click discards nothing");
  await discard.click();
  await overlayClosed();
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("review-commitment-calls"))), [{ op: "retry", id: "review-action-1" }, { op: "discard", id: "review-action-1" }]);
  check("commitment recovery: keyboard open, kept across nav and reload, same-ID retry, export, two-step discard");

  // ── Queue conflict recovery from the dot ──
  await page.evaluate(() => {
    const ctx = window.DCC_ACCOUNT_CONTEXT;
    localStorage.setItem("dcc-working-queue:" + ctx.workspaceId + ":" + ctx.userId + ":conflict", JSON.stringify({ body: { action: "queue-reorder", sourceEventId: "review-conflict" }, message: "Queue changed elsewhere" }));
  });
  await page.reload();
  await ready();
  assert.equal(await page.locator("#save-status").getAttribute("data-remote-state"), "needs-attention");
  assert.match(await page.locator("#save-status").getAttribute("aria-label"), /Queue update needs review/);
  await overlayClosed();
  await page.locator("#save-status").focus();
  await page.keyboard.press("Enter");
  await statusPanel().getByRole("button", { name: "Review queue update" }).click();
  await page.waitForSelector(".dcc-overlay pre");
  assert.equal(await page.locator(".dcc-overlay pre").count(), 1);
  assert.match(await page.locator(".dcc-overlay pre").innerText(), /review-conflict/);
  check("queue conflict is announced on the dot and reviewable by keyboard");

  await page.screenshot({ path: path.join(out, "queue-conflict-1440.png") });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, "checks.json"), JSON.stringify({ checks, errors, synthetic: true }, null, 2));
} finally {
  await browser.close();
}
