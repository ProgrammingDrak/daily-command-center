// Two disposable browser profiles against the opt-in in-memory review backend.
/* global document, window */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
const base=process.argv[2]||'http://127.0.0.1:8318';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname));
const info=await(await fetch(base+'/api/shared-task-review-info')).json();assert.equal(info.synthetic,true);assert.equal(info.storage,'memory');
const output=path.resolve(process.env.DCC_QA_OUTPUT||'combined-collaboration-qa');await fs.mkdir(output,{recursive:true});
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
async function request(p,url,body,headers={}) {
  return p.evaluate(async({url,body,headers})=>{
    const c=window.DCC_ACCOUNT_CONTEXT;
    const r=await fetch(url,{method:body?'POST':'GET',headers:{'content-type':'application/json','X-DCC-User':String(c.userId),'X-DCC-Workspace':c.workspaceId,...headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,body:await r.json()};
  },{url,body,headers});
}
async function act(p,id,body) {
  const current=await request(p,'/api/commitments/'+id);assert.equal(current.status,200);
  return request(p,'/api/commitments/'+id+'/actions',{actionId:crypto.randomUUID(),expectedRevision:current.body.revision,...body});
}
try{
  await ready(page);await badge(page,info.taskId).first().click();
  const dialog=page.locator('.shared-tasks-dialog');
  await dialog.locator('[data-scope]').waitFor();
  assert.deepEqual(await dialog.locator('[data-scope] option').evaluateAll(nodes=>nodes.map(n=>n.value)),['occurrence','series']);
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
  // Both controls must work on the same persisted owner card, with the same DB/session.
  await page.locator('[data-task-collaborate="'+info.taskId+'"]').click();
  assert.equal(await page.locator('#commitment-create-form [name=title]').inputValue(),'');
  await page.locator('#commitment-create-form [name=title]').fill('Synthetic coaching agreement');
  await page.locator('#commitment-create-form [name=definitionDone]').fill('Owner completes their own workout');
  await page.locator('#commitment-create-form button[type=submit]').click();
  await page.waitForFunction(()=>window.DCCCommitmentSync.summary.pending===0 && window.DCCCommitments.records.some(r=>r.title==='Synthetic coaching agreement'));
  const commitment=(await request(page,'/api/commitments')).body.find(r=>r.title==='Synthetic coaching agreement');assert.ok(commitment);
  assert.equal((await act(page,commitment.id,{kind:'invite',userId:2,role:'coach'})).status,200);
  assert.equal((await act(other,commitment.id,{kind:'accept'})).status,200);
  assert.equal((await act(other,commitment.id,{kind:'complete',evidence:'Forbidden coach completion'})).status,403);
  assert.equal((await act(page,commitment.id,{kind:'complete',evidence:'Owner still uses canonical checkbox'})).status,409);
  assert.equal((await request(other,'/api/tasks/'+info.taskId+'/completion',{completed:true,mutationId:crypto.randomUUID()})).status,404);
  assert.equal((await request(page,'/api/tasks/'+ownTask+'/completion',{completed:true,mutationId:crypto.randomUUID()})).status,404);
  assert.equal((await request(other,'/api/activity/tasks/'+info.taskId)).status,404);
  const projection=(await request(other,'/api/commitments/'+commitment.id)).body;
  assert.equal(projection.source_block_id,undefined);assert.equal(projection.capabilities.complete,false);
  assert.doesNotMatch(JSON.stringify(projection),/Comfortable seat|Morning workout together|123/);
  assert.equal((await peer.request.get(base+'/api/shared-tasks',{headers:{'X-DCC-User':'1','X-DCC-Workspace':'ws-1'}})).status(),409);
  assert.equal((await peer.request.get(base+'/api/commitments',{headers:{'X-DCC-User':'1','X-DCC-Workspace':'ws-1'}})).status(),409);
  await page.locator('#commitment-close').click();
  mark('same-card collaboration and participation coexist; coach, foreign-task and stale-account completion are rejected');
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
  assert.equal((await request(other,'/api/commitments/'+commitment.id)).body.status,'completed');
  assert.equal((await request(other,'/api/activity/tasks/'+ownTask)).body.completed,false);
  async function assertCorner() {
    const card=await row.boundingBox(),status=await badge(other,ownTask).first().boundingBox();
    assert.ok(await badge(other,ownTask).first().evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.right-4,r.top+r.height/2));}),'completion count is not obscured by another control');
    assert.ok(status.y-card.y<=16,'participant status stays at the card top');
    assert.ok(card.x+card.width-status.x-status.width<=48,'participant status stays at the card right');
  }
  await assertCorner();
  await other.screenshot({path:path.join(output,'shared-workout-desktop.png')});
  await other.setViewportSize({width:375,height:900});
  assert.equal(await badge(other,ownTask).first().isVisible(),true);
  await assertCorner();
  await other.screenshot({path:path.join(output,'shared-workout-mobile.png')});
  await other.setViewportSize({width:1440,height:1000});
  mark('live update shows owner done while the peer task stays open');
  await peer.setOffline(true);await row.locator('.it-list-check').click();
  await peer.setOffline(false);await other.evaluate(()=>window.blockStore?.replayWAL());
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
  assert.equal((await act(page,commitment.id,{kind:'revoke',userId:2})).status,200);
  assert.equal((await request(other,'/api/commitments/'+commitment.id)).status,404);
  assert.ok((await request(other,'/api/shared-tasks')).body.shares.some(s=>s.taskId===ownTask));
  mark('revoking coaching access leaves separately accepted shared-workout participation intact');
  const oneOffInfo=await page.evaluate(async()=> (await(await fetch('/api/activity-review-info')).json()));
  const oneOff=await request(page,'/api/shared-tasks/invite',{taskId:oneOffInfo.taskId,userId:2,scope:'occurrence'});assert.equal(oneOff.status,200);
  const invitation=(await request(other,'/api/shared-tasks')).body.shares.find(s=>s.id===oneOff.body.id);assert.equal(invitation.scope,'occurrence');assert.equal(invitation.seriesId,null);assert.equal(invitation.instructions,null);
  assert.equal((await request(other,'/api/shared-tasks/'+oneOff.body.id+'/respond',{action:'accept'})).status,200);
  const later=(await request(other,'/api/shared-tasks?date='+tomorrow)).body.shares;assert.ok(!later.some(s=>s.id===oneOff.body.id));
  mark('occurrence-only consent stays separate from series acceptance and does not propagate private results');
  await page.locator('#shared-tasks-open').click();await page.locator('[data-action="remove"][data-user="2"][data-share="'+next.seriesId+'"]').first().click();await close(page);
  await other.evaluate(()=>window.DCC.SharedTasks.refresh());
  await count(other,ownTask,'Share task');
  const saved=await other.evaluate(async id=>(await(await fetch('/api/activity/tasks/'+id)).json()),ownTask);
  assert.equal(saved.record.plan.exercises.length,10);assert.equal(saved.completed,true);
  mark('removal hides participation and preserves the peer’s private task and instruction log');
  assert.equal((await request(page,'/api/commitments/'+commitment.id)).body.status,'completed');
  assert.equal((await request(other,'/api/activity/tasks/'+next.taskId)).body.record.plan.exercises.length,10);
  const viewer=await browser.newContext({extraHTTPHeaders:{'x-review-session':'viewer'}});const v=await viewer.newPage();await ready(v);
  assert.equal((await request(v,'/api/shared-tasks')).status,403);assert.equal((await request(v,'/api/commitments/'+commitment.id)).status,404);await viewer.close();
  mark('series revocation preserves each private dated log and owner commitment; unrelated viewer sees neither');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({synthetic:true,checks,errors,completedAt:new Date().toISOString()},null,2));
} finally {await browser.close();}
