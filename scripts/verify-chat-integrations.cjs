// Synthetic isolated fixture only. Never connects to production or a personal DB.
/* global process, __dirname, document, innerWidth, console */
const assert = require("node:assert/strict");
const path = require("node:path");
async function main() {
  if (!process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL)
    throw new Error("Set DCC_PGLITE_MODULE or a localhost DCC_TEST_DATABASE_URL");
  const ctx = await require("../test-support/activity-db").createActivityDb();
  const express = require("express"),
    app = express();
  app.use("/public", express.static(path.join(__dirname, "../public")));
  const session = { userId: 1, workspaceId: "ws-1", username: "Integration review" };
  app.use((req, _res, next) => {
    req.session = session;
    next();
  });
  // Disabled remote setup is a supported first-class screen; there are no real grants.
  require("../routes/chat-integrations")(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const browser = await require("playwright-core").chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || process.env.CHROME_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"]
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:" + server.address().port + "/connections/conversation");
    assert.equal(await page.locator("h1").innerText(), "Chat integrations");
    assert.equal(await page.locator("select").count(), 6);
    assert.equal(await page.locator('select[name="tasks"]').inputValue(), "read");
    await page.locator("[data-select-all]").click();
    assert.equal(await page.locator('select[name="repeats"]').inputValue(), "write");
    assert.match(await page.locator("[data-scopes]").inputValue(), /dcc.repeats.write/);
    await page.getByRole("button", { name: "Save connection preferences" }).click();
    await page.waitForURL("**/connections/conversation?saved=1");
    assert.equal(await page.locator('select[name="files"]').inputValue(), "write");
    assert.match(await page.locator("body").innerText(), /remote integration is disabled/);
    for (const [width, height, label] of [
      [1280, 1000, "desktop"],
      [390, 844, "mobile"]
    ]) {
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `/tmp/dcc-chat-integrations-${label}.png`, fullPage: true });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("body").evaluate((el) => (el.style.zoom = "2"));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(
      "Passed: permission selection, persistence, disabled setup, desktop/mobile, 200% zoom, reduced motion and browser errors."
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    await ctx.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
