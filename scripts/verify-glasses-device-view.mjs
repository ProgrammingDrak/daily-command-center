/* global document, window, KeyboardEvent, innerWidth, getComputedStyle */
// Integrated glasses navigation, exclusively on the opt-in synthetic review server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
const base = process.env.DCC_GLASSES_REVIEW_URL || 'http://127.0.0.1:8399';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert.equal((await fetch(base + '/api/health').then(r => r.json())).reviewOnly, true);
assert.equal((await fetch(base + '/api/review/glasses-device/reset', { method: 'POST' })).ok, true);
const out = process.env.DCC_GLASSES_REVIEW_OUT || '/tmp/dcc-glasses-device-review';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const context = await browser.newContext({ viewport: { width: 600, height: 600 }, hasTouch: true });
await context.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
const page = await context.newPage(), errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
const check = name => { checks.push(name); console.log('PASS ' + name); };
const input = action => page.evaluate(action => window.DCCGlasses.input(action), action);
const selected = () => page.locator('.glasses-task-row[aria-selected="true"]').getAttribute('data-task-id');
const level = async expected => assert.equal(await page.locator('#glasses-app').getAttribute('data-level'), expected);
let writes = 0;
page.on('request', r => { if (r.method() !== 'GET' && /\/api\/(working-queue|tasks\/.*\/completion)/.test(r.url())) writes++; });
try {
  // Hold the task runtime indefinitely: glasses must paint before any of it can
  // execute, and desktop controls must never become the loading screen.
  let releaseRuntime;
  const runtimeGate = new Promise(resolve => { releaseRuntime = resolve; });
  const holdRuntime = async route => { await runtimeGate; await route.continue(); };
  await page.route('**/public/js/core.js?*', holdRuntime);
  try {
    await page.goto(base + '/?tab=schedule&device=glasses', { waitUntil: 'commit' });
    await page.locator('#glasses-startup').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => typeof window.DCCGlasses), 'undefined');
    assert.equal(await page.locator('#glasses-startup [role="status"]').innerText(), 'Loading your tasks…');
    assert.equal(await page.locator('#glasses-startup').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(13, 23, 34)');
    assert.equal(await page.evaluate(() => [...document.body.children].filter(el => !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName) && el.id !== 'glasses-startup').every(el => getComputedStyle(el).display === 'none')), true);
  } finally { releaseRuntime(); }
  await page.waitForSelector('.glasses-task-row');
  assert.equal(await page.locator('#glasses-startup').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('glasses-starting')), false);
  await page.unroute('**/public/js/core.js?*', holdRuntime);
  check('glasses paints before the task runtime loads, hides desktop throughout startup and hands off to task navigation');
  await page.waitForSelector('.glasses-task-row');
  await level('jump');
  assert.equal(await page.locator('.glasses-task-row').count(), 11);
  const initial = await selected();
  const ids = await page.locator('.glasses-task-row').evaluateAll(rows => rows.map(r => r.dataset.taskId));
  const canonical = await page.evaluate(async () => (await window.DCCTaskLibrary.glassesCollections()).allTasks.map(task => task.id));
  assert.ok(ids.every(id => canonical.includes(id)));
  assert.equal(await page.evaluate(() => window.DCCGlasses.snapshot().count), canonical.length);
  assert.ok(!canonical.includes('glasses-done'));
  assert.equal(new Set(ids).size, ids.length);
  const parentIndex = ids.indexOf('review-detail-task');
  assert.deepEqual(ids.slice(parentIndex, parentIndex + 3), ['review-detail-task', 'review-detail-step', 'glasses-review-nested']);
  const taskRow = id => page.locator('.glasses-task-row[data-task-id="' + id + '"]');
  for (const width of [600, 320]) {
    await page.setViewportSize({ width, height: 600 });
    // Read the whole hierarchy in one browser turn; polling refreshes replace
    // rows and can detach elements between separate boundingBox calls.
    await page.waitForFunction(() => {
      const ids = ['review-detail-task', 'review-detail-step', 'glasses-review-nested'];
      const rows = ids.map(id => document.querySelector('.glasses-task-row[data-task-id="' + id + '"] .glasses-title'));
      if (rows.some(row => !row)) return false;
      const x = rows.map(row => row.getBoundingClientRect().x);
      return x[0] < x[1] && x[1] < x[2];
    });
  }
  await page.setViewportSize({ width: 600, height: 600 });
  assert.equal(await taskRow('review-detail-step').getAttribute('data-relation'), 'subtask');
  assert.equal(await taskRow('glasses-review-nested').getAttribute('data-relation'), 'ride-along');
  assert.match(await taskRow('glasses-review-nested').getAttribute('aria-label'), /Nested task/);
  await page.waitForFunction(() => {
    const color = id => {
      const node = document.querySelector('.glasses-task-row[data-task-id="' + id + '"] .glasses-type');
      return node && getComputedStyle(node).color;
    };
    return color('review-detail-step') && color('review-detail-step') !== color('glasses-review-nested')
      && color('review-workout') === 'rgb(56, 189, 248)' && color('review-meeting') === 'rgb(249, 115, 22)';
  });
  check('All Tasks keeps the canonical open-task count, indents each level and displays DCC type colors');
  await page.keyboard.press('ArrowDown');
  assert.equal(await selected(), ids[5]);
  assert.equal(await page.locator('.glasses-range').count(), 5);
  await page.keyboard.press('ArrowUp');
  assert.equal(await selected(), initial);
  const animationName = () => getComputedStyle(document.querySelector('.glasses-selected')).animationName;
  assert.equal(await page.evaluate(async () => {
    await window.DCCGlasses.input('tap-fore');
    return getComputedStyle(document.querySelector('.glasses-selected')).animationName;
  }), 'glasses-select-enter');
  await level('select');
  await page.screenshot({ path: path.join(out, 'glasses-select-animation-600.png') });
  await page.keyboard.press('ArrowDown');
  assert.equal(await selected(), ids[1]);
  assert.equal(await page.evaluate(animationName), 'none');
  await page.keyboard.press('ArrowUp');
  assert.equal(await selected(), initial);
  check('Jump moves five rows, Select moves one, eleven complete rows and five-row range render');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'glasses-select-600.png') });
  await input('tap-fore'); await level('task');
  assert.ok(await page.locator('.glasses-focus').isVisible());
  await page.screenshot({ path: path.join(out, 'glasses-task-focus-600.png') });
  assert.equal(await page.locator('.glasses-direction[data-action]').count(), 4);
  const touch = await context.newCDPSession(page);
  const focusBox = await page.locator('.glasses-focus').boundingBox();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: focusBox.x + focusBox.width / 2, y: focusBox.y + focusBox.height / 2, id: 1 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await touch.detach();
  await page.waitForTimeout(650);
  await level('task'); assert.equal(writes, 0);
  check('pointer cancellation emits neither a tap nor a held completion');
  await input('hold-fore'); await level('details');
  await input('tap-middle'); await level('task');
  await input('down'); await level('more');
  await input('down'); await input('tap-fore'); await level('details');
  await input('tap-middle'); await level('task');
  await input('down'); await level('more');
  await input('tap-middle'); await level('task');
  await input('tap-middle'); await level('select');
  await input('tap-middle'); await level('jump');
  assert.equal(await page.evaluate(animationName), 'none');
  check('Select entry highlight does not replay on a redraw or on Back to Jump');
  check('task focus, details placeholder, More menu and single-middle back follow the level stack');
  await input('tap-fore'); await input('down');
  const remembered = await selected();
  await input('tap-middle');
  await input('left'); await input('right');
  assert.equal(await selected(), remembered);
  check('collection switch restores selection by stable task ID');
  const names = [];
  for (let i = 0; i < 8; i++) {
    names.push(await page.locator('#glasses-app').innerText());
    await input('left');
  }
  const expected = ['All Tasks', 'Working Queue', 'Itinerary', 'Loose Ends', 'Whenever', 'Someday', 'Waiting'];
  expected.forEach((name, i) => assert.ok(names[i].includes(name), 'collection ' + i + ': ' + name));
  for (let i = 0; i < 7; i++) await input('right');
  await level('jump');
  assert.ok((await page.locator('#glasses-app').innerText()).includes('All Tasks'));
  check('all eight collections cycle in required order');
  assert.equal(await page.evaluate(() => { const e = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; }), false);
  await page.keyboard.press('Enter'); await level('select');
  await page.keyboard.press('Enter'); await level('task');
  await page.keyboard.down('Enter'); await page.waitForTimeout(850); await page.keyboard.up('Enter');
  await level('details');
  await page.keyboard.press('Escape'); await page.waitForTimeout(450);
  assert.notEqual(await page.locator('#glasses-app').getAttribute('data-level'), 'details');
  await page.keyboard.press('Escape'); await level('select');
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  await level('jump');
  assert.equal(writes, 0);
  check('held Enter opens details, each Escape goes back one level, Backspace stays native and navigation performs no mutations');
  for (const [width, height] of [[320, 600], [375, 812], [600, 600], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(out, 'glasses-navigation-' + width + '.png') });
  }
  await page.setViewportSize({ width: 600, height: 600 });
  await page.waitForTimeout(200);
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.glasses-task-row')].map(row => { const r = row.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }));
  assert.equal(boxes.length, 11);
  assert.ok(boxes.every(box => box.height > 20 && box.top >= 0 && box.bottom <= 600));
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(out, 'glasses-zoom-200.png') });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await input('tap-fore');
  await page.waitForFunction(() => { const el = document.querySelector('.glasses-selected'); return el && getComputedStyle(el).animationName === 'none'; });
  await input('tap-middle');
  check('eleven complete slots fit 600×600, select animation is present, reduced-motion disables it and 200 percent zoom avoids horizontal overflow');
  // Exercise browser history, rather than the synthetic middle-tap seam.
  const beforeHistoryWrites = writes;
  await input('tap-fore'); await input('down');
  const historySelected = await selected();
  await input('tap-fore'); await input('hold-fore'); await level('details');
  await page.goBack(); await level('task');
  await input('down'); await level('more');
  await page.goBack(); await level('task');
  await page.goBack(); await level('select');
  assert.equal(await selected(), historySelected);
  await page.goForward(); await level('task');
  await page.reload(); await page.waitForSelector('.glasses-focus'); await level('task');
  assert.equal(await page.evaluate(() => window.DCCGlasses.snapshot().selected.id), historySelected);
  await input('tap-middle'); await level('select');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.DCCGlasses.snapshot().level === 'jump');
  assert.equal(await selected(), historySelected);
  await input('tap-fore'); await input('tap-fore');
  await page.locator('.glasses-back').click();
  await page.waitForFunction(() => window.DCCGlasses.snapshot().level === 'select');
  await input('tap-middle'); await level('jump');
  assert.equal(writes, beforeHistoryWrites);
  assert.ok(await page.evaluate(() => !!window.history.state.dccNav));
  check('native Back, Forward, reload and mixed Back controls preserve view/selection without task writes');
  const exit = page.locator('.glasses-exit');
  assert.ok(await exit.isVisible());
  assert.equal(new URL(await exit.getAttribute('href'), base).searchParams.has('device'), false);
  await exit.click(); await page.waitForFunction(() => !new URL(window.location.href).searchParams.has('device'));
  assert.equal(await page.locator('#glasses-app:visible').count(), 0);
  await page.goBack(); await page.waitForSelector('.glasses-task-row');
  assert.equal(new URL(page.url()).searchParams.get('device'), 'glasses');
  for (const status of [401, 403]) {
    await page.route('**/api/task-library', route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic session refusal' }) }));
    await page.evaluate(() => window.DCCGlasses.refresh());
    assert.equal(await page.locator('.glasses-task-row').count(), 0);
    const rejectedWrites = writes;
    await input('tap-fore'); await input('left');
    assert.equal(writes, rejectedWrites);
    await page.unroute('**/api/task-library');
    await page.reload(); await page.waitForSelector('.glasses-task-row');
  }
  check('401 and 403 source refresh failures immediately redact tasks and block mutations');
  await page.evaluate(() => { window.DCC_ACCOUNT_CONTEXT = { userId: 2, workspaceId: 'other-synthetic' }; });
  await page.waitForFunction(() => document.querySelectorAll('.glasses-task-row').length === 0);
  assert.match(await page.locator('.glasses-status').innerText(), /account|signed out/i);
  const beforeAccountInput = writes;
  await input('tap-fore'); await input('left');
  assert.equal(writes, beforeAccountInput);
  check('browser Back restores device mode; account change redacts tasks and blocks mutations');
  check('responsive previews have no horizontal overflow and Full app exits device mode');
  const exitPage = await context.newPage();
  await exitPage.goto(base + '/?tab=tasks');
  await exitPage.goto(base + '/?tab=tasks&device=glasses');
  await exitPage.waitForSelector('.glasses-task-row');
  await exitPage.evaluate(() => window.DCCGlasses.input('tap-fore'));
  await exitPage.goBack();
  await exitPage.waitForFunction(() => window.DCCGlasses.snapshot().level === 'jump');
  await exitPage.goBack();
  assert.equal(new URL(exitPage.url()).searchParams.has('device'), false);
  await exitPage.close();
  check('Back at Jump leaves the glasses entry without a trapping sentinel');
  const swipePage = await context.newPage();
  await swipePage.emulateMedia({ reducedMotion: 'reduce' });
  await swipePage.goto(base + '/?tab=schedule&device=glasses');
  await swipePage.waitForSelector('.glasses-task-row');
  // Exercise Glasses through the static review completion endpoint. Production
  // queue receipts and their validation are covered by the queue tests.
  await swipePage.evaluate(() => {
    window.DCCWorkingQueue.performTaskAction = async (action, id, { kind }) => {
      if (action !== 'complete' || kind !== 'task') throw new Error('Unexpected task action');
      const result = await window.blockStore.setTaskCompletion(id, true);
      if (!result.ok) throw new Error('Fixture completion failed');
      return { undo: { taskId: id, expiresAt: Date.now() + 5000 } };
    };
    window.DCCWorkingQueue.undoCompletion = async receipt => {
      const result = await window.blockStore.setTaskCompletion(receipt.taskId, false);
      if (!result.ok) throw new Error('Fixture completion undo failed');
    };
  });
  const swipeTouch = await context.newCDPSession(swipePage);
  const touchAt = (type, x, y = 130) => swipeTouch.send('Input.dispatchTouchEvent', {
    type, touchPoints: x == null ? [] : [{ x, y, id: 1 }]
  });
  const swipe = async (from, to, y) => {
    await touchAt('touchStart', from, y);
    await touchAt('touchMove', to, y);
    await touchAt('touchEnd');
  };
  const swipeInput = action => swipePage.evaluate(action => window.DCCGlasses.input(action), action);
  const swipeTarget = swipePage.locator('.glasses-swipe-target');
  const swipePrompt = swipePage.locator('.glasses-swipe-prompt');
  const selectedRow = swipePage.locator('.glasses-task-row[aria-selected="true"]');
  const undoButton = swipePage.locator('#glasses-undo');
  const condition = async direction => assert.equal(await swipeTarget.getAttribute('data-swipe'), direction);
  const completionResponse = (id, completed) => swipePage.waitForResponse(r =>
    r.url().includes('/api/tasks/' + id + '/completion') && r.request().method() === 'POST' &&
    r.request().postDataJSON().completed === completed);
  const batchResponse = (id, op) => swipePage.waitForResponse(r =>
    new URL(r.url()).pathname === '/api/blocks/batch' && r.request().method() === 'POST' &&
    r.request().postDataJSON().operations.some(entry => entry.id === id && entry.op === op));
  await swipeInput('tap-fore');
  const currentSwipeTask = () => swipePage.evaluate(() => window.DCCGlasses.snapshot().selected.id);
  const completedId = await currentSwipeTask();
  const beforeComplete = await selectedRow.boundingBox();
  await swipe(170, 300);
  await condition('right');
  assert.equal(await swipePrompt.innerText(), 'Complete?');
  assert.ok((await selectedRow.boundingBox()).x > beforeComplete.x);
  assert.ok(!(await swipePage.request.get(base + '/api/blocks/' + completedId).then(r => r.json())).properties.done);
  await swipe(300, 170); await condition('');
  await swipeInput('tap-fore');
  const focus = await swipePage.locator('.glasses-focus').boundingBox();
  const focusY = Math.round(focus.y + focus.height / 2);
  await touchAt('touchStart', 170, focusY);
  await touchAt('touchMove', 300, focusY);
  await swipePage.evaluate(() => new Promise(resolve => {
    document.dispatchEvent(new window.Event('dcc:working-queue-sync'));
    window.requestAnimationFrame(resolve);
  }));
  await touchAt('touchEnd');
  await condition('right');
  assert.ok((await swipePage.locator('.glasses-focus').boundingBox()).x > focus.x);
  assert.equal(await swipePage.getByRole('button', { name: 'Complete?', exact: true }).count(), 1);
  const completed = completionResponse(completedId, true);
  await swipe(170, 300, focusY);
  assert.equal((await completed).ok(), true);
  await undoButton.waitFor({ state: 'visible' });
  assert.match(await undoButton.innerText(), /Swipe left to undo/);
  const reopened = completionResponse(completedId, false);
  await swipePage.keyboard.press('ArrowLeft');
  assert.equal((await reopened).ok(), true);
  await swipePage.locator('.glasses-status').getByText('Completion undone.', { exact: true }).waitFor();
  await condition('');

  // A selection change while a finger is down must not stage the new task.
  await touchAt('touchStart', 300);
  await swipeInput('down');
  await touchAt('touchMove', 170);
  await touchAt('touchEnd');
  await condition('');
  const deletedId = await currentSwipeTask();
  const beforeDelete = await selectedRow.boundingBox();
  const original = await swipePage.request.get(base + '/api/blocks/' + deletedId).then(r => r.json());
  await swipe(300, 170); await condition('left');
  assert.equal(await swipePrompt.innerText(), 'Delete?');
  const revealedRow = await selectedRow.boundingBox();
  const revealedPrompt = await swipePrompt.boundingBox();
  assert.ok(revealedRow.x < beforeDelete.x && revealedRow.x + revealedRow.width < revealedPrompt.x);
  assert.equal((await swipePage.request.get(base + '/api/blocks/' + deletedId)).status(), 200);
  const deleted = batchResponse(deletedId, 'delete');
  await swipe(300, 170);
  assert.equal((await deleted).ok(), true);
  assert.equal((await swipePage.request.get(base + '/api/blocks/' + deletedId)).status(), 404);
  await swipePage.waitForFunction(id => window.DCCGlasses.snapshot().selected.id !== id, deletedId);
  assert.equal(await swipePage.locator('#glasses-app').getAttribute('data-level'), 'select');
  await undoButton.waitFor({ state: 'visible' });
  const restored = batchResponse(deletedId, 'undelete');
  await swipe(300, 170);
  assert.equal((await restored).ok(), true);
  const revived = await swipePage.request.get(base + '/api/blocks/' + deletedId).then(r => r.json());
  assert.equal(revived.id, original.id);
  assert.equal(revived.properties.title, original.properties.title);
  await swipePage.locator('.glasses-status').getByText('Task restored.', { exact: true }).waitFor();
  await swipeTouch.detach();
  await swipePage.close();
  check('Select and Task show swipe confirmation, ignore stale gestures, and undo both writes with a left swipe');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ checks, errors, synthetic: true, physicalMeta: false }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png') });
  console.log(await page.evaluate(() => window.DCCGlasses?.snapshot()));
  throw error;
} finally { await browser.close(); }
