// Real server/session/browser integration. Run only against a disposable local DB.
/* global window, document, localStorage, setTimeout */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const base = process.env.DCC_AUTH_QA_URL || "http://localhost:8462";
const db = process.env.DCC_TEST_DATABASE_URL;
if (
  process.env.DCC_POMODORO_AUTH_QA !== "1" ||
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname) ||
  !db ||
  !["localhost", "127.0.0.1"].includes(new URL(db).hostname) ||
  !new URL(db).pathname.startsWith("/dcc_pomodoro_review_")
)
  throw new Error("Explicit disposable localhost app/database required");
const username = process.env.SEED_USERNAME || "pomodoro-review",
  password = process.env.SEED_PASSWORD || "local-review-only";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
  // No external integrations, real credentials, or shared browser profiles.
  await context.route("**/*", (r) => (new URL(r.request().url()).origin === base ? r.continue() : r.abort()));
  const page = await context.newPage(),
    errors = [],
    assets = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (/\/public\/js\/(app-config|pomodoro-model|pomodoro|working-queue)\.js(?:\?|$)/.test(r.url()))
      assets.push({ url: r.url(), status: r.status(), cache: r.headers()["cache-control"] });
  });
  const login = async () => {
    const r = await context.request.post(base + "/api/auth/login", { data: { username, password } });
    assert.equal(r.status(), 200);
  };
  const suppressTour = async () => {
    const r = await context.request.patch(base + "/api/me/onboarding", {
      data: { dailyCommandCenterTour: { version: 2, dismissedAt: new Date().toISOString() } }
    });
    assert.ok(r.ok());
  };
  await login();
  await suppressTour();
  await page.goto(base + "/");
  await page.waitForFunction(() => !!window.DCCPomodoro && !!window.DCCWorkingQueue);
  const owner = await page.evaluate(() => window.DCC_ACCOUNT_CONTEXT);
  assert.ok(owner.userId && owner.workspaceId);
  const scriptOrder = await page
    .locator("script[src]")
    .evaluateAll((nodes) => nodes.map((n) => new URL(n.src).pathname));
  assert.ok(scriptOrder.indexOf("/public/js/app-config.js") < scriptOrder.indexOf("/public/js/pomodoro.js"));
  assert.ok(scriptOrder.indexOf("/public/js/pomodoro-model.js") < scriptOrder.indexOf("/public/js/pomodoro.js"));
  const key = "dcc-pomodoro:" + owner.workspaceId + ":" + owner.userId;
  const makeForeground = async (title) =>
    page.evaluate(async (title) => {
      for (let attempt = 0; window.blockStore?.hasPendingWrites() && attempt < 150; attempt++) {
        window.blockStore.flushPending();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (window.blockStore?.hasPendingWrites()) throw new Error("Fixture startup writes did not settle");
      const before = await window.DCCWorkingQueue.refresh();
      const foreground = before.queue.items.find((item) => item.status === "foreground");
      if (foreground)
        await window.DCCWorkingQueue.send({
          action: "pause",
          taskId: foreground.task.id,
          expectedRevision: before.revision,
          sourceEventId: "qa-pause:" + crypto.randomUUID(),
          at: new Date().toISOString()
        });
      const result = await window.DCC.api("/api/blocks", {
        method: "POST",
        body: {
          type: "block",
          date: new Date().toISOString().slice(0, 10),
          properties: { type: "task", title, duration: 30, status: "open" }
        }
      });
      const row = Array.isArray(result) ? result[0] : result;
      const state = await window.DCCWorkingQueue.refresh();
      await window.DCCWorkingQueue.send({
        action: "start",
        taskId: row.id,
        expectedRevision: state.revision,
        expectedForegroundTaskId: null,
        sourceEventId: "qa:" + crypto.randomUUID(),
        at: new Date().toISOString()
      });
      return row.id;
    }, title);
  const originalTask = await makeForeground("Authenticated focus task");
  await page.locator(".wq-foreground [data-queue-action=pomodoro]").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Authenticated focus task", { exact: true }).waitFor();
  await dialog
    .getByRole("textbox", { name: "Section 1 objective" })
    .fill("Authenticated objective <script> remains text");
  await dialog.getByRole("button", { name: "Start section 1", exact: true }).click();
  await dialog.getByText("Section 1 of 4 · running").waitFor();
  const first = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
  assert.equal(first.taskId, originalTask);
  await page.evaluate(() => window.DCCWorkingQueue.render());
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.queueAction), "pomodoro");
  await page.reload();
  await page.locator(".wq-foreground [data-queue-action=pomodoro]").click();
  await dialog.getByText("Section 1 of 4 · running").waitFor();
  assert.equal(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).deadline, key), first.deadline);
  await page.setViewportSize({ width: 320, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await dialog.getByRole("button", { name: "Pause", exact: true }).click();
  await dialog.getByText("Section 1 of 4 · paused").waitFor();
  // Reach the actual bottom controls in the scrolling modal on a narrow viewport.
  await dialog.getByText("End this plan early", { exact: true }).click();
  await dialog.locator("[data-end-confirm]").check();
  assert.ok(await dialog.getByRole("button", { name: "End plan", exact: true }).isVisible());
  await page.screenshot({ path: "/tmp/dcc-pomodoro-auth-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 1000 });
  const share = await page.evaluate(() => window.DCC.api("/api/todo-share", { method: "POST", body: {} }));
  assert.ok(share.share.token);
  // Change the real session to a second disposable user/workspace, then reload.
  const second = await context.request.post(base + "/api/auth/register", {
    data: { username: "pomodoro-other-" + Date.now(), password: "local-review-only-other" }
  });
  assert.equal(second.status(), 201);
  await suppressTour();
  await page.reload();
  await page.waitForFunction(() => !!window.DCCPomodoro);
  const other = await page.evaluate(() => window.DCC_ACCOUNT_CONTEXT);
  assert.notEqual(other.userId, owner.userId);
  assert.notEqual(other.workspaceId, owner.workspaceId);
  const otherKey = "dcc-pomodoro:" + other.workspaceId + ":" + other.userId;
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), otherKey), null);
  await makeForeground("Other workspace task");
  await page.locator(".wq-foreground [data-queue-action=pomodoro]").click();
  assert.equal(await dialog.getByRole("textbox", { name: "Section 1 objective" }).inputValue(), "");
  await dialog.getByRole("textbox", { name: "Section 1 objective" }).fill("Second workspace objective");
  await dialog.getByRole("button", { name: "Save objectives", exact: true }).click();
  await page.waitForFunction((k) => !!localStorage.getItem(k), otherKey);
  assert.equal(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).taskId, key), originalTask);
  await page.keyboard.press("Escape");
  await login();
  await page.reload();
  await page.locator(".wq-foreground [data-queue-action=pomodoro]").click();
  assert.equal(
    await dialog.getByRole("textbox", { name: "Section 1 objective" }).inputValue(),
    "Authenticated objective <script> remains text"
  );
  await page.keyboard.press("Escape");
  const out = await context.request.post(base + "/api/auth/logout");
  assert.ok(out.ok());
  await page.goto(base + "/");
  assert.equal(new URL(page.url()).pathname, "/login");
  assert.equal(await page.evaluate(() => typeof window.DCCPomodoro), "undefined");
  const config = await context.request.get(base + "/public/js/app-config.js");
  assert.ok((await config.text()).includes("window.DCC_ACCOUNT_CONTEXT=null"));
  await page.goto(base + "/todo/" + share.share.token);
  assert.equal(await page.evaluate(() => typeof window.DCCPomodoro), "undefined");
  assert.equal(await page.locator("[data-queue-action=pomodoro]").count(), 0);
  for (const name of ["app-config", "pomodoro-model", "pomodoro", "working-queue"]) {
    const observed = assets.filter((r) => new URL(r.url).pathname === "/public/js/" + name + ".js");
    assert.ok(observed.length >= 2, name + " loads on refresh");
    assert.ok(
      observed.every((r) => r.status === 200 && r.cache.includes("no-store")),
      name + " is fresh"
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real authenticated server route, account config order, no-store assets/reload, Foreground/overlay/focus, 320px scroll controls, actual account/workspace switching, signed-out and public shared-view boundaries."
  );
} finally {
  await browser.close();
}
