/* global window, document */
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
test(
  "queue tips support keyboard, touch, redraw and inactive cached work with stable priority",
  { skip: !process.env.DCC_BROWSER_TESTS },
  async (t) => {
    const express = require("express"),
      app = express();
    app.use(express.json());
    const writes = [];
    const now = Date.now(),
      state = {
        revision: 1,
        timeZone: "America/New_York",
        foreground: [],
        queue: {
          serverNow: new Date(now).toISOString(),
          order: ["a", "b", "c"],
          priorityOrder: ["a"],
          items: [
            {
              task: { id: "a", properties: { type: "task", title: "Plan the next step", taskPriority: "Low" } },
              status: "queued",
              taskPriority: "Low",
              delegated: []
            },
            {
              task: {
                id: "b",
                properties: {
                  type: "task",
                  title: "Stopped research",
                  notes: "Retained",
                  actualMinutes: 17,
                  taskPriority: "High"
                }
              },
              actualMinutes: 17,
              status: "background",
              taskPriority: "High",
              note: "Results preserved; choose the next query",
              delegated: [
                {
                  work: { source: "codex", id: "job" },
                  phase: "working",
                  at: new Date(now - 1000000).toISOString(),
                  note: "Collected findings",
                  reviewActions: [],
                  execution: {
                    state: "running",
                    observedAt: new Date(now - 1000000).toISOString(),
                    validUntil: new Date(now - 1000).toISOString()
                  }
                }
              ]
            },
            {
              task: { id: "c", properties: { type: "task", title: "Review the proposed answer" } },
              status: "queued",
              needsYou: true,
              taskPriority: "Medium",
              delegated: []
            }
          ]
        }
      };
    state.queue.order.push("d");
    state.queue.items.push({ task: { id: "d", properties: { type: "task", title: "Executing worker" } }, status: "background", delegated: [{ work: { source: "codex", id: "live-job" }, phase: "working", at: new Date(now).toISOString(), note: "Observed running", reviewActions: [], execution: { state: "running", observedAt: new Date(now).toISOString(), validUntil: new Date(now+600000).toISOString() } }] });
    app.use("/public", express.static(path.join(__dirname, "public")));
    app.post("/api/working-queue", (req, res) => {
      writes.push(req.body);
      state.revision++;
      res.json({ ok: true, state });
    });
    app.get("/api/working-queue", (_req, res) => res.json(state));
    app.get("/", (_req, res) =>
      res.send(
        '<html><head><link rel="stylesheet" href="/public/css/working-queue.css"></head><body style="background:#171522;color:#eee;font:16px system-ui;margin:20px"><main id="working-queue-root"></main><script>window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:"ws-1"};</script><script src="/public/js/core.js"></script><script src="/public/js/task-priority.js"></script><script src="/public/js/task-model.js"></script><script src="/public/js/completed-queue-filter.js"></script><script src="/public/js/queue-policy.js"></script><script src="/public/js/hold-action.js"></script><script src="/public/js/itinerary-card.js"></script><script src="/public/js/queue-layout.js"></script><script src="/public/js/working-queue.js"></script><script>window.DCCWorkingQueue.refresh()</script></body></html>'
      )
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await require("playwright-core").chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.locator("[data-queue-id=b]").waitFor();
    assert.deepEqual(
      await page.locator(".wq-next [data-queue-id]").evaluateAll((rows) => rows.map((row) => row.dataset.queueId)),
      ["b", "a"]
    );
    assert.equal(await page.locator(".wq-background [data-queue-id]").count(), 1);
    assert.equal(await page.locator(".wq-needs [data-queue-id=c]").count(), 1);
    for (const label of ["Foreground", "Needs You", "Priority Queue", "Background"]) {
      const summary = page.getByLabel("About " + label, { exact: true });
      await summary.focus();
      await page.keyboard.press("Enter");
      assert.equal(await summary.locator("..").getAttribute("open"), "");
      await page.evaluate(() => window.DCCWorkingQueue.render());
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "About " + label);
      assert.equal(
        await page
          .getByLabel("About " + label, { exact: true })
          .locator("..")
          .getAttribute("open"),
        ""
      );
    }
    assert.equal(await page.locator("[data-queue-id=b] [data-queue-action=return]").isEnabled(), true);
    assert.equal(await page.locator("[data-queue-id=c] [data-queue-action=return]").isDisabled(), true);
    assert.equal(await page.locator("[data-queue-id=d] [data-queue-action=return]").isDisabled(), true);
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/api/working-queue") && response.request().method() === "POST"
    );
    await page.locator("[data-queue-id=b] [data-queue-action=return]").click();
    await saved;
    assert.equal(writes[0].action, "queue-return");
    assert.equal(writes[0].taskId, "b");
    assert.equal(writes[0].expectedRevision, 1);
    await page.screenshot({ path: path.join(__dirname, "../queue-policy-review.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("About Background", { exact: true }).click();
    assert.equal(await page.getByLabel("About Background", { exact: true }).locator("..").getAttribute("open"), null);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
  }
);
