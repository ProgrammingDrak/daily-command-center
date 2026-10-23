// Two disposable browser profiles against the opt-in in-memory review backend.
/* global document, window, navigator */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
const base=process.argv[2]||'http://127.0.0.1:8317';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname));
const info=await(await fetch(base+'/api/shared-task-review-info')).json();assert.equal(info.synthetic,true);assert.equal(info.storage,'memory');
const output=path.resolve(process.env.DCC_QA_OUTPUT||'shared-task-qa');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.DCC_CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const owner=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const peer=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',extraHTTPHeaders:{'x-review-session':'other'}});
const page=await owner.newPage(),other=await peer.newPage(),errors=[],checks=[];
for(const p of [page,other])p.on('pageerror',e=>errors.push(e.message));
const mark=s=>{checks.push(s);console.log('PASS '+s);};
const badge=(p,id)=>p.locator('[data-shared-task="'+id+'"]');
const close=async p=>p.locator('.dcc-overlay-actions').getByRole('button',{name:'Close',exact:true}).last().click();
const ready=async p=>{await p.goto(base);await p.locator('#api-loading').waitFor({state:'detached'});};
async function count(p,id,text){await p.waitForFunction(({id,text})=>[...document.querySelectorAll('[data-shared-task]')].some(e=>e.dataset.sharedTask===id&&e.textContent.includes(text)),{id,text});}
try{
  await ready(page);await badge(page,info.taskId).first().click();
  const dialog=page.locator('.shared-tasks-dialog');
  await dialog.locator('[data-scope]').selectOption('series');
  await page.screenshot({path:path.join(output,'series-invitation.png')});
  await dialog.locator('[data-friend]').selectOption('2');
  assert.equal(await dialog.locator('[data-include-instructions]').isChecked(),true);
  await dialog.locator('.shared-instructions summary').click();
  assert.match(await dialog.innerText(),/Comfortable seat/);assert.doesNotMatch(await dialog.innerText(),/123|45 reps/);
  await page.screenshot({path:path.join(output,'instruction-preview.png')});
  await dialog.locator('[data-invite]').click();await dialog.getByText('Riley-demo · Invited',{exact:false}).waitFor();await close(page);
  await ready(other);await other.locator('#shared-tasks-open').click();
  await other.locator('[data-action="accept"]').click();
  await other.locator('[data-action="remove"]').waitFor();await close(other);
  const shares=await other.evaluate(async()=> (await(await fetch('/api/shared-tasks')).json()).shares);
  const ownTask=shares.find(s=>s.title==='DEMO · Morning workout together').taskId;assert.ok(ownTask);
  await count(page,info.taskId,'0/2');await other.reload();await other.locator('#api-loading').waitFor({state:'detached'});await count(other,ownTask,'0/2');
  mark('owner explicitly reviews instructions and invites; peer accepts into an independent private task');
  const row=badge(other,ownTask).first().locator('xpath=ancestor::*[contains(@class,"it-list-item")][1]');
  await row.getByRole('button',{name:'Plan & Log',exact:true}).click();
  await row.locator('.wp-entry').first().waitFor();assert.equal(await row.locator('.wp-entry').count(),10);
  assert.match(await row.innerText(),/Comfortable seat/);assert.doesNotMatch(await row.innerText(),/123 lb/);
  await row.getByRole('button',{name:'Plan & Log',exact:true}).click();
  mark('accepted instruction snapshot opens in the existing Guided Routines planner with ten movement cards');
  const ownerRow=badge(page,info.taskId).first().locator('xpath=ancestor::*[contains(@class,"it-list-item")][1]');
  await ownerRow.locator('.it-list-check').click();
  await count(other,ownTask,'1/2');
  assert.equal(await row.locator('.it-list-check').getAttribute('aria-label').then(x=>/Uncheck/.test(x||'')),false);
  await other.screenshot({path:path.join(output,'peer-open-owner-done.png')});
  mark('live update shows owner done while the peer task stays open');
  await other.locator('#shared-tasks-open').click();
  const updates=other.locator('.shared-notifications');await updates.locator('summary').click();
  assert.match(await updates.innerText(),/Morgan-demo/);
  assert.match(await updates.innerText(),/completed DEMO/);
  await updates.locator('[data-read-notifications]').click();
  await other.waitForFunction(()=>!document.querySelector('#shared-tasks-open').textContent.includes(' new'));
  const preference=other.locator('[data-notification-preference]');await preference.uncheck();
  await other.waitForFunction(async()=>!(await(await fetch('/api/shared-tasks')).json()).notificationPreferences.enabled);
  await close(other);await ownerRow.locator('.it-list-check').click();
  await count(other,ownTask,'0/2');
  const muted=await other.evaluate(async()=> (await(await fetch('/api/shared-tasks')).json()));
  assert.equal(muted.notificationPreferences.enabled,false);assert.ok(muted.notifications.every(n=>n.read));
  await other.locator('#shared-tasks-open').click();await other.locator('[data-notification-preference]').check();
  await other.waitForFunction(async()=> (await(await fetch('/api/shared-tasks')).json()).notificationPreferences.enabled);
  await close(other);await ownerRow.locator('.it-list-check').click();await count(other,ownTask,'1/2');
  await other.waitForFunction(()=>document.querySelector('#shared-tasks-open').textContent.includes('1 new'));
  mark('durable in-app history, mark-read and mute/re-enable preserve per-recipient alert choices without duplicate badges');
  const beforeOffline=await other.evaluate(()=>({debug:window.blockStore.debug(),deadLetters:window.blockStore.exportPending().deadLetters.length}));
  await peer.setOffline(true);await other.waitForFunction(()=>navigator.onLine===false);
  await row.locator('.it-list-check').click();
  // Prove that the click actually failed offline and entered the durable outbox
  // before reconnecting. A click resolving is not a network-settlement barrier.
  await other.waitForFunction(({id,queued})=>window.blockStore.debug().completionMetrics.queued>queued
    &&window.blockStore.exportPending().pending.some(e=>e.op==='completion'&&e.id===id&&e.data.completed===true),
  {id:ownTask,queued:beforeOffline.debug.completionMetrics.queued});
  await peer.setOffline(false);await other.evaluate(()=>window.blockStore?.replayWAL());
  // The online listener may already own replay; a second replayWAL call returns
  // immediately in that case. Observe the persisted entry draining instead.
  await other.waitForFunction(id=>!window.blockStore.exportPending().pending.some(e=>e.op==='completion'&&e.id===id),ownTask);
  const afterOffline=await other.evaluate(()=>({debug:window.blockStore.debug(),deadLetters:window.blockStore.exportPending().deadLetters.length}));
  assert.equal(afterOffline.debug.completionMetrics.rejected,beforeOffline.debug.completionMetrics.rejected);
  assert.equal(afterOffline.deadLetters,beforeOffline.deadLetters);
  await count(page,info.taskId,'All done');await count(other,ownTask,'All done');
  assert.equal(await badge(page,info.taskId).first().isVisible(),true);assert.equal(await badge(other,ownTask).first().isVisible(),true);
  await page.screenshot({path:path.join(output,'both-done-desktop.png')});
  mark('offline peer completion retries through the existing outbox and both profiles reach All done');
  await other.setViewportSize({width:375,height:900});assert.equal(await badge(other,ownTask).first().isVisible(),true);await other.screenshot({path:path.join(output,'both-done-mobile.png')});
  assert.ok(await other.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  await other.locator('[data-nav-key="__more"]').click();await other.locator('#mobile-more-sheet').getByRole('button',{name:'Shared tasks',exact:false}).click();await other.locator('.shared-tasks-dialog').waitFor();await close(other);
  mark('375px layout keeps participant avatars visible and Shared tasks is reachable from More');
  const tomorrow=new Date(Date.parse(info.date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  const next=await other.evaluate(async date=>{
    const synced=await fetch('/api/shared-tasks/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date})});
    if(!synced.ok)throw new Error(await synced.text());
    return (await(await fetch('/api/shared-tasks?date='+date)).json()).shares.find(s=>s.date===date);
  },tomorrow);
  assert.ok(next);assert.equal(next.scope,'series');assert.equal(next.participants.length,2);assert.ok(next.participants.every(p=>!p.completed));assert.notEqual(next.taskId,ownTask);
  const fresh=await other.evaluate(async id=>(await(await fetch('/api/activity/tasks/'+id)).json()),next.taskId);
  assert.equal(fresh.record.plan.exercises.length,10);assert.deepEqual(fresh.record.actual,{sets:[],runs:[]});
  mark('one explicit series acceptance generates tomorrow’s two fresh tasks and private guided logs without another invitation');
  await page.locator('#shared-tasks-open').click();await page.locator('[data-action="remove"][data-user="2"]').first().click();await close(page);
  await other.evaluate(()=>window.DCC.SharedTasks.refresh());
  await count(other,ownTask,'Share task');
  const saved=await other.evaluate(async id=>(await(await fetch('/api/activity/tasks/'+id)).json()),ownTask);
  assert.equal(saved.record.plan.exercises.length,10);assert.equal(saved.completed,true);
  mark('removal hides participation and preserves the peer’s private task and instruction log');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({synthetic:true,checks,errors,completedAt:new Date().toISOString()},null,2));
} catch(error){
  // Only disposable synthetic accounts are used by this runner. Preserve the
  // failed transition rather than silently retrying a checkbox that toggles.
  const diagnostics={message:error.message,checks,errors};
  for(const [name,p] of [['owner',page],['peer',other]]){
    diagnostics[name]=await p.evaluate(()=>({online:navigator.onLine,debug:window.blockStore?.debug(),outbox:window.blockStore?.exportPending()})).catch(e=>({captureError:e.message}));
    await p.screenshot({path:path.join(output,name+'-failure.png')}).catch(()=>{});
  }
  await fs.writeFile(path.join(output,'failure.json'),JSON.stringify(diagnostics,null,2));
  throw error;
} finally {await browser.close();}
