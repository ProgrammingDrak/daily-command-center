/* global __dirname, fetch, URL, window, document, console, process, setTimeout, openAddModal, closeAddModal, refoldTaskStateFromBlockCache, render, viewMode: writable, setAddModalMode, _addModalTaskId */
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const base='http://127.0.0.1:8301', date='2026-10-06';
const prefix='flow-'+Date.now(), a=prefix+'-a', b=prefix+'-b';
const read=id=>fetch(base+'/api/blocks/'+id+'/work').then(r=>r.json());
const notes=()=>fetch(base+'/api/blocks?date='+date).then(r=>r.json()).then(rows=>rows.filter(r=>r.properties?._sourceTaskId===a));
async function until(check,label){for(let n=0;n<80;n++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error(label);}
(async()=>{
 assert.equal((await(await fetch(base+'/api/health')).json()).database,'fixture');
 for(const [id,title] of [[a,'Review task A'],[b,'Review task B']])await fetch(base+'/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,type:'block',date,properties:{local_id:id,title,type:'task',start:'10:00',end:'10:30',duration:30,tags:['retain-tag'],commuteToMinutes:15,source_id:'https://example.test/source'}})});
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(base);await page.waitForFunction(()=>window.blockStore&&typeof openAddModal==='function');
  await page.evaluate(async d=>{await window.blockStore.loadDay(d);refoldTaskStateFromBlockCache();render();},date);
  const open=async id=>{await page.evaluate(id=>openAddModal(id),id);await page.locator('#am-work-actions button').first().waitFor();await page.waitForTimeout(100);};
  await page.locator('#triage-pill-nav').focus();await open(a);
  assert.equal(await page.getByRole('textbox',{name:'Task notes',exact:true}).count(),1);
  // Named dialog, keyboard focus trap, editable title keeps the dialog label.
  assert.equal(await page.locator('#add-modal-close').evaluate(e=>document.activeElement===e),true);
  await page.locator('#add-modal-title').press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'add-modal-save');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'add-modal-title');
  assert(await page.locator('#tab-bar').evaluate(e=>e.inert));
  await page.locator('#add-modal-title').press('Enter');await page.locator('.am-title-edit').fill('Uncommitted title');
  assert.equal(await page.locator('[role="dialog"][aria-labelledby="add-modal-title"]').count(),1);
  await page.locator('.am-title-edit').press('Escape');assert.equal(await page.locator('#add-modal-title').textContent(),'Review task A');
  // Closing saves notes only, leaves explicit title/settings drafts uncommitted.
  await page.locator('#add-modal-title').press('Enter');await page.locator('.am-title-edit').fill('Discard on close');await page.locator('.am-title-edit').press('Enter');
  await page.getByText('Task settings',{exact:true}).click();await page.locator('#am-commute-to-input').fill('60');
  await page.evaluate(()=>window._amBlockEditor.setBlocks([{type:'paragraph',content:'First note'}]));
  await page.locator('#add-modal-close').click();
  await until(async()=> (await notes()).some(n=>n.properties.text.includes('First note')),'notes did not persist on close');
  await until(()=>page.evaluate(()=>document.activeElement.id==='triage-pill-nav'),'focus did not return to the opener');
  assert.equal((await read(a)).block.properties.title,'Review task A');assert.equal((await read(a)).block.properties.commuteToMinutes,15);
  assert.deepEqual((await read(a)).block.properties.tags,['retain-tag']);
  const noteId=(await notes())[0].id;
  await open(a);assert((await page.locator('#am-notes-block-editor').innerText()).includes('First note'));
  await page.evaluate(()=>window._amBlockEditor.setBlocks([{type:'paragraph',content:'Second note'}]));await page.locator('#add-modal-close').click();
  await until(async()=> (await notes()).some(n=>n.properties.text.includes('Second note')),'note update did not persist');
  assert.deepEqual((await notes()).map(n=>n.id),[noteId],'updating notes must not create a duplicate');
  await open(a);await page.evaluate(()=>window._amBlockEditor.setBlocks([]));await page.locator('#add-modal-close').click();
  await until(async()=> (await notes()).some(n=>n.id===noteId&&n.properties.html===''&&n.properties.text===''),'empty note override did not persist');
  assert.deepEqual((await notes()).map(n=>n.id),[noteId],'clearing notes must retain identity');
  await open(a);assert.equal(await page.evaluate(()=>window._amBlockEditor.isEmpty()),true);
  // Rejected work action rolls back optimistic state and leaves drafts available.
  await page.evaluate(()=>window._amBlockEditor.setBlocks([{type:'paragraph',content:'Keep this draft'}]));
  const reject=route=>route.request().method()==='POST'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic work conflict'})}):route.continue();
  await page.route('**/api/blocks/'+a+'/work',reject);
  await page.locator('#am-work-actions [data-work-action="start"]').click();
  await until(()=>page.locator('#am-work-actions [data-work-action="start"]').isEnabled(),'work control not restored after conflict');
  assert(!(await read(a)).block.properties.startedAt);
  assert((await page.locator('#am-notes-block-editor').innerText()).includes('Keep this draft'));
  assert((await page.evaluate(()=>window.blockStore.debug())).deadLetterEntries>=1);
  await page.unroute('**/api/blocks/'+a+'/work',reject);
  await page.locator('#am-work-actions [data-work-action="start"]').click();await page.locator('#am-work-actions [data-work-action="pause"]').waitFor();
  await page.locator('#am-work-actions [data-work-action="pause"]').click();await page.locator('#am-work-actions [data-work-action="start"]').waitFor();
  // Close A while its history is in flight; opening B must never show A's controls.
  let release,started;const began=new Promise(r=>started=r), gate=new Promise(r=>release=r);
  const delay=async route=>{started();await gate;await route.continue();};
  await page.route('**/api/blocks/'+a+'/work',delay);
  await page.evaluate(id=>{window.DCCWorkSessions.renderHistory(id);},a);await began;
  await page.evaluate(()=>closeAddModal());await open(b);release();await page.waitForTimeout(200);
  assert.equal(await page.locator('#am-work-actions [data-work-task]').first().getAttribute('data-work-task'),b);
  assert.equal(await page.evaluate(()=>_addModalTaskId),b);
  await page.unroute('**/api/blocks/'+a+'/work',delay);
  assert.equal((await read(b)).block.properties.title,'Review task B');
  // Offline Save is buffered, survives reload, and never announces server success.
  const offline=route=>route.request().method()==='PATCH'?route.abort('failed'):route.continue();
  await page.route('**/api/blocks/'+b,offline);
  await page.locator('#add-modal-title').click();await page.locator('.am-title-edit').fill('Offline draft B');await page.locator('.am-title-edit').press('Enter');
  await page.locator('#add-modal-save').click();await page.waitForTimeout(250);
  assert((await page.evaluate(()=>window.blockStore.debug())).walEntries>0);
  assert((await page.locator('#am-save-status').textContent()).match(/Offline|Needs attention|Waiting to sync/));
  assert.equal((await read(b)).block.properties.title,'Review task B');
  await page.reload();await page.waitForFunction(()=>window.blockStore);
  assert((await page.evaluate(()=>window.blockStore.debug())).walEntries>0,'reload discarded queued changes');
  await page.unroute('**/api/blocks/'+b,offline);await page.evaluate(()=>window.blockStore.replayWAL());
  await until(async()=>(await read(b)).block.properties.title==='Offline draft B','buffered title did not replay');
  await page.evaluate(async d=>{await window.blockStore.loadDay(d);refoldTaskStateFromBlockCache();},date);
  await page.evaluate(id=>{viewMode='archive';openAddModal(id);},a);await page.waitForTimeout(300);
  await page.evaluate(()=>setAddModalMode(true));assert(await page.locator('#add-modal-edit').isHidden());
  assert(await page.locator('#am-work-actions button').first().isDisabled());
  await page.getByText('Time and history',{exact:true}).click();
  for(const button of await page.locator('#am-work-history button').all())assert(await button.isDisabled());
  assert(await page.locator('#am-item-input').isDisabled());
  await page.evaluate(()=>{closeAddModal();if(viewMode==='archive')viewMode='today';});
  assert(!await page.locator('#tab-bar').evaluate(e=>e.inert));
  assert.deepEqual(errors,[]);
  const evidence={passed:['named dialog and title editor','Tab/Shift+Tab containment','background inertness and restoration','Escape rename cancellation','notes on close','explicit settings remain unsaved on close','notes update without duplication','clear notes persisted','409 work conflict rollback and draft retention','work retry start/pause','stale history excluded after task switch','offline queued save survives reload and replays','archived edit bypass blocked','late history reallocation read-only'],data:'synthetic in-memory only',realPhone:false};
  fs.writeFileSync(path.join(__dirname,'../design/task-details/detail-flow-checks.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
