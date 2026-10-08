/* global window, document, DCC, DCCCommitmentSync, IDBDatabase, DOMException, navigator */
// The declared browser globals are used only in Playwright page callbacks.
// Uses a new headless Mac Chrome profile, fictional accounts and a loopback fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const origin='http://127.0.0.1:8107';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const outcome='Publish a fictional product brief '+Date.now();
const errors=[];
let reset=false;
const watchdog=setTimeout(()=>{console.error('Review timeout');void browser.close();},90000);
async function account(id,width=1440){
  const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'Etc/UTC'});
  await context.addCookies([{name:'dcc_review_user',value:String(id),url:origin}]);
  await context.route('**/*', r => new URL(r.request().url()).origin===origin ? r.continue():r.abort());
  if (!reset) { const result=await context.request.post(origin+'/review/commitments/reset');assert.equal(result.status(),200);reset=true; }
  const page=await context.newPage();page.setDefaultTimeout(10000);console.log('Opening fictional account',id);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.locator('#itinerary-collaboration > summary').click();
  await page.waitForFunction(()=>!!window.DCCCommitmentSync);
  return {context,page};
}
async function sync(page){await page.locator('#commitment-refresh').click();try { await page.waitForFunction(()=>window.DCCCommitmentSync.summary.pending===0 && !document.getElementById("commitment-refresh").disabled && !document.getElementById("commitment-workspace").hasAttribute("aria-busy"),{},{timeout:10000}); }
catch(e){console.error('Sync debug',await page.evaluate(async()=>({summary:DCCCommitmentSync.summary,pending:await DCCCommitmentSync.pending(),cache:await DCCCommitmentSync.cached()})));throw e;}}
async function action(page,kind,note){
  await page.locator('#commitment-action-form [name="kind"]').selectOption(kind);
  await page.locator('#commitment-action-form [name="note"]').fill(note);
  await page.locator('#commitment-action-form button[type="submit"]').click();await sync(page);
}
await fs.mkdir('test-results/accountability',{recursive:true});
try{
  const {page:owner,context:ownerCtx}=await account(1);
  await owner.locator('.commitment-create summary').click();
  await owner.locator('#commitment-create-form [name="title"]').fill(outcome);
  await owner.locator('#commitment-create-form [name="definitionDone"]').fill('A reviewed conclusion and supporting evidence are present.');
  await owner.locator('#commitment-create-form button[type="submit"]').click();await sync(owner);console.log('Created commitment');
  await owner.locator('.commitment-card').filter({hasText:outcome}).click();
  const id=await owner.locator('.commitment-card').filter({hasText:outcome}).getAttribute('data-commitment');
  for(const [person,role] of [['blair','coach'],['casey','manager']]){
    await owner.locator('#commitment-detail details:not(.commitment-history-details) summary').click();
    await owner.locator('#commitment-invite-form [name="person"]').fill(person);
    await owner.locator('#commitment-invite-form [name="role"]').selectOption(role);
    await owner.locator('#commitment-invite-form button[type="submit"]').click();await sync(owner);
  }
  const {page:coach,context:coachCtx}=await account(2,390);
  await coach.locator('.commitment-card').filter({hasText:outcome}).click();
  assert.equal(await coach.locator('#commitment-detail').getByText('A reviewed conclusion and supporting evidence are present.').count(),0);
  await coach.locator('[data-invite-answer="accept"]').click();await sync(coach);
  await coach.locator('#commitment-action-form [name="kind"]').selectOption('check_in');
  await coach.locator('#commitment-action-form [name="note"]').fill('Bring a draft to the check-in.');
  await coach.locator('#commitment-action-form [name="at"]').fill('2026-10-08T16:00');
  await coach.locator('#commitment-action-form button[type="submit"]').click();await sync(coach);
  await action(coach,'challenge','What is blocking the supporting evidence?');
  assert.equal(await coach.locator('#commitment-action-form option[value="complete"]').count(),0);
  assert.equal(await coach.locator('#commitment-action-form option[value="review"]').count(),0);
  await coach.locator('#commitment-detail').evaluate(el=>{el.scrollIntoView({block:'start'});window.scrollBy(0,-220);});
  await coach.screenshot({path:'test-results/accountability/coach-mobile.png'});
  const {page:manager}=await account(3);
  await manager.locator('.commitment-card').filter({hasText:outcome}).click();
  await manager.locator('[data-invite-answer="accept"]').click();await sync(manager);
  await sync(owner);await action(owner,'complete','Reviewed conclusion and fictional evidence supplied.');
  await sync(manager);await action(manager,'review','The conclusion and supporting evidence meet the agreed definition.');
  await sync(owner);await owner.locator('.commitment-history-details summary').click();assert.match(await owner.locator('#commitment-detail').innerText(),/casey · review/);
  await owner.screenshot({path:'test-results/accountability/owner-desktop.png',fullPage:true});
  // Offline intent survives reload, then uses the same stable operation on reconnect.
  await ownerCtx.setOffline(true);
  await owner.locator('#commitment-action-form [name="note"]').fill('Offline comment survives reload.');
  await owner.locator('#commitment-action-form button[type="submit"]').click();
  await owner.waitForFunction(()=>window.DCCCommitmentSync.summary.pending===1);
  const queued=await owner.evaluate(async()=> (await window.DCCCommitmentSync.pending())[0]);
  const blockPosts=route=>route.request().method()==='POST' ? route.abort('internetdisconnected') : route.continue();
  await ownerCtx.route('**/api/commitments/**',blockPosts);
  await ownerCtx.setOffline(false);await owner.reload();
  await owner.waitForFunction(()=>window.DCCCommitmentSync?.summary.pending===1);
  const recovered=await owner.evaluate(async()=> (await window.DCCCommitmentSync.pending())[0]);
  assert.equal(recovered.actionId,queued.actionId);assert.deepEqual(recovered.body,queued.body);
  await ownerCtx.unroute('**/api/commitments/**',blockPosts);
  await owner.evaluate(()=>DCCCommitmentSync.flush());
  await owner.waitForFunction(()=>window.DCCCommitmentSync?.summary.pending===0);
  const read=await owner.evaluate(id=>DCC.api('/api/commitments/'+id),id);
  assert.equal(read.events.filter(e=>e.detail.note==='Offline comment survives reload.').length,1);
  assert.ok(queued.actionId);
  // Stale account tab may neither read nor replay its old intent as account 4.
  await ownerCtx.addCookies([{name:'dcc_review_user',value:'4',url:origin}]);
  const stale=await owner.evaluate(async id=>{try{await DCC.api('/api/commitments/'+id);return null;}catch(e){return {status:e.status,code:e.code};}},id);
  assert.deepEqual(stale,{status:409,code:'ACCOUNT_CHANGED'});
  await owner.reload();await owner.waitForFunction(()=>!!window.DCCCommitmentSync);
  assert.equal((await owner.evaluate(()=>window.DCCCommitmentSync.cached())).length,0);
  // A pending coach comment remains recoverable after revocation; cached content is removed.
  await coachCtx.setOffline(true);await actionOffline(coach);
  await ownerCtx.addCookies([{name:'dcc_review_user',value:'1',url:origin}]);await owner.reload();
  await owner.locator('#itinerary-collaboration > summary').click();await owner.locator('.commitment-card').filter({hasText:outcome}).click();
  await owner.locator('[data-member-revoke="2"]').click();await sync(owner);
  await coachCtx.setOffline(false);await coach.locator('#commitment-refresh').click();
  await coach.waitForFunction(()=>window.DCCCommitmentSync.summary.attention && !document.getElementById("commitment-refresh").disabled);
  assert.equal((await coach.evaluate(id=>window.DCCCommitmentSync.cached().then(rows=>rows.some(r=>r.id===id)),id)),false);
  assert.equal((await coach.evaluate(()=>window.DCCCommitmentSync.pending())).length,1);
  assert.match(await coach.locator('#commitment-pending').innerText(),/Commitment unavailable/);
  // Responsive commitment panel never overflows at supported and narrow phone widths.
  for(const width of [320,390,760,1024,1440]){
    await manager.setViewportSize({width,height:1000});
    assert.ok(await manager.locator('#commitment-workspace').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'commitment panel overflow at '+width);
  }
  // A second device's stale revision stays recoverable and is never rebased.
  const conflict = await manager.evaluate(async id => {
    const record=(await DCCCommitmentSync.cached()).find(r=>r.id===id);
    await DCCCommitmentSync.queue(record,{kind:'comment',note:'Stale manager draft kept for recovery.'});
    await DCCCommitmentSync.flush(); await DCCCommitmentSync.refresh();
    return (await DCCCommitmentSync.pending())[0];
  },id);
  assert.equal(conflict.status,409);
  assert.equal(conflict.body.note,'Stale manager draft kept for recovery.');
  const latest=await manager.evaluate(id=>DCC.api('/api/commitments/'+id),id);
  assert.ok(conflict.body.expectedRevision<latest.revision);
  assert.equal(latest.events.filter(e=>e.detail.note==='Stale manager draft kept for recovery.').length,0);
  await manager.evaluate(actionId=>DCCCommitmentSync.discard(actionId),conflict.actionId);
  // An earlier snapshot cannot overwrite another tab's shared durable cache,
  // including browsers without Web Locks.
  const raceCtx=await browser.newContext();
  await raceCtx.addCookies([{name:'dcc_review_user',value:'5',url:origin}]);
  await raceCtx.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined}));
  await raceCtx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const tabA=await raceCtx.newPage(),tabB=await raceCtx.newPage();
  let heldRoute,hold=false,snapshot=[];
  let resolveHeld;const held=new Promise(resolve=>{resolveHeld=resolve;});
  await tabA.route('**/api/commitments?summary=1',r=>{
    if(hold){hold=false;heldRoute=r;resolveHeld();return;}
    return r.fulfill({status:200,json:snapshot});
  });
  await tabB.route('**/api/commitments?summary=1',r=>r.fulfill({status:200,json:snapshot}));
  for(const page of [tabA,tabB]){
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!!window.DCCCommitmentSync?.summary.lastSyncedAt);
  }
  const record={id:'synthetic-race',revision:2,title:'Fictional newer snapshot'};
  hold=true;const staleCall=tabA.evaluate(()=>DCCCommitmentSync.refresh());await held;
  snapshot=[record,{id:'synthetic-new',revision:1,title:'Fictional new record'}];
  await tabB.evaluate(()=>DCCCommitmentSync.refresh());
  await heldRoute.fulfill({status:200,json:[{...record,revision:1}]});await staleCall;
  const shared=await tabB.evaluate(()=>DCCCommitmentSync.cached());
  assert.equal(shared.find(row=>row.id===record.id).revision,2);
  assert.ok(shared.some(row=>row.id==='synthetic-new'));
  // Delayed successful and failed POST receipts also obey the shared generation.
  await tabA.evaluate(()=>{
    const original=DCC.api;
    DCC.api=(path,opts)=>path.startsWith('/api/commitments') && opts?.method==='POST'
      ? new Promise((resolve,reject)=>{window.resolveHeldAck=resolve;window.rejectHeldAck=reject;}) : original(path,opts);
  });
  await tabB.evaluate(()=>{
    const original=DCC.api;window.nextAckRevision=3;
    DCC.api=(path,opts)=>path.startsWith('/api/commitments') && opts?.method==='POST'
      ? Promise.resolve({id:'synthetic-race',title:'Fictional newer snapshot',revision:window.nextAckRevision++}) : original(path,opts);
  });
  await tabA.evaluate(async()=>DCCCommitmentSync.queue((await DCCCommitmentSync.cached()).find(r=>r.id==='synthetic-race'),{kind:'comment',note:'First synthetic operation'}));
  await tabA.waitForFunction(()=>!!window.resolveHeldAck);
  await tabB.evaluate(()=>DCCCommitmentSync.flush());
  await tabB.evaluate(async()=>{await DCCCommitmentSync.queue((await DCCCommitmentSync.cached()).find(r=>r.id==='synthetic-race'),{kind:'comment',note:'Newer synthetic operation'});await DCCCommitmentSync.flush();});
  await tabA.evaluate(async()=>{window.resolveHeldAck({id:'synthetic-race',title:'Fictional older snapshot',revision:3});await DCCCommitmentSync.flush();window.resolveHeldAck=null;});
  assert.equal((await tabB.evaluate(()=>DCCCommitmentSync.cached())).find(r=>r.id==='synthetic-race').revision,4);
  await tabA.evaluate(async()=>DCCCommitmentSync.queue((await DCCCommitmentSync.cached()).find(r=>r.id==='synthetic-race'),{kind:'comment',note:'Late rejected duplicate'}));
  await tabA.waitForFunction(()=>!!window.resolveHeldAck);
  await tabB.evaluate(()=>DCCCommitmentSync.flush());
  await tabA.evaluate(async()=>{window.rejectHeldAck(Object.assign(new Error('Synthetic late denial'),{status:404}));await DCCCommitmentSync.flush();window.resolveHeldAck=null;});
  assert.equal((await tabB.evaluate(()=>DCCCommitmentSync.pending())).length,0);
  assert.equal((await tabB.evaluate(()=>DCCCommitmentSync.cached())).find(r=>r.id==='synthetic-race').revision,5);
  // A late successful receipt cannot restore content after authoritative absence.
  await tabA.evaluate(async()=>DCCCommitmentSync.queue((await DCCCommitmentSync.cached()).find(r=>r.id==='synthetic-race'),{kind:'comment',note:'Revoked synthetic snapshot'}));
  await tabA.waitForFunction(()=>!!window.resolveHeldAck);
  snapshot=[];await tabB.evaluate(()=>DCCCommitmentSync.refresh());
  await tabA.evaluate(async()=>{window.resolveHeldAck({id:'synthetic-race',title:'Fictional revoked content',revision:6});await DCCCommitmentSync.flush();});
  assert.equal((await tabB.evaluate(()=>DCCCommitmentSync.cached())).length,0);
  await raceCtx.close();
  // A failed local transaction must not send anything or claim durable success.
  let sent=0; manager.on('request',req=>{if(req.method()==='POST'&&req.url().includes('/api/commitments'))sent++;});
  const localFailure=await manager.evaluate(async () => {
    const original=IDBDatabase.prototype.transaction, id=crypto.randomUUID();
    IDBDatabase.prototype.transaction=function(stores,mode){
      if(mode==='readwrite')throw new DOMException('Synthetic quota failure','QuotaExceededError');
      return original.call(this,stores,mode);
    };
    let message;
    try{await DCCCommitmentSync.queue({id,title:'Unsaved synthetic draft'},{title:'Unsaved synthetic draft'},true);}
    catch(e){message=e.message;}
    finally{IDBDatabase.prototype.transaction=original;}
    return {message,pending:(await DCCCommitmentSync.pending()).length,stored:(await DCCCommitmentSync.cached()).some(r=>r.id===id),summary:DCCCommitmentSync.summary};
  });
  assert.match(localFailure.message,/Local save failed/);assert.equal(localFailure.pending,0);assert.equal(localFailure.stored,false);assert.equal(sent,0);
  assert.ok(localFailure.summary.localError);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:['owner creation','scoped invitations','minimal preview','coach check-in and challenge','manager review','owner completion','offline durable replay exactly once','stale account blocked','revoked cached data removed, intent recoverable','responsive widths 320/390/760/1024/1440','recoverable stale revision without rebasing','cross-tab obsolete snapshot rejected without Web Locks','delayed acknowledgements preserve newer revisions and revoked absence','late errors cannot resurrect acknowledged intent','failed local transaction never sends or claims saved'],screenshots:['owner-desktop.png','coach-mobile.png']},null,2));
}catch(e){console.error(e);console.error('Browser errors:',errors);throw e;}
finally{clearTimeout(watchdog);await browser.close();}
async function actionOffline(page){
  await page.locator('#commitment-action-form [name="kind"]').selectOption('comment');
  await page.locator('#commitment-action-form [name="note"]').fill('Recoverable coach draft after revocation.');
  await page.locator('#commitment-action-form button[type="submit"]').click();
  await page.waitForFunction(()=>window.DCCCommitmentSync.summary.pending===1);
}
