// Run against scripts/ui-review-server.mjs only; all task data below is synthetic.
/* global window, document, buildProgress, scheduled:writable */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:8107';
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
page.on('pageerror', error => console.error('Page error:', error.message));
await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
// Prove this browser guard catches a missing production binding without editing files.
if (process.env.DCC_TOOLTIP_NEGATIVE_CONTROL === '1') {
  await page.route('**/public/js/schedule-tab.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: fs.readFileSync('public/js/schedule-tab.js', 'utf8').replace('_bindProgressTooltip(seg,ev,time);', ''),
  }));
}
const title = 'Review the complete quarterly plan with the team — including all outstanding decisions';
const details = 'Confirm the owners and next steps before sending the final plan.';
fs.mkdirSync('test-results/day-progress', { recursive: true });
try {
  const health = await (await page.request.get(`${base}/api/health`)).json();
  assert.ok(health.reviewOnly === true && health.database === 'fixture', 'Use the synthetic UI review server only');
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof buildProgress === 'function');
  await page.evaluate(({ title, details }) => {
    scheduled = [
      { id: 'tooltip-first', title, detail: details, start: '07:00', end: '07:01', type: 'task' },
      { id: 'tooltip-middle', title: '<img src=x onerror=alert(1)> Literal task title', detail: '<script>alert(1)</script> ' + 'Long description '.repeat(30), start: '10:00', end: '11:00', type: 'task' },
      { id: 'tooltip-last', title: 'Last task with no description', detail: '  ', start: '17:29', end: '17:30', type: 'task' },
    ];
    window.tooltipScheduleBefore = JSON.stringify(scheduled);
    window.tooltipOpened = null;
    window.openAddModal = (id, title) => { window.tooltipOpened = { id, title }; };
    buildProgress();
  }, { title, details });
  const writes = [];
  page.on('request', request => {
    // The app independently autosaves its day-root view settings during startup.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !new URL(request.url()).pathname.startsWith('/api/blocks/day-root-review-')) writes.push(request.url());
  });
  const segments = page.locator('#ptrack button.pseg');
  assert.equal(await segments.count(), 3);
  const tip = page.locator('#day-progress-tooltip');
  const inViewport = async () => {
    const box = await tip.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box && box.x >= 7 && box.y >= 7 && box.x + box.width <= viewport.width - 7 && box.y + box.height <= viewport.height - 7, JSON.stringify(box));
  };
  for (const width of [1440, 320]) {
    console.log('Checking viewport', width);
    await page.setViewportSize({ width, height: 900 });
    await segments.first().scrollIntoViewIfNeeded();
    await segments.first().hover();
    await tip.waitFor();
    assert.equal(await tip.locator('strong').textContent(), title);
    assert.equal(await tip.locator('.progress-task-tooltip-summary').textContent(), details);
    assert.match(await tip.textContent(), /7:00.*7:01.*1m/);
    await inViewport();
    await page.screenshot({ path: `test-results/day-progress/${width}-first-hover.png` });
    await tip.hover();
    await page.waitForTimeout(200);
    assert.ok(await tip.isVisible(), 'tooltip remains hoverable');
    await page.keyboard.press('Escape');
    assert.equal(await tip.count(), 0);
    await segments.last().hover();
    await tip.waitFor();
    assert.equal(await tip.locator('.progress-task-tooltip-summary').count(), 0);
    await inViewport();
    await page.screenshot({ path: `test-results/day-progress/${width}-last-hover.png` });
    await page.mouse.move(0, 0);
    await tip.waitFor({ state: 'detached' });
  }
  // Reach the segment via real Tab navigation, then preserve focus on Escape.
  await segments.first().focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert.ok(await segments.first().evaluate(node => node === document.activeElement));
  await tip.waitFor();
  assert.equal(await segments.first().getAttribute('aria-describedby'), 'day-progress-tooltip');
  await page.keyboard.press('Escape');
  assert.equal(await tip.count(), 0);
  assert.ok(await segments.first().evaluate(node => node === document.activeElement));
  await page.keyboard.press('Tab');
  await tip.waitFor();
  assert.match(await tip.locator('strong').textContent(), /^<img/);
  assert.equal(await tip.locator('img, script').count(), 0);
  const summary = await tip.locator('.progress-task-tooltip-summary').textContent();
  assert.ok(summary.length <= 240 && summary.endsWith('…'));
  await page.keyboard.press('Enter');
  assert.equal(await tip.count(), 0);
  assert.equal(await page.evaluate(() => window.tooltipOpened.id), 'tooltip-middle');
  await segments.last().focus();
  await tip.waitFor();
  await page.setViewportSize({ width: 320, height: 400 });
  await tip.waitFor({ state: 'detached' });
  assert.equal(await tip.count(), 0, 'resize dismisses stale placement');
  await segments.last().blur();
  await segments.last().focus();
  await tip.waitFor();
  await inViewport();
  await page.screenshot({ path: 'test-results/day-progress/320-short-keyboard.png' });
  await page.evaluate(() => buildProgress());
  assert.equal(await tip.count(), 0, 'rebuild clears stale tooltip');
  assert.ok(await page.evaluate(() => JSON.stringify(scheduled) === window.tooltipScheduleBefore), 'task timing unchanged');
  assert.deepEqual(writes, [], 'hover and keyboard inspection do not write or start timers');
  console.log('PASS: desktop/mobile edge hover, full title/details, empty/long/unsafe text, hover persistence, Tab/Escape/Enter, rebuild cleanup, no task writes');
} catch (error) {
  await page.screenshot({ path: 'test-results/day-progress/failure.png' });
  console.error(await page.locator('#ptrack').evaluate(node => ({ html: node.innerHTML, hovered: document.querySelector(':hover')?.tagName })));
  throw error;
} finally {
  await browser.close();
}
