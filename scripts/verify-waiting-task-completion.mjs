/* global window, document, Event */
// Run against PORT=8344 DCC_WAITING_REVIEW=1 DCC_PGLITE_MODULE=@electric-sql/pglite node scripts/ui-review-server.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://127.0.0.1:8344';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.equal((await (await fetch(base + '/api/health')).json()).reviewOnly, true, 'never run on a live server');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
let groups = 0;
try {
for (const width of [1280, 390, 320]) for (const surface of ['itinerary', 'loose-ends']) {
  await fetch(base + '/api/review/waiting/reset', { method: 'POST' });
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.method() === 'POST' && /waiting-items\/.+\/(complete|check-ins\/complete)$/.test(req.url())) writes.push({ url: req.url(), body: req.postDataJSON() }); });
  const state = async () => (await page.request.get(base + '/api/review/waiting/state')).json();
  const ready = async () => { await page.waitForSelector('.it-list-item.waiting-row .it-list-check'); await page.waitForFunction(() => window.DCC?.Waiting && window.getAttentionWaitingItems?.().length > 0); };
  const open = async () => {
    if (surface === 'loose-ends') { if (!await page.locator('#catchup-overlay.open').count()) await page.locator('#loose-ends-pill').click(); }
    const checkbox = page.locator(surface === 'itinerary' ? '.it-list-item.waiting-row .it-list-check' : '.cu-waiting-row .it-list-check').first();
    await checkbox.focus(); await page.keyboard.press('Space');
    await page.waitForSelector('.waiting-checkin-form');
    assert.equal(await page.locator('.dcc-overlay').getAttribute('data-overlay-kind'), width < 600 ? 'sheet' : 'modal');
    return checkbox;
  };
  await page.goto(base); await ready();
  const opener = await open();
  assert.equal(await page.getByRole('radio', { name: 'Check-in done — still waiting' }).isChecked(), true);
  if (surface === 'loose-ends') {
    const anchor = await opener.elementHandle();
    await page.evaluate(() => window.DCC.CatchUp.refresh({ focus: false }));
    assert.equal(await anchor.evaluate(el => el.isConnected), true, 'background refresh keeps the dialog focus-return target');
  }
  await page.keyboard.press('Escape'); await page.locator('.dcc-overlay').waitFor({ state: 'detached' });
  assert.equal(writes.length, 0);
  assert.equal(await opener.evaluate(el => el === document.activeElement), true, 'cancel restores the triggering checkbox');
  await open();
  await page.getByRole('radio', { name: 'Complete task', exact: true }).check();
  assert.equal(await page.locator('#wci-date').isVisible(), false);
  const bounds = await page.locator('.dcc-overlay-body').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(bounds.scroll <= bounds.client, 'no horizontal overflow');
  // Error before commit leaves the chosen action and editable dialog intact.
  let fail = true;
  await page.route('**/api/waiting-items/*/complete', async route => { if (fail) { fail = false; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic retryable failure"}' }); } else await route.continue(); });
  await page.getByRole('button', { name: 'Complete task', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Retry safely' }).waitFor();
  assert.equal((await state()).rows[0].properties.status === 'done', false);
  await page.getByRole('button', { name: 'Complete task', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.evaluate(() => { const form = document.querySelector('.waiting-checkin-form'); form.dispatchEvent(new Event('submit', { cancelable: true })); form.dispatchEvent(new Event('submit', { cancelable: true })); });
  await page.locator('.dcc-overlay').waitFor({ state: 'detached' });
  assert.equal(writes.length, 2, 'one error plus one successful request despite repeated submit');
  assert.deepEqual(writes[0].body, writes[1].body, 'retry retains captured completion intent');
  let saved = await state();
  assert.ok(saved.rows.every(row => row.properties.status === 'done'));
  assert.equal((saved.rows[1].properties.checkInHistory || []).length, 0);
  const revision = saved.rows[0].properties._completionRevision;
  await page.reload(); await page.waitForTimeout(600);
  saved = await state(); assert.equal(saved.rows[0].properties._completionRevision, revision);
  assert.equal(await page.locator('.it-list-item.waiting-row:not(.done) .it-list-check').count(), 0, 'pending check-ins stay closed on reload');
  assert.equal(errors.length, 0, errors.join('\n'));
  groups++; console.log(`PASS ${width}px ${surface}: keyboard/cancel/focus, explicit completion, error/retry, repeated submit, canonical persistence/reload`);
  await context.close();

  // Check-in-only remains a separate cycle: complete its reminder, retain work.
  await fetch(base + '/api/review/waiting/reset', { method: 'POST' });
  const c2 = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600, reducedMotion: 'reduce' });
  const p2 = await c2.newPage(); await p2.goto(base); await p2.waitForSelector('.it-list-item.waiting-row .it-list-check');
  if (surface === 'loose-ends') await p2.locator('#loose-ends-pill').click();
  await p2.locator(surface === 'itinerary' ? '.it-list-item.waiting-row .it-list-check' : '.cu-waiting-row .it-list-check').first().click();
  await p2.locator('#wci-date').fill('2099-01-01');
  await p2.locator('#wci-note').fill('Synthetic follow-up; still waiting');
  await p2.getByRole('button', { name: 'Save check-in' }).click();
  await p2.locator('.dcc-overlay').waitFor({ state: 'detached' });
  const checked = await (await p2.request.get(base + '/api/review/waiting/state')).json();
  assert.notEqual(checked.rows[0].properties.status, 'done'); assert.equal(checked.rows[1].properties.status, 'open');
  assert.equal(checked.rows[1].properties.checkInHistory.length, 1); assert.equal(checked.rows[1].properties.checkInDate, '2099-01-01');
  await p2.reload(); assert.equal((await (await p2.request.get(base + '/api/review/waiting/state')).json()).rows[1].properties.checkInHistory.length, 1);
  groups++; console.log(`PASS ${width}px ${surface}: check-in-only preserves work, history/date survive reload`);
  await c2.close();
}
for (const surface of ['itinerary', 'loose-ends']) for (const interrupted of ['response', 'cleanup']) {
  await fetch(base + '/api/review/waiting/reset', { method: 'POST' });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(base); await page.waitForSelector('.it-list-item.waiting-row .it-list-check');
  if (surface === 'loose-ends') await page.locator('#loose-ends-pill').click();
  await page.locator(surface === 'itinerary' ? '.it-list-item.waiting-row .it-list-check' : '.cu-waiting-row .it-list-check').first().tap();
  await page.getByRole('radio', { name: 'Complete task', exact: true }).check();
  if (interrupted === 'response') {
    let lose = true;
    await page.route('**/api/waiting-items/*/complete', async route => {
      if (!lose) return route.continue();
      lose = false; const response = await route.fetch(); assert.equal(response.status(), 200);
      await route.abort('connectionreset'); // server committed; acknowledgement never arrives
    });
  } else await page.request.post(base + '/api/review/waiting/fail-cleanup');
  await page.getByRole('button', { name: 'Complete task', exact: true }).tap();
  await page.getByRole('alert').filter({ hasText: interrupted === 'response' ? 'Retry safely' : 'Task completed.' }).waitFor();
  const saved = await (await page.request.get(base + '/api/review/waiting/state')).json();
  assert.equal(saved.rows[0].properties.status, 'done');
  const revision = saved.rows[0].properties._completionRevision;
  if (interrupted === 'response') {
    await page.getByRole('button', { name: 'Complete task', exact: true }).tap();
    await page.locator('.dcc-overlay').waitFor({ state: 'detached' });
  } else {
    // An interrupted tab does not strand cleanup: a remaining itinerary check-in
    // offers cleanup only, and can never mark reopened work complete again.
    await page.reload(); await page.waitForSelector('.it-list-item.waiting-row .it-list-check');
    await page.locator('.it-list-item.waiting-row .it-list-check').first().tap();
    await page.getByRole('button', { name: 'Retry cleanup' }).tap();
    await page.locator('.dcc-overlay').waitFor({ state: 'detached' });
  }
  const repaired = await (await page.request.get(base + '/api/review/waiting/state')).json();
  assert.equal(repaired.rows[0].properties._completionRevision, revision);
  assert.ok(repaired.rows.every(row => row.properties.status === 'done'));
  groups++; console.log(`PASS 390px ${surface}: interrupted ${interrupted} and safe recovery`);
  await context.close();
}
console.log(`PASS ${groups} browser groups`);
} finally { await browser.close(); }
