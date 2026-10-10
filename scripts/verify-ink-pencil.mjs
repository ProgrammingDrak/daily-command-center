// Isolated synthetic browser QA; never opens production or user storage.
/* global document, window, PointerEvent, performance */
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";

const browser = await chromium.launch({ channel: process.env.INK_BROWSER_CHANNEL || "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 }, deviceScaleFactor: 2 });
  await page.setContent('<div id="wrap" style="width:638px;height:825px"><canvas id="base"></canvas><canvas id="live"></canvas></div>');
  await page.addScriptTag({ path: path.resolve("public/js/ink/strokes.js") });
  await page.addScriptTag({ path: path.resolve(process.env.INK_CANVAS_SOURCE || "public/js/ink/canvas.js") });
  const result = await page.evaluate(() => {
    const base = document.getElementById("base");
    const live = document.getElementById("live");
    // DOM-dispatched events are synthetic and cannot own native capture.
    const capture = new Set();
    base.setPointerCapture = (id) => capture.add(id);
    base.releasePointerCapture = (id) => capture.delete(id);
    base.hasPointerCapture = (id) => capture.has(id);
    const ink = window.InkCanvas.create({ base, live, wrap: document.getElementById("wrap") });
    ink.layout();
    function event(type, id, x, y) {
      const r = base.getBoundingClientRect();
      base.dispatchEvent(new PointerEvent(type, { pointerType: "pen", pointerId: id,
        clientX: r.left + x, clientY: r.top + y, pressure: 0.6, buttons: type === "pointerup" ? 0 : 1 }));
    }
    const lifts = [];
    for (let id = 0; id < 100; id++) {
      event("pointerdown", id, 20, 20 + id * 3);
      const count = id === 0 ? 10000 : 12;
      for (let i = 1; i < count; i++) event("pointermove", id, 20 + (i % 300), 20 + id * 3 + Math.sin(i / 5) * 10);
      const start = performance.now();
      event("pointerup", id, 30, 30);
      lifts.push(performance.now() - start);
    }
    // Compare the committed raster with a canonical full vector redraw. Browser
    // alpha rounding across intermediate canvases may differ by a few levels.
    const beforeUrl = base.toDataURL();
    const before = base.getContext("2d").getImageData(0, 0, base.width, base.height).data;
    ink.redraw();
    const after = base.getContext("2d").getImageData(0, 0, base.width, base.height).data;
    let maxDifference = 0, materialPixels = 0;
    for (let i = 0; i < before.length; i += 4) {
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs(before[i + c] - after[i + c])));
      maxDifference = Math.max(d, maxDifference);
      if (d > 8) materialPixels++;
    }
    return { beforeUrl, afterUrl: base.toDataURL(), strokes: ink.getPage().strokes.length, maxDifference, materialPixels,
      longStrokeLiftMs: lifts[0], maxLiftMs: Math.max(...lifts), penDown: ink.isPenDown() };
  });
  if (process.env.INK_PIXEL_EVIDENCE) {
    await writeFile("ink-before.png", Buffer.from(result.beforeUrl.split(",")[1], "base64"));
    await writeFile("ink-after.png", Buffer.from(result.afterUrl.split(",")[1], "base64"));
  }
  delete result.beforeUrl;
  delete result.afterUrl;
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.strokes, 100);
  assert.equal(result.penDown, false);
  assert.equal(result.materialPixels, 0, "committed ink differs visibly from canonical redraw");
} finally {
  await browser.close();
}
