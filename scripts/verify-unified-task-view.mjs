/* global window */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright-core";
const base = process.argv[2] || "http://127.0.0.1:8357";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
assert.equal((await (await fetch(base + "/api/health")).json()).reviewOnly, true);
const out = process.env.DCC_QA_OUTPUT || "test-results/unified-task-view";
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true
});
let groups = 0;
try {
  for (const width of [1280, 390, 320]) {
    const ids = await (await fetch(base + "/api/review/task-actions/reset", { method: "POST" })).json();
    const owner = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const viewer = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await viewer.addCookies([{ name: "fixtureActor", value: "3", url: base }]);
    const page = await viewer.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(base + "/unified-fixture");
    await page.locator(".it-list-item").first().waitFor();
    assert.equal(await page.locator(".it-list-item").count(), 3);
    assert.equal(await page.locator(".task-card").count(), 0);
    const work = page.locator('.it-list-item[data-id="' + ids.work + '"]');
    await work.getByRole("button", { name: /Actions and incentives/ }).click();
    await page.getByRole("combobox", { name: "Task action", exact: true }).selectOption("edit");
    await page.getByLabel("Task title", { exact: true }).fill("DEMO · Suggested rename");
    await page.getByRole("button", { name: "Send suggestion", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Suggestion sent" }).waitFor();
    const read = async () => (await (await fetch(base + "/api/review/task-actions/state")).json()).rows;
    assert.equal((await read()).find((r) => r.id === ids.work).properties.title, "DEMO · Shared itinerary task");
    await page.screenshot({ path: out + "/suggest-" + width + ".png" });
    groups++;
    await page.keyboard.press("Escape");
    const op = await owner.newPage();
    op.setDefaultTimeout(10000);
    await op.goto(base);
    await op.waitForFunction(() => window.DCC?.TaskActions);
    await op.evaluate(() => window.DCC.TaskActions.review());
    await op.getByRole("button", { name: "Approve", exact: true }).click();
    await op.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.equal((await read()).find((r) => r.id === ids.work).properties.title, "DEMO · Suggested rename");
    await op.keyboard.press("Escape");
    await page.reload();
    await page.getByText("DEMO · Suggested rename", { exact: true }).first().waitFor();
    groups++;
    // Preserve failed-save draft and retry the same operation; stale title/schedule stays intact.
    await op.evaluate((id) => window.DCC.TaskActions.open({ id, action: "edit" }), ids.work);
    await op.getByLabel("Task title", { exact: true }).fill("DEMO · Owner renamed");
    let fail = true;
    await op.route("**/api/task-view/self/tasks/*/actions", async (route) => {
      if (fail) {
        fail = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"Synthetic failed save"}'
        });
      } else await route.continue();
    });
    await op.getByRole("button", { name: "Apply task title", exact: true }).click();
    await op.getByRole("status").filter({ hasText: "Synthetic failed save" }).waitFor();
    assert.equal(await op.getByLabel("Task title", { exact: true }).inputValue(), "DEMO · Owner renamed");
    await op.getByRole("button", { name: "Apply task title", exact: true }).click();
    await op.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    await op.keyboard.press("Escape");
    groups++;
    await page.reload();
    await page.locator(".it-list-item").first().waitFor();
    if (width >= 760) await page.locator('.it-list-item[data-id="' + ids.work + '"] .btn-schedule').click();
    else {
      await work.getByRole("button", { name: /Actions and incentives/ }).click();
      await page.getByRole("combobox", { name: "Task action", exact: true }).selectOption("schedule");
    }
    for (const field of ["Start", "End"]) {
      await page.getByRole("button", { name: field, exact: true }).click();
      await page.locator(".tw-col").first().getByText("11", { exact: true }).click();
      await page
        .locator(".tw-head")
        .filter({ hasText: field === "Start" ? "11:00 AM" : "11:30 AM" })
        .waitFor();
      await page.getByRole("button", { name: "Set", exact: true }).click();
    }
    await page.getByRole("button", { name: /^Apply scheduling/ }).click();
    await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.equal((await read()).find((r) => r.id === ids.work).properties.start, "11:00");
    await page.keyboard.press("Escape");
    await page.reload();
    groups++;
    const done = page.locator('.it-list-item[data-id="' + ids.done + '"]');
    await done.getByRole("button", { name: /Actions and incentives/ }).click();
    await page.getByRole("combobox", { name: "Task action", exact: true }).selectOption("complete");
    assert.equal(await page.getByRole("combobox", { name: "Completion", exact: true }).inputValue(), "false");
    await page.keyboard.press("Escape");
    groups++;
    // Shared rows are keyboard reachable; action dialogs remain inside mobile viewport.
    await work.getByRole("button", { name: /Actions and incentives/ }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Task action", exact: true }).waitFor();
    const bounds = await page.locator(".dcc-overlay-body").evaluate((e) => ({ w: e.clientWidth, s: e.scrollWidth }));
    assert.ok(bounds.s <= bounds.w + 1);
    await page.screenshot({ path: out + "/shared-actions-" + width + ".png" });
    await page.keyboard.press("Escape");
    await page.screenshot({ path: out + "/shared-list-" + width + ".png" });
    await op.reload();
    await op.locator(".it-list-item").first().waitFor();
    await op.screenshot({ path: out + "/owner-list-" + width + ".png" });
    const ownerAction=op.getByRole('button',{name:'Actions and incentives: DEMO · Owner renamed',exact:true});
    assert.equal(await ownerAction.count(),1);await ownerAction.click();await op.getByRole('combobox',{name:'Task action',exact:true}).selectOption('react');await op.getByRole('button',{name:'Apply reactions',exact:true}).click();await op.getByRole('status').filter({hasText:'Saved'}).waitFor();await op.keyboard.press('Escape');groups++;

    groups++;
    for (const selector of [".it-list-utility", ".it-list-main", ".it-list-actions", ".ttl"]) {
      assert.ok(await work.locator(selector).count());
      assert.ok(await op.locator(".it-list-item").first().locator(selector).count());
    }
    await viewer.addCookies([{ name: "fixtureActor", value: "2", url: base }]);
    await page.reload();
    await page.locator(".it-list-item").first().waitFor();
    assert.equal(await page.locator(".task-access-actions,.it-list-check").count(), 0);
    groups++;
    await owner.close();
    await viewer.close();
    console.log("PASS width " + width);
  }
  console.log("PASS " + groups + " browser groups");
} finally {
  await browser.close();
}
