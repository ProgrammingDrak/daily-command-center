// Isolated WebKit/Chromium app QA. All HTTP is fulfilled locally; fresh browser
// storage and synthetic handwriting only. This is NOT physical iPad/Pencil QA.
/* global window, document, Event, getComputedStyle */
import { webkit, chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const engine = process.env.INK_ENGINE || "webkit";
const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true, ...(engine === "chromium" ? { channel: "msedge" } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 2, hasTouch: true, serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "http://ink.test", "unexpected external request");
    if (url.pathname === "/api/me") return route.fulfill({ json: { workspaceId: "synthetic-gesture-test" } });
    if (url.pathname === "/api/health") return route.fulfill({ json: { revision: "synthetic" } });
    let file = url.pathname === "/ink" ? (process.env.INK_HTML_SOURCE || "ink.html") : url.pathname.slice(1);
    if (!file.startsWith("public/") && url.pathname !== "/ink") return route.fulfill({ status: 404 });
    try {
      let body = await readFile(path.resolve(file));
      if (file.endsWith("canvas.js")) body = Buffer.concat([body, Buffer.from(
        "\nconst originalCreate = window.InkCanvas.create; window.InkCanvas.create = opts => (window.testInk = originalCreate(opts));")]);
      return route.fulfill({ body, contentType: file.endsWith(".js") ? "application/javascript" : file.endsWith(".html") ? "text/html" : undefined });
    } catch { return route.fulfill({ status: 404 }); }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("http://ink.test/ink");
  await page.waitForFunction(() => document.querySelector(".new-book") || !document.querySelector("#shelfEmpty").classList.contains("hidden"));
  console.log(await page.locator("#shelf").innerText());
  await page.locator(".new-book").click();
  await page.locator("#newTitle").fill("Synthetic gesture QA");
  await page.locator("#newCreate").click();
  await page.waitForFunction(() => window.testInk && window.testInk.state.scale > 0);
  const canvas = await page.locator("#base").boundingBox();
  // Browser-injected mouse events exercise real hit testing and pointer capture.
  for (let i = 0; i < 99; i++) {
    await page.mouse.move(canvas.x + 20, canvas.y + 20 + i * 2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 90, canvas.y + 20 + i * 2, { steps: 2 });
    await page.mouse.up();
  }
  // Browser-injected touch verifies the non-passive guard still permits the
  // pointer stream and a no-motion tap creates exactly one dot.
  await page.touchscreen.tap(canvas.x + 120, canvas.y + 40);
  await page.waitForFunction(() => document.querySelector("#syncStatus").textContent.includes("Saved locally"));
  assert.equal(await page.evaluate(() => window.testInk.getPage().strokes.length), 100);
  await page.locator("#syncStatus").dblclick();
  const selection = await page.evaluate(() => window.getSelection().toString());
  const styles = await page.locator("#syncStatus").evaluate(el => ({
    select: getComputedStyle(el).userSelect, webkitSelect: getComputedStyle(el).webkitUserSelect,
  }));
  console.log(JSON.stringify({ engine, toolbarSelection: selection, styles, strokes: 100, errors }));
  assert.equal(selection, "", "writer status must not enter native text selection");
  // The non-passive touch guard cancels defaults without generating ink itself.
  const touch = await page.evaluate(() => {
    const event = new Event("touchstart", { bubbles: true, cancelable: true });
    document.querySelector("#base").dispatchEvent(event);
    return { cancelled: event.defaultPrevented, strokes: window.testInk.getPage().strokes.length };
  });
  assert.deepEqual(touch, { cancelled: true, strokes: 100 });
  await page.locator("#nbName").click();
  await page.locator("#bookTitle").fill("Rename still works");
  await page.locator("#bookTitle").press("ControlOrMeta+A");
  assert.equal(await page.locator("#bookTitle").evaluate(el => el.selectionEnd - el.selectionStart), 18);
  await page.locator("#bookSave").click();
  await page.waitForFunction(() => document.querySelector("#nbName").textContent === "Rename still works");
  await page.reload();
  await page.getByText("Rename still works", { exact: true }).click();
  await page.waitForFunction(() => window.testInk);
  assert.equal(await page.evaluate(() => window.testInk.getPage().strokes.length), 100);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, savedAndReloaded: 100, renameSelection: "passed", pageErrors: errors.length }));
  if (process.env.INK_GESTURE_SCREENSHOT) await page.screenshot({ path: process.env.INK_GESTURE_SCREENSHOT });
} finally { await browser.close(); }
