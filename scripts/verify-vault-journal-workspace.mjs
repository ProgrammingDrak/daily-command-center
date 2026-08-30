#!/usr/bin/env node

// Real-browser verification for the adaptive Mycelium journal workspace.
// It mounts the production CSS and script around the real #vault-reading DOM.
/* global window, document */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const candidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.setContent(`<!doctype html><html><body>
  <div id="vault-body">
    <div id="vault-reading">
      <button id="vault-reading-close">×</button>
      <div id="vault-detail" class="vault-detail">
        <div class="vault-detail-bar"><button class="vault-edit-btn">Edit</button></div>
        <div class="vault-body-md"><h1>Morning</h1><p>Entry body.</p><h2>Notes</h2></div>
      </div>
    </div>
  </div>
  <div id="vault-editor-overlay"></div>
</body></html>`);
await page.addStyleTag({ path: path.join(root, "public", "css", "vault.css") });
await page.addScriptTag({ path: path.join(root, "public", "js", "vault-journal-workspace.js") });

const node = {
  slug: "journal/2026/2026-08-30",
  frontmatter: { type: "journal", title: "August 30" },
  body: "# Morning\n\nEntry body.\n\n## Notes",
};
await page.evaluate((entry) => {
  window.__opened = "";
  window.__edited = false;
  window.__closed = false;
  window.VaultJournalWorkspace.init({
    openSlug: (slug) => { window.__opened = slug; },
    editNode: () => { window.__edited = true; },
    onClose: () => { window.__closed = true; },
  });
  window.VaultJournalWorkspace.open(entry);
}, node);

assert.equal(await page.evaluate(() => document.body.classList.contains("vault-journal-dock-right")), true);
const focus = await page.locator("#vault-reading").boundingBox();
assert.ok(focus && focus.x >= 0 && focus.y >= 0 && focus.x + focus.width <= 1280 && focus.y + focus.height <= 800);
assert.equal(await page.locator("#journal-section-notes").count(), 1);

await page.locator(".vault-journal-sensor").click();
await page.locator('[data-journal-mode="float"]').click();
assert.equal(await page.evaluate(() => document.body.classList.contains("vault-journal-float")), true);

await page.locator('[data-journal-mode="dock-right"]').click();
assert.equal(await page.evaluate(() => document.body.classList.contains("vault-journal-dock-right")), true);
assert.ok((await page.locator("#vault-reading").boundingBox()).width <= 640);

await page.locator("[data-journal-edit]").click();
assert.equal(await page.evaluate(() => window.__edited), true);

await page.locator("[data-journal-minimize]").click();
assert.equal(await page.locator("#vault-journal-restore").isVisible(), true);
await page.locator("#vault-journal-restore").click();
assert.equal(await page.locator("#vault-reading").isVisible(), true);
assert.equal(await page.evaluate(() => document.body.classList.contains("vault-journal-dock-right")), true);

await page.locator("[data-journal-close]").click();
assert.equal(await page.evaluate(() => window.__closed), true);
assert.equal(await page.evaluate(() => document.body.className), "");

await page.setViewportSize({ width: 375, height: 812 });
await page.evaluate((entry) => window.VaultJournalWorkspace.open(entry), node);
const mobile = await page.locator("#vault-reading").boundingBox();
assert.ok(mobile && mobile.x >= 0 && mobile.y >= 0 && mobile.x + mobile.width <= 375 && mobile.y + mobile.height <= 812);
assert.equal(await page.locator('[data-journal-mode="dock-left"]').isDisabled(), true);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

await browser.close();
console.log("Mycelium journal workspace browser verification passed.");
