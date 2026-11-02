const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const { createActivityDb } = require("./test-support/activity-db");
const { FOREGROUND_INDEX_SQL } = require("./conversation-store");
test(
  "browser review saves, cancels, rolls over, undoes and resumes an interrupted response",
  { skip: !process.env.DCC_TEST_DATABASE_URL || !process.env.DCC_BROWSER_TESTS },
  async (t) => {
    const ctx = await createActivityDb();
    t.after(() => ctx.close());
    await ctx.pool.query(FOREGROUND_INDEX_SQL);
    const express = require("express"),
      app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.session = { userId: 1 };
      req.workspaceId = "ws-1";
      next();
    });
    const store = require("./routes/working-queue")(app, ctx, { enabled: true });
    app.use("/public", express.static(path.join(__dirname, "public")));
    app.get("/", (_req, res) =>
      res.send(
        '<html><head><link rel="stylesheet" href="/public/css/core-ui.css"></head><body style="font:16px system-ui;background:#171522;color:#eee;padding:30px"><h1>Daily review · synthetic fixture</h1><button data-completion-review>Did these happen?</button><script>window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:"ws-1"};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/task-reconciliation.js"></script></body></html>'
      )
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    for (const id of ["a", "b", "c"])
      await ctx.blockDB.createBlock({
        id,
        type: "block",
        user_id: 1,
        workspace_id: "ws-1",
        date: null,
        properties: { title: "Review " + id, type: "task", status: "open" }
      });
    const { chromium } = require("playwright-core"),
      browser = await chromium.launch({
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true
      });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.getByRole("button", { name: "Did these happen?", exact: true }).click();
    await page.locator('[data-task="a"][data-choice="drop"]').click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await ctx.blockDB.getBlock("a")).deleted_at, null);
    await page.locator('[data-task="a"][data-choice="step_done"]').click();
    await page.locator("[name=outcome]").fill("Reproduced the failure and narrowed its cause");
    await page.locator("[name=completedTitle]").fill("Investigate delete failure");
    await page.locator("[name=nextTitle]").fill("Fix the identified delete constraint");
    await page.locator("[name=remaining]").fill("Update deletion order and run regression checks");
    await page.getByRole("button", { name: "Save outcome", exact: true }).click();
    await page.getByText("Saved and verified in DCC.", { exact: true }).waitFor();
    assert.equal((await ctx.blockDB.getBlock("a")).properties.status, "done");
    await page.getByRole("button", { name: "Undo last saved choice" }).click();
    await page.locator('[data-task="a"][data-choice="done"]').waitFor();
    assert.notEqual((await ctx.blockDB.getBlock("a")).properties.status, "done");
    let interrupted = true;
    await page.route("**/api/working-queue", async (route) => {
      if (route.request().method() === "POST" && interrupted) {
        interrupted = false;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await page.locator('[data-task="b"][data-choice="still_working"]').click();
    await page.getByRole("button", { name: "Retry saved decision" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Did these happen?", exact: true }).click();
    await page.getByRole("button", { name: "Retry saved decision" }).click();
    await page.getByText("Saved and verified in DCC.", { exact: true }).waitFor();
    const history = await store.history({ userId: 1, workspaceId: "ws-1" });
    assert.equal(history.filter((e) => e.command.taskId === "b").length, 1);
    await page.locator('[data-task="c"][data-choice="drop"]').click();
    await page.screenshot({ path: path.join(__dirname, "..", "reconciliation-review.png"), fullPage: true });
    await page.getByRole("button", { name: "Drop this occurrence" }).click();
    await page.getByText("Saved and verified in DCC.", { exact: true }).waitFor();
    assert.ok((await ctx.blockDB.getBlock("c")).deleted_at);
    await page.getByRole("button", { name: "Undo last saved choice" }).click();
    await page.locator('[data-task="c"][data-choice="done"]').waitFor();
    assert.equal((await ctx.blockDB.getBlock("c")).deleted_at, null);
    assert.deepEqual(errors, []);
  }
);
