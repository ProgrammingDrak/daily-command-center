// Isolated browser regression. No production requests or user storage.
/* global sketch, mount, PointerEvent, InkStrokes, performance, document, Event, innerWidth */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const baseline = process.argv.includes('--baseline');
const { chromium, webkit } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await (process.env.INK_ENGINE === 'webkit' ? webkit.launch({ headless:true }) :
  chromium.launch({ channel:'msedge', headless:true }));
try {
  const page = await browser.newPage({ viewport:{width:800,height:1000} });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Fulfill local source files directly, without exposing a server or depending
  // on machine proxy/firewall rules. An explicit URL can test a running preview.
  if (!process.env.JOURNAL_QA_URL) {
    await page.route('http://journal-qa.test/**', async route => {
      const file = new URL(route.request().url()).pathname.slice(1);
      const source = file === 'public/js/journal-sketchbook.js' && process.env.JOURNAL_SKETCH_SOURCE
        ? process.env.JOURNAL_SKETCH_SOURCE : path.resolve(file);
      const body = baseline && file === 'public/js/journal-sketchbook.js'
        ? execFileSync('git', ['show', 'HEAD:public/js/journal-sketchbook.js']) : await readFile(source);
      await route.fulfill({ body, contentType:
        file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
  }
  await page.goto(process.env.JOURNAL_QA_URL || 'http://journal-qa.test/scripts/journal-pencil-fixture.html');
  const results = await page.evaluate((baseline) => {
    const checks = [];
    function check(condition, name) { if (!condition) throw new Error(name); checks.push(name); }
    function harness(pages = [[]], options = {}) {
      if (sketch) sketch.destroy();
      const stage = mount(pages, options), canvas = stage.querySelector('[data-canvas]');
      const captures = new Set();
      canvas.setPointerCapture = id => captures.add(id);
      canvas.hasPointerCapture = id => captures.has(id);
      canvas.releasePointerCapture = id => {
        captures.delete(id);
        send('lostpointercapture', id);
      };
      function send(type, id = 1, x = 30, extra = {}) {
        const rect = canvas.getBoundingClientRect();
        const event = new PointerEvent(type, { pointerId:id, pointerType:'pen', isPrimary:true,
          button:0, buttons:type === 'pointerup' ? 0 : 1, pressure:0.6,
          clientX:rect.left + x, clientY:rect.top + 30, cancelable:true, ...extra });
        canvas.dispatchEvent(event);
      }
      if (!options.readOnly) {
        stage.querySelector('[data-tool="pen"]').click();
        stage.querySelector('[data-close-popup]').click();
      }
      return { stage, canvas, captures, send, count:() => sketch.read()[0].length };
    }
    let h = harness();
    let fullDraws = 0, serializations = 0;
    const originalDraw = InkStrokes.drawStroke, stringify = JSON.stringify;
    InkStrokes.drawStroke = (...args) => { fullDraws++; return originalDraw(...args); };
    JSON.stringify = (...args) => { serializations++; return stringify(...args); };
    const lifts = [];
    for (let id = 1; id <= 100; id++) {
      h.send('pointerdown', id);
      const n = id === 1 ? (baseline ? 60 : 10000) : 10;
      for (let p = 0; p < n; p++) h.send('pointermove', id, 30 + p % 200);
      const start = performance.now();
      h.send('pointerup', id);
      lifts.push(performance.now() - start);
      h.send('pointerdown', id + 1000, 40, {pointerType:'touch'});
      h.send('pointerup', id + 1000, 40, {pointerType:'touch'});
    }
    InkStrokes.drawStroke = originalDraw;
    JSON.stringify = stringify;
    check(h.count() === 100, '100 rapid strokes survive lifts and palms');
    check(fullDraws === 0, 'writing never replays the committed page');
    check(serializations === 0, 'writing never serializes full-page undo snapshots');
    check(h.captures.size === 0, 'capture release cannot finish a stroke twice');
    h.stage.querySelector('[data-undo]').click();
    check(h.count() === 99, 'undo removes one stroke');
    h.stage.querySelector('[data-redo]').click();
    check(h.count() === 100, 'redo restores one stroke');
    document.querySelector('#reopen').click();
    check(sketch.read()[0].length === 100, 'save/reopen preserves every stroke');

    h = harness();
    h.send('pointerdown', 1, 20, {pointerType:'touch'});
    h.send('pointerdown', 2);
    h.send('pointercancel', 1, 20, {pointerType:'touch'});
    h.send('pointerup', 2);
    check(h.count() === 1, 'Pencil preempts a palm arriving first');
    h.send('pointerdown', 3);
    h.captures.delete(3);
    h.send('lostpointercapture', 3);
    h.send('pointerdown', 4); h.send('pointerup', 4);
    check(h.count() === 3, 'unexpected capture loss accepts the next mark');
    h.send('pointerdown', 5); h.send('pointercancel', 5);
    h.send('pointerdown', 6); h.send('pointerup', 6);
    check(h.count() === 4, 'cancel discards only provisional ink');
    const capture = h.canvas.setPointerCapture;
    h.canvas.setPointerCapture = () => { throw new Error('inactive'); };
    h.send('pointerdown', 7);
    h.canvas.setPointerCapture = capture;
    h.send('pointerdown', 8); h.send('pointerup', 8);
    check(h.count() === 5, 'capture failure never strands the pointer');
    let prevented = 0;
    for (const type of ['touchstart','touchmove']) {
      const event = new Event(type, {bubbles:true,cancelable:true});
      h.canvas.dispatchEvent(event);
      if (event.defaultPrevented) prevented++;
    }
    check(prevented === 2, 'native touch recognizers are suppressed while writing');
    const legacy = {color:'#292722',size:3,points:[[10,20],[30,40]]};
    h = harness([[legacy], []]);
    h.send('pointerdown'); h.send('pointerup');
    h.stage.querySelector('[data-paper]').value = 'music';
    h.stage.querySelector('[data-paper]').dispatchEvent(new Event('change'));
    h.send('pointerdown', 2); h.send('pointerup', 2);
    h.stage.querySelector('[data-undo]').click();
    h.stage.querySelector('[data-undo]').click();
    check(h.count() === 2 && sketch.readTemplates()[0] === 'dotted', 'mixed paper and stroke undo preserves legacy ink');
    h.stage.querySelector('[data-redo]').click();
    h.stage.querySelector('[data-redo]').click();
    check(h.count() === 3 && sketch.readTemplates()[0] === 'music', 'mixed redo restores paper and stroke');
    check(stringify(sketch.read()[0][0]) === stringify(legacy), 'legacy coordinates remain unchanged');
    h.stage.querySelector('[data-next]').click();
    h.send('pointerdown', 3); h.send('pointerup', 3);
    check(sketch.read()[1].length === 1, 'page switching retains independent ink');
    for (const tool of ['pencil', 'highlighter']) {
      h = harness();
      const select = h.stage.querySelector('[data-writing]');
      select.value = tool;
      select.dispatchEvent(new Event('change'));
      h.send('pointerdown');
      for (let p = 0; p < 80; p++) h.send('pointermove', 1, 30 + p);
      h.send('pointerup');
      const context = h.canvas.getContext('2d');
      const before = context.getImageData(0,0,1000,1200).data;
      h.stage.querySelector('[data-paper]').dispatchEvent(new Event('change'));
      const after = context.getImageData(0,0,1000,1200).data;
      let different = 0;
      for (let p = 0; p < before.length; p += 4) {
        if ([0,1,2].some(c => Math.abs(before[p+c] - after[p+c]) > 12)) different++;
      }
      check(different < 100, tool + ' bitmap lift matches vector redraw');
    }
    h = harness([[]], {readOnly:true});
    h.send('pointerdown'); h.send('pointerup');
    check(h.count() === 0, 'read-only pages reject drawing');
    return {checks, longLiftMs:lifts[0], maxLiftMs:Math.max(...lifts)};
  }, baseline);
  assert.deepEqual(errors, []);
  // Also exercise real browser capture with native mouse events, without stubs.
  await page.reload();
  await page.locator('[data-tool="pen"]').click();
  await page.locator('[data-close-popup]').click();
  const box = await page.locator('[data-canvas]').boundingBox();
  for (let n = 0; n < 10; n++) {
    await page.mouse.move(box.x + 30, box.y + 40 + n * 4);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 40 + n * 4);
    await page.mouse.up();
  }
  assert.equal(await page.evaluate(() => sketch.read()[0].length), 10);
  results.checks.push('10 native mouse strokes survive real pointer capture');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  results.checks.push('390px mobile viewport has no horizontal overflow');
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
