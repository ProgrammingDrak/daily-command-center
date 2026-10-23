import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright-core";
const base = process.argv[2] || "http://127.0.0.1:8357";
assert.equal((await (await fetch(base + "/api/health")).json()).reviewOnly, true);
const out = "test-results/unified-task-view";
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true
});
try {
  for (const width of [1280, 390]) {
    const ids = await (await fetch(base + "/api/review/task-actions/reset", { method: "POST" })).json();
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: "fixtureActor", value: "3", url: base }]);
    await context.route("**/api/social/**", (r) => r.fulfill({ json: [] }));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(base);
    await page.locator("#social-tab-btn").evaluate((e) => e.click());
    await page.locator('[data-open-day="1"]').waitFor({ state: "attached" });
    await page.locator('[data-open-day="1"]').evaluate((e) => e.click());
    await page.locator("#coach-day-list .it-list-item").first().waitFor();
    assert.equal((await page.locator("#coach-day-role").innerText()).toLowerCase(), "manager");
    assert.equal(
      await page
        .locator('#coach-day-list .it-list-item[data-id="' + ids.done + '"]')
        .evaluate((e) => e.classList.contains("done")),
      true
    );
    const row = page.locator('#coach-day-list .it-list-item[data-id="' + ids.work + '"]');
    await row.getByRole("spinbutton", { name: "Points", exact: true }).fill("17");
    await row.getByRole("button", { name: "Set", exact: true }).click();
    await page.locator("#coach-day-status").filter({ hasText: "Points changed" }).waitFor();
    const state = await (await fetch(base + "/api/review/task-actions/state")).json();
    assert.equal(state.rows.find((r) => r.id === ids.work).properties.points, 17);
    await row.getByRole("button", { name: /Actions and incentives/ }).click();
    await page.getByRole("combobox", { name: "Task action", exact: true }).selectOption("edit");
    assert.equal(await page.getByRole("button", { name: "Send suggestion", exact: true }).isVisible(), true);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: out + "/delegated-" + width + ".png" });
    await context.close();
    console.log("PASS delegated shared row, preserved coach points and suggestion-only editing " + width);
  }
} finally {
  await browser.close();
}
