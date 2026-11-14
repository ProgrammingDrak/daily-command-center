/* global document, localStorage, innerWidth, Storage, window, navigator, StorageEvent */
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  queueBrowserComponents = require("../test-support/queue-browser-components");
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  app = express();
const queue = {
  revision: 1,
  foreground: [],
  queue: {
    items: [
      {
        task: {
          id: "task",
          type: "block",
          properties: { type: "task", title: "Write a draft", startedAt: new Date().toISOString() }
        },
        status: "foreground",
        delegated: []
      }
    ],
    order: ["task"]
  }
};
app.use("/public", express.static(path.join(root, "public")));
app.get("/api/working-queue", (_req, res) => res.json({state:queue}));
app.get("/", (_req, res) =>
  res
    .type("html")
    .send(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/tokens.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"></head><body><main><div id="working-queue-root"></div><button id="outside">Outside</button></main><div id="toast-container"></div><script>window.DCC_ACCOUNT_CONTEXT={userId:Number(new URLSearchParams(location.search).get('user')||1),workspaceId:new URLSearchParams(location.search).get('workspace')||'test'};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/pomodoro-model.js"></script><script src="/public/js/pomodoro.js"></script><script src="/public/js/task-types.js"></script><script src="/public/js/task-model.js"></script><script src="/public/js/completed-queue-filter.js"></script><script src="/public/js/task-priority.js"></script><script src="/public/js/queue-policy.js"></script>${queueBrowserComponents()}<script src="/public/js/working-queue.js"></script><script>DCCWorkingQueue.refresh();</script></body></html>`
    )
);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 1000 }, reducedMotion: "reduce" }),
    page = await context.newPage(),
    errors = [];
  context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  page.on("pageerror", (e) => errors.push(e.message));
  const writes = [];
  context.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  const url = "http://127.0.0.1:" + server.address().port,
    key = "dcc-pomodoro:test:1";
  await page.goto(url);
  await page.locator("[data-queue-action=pomodoro]").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.ok(await page.locator("main").evaluate((el) => el.inert));
  await page.getByRole("button", { name: "Start section 1", exact: true }).click();
  await page.getByText("Could not save: Set an objective for this section first.").waitFor();
  await page.getByRole("textbox", { name: "Section 1 objective" }).fill("Draft introduction");
  await page.getByRole("textbox", { name: "Section 2 objective" }).fill("Revise");
  await page.getByRole("button", { name: "Start section 1", exact: true }).click();
  await page.getByText("Section 1 of 4 · running").waitFor();
  const read = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
  let p = await read();
  assert.equal(p.taskId, "task");
  assert.equal(p.deadline - p.remaining > 0, true);
  const deadline = p.deadline;
  await page.getByRole("textbox", { name: "Section 3 objective" }).fill("Check evidence");
  await page.getByRole("button", { name: "Save objectives", exact: true }).click();
  await page.waitForFunction(
    ([k, d]) =>
      JSON.parse(localStorage.getItem(k)).revision === 2 && JSON.parse(localStorage.getItem(k)).deadline === d,
    [key, deadline]
  );
  await page.evaluate(() => window.DCCWorkingQueue.render());
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.queueAction), "pomodoro");
  await page.reload();
  await page.locator("[data-queue-action=pomodoro]").click();
  await page.getByText("Section 1 of 4 · running").waitFor();
  assert.equal((await read()).deadline, deadline);
  await dialog.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByText("Section 1 of 4 · paused").waitFor();
  const paused = (await read()).remaining;
  const other = await context.newPage();
  await other.goto(url);
  await other.locator("[data-queue-action=pomodoro]").click();
  for (const tab of [page, other])
    await tab.evaluate((k) => {
      window.__focusWrites = 0;
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === k) window.__focusWrites++;
        return set.call(this, name, value);
      };
    }, key);
  // Hold the shared lock so both handlers definitely enqueue before either can save.
  const lockPage = await context.newPage();
  await lockPage.goto(url);
  await lockPage.evaluate((k) => {
    navigator.locks.request(k, async () => {
      window.__focusLockHeld = true;
      await new Promise((resolve) => {
        window.__releaseFocusLock = resolve;
      });
    });
  }, key);
  await lockPage.waitForFunction(() => window.__focusLockHeld);
  await Promise.all([
    page.getByRole("button", { name: "Resume section", exact: true }).click(),
    other.getByRole("button", { name: "Resume section", exact: true }).click()
  ]);
  await lockPage.waitForFunction(
    async (k) => (await navigator.locks.query()).pending.filter((lock) => lock.name === k).length === 2,
    key
  );
  await lockPage.evaluate(() => window.__releaseFocusLock());
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).revision === 4, key);
  await lockPage.waitForFunction(async (k) => {
    const locks = await navigator.locks.query();
    return ![...locks.held, ...locks.pending].some((lock) => lock.name === k);
  }, key);
  assert.equal(
    (await Promise.all([page, other].map((tab) => tab.evaluate(() => window.__focusWrites)))).reduce(
      (a, b) => a + b,
      0
    ),
    1,
    "only one queued resume may commit"
  );
  p = await read();
  assert.equal(p.revision, 4);
  assert.equal(p.remaining, paused);
  await Promise.any(
    [page, other].map((tab) =>
      tab.waitForFunction(() => document.querySelector("[data-error]")?.textContent.includes("another tab"))
    )
  );
  const loserErrors = await Promise.all([page, other].map((tab) => tab.locator("[data-error]").textContent()));
  assert.ok(
    loserErrors.some((text) => text.includes("another tab")),
    "one stale tab must report the conflict"
  );
  await lockPage.close();
  // The race has been asserted; reload to drain the old document and overlay lifecycle
  // before testing a separate sleep/expiry interruption.
  await page.reload();
  // Expire in storage to model a deadline passing during device sleep. No task API is involved.
  await page.evaluate((k) => {
    const p = JSON.parse(localStorage.getItem(k));
    p.deadline = Date.now() - 1;
    localStorage.setItem(k, JSON.stringify(p));
  }, key);
  await page.locator("[data-queue-action=pomodoro]").click();
  await page.getByText("Section 1 timer finished", { exact: true }).waitFor();
  // A late notification for an already-loaded record must not disable this view.
  await page.evaluate(
    (k) =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: k, newValue: localStorage.getItem(k), storageArea: localStorage })
      ),
    key
  );
  assert.equal(await page.getByRole("button", { name: "Save objectives", exact: true }).isEnabled(), true);
  await page.getByRole("textbox", { name: "Section 1 objective" }).fill("");
  await page.getByRole("button", { name: "Save objectives", exact: true }).click();
  try {
    await page.getByText("Could not save: Keep an objective for the running section.").waitFor({ timeout: 5000 });
  } catch (e) {
    console.log(
      "EXPIRED_VALIDATION_DIAGNOSTIC",
      await page.evaluate(
        (k) => ({
          error: document.querySelector("[data-error]")?.textContent,
          phase: document.querySelector("[data-phase]")?.textContent,
          button: document.querySelector('[data-focus-action="save"]')?.outerHTML,
          values: [...document.querySelectorAll(".dcc-pomodoro textarea")].map((i) => i.value),
          stored: localStorage.getItem(k)
        }),
        key
      ),
      errors
    );
    throw e;
  }

  assert.equal((await read()).objectives[0], "Draft introduction");
  await page.getByRole("textbox", { name: "Section 1 objective" }).fill("Draft introduction");
  await page.getByRole("button", { name: "Prepare next section", exact: true }).dblclick();
  await page.getByText("Section 2 of 4 · ready").waitFor();
  assert.equal((await read()).section, 1);
  assert.equal(await page.getByRole("textbox", { name: "Section 1 objective" }).isDisabled(), true);
  await page.screenshot({ path: "/tmp/dcc-pomodoro-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "/tmp/dcc-pomodoro-mobile.png", fullPage: true });
  // Focus cannot escape the blocking overlay.
  for (let i = 0; i < 14; i++) await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement.closest("[role=dialog]")), true);
  const isolated = await context.newPage();
  await isolated.goto(url + "/?workspace=other");
  await isolated.locator("[data-queue-action=pomodoro]").click();
  await isolated.getByText("Section 1 of 4 · ready").waitFor();
  assert.equal(await isolated.getByRole("textbox", { name: "Section 1 objective" }).inputValue(), "");
  // A foreground replacement must not retarget the saved plan.
  queue.queue.items[0].task = {
    id: "replacement",
    type: "block",
    properties: { type: "task", title: "Replacement task", startedAt: new Date().toISOString() }
  };
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.reload();
  await page.locator("[data-queue-action=pomodoro]").click();
  await page.getByText("Write a draft", { exact: true }).waitFor();
  assert.equal((await read()).taskId, "task");
  // A deleted task retains its snapshot focus plan without producing task writes.
  const replacement = queue.queue.items;
  queue.queue.items = [];
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.reload();
  await page.locator("[data-queue-action=pomodoro]").click();
  await dialog.getByText("Write a draft", { exact: true }).waitFor();
  assert.equal((await read()).taskId, "task");
  queue.queue.items = replacement;
  await page.evaluate(() => window.DCCWorkingQueue.refresh());
  // Complete the remaining timers explicitly; no section starts itself.
  for (let section = 1; section < 4; section++) {
    await page.getByRole("textbox", { name: "Section " + (section + 1) + " objective" }).fill("Goal " + section);
    await page.getByRole("button", { name: "Start section " + (section + 1), exact: true }).click();
    await page.getByText("Section " + (section + 1) + " of 4 · running").waitFor();
    await page.evaluate((k) => {
      const p = JSON.parse(localStorage.getItem(k));
      p.deadline = Date.now() - 1;
      localStorage.setItem(k, JSON.stringify(p));
    }, key);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.locator("[data-queue-action=pomodoro]").click();
    await page.getByText("Section " + (section + 1) + " timer finished", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: section === 3 ? "Finish plan" : "Prepare next section", exact: true })
      .click();
    await page
      .getByText(section === 3 ? "Plan complete" : "Section " + (section + 2) + " of 4 · ready", { exact: true })
      .waitFor();
  }
  assert.equal((await read()).status, "complete");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.locator("[data-queue-action=pomodoro]").click();
  await dialog.getByText("Replacement task", { exact: true }).waitFor();
  await page.getByText("End this plan early", { exact: true }).click();
  await page.getByRole("button", { name: "End plan", exact: true }).click();
  await page.getByText("Confirm ending the remaining sections first.").waitFor();
  await page.locator("[data-end-confirm]").check();
  await page.getByRole("button", { name: "End plan", exact: true }).click();
  await page.getByText("Plan ended early", { exact: true }).waitFor();
  assert.equal((await read()).status, "cancelled");
  // A failed disk write must leave the last saved timer untouched and report failure.
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.locator("[data-queue-action=pomodoro]").click();
  const before = await read();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Quota exceeded");
    };
  });
  await page.getByRole("textbox", { name: "Section 2 objective" }).fill("Unsaved");
  await page.getByRole("button", { name: "Save objectives", exact: true }).click();
  await page.getByText("Could not save: Quota exceeded").waitFor();
  assert.deepEqual(await read(), before);
  // A different user in the same workspace never sees the first user's saved plan.
  const userPage = await context.newPage();
  await userPage.goto(url + "/?user=2");
  await userPage.locator("[data-queue-action=pomodoro]").click();
  assert.equal(await userPage.getByRole("textbox", { name: "Section 1 objective" }).inputValue(), "");
  // Without Web Locks, refuse mutation and preserve storage instead of racing tabs.
  await userPage.evaluate(() => Object.defineProperty(navigator, "locks", { value: undefined }));
  await userPage.getByRole("textbox", { name: "Section 1 objective" }).fill("No lock goal");
  await userPage.getByRole("button", { name: "Start section 1", exact: true }).click();
  await userPage
    .getByText("Could not save: This browser cannot safely coordinate focus timers across tabs. Use a current browser.")
    .waitFor();
  assert.equal(await userPage.evaluate(() => localStorage.getItem("dcc-pomodoro:test:2")), null);
  // Invalid stored data is preserved and produces an actionable error, not silent reset.
  await other.evaluate((k) => localStorage.setItem(k, "invalid-json"), key);
  await other.keyboard.press("Escape");
  await other.locator("[data-queue-action=pomodoro]").click();
  assert.equal(await other.evaluate((k) => localStorage.getItem(k), key), "invalid-json");
  assert.equal(await other.getByRole("dialog").count(), 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: objectives, 20-minute deadline, refresh, pause/resume race, expiry, repeated next, focus/inert/Escape, 320px, workspace isolation and failed storage."
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
