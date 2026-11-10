/* global window, document */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
test('foreground switch preview, cancellation, stale state and exact retry', { skip: !process.env.DCC_BROWSER_TESTS }, async t => {
  const app = require('express')();
  app.use(require('express').json());
  let revision = 1, state, mode = 'ok';
  const writes = [], receipts = new Set();
  const item = (id, status = 'queued') => ({ task: { id, properties: { type: 'task', title: id === 'old' ? 'Review <draft>' : 'Write next step', ...(status === 'foreground' ? { startedAt: new Date(Date.now()-60000).toISOString() } : {}) } }, status, delegated: [], taskPriority: 'Medium' });
  function reset(oldStatus = null, guided = false) {
    const next = item('new');
    if (guided) next.task.properties.guidedDefinitionId = 'synthetic-guide';
    state = { revision: ++revision, timeZone: 'UTC', foreground: oldStatus === 'foreground' ? [{ id: 'old', title: 'Review <draft>' }] : [], queue: { serverNow: new Date().toISOString(), order: ['old','new'], items: [...(oldStatus ? [item('old', oldStatus)] : []), next] } };
    writes.length = 0; receipts.clear(); mode = 'ok';
  }
  reset();
  app.get('/api/working-queue', (_req,res) => res.json(state));
  app.get('/api/guided/tasks/new', (_req,res) => res.json({ revision: 1, definitionRevision: 1, contextVersion: 1, prompt: 'Synthetic instructions' }));
  app.post('/api/working-queue', (req,res) => {
    const b = req.body; writes.push(b);
    if (receipts.has(b.sourceEventId)) return res.json({ currentState: state, duplicate: true });
    if (b.expectedRevision !== state.revision) return res.status(409).json({ error: 'Activity changed' });
    receipts.add(b.sourceEventId);
    state.revision = ++revision;
    state.queue.items.forEach(row => {
      row.status = row.task.id === b.taskId ? 'foreground' : 'queued';
      if (row.status === 'foreground') row.task.properties.startedAt = b.at;
      else delete row.task.properties.startedAt;
    });
    state.foreground = [{ id: b.taskId, title: 'Write next step' }];
    if (mode === 'lost') { mode = 'ok'; return res.status(503).json({ error: 'Synthetic lost response' }); }
    return res.json({ currentState: state });
  });
  app.use('/public', require('express').static(path.join(__dirname,'public')));
  app.get('/', (_req,res) => res.send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/tokens.css"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"></head><body><main id="working-queue-root"></main><script>window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:"switch-fixture"};</script>'+['core','core-ui','task-priority','task-model','hold-action','itinerary-card','completed-queue-filter','queue-policy','queue-layout','working-queue'].map(name=>'<script src="/public/js/'+name+'.js"></script>').join('')+'<script>DCCWorkingQueue.refresh()</script></body></html>'));
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser = await require('playwright-core').chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  t.after(()=>browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, reducedMotion: 'reduce' });
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  const refresh = () => page.evaluate(()=>window.DCCWorkingQueue.refresh());
  const focus = () => page.locator('[data-queue-id=new] [data-queue-action=focus]').click();
  const dialog = () => page.getByRole('dialog');
  const submit = () => dialog().getByRole('button',{name:'Bring forward',exact:true}).click();
  const started = () => page.waitForFunction(()=>window.DCCWorkingQueue.getState().foreground[0]?.id==='new');

  await t.test('empty, completed and removed old foreground never show a wait prompt', async()=>{
    for (const old of [null,'completed',null]) {
      reset('foreground'); await refresh(); // stale page initially shows a foreground task
      reset(old); // the authoritative refresh must win over that stale page
      await focus(); await started();
      assert.equal(await dialog().count(),0);
      assert.equal(writes.length,1);
      assert.equal(Object.hasOwn(writes[0],'remindMinutes'),false);
      assert.equal(writes[0].expectedForegroundTaskId,null);
    }
  });
  await t.test('already-current selection is a no-op after refresh', async()=>{
    const count=writes.length;
    await page.evaluate(()=>window.DCCWorkRotation.open(null,{id:'new'}));
    await refresh();
    assert.equal(await dialog().count(),0); assert.equal(writes.length,count);
  });
  await t.test('one escaped old/new prompt; Cancel and Escape preserve all state', async()=>{
    reset('foreground'); await refresh();
    await page.evaluate(()=>{const b=document.querySelector('[data-queue-id=new] [data-queue-action=focus]');b.click();b.click();});
    await dialog().waitFor(); assert.equal(await dialog().count(),1);
    assert.match(await dialog().innerText(),/Moving to Background[\s\S]*Review <draft>/);
    assert.match(await dialog().innerText(),/Moving to Foreground[\s\S]*Write next step/);
    assert.equal(await dialog().locator('draft').count(),0);
    assert.match(await dialog().innerText(),/Moving to Background[\s\S]*Snooze[\s\S]*Moving to Foreground/);
    await dialog().getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(writes.length,0);
    await focus(); await dialog().waitFor(); await page.keyboard.press('Escape');
    assert.equal(writes.length,0);
  });
  await t.test('uncertain save retries exactly once with the same old task and timer', async()=>{
    reset('foreground'); await refresh(); mode='lost';
    await focus(); await dialog().waitFor(); await dialog().locator('[data-minutes]').selectOption('5');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:path.join(__dirname,'../foreground-switch-review.png'),fullPage:true});
    await dialog().getByRole('button',{name:'Bring forward',exact:true}).evaluate(b=>{b.click();b.click();});
    await dialog().getByRole('status').filter({hasText:'Update not confirmed'}).waitFor();
    assert.equal(writes.length,1);
    assert.equal(await dialog().locator('[data-minutes]').isDisabled(),true);
    await submit(); await started(); await dialog().waitFor({state:'hidden'});
    assert.equal(writes.length,2); assert.deepEqual(writes[1],writes[0]);
    assert.equal(writes[0].expectedForegroundTaskId,'old'); assert.equal(writes[0].taskId,'new'); assert.equal(writes[0].remindMinutes,5);
  });
  await t.test('a newer revision while reviewing cannot silently switch a different foreground', async()=>{
    reset('foreground'); await refresh(); await focus(); await dialog().waitFor();
    const reviewed=state.revision; state.revision=++revision;
    await submit(); await dialog().getByRole('status').filter({hasText:'Activity changed'}).waitFor();
    assert.equal(writes.length,1); assert.equal(writes[0].expectedRevision,reviewed);
    assert.equal(state.foreground[0].id,'old');
    await dialog().getByRole('button',{name:'Cancel',exact:true}).click();
  });
  await t.test('guided instructions still appear without an old-task timer', async()=>{
    reset(null,true); await refresh(); await focus(); await dialog().waitFor();
    await dialog().getByText('Synthetic instructions',{exact:true}).waitFor();
    assert.equal(await dialog().locator('[data-minutes]').count(),0);
    await submit(); await started(); await dialog().waitFor({state:'hidden'});
    assert.equal(writes[0].guided.expectedRevision,1); assert.equal(writes[0].expectedForegroundTaskId,null);
  });
  assert.deepEqual(errors,[]);
});
