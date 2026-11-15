/* global Buffer, __dirname, process, console, window, document, DCC, VaultEditor, viewer */
// Repeatable browser check using the real journal editor and its save path.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");
const root = path.resolve(__dirname, "..");
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"]
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, hasTouch: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://journal.test/**", (route) => {
      if (route.request().url().includes("/api/vault/media/"))
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            "base64"
          )
        });
      return route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
    });
    await page.goto("http://journal.test/");
    await page.setContent('<html><body><button id="completion-photo-gallery"></button></body></html>');
    for (const file of [
      "public/css/tokens.css",
      "public/css/vault.css",
      "public/css/completion-memories.css",
      "public/css/journal-sketchbook.css"
    ])
      await page.addStyleTag({ path: path.join(root, file) });
    await page.evaluate(() => {
      window.DCC = {
        esc: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
        toast() {}
      };
      window.saved = null;
      window.fetch = async (url, options) => {
        if (url === "/api/vault/attach") {
          window.attachmentSlug = options.body.get("slug");
          return { ok: true, json: async () => ({ ref: "media:sha256:" + "b".repeat(64) }) };
        }
        if (options?.method === "PUT") window.saved = JSON.parse(options.body);
        return { ok: true, json: async () => (url === "/api/vault/schema" ? { types: [{ type: "journal" }] } : {}) };
      };
    });
    for (const file of [
      "public/js/vendor/marked.min.js",
      "public/js/vendor/purify.min.js",
      "public/js/ink/strokes.js",
      "public/js/ink/shapes.js",
      "public/js/journal-notebook.js",
      "public/js/journal-sketchbook.js",
      "public/js/completion-memories.js",
      "public/js/vault-editor.js"
    ])
      await page.addScriptTag({ path: path.join(root, file) });
    await page.evaluate(async () => {
      DCC.CompletionMemories.loadDayPhotos = async () => [];
      VaultEditor.init({
        onSaved: (slug) => {
          window.savedSlug = slug;
        }
      });
      window.entry = {
        slug: "journal/2026/test",
        hash: "original",
        frontmatter: { type: "journal", title: "Morning pages", date: "2026-11-15" },
        body: "## Morning\n\n**A good day.**\n\n![My photo](media:sha256:" + "a".repeat(64) + ")"
      };
      await VaultEditor.openEdit(window.entry);
    });
    assert.equal(await page.locator("#ed-prev strong").textContent(), "A good day.");
    assert.equal(await page.locator("#ed-day-cover img").count(), 1);
    assert.equal(await page.locator("[data-notebook-toggle]").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("[data-drawing]").isVisible(), false);
    assert.equal(await page.locator("[data-template]").isVisible(), true);
    assert.equal(await page.locator(".journal-drawer > summary").count(), 0);
    await page.locator("[data-notebook-toggle]").click();
    assert.equal(await page.locator("[data-template] option").count(), 10);
    await page.locator("[data-template]").selectOption("college-ruled");
    await page.locator('[data-tool="pen"]').click();
    await page.locator("[data-close-popup]").click();
    const canvas = page.locator(".journal-paper canvas");
    await canvas.scrollIntoViewIfNeeded();
    async function stroke() {
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35, { steps: 10 });
      await page.mouse.up();
    }
    await stroke();
    assert.equal(await page.locator("[data-undo]").isEnabled(), true);
    await page.locator("[data-undo]").click();
    assert.equal(await page.locator("[data-redo]").isEnabled(), true);
    await page.locator("[data-redo]").click();
    for (const tool of ["pencil", "highlighter"]) {
      await page.locator("[data-writing]").selectOption(tool);
      await stroke();
    }
    // The approved toolbar writes semantic geometry and rich content, not a preview-only layer.
    await page.locator('[data-tool="shape"]').click();
    for (const kind of ["line", "arrow", "rectangle", "ellipse"]) {
      await page.locator("[data-shape]").selectOption(kind);
      await stroke();
    }
    await page.locator('[data-tool="text"]').click();
    await page.getByRole("textbox", { name: "Text to place", exact: true }).fill("A saved sketchbook note --> <safe>");
    await page.getByRole("button", { name: "Place on page", exact: true }).click();
    await stroke();
    await page
      .locator("[data-image-file]")
      .setInputFiles({ name: "sketch.png", mimeType: "image/png", buffer: Buffer.from("image") });
    await page.getByText("Tap on the paper to place the image.", { exact: true }).waitFor();
    await stroke();
    assert.equal(await page.evaluate(() => window.attachmentSlug), "journal/2026/test");
    await page.locator("[data-add]").click();
    assert.equal(await page.locator("[data-page-status]").textContent(), "Page 2 / 2");
    assert.equal(await page.locator("[data-template]").inputValue(), "college-ruled");
    await page.locator("[data-notebook-toggle]").click();
    assert.equal(await page.locator("[data-drawing]").isVisible(), false);
    await page.locator("[data-notebook-toggle]").click();
    assert.equal(await page.locator("[data-template]").inputValue(), "college-ruled");
    await page.locator("[data-template]").selectOption("wide-ruled");
    assert.equal(await page.locator('[data-page-index="1"]').getAttribute("aria-current"), "page");
    // Hand swipes on the paper turn without drawing a stroke.
    await page.locator("[data-more]").click();
    await page.getByRole("button", { name: "Hand", exact: true }).click();
    await page.locator("[data-page-status]").scrollIntoViewIfNeeded();
    await canvas.scrollIntoViewIfNeeded();
    const footer = await canvas.boundingBox();
    const touch = await page.context().newCDPSession(page);
    const x = footer.x + 10,
      y = footer.y + footer.height / 2;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 75, y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal(await page.locator("[data-page-status]").textContent(), "Page 1 / 2");
    assert.equal(await page.locator("[data-template]").inputValue(), "college-ruled");
    await page.locator("#ed-save").click();
    const saved = await page.evaluate(() => window.saved);
    const { unpack } = require("../public/js/journal-notebook");
    assert.equal(unpack(saved.body).pages[0].length, 3);
    assert.equal(unpack(saved.body).pages[1].length, 0);
    assert.deepEqual(
      unpack(saved.body).pages[0].map((item) => item.tool),
      ["fineliner", "pencil", "highlighter"]
    );
    const objects = unpack(saved.body).objects[0];
    assert.deepEqual(
      objects.filter((item) => item.kind === "shape").map((item) => item.shapeType),
      ["line", "arrow", "rectangle", "ellipse"]
    );
    assert.equal(objects.find((item) => item.kind === "text").text, "A saved sketchbook note --> <safe>");
    assert.match(objects.find((item) => item.kind === "image").media, /media:sha256:b{64}/);
    assert.deepEqual(unpack(saved.body).templates, ["college-ruled", "wide-ruled"]);
    assert.equal(
      unpack(saved.body).text,
      "## Morning\n\n**A good day.**\n\n![My photo](media:sha256:" + "a".repeat(64) + ")"
    );
    assert.equal(saved.expectedHash, "original");
    assert.equal(await page.evaluate(() => window.savedSlug), "journal/2026/test");
    await page.evaluate(async () => {
      await VaultEditor.openEdit({ ...window.entry, body: window.saved.body });
    });
    assert.equal(await page.locator("[data-drawing]").isVisible(), false);
    await page.locator("[data-notebook-toggle]").click();
    assert.equal(await page.locator("[data-page-status]").textContent(), "Page 1 / 2");
    assert.equal(await page.locator("#ed-day-cover img").count(), 1);
    assert.equal(await page.locator("[data-template]").inputValue(), "college-ruled");
    await page.locator('[data-page-index="1"]').click();
    assert.equal(await page.locator("[data-template]").inputValue(), "wide-ruled");
    await page.locator('[data-neighbor="-1"]').click();
    assert.equal(await page.locator("[data-template]").inputValue(), "college-ruled");
    await page.locator('[data-tool="eraser"]').click();
    await stroke();
    await page.locator("#ed-save").click();
    assert.equal(unpack(await page.evaluate(() => window.saved.body)).pages[0].length, 0);
    // Restore original drawing, then verify phone layout and read-only viewing.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async (saved) => {
      await VaultEditor.openEdit({ ...window.entry, body: saved.body });
    }, saved);
    await page.locator("[data-notebook-toggle]").click();
    await page.locator(".journal-paper").scrollIntoViewIfNeeded();
    const bounds = await canvas.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, "Paper fits a phone");
    if (process.env.JOURNAL_SCREENSHOT) await page.screenshot({ path: process.env.JOURNAL_SCREENSHOT });
    await page.evaluate((saved) => {
      document.querySelector("#ed-cancel").click();
      const host = document.createElement("div");
      host.innerHTML = '<div id="cover"></div><div id="story"></div>';
      document.body.append(host);
      window.viewer = DCC.CompletionMemories.mountJournalEntry(
        host.querySelector("#cover"),
        host.querySelector("#story"),
        saved.body,
        { readOnly: true, notebook: true }
      );
      viewer.setPhotos([]);
    }, saved);
    assert.equal(await page.locator("#story + .journal-notebook [data-tool]").count(), 0);
    assert.equal(await page.locator("#story + .journal-notebook [data-drawing]").isVisible(), false);
    await page.locator("#story + .journal-notebook [data-notebook-toggle]").click();
    assert.equal(await page.locator("#story + .journal-notebook [data-page-status]").textContent(), "Page 1 / 2");
    assert.equal(await page.evaluate(() => window.viewer.read()), saved.body);
    assert.deepEqual(errors, []);
    console.log(
      "Journal browser checks passed: 10 paper templates, independent page settings, dots/neighbor navigation, text/photos, drawing, undo/redo, eraser, touch swipes, save/reopen, phone, read-only."
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
