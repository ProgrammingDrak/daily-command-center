// Repeatable browser check using the real journal editor and its save path.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");
const root = path.resolve(__dirname, "..");
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, hasTouch: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<html><body><button id="completion-photo-gallery"></button></body></html>');
    for (const file of ["public/css/tokens.css", "public/css/vault.css", "public/css/completion-memories.css"]) await page.addStyleTag({ path: path.join(root, file) });
    await page.evaluate(() => {
      window.DCC = { esc: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"), toast() {} };
      window.saved = null;
      window.fetch = async (url, options) => {
        if (options?.method === "PUT") window.saved = JSON.parse(options.body);
        return { ok: true, json: async () => url === "/api/vault/schema" ? { types: [{ type: "journal" }] } : {} };
      };
    });
    for (const file of ["public/js/vendor/marked.min.js", "public/js/vendor/purify.min.js", "public/js/journal-notebook.js", "public/js/completion-memories.js", "public/js/vault-editor.js"]) await page.addScriptTag({ path: path.join(root, file) });
    await page.evaluate(async () => {
      DCC.CompletionMemories.loadDayPhotos = async () => [];
      VaultEditor.init({ onSaved: slug => { window.savedSlug = slug; } });
      window.entry = { slug: "journal/2026/test", hash: "original", frontmatter: { type: "journal", title: "Morning pages", date: "2026-11-15" }, body: "## Morning\n\n**A good day.**\n\n![My photo](media:sha256:" + "a".repeat(64) + ")" };
      await VaultEditor.openEdit(window.entry);
    });
    assert.equal(await page.locator("#ed-prev strong").textContent(), "A good day.");
    assert.equal(await page.locator("#ed-day-cover img").count(), 1);
    const canvas = page.locator(".journal-paper canvas");
    await canvas.scrollIntoViewIfNeeded();
    async function stroke() {
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .35, { steps: 10 });
      await page.mouse.up();
    }
    await stroke();
    assert.equal(await page.locator("[data-undo]").isEnabled(), true);
    await page.locator("[data-undo]").click();
    assert.equal(await page.locator("[data-redo]").isEnabled(), true);
    await page.locator("[data-redo]").click();
    await page.locator("[data-add]").click();
    assert.equal(await page.locator("[data-page]").textContent(), "Page 2 / 2");
    // A touch swipe on the footer turns without drawing a stroke.
    await page.locator("[data-page]").scrollIntoViewIfNeeded();
    const footer = await page.locator("[data-page]").boundingBox();
    const touch = await page.context().newCDPSession(page);
    const x = footer.x + 10, y = footer.y + footer.height / 2;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 75, y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal(await page.locator("[data-page]").textContent(), "Page 1 / 2");
    await page.locator("#ed-save").click();
    const saved = await page.evaluate(() => window.saved);
    const { unpack } = require("../public/js/journal-notebook");
    assert.equal(unpack(saved.body).pages[0].length, 1);
    assert.equal(unpack(saved.body).pages[1].length, 0);
    assert.equal(unpack(saved.body).text, "## Morning\n\n**A good day.**\n\n![My photo](media:sha256:" + "a".repeat(64) + ")");
    assert.equal(saved.expectedHash, "original");
    assert.equal(await page.evaluate(() => window.savedSlug), "journal/2026/test");
    await page.evaluate(async () => { await VaultEditor.openEdit({ ...window.entry, body: window.saved.body }); });
    assert.equal(await page.locator("[data-page]").textContent(), "Page 1 / 2");
    assert.equal(await page.locator("#ed-day-cover img").count(), 1);
    await page.locator('[data-tool="eraser"]').click();
    await stroke();
    await page.locator("#ed-save").click();
    assert.equal(unpack(await page.evaluate(() => window.saved.body)).pages[0].length, 0);
    // Restore original drawing, then verify phone layout and read-only viewing.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async saved => { await VaultEditor.openEdit({ ...window.entry, body: saved.body }); }, saved);
    await page.locator(".journal-paper").scrollIntoViewIfNeeded();
    const bounds = await canvas.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, "Paper fits a phone");
    if (process.env.JOURNAL_SCREENSHOT) await page.screenshot({ path: process.env.JOURNAL_SCREENSHOT });
    await page.evaluate(saved => {
      document.querySelector("#ed-cancel").click();
      const host = document.createElement("div");
      host.innerHTML = '<div id="cover"></div><div id="story"></div>';
      document.body.append(host);
      window.viewer = DCC.CompletionMemories.mountJournalEntry(host.querySelector("#cover"), host.querySelector("#story"), saved.body, { readOnly: true, notebook: true });
      viewer.setPhotos([]);
    }, saved);
    assert.equal(await page.locator("#story + .journal-notebook [data-tool]").count(), 0);
    assert.equal(await page.locator("#story + .journal-notebook [data-page]").textContent(), "Page 1 / 2");
    assert.equal(await page.evaluate(() => window.viewer.read()), saved.body);
    assert.deepEqual(errors, []);
    console.log("Journal browser checks passed: text/photos, drawing, undo/redo, eraser, page turns, save/reopen, phone, read-only.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
