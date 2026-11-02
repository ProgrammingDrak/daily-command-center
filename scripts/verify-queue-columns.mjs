/* global window, document */
// Working Queue column layout regression. Synthetic in-memory queue only: no
// database, no .env, no auth, no real tasks. Any write request fails the run.
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.now(),
  iso = (ms) => new Date(ms).toISOString();
const task = (id, title, p = {}) => ({
  id,
  type: "block",
  date: "2099-01-02",
  properties: { local_id: id, title, type: "task", status: "open", duration: 30, ...p }
});
const running = (id) => [
  {
    at: iso(now - 60000),
    phase: "working",
    note: "Synthetic worker report",
    reviewActions: [],
    work: { source: "fixture", id: "w-" + id },
    execution: { state: "running", observedAt: iso(now - 60000), validUntil: iso(now + 10 * 60000) }
  }
];
const fg = (id) => ({ task: task(id, "Focus " + id, { startedAt: iso(now - 120000) }), status: "foreground" });
const needs = (id) => ({ task: task(id, "Needs " + id), status: "background", needsYou: true, needsReview: true, note: "Synthetic review request" });
const queued = (id) => ({ task: task(id, "Priority " + id), status: "queued", taskPriority: "Medium" });
const bg = (id) => ({ task: task(id, "Background " + id), status: "background", delegated: running(id) });
const range = (n, prefix) => Array.from({ length: n }, (_, i) => prefix + i);
let revision = 1,
  queueItems = [];
function setQueue(list) {
  queueItems = list;
  revision += 1;
}
const writes = [],
  reads = [];
const app = express();
app.use((req, _res, next) => {
  if (req.path.startsWith("/api/")) (req.method === "GET" ? reads : writes).push(req.method + " " + req.path);
  next();
});
app.use("/public", express.static(path.join(root, "public")));
app.get("/api/working-queue", (_req, res) =>
  res.set("Cache-Control", "no-store").json({
    revision,
    foreground: [],
    timeZone: "UTC",
    queue: { items: queueItems, order: queueItems.map((i) => i.task.id), serverNow: iso(Date.now()) }
  })
);
app.all("/api/*", (_req, res) => res.status(500).json({ error: "Synthetic layout fixture is read-only" }));
const page = (glasses) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"><link rel="stylesheet" href="/public/css/device-views/glasses.css"></head><body${glasses ? ' class="device-glasses"' : ""} style="padding:20px"><div class="tab-content active" id="tab-working-queue"><div id="working-queue-root"></div></div><div id="toast-container"></div>
<script>window.__state={date:"2099-01-02"};window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'layout-fixture'};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/task-types.js"></script><script src="/public/js/task-model.js"></script><script src="/public/js/nav-state.js"></script><script src="/public/js/tabs.js"></script><script src="/public/js/completed-queue-filter.js"></script><script src="/public/js/task-priority.js"></script><script src="/public/js/queue-policy.js"></script><script src="/public/js/working-queue.js"></script><script>dispatchEvent(new Event('dcc:data-ready'));</script></body></html>`;
app.get("/", (req, res) => res.type("html").send(page(req.query.device === "glasses")));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route("**/*", (r) => (new URL(r.request().url()).origin === base ? r.continue() : r.abort()));
const tab = await context.newPage(),
  errors = [];
tab.on("pageerror", (e) => errors.push(e.message));
const LANE = { fg: ".wq-foreground", needs: ".wq-needs", next: ".wq-next", bg: ".wq-background" };
const boxes = () =>
  tab.evaluate((lanes) => {
    const out = {};
    for (const [k, sel] of Object.entries(lanes)) {
      const r = document.querySelector("#working-queue-root " + sel).getBoundingClientRect();
      out[k] = { top: r.top, bottom: r.bottom, left: r.left, height: r.height };
    }
    return out;
  }, LANE);
const domOrder = () =>
  tab.evaluate(() => [...document.querySelectorAll("#working-queue-root .wq-lane")].map((el) => el.classList[1]));
const load = async (list, url = "/") => {
  setQueue(list);
  await tab.goto(base + url);
  await tab.evaluate(() => localStorage.clear());
  await tab.goto(base + url);
  await tab.waitForFunction((n) => document.querySelectorAll("#working-queue-root .wq-card").length === n, list.length);
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1, msg + " (" + a + " vs " + b + ")");
const GAP = 18;
const passed = [];
const screenshotDir=process.env.DCC_QUEUE_COLUMNS_OUT||"/tmp/dcc-queue-columns";
await fs.mkdir(screenshotDir,{recursive:true});
const check = (name) => passed.push(name);
try {
  // 1. Tall Needs You, short Foreground: Priority sits directly under Foreground.
  await load([fg("f0"), ...range(8, "n").map(needs), ...range(2, "p").map(queued), bg("b0")]);
  let b = await boxes();
  assert.ok(b.needs.height > b.fg.height * 3, "fixture makes Needs You much taller than Foreground");
  near(b.next.top, b.fg.bottom + GAP, "Priority sits immediately below Foreground");
  near(b.needs.top, b.fg.top, "Needs You starts level with Foreground");
  assert.ok(b.fg.left < b.needs.left, "Foreground is in the left column");
  near(b.next.left, b.fg.left, "Priority shares the left column");
  near(b.bg.left, b.needs.left, "Background shares the right column");
  near(b.bg.top, b.needs.bottom + GAP, "Background sits immediately below Needs You");
  assert.deepEqual(await domOrder(), ["wq-foreground", "wq-next", "wq-needs", "wq-background"], "desktop DOM matches visual column order");
  await tab.screenshot({path:path.join(screenshotDir,"independent-columns-desktop-synthetic.png")});
  check("tall Needs You does not stretch Foreground or push Priority");

  // 2. Opposite heights: tall Priority leaves Background directly under Needs You.
  await load([fg("f0"), needs("n0"), ...range(9, "p").map(queued), bg("b0")]);
  b = await boxes();
  assert.ok(b.next.bottom > b.needs.bottom + 200, "fixture makes the left column much taller");
  near(b.bg.top, b.needs.bottom + GAP, "Background is not pushed by a tall Priority");
  near(b.next.top, b.fg.bottom + GAP, "Priority still follows Foreground");
  check("tall Priority does not push Background");

  // 3. Dynamic growth: opening context, and a refresh adding more Needs You rows.
  await load([fg("f0"), ...range(2, "n").map(needs), queued("p0"), bg("b0")]);
  const before = await boxes();
  await tab.locator('[data-queue-id="n0"] .wq-context > summary').click();
  b = await boxes();
  assert.ok(b.needs.height > before.needs.height, "opening context grows Needs You");
  near(b.next.top, before.next.top, "Priority does not move when Needs You grows");
  near(b.fg.height, before.fg.height, "Foreground keeps its own height when Needs You grows");
  setQueue([fg("f0"), ...range(10, "n").map(needs), queued("p0"), bg("b0")]);
  await tab.evaluate(() => window.DCCWorkingQueue.refresh());
  await tab.waitForFunction(() => document.querySelectorAll(".wq-needs .wq-card").length === 10);
  b = await boxes();
  near(b.next.top, before.next.top, "Priority stays put after a refresh adds Needs You rows");
  near(b.bg.top, b.needs.bottom + GAP, "Background follows the grown Needs You");
  check("dynamic growth stays within its own column");

  // 4. Mobile single column keeps Foreground, Needs You, Priority, Background.
  await tab.setViewportSize({ width: 600, height: 900 });
  await load([fg("f0"), ...range(3, "n").map(needs), ...range(2, "p").map(queued), bg("b0")]);
  const stackedOrder = ["wq-foreground", "wq-needs", "wq-next", "wq-background"];
  assert.deepEqual(await domOrder(), stackedOrder, "mobile DOM order");
  b = await boxes();
  assert.ok(b.fg.bottom <= b.needs.top && b.needs.bottom <= b.next.top && b.next.bottom <= b.bg.top, "mobile visual order");
  near(b.needs.left, b.fg.left, "mobile is one column");
  near(b.next.left, b.fg.left, "mobile is one column");
  const tabOrder = await tab.evaluate(() => {
    const seen = [];
    for (const el of document.querySelectorAll("#working-queue-root .wq-card")) {
      const lane = el.closest(".wq-lane").classList[1];
      if (seen.at(-1) !== lane) seen.push(lane);
    }
    return seen;
  });
  assert.deepEqual(tabOrder, stackedOrder, "keyboard order of cards follows mobile lane order");
  check("mobile single column order");

  // 5. Breakpoint changes move lanes without re-rendering and keep focus, open
  //    details and control behavior. Layout must cause no requests at all.
  await tab.locator('[data-queue-id="n1"] .wq-context > summary').click();
  await tab.evaluate(() => {
    document.querySelector('[data-queue-id="n1"]').dataset.layoutMarker = "kept";
    document.querySelector('[data-queue-id="p0"]').dataset.layoutMarker = "kept";
  });
  const control = '[data-queue-id="n1"] [data-queue-action="priority"]';
  await tab.locator(control).focus();
  const readsBefore = reads.length,
    writesBefore = writes.length;
  const focusState = () =>
    tab.evaluate((sel) => ({
      same: document.activeElement === document.querySelector(sel),
      markers: document.querySelectorAll("[data-layout-marker=kept]").length,
      open: document.querySelector('[data-queue-id="n1"] .wq-context').open,
      order: [...document.querySelectorAll("#working-queue-root .wq-lane")].map((el) => el.classList[1])
    }), control);
  for (const [width, order] of [
    [1280, ["wq-foreground", "wq-next", "wq-needs", "wq-background"]],
    [600, stackedOrder],
    [1280, ["wq-foreground", "wq-next", "wq-needs", "wq-background"]]
  ]) {
    await tab.setViewportSize({ width, height: 900 });
    await tab.waitForFunction((o) => [...document.querySelectorAll("#working-queue-root .wq-lane")].map((el) => el.classList[1]).join() === o.join(), order);
    const s = await focusState();
    assert.ok(s.same, "focus stays on the moved control at width " + width);
    assert.equal(s.markers, 2, "cards are moved, not re-rendered, at width " + width);
    assert.ok(s.open, "open context survives the move at width " + width);
  }
  // Moving a lane that does not hold focus also leaves focus alone.
  await tab.locator('[data-queue-id="f0"] [data-queue-action="background"]').focus();
  await tab.setViewportSize({ width: 600, height: 900 });
  await tab.waitForFunction(() => document.querySelector(".wq-col").children.length === 2 && document.querySelector(".wq-col .wq-needs"));
  assert.equal(await tab.evaluate(() => document.activeElement.closest("[data-queue-id]")?.dataset.queueId), "f0", "unmoved focus is untouched");
  assert.equal(reads.length - readsBefore, 0, "breakpoint changes make no reads");
  assert.equal(writes.length - writesBefore, 0, "breakpoint changes make no writes");
  // The moved control still works: it opens the Priority dialog, cancel writes nothing.
  await tab.locator(control).press("Enter");
  await tab.getByRole("dialog").waitFor();
  assert.ok(await tab.getByRole("dialog").getByText("Set priority").count(), "moved control opens its dialog");
  await tab.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await tab.waitForFunction(() => !document.querySelector("[role=dialog]"));
  check("breakpoint transitions preserve focus, open state and controls");

  // 6. Glasses: always one column in DOM order, even on a wide viewport.
  await tab.setViewportSize({ width: 1280, height: 900 });
  await load([fg("f0"), ...range(3, "n").map(needs), ...range(2, "p").map(queued), bg("b0")], "/?device=glasses");
  assert.deepEqual(await domOrder(), stackedOrder, "glasses DOM order");
  b = await boxes();
  near(b.next.left, b.fg.left, "glasses is one column");
  assert.ok(b.fg.bottom <= b.needs.top && b.needs.bottom <= b.next.top && b.next.bottom <= b.bg.top, "glasses visual order");
  await tab.setViewportSize({ width: 600, height: 900 });
  await tab.setViewportSize({ width: 1280, height: 900 });
  assert.deepEqual(await domOrder(), stackedOrder, "glasses order survives breakpoint changes");
  await tab.screenshot({path:path.join(screenshotDir,"independent-columns-glasses-synthetic.png")});
  check("glasses stays single column");

  assert.deepEqual(writes, [], "layout fixture saw no write requests");
  assert.deepEqual(errors, [], "no page errors");
  for (const name of passed) console.log("ok - " + name);
} finally {
  await browser.close();
  server.close();
}
