/* global document, DCCWorkingQueue, petDeliveries */
// Needs You snooze regression: isolated PostgreSQL + the real queue API and UI.
// No .env, auth, live tasks, shared browser profile or external notifications.
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (
  !process.env.DCC_TEST_DATABASE_URL ||
  !["localhost", "127.0.0.1"].includes(new URL(process.env.DCC_TEST_DATABASE_URL).hostname)
)
  throw new Error("A disposable localhost database is required");
const APP_ZONE = "America/New_York";
const screenshotDir=process.env.DCC_QUEUE_SNOOZE_OUT||"/tmp/dcc-queue-snooze";
await fs.mkdir(screenshotDir,{recursive:true});
const ctx = await require("../test-support/activity-db").createActivityDb();
Object.assign(ctx, { APP_TIME_ZONE: APP_ZONE, broadcast() {} });
await ctx.pool.query(require("../conversation-store").FOREGROUND_INDEX_SQL);
const make = (id, title, p = {}) =>
  ctx.blockDB.createBlock({
    id,
    type: "block",
    date: "2099-01-02",
    user_id: 1,
    workspace_id: "ws-1",
    properties: { local_id: id, title, type: "task", duration: 30, status: "open", ...p }
  });
const startedAt = new Date(Date.now() - 120000).toISOString();
await make("fg", "Focused writing", { startedAt, workStateChangedAt: startedAt, activeWorkSessionId: "fixture-fg" });
await make("rev", "Draft needs review");
await make("blk", "Blocked on access");
await make("chk", "Check on export");
await make("plain", "Plain priority task");
process.env.DCC_CONVERSATION_ENABLED = "true";
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.session = { userId: 1 };
  req.workspaceId = "ws-1";
  res.set("Cache-Control", "no-store");
  next();
});
app.use("/public", express.static(path.join(root, "public")));
require("../routes/working-queue")(app, ctx);
app.get("/", (_req, res) =>
  res.type("html")
    .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"></head><body style="padding:20px"><div class="tab-content active" id="tab-working-queue"><div id="working-queue-root"></div></div><div id="toast-container"></div>
<script>window.__state={date:"2099-01-02"};window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'ws-1'};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/task-types.js"></script><script src="/public/js/task-model.js"></script>
<script>window.petDeliveries=[];DCC.PetNudge={deliverWorkCheckIn:async text=>{petDeliveries.push(text);}};</script><script src="/public/js/completed-queue-filter.js"></script><script src="/public/js/task-priority.js"></script><script src="/public/js/queue-policy.js"></script><script src="/public/js/working-queue.js"></script><script>dispatchEvent(new Event('dcc:data-ready'));</script></body></html>`)
);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + server.address().port;
// Setup goes through the same canonical command API the page uses.
const api = async (body) => {
  const state = await fetch(base + "/api/working-queue").then((r) => r.json());
  const res = await fetch(base + "/api/working-queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceEventId: "setup:" + crypto.randomUUID(), expectedRevision: state.revision, at: new Date().toISOString(), ...body })
  });
  assert.ok(res.ok, "setup " + body.action + ": " + (await res.text()));
};
for (const taskId of ["rev", "blk", "chk", "plain"]) await api({ action: "queue-add", taskId });
await api({ action: "queue-block", taskId: "blk", remindMinutes: null });
await api({ action: "background-start", taskId: "chk", remindMinutes: 5 });
await ctx.pool.query(
  "INSERT INTO delegated_work(user_id,workspace_id,task_id,work_key,report) VALUES(1,'ws-1','rev','fixture',$1)",
  [{ phase: "needs-review", reviewActions: ["Review the draft"], at: new Date().toISOString(), note: "Draft is ready for review", work: { source: "fixture", id: "w-rev" } }]
);
const queueItem = async (id) =>
  (await ctx.pool.query("SELECT state FROM work_rotations WHERE user_id=1 AND workspace_id='ws-1'")).rows[0].state.items[id];
// Simulates time passing: both deadlines move to the past together.
const expire = (id, snoozed = true) =>
  ctx.pool.query(
    "UPDATE work_rotations SET state=jsonb_set(jsonb_set(state,ARRAY['items',$1,'dueAt'],to_jsonb($2::text)),ARRAY['items',$1,'snoozedUntil'],$3::jsonb)",
    [id, new Date(Date.now() - 1000).toISOString(), snoozed ? JSON.stringify(new Date(Date.now() - 1000).toISOString()) : "null"]
  );
await expire("chk", false);
const fgBefore = (await ctx.blockDB.getBlock("fg")).properties;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});
// Browser zone differs from the app zone, so the label must come from the app.
const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, timezoneId: "Asia/Tokyo" });
await context.route("**/*", (r) => (new URL(r.request().url()).origin === base ? r.continue() : r.abort()));
const page = await context.newPage(),
  errors = [],
  writes = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.method() !== "GET" && r.url().includes("/api/")) writes.push(r.postDataJSON?.() || {});
});
const userWrites = () => writes.filter((w) => w.action !== "queue-claim");
const card = (id) => page.locator('[data-queue-id="' + id + '"]'),
  button = (id, action) => card(id).locator('[data-queue-action="' + action + '"]');
const dialog = () => page.getByRole("dialog");
const closed = () => page.waitForFunction(() => !document.querySelector("[role=dialog]"));
const inLane = (id, lane) =>
  page.waitForFunction(([id, lane]) => document.querySelector('[data-queue-id="' + id + '"]')?.closest(".wq-lane")?.classList.contains(lane), [id, lane]);
const passed = [];
const check = (name) => passed.push(name);
try {
  await page.goto(base);
  await page.waitForSelector('.wq-foreground [data-queue-id="fg"]');
  for (const id of ["rev", "blk", "chk"]) {
    await inLane(id, "wq-needs");
    assert.equal(await button(id, "snooze").count(), 1, id + " exposes Snooze");
  }
  assert.equal(await button("plain", "snooze").count(), 0, "Priority items without attention have no Snooze");
  assert.equal(await button("fg", "snooze").count(), 0, "Foreground has no Snooze");
  for (const id of ["rev", "blk"]) {
    assert.ok(await button(id, "return").isDisabled(), id + " cannot return to Priority while review is pending");
    assert.match(await card(id).textContent(), id === "blk" ? /Unblock this task before returning/ : /Resolve the review request before returning/);
  }
  check("every Needs You item exposes Snooze; review/blocked return is disabled with a reason");

  // Cancel and Escape write nothing.
  const before = userWrites().length;
  await button("rev", "snooze").click();
  await dialog().getByRole("button", { name: "Cancel" }).click();
  await closed();
  await button("rev", "snooze").click();
  await dialog().waitFor();
  await page.keyboard.press("Escape");
  await closed();
  await page.waitForTimeout(200);
  assert.equal(userWrites().length, before, "Cancel and Escape send no command");
  check("cancel and Escape");

  // Review request (no existing timer): custom 45 minutes, app-zone label,
  // one command despite a double click, exact retry after a lost request.
  await button("rev", "snooze").click();
  await dialog().locator("[data-minutes]").selectOption("custom");
  await dialog().locator("[data-custom] input").fill("45");
  const preview = await dialog().locator("[data-snooze-preview]").textContent();
  assert.match(preview, /^Snoozed until .*(EST|EDT)/, "preview uses the app timezone: " + preview);
  await page.screenshot({path:path.join(screenshotDir,"snooze-dialog-synthetic.png")});
  let dropped = 0;
  await page.route("**/api/working-queue", (r) =>
    r.request().method() === "POST" && r.request().postDataJSON().action === "queue-snooze" && !dropped++ ? r.abort() : r.continue()
  );
  await dialog().getByRole("button", { name: "Snooze", exact: true }).dblclick();
  await page.waitForFunction(() => /Snooze not confirmed/.test(document.querySelector("[role=dialog] [role=status]")?.textContent || ""));
  assert.ok(await dialog().locator("[data-minutes]").isDisabled(), "delay is locked to the saved command");
  await dialog().getByRole("button", { name: "Snooze", exact: true }).click();
  await closed();
  await page.unroute("**/api/working-queue");
  const snoozes = userWrites().filter((w) => w.action === "queue-snooze");
  assert.equal(snoozes.length, 2, "one aborted send plus one retry, no duplicate");
  assert.equal(snoozes[0].sourceEventId, snoozes[1].sourceEventId, "retry reuses the exact envelope");
  assert.equal(snoozes[0].at, snoozes[1].at, "retry keeps the original timestamp");
  assert.equal(snoozes[0].remindMinutes, 45);
  assert.equal("generation" in snoozes[0], false, "no generation is sent when the item had none");
  const rev = await queueItem("rev");
  assert.equal(Date.parse(rev.snoozedUntil) - Date.parse(snoozes[0].at), 45 * 60000, "chosen delay is stored");
  assert.equal(rev.generation, snoozes[0].sourceEventId);
  await inLane("rev", "wq-background");
  const label = await card("rev").locator(".wq-attention time").textContent();
  const expected = await page.evaluate(
    ([iso, timeZone]) => "Snoozed until " + new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(Date.parse(iso)),
    [rev.snoozedUntil, APP_ZONE]
  );
  assert.equal(label, expected, "card shows the stored time in the app timezone");
  const revText = await card("rev").textContent();
  assert.match(revText, /Attention snoozed · not focused time/);
  assert.match(revText, /still awaiting your review/);
  assert.match(revText, /Draft is ready for review/, "review details stay attached");
  assert.equal(await card("rev").locator(".wq-status").textContent(), "Snoozed");
  assert.ok(await button("rev", "return").isDisabled(), "snoozed item cannot return to Priority");
  await card("rev").scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(screenshotDir,"snoozed-background-synthetic.png")});
  check("review request snooze: chosen time, app timezone, exact retry, no duplicate");

  // Blocked (no existing timer) and existing check-back (with generation).
  const chkGeneration = (await queueItem("chk")).generation;
  for (const id of ["blk", "chk"]) {
    await button(id, "snooze").click();
    await dialog().locator("[data-minutes]").selectOption("15");
    await dialog().getByRole("button", { name: "Snooze", exact: true }).click();
    await closed();
    await inLane(id, "wq-background");
  }
  const chkSnooze = userWrites().filter((w) => w.action === "queue-snooze" && w.taskId === "chk").at(-1);
  assert.equal(chkSnooze.generation, chkGeneration, "existing check-back sends its current generation");
  assert.match(await card("blk").textContent(), /still blocked/);
  check("blocked and existing check-back snooze");

  // Resnooze: a fresh generation and deadline; the reason stays.
  const oldRev = await queueItem("rev");
  assert.equal(await button("rev", "snooze").textContent(), "Snooze again…");
  await button("rev", "snooze").click();
  await dialog().locator("[data-minutes]").selectOption("60");
  await dialog().getByRole("button", { name: "Snooze", exact: true }).click();
  await closed();
  const newRev = await queueItem("rev");
  assert.notEqual(newRev.generation, oldRev.generation, "resnooze rotates the generation");
  assert.equal(userWrites().filter((w) => w.taskId === "rev" && w.action === "queue-snooze").at(-1).generation, oldRev.generation, "resnooze sends the snoozed generation");
  assert.notEqual(newRev.snoozedUntil, oldRev.snoozedUntil);
  await inLane("rev", "wq-background");
  check("resnooze");

  // Dismiss snooze reveals the underlying blocked reason in Needs You now.
  await button("blk", "dismiss").click();
  await inLane("blk", "wq-needs");
  assert.equal(await card("blk").locator(".wq-status").textContent(), "Needs you");
  assert.ok(await button("blk", "return").isDisabled());
  assert.match(await card("blk").textContent(), /Unblock this task before returning/);
  check("dismiss snooze reveals the reason");

  // Reload keeps the snooze; expiry returns to Needs You and alerts once.
  await page.reload();
  await inLane("rev", "wq-background");
  await inLane("chk", "wq-background");
  await expire("rev");
  await expire("chk");
  await page.reload();
  await inLane("rev", "wq-needs");
  await inLane("chk", "wq-needs");
  assert.match(await card("rev").textContent(), /Draft is ready for review/, "reason survives expiry");
  // Each tick claims at most one due item; the server claim deduplicates.
  // Startup may already own tick; yield between explicit checks rather than
  // treating an in-flight tick as completion. Keep the assertion on delivery.
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => DCCWorkingQueue.tick());
    if (await page.evaluate(() => petDeliveries.length === 2)) break;
    await page.waitForTimeout(100);
  }
  await page.waitForFunction(() => petDeliveries.length === 2);
  const delivered = await page.evaluate(() => petDeliveries.slice());
  assert.equal(delivered.length, 2, "one pet notification per expired snooze: " + delivered.join(" | "));
  assert.ok(delivered.some((t) => t.includes("Draft needs review")) && delivered.some((t) => t.includes("Check on export")));
  check("reload, expiry and single notification");

  // Snooze never touched foreground, task timing or task rows.
  await page.waitForSelector('.wq-foreground [data-queue-id="fg"]');
  const fgAfter = (await ctx.blockDB.getBlock("fg")).properties;
  assert.equal(fgAfter.startedAt, fgBefore.startedAt, "foreground is unchanged");
  for (const id of ["rev", "blk", "chk"]) {
    const p = (await ctx.blockDB.getBlock(id)).properties;
    assert.equal(p.startedAt ?? null, null, id + " was not started");
    assert.equal(p.actualMinutes ?? null, null, id + " gained no focused time");
  }
  assert.ok(userWrites().every((w) => ["queue-snooze", "queue-dismiss"].includes(w.action)), "only snooze/dismiss commands were sent");
  check("no foreground, timer or task change");

  assert.deepEqual(errors, [], "no page errors");
  for (const name of passed) console.log("ok - " + name);
} finally {
  await browser.close();
  server.close();
  await ctx.close?.();
}
