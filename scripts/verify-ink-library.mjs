// Fresh, synthetic, offline-only app fixtures. No real notes or production APIs.
/* global window, document, PointerEvent, performance, getComputedStyle */
import { webkit, chromium } from "playwright-core";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const engine = process.env.INK_ENGINE || "webkit";
const evidence = path.resolve(process.env.INK_EVIDENCE_DIR || "../evidence");
await mkdir(evidence, { recursive: true });
const browser = await (engine === "webkit" ? webkit : chromium).launch({ headless: true,
  ...(engine === "chromium" ? { channel: process.env.INK_BROWSER_CHANNEL || "chrome" } : {}) });
const results = { engine, brushPixels: [], layouts: [], errors: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: "block" });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "http://ink.test");
    if (url.pathname === "/api/me") return route.fulfill({ json: { workspaceId: "synthetic-library-qa" } });
    if (url.pathname === "/api/health") return route.fulfill({ json: { revision: "synthetic" } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 503 });
    const file = url.pathname === "/ink" ? "ink.html" : url.pathname.slice(1);
    if (!file.startsWith("public/") && file !== "ink.html") return route.fulfill({ status: 404 });
    try {
      let body = await readFile(path.resolve(file));
      if (file.endsWith("canvas.js")) body = Buffer.concat([body, Buffer.from("\nconst makeInk = window.InkCanvas.create; window.InkCanvas.create = opts => (window.testInk = makeInk(opts));")]);
      return route.fulfill({ body, contentType: file.endsWith(".js") ? "application/javascript" : file.endsWith(".html") ? "text/html" : undefined });
    } catch { return route.fulfill({ status: 404 }); }
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", e => results.errors.push(e.message));
  await page.goto("http://ink.test/ink");
  await page.locator(".new-book").click(); await page.locator("#newTitle").fill("Brush & paper studio"); await page.locator("#newCreate").click();
  await page.waitForFunction(() => window.testInk && window.testInk.state.scale > 0);
  await page.locator("#penBtn").click();
  assert.equal(await page.locator("#brushChoices button").count(), 9);
  await page.screenshot({ path: path.join(evidence, `${engine}-brush-picker.png`) });
  await page.getByRole("button", { name: "Graphite pencil", exact: true }).click(); await page.locator("#brushClose").click();
  await page.locator("#widthRange").fill("8.2"); await page.locator("#swatches button").nth(1).click();
  await page.locator("#hlBtn").click(); await page.locator("#penBtn").click();
  await page.getByRole("button", { name: "Graphite pencil", exact: true }).click(); await page.locator("#brushClose").click();
  assert.equal(await page.locator("#widthRange").inputValue(), "8.2");
  assert.equal(await page.evaluate(() => window.testInk.state.color), "#2f6fb0");
  // Synthetic Pencil samples own a test capture shim. The separate gesture
  // script covers real browser-injected mouse/touch capture and save/reload.
  results.brushPixels = await page.evaluate(() => {
    const ink = window.testInk, S = window.InkStrokes, base = document.querySelector("#base");
    base.setPointerCapture = () => {}; base.releasePointerCapture = () => {};
    const ctx = base.getContext("2d");
    const data = [];
    let id = 0;
    function event(type, x, y, pressure) {
      const r = base.getBoundingClientRect(), scale = ink.state.scale;
      base.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: id,
        clientX: r.left + x * scale, clientY: r.top + y * scale, pressure, buttons: type === "pointerup" ? 0 : 1 }));
    }
    for (const tool of ["ballpoint", "fineliner", "fountain", "pencil", "mechanical", "marker", "highlighter", "brush", "calligraphy"]) {
      ink.loadPage(S.emptyPage()); ink.setTool(tool); ink.setStyle({ angle: 45 });
      ink.setSize(S.toolSpec(tool).sizes[1]); ink.setColor(tool === "highlighter" ? "#ffe66d" : "#1b1b2f");
      for (let repeat = 0; repeat < 3; repeat++) {
        id++; event("pointerdown", 180, 250 + repeat * 180, 0.1);
        for (let i = 1; i < 80; i++) event("pointermove", 180 + i * 9, 250 + repeat * 180 + Math.sin(i / 9) * 60, 0.1 + Math.sin(i / 80 * Math.PI) * 0.85);
        event("pointerup", 891, 250, 0.5);
      }
      const before = ctx.getImageData(0, 0, base.width, base.height).data;
      ink.redraw(); const after = ctx.getImageData(0, 0, base.width, base.height).data;
      let materialPixels = 0, maxDifference = 0;
      for (let i = 0; i < before.length; i += 4) {
        const difference = Math.max(...[0, 1, 2].map(c => Math.abs(before[i + c] - after[i + c])));
        maxDifference = Math.max(maxDifference, difference); if (difference > 8) materialPixels++;
      }
      data.push({ tool, materialPixels, maxDifference });
    }
    // A 10,000-sample highlight lift must not replay its points.
    ink.loadPage(S.emptyPage()); ink.setTool("highlighter"); ink.setStyle({ angle: 45 }); ink.setSize(24);
    id++; event("pointerdown", 200, 500, 0.5);
    for (let i = 1; i < 10000; i++) event("pointermove", 200 + i % 700, 500 + Math.sin(i / 9) * 70, 0.5);
    const start = performance.now(); event("pointerup", 400, 500, 0.5);
    data.push({ longHighlightLiftMs: performance.now() - start, points: S.pointCount(ink.getPage().strokes[0]) });
    return data;
  });
  if (engine === "webkit") for (const result of results.brushPixels.filter(p => p.tool)) assert.equal(result.materialPixels, 0, `${result.tool} raster mismatch`);
  assert.ok(results.brushPixels.at(-1).longHighlightLiftMs < 25, "highlighter lift replayed a long stroke");
  console.log(JSON.stringify({ brushPixels: results.brushPixels }));
  // Build a visible synthetic sampler without altering the source of real notes.
  await page.evaluate(() => {
    const S = window.InkStrokes, ink = window.testInk, page = S.emptyPage();
    page.paper = { type: "dots", tint: "cream", spacing: 5 };
    ["ballpoint", "fineliner", "fountain", "pencil", "mechanical", "marker", "highlighter", "brush", "calligraphy"].forEach((tool, row) => {
      const st = S.newStroke(tool, tool === "highlighter" ? "#ffe66d" : "#1b1b2f", S.toolSpec(tool).sizes[2], { angle: 45 });
      for (let i = 0; i < 70; i++) S.addPoint(st, 200 + i * 11, 200 + row * 130 + Math.sin(i / 7) * 40, 0.1 + Math.sin(i / 70 * Math.PI) * 0.85, 0);
      page.strokes.push(st);
    });
    ink.loadPage(page); ink.setPaper({ ...page.paper });
  });
  // Mark synthetic page dirty via a real paper change, preserving all nine strokes.
  await page.locator("#paperBtn").click();
  assert.equal(await page.locator("#paperChoices button").count(), 15);
  await page.screenshot({ path: path.join(evidence, `${engine}-paper-picker.png`) });
  await page.getByRole("button", { name: "Cornell notes", exact: true }).click();
  await page.locator("#paperTint").selectOption("cream"); await page.locator("#paperSpacing").selectOption("6");
  await page.locator("#paperClose").click();
  assert.equal(await page.evaluate(() => window.testInk.getPage().strokes.length), 9);
  await page.locator("#undoBtn").click(); assert.equal(await page.evaluate(() => window.testInk.getPage().paper.spacing), 7);
  await page.locator("#redoBtn").click(); assert.equal(await page.evaluate(() => window.testInk.getPage().paper.spacing), 6);
  await page.waitForFunction(() => document.querySelector("#syncStatus").textContent.includes("Saved locally"));
  // Delay one IndexedDB acknowledgement while a newer paper edit arrives.
  await page.evaluate(() => {
    const Store = window.InkStore, original = Store.savePage;
    Store.savePage = async (...args) => {
      const result = await original(...args);
      window.saveHeld = true;
      await new Promise(resolve => { window.releaseSave = resolve; });
      return result;
    };
    window.restoreSave = () => { Store.savePage = original; };
    window.testInk.setPaper({ ...window.testInk.getPage().paper, spacing: 5 });
  });
  await page.waitForFunction(() => window.saveHeld);
  await page.evaluate(() => {
    window.testInk.setPaper({ ...window.testInk.getPage().paper, spacing: 6 });
    window.restoreSave(); window.releaseSave();
  });
  assert.equal(await page.evaluate(() => window.testInk.isDirty()), true, "an older save acknowledged newer paper");
  await page.waitForFunction(() => !window.testInk.isDirty());
  results.saveAcknowledgementRace = true;
  results.worker = await page.evaluate(async () => {
    if (!window.Worker || !window.OffscreenCanvas) return { supported: false };
    const worker = new window.Worker("/public/js/ink/render-worker.js");
    try {
      const message = await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("worker render timeout")), 10000);
        worker.onmessage = e => { window.clearTimeout(timer); resolve(e.data); };
        worker.onerror = e => { window.clearTimeout(timer); reject(new Error(e.message)); };
        worker.postMessage({ id: 1, ink: window.InkStrokes.serialize(window.testInk.getPage()), scale: 0.2, type: "image/jpeg", quality: 0.9 });
      });
      if (!message.ok) throw new Error(message.error);
      const bitmap = await window.createImageBitmap(message.blob);
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return { supported: true, type: message.type, bytes: message.bytes, corner: [...ctx.getImageData(2, 2, 1, 1).data] };
    } finally { worker.terminate(); }
  });
  if (results.worker.supported) { assert.ok(results.worker.bytes > 1000); assert.ok(results.worker.corner[0] > results.worker.corner[2] + 10, "worker lost cream paper"); }
  const saved = await page.evaluate(() => window.InkStrokes.serialize(window.testInk.getPage()));
  await page.reload(); await page.locator("#books .title").filter({ hasText: "Brush & paper studio" }).click();
  await page.waitForFunction(() => window.testInk);
  assert.equal(await page.evaluate(() => window.InkStrokes.serialize(window.testInk.getPage())), saved);
  // Archive download contains the source strokes and paper, not only raster previews.
  await page.locator("#backBtn").click(); await page.locator(".book-actions").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#bookMenuExport").click()]);
  const archive = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(archive.notebooks[0].pages[0].data.strokes.length, 9);
  assert.equal(archive.notebooks[0].pages[0].data.paper.type, "cornell");
  await page.locator("#archiveClose").click();
  await page.locator("#books .title").filter({ hasText: "Brush & paper studio" }).click();
  await page.locator("#addPageBtn").click();
  assert.equal(await page.evaluate(() => window.testInk.getPage().paper.type), "cornell");
  await page.locator("#prevBtn").click();
  await page.waitForFunction(() => document.querySelector("#pgLabel").textContent.includes("Page 1"));
  // Swipe after idle, with a capture shim for DOM-dispatched touch pointers.
  await page.evaluate(() => {
    const base = document.querySelector("#base"), r = base.getBoundingClientRect();
    base.setPointerCapture = () => {}; base.releasePointerCapture = () => {};
    for (const [type, x] of [["pointerdown", r.left + 140], ["pointermove", r.left + 20], ["pointerup", r.left + 20]])
      base.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 100, pointerType: "touch", clientX: x, clientY: r.top + 100 }));
  });
  await page.waitForFunction(() => document.querySelector("#pgLabel").textContent.includes("Page 2"));
  assert.equal(await page.evaluate(() => window.testInk.getPage().strokes.length), 0);
  await page.locator("#prevBtn").click();
  for (const [width, height] of [[1440, 900], [768, 1024], [375, 812], [812, 375]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(180);
    const layout = await page.evaluate(() => ({ width: window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      paperHeight: document.querySelector("#base").getBoundingClientRect().height,
      controls: [...document.querySelectorAll("#writer button:not([hidden])")].filter(el => getComputedStyle(el).display !== "none").every(el => {
        const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      }) }));
    results.layouts.push(layout); assert.equal(layout.overflow, false); assert.ok(layout.paperHeight > 80); assert.equal(layout.controls, true);
    await page.screenshot({ path: path.join(evidence, `${engine}-${width}x${height}.png`) });
  }
  assert.deepEqual(results.errors, []);
  results.savedReloadedExportedStrokes = 9; results.paperUndoRedo = true; results.fingerNavigation = true; results.toolMemory = true;
  console.log(JSON.stringify(results, null, 2));
  await writeFile(path.join(evidence, `${engine}-results.json`), JSON.stringify(results, null, 2));
} finally { await browser.close(); }
