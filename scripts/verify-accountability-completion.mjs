/* global DCC, DCCCommitmentSync, window, document */
// Synthetic local QA in a separate headless Mac Chrome profile. No external requests.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
const origin='http://127.0.0.1:8107';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors=[];const contexts=[];
async function account(user,width=1440){
 const context=await browser.newContext({viewport:{width,height:900},timezoneId:'America/New_York'});contexts.push(context);
 await context.addCookies([{name:'dcc_review_user',value:String(user),url:origin}]);
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.DCCCommitmentSync);return {context,page};
}
async function settle(page){await page.evaluate(()=>DCCCommitmentSync.flush());await page.waitForFunction(()=>DCCCommitmentSync.summary.pending===0);}
async function refresh(page){await page.evaluate(async()=>{await DCCCommitmentSync.refresh();});await page.locator('#commitment-inline-sync').isVisible().then(async visible=>{await page.locator(visible?'#commitment-inline-sync':'#commitment-refresh').click();});}
async function action(page,kind,note){await page.locator('#commitment-action-form [name=kind]').selectOption(kind);await page.locator('#commitment-action-form [name=note]').fill(note);await page.locator('#commitment-action-form button[type=submit]').click();await settle(page);}
await fs.mkdir('test-results/accountability-completion',{recursive:true});
try{
 const {page:owner}=await account(1);
 await owner.request.post(origin+'/review/commitments/reset');await owner.reload();await owner.waitForFunction(()=>!!window.DCCCommitmentSync);
 assert.equal(await owner.locator('#tab-bar [data-tab=social]').count(),0);assert.equal(await owner.locator('#tab-bar [data-tab=vault]').count(),0);
 await owner.locator('#dcc-settings-button').click();await owner.locator('#vault-tab-btn').click();await owner.waitForFunction(()=>document.getElementById('tab-vault').classList.contains('active'));
 assert.equal(new URL(owner.url()).hash,'#personal-vault');await owner.reload();assert.equal(await owner.locator('#tab-vault').getAttribute('class'),'tab-content active');
 await owner.locator('[data-tab=budget]').click();assert.equal(new URL(owner.url()).hash,'#budget');await owner.reload();assert.ok(await owner.locator('#tab-budget').evaluate(el=>el.classList.contains('active')));
 await owner.locator('[data-tab=schedule]').click();
 const task='fixture-'+Date.now();
 await owner.evaluate(async id=>{await DCC.api('/api/blocks',{method:'POST',body:{id,type:'block',date:DCC.dates.todayKey(),properties:{kind:'task',local_id:id,title:'OWNER PRIVATE rehearsal',detail:'PRIVATE inbox notes',source:'manual',duration:30,start:'09:30',end:'10:00',status:'open'}}});},task);
 await owner.reload();await owner.waitForFunction(id=>!!document.querySelector('[data-task-collaborate="'+id+'"]'),task);
 assert.equal(await owner.evaluate(async id=>{
  const block=(await DCC.api('/api/blocks')).find(b=>b.id===id);
  const ev=DCC.TaskModel.fromBlock(block);
  return window.createTaskListRowRenderer({pool:[]})(ev,0,'open').querySelectorAll('[data-task-collaborate]').length;
 },task),0,'non-itinerary persisted rows must not expose an unsupported anchor');
 await owner.locator('[data-task-collaborate="'+task+'"]').click();
 assert.equal(await owner.locator('#commitment-workspace').evaluate(el=>el.classList.contains('commitment-inline')),true);
 assert.equal(await owner.locator('#commitment-create-form [name=title]').inputValue(),'');
 await owner.locator('#commitment-create-form [name=title]').fill('Shared rehearsal result');await owner.locator('#commitment-create-form [name=definitionDone]').fill('A clear reviewed recording');await owner.locator('#commitment-create-form button[type=submit]').click();await settle(owner);
 const id=await owner.evaluate(async()=> (await DCCCommitmentSync.cached()).find(r=>r.title==='Shared rehearsal result').id);
 assert.equal(await owner.locator('#commitment-action-form option[value=complete]').count(),0);
 assert.equal(await owner.locator('.commitment-create').isVisible(),false);
 assert.equal(await owner.locator('#commitment-create-form [name=sourceBlockId]').inputValue(),task);
 assert.match(await owner.locator('#commitment-detail').innerText(),/existing checkbox|itinerary checkbox/);
 for(const [name,role] of [['blair','coach'],['casey','manager']]){await owner.locator('#commitment-detail details:not(.commitment-history-details) summary').click();await owner.locator('#commitment-invite-form [name=person]').fill(name);await owner.locator('#commitment-invite-form [name=role]').selectOption(role);await owner.locator('#commitment-invite-form button[type=submit]').click();await settle(owner);}
 const {page:coach,context:coachContext}=await account(2,390);
 await coach.locator('#itinerary-collaboration > summary').click();await coach.locator('[data-commitment="'+id+'"]').click();
 assert.ok(!(await coach.locator('#tab-schedule').innerText()).includes('OWNER PRIVATE'));
 await coach.locator('[data-invite-answer=accept]').click();await settle(coach);
 await action(coach,'comment','Synthetic inline coaching comment');
 await coach.locator('[data-commitment-reaction="💪"]').click();await settle(coach);
 await action(coach,'highlight','Focus on the rehearsal conclusion');
 await coach.locator('#commitment-action-form [name=kind]').selectOption('check_in');await coach.locator('#commitment-action-form [name=note]').fill('Review the recording together');await coach.locator('#commitment-action-form [name=at]').fill('2026-10-08T16:00');await coach.locator('#commitment-action-form button[type=submit]').click();await settle(coach);
 await action(coach,'bounty_offer','Synthetic encouragement with points only');
 await refresh(owner);await action(owner,'check_in_response','Recording is ready for review');await action(owner,'evidence','Fictional evidence provided');
 await owner.locator('[data-bounty-decision=approved]').click();await settle(owner);assert.match(await owner.locator('#commitment-detail').innerText(),/approved/);
 await owner.evaluate(async task=>{await DCC.api('/api/blocks/'+task,{method:'PATCH',body:{properties:{kind:'task',local_id:task,title:'OWNER PRIVATE rehearsal',detail:'PRIVATE inbox notes',status:'done',done:true}}});},task);await refresh(owner);assert.match(await owner.locator('#commitment-detail').innerText(),/completed/);
 const {page:manager}=await account(3,760);await manager.locator('#itinerary-collaboration > summary').click();await manager.locator('[data-commitment="'+id+'"]').click();await manager.locator('[data-invite-answer=accept]').click();await settle(manager);await action(manager,'review','Reviewed against the recording definition');
 await refresh(owner);
 for(const width of [320,390,760,1024,1440]){await owner.setViewportSize({width,height:900});assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'overflow '+width);await owner.screenshot({path:'test-results/accountability-completion/itinerary-'+width+'.png'});}
 await refresh(coach);await coachContext.setOffline(true);await coach.locator('#commitment-action-form [name=kind]').selectOption('comment');await coach.locator('#commitment-action-form [name=note]').fill('Offline coach text');await coach.locator('#commitment-action-form button[type=submit]').click();await coach.waitForFunction(()=>DCCCommitmentSync.summary.pending===1);await coachContext.setOffline(false);await settle(coach);
 // Queue is expected to remain pending offline; the separate regression suite covers replay.
 console.log('PASS: itinerary links, audience, roles, comments/reactions/highlights/check-ins/evidence/review, owner-approved points and five responsive widths');
 assert.deepEqual(errors,[]);
}finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
