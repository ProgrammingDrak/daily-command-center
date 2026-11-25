// Isolated browser regression for the full-screen journal sketchbook.
// No production requests or user storage: files are fulfilled from disk.
/* global document, window, history, sketch, devicePixelRatio */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
const base = 'http://journal-qa.test/scripts/journal-pencil-fixture.html';
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 });
  await context.route('http://journal-qa.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({ body: await readFile(path.resolve(file)), contentType:
      file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const checks = [];
  const check = (condition, name) => { assert.ok(condition, name); checks.push(name); };

  // Sharp at the inline size: backing store matches CSS size times DPR.
  const sharp = () => page.evaluate(() => {
    const c = document.querySelector('[data-canvas]'), r = c.getBoundingClientRect();
    return { w: c.width, h: c.height, cssW: r.width, cssH: r.height, dpr: devicePixelRatio };
  });
  const isSharp = s => Math.abs(s.w - s.cssW * s.dpr) <= 1 && Math.abs(s.h - s.cssH * s.dpr) <= 1;
  const inline = await sharp();
  check(isSharp(inline) && inline.dpr === 2, 'inline canvas backed at device pixels');
  check(Math.abs(inline.cssW / inline.cssH - 1000 / 1200) < 0.01, 'inline page keeps its aspect ratio');

  // Pick the pen before going full screen; it persists across cycles.
  await page.click('.jsk-toolbox [data-tool="pen"]');
  await page.click('[data-close-popup]');
  await page.evaluate(() => { window.canvasRef = document.querySelector('[data-canvas]'); });
  const strokes = () => page.evaluate(() => sketch.readCommitted()[0].length);
  async function draw(offset) {
    const box = await page.locator('[data-canvas]').boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * (0.2 + offset));
    await page.mouse.down();
    for (let n = 1; n <= 12; n++) await page.mouse.move(box.x + box.width * (0.2 + n * 0.05), box.y + box.height * (0.2 + offset + n * 0.01));
    await page.mouse.up();
  }
  const historyBefore = await page.evaluate(() => history.length);
  const ways = ['button', 'escape', 'back', 'button', 'escape'];
  for (let cycle = 0; cycle < ways.length; cycle++) {
    await page.click('[data-expand]');
    await page.waitForSelector('.jsk-overlay.open .journal-sketchbook.is-fullscreen');
    await page.waitForTimeout(260);
    const state = await page.evaluate(() => {
      const r = document.querySelector('.jsk-overlay').getBoundingClientRect();
      return { fixed: getComputedStyle(document.querySelector('.jsk-overlay')).position, w: r.width, h: r.height,
        vw: window.innerWidth, vh: window.innerHeight, overflow: document.documentElement.style.overflow,
        touch: getComputedStyle(document.querySelector('[data-canvas]')).touchAction,
        same: document.querySelector('[data-canvas]') === window.canvasRef, marked: !!history.state?.jskSketch };
    });
    check(state.fixed === 'fixed' && state.w === state.vw && state.h === state.vh, `cycle ${cycle + 1}: overlay covers the viewport`);
    check(state.overflow === 'hidden', `cycle ${cycle + 1}: page scroll locked`);
    check(state.touch === 'none', `cycle ${cycle + 1}: canvas touch-action none`);
    check(state.same, `cycle ${cycle + 1}: canvas not remounted`);
    check(state.marked, `cycle ${cycle + 1}: history entry pushed`);
    const full = await sharp();
    check(isSharp(full) && full.cssW > inline.cssW * 1.5, `cycle ${cycle + 1}: full-screen canvas sharp and larger`);
    if (cycle === 0) {
      // GoodNotes-style layout: the page fills the width under one slim bar.
      const shape = await page.evaluate(() => {
        const visible = s => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none'; };
        return { pageW: document.querySelector('[data-canvas]').getBoundingClientRect().width, vw: window.innerWidth,
          bar: document.querySelector('.jsk-fsbar').getBoundingClientRect().height,
          oldChrome: ['.jsk-menu', '.jsk-toolbox', '.jsk-context', '.jsk-pages.journal-page-turn'].some(visible) };
      });
      check(shape.pageW >= shape.vw - 16, 'full-screen page fills the width');
      check(shape.bar <= 72 && !shape.oldChrome, 'one slim bar replaces the inline toolbars');
      await page.mouse.move(450, 600);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(150);
      check(await page.evaluate(() => document.querySelector('.jsk-gallery').scrollTop) > 0, 'the page scrolls beneath the bar');
      await page.evaluate(() => { document.querySelector('.jsk-gallery').scrollTop = 0; });
      await page.click('[data-fs-hide]');
      check(!(await page.locator('.jsk-fsbar').isVisible()) && await page.locator('[data-fs-show]').isVisible(), 'Hide tools leaves only the page');
      await page.click('[data-fs-show]');
      check(await page.locator('.jsk-fsbar').isVisible(), 'Show tools restores the bar');
      await page.click('[data-fs-more]');
      check(await page.locator('.jsk-popup:visible').getByRole('button', { name: 'Export drawing' }).count() === 1, 'More holds the secondary actions');
      await page.click('[data-close-popup]');
    }
    // A backdrop click never dismisses.
    await page.evaluate(() => document.querySelector('.jsk-overlay').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    check(await page.locator('.jsk-overlay.open').count() === 1, `cycle ${cycle + 1}: backdrop click ignored`);
    const before = await strokes();
    await draw(cycle * 0.08);
    check(await strokes() === before + 1, `cycle ${cycle + 1}: stroke recorded`);
    const way = ways[cycle];
    if (way === 'button') await page.click('.jsk-minimize');
    else if (way === 'escape') await page.keyboard.press('Escape');
    else await page.goBack();
    await page.waitForFunction(() => !document.querySelector('.dcc-overlay'));
    const after = await page.evaluate(() => ({
      inline: document.querySelector('#mount .journal-sketchbook:not(.is-fullscreen)') !== null,
      same: document.querySelector('[data-canvas]') === window.canvasRef,
      focus: document.activeElement?.matches('[data-expand]'),
      overflow: document.documentElement.style.overflow,
      marked: !!history.state?.jskSketch, saves: window.minimizeSaves || 0
    }));
    check(after.inline && after.same, `cycle ${cycle + 1} (${way}): stage back inline, same canvas`);
    check(after.focus, `cycle ${cycle + 1} (${way}): focus returned to the card`);
    check(after.overflow === '', `cycle ${cycle + 1} (${way}): page scroll restored`);
    check(!after.marked, `cycle ${cycle + 1} (${way}): history entry removed`);
    check(after.saves === cycle + 1, `cycle ${cycle + 1} (${way}): autosaved on minimize`);
    check(await strokes() === cycle + 1, `cycle ${cycle + 1} (${way}): no drawing lost`);
  }
  check(await page.evaluate(() => history.length) >= historyBefore, 'history stays navigable');
  check(isSharp(await sharp()), 'inline canvas sharp after cycles');

  // A minimize with no edits does not autosave.
  await page.click('[data-expand]');
  await page.waitForSelector('.jsk-overlay.open');
  await page.click('.jsk-minimize');
  await page.waitForFunction(() => !document.querySelector('.dcc-overlay'));
  check(await page.evaluate(() => window.minimizeSaves) === ways.length, 'unchanged minimize skips autosave');

  // The autosaved drawing survives a real reload.
  await page.goto(base + '?restore');
  check(await strokes() === ways.length, 'drawing survives reload');
  // Touch: a finger scrolls the page; a pen stroke draws and never scrolls.
  const touchContext = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, deviceScaleFactor: 2 });
  await touchContext.route('http://journal-qa.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({ body: await readFile(path.resolve(file)), contentType:
      file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  const touchPage = await touchContext.newPage();
  touchPage.on('pageerror', error => errors.push(error.message));
  await touchPage.goto(base);
  await touchPage.click('[data-expand]');
  await touchPage.waitForSelector('.jsk-overlay.open .is-fullscreen');
  const touch = await touchPage.evaluate(() => {
    const box = document.querySelector('.jsk-paper'), scroller = document.querySelector('.jsk-gallery'), canvas = document.querySelector('[data-canvas]');
    const captures = new Set();
    canvas.setPointerCapture = id => captures.add(id);
    canvas.hasPointerCapture = id => captures.has(id);
    canvas.releasePointerCapture = id => captures.delete(id);
    const finger = (type, y) => { const t = new Touch({ identifier: 1, target: box, clientX: 400, clientY: y });
      box.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true })); };
    const pen = (type, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'pen', clientX: 400, clientY: y,
      pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
    finger('touchstart', 600); finger('touchmove', 400); finger('touchend', 400);
    const fingerScroll = scroller.scrollTop;
    scroller.scrollTop = 0;
    pen('pointerdown', 600); finger('touchstart', 600); pen('pointermove', 450); finger('touchmove', 450);
    pen('pointermove', 400); finger('touchmove', 400); pen('pointerup', 400); finger('touchend', 400);
    return { fingerScroll, penScroll: scroller.scrollTop, strokes: sketch.readCommitted()[0].length };
  });
  check(touch.fingerScroll > 0, 'a finger scrolls the full-screen page');
  check(touch.penScroll === 0 && touch.strokes === 1, 'a pen stroke draws without scrolling');
  await touchContext.close();
  check(errors.length === 0, 'no page errors: ' + errors.join('; '));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser.close();
}
