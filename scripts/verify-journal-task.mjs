// Browser check for Journal tasks against the synthetic review server:
//   node --env-file=<env with DCC_PGLITE_MODULE, DCC_JOURNAL_REVIEW=1, PORT> scripts/ui-review-server.mjs
//   node scripts/verify-journal-task.mjs http://127.0.0.1:<PORT>
// Production block/journal routes + account binding, in-memory PGlite, fresh
// browser profiles. Refuses non-local or non-synthetic servers.
// Env: DCC_CHROMIUM_PATH (default: macOS Google Chrome), DCC_QA_OUTPUT.
/* global window, document, indexedDB, IDBObjectStore, DOMException, PageTransitionEvent, Event, localStorage, DCC, JournalPageStore */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:8297';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'local review server only');
const info = await (await fetch(base + '/api/journal-review-info')).json();
assert.equal(info.synthetic, true); assert.equal(info.storage, 'memory');
const executablePath = process.env.DCC_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output = path.resolve(process.env.DCC_QA_OUTPUT || 'journal-qa'); await fs.mkdir(output, { recursive: true });
const checks = [], errors = [];
const mark = s => { checks.push(s); console.log('PASS ' + s); };
const rows = async () => (await fetch(base + '/api/review/journal/rows')).json();
const fault = async f => fetch(base + '/api/review/journal/faults', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ journalPut: null, journalGet: null, ...f }) });
const pageFor = async (title) => { const r = await rows(); const b = r.blocks.find(x => x.properties.title === title); return { block: b, page: b && r.pages.find(p => p.task_id === b.id) }; };
const strokes = p => (p && p.ink && p.ink.strokes ? p.ink.strokes.length : 0);

function watch(page, label) {
  page.on('pageerror', e => errors.push(label + ': ' + e.message));
}
async function boot(context, user, { width = 1280, height = 900 } = {}) {
  await context.request.post(base + '/api/review/journal/session', { data: { user } });
  const page = await context.newPage(); watch(page, 'user' + user);
  await page.setViewportSize({ width, height });
  await page.goto(base); await page.locator('#api-loading').waitFor({ state: 'detached', timeout: 30000 });
  return page;
}
async function quickAddJournal(page, title) {
  await page.locator('#dcc-launcher-btn').click();
  const launcher = page.locator('#task-add-launcher');
  await launcher.locator('.tab-title').fill(title);
  await launcher.locator('.tab-dest').selectOption('journal');
  await launcher.locator('.tab-add').click();
  await page.locator('.jt-dialog').waitFor({ timeout: 10000 });
  await page.locator('.jt-dialog .jt-editor[data-jt-ready="true"]').waitFor({ timeout: 10000 });
}
async function reopenFromItinerary(page, title, ready = true) {
  await page.locator('.tab[data-tab="schedule"]').click();
  await page.locator('#tab-schedule .ttl', { hasText: title }).first().click();
  await page.locator('.jt-dialog').waitFor({ timeout: 10000 });
  await page.locator(ready ? '.jt-dialog .jt-editor[data-jt-ready="true"]' : '.jt-dialog .jt-editor[data-jt-state="open-failed"]').waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
}
async function draw(page, i = 0) {
  const box = await page.locator('.jt-dialog .jt-base').boundingBox();
  const x = box.x + 30 + (i % 5) * 60, y = box.y + 30 + Math.floor(i / 5) * 60 + (i % 3) * 8;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(x + k * 6, y + k * 4);
  await page.mouse.up();
}
const status = page => page.locator('.jt-dialog .jt-status-text').textContent();
async function waitStatus(page, re, timeout = 15000) {
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('.jt-dialog .jt-status-text')?.textContent || ''), re.source, { timeout });
}
async function close(page) {
  await page.locator('.jt-dialog .dcc-overlay-close').click();
  await page.locator('.jt-dialog').waitFor({ state: 'detached', timeout: 10000 });
}
const darkPixels = page => page.evaluate(() => {
  const c = document.querySelector('.jt-dialog .jt-base'); if (!c) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 120) n++;
  return n;
});
const localRecord = (page, journalId) => page.evaluate(id => JournalPageStore.create({ account: window.DCC_ACCOUNT_CONTEXT }).load(id), journalId);
// waitForFunction does not await an async predicate (a Promise is truthy), so
// poll the device record from here.
async function waitClean(page, journalId, timeout = 20000) {
  const until = Date.now() + timeout;
  for (;;) {
    const rec = await localRecord(page, journalId).catch(() => null);
    if (rec && !rec.dirty) return rec;
    if (Date.now() > until) throw new Error('page ' + journalId + ' still dirty after ' + timeout + 'ms');
    await page.waitForTimeout(500);
  }
}

const browser = await chromium.launch({ headless: true, executablePath });
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcc-journal-profile-'));
try {
  // ── 1. Quick add -> draw -> sync -> close -> reopen (fresh profile) ─────────
  const ctxA = await browser.newContext();
  let page = await boot(ctxA, 1);
  const A = 'Synthetic evening pages';
  await quickAddJournal(page, A);
  await draw(page, 0); await draw(page, 1);
  await waitStatus(page, /Saved and synced/);
  let { block: blockA, page: rowA } = await pageFor(A);
  assert.equal(blockA.properties.type, 'journal'); assert.equal(blockA.properties.publicVisibility, 'private');
  assert.match(blockA.properties.journalId, /^jr_/); assert.equal(rowA.journal_id, blockA.properties.journalId);
  assert.equal(strokes(rowA), 2); assert.equal(rowA.owner_user_id, 1);
  assert.doesNotMatch(JSON.stringify(blockA.properties), /strokes|pts/);
  await page.screenshot({ path: path.join(output, '01-quick-add-desktop.png') });
  await close(page);
  await reopenFromItinerary(page, A);
  assert.ok(await darkPixels(page) > 20, 'reopened page shows ink');
  mark('Quick add creates a private Journal task; 2 strokes saved locally then synced; content not in task JSON; itinerary title reopens the same page');

  // ── 2. Reload -> reopen -> continue editing on the accepted revision ──────
  await close(page); await page.reload(); await page.locator('#api-loading').waitFor({ state: 'detached', timeout: 30000 });
  await reopenFromItinerary(page, A);
  assert.ok(await darkPixels(page) > 20);
  await draw(page, 2); await waitStatus(page, /Saved and synced/);
  ({ page: rowA } = await pageFor(A)); assert.equal(strokes(rowA), 3); assert.equal(rowA.revision, 2);
  mark('Reload keeps the page; a new stroke syncs as revision 2 on the same journal');

  // ── 3. Remote 500, then retry ─────────────────────────────────────────────
  await fault({ journalPut: { status: 500 } });
  await draw(page, 3); await waitStatus(page, /DCC had a problem/);
  assert.equal((await localRecord(page, blockA.properties.journalId)).dirty, true);
  ({ page: rowA } = await pageFor(A)); assert.equal(strokes(rowA), 3, 'server unchanged');
  await fault({}); await page.locator('.jt-dialog .jt-retry').click(); await waitStatus(page, /Saved and synced/);
  ({ page: rowA } = await pageFor(A)); assert.equal(strokes(rowA), 4);
  mark('500: strokes stay on device and dirty, status says retrying, Retry syncs them');

  // ── 4. Remote 401, then retry ─────────────────────────────────────────────
  await fault({ journalPut: { status: 401, code: 'SIGNED_OUT' } });
  await draw(page, 4); await waitStatus(page, /Sign in to sync/);
  await fault({}); await page.locator('.jt-dialog .jt-retry').click(); await waitStatus(page, /Saved and synced/);
  ({ page: rowA } = await pageFor(A)); assert.equal(strokes(rowA), 5);
  mark('401: sync pauses with a sign-in message; nothing dropped; Retry syncs');

  // ── 5. Conflict, with the comparison fetch failing first ──────────────────
  const current = rowA.revision;
  const other = await ctxA.request.put(base + '/api/journal/tasks/' + blockA.id, {
    headers: { 'X-DCC-User': '1', 'X-DCC-Workspace': 'ws-1' },
    data: { journalId: blockA.properties.journalId, ink: { v: 1, w: 1275, h: 1650, strokes: [] }, body: 'other device', expectedRevision: current, mutationId: 'other-device-1' } });
  assert.equal(other.status(), 200);
  await fault({ journalGet: { status: 500 } });
  await draw(page, 5); await waitStatus(page, /loading the saved copy to compare/);
  await fault({}); await page.locator('.jt-dialog .jt-retry').click();
  await page.locator('.jt-dialog [data-jt-banner="keep-local"]').waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(output, '05-conflict.png') });
  await page.locator('.jt-dialog [data-jt-banner="keep-local"]').click(); await waitStatus(page, /Saved and synced/);
  ({ page: rowA } = await pageFor(A)); assert.equal(strokes(rowA), 6); assert.equal(rowA.revision, current + 2);
  mark('Conflict: failed comparison fetch stays retryable; Retry shows the choice; keeping this device overwrites only after explicit choice');

  // ── 6. Local IndexedDB failure blocks a lossy close; retry recovers ───────
  await page.evaluate(() => { window.__realPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); }; });
  await draw(page, 6); await waitStatus(page, /Not saved on this device/);
  await page.locator('.jt-dialog .dcc-overlay-close').click();
  await page.locator('.jt-dialog [data-jt-banner="retry-save"]').waitFor();
  assert.equal(await page.locator('.jt-dialog').count(), 1, 'close blocked');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.jt-dialog').count(), 1, 'escape blocked too');
  await page.screenshot({ path: path.join(output, '06-local-failure.png') });
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__realPut; });
  await page.locator('.jt-dialog [data-jt-banner="retry-save"]').click(); await waitStatus(page, /Saved and synced/);
  ({ page: rowA } = await pageFor(A)); assert.equal(strokes(rowA), 7);
  await close(page);
  mark('Local save failure is shown, blocks close and Escape, and Retry save writes then syncs the stroke');

  // ── 7. Replacement by another dialog while the local save is failing ──────
  await reopenFromItinerary(page, A);
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); }; });
  await draw(page, 7); await waitStatus(page, /Not saved on this device/);
  const replaced = await page.evaluate(() => { const h = DCC.modal({ title: 'Synthetic other dialog', body: 'x' }); const mine = h.el.classList.contains('jt-dialog'); h.close('close'); return { mine }; });
  assert.equal(replaced.mine, false, 'the other dialog got its own handle');
  await page.locator('.jt-dialog').waitFor({ state: 'detached' });
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__realPut; });
  await reopenFromItinerary(page, A);
  await waitStatus(page, /Saved and synced/);
  ({ page: rowA } = await pageFor(A)); assert.equal(strokes(rowA), 8, 'in-memory strokes restored on reopen and saved');
  await close(page);
  mark('Another dialog replacing the editor gets its own handle; unsaved strokes are kept in memory and saved on reopen');

  // ── 8. Offline in an already-open page, then reconnect ────────────────────
  await reopenFromItinerary(page, A);
  await ctxA.setOffline(true);
  await draw(page, 8); await waitStatus(page, /Offline/);
  assert.equal((await localRecord(page, blockA.properties.journalId)).dirty, true);
  await close(page);                       // closed editor must still drain
  await ctxA.setOffline(false);
  await waitClean(page, blockA.properties.journalId);
  ({ page: rowA } = await pageFor(A)); assert.equal(strokes(rowA), 9);
  mark('Offline while open: saved on device with Offline status; after closing the editor, reconnect drains it without reopening');

  // ── 9. Rapid A->B switch with delayed server saves ────────────────────────
  const B = 'Synthetic morning pages';
  await quickAddJournal(page, B); await draw(page, 0); await waitStatus(page, /Saved and synced/);
  await close(page);
  await fault({ journalPut: { delayMs: 2500 } });
  await reopenFromItinerary(page, A); await draw(page, 9);
  await close(page);
  await reopenFromItinerary(page, B); await draw(page, 1); await draw(page, 2);
  await page.waitForTimeout(500);
  const bPixels = await darkPixels(page);
  await fault({});
  await waitStatus(page, /Saved and synced/, 20000);
  await page.waitForTimeout(3500);
  ({ page: rowA } = await pageFor(A)); const { page: rowB, block: blockB } = await pageFor(B);
  if (strokes(rowB) !== 3 || strokes(rowA) !== 10) console.log('DEBUG step9 local B', (await localRecord(page, blockB.properties.journalId)).ink.strokes.length, 'local A', (await localRecord(page, blockA.properties.journalId)).ink.strokes.length, 'server', strokes(rowA), strokes(rowB));
  assert.equal(strokes(rowA), 10); assert.equal(strokes(rowB), 3);
  assert.notEqual(blockA.properties.journalId, blockB.properties.journalId);
  assert.ok(Math.abs((await darkPixels(page)) - bPixels) < 5, 'A\'s late save never repainted B');
  await close(page);
  mark('Rapid A->B switch with 2.5 s delayed saves: each page gets only its own strokes; B never repainted by A');

  // ── 10. Close mid-stroke and pagehide mid-stroke ──────────────────────────
  await reopenFromItinerary(page, B);
  const box = await page.locator('.jt-dialog .jt-base').boundingBox();
  await page.mouse.move(box.x + 200, box.y + 300); await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(box.x + 200 + k * 7, box.y + 300 + k * 3);
  await page.keyboard.press('Escape');
  await page.locator('.jt-dialog').waitFor({ state: 'detached', timeout: 10000 });
  await page.mouse.up();
  const jidB = blockB.properties.journalId;
  assert.equal((await localRecord(page, jidB)).ink.strokes.length, 4, 'Escape mid-stroke commits the stroke before closing');
  await reopenFromItinerary(page, B);
  const box2 = await page.locator('.jt-dialog .jt-base').boundingBox();
  await page.mouse.move(box2.x + 250, box2.y + 400); await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(box2.x + 250 + k * 7, box2.y + 400 + k * 3);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); });
  await page.waitForTimeout(500);
  await page.mouse.up();
  assert.equal((await localRecord(page, jidB)).ink.strokes.length, 5, 'pagehide mid-stroke commits and writes the stroke');
  await close(page);
  mark('Escape mid-stroke and pagehide mid-stroke both commit the in-progress stroke to the device');

  // ── 11. Account separation, stale-tab binding, fresh profile ──────────────
  const ctxB = await browser.newContext();
  const pageB = await boot(ctxB, 2);
  const foreign = await pageB.evaluate(async id => { const r = await fetch('/api/journal/tasks/' + id); return { status: r.status, body: await r.text() }; }, blockA.id);
  assert.equal(foreign.status, 404); assert.doesNotMatch(foreign.body, /strokes|evening/);
  const foreignPut = await pageB.evaluate(async ({ id, jid }) => (await fetch('/api/journal/tasks/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ journalId: jid, ink: null, body: 'hijack', expectedRevision: 0 }) })).status, { id: blockA.id, jid: blockA.properties.journalId });
  assert.equal(foreignPut, 404);
  const dbNames = await pageB.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
  assert.ok(!dbNames.some(n => /u1:/.test(n || '')), 'fresh profile has no other account database');
  assert.deepEqual(await pageB.evaluate(() => JournalPageStore.create({ account: window.DCC_ACCOUNT_CONTEXT }).listDirty()), []);
  mark('Other account (fresh profile): server read/write of user 1 journal is 404; no user-1 database present');
  // Same browser profile, account switched by a sign-in in another tab.
  await reopenFromItinerary(page, A);
  await ctxA.request.post(base + '/api/review/journal/session', { data: { user: 2 } });
  await draw(page, 10); await waitStatus(page, /another account/);
  assert.equal((await localRecord(page, blockA.properties.journalId)).dirty, true, 'kept for the original account');
  ({ page: rowA } = await pageFor(A)); assert.equal(strokes(rowA), 10, 'stale tab could not write as user 2');
  await page.reload(); await page.locator('#api-loading').waitFor({ state: 'detached', timeout: 30000 });
  const asUser2 = await page.evaluate(async () => ({ account: window.DCC_ACCOUNT_CONTEXT, dirty: await JournalPageStore.create({ account: window.DCC_ACCOUNT_CONTEXT }).listDirty() }));
  assert.equal(asUser2.account.userId, 2); assert.deepEqual(asUser2.dirty, [], 'user 2 cannot see user 1 pages in the same profile');
  const names = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).filter(n => /^dcc-journal/.test(n)).sort());
  assert.deepEqual(names, ['dcc-journal:v1:u1:ws-1', 'dcc-journal:v1:u2:ws-2']);
  await ctxA.request.post(base + '/api/review/journal/session', { data: { user: 1 } });
  await page.reload(); await page.locator('#api-loading').waitFor({ state: 'detached', timeout: 30000 });
  await waitClean(page, blockA.properties.journalId);
  ({ page: rowA } = await pageFor(A));
  if (strokes(rowA) !== 11) console.log('DEBUG local', JSON.stringify(await localRecord(page, blockA.properties.journalId), (k, v) => k === 'ink' ? (v && v.strokes.length) : v), 'server rev', rowA.revision, 'strokes', strokes(rowA));
  assert.equal(strokes(rowA), 11);
  mark('Account switch: stale tab gets ACCOUNT_CHANGED, page kept; user 2 sees none of it; signing back in as user 1 drains it on startup');
  await ctxB.close();

  // ── 12. Browser restart with the journal API unreachable (app shell served) ─
  let persistent = await chromium.launchPersistentContext(profileDir, { headless: true, executablePath, viewport: { width: 1280, height: 900 } });
  let pp = await boot(persistent, 1);
  const C = 'Synthetic restart pages';
  await quickAddJournal(pp, C); await draw(pp, 0); await waitStatus(pp, /Saved and synced/); await close(pp);
  await pp.route('**/api/journal/**', r => r.abort('internetdisconnected'));
  await reopenFromItinerary(pp, C); await draw(pp, 1); await waitStatus(pp, /Could not reach DCC|Offline/);
  await close(pp); await persistent.close();
  persistent = await chromium.launchPersistentContext(profileDir, { headless: true, executablePath, viewport: { width: 1280, height: 900 } });
  pp = persistent.pages()[0] || await persistent.newPage(); watch(pp, 'restart');
  await pp.route('**/api/journal/**', r => r.abort('internetdisconnected'));
  await pp.goto(base); await pp.locator('#api-loading').waitFor({ state: 'detached', timeout: 30000 });
  await reopenFromItinerary(pp, C);
  const { block: blockC } = await pageFor(C);
  assert.equal((await localRecord(pp, blockC.properties.journalId)).ink.strokes.length, 2, 'stroke drawn before restart is on the device');
  assert.equal(strokes((await pageFor(C)).page), 1, 'server still has the old copy');
  await close(pp); await pp.unroute('**/api/journal/**');
  await pp.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitClean(pp, blockC.properties.journalId);
  assert.equal(strokes((await pageFor(C)).page), 2);
  await persistent.close();
  mark('Browser restart (same profile) with the journal API unreachable: unsynced stroke survives on device and drains once reachable. NOT a cold offline start: DCC has no service worker, the app shell was served.');

  // ── 13. Touch, pen pressure, palm rejection, panning, two-finger cancel ───
  const touch = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const tp = await boot(touch, 1, { width: 390, height: 844 });
  await tp.evaluate(() => localStorage.removeItem('dcc-journal-finger-draw'));
  await reopenFromItinerary(tp, B);
  const cdp = await touch.newCDPSession(tp);
  const pb = await tp.locator('.jt-dialog .jt-base').boundingBox();
  const jStrokes = () => localRecord(tp, jidB).then(r => r.ink.strokes.length);
  const before = await jStrokes();
  const touchDrag = async (pts) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pts[0]] });
    for (const p of pts.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const line = (x, y, dx, dy, n = 8) => Array.from({ length: n }, (_, k) => ({ x: x + k * dx, y: y + k * dy, id: 1 }));
  await touchDrag(line(pb.x + 60, pb.y + 80, 6, 3));
  await tp.waitForTimeout(600);
  assert.equal(await jStrokes(), before + 1, 'auto mode: finger draws before any pen');
  // Pen with pressure 0.8.
  const pen = async (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, pointerType: 'pen', force: 0.8, clickCount: 1 });
  await pen('mousePressed', pb.x + 80, pb.y + 160, 1);
  for (let k = 1; k <= 8; k++) await pen('mouseMoved', pb.x + 80 + k * 6, pb.y + 160 + k * 2, 1);
  await pen('mouseReleased', pb.x + 128, pb.y + 176, 0);
  await tp.waitForTimeout(600);
  const penRec = await localRecord(tp, jidB);
  const last = penRec.ink.strokes.at(-1);
  assert.equal(penRec.ink.strokes.length, before + 2);
  assert.ok(last.pts.filter((_, i) => i % 3 === 2).every(p => Math.abs(p - 0.8) < 0.02), 'pen pressure recorded: ' + last.pts.filter((_, i) => i % 3 === 2).join(','));
  // After a pen: a finger is a palm/pan, not ink, and scrolls the dialog.
  await tp.locator('.jt-dialog [data-jt-act="notes"]').click();      // taller content to scroll
  const scroller = '.jt-dialog .dcc-overlay-body';
  await tp.evaluate(s => { document.querySelector(s).scrollTop = 0; }, scroller);
  const pb2 = await tp.locator('.jt-dialog .jt-base').boundingBox();
  await touchDrag(line(pb2.x + 150, pb2.y + 400, 0, -25, 10));
  await tp.waitForTimeout(400);
  const scrolled = await tp.evaluate(s => document.querySelector(s).scrollTop, scroller);
  assert.equal(await jStrokes(), before + 2, 'finger after pen did not draw');
  assert.ok(scrolled > 50, 'one-finger drag on the paper scrolled the dialog by ' + scrolled + 'px');
  // Two fingers: no ink, no pan.
  await tp.evaluate(s => { document.querySelector(s).scrollTop = 0; }, scroller);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pb2.x + 100, y: pb2.y + 300, id: 1 }, { x: pb2.x + 160, y: pb2.y + 300, id: 2 }] });
  for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pb2.x + 100, y: pb2.y + 300 - k * 20, id: 1 }, { x: pb2.x + 160, y: pb2.y + 300 - k * 20, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await tp.waitForTimeout(400);
  assert.equal(await jStrokes(), before + 2, 'two fingers never ink');
  assert.ok(await tp.evaluate(s => document.querySelector(s).scrollTop, scroller) < 30, 'two fingers do not pan');
  // Finger: on -> finger draws again even after a pen.
  await tp.locator('.jt-dialog [data-jt-act="finger"]').click();     // auto -> on
  await tp.evaluate(s => { document.querySelector(s).scrollTop = 0; }, scroller);
  const pb3 = await tp.locator('.jt-dialog .jt-base').boundingBox();
  await touchDrag(line(pb3.x + 70, pb3.y + 240, 5, 2));
  await tp.waitForTimeout(600);
  assert.equal(await jStrokes(), before + 3, 'Finger: on draws');
  assert.equal(await tp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'no horizontal page overflow at 390px');
  await tp.screenshot({ path: path.join(output, '13-mobile-390.png') });
  await tp.setViewportSize({ width: 320, height: 640 });
  await tp.waitForTimeout(400);
  assert.equal(await tp.locator('.jt-dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'no dialog overflow at 320px');
  await tp.screenshot({ path: path.join(output, '13-mobile-320.png') });
  await tp.locator('.jt-dialog [data-jt-act="finger"]').click();     // on -> off, leave preference sane
  mark('Touch (CDP touch events, emulated): finger draws in auto before a pen; pen pressure 0.8 recorded; after a pen a finger pans the dialog (not ink); two fingers neither ink nor pan; Finger: on draws; no overflow at 390/320px');
  await touch.close();

  // ── 14. Newer stroke format is refused, not rewritten ─────────────────────
  const ctxV = await browser.newContext();
  const pv = await boot(ctxV, 1);
  const D = 'Synthetic future format';
  await quickAddJournal(pv, D); await close(pv);
  const { block: blockD } = await pageFor(D);
  await pv.evaluate(async ({ jid, id }) => { await JournalPageStore.create({ account: window.DCC_ACCOUNT_CONTEXT }).seed(jid, { taskId: id, revision: 99, ink: { v: 2, w: 1, h: 1, strokes: [] }, body: '' }); }, { jid: blockD.properties.journalId, id: blockD.id });
  await reopenFromItinerary(pv, D, false);
  assert.match(await status(pv), /newer version of DCC/);
  assert.equal(await pv.locator('.jt-dialog').getAttribute('data-journal-id'), blockD.properties.journalId);
  mark('A page in an unknown stroke-format version opens as an error, never loaded into the editor');
  await ctxV.close();

  // ── Review finding 1 & 2 scenarios (two tabs, refresh under pen/typing,
  //    conflict choices with pending input and failing local writes) ──────
  const remoteInk = (x) => ({ v: 1, w: 1275, h: 1650, strokes: [{ tool: 'ballpoint', color: '#2563eb', size: 2.6, pts: [x, 600, 0.5, x + 50, 650, 0.5] }] });
  const ctxT = await browser.newContext();
  const t1 = await boot(ctxT, 1);
  const otherDevice = async (title, ink, body, tag) => {
    const { block, page: row } = await pageFor(title);
    const r = await ctxT.request.put(base + '/api/journal/tasks/' + block.id, { headers: { 'X-DCC-User': '1', 'X-DCC-Workspace': 'ws-1' },
      data: { journalId: block.properties.journalId, ink, body, expectedRevision: row ? row.revision : 0, mutationId: 'other-device-' + tag } });
    assert.equal(r.status(), 200); return (await r.json()).revision;
  };
  const firstX = s => s.pts[0];
  // A status line may still read "Saved and synced" from before a choice, so
  // wait on the server's accepted revision instead.
  const waitServerRev = async (title, rev, timeout = 20000) => {
    const until = Date.now() + timeout;
    for (;;) {
      const { page: row } = await pageFor(title);
      if (row && row.revision >= rev) return row;
      if (Date.now() > until) throw new Error(title + ' never reached server revision ' + rev);
      await new Promise(r => setTimeout(r, 400));
    }
  };

  // 15. Two tabs, one IndexedDB.
  const E = 'Synthetic two-tab pages';
  await quickAddJournal(t1, E); await draw(t1, 0); await waitStatus(t1, /Saved and synced/); await close(t1);
  const t2 = await ctxT.newPage(); watch(t2, 'tab2'); await t2.setViewportSize({ width: 1280, height: 900 });
  await t2.goto(base); await t2.locator('#api-loading').waitFor({ state: 'detached', timeout: 30000 });
  await reopenFromItinerary(t1, E); await reopenFromItinerary(t2, E);
  const jidE = (await pageFor(E)).block.properties.journalId;
  await draw(t1, 1); await waitStatus(t1, /Saved and synced/);
  let rowE = (await pageFor(E)).page; const revA = rowE.revision; assert.equal(strokes(rowE), 2);
  await draw(t2, 7);
  await t2.locator('.jt-dialog [data-jt-banner="keep-mine"]').waitFor({ timeout: 10000 });
  assert.match(await status(t2), /also changed elsewhere/);
  await t2.screenshot({ path: path.join(output, '15-two-tabs-stale.png') });
  await t2.waitForTimeout(3000);
  rowE = (await pageFor(E)).page;
  assert.equal(rowE.revision, revA, 'the stale tab sent nothing'); assert.equal(strokes(rowE), 2);
  let recE = await localRecord(t2, jidE);
  const tab1X = firstX(recE.ink.strokes[1]), tab2X = firstX(recE.drafts[0].ink.strokes[1]);
  assert.notEqual(tab1X, tab2X); assert.equal(recE.dirty, false); assert.equal(recE.baseRevision, revA);
  await t2.locator('.jt-dialog [data-jt-banner="use-newer"]').click();
  await t2.locator('.jt-dialog [data-jt-banner="restore-recovery"]').waitFor();
  recE = await localRecord(t2, jidE);
  assert.equal(recE.drafts.length, 0); assert.equal(firstX(recE.recoveries[0].ink.strokes[1]), tab2X, 'tab 2 page kept as recovery');
  await t2.locator('.jt-dialog [data-jt-banner="restore-recovery"]').click();
  rowE = await waitServerRev(E, revA + 1);
  assert.equal(rowE.revision, revA + 1); assert.equal(firstX(rowE.ink.strokes[1]), tab2X, 'explicitly restored tab 2 page synced');
  recE = await localRecord(t2, jidE); assert.equal(firstX(recE.recoveries[0].ink.strokes[1]), tab1X, 'tab 1 page now kept as recovery');
  await close(t1); await close(t2); await t2.close();
  mark('Two tabs on one IndexedDB: the stale tab\'s stroke becomes a draft, nothing is sent over the newer page; "Use the newer page" keeps the draft as recovery; restoring it is explicit and keeps the other page');

  // 16. Newer server copy lands while the pen is down.
  let remoteRev = await otherDevice(E, remoteInk(600), 'remote', '16');
  await fault({ journalGet: { delayMs: 2500 } });
  await reopenFromItinerary(t1, E);
  const shownBefore = (await localRecord(t1, jidE)).ink.strokes.length;
  const pbox = await t1.locator('.jt-dialog .jt-base').boundingBox();
  await t1.mouse.move(pbox.x + 300, pbox.y + 500); await t1.mouse.down();
  for (let k = 1; k <= 14; k++) { await t1.mouse.move(pbox.x + 300 + k * 5, pbox.y + 500 + k * 2); await t1.waitForTimeout(250); }
  await t1.mouse.up();
  await fault({});
  await t1.locator('.jt-dialog [data-jt-banner="keep-mine"]').waitFor({ timeout: 10000 });
  let recR = await localRecord(t1, jidE);
  assert.equal(recR.baseRevision, remoteRev); assert.equal(firstX(recR.ink.strokes[0]), 600, 'remote page is the content');
  assert.equal(recR.drafts[0].ink.strokes.length, shownBefore + 1, 'the stroke drawn under the pen is kept as a draft');
  await t1.waitForTimeout(2500);
  assert.equal((await pageFor(E)).page.revision, remoteRev, 'nothing sent over the remote page');
  await t1.locator('.jt-dialog [data-jt-banner="keep-mine"]').click();
  const row16 = await waitServerRev(E, remoteRev + 1);
  assert.equal(row16.revision, remoteRev + 1); assert.equal(strokes(row16), shownBefore + 1);
  recR = await localRecord(t1, jidE); assert.equal(firstX(recR.recoveries[0].ink.strokes[0]), 600, 'remote page kept as recovery');
  await close(t1);
  mark('Remote refresh while the pen is down: stroke kept as a draft, no silent overwrite; "Keep my version" is explicit and the remote page stays as recovery');

  // 17. Typing pending when the newer server copy arrives; "Saving…" until written.
  remoteRev = await otherDevice(E, remoteInk(700), 'remote typed', '17');
  await fault({ journalGet: { delayMs: 1200 } });
  await reopenFromItinerary(t1, E);
  if (await t1.locator('.jt-dialog [data-jt-act="notes"]').getAttribute('aria-expanded') !== 'true') await t1.locator('.jt-dialog [data-jt-act="notes"]').click();
  const notes = t1.locator('.jt-dialog .jt-notes-input');
  await notes.focus(); await t1.keyboard.press('End');
  await t1.keyboard.type(' l');
  assert.match(await status(t1), /Saving/, 'typing not yet written shows Saving…');
  await notes.pressSequentially('atest local text', { delay: 130 });
  await fault({});
  await t1.locator('.jt-dialog [data-jt-banner="use-newer"]').waitFor({ timeout: 10000 });
  let rec17 = await localRecord(t1, jidE);
  assert.equal(rec17.body, 'remote typed'); assert.match(rec17.drafts[0].body, /latest local text$/);
  await t1.locator('.jt-dialog [data-jt-banner="use-newer"]').click();
  await t1.locator('.jt-dialog [data-jt-banner="restore-recovery"]').waitFor();
  assert.equal(await notes.inputValue(), 'remote typed');
  rec17 = await localRecord(t1, jidE); assert.match(rec17.recoveries[0].body, /latest local text$/, 'typed text kept as recovery');
  assert.equal((await pageFor(E)).page.body, 'remote typed');
  await close(t1);
  mark('Typing pending during a remote refresh: status says Saving…; the typed text becomes a draft, then a recovery copy after "Use the newer page"; remote text never overwritten');

  // 18. Immediate "Use the saved page" with pending typing AND a stroke under the pen.
  await reopenFromItinerary(t1, E);
  remoteRev = await otherDevice(E, remoteInk(800), 'remote conflict', '18');
  await draw(t1, 3);
  await t1.locator('.jt-dialog [data-jt-banner="use-server"]').waitFor({ timeout: 15000 });
  const n18 = (await localRecord(t1, jidE)).ink.strokes.length;
  if (await t1.locator('.jt-dialog [data-jt-act="notes"]').getAttribute('aria-expanded') !== 'true') await t1.locator('.jt-dialog [data-jt-act="notes"]').click();
  await notes.fill('latest unsaved typed text');                          // typing timer now pending
  // Filling the notes scrolls the dialog; bring the paper back and press at a
  // point that is inside both the paper and the viewport.
  await t1.locator('.jt-dialog .jt-base').scrollIntoViewIfNeeded();
  const b18 = await t1.locator('.jt-dialog .jt-base').boundingBox();
  const x18 = b18.x + b18.width * 0.6, y18 = Math.max(b18.y, 0) + 40;
  await t1.mouse.move(x18, y18); await t1.mouse.down();
  for (let k = 1; k <= 5; k++) await t1.mouse.move(x18 + k * 6, y18 + k * 3);
  const penDown18 = await t1.evaluate(() => DCC.JournalTask.current.penDown());
  await t1.evaluate(() => document.querySelector('.jt-dialog [data-jt-banner="use-server"]').click());   // pen still down
  await t1.locator('.jt-dialog [data-jt-banner="restore-recovery"]').waitFor({ timeout: 10000 });
  await t1.mouse.up();
  assert.equal(await notes.inputValue(), 'remote conflict');
  let rec18 = await localRecord(t1, jidE);
  assert.equal(rec18.conflict, null); assert.equal(rec18.body, 'remote conflict');
  assert.equal(rec18.recoveries[0].body, 'latest unsaved typed text', 'latest typed text kept');
  assert.equal(penDown18, true, 'the stroke was really under the pen when the choice was clicked');
  assert.equal(rec18.recoveries[0].ink.strokes.length, n18 + 1, 'stroke under the pen committed into the kept copy (n18=' + n18 + ', recoveries=' + JSON.stringify(rec18.recoveries.map(r => [r.reason, r.ink && r.ink.strokes.length, r.body])) + ')');
  await t1.waitForTimeout(1500);
  rec18 = await localRecord(t1, jidE);
  assert.equal(rec18.body, 'remote conflict'); assert.equal(rec18.dirty, false, 'no late typing timer persisted over the choice');
  await close(t1);
  mark('"Use the saved page" clicked with typing pending and the pen down: both are committed first and kept as recovery; the saved page shows; nothing is written over it afterwards');

  // 19. Conflict choice while the local write fails.
  await reopenFromItinerary(t1, E);
  remoteRev = await otherDevice(E, remoteInk(900), 'remote again', '19');
  await draw(t1, 4);
  await t1.locator('.jt-dialog [data-jt-banner="use-server"]').waitFor({ timeout: 15000 });
  const before19 = await localRecord(t1, jidE);
  await t1.evaluate(() => { window.__realPut = window.__realPut || IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); }; });
  if (await t1.locator('.jt-dialog [data-jt-act="notes"]').getAttribute('aria-expanded') !== 'true') await t1.locator('.jt-dialog [data-jt-act="notes"]').click();
  await notes.fill('text that cannot be saved yet');
  await t1.locator('.jt-dialog [data-jt-banner="use-server"]').click();
  await t1.locator('.jt-dialog [data-jt-banner="retry-save"]').waitFor({ timeout: 10000 });
  assert.match(await t1.locator('.jt-dialog .jt-banner').textContent(), /not saved on this device yet/);
  assert.equal(await notes.inputValue(), 'text that cannot be saved yet', 'typed text still on screen');
  const mid19 = await localRecord(t1, jidE);
  assert.ok(mid19.conflict, 'conflict not resolved'); assert.equal(mid19.body, before19.body, 'content unchanged');
  await t1.screenshot({ path: path.join(output, '19-conflict-local-failure.png') });
  await t1.evaluate(() => { IDBObjectStore.prototype.put = window.__realPut; });
  await t1.locator('.jt-dialog [data-jt-banner="retry-save"]').click();
  await t1.locator('.jt-dialog [data-jt-banner="use-server"]').waitFor({ timeout: 10000 });
  await t1.locator('.jt-dialog [data-jt-banner="use-server"]').click();
  await t1.locator('.jt-dialog [data-jt-banner="restore-recovery"]').waitFor({ timeout: 10000 });
  const rec19 = await localRecord(t1, jidE);
  assert.equal(rec19.body, 'remote again'); assert.equal(rec19.recoveries[0].body, 'text that cannot be saved yet');
  await close(t1);
  mark('Conflict choice while the local write fails: the choice is refused with nothing changed and the text kept on screen; Retry save writes it, the choice is re-offered, and the text is kept as recovery');
  await ctxT.close();

  assert.deepEqual(errors, [], 'no page errors');
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ synthetic: true, base, checks, errors }, null, 2));
  console.log('ALL ' + checks.length + ' CHECKS PASSED');
} catch (e) {
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ synthetic: true, base, checks, errors, failure: String(e && e.stack || e) }, null, 2));
  throw e;
} finally {
  await browser.close();
  await fs.rm(profileDir, { recursive: true, force: true });
}
