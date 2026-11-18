/* global window, navigator */
// Actual glasses adapter + coordinator + disposable local PostgreSQL review API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const base = process.env.DCC_GLASSES_REVIEW_URL || 'http://127.0.0.1:18459';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert.equal((await fetch(base + '/api/health').then(r => r.json())).reviewOnly, true);
const api = async (url, body) => {
  const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, await response.clone().text()); return response.json();
};
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  for (const size of [600, 375]) {
    await api('/api/queue-review/reset', {});
    const date = new Date().toISOString().slice(0, 10);
    await api('/api/blocks', ['a', 'b'].map(id => ({ id: 'offline-' + id, type: 'block', date, properties: { local_id: 'offline-' + id, title: 'Offline recovery ' + id, type: 'task', status: 'open', duration: 15 } })));
    for (const id of ['a', 'b']) {
      const state = await api('/api/working-queue');
      await api('/api/working-queue', { action: 'queue-add', taskId: 'offline-' + id, sourceEventId: crypto.randomUUID(), expectedRevision: state.revision, at: new Date().toISOString() });
    }
    const context = await browser.newContext({ viewport: { width: size, height: 600 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/?device=glasses');
    await page.waitForFunction(() => window.DCCGlasses?.snapshot().rows !== undefined);
    const input = action => page.evaluate(action => window.DCCGlasses.input(action), action);
    await page.evaluate(() => window.DCCGlasses.refresh());
    await input('left'); // All Tasks -> Working Queue.
    await page.waitForFunction(() => window.DCCGlasses.snapshot().rows.some(r => r.id === 'offline-a'));
    await input('tap-fore'); await input('tap-fore');
    assert.equal(await page.evaluate(() => window.DCCGlasses.snapshot().selected.actionId), 'offline-a');
    await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
    let writes = 0, release, arrived;
    const held = new Promise(resolve => { release = resolve; });
    const seen = new Promise(resolve => { arrived = resolve; });
    await page.route('**/api/working-queue', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes++; arrived(); await held; return route.continue();
    });
    await page.evaluate(() => { window.offlineCompletion = window.DCCGlasses.input('tap-fore'); });
    await seen;
    await input('tap-fore');
    assert.equal(writes, 1);
    assert.match(await page.locator('.glasses-status').innerText(), /awaiting|saving/i);
    release(); await page.evaluate(() => window.offlineCompletion);
    await page.unroute('**/api/working-queue');
    let state = await api('/api/working-queue');
    assert.equal(state.queue.items.find(i => i.task.id === 'offline-a').status, 'completed');
    await input('left'); // Visible completion receipt owns left for Undo.
    state = await api('/api/working-queue');
    assert.notEqual(state.queue.items.find(i => i.task.id === 'offline-a').status, 'completed');
    console.log('PASS ' + size + ': false offline flag permits acknowledged completion and Undo, one write while held');
    await input('tap-fore');
    const before = (await api('/api/working-queue')).revision;
    await context.setOffline(true);
    await input('tap-fore');
    assert.equal((await api('/api/working-queue')).revision, before);
    assert.match(await page.locator('.glasses-status').innerText(), /not confirmed|unavailable/i);
    await context.setOffline(false);
    await page.evaluate(() => window.DCCGlasses.refresh());
    let refusedWrites = 0;
    await page.route('**/api/working-queue', route => {
      if (route.request().method() !== 'POST') return route.continue();
      refusedWrites++;
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic permission refusal' }) });
    });
    await input('tap-fore');
    assert.equal((await api('/api/working-queue')).revision, before);
    assert.equal(refusedWrites, 1);
    assert.match(await page.locator('.glasses-status').innerText(), /Synthetic permission refusal/);
    assert.deepEqual(errors, []);
    console.log('PASS ' + size + ': network failure and permission refusal preserve server state and never claim success');
    if (process.env.DCC_GLASSES_REVIEW_OUT) {
      await fs.mkdir(process.env.DCC_GLASSES_REVIEW_OUT, { recursive: true });
      await page.screenshot({ path: process.env.DCC_GLASSES_REVIEW_OUT + '/glasses-offline-' + size + '.png' });
    }
    await context.close();
  }
} finally { await browser.close(); }
