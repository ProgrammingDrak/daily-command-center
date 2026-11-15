/* global window */
// Real DCC shell, synthetic accounts and an isolated test database only.
/* global process, __dirname, document, innerWidth, console */
const { URL } = require("node:url");
const assert = require("node:assert/strict");
const path = require("node:path");
async function main() {
  if (!process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL)
    throw new Error("Set DCC_PGLITE_MODULE or a localhost DCC_TEST_DATABASE_URL");
  const ctx = await require("../test-support/activity-db").createActivityDb();
  const express = require("express"),
    app = express();
  app.use(express.json());
  const session = { userId: 1, workspaceId: "ws-1", username: "Review account" };
  app.use((req, _res, next) => {
    req.session = session;
    next();
  });
  app.get("/public/js/app-config.js", (_req, res) =>
    res
      .type("js")
      .send(
        'window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:"ws-1"};window.DCC_APP_TIME_ZONE="America/New_York";window.DCC_DELTA_SYNC_ENABLED=false;'
      )
  );
  app.use("/public", express.static(path.join(__dirname, "../public")));
  const providerState = {
    slack: { connected: true, tier: "user", canOauth: true, sharedBot: true, autoLink: true },
    google: { connected: true, accounts: [{ email: "review@example.test" }] },
    triage: {
      lastSeenAt: new Date().toISOString(),
      hasPassword: true,
      username: "review",
      baseUrl: "http://localhost"
    },
    setup: {}
  };
  app.get("/api/me/integrations", (_req, res) => res.json(providerState));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const { createOAuth } = require("../conversation-oauth");
  const oauth = createOAuth({ pool: ctx.pool, baseUrl: "https://dcc.example" });
  // Only the synthetic server origin differs; real grant ownership/subset checks run.
  require("../routes/chat-integrations")(app, ctx, {
    oauth: { ...oauth, baseUrl: base, resource: base + "/mcp/dcc" },
    enabled: true,
    clientsReady: true
  });
  process.env.DCC_REVIEW_EXPORT_APP = "1";
  const review = await import("./ui-review-server.mjs");
  app.use(review.default);
  const browser = await require("playwright-core").chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || process.env.CHROME_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"]
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/");
    await page.waitForFunction(() => !!window.DCCConnections && !!window.DCCSetup);
    const original = page.url();
    const openMenu = async () => {
      await page.locator("#dcc-settings-button").click();
      await page.locator("#dcc-setup-integrations").click();
      await page.getByRole("dialog", { name: "Connections", exact: true }).waitFor();
    };
    await openMenu();
    assert.equal(page.url(), original, "opening settings never navigates away");
    assert.equal(await page.locator(".connection-service").count(), 4);
    assert.equal(
      await page.getByRole("menuitem", { name: "Chat integrations", exact: true }).count(),
      0,
      "duplicate menu entry is removed"
    );
    await page.locator('[data-service="chatgpt"]').click();
    await page.locator("[data-permissions]").waitFor();
    assert.equal(await page.locator('[data-permissions] [role="radiogroup"]').count(), 6);
    assert.equal(await page.locator('input[name="tasks"][value="read"]').isChecked(), true);
    await page.locator('[data-action="allow-all"]').click();
    await page.locator('[data-action="connect"]').click();
    await page.getByRole("heading", { name: "Connect ChatGPT", exact: true }).waitFor();
    assert.equal(page.url(), original);
    assert.equal(await page.locator(".connection-advanced[open]").count(), 0, "manual setup stays collapsed");
    assert.equal((await oauth.preferences({ userId: 1, workspaceId: "ws-1" })).includes("dcc.files.write"), true);
    assert.equal((await oauth.list({ userId: 1, workspaceId: "ws-1" })).length, 0, "choosing access does not grant it");
    await page.locator('[data-action="check"]').click();
    await page.waitForFunction(() =>
      document.querySelector(".connection-feedback")?.textContent.includes("No new authorization")
    );
    const scopes = require("../lib/chat-permissions").categories.flatMap((c) => [c.read, c.write]);
    await ctx.pool.query(
      "INSERT INTO conversation_grants(id,user_id,workspace_id,client_id,scopes,last_verified_at) VALUES('review-chat',1,'ws-1','ChatGPT',$1,NOW())",
      [JSON.stringify(scopes)]
    );
    await page.locator('[data-action="check"]').click();
    await page.getByRole("heading", { name: "ChatGPT", exact: true }).first().waitFor();
    await page.locator('input[name="repeats"][value="read"]').check();
    await page.locator('[data-action="save"]').click();
    await page.waitForFunction(
      () => document.querySelector(".connection-feedback")?.textContent === "Permissions updated."
    );
    const grant = (await oauth.list({ userId: 1, workspaceId: "ws-1" }))[0];
    assert.ok(!grant.scopes.includes("dcc.repeats.write"));
    assert.equal(page.url(), original, "saving permissions never reloads the app");
    await page.screenshot({ path: "/tmp/dcc-connections-permissions-desktop.png" });
    await page.locator('[data-action="hub"]').click();
    await page.screenshot({ path: "/tmp/dcc-connections-hub-desktop.png" });
    await page.locator('[data-service="slack"]').click();
    await page.getByRole("dialog", { name: "Slack task reactions" }).waitFor();
    await page.locator(".connection-back").click();
    await page.getByRole("dialog", { name: "Connections", exact: true }).waitFor();
    await page.locator('[data-service="triage"]').click();
    await page.getByRole("dialog", { name: "AI triage", exact: true }).waitFor();
    await page.locator(".connection-back").click();
    await page.locator('[data-service="calendar"]').click();
    await page.getByRole("dialog", { name: "Google Calendar", exact: true }).waitFor();
    assert.equal((await page.locator('a[href="/api/gcal/auth"]').count()) >= 1, true);
    await page.locator('[data-action="hub"]').click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".connections-modal"));
    assert.equal(await page.evaluate(() => document.activeElement.id), "dcc-settings-button");
    await openMenu();
    await page.locator('[data-service="chatgpt"]').click();
    await page.locator("[data-permissions]").waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator(".connections").evaluate((el) => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: "/tmp/dcc-connections-permissions-mobile.png" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("body").evaluate((el) => (el.style.zoom = "2"));
    // The underlying legacy dashboard overflows at CSS zoom; assert this dialog independently.
    assert.ok(await page.locator(".connections").evaluate((el) => el.scrollWidth <= el.clientWidth));
    assert.ok(
      await page.locator(".connections-modal").evaluate((el) => el.getBoundingClientRect().right <= innerWidth)
    );
    await page.locator("body").evaluate((el) => (el.style.zoom = "1"));
    await page.locator('[data-action="disconnect-confirm"]').click();
    await page.locator('[data-action="disconnect"]').click();
    await page.waitForFunction(() => document.querySelector(".connection-feedback")?.textContent === "Disconnected.");
    assert.ok((await oauth.list({ userId: 1, workspaceId: "ws-1" }))[0].revoked_at);
    await page.goto(base + "/connections/conversation");
    await page.getByRole("dialog", { name: "ChatGPT", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/", "old bookmarks route to the in-app panel");
    assert.deepEqual(errors, []);
    console.log(
      "Passed: real DCC shell, unified menu, permission persistence, explicit authorization, reductions, disconnect, retained Slack/Calendar/triage, old links, keyboard focus, mobile, zoom and reduced motion."
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
