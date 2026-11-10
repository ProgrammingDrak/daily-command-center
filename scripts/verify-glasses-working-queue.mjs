/* global window */
// Integrated glasses UI + real queue API, only in an opt-in disposable review account.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
const base = process.env.DCC_GLASSES_REVIEW_URL || 'http://127.0.0.1:18449';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert.equal((await fetch(base + '/api/health').then(r => r.json())).reviewOnly, true);
const out = process.env.DCC_GLASSES_REVIEW_OUT || '/tmp/dcc-glasses-working-queue';
await fs.mkdir(out, { recursive: true });
const api = async (url, body) => {
  const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, await response.clone().text()); return response.json();
};
async function action(action, extra = {}) {
  const state = await api('/api/working-queue');
  return api('/api/working-queue', { action, sourceEventId: crypto.randomUUID(), expectedRevision: state.revision, at: new Date().toISOString(), ...extra });
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const context = await browser.newContext({ viewport: { width: 600, height: 600 } });
await context.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
const page = await context.newPage(), errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
const check = name => { checks.push(name); console.log('PASS ' + name); };
const input = action => page.evaluate(action => window.DCCGlasses.input(action), action);
const selected = () => page.locator('.glasses-task-row[aria-selected="true"]').getAttribute('data-task-id');
async function choose(id) {
  await input('double-middle');
  await input('tap-fore');
  for (let i = 0; i < 40; i++) await input('up');
  for (let i = 0; i < 40 && await selected() !== id; i++) await input('down');
  assert.equal(await selected(), id, 'target remains navigable: ' + id);
  await input('tap-fore');
}
const queueItem = async id => (await api('/api/working-queue')).queue.items.find(i => i.task.id === id);
const waitStatus = async (id, status) => {
  for (let i = 0; i < 100; i++) { if ((await queueItem(id))?.status === status) return; await page.waitForTimeout(50); }
  assert.equal((await queueItem(id))?.status, status);
};
try {
  await api('/api/queue-review/reset', {});
  await api('/api/blocks', ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id: 'glasses-' + id, type: 'block', date: new Date().toISOString().slice(0, 10), properties: { local_id: 'glasses-' + id, title: ['Review the project handoff', 'Research the next approach', 'Prepare tomorrow’s outline', 'Send the finished draft', 'Check the remaining details'][i], type: 'task', status: 'open', duration: 30 } })));
  for (const id of ['a', 'b', 'c', 'd', 'e']) await action('queue-add', { taskId: 'glasses-' + id });
  await action('start', { taskId: 'glasses-a', remindMinutes: null });
  await page.goto(base + '/glasses.html'); await page.waitForSelector('.glasses-task-row');
  assert.equal(new URL(page.url()).searchParams.get('device'), 'glasses');
  assert.equal(await page.locator('#glasses-app').getAttribute('data-level'), 'jump');
  check('existing glasses bookmark launches integrated navigation on real isolated queue data');
  const original = await api('/api/working-queue');
  await input('tap-fore');
  for (let i = 0; i < 20; i++) { await input('down'); await input('up'); }
  assert.equal((await api('/api/working-queue')).revision, original.revision);
  await page.evaluate(() => window.DCCWorkingQueue.render());
  assert.ok(await selected());
  check('repeated navigation and canonical rerender do not mutate queue state');
  await choose('glasses-b'); await input('up'); await waitStatus('glasses-b', 'foreground');
  const switched = await api('/api/working-queue');
  assert.equal(switched.queue.items.filter(i => i.status === 'foreground').length, 1);
  assert.equal(switched.queue.items.find(i => i.task.id === 'glasses-a').status, 'queued');
  check('Task Up uses canonical foreground coordinator and safely queues displaced foreground without worker evidence');
  await input('up'); await waitStatus('glasses-b', 'background');
  assert.match(await page.locator('.glasses-status').innerText(), /30 minutes/);
  await input('down');
  const beforeOutcome = (await api('/api/working-queue')).revision;
  await page.getByRole('button', { name: 'Open existing outcome flow', exact: true }).click();
  await page.locator('#done-modal-overlay.open').waitFor();
  assert.ok(await page.locator('#done-modal-cancel').isVisible());
  await page.locator('#done-modal-cancel').click();
  assert.equal((await api('/api/working-queue')).revision, beforeOutcome);
  check('Foreground Up moves to real Background with 30-minute snooze; More opens cancellable canonical outcome flow');
  await choose('glasses-c'); await input('right');
  assert.ok(!(await api('/api/working-queue')).queue.items.some(i => i.task.id === 'glasses-c'));
  // The task remains available in All Tasks after membership removal.
  await choose('glasses-c');
  check('Task Right removes queue membership without deleting the task');
  await choose('glasses-d');
  let release, arrived;
  const gate = new Promise(r => { release = r; });
  const seen = new Promise(r => { arrived = r; });
  let submissions = 0;
  await page.route('**/api/working-queue', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions++; arrived(); await gate; return route.continue();
  });
  // Do not await the ACK-bound input promise while deliberately holding the response.
  await page.evaluate(() => { window.__glassesPending = window.DCCGlasses.input('left'); });
  await seen;
  assert.notEqual((await queueItem('glasses-d'))?.status, 'completed');
  assert.equal(await page.locator('#glasses-undo').isVisible(), false);
  assert.match(await page.locator('.glasses-status').innerText(), /awaiting|saving|completing/i);
  await input('tap-fore'); await input('left'); // A repeated completion while pending must not submit again.
  await input('tap-middle'); await input('down');
  assert.notEqual(await selected(), 'glasses-d');
  release(); await page.evaluate(() => window.__glassesPending);
  await waitStatus('glasses-d', 'completed');
  assert.equal(submissions, 1);
  await page.unroute('**/api/working-queue');
  check('delayed completion makes one request, does not claim success before ACK, and navigation stays live');
  let releaseUndo, undoArrived;
  const undoGate = new Promise(r => { releaseUndo = r; });
  const undoSeen = new Promise(r => { undoArrived = r; });
  await page.route('**/api/working-queue', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    undoArrived(); await undoGate; return route.continue();
  });
  await page.evaluate(() => { window.__glassesPendingUndo = window.DCCGlasses.input('double-middle'); });
  await undoSeen;
  assert.equal((await queueItem('glasses-d'))?.status, 'completed');
  await input('tap-middle'); await input('up');
  assert.ok(await selected());
  releaseUndo(); await page.evaluate(() => window.__glassesPendingUndo);
  await page.unroute('**/api/working-queue');
  assert.notEqual((await queueItem('glasses-d'))?.status, 'completed');
  check('double-middle performs actual server-backed completion undo within five seconds with navigation live during delayed undo');
  await choose('glasses-e');
  await input('left'); await waitStatus('glasses-e', 'completed');
  await page.waitForTimeout(5200);
  assert.equal(await page.locator('#glasses-undo').isVisible(), false);
  const expiredRevision = (await api('/api/working-queue')).revision;
  await input('double-middle');
  assert.equal((await api('/api/working-queue')).revision, expiredRevision);
  assert.equal((await queueItem('glasses-e'))?.status, 'completed');
  check('expired five-second receipt disappears and double-middle returns home without reopening');
  await choose('glasses-a');
  const beforeRefusal = await api('/api/working-queue');
  await context.setOffline(true);
  await input('left');
  assert.equal((await api('/api/working-queue')).revision, beforeRefusal.revision);
  assert.match(await page.locator('.glasses-status').innerText(), /offline/i);
  await context.setOffline(false);
  await page.evaluate(() => window.DCCGlasses.refresh());
  check('offline completion is blocked before submission and cannot change the server');
  await page.route('**/api/working-queue', r => r.request().method() === 'POST' ? r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic permission refusal' }) }) : r.continue());
  await input('left');
  assert.equal((await api('/api/working-queue')).revision, beforeRefusal.revision);
  assert.notEqual((await queueItem('glasses-a'))?.status, 'completed');
  assert.match(await page.locator('.glasses-status').innerText(), /refus|permission|failed|not|conflict/i);
  await page.unroute('**/api/working-queue');
  check('permission refusal preserves confirmed task state and displays failure instead of success');
  await page.screenshot({ path: path.join(out, 'glasses-queue-600.png') });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ checks, errors, synthetic: true, physicalMeta: false }, null, 2));
} catch (error) {
  console.log(await page.evaluate(() => window.DCCGlasses?.snapshot()));
  await page.screenshot({ path: path.join(out, 'failure.png') }); throw error;
} finally { await browser.close(); }
