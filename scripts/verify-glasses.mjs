/* global document, window, sessionStorage */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://127.0.0.1:8396';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const info = await (await fetch(base + '/api/glasses-review-info')).json();
assert.equal(info.synthetic, true); assert.ok(['memory', 'isolated-schema'].includes(info.storage)); assert.equal(info.accountBinding, true);
const ownerHeaders = { 'X-DCC-User': '1', 'X-DCC-Workspace': 'ws-1' };
const fixtureRead = url => fetch(base + url, { headers: ownerHeaders });
const output = path.resolve(process.env.DCC_QA_OUTPUT || 'test-results/glasses'); await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.DCC_CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
const context = await browser.newContext({ viewport: { width: 600, height: 600 } }), page = await context.newPage(), errors = [], checks = [];
await page.clock.setFixedTime(new Date(info.now));
page.on('pageerror', e => errors.push(e.message));
await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
const mark = s => { checks.push(s); console.log('PASS ' + s); };
const act = a => page.locator('[data-action="' + a + '"]');
const ready = async () => { await page.getByRole('status').filter({ hasText: /Synced|synced|saved state|Already completed/ }).waitFor(); };
const screenshot = name => page.screenshot({ path: path.join(output, name + '.png') });
const open = async id => { await page.goto(base + '/glasses.html?task=' + id); await ready(); };
const apiRequests = [];
page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) apiRequests.push(r); });
try {
  for (const headers of [{}, { 'X-DCC-User': '2', 'X-DCC-Workspace': 'ws-2' }, { ...ownerHeaders, 'X-DCC-Workspace': 'ws-2' }]) {
    const denied = await fetch(base + '/api/tasks/open?before=' + info.date, { headers });
    assert.equal(denied.status, 409); assert.equal((await denied.json()).code, 'ACCOUNT_CHANGED');
    const write = await fetch(base + '/api/tasks/glasses-unplanned/completion', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"completed":true}' });
    assert.equal(write.status, 409); assert.equal((await write.json()).code, 'ACCOUNT_CHANGED');
  }
  const foreignHeaders = { 'X-DCC-User': '2', 'X-DCC-Workspace': 'ws-2', 'X-Review-Session': 'other', 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/blocks/glasses-unplanned', { headers: foreignHeaders })).status, 404);
  // No date fallback: exercise canonical lookup, not the existing own-workspace legacy overlay.
  assert.equal((await fetch(base + '/api/tasks/glasses-unplanned/completion', { method: 'POST', headers: foreignHeaders, body: JSON.stringify({ completed: true, mutationId: 'foreign-canonical-attempt', expectedRevision: null }) })).status, 404);
  assert.notEqual((await (await fixtureRead('/api/blocks/glasses-unplanned')).json()).properties.status, 'done');
  mark('real account-binding middleware rejects missing/stale user/workspace headers and foreign task access');
  await page.goto(base + '/glasses.html'); await ready(); await page.getByRole('heading', { name: 'Itinerary', exact: true }).waitFor();
  assert.match(await page.locator('#card').innerText(), /NOW/); assert.match(await page.locator('#card').innerText(), /UP NEXT/);
  assert.equal(new URL(page.url()).searchParams.has('date'),false);
  await page.reload(); await ready(); assert.equal(new URL(page.url()).searchParams.has('date'),false);
  assert.deepEqual(await page.locator('.queue-pills button').allTextContents(), ['Triage 1','Loose Ends 3','Waiting 1','Unscheduled 2','Whenever 2']);
  assert.equal(await act('open:glasses-done').getAttribute('class').then(c=>c.includes('done')), true);
  assert.equal(await act('open:glasses-child-done').getAttribute('class').then(c=>c.includes('nested')&&c.includes('done')), true);
  assert.match(await act('open:glasses-child-open').innerText(), /Open/);
  assert.equal(await act('open:glasses-done-untimed').count(),1);
  await screenshot('600-full-itinerary-top');
  for(const [id,taskId] of [['triage','glasses-triage'],['loose','glasses-earlier'],['waiting','waiting:glasses-waiting'],['unscheduled','glasses-unplanned'],['whenever','glasses-backlog']]) {
    await act('queue:'+id).click();
    assert.equal(await act('queue:'+id).getAttribute('aria-pressed'),'true');
    await act('open:'+taskId).waitFor();
    if(id==='triage')await page.getByText(/additional source item/).waitFor();
    if(id==='loose')assert.match(await act('open:'+taskId).innerText(),/Overdue/);
    await screenshot('600-queue-'+id);
    await act('open:'+taskId).click(); await ready();
    if(id==='waiting')assert.equal(await act('confirm').count(),0);
    await act('back').click(); await ready();
    assert.equal(await page.locator(':focus').getAttribute('data-action'),'open:'+taskId);
    await page.reload(); await ready(); assert.equal(await act('queue:'+id).getAttribute('aria-pressed'),'true');
  }
  await act('queue:loose').click();
  await act('open:triage:unprepared-source').click(); await ready(); assert.equal(await act('confirm').count(),0);
  await act('back').click(); await ready();
  await page.route('**/api/tasks/open?**days=all**',route=>route.abort());
  await act('older').click(); await page.getByRole('alert').waitFor();
  assert.match(await page.locator('#card').innerText(),/Past 14 days/);
  assert.equal(await act('older').innerText(),'Show older tasks');
  await page.unroute('**/api/tasks/open?**days=all**');
  await act('older').click(); await ready(); assert.match(await page.locator('#card').innerText(),/All earlier tasks/);
  await page.reload(); await ready(); assert.equal(new URL(page.url()).searchParams.get('older'),'all');
  await act('older').click(); await ready();
  await act('itinerary').click();
  for(const [width,height] of [[375,812],[1440,1000],[600,600]]) {
    await page.setViewportSize({width,height});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    assert.ok(await page.locator('.queue-pills button').evaluateAll(es=>es.every(e=>{const b=e.getBoundingClientRect();return b.height>=44&&b.top>=0&&b.bottom<window.innerHeight;})));
    await screenshot(width+'-full-itinerary');
  }
  mark('five canonical queue pills, counts/filters, completed hierarchy, overdue work, reload/back focus and responsive full-list layout');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'card');
  await page.keyboard.press('ArrowRight'); assert.match(await page.locator(':focus').getAttribute('data-action'), /^open:/);
  await act('open:glasses-now').focus();
  await screenshot('600-itinerary'); await page.keyboard.press('Enter'); await ready();
  assert.match(await page.locator('h1').innerText(), /Prepare the weekly plan/); assert.equal(await page.locator(':focus').getAttribute('id'), 'card');
  mark('600px full itinerary and arrow/Enter detail navigation, focus restored');
  await act('confirm').click(); assert.equal(await page.locator(':focus').getAttribute('data-action'), 'cancel');
  await page.keyboard.press('Enter'); assert.equal(await act('confirm').count(), 1); mark('confirmation defaults to Cancel; repeated activation cannot complete');
  await context.setOffline(true); await page.getByRole('alert').filter({ hasText: /Offline/ }).waitFor(); assert.equal(await act('confirm').isDisabled(), true); await screenshot('600-offline');
  await context.setOffline(false); await act('refresh').first().click(); await ready();
  mark('offline is explicit and refuses completion');
  await page.goto(base + '/glasses.html?view=tasks'); await ready(); await screenshot('600-tasks');
  await act('open:glasses-now').click(); await ready();
  let lost = false, writes = [];
  await page.route('**/api/tasks/glasses-now/completion', async route => {
    writes.push(route.request().postDataJSON());
    if (!lost) { lost = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort(); }
    else await route.continue();
  });
  await act('confirm').click(); await act('complete').click(); await page.getByRole('status').filter({ hasText: 'Completion unconfirmed' }).waitFor(); await screenshot('600-retry');
  await page.reload(); await act('retry').waitFor(); await act('retry').click(); await ready();
  await page.getByText('Completed · confirmed by DCC', { exact: true }).waitFor();
  assert.equal(writes.length, 2); assert.equal(writes[0].mutationId, writes[1].mutationId); await screenshot('600-completed');
  const row = await (await fixtureRead('/api/blocks/glasses-now')).json(); assert.equal(row.properties.status, 'done');
  mark('real completion route: lost acknowledgement, reload, idempotent retry, confirmed state');
  await open('glasses-unplanned');
  await context.addCookies([{ name: 'dcc-review-auth', value: 'none', url: base }]);
  await act('confirm').click(); await act('complete').click(); await page.getByRole('alert').filter({ hasText: /Sign in again/ }).waitFor();
  assert.match(await act('login').getAttribute('href'), /next=/); await screenshot('600-auth');
  const unplanned = await (await fixtureRead('/api/blocks/glasses-unplanned')).json(); assert.notEqual(unplanned.properties.status, 'done');
  await context.clearCookies(); await act('refresh').first().click(); await ready(); mark('auth interruption offers existing login with return URL; no completion');
  await open('glasses-no-alias'); await page.getByText('Schedule this task in DCC before completing it here.', { exact: true }).waitFor();
  assert.equal(await act('confirm').count(), 0); mark('alias-less backlog is readable; dateless completion preserves DCC scheduling semantics');
  await open('glasses-unplanned');
  await page.route('**/api/tasks/glasses-unplanned/completion', route => route.abort());
  await act('confirm').click(); await act('complete').click(); await act('retry').waitFor();
  const receipt = await page.evaluate(() => Object.entries(sessionStorage).find(([k]) => k.startsWith('dcc.glasses.task-retry'))?.[1]); assert.ok(receipt);
  await context.addCookies([{ name: 'dcc-review-auth', value: 'other', url: base }]);
  const beforeSwitchWrites = apiRequests.filter(r => r.method() === 'POST').length;
  await act('retry').click(); await page.getByRole('alert').filter({ hasText: 'Account changed' }).waitFor();
  assert.equal(apiRequests.filter(r => r.method() === 'POST').length, beforeSwitchWrites);
  assert.equal(await page.getByRole('heading', { name: 'Send the follow-up notes' }).count(), 0);
  await act('refresh').first().click(); await page.getByRole('alert').filter({ hasText: 'Account changed' }).waitFor();
  assert.equal(await page.evaluate(() => Object.entries(sessionStorage).find(([k]) => k.startsWith('dcc.glasses.task-retry'))?.[1]), receipt);
  await act('reload-account').click(); await page.getByRole('alert').filter({ hasText: /not found|not available/i }).waitFor();
  assert.equal(await page.evaluate(() => window.DCC_ACCOUNT_CONTEXT.userId), 2);
  assert.equal(await act('retry').count(), 0);
  assert.equal(await page.evaluate(() => Object.entries(sessionStorage).find(([k]) => k.startsWith('dcc.glasses.task-retry'))?.[1]), receipt);
  await context.clearCookies(); await page.reload(); await act('retry').waitFor();
  assert.equal(await page.evaluate(() => window.DCC_ACCOUNT_CONTEXT.userId), 1);
  mark('account switch hides old task, refuses pending writes and preserves original receipt across account reload/recovery');
  const second = await context.newPage(); await second.clock.setFixedTime(new Date(info.now)); await second.goto(base + '/glasses.html?task=glasses-next');
  await second.getByRole('status').filter({ hasText: 'Synced' }).waitFor(); await second.locator('[data-action="confirm"]').click(); await second.locator('[data-action="complete"]').click();
  await second.getByText('Completed · confirmed by DCC', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => Object.entries(sessionStorage).find(([k]) => k.startsWith('dcc.glasses.task-retry'))?.[1]), receipt);
  await second.close(); await page.unroute('**/api/tasks/glasses-unplanned/completion'); await act('retry').click(); await ready();
  mark('two tabs preserve independent pending receipts; original tab retries safely');
  await open('glasses-long');
  await page.route('**/api/tasks/glasses-long/completion', route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"Changed elsewhere"}' }));
  await act('confirm').click(); await act('complete').click(); await page.getByRole('alert').filter({ hasText: /changed elsewhere/ }).waitFor();
  await page.unroute('**/api/tasks/glasses-long/completion'); await act('refresh').first().click(); await ready(); assert.equal(await act('retry').count(), 0);
  mark('server conflict stays open and explicit refresh clears stale intent');
  await open('glasses-long');
  assert.ok(await page.locator('#card').evaluate(e => e.scrollHeight > e.clientHeight));
  await page.keyboard.press('ArrowDown'); assert.ok(await page.locator('#card').evaluate(e => e.scrollTop > 0));
  for (const [width, height] of [[375, 812], [1440, 1000], [600, 600]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const boxes = await page.locator('nav button').evaluateAll(es => es.map(e => { const b = e.getBoundingClientRect(); return { h: b.height, bottom: b.bottom }; }));
    assert.ok(boxes.every(b => b.h >= 44 && b.bottom <= height));
    await screenshot(width + '-detail');
  }
  mark('long content scrolls with arrows; 375/600/1440 layouts keep controls visible');
  await page.goto(base + '/glasses-routine.html?task=' + info.routineId); await ready(); await act('begin').click(); await ready(); await act('next').click(); await ready();
  assert.match(await page.locator('.side').innerText(), /RIGHT/); await act('exit').click(); await ready(); await page.reload(); await ready(); await act('resume').click(); await ready();
  assert.match(await page.locator('.side').innerText(), /RIGHT/); await screenshot('600-routine');
  const routine = await (await fixtureRead('/api/activity/tasks/' + info.routineId)).json(); assert.equal(routine.record.guidance.stepIndex, 1); assert.deepEqual(routine.record.actual, { sets: [], runs: [] }); assert.deepEqual(routine.record.session.events, []);
  mark('secondary routine shares real guidance API; pause/reload/resume never invent results');
  const routineRequests = apiRequests.filter(r => new URL(r.url()).pathname.startsWith('/api/activity'));
  assert.ok(routineRequests.some(r => r.method() === 'PUT'));
  for (const r of routineRequests) { assert.equal(r.headers()['x-dcc-user'], '1'); assert.equal(r.headers()['x-dcc-workspace'], 'ws-1'); }
  assert.ok(apiRequests.some(r => new URL(r.url()).pathname === '/api/tasks/open' && r.headers()['x-dcc-user'] === '1' && r.headers()['x-dcc-workspace'] === 'ws-1'));
  await context.addCookies([{ name: 'dcc-review-auth', value: 'other', url: base }]);
  await act('next').click(); await page.getByRole('alert').filter({ hasText: 'Account changed' }).waitFor();
  assert.equal((await (await fixtureRead('/api/activity/tasks/' + info.routineId)).json()).record.guidance.stepIndex, 1);
  assert.equal(await page.getByRole('heading', { name: 'DEMO · Gentle Reset', exact: true }).count(), 0);
  await context.clearCookies(); await act('refresh').first().click(); await ready();
  mark('both entry points attach captured account headers; secondary guidance refuses changed accounts');
  for (let i = 0; i < 40 && await act('next').count(); i++) { await act('next').click(); await ready(); }
  await act('finish').click(); await ready(); await act('confirm').click(); await act('complete').click(); await ready();
  await page.getByRole('heading', { name: 'Task complete', exact: true }).waitFor();
  const completedRoutine = await (await fixtureRead('/api/activity/tasks/' + info.routineId)).json();
  assert.equal(completedRoutine.completed, true); assert.deepEqual(completedRoutine.record.actual, { sets: [], runs: [] });
  const routineCompletion = apiRequests.find(r => new URL(r.url()).pathname === '/api/tasks/' + info.routineId + '/completion');
  assert.equal(routineCompletion.headers()['x-dcc-user'], '1'); assert.equal(routineCompletion.headers()['x-dcc-workspace'], 'ws-1');
  mark('routine explicitly completes through protected canonical task/block endpoints after account recovery');
  await context.addCookies([{ name: 'dcc-review-auth', value: 'other', url: base }]);
  await page.goto(base+'/glasses.html'); await ready();
  assert.deepEqual(await page.locator('.queue-pills button').allTextContents(),['Triage 0','Loose Ends 0','Waiting 0','Unscheduled 0','Whenever 0']);
  await page.getByText('No scheduled items. Open the task pills above for unscheduled work.').waitFor();
  for(const q of ['triage','loose','waiting','unscheduled','whenever']) {
    await act('queue:'+q).click(); await page.getByText('No items here. All clear.').waitFor();
  }
  await screenshot('600-empty');
  await page.goto(base+'/glasses.html?date='+info.date); await ready(); await page.reload(); await ready();
  assert.equal(new URL(page.url()).searchParams.get('date'),info.date);
  mark('empty account queues remain explicit; default Today reload stays automatic while an explicit date remains pinned');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'checks.json'), JSON.stringify({ checks, errors, viewports: ['600x600', '375x812', '1440x1000'], realGlasses: false }, null, 2));
} catch (e) { await screenshot('failure'); throw e; } finally { await browser.close(); }
