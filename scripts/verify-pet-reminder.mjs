// Run against the disposable scripts/ui-review-server.mjs, never a live account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
/* global window, document, innerWidth, scrollX, getComputedStyle, requestAnimationFrame, DCCWorkSessions, DCC */
const port = process.env.PET_REVIEW_PORT || '8138';
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/ui-review-server.mjs'], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('exit', code => reject(new Error(`Review server exited: ${code}`)));
  server.stdout.on('data', bytes => { if (String(bytes).includes('UI review server:')) resolve(); });
});
const out = 'test-results/pet-reminder';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const results = [];
const widths = [320, 375, 760, 761, 853, 1024, 1440];
let id;
const startedAt = new Date(Date.now() - 26 * 60000).toISOString();
async function seed(page) {
  id = `pet-viewport-review-${results.length}`;
  await page.addInitScript(() => {
    window.petViewportSamples = [];
    window.petSampling = true;
    const sample = () => {
      const runner = document.querySelector('.pet-nudge-runner');
      const rect = runner?.getBoundingClientRect();
      window.petViewportSamples.push({ x: scrollX, width: document.documentElement.scrollWidth, viewport: innerWidth, runnerLeft: rect?.left ?? null, runnerRight: rect?.right ?? null });
      if (window.petSampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto(base);
  await page.evaluate(async ({ id, startedAt }) => {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const response = await fetch('/api/blocks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      id, type: 'block', date, properties: { local_id: id, title: 'Prepare the example project handoff', type: 'task', start: '10:00', duration: 30, startedAt },
    }) });
    if (!response.ok) throw new Error('Fixture seed failed');
  }, { id, startedAt });
  await page.reload();
  await page.waitForFunction(id => window.blockStore?.get(id), id);
  await page.evaluate(() => DCCWorkSessions.refresh());
}
async function geometry(page, label) {
  const state = await page.evaluate(() => ({
    viewport: innerWidth, width: document.documentElement.scrollWidth, x: scrollX,
    headerLeft: document.querySelector('.header').getBoundingClientRect().left,
    controls: [...document.querySelectorAll('.work-checkin button')].map(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { action: el.dataset.workAction, left: r.left, right: r.right, width: r.width, height: r.height, reachable: !!hit && (hit === el || el.contains(hit)) };
    }),
  }));
  assert.equal(state.x, 0, `${label}: page shifted horizontally`);
  assert.ok(state.width <= state.viewport + 1, `${label}: overflow ${JSON.stringify(state)}`);
  assert.ok(state.headerLeft >= -1, `${label}: app header shifted off screen`);
  for (const c of state.controls) {
    assert.ok(c.left >= 0 && c.right <= state.viewport && c.reachable, `${label}: inaccessible ${JSON.stringify(c)}`);
    assert.ok(c.width >= 44 && c.height >= 44, `${label}: touch target too small`);
  }
  results.push({ label, ...state });
}
try {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 1268 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await seed(page);
    // Sample every frame, including the runner's off-screen exit.
    await page.evaluate(() => DCCWorkSessions.checkInTick());
    await page.waitForFunction(id => document.activeElement?.dataset.workTask === id && document.activeElement?.dataset.workAction === 'continue', id);
    await page.waitForTimeout(350);
    const frames = await page.evaluate(() => { window.petSampling = false; return window.petViewportSamples; });
    assert.ok(frames.length > 20, 'Exercise the animation rather than skipping it');
    assert.ok(frames.some(f => f.runnerLeft !== null && f.runnerLeft < 0), 'Observe pet entering from off-screen');
    assert.ok(frames.some(f => f.runnerLeft !== null && f.runnerLeft > 0 && f.runnerRight < f.viewport), 'Observe pet inside viewport');
    assert.ok(frames.some(f => f.runnerRight > f.viewport), 'Observe pet exiting past the viewport');
    assert.ok(frames.every(f => f.x === 0 && f.width <= f.viewport + 1), `${width}: animation overflow ${JSON.stringify(frames.filter(f => f.x || f.width > f.viewport + 1).slice(0, 3))}`);
    await geometry(page, `${width}px reminder open`);
    assert.equal(await page.locator('.pet-nudge-stage').count(), 0, 'Runner and dust are removed');
    if (width === 853) await page.screenshot({ path: `${out}/853px-open.png` });
    const continuation = page.locator(`[data-work-checkin-task="${id}"] [data-work-action="continue"]`);
    await continuation.click();
    await page.waitForFunction(id => !document.querySelector(`[data-work-checkin-task="${id}"]`), id);
    const continued = await page.evaluate(id => window.blockStore.get(id).properties, id);
    assert.equal(continued.startedAt, startedAt, 'Continue preserves the running session');
    assert.equal(continued.workCheckInCount, 1, 'Continue acknowledges exactly once');
    // A later cadence opens the same controls, with the next prompt.
    await page.evaluate(id => DCCWorkSessions.checkInTick(Date.parse(window.blockStore.get(id).properties.workCheckInAt) + 26 * 60000), id);
    await page.waitForSelector(`[data-work-checkin-task="${id}"]`);
    await page.waitForTimeout(2100);
    await geometry(page, `${width}px repeated reminder`);
    await page.locator(`[data-work-checkin-task="${id}"] [data-work-action="pause"]`).click();
    await page.waitForFunction(id => !window.blockStore.get(id).properties.startedAt, id);
    await page.waitForFunction(id => !document.querySelector(`[data-work-checkin-task="${id}"]`), id);
    assert.equal(await page.locator(`[data-work-checkin-task="${id}"]`).count(), 0, 'Pause dismisses the check-in');
    assert.equal(errors.length, 0, errors.join('\n'));
    await context.close();
  }
  // Resize an open reminder, including the effective CSS viewport at browser
  // zoom. This does not claim native Windows browser-toolbar zoom coverage.
  const context = await browser.newContext({ viewport: { width: 853, height: 1268 } });
  const page = await context.newPage();
  await seed(page);
  await page.evaluate(() => DCCWorkSessions.checkInTick());
  await page.waitForTimeout(2100);
  for (const width of [1440, 761, 760, 375, 853]) {
    await page.setViewportSize({ width, height: 1268 });
    await geometry(page, `resize ${width}px`);
  }
  for (const zoom of [1.25, 1.5, 2]) {
    await page.setViewportSize({ width: Math.floor(853 / zoom), height: Math.floor(1268 / zoom) });
    await page.locator(`[data-work-checkin-task="${id}"]`).scrollIntoViewIfNeeded();
    await geometry(page, `effective browser zoom ${zoom}`);
  }
  await page.setViewportSize({ width: 853, height: 1268 });
  // A note being edited retains focus, while the fallback reminder stays usable.
  await page.evaluate(async () => {
    const note = document.createElement('textarea'); note.id = 'review-note'; document.body.appendChild(note); note.focus();
    await DCC.PetNudge.deliverWorkCheckIn('Example task', { open() {} });
  });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'review-note');
  assert.equal(await page.locator('.pet-nudge-stage').count(), 0);
  await context.close();
  console.log(`Passed ${results.length} layout scenarios, animation frames, Continue, repeated reminders, Pause and typing focus.`);
} finally {
  fs.writeFileSync(`${out}/browser-results.json`, JSON.stringify({ browser: browser.version(), platform: process.platform, results }, null, 2));
  await browser.close();
  server.kill();
}
