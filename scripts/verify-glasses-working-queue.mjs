/* global localStorage, Event, document, DCCWorkingQueue, KeyboardEvent, innerWidth, Storage, window, history */
// Real queue APIs with fictional tasks only. Never point this at a live DCC instance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
const base=process.env.DCC_GLASSES_REVIEW_URL||'http://127.0.0.1:18449';
assert.ok(['127.0.0.1','localhost'].includes(new URL(base).hostname));
assert.equal((await fetch(base+'/api/health').then(r=>r.json())).reviewOnly,true);
const out=process.env.DCC_GLASSES_REVIEW_OUT||'test-results/glasses-working-queue';
await fs.mkdir(out,{recursive:true});
const api=async(url,body,method)=>{const r=await fetch(base+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,await r.clone().text());return r.json();};
const state=()=>api('/api/working-queue');
async function action(action,extra={}){const current=await state();return api('/api/working-queue',{action,sourceEventId:crypto.randomUUID(),expectedRevision:current.revision,at:new Date().toISOString(),...extra});}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({viewport:{width:600,height:600}});
await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
const page=await context.newPage(),errors=[],checks=[];
page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
const check=name=>{checks.push(name);console.log('PASS '+name);};
const source=id=>page.locator('[data-glasses-action="add"][data-glasses-id="glasses-'+id+'"]');
const queued=id=>page.locator('[data-glasses-action="focus"][data-glasses-id="glasses-'+id+'"]');
const detail=()=>page.locator('[data-glasses-action="details"]');
const select=async locator=>{await page.waitForTimeout(380);await locator.click();};
const key=async value=>{await page.waitForTimeout(380);await detail().focus();await page.keyboard.press(value);};
const ready=async()=>page.waitForFunction(()=>document.querySelector('[data-glasses-action="details"]')?.getAttribute('aria-disabled')==='false');
const current=id=>state().then(s=>s.queue.items.find(i=>i.task.id==='glasses-'+id));
try {
 await api('/api/queue-review/reset',{});
 const date=new Date().toISOString().slice(0,10);
 const make=(id,title,p={},order=0)=>({id:'glasses-'+id,type:'block',date,sort_order:order,properties:{local_id:'glasses-'+id,title,type:'task',status:'open',duration:30,...p}});
 await api('/api/blocks',[make('a','Review the project handoff'),make('b','Research the next approach'),make('c','Prepare tomorrow’s outline'),make('child','Read the proposed changes',{subtaskOf:'glasses-a'},1),make('done-child','Review the background',{subtaskOf:'glasses-a',status:'done'},2),make('grandchild','Check the supporting detail',{subtaskOf:'glasses-child'},3),...Array.from({length:51},(_,i)=>make('extra-'+i,'Additional task '+i))]);
 await page.goto(base+'/glasses.html');await source('a').waitFor();await source('extra-50').waitFor();
 assert.equal(await queued('a').count(),0);assert.equal(await source('done-child').count(),0);
 assert.equal(await page.locator('.glasses-nav').isVisible(),false);
 const initial=(await state()).revision;
 await select(source('a'));await queued('a').waitFor();
 assert.equal((await current('a')).status,'queued');assert.equal((await current('a')).task.properties.startedAt,undefined);
 const duplicateRequests=[];const captureDuplicate=r=>{if(r.method()==='POST'&&r.url()===base+'/api/working-queue')duplicateRequests.push(r.postDataJSON());};
 page.on('request',captureDuplicate);await page.waitForTimeout(400);await source('a').dispatchEvent('click');await page.waitForTimeout(100);page.off('request',captureDuplicate);assert.equal(duplicateRequests.length,0);assert.equal((await state()).revision,initial+1);assert.equal((await state()).queue.items.length,1);
 check('all open tasks paginate beyond 50; adding creates one queue membership and never starts a timer');
 await select(source('b'));await queued('b').waitFor();
 await queued('a').focus();await page.keyboard.press('ArrowRight');assert.equal(await queued('b').evaluate(el=>el===document.activeElement),true);
 assert.equal((await current('a')).status,'queued');
 await page.screenshot({path:path.join(out,'task-source-and-queue-600.png')});
 await select(queued('a'));await ready();await page.locator('.gq-subtasks').getByText('Read the proposed changes',{exact:false}).waitFor();
 assert.equal((await current('a')).status,'foreground');assert.ok((await current('a')).task.properties.startedAt);
 assert.deepEqual((await page.locator('.gq-subtasks li').allTextContents()).map(t=>t.slice(2)),['Read the proposed changes','Check the supporting detail','Review the background']);
 await page.waitForTimeout(400);
 await detail().evaluate(el=>{el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true,cancelable:true}));});
 await page.waitForTimeout(100);assert.equal((await current('a')).status,'foreground');
 check('queue selection starts foreground exactly once and displays open and completed subtasks');
 const beforeChildEdit=(await state()).revision;
 const childBefore=await api('/api/blocks/glasses-grandchild');await api('/api/blocks/glasses-grandchild',{properties:{...childBefore.properties,title:'Updated supporting detail'}},'PATCH');
 assert.equal((await state()).revision,beforeChildEdit);await page.evaluate(()=>DCCWorkingQueue.refresh());
 await page.locator('.gq-subtasks').getByText('Updated supporting detail',{exact:false}).waitFor();
 check('nested hierarchy stays grouped and same-revision child edits refresh the subtree');
 const started=(await current('a')).task.properties.startedAt;
 await key('Escape');await queued('a').waitFor();await page.waitForTimeout(100);assert.equal((await current('a')).task.properties.startedAt,started);
 await page.goForward();await ready();
 await page.goBack();await queued('a').waitFor();assert.equal((await current('a')).task.properties.startedAt,started);
 await page.goForward();await ready();assert.equal((await current('a')).task.properties.startedAt,started);
 const notes=()=>page.locator('.gq-notes'),editor=()=>notes().getByRole('textbox',{name:'Task notes'}).first();
 const notesSaved=()=>page.waitForFunction(()=>document.querySelector('[data-notes-status]')?.textContent==='Notes saved');
 await key('Enter');await editor().waitFor();assert.equal((await current('a')).task.properties.startedAt,started);
 await editor().fill('Capture the decision and next step.');await notesSaved();
 assert.match((await api('/api/working-queue/tasks/glasses-a/notes')).note.text,/Capture the decision/);
 await page.screenshot({path:path.join(out,'task-notes-600.png')});
 const noteRevision=(await state()).revision;await editor().press('ArrowRight');await editor().press('ArrowLeft');await editor().press('Enter');
 await page.goBack();await notes().waitFor({state:'detached'});await ready();assert.equal((await state()).revision,noteRevision);assert.equal((await current('a')).task.properties.startedAt,started);
 await page.waitForFunction(()=>document.activeElement?.dataset.glassesAction==='details');assert.equal(await detail().evaluate(el=>el===document.activeElement),true);
 await page.goBack();await queued('a').waitFor();await page.goForward();await ready();
 await key('Enter');await editor().waitFor();assert.match(await notes().innerText(),/Capture the decision/);await notesSaved();
 await page.goBack();await notes().waitFor({state:'detached'});await ready();await page.screenshot({path:path.join(out,'focused-task-subtasks-600.png')});
 check('foreground Select opens existing notes editor without timer changes; autosave and two-step Back preserve task focus');
 // Back during a failed save retains a draft; reload recovers it and retry succeeds.
 await key('Enter');await editor().waitFor();
 await page.route('**/api/working-queue/tasks/*/notes',route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Synthetic notes save failure'})}):route.continue());
 await editor().fill('Retain this draft through Back and reload.');await page.goBack();await notes().waitFor({state:'detached'});await page.waitForFunction(()=>document.querySelector('.gq-status')?.textContent.includes('Notes not saved'));
 await page.reload();await ready();await key('Enter');await editor().waitFor();assert.match(await editor().innerText(),/Retain this draft/);
 await notes().getByRole('button',{name:'Retry notes save'}).waitFor();await page.unroute('**/api/working-queue/tasks/*/notes');await notes().getByRole('button',{name:'Retry notes save'}).click();await notesSaved();
 // Conflict never silently rebases over another client's text.
 const savedNotes=await api('/api/working-queue/tasks/glasses-a/notes');
 await api('/api/working-queue/tasks/glasses-a/notes',{expectedRevision:savedNotes.revision,note:{html:'<p>Other client notes</p>',text:'Other client notes',blocks:[]}},'PUT');
 await editor().fill('My conflicting draft');await notes().getByRole('button',{name:'Replace saved notes with my draft'}).waitFor();
 assert.equal((await api('/api/working-queue/tasks/glasses-a/notes')).note.text,'Other client notes');assert.match(await editor().innerText(),/My conflicting draft/);
 await notes().getByRole('button',{name:'Replace saved notes with my draft'}).click();await notesSaved();assert.match((await api('/api/working-queue/tasks/glasses-a/notes')).note.text,/My conflicting draft/);
 await page.goBack();await notes().waitFor({state:'detached'});await ready();
 check('notes drafts survive failed saves, Back and reload; concurrent edits require an explicit conflict choice');
 // A clean cached editor must adopt newer server notes before accepting edits.
 let fresh=await api('/api/working-queue/tasks/glasses-a/notes');
 await api('/api/working-queue/tasks/glasses-a/notes',{expectedRevision:fresh.revision,note:{html:'<p>Fresh from another client</p>',text:'Fresh from another client',blocks:[]}},'PUT');
 await key('Enter');await editor().waitFor();await editor().getByText('Fresh from another client',{exact:true}).waitFor();await page.goBack();await notes().waitFor({state:'detached'});
 // An obsolete GET from an earlier opening must not replace a later saved edit.
 let releaseOld,held=false;const gate=new Promise(resolve=>{releaseOld=resolve;});
 await page.route('**/api/working-queue/tasks/glasses-a/notes',async route=>{if(route.request().method()==='GET'&&!held){held=true;const response=await route.fetch();await gate;return route.fulfill({response});}return route.continue();});
 await key('Enter');await editor().waitFor();await page.waitForTimeout(80);assert.equal(held,true);await page.goBack();await notes().waitFor({state:'detached'});
 await key('Enter');await editor().waitFor();await editor().fill('Latest edit after reopening');await notesSaved();releaseOld();await page.waitForTimeout(150);await page.unroute('**/api/working-queue/tasks/glasses-a/notes');
 await editor().fill('Latest edit after the stale response');await notesSaved();assert.match((await api('/api/working-queue/tasks/glasses-a/notes')).note.text,/after the stale response/);
 await page.goBack();await notes().waitFor({state:'detached'});await ready();
 check('newer saved notes refresh a cached editor; obsolete reads cannot overwrite later edits or save revisions');
 // A separate tab can explicitly recover a stranded local draft, without borrowing account state.
 await page.route('**/api/working-queue/tasks/*/notes',route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Synthetic retained draft'})}):route.continue());
 await key('Enter');await editor().waitFor();await editor().fill('Recover this retained draft in another tab');await notes().getByRole('button',{name:'Retry notes save'}).waitFor();await page.goBack();await notes().waitFor({state:'detached'});
 await page.evaluate(()=>{const note={html:'<p>Unrelated draft</p>',text:'Unrelated draft',blocks:[]};localStorage.setItem('dcc-glasses-notes:ws-other:1:other:glasses-a',JSON.stringify({taskId:'glasses-a',revision:'other',note}));localStorage.setItem('dcc-glasses-notes:ws-1:1:other:glasses-other',JSON.stringify({taskId:'glasses-other',revision:'other',note}));});
 const recoveryTab=await context.newPage();await recoveryTab.goto(base+'/?device=glasses');await recoveryTab.locator('[data-glasses-action="focus"][data-glasses-id="glasses-a"]').click();await recoveryTab.locator('[data-glasses-action="details"]').waitFor();await recoveryTab.waitForTimeout(400);await recoveryTab.locator('[data-glasses-action="details"]').click();
 await recoveryTab.getByRole('button',{name:'Recover retained draft'}).waitFor();assert.equal(await recoveryTab.getByRole('button',{name:'Recover retained draft'}).count(),1);assert.doesNotMatch(await recoveryTab.locator('.gq-notes').innerText(),/Unrelated draft/);await recoveryTab.getByRole('button',{name:'Recover retained draft'}).click();await recoveryTab.waitForFunction(()=>document.querySelector('[data-notes-status]')?.textContent==='Notes saved');assert.match((await api('/api/working-queue/tasks/glasses-a/notes')).note.text,/Recover this retained draft/);await recoveryTab.close();
 await page.unroute('**/api/working-queue/tasks/*/notes');await key('Enter');await editor().waitFor();await notesSaved();await page.goBack();await notes().waitFor({state:'detached'});
 check('account/task-scoped drafts remain explicitly recoverable from a separate tab after a failed save');
 // Acknowledging an older save cannot mark newer typed text clean.
 let releasePut,putHeld=false;const putGate=new Promise(resolve=>{releasePut=resolve;});
 await page.route('**/api/working-queue/tasks/glasses-a/notes',async route=>{if(route.request().method()==='PUT'&&!putHeld){putHeld=true;const response=await route.fetch();await putGate;return route.fulfill({response});}return route.continue();});
 await key('Enter');await editor().waitFor();await editor().fill('First in-flight draft');for(let attempt=0;attempt<100&&!putHeld;attempt++)await page.waitForTimeout(20);assert.equal(putHeld,true);
 await editor().fill('Newer draft while save is in flight');releasePut();await notesSaved();assert.match((await api('/api/working-queue/tasks/glasses-a/notes')).note.text,/Newer draft/);await page.unroute('**/api/working-queue/tasks/glasses-a/notes');
 await page.goBack();await notes().waitFor({state:'detached'});await ready();
 check('an older save acknowledgement cannot clear a newer unsaved edit');
 // When both storage and networking fail, Back retains text in memory and exit warns.
 await page.evaluate(()=>{window.notesOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('dcc-glasses-notes:'))throw new Error('Synthetic notes quota');return window.notesOriginalSetItem.call(this,k,v);};});
 await page.route('**/api/working-queue/tasks/*/notes',route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Synthetic offline save'})}):route.continue());
 await key('Enter');await editor().waitFor();await editor().fill('Keep this text in the open tab');await notes().getByText(/Draft kept in this tab only/).waitFor();
 assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true);
 await page.goBack();await notes().waitFor({state:'detached'});await key('Enter');await editor().waitFor();assert.match(await editor().innerText(),/Keep this text/);
 await notes().getByRole('button',{name:'Retry notes save'}).waitFor();await page.evaluate(()=>{Storage.prototype.setItem=window.notesOriginalSetItem;});await page.unroute('**/api/working-queue/tasks/*/notes');await notes().getByRole('button',{name:'Retry notes save'}).click();await notesSaved();
 await page.goBack();await notes().waitFor({state:'detached'});await ready();
 check('notes-specific storage and save failures retain text through Back and warn before tab exit');
 // HTML-backed legacy checkbox notes preserve structure/state through the canonical editor.
 await api('/api/blocks',[{id:'glasses-legacy-note',type:'block',date,properties:{_sourceTaskId:'glasses-b',html:'<div><input type="checkbox" checked>Checked legacy step</div><div><input type="checkbox">Open legacy step</div>',text:'Legacy steps'}}]);
 await page.goBack();await queued('b').waitFor();await select(queued('b'));await ready();await key('Enter');await notes().locator('.nb-check').first().waitFor();
 assert.equal(await notes().locator('.nb-check').count(),2);assert.equal(await notes().locator('.nb-check').first().isChecked(),true);await notes().locator('.nb-content').last().fill('Updated open legacy step');await notesSaved();
 const legacyNote=await api('/api/blocks/glasses-legacy-note');assert.equal(legacyNote.properties.blocks[0].type,'checkbox');assert.equal(legacyNote.properties.blocks[0].checked,true);assert.equal(legacyNote.properties.blocks[1].checked,false);
 await page.goBack();await notes().waitFor({state:'detached'});await page.goBack();await queued('a').waitFor();await select(queued('a'));await ready();
 check('legacy checked and unchecked note blocks survive editing without changing note identity');
 // Switching tasks while a notes read is outstanding cannot cross-contaminate editors.
 let releaseTaskRead,taskReadHeld=false;const taskReadGate=new Promise(resolve=>{releaseTaskRead=resolve;});
 await page.route('**/api/working-queue/tasks/glasses-a/notes',async route=>{if(route.request().method()==='GET'&&!taskReadHeld){taskReadHeld=true;const response=await route.fetch();await taskReadGate;return route.fulfill({response});}return route.continue();});
 await key('Enter');await editor().waitFor();for(let i=0;i<100&&!taskReadHeld;i++)await page.waitForTimeout(20);assert.equal(taskReadHeld,true);
 await page.goBack();await notes().waitFor({state:'detached'});await page.goBack();await queued('b').waitFor();await select(queued('b'));await ready();await key('Enter');await editor().waitFor();await editor().fill('Notes belong only to task B');await notesSaved();releaseTaskRead();await page.waitForTimeout(100);
 assert.match(await editor().innerText(),/only to task B/);assert.doesNotMatch((await api('/api/working-queue/tasks/glasses-a/notes')).note.text,/only to task B/);await page.unroute('**/api/working-queue/tasks/glasses-a/notes');
 await page.goBack();await notes().waitFor({state:'detached'});await page.goBack();await queued('a').waitFor();await select(queued('a'));await ready();
 // Keep viewport position as well as task selection on the quick notes round trip.
 await page.setViewportSize({width:375,height:300});await detail().focus();await page.evaluate(()=>window.scrollTo(0,90));const scrollBefore=await page.evaluate(()=>window.scrollY);assert.ok(scrollBefore>0);
 await page.waitForTimeout(400);await page.keyboard.press('Enter');await editor().waitFor();await page.goBack();await notes().waitFor({state:'detached'});await page.waitForFunction(()=>document.activeElement?.dataset.glassesAction==='details');
 assert.equal(await page.evaluate(()=>window.scrollY),scrollBefore);await page.setViewportSize({width:600,height:600});
 check('delayed reads stay bound to their task; quick notes Back restores foreground selection and scroll');



 await action('start',{taskId:'glasses-b',remindMinutes:null});await page.evaluate(()=>DCCWorkingQueue.refresh());
 assert.equal(await detail().getAttribute('data-running'),'false');assert.equal((await current('a')).status,'background');
 await key('Enter');await editor().waitFor();assert.equal((await current('a')).status,'background');await page.goBack();await notes().waitFor({state:'detached'});
 await page.goBack();await queued('a').waitFor();await select(queued('a'));await ready();assert.equal((await current('a')).status,'foreground');assert.equal((await current('b')).status,'background');
 check('other-client timing reconciles; opening notes does not resume background work; queue selection brings it forward');
 const beforeOffline=(await state()).revision;
 await context.setOffline(true);await key('ArrowRight');assert.equal((await state()).revision,beforeOffline);assert.match(await page.locator('.gq-status').innerText(),/Offline/);
 await context.setOffline(false);await page.evaluate(()=>DCCWorkingQueue.refresh());await ready();
 check('offline task gestures do not create hidden timer or completion changes');
 const beforeStorage=(await state()).revision;
 await page.evaluate(()=>{window.glassesOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.endsWith(':pending'))throw new Error('Synthetic local storage full');return window.glassesOriginalSetItem.call(this,key,value);};});
 await key('ArrowRight');await page.waitForFunction(()=>document.querySelector('.gq-status')?.textContent.includes('storage full'));assert.equal((await state()).revision,beforeStorage);
 await page.evaluate(()=>{Storage.prototype.setItem=window.glassesOriginalSetItem;});await ready();
 check('local receipt storage failure prevents the completion write');
 await page.route('**/api/working-queue/tasks/*/tree',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Synthetic tree failure'})}));
 await page.goBack();await queued('a').waitFor();await select(queued('a'));await ready();await page.getByRole('button',{name:'Retry subtasks'}).waitFor();
 assert.match(await page.locator('.gq-detail').innerText(),/Subtasks unavailable/);
 await page.unroute('**/api/working-queue/tasks/*/tree');await select(page.getByRole('button',{name:'Retry subtasks'}));await page.locator('.gq-subtasks li').first().waitFor();
 check('subtask read failures are visible and retry restores the current task tree');
 // A stale coordinator revision must fail closed and refresh before completion.
 await page.route('**/api/working-queue',route=>route.request().method()==='POST'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic stale revision'})}):route.continue());
 const conflictRevision=(await state()).revision;await key('ArrowRight');await page.locator('.wq-conflict').waitFor();assert.equal((await state()).revision,conflictRevision);
 await page.unroute('**/api/working-queue');await page.locator('[data-queue-action="clear-conflict"]').click();await ready();
 check('a revision conflict preserves confirmed timing and exposes recovery');
 // Dismiss stops first. A failed removal leaves the open, paused task visible.
 await page.route('**/api/working-queue',route=>route.request().method()==='POST'&&route.request().postDataJSON().action==='queue-remove'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic remove conflict'})}):route.continue());
 await key('ArrowLeft');await page.locator('.wq-conflict').waitFor();assert.equal((await current('a')).status,'paused');assert.equal((await current('a')).task.properties.startedAt,undefined);assert.notEqual((await current('a')).task.properties.status,'done');
 assert.equal(await detail().count(),1);
 await page.unroute('**/api/working-queue');await page.locator('[data-queue-action="clear-conflict"]').click();await ready();
 await key('ArrowLeft');await page.locator('.gq-list').waitFor();assert.equal(await current('a'),undefined);assert.notEqual((await api('/api/blocks/glasses-a')).properties.status,'done');assert.equal((await api('/api/blocks/glasses-a')).properties.startedAt,undefined);await source('a').waitFor();
 await select(source('a'));await queued('a').waitFor();assert.equal((await current('a')).status,'paused');
 check('swipe left pauses before removal; removal failure remains visible; dismiss preserves the task and allows re-adding without a timer');
 // Completion lost acknowledgement: reuse the saved command, and leave the task list once.
 await select(queued('a'));await ready();let lost=false,allowReplay=false,completionId;
 await page.route('**/api/working-queue',async route=>{
  if(route.request().method()==='POST'&&route.request().postDataJSON().action==='done'&&!lost){lost=true;completionId=route.request().postDataJSON().sourceEventId;await route.fetch();await route.abort();return;}if(lost&&!allowReplay&&route.request().method()==='POST'&&route.request().postDataJSON().action==='done'){await route.abort();return;}await route.continue();
 });
 await key('ArrowRight');await page.getByRole('button',{name:'Retry saved update'}).waitFor();assert.equal((await current('a')).status,'completed');
 const completedRevision=(await state()).revision;
 await page.reload();await page.getByRole('button',{name:'Retry saved update'}).waitFor();
 const retries=[];page.on('request',r=>{if(r.method()==='POST'&&r.url()===base+'/api/working-queue')retries.push(r.postDataJSON());});
 const replayResponse=page.waitForResponse(r=>r.url()===base+'/api/working-queue'&&r.request().method()==='POST'&&r.request().postDataJSON().sourceEventId===completionId);
 allowReplay=true;await page.waitForFunction(async()=>{await DCCWorkingQueue.tick();return !document.querySelector('[data-queue-action="retry"]');},null,{polling:100});await page.locator('.gq-list').waitFor();await page.unroute('**/api/working-queue');
 const replay=await replayResponse;assert.ok(replay.ok(),'saved completion replay must be acknowledged');assert.equal((await replay.json()).duplicate,true);assert.equal(await page.locator('.wq-conflict').count(),0);
 assert.ok(retries.some(r=>r.sourceEventId===completionId));assert.equal((await state()).revision,completedRevision);
 assert.equal(await queued('a').count(),0);assert.equal((await api('/api/blocks/glasses-a')).properties.status,'done');
 assert.equal(new URL(page.url()).searchParams.get('device'),'glasses');
 check('swipe right persists completion; lost-response reload retries the same receipt once and returns to the list');
 await select(queued('b'));await ready();
 for(const [width,height] of [[320,600],[375,812],[600,600],[1440,1000]]){
  await page.setViewportSize({width,height});await detail().focus();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,'focus-'+width+'.png')});await page.goBack();await queued('b').waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'list-'+width+'.png')});await select(queued('b'));await ready();
 }
 await page.setViewportSize({width:600,height:600});await page.evaluate(()=>document.documentElement.style.zoom='2');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.evaluate(()=>document.documentElement.style.zoom='');
 check('list and detail stay usable at 320/375/600/1440 widths and 200 percent zoom');
 await key('Escape');await queued('b').waitFor();
 await page.goto(base+'/?device=glasses&tab=schedule');await page.waitForSelector('#tab-schedule.active');assert.equal(await page.locator('.glasses-nav').isVisible(),true);
 check('keyboard Escape uses the same Back path and explicit itinerary links retain their adapter');
 // An inactive or hidden surface must not trigger a full catalog scan, even past TTL.
 const sourceRequests=[];const recordSource=r=>{if(r.method()==='GET'&&new URL(r.url()).pathname==='/api/working-queue/tasks')sourceRequests.push(r.url());};page.on('request',recordSource);
 await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+120000;DCCWorkingQueue.render();Date.now=now;});await page.waitForTimeout(100);assert.equal(sourceRequests.length,0);
 await page.goto(base+'/?device=glasses');await source('c').waitFor();await page.waitForTimeout(150);sourceRequests.length=0;
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});const now=Date.now;Date.now=()=>now()+120000;DCCWorkingQueue.render();Date.now=now;});await page.waitForTimeout(100);assert.equal(sourceRequests.length,0);
 await page.evaluate(()=>{delete document.hidden;});page.off('request',recordSource);
 check('hidden and inactive glasses views do not scan the task catalog');
 const definition=await api('/api/guided/definitions',{id:crypto.randomUUID(),expectedRevision:0,definition:{title:'Synthetic guided review',goal:'Review the synthetic fixture',starterPrompt:'Ask for the confirmed outcome.',completionCriteria:'Record a confirmed result.'}});
 const guided=await api('/api/guided/tasks',{id:crypto.randomUUID(),definitionId:definition.id,date});
 await page.reload();const guidedSource=page.locator('[data-glasses-action="add"][data-glasses-id="'+guided.taskId+'"]'),guidedCard=page.locator('[data-glasses-action="focus"][data-glasses-id="'+guided.taskId+'"]');await guidedSource.waitFor();await select(guidedSource);await guidedCard.waitFor();
 const modal=()=>page.getByRole('dialog');const settled=()=>page.waitForFunction(()=>!document.querySelector('.dcc-overlay'));
 const guidedPreview=()=>page.waitForFunction(()=>document.querySelector('[data-preview]')?.textContent.includes('Ask for the confirmed outcome.'));
 const beforeGuided=(await state()).revision;
 await select(guidedCard);await guidedPreview();await page.goBack();await settled();assert.equal((await state()).revision,beforeGuided);assert.equal(await page.locator('.gq-list').count(),1);
 await select(guidedCard);await guidedPreview();await modal().getByRole('button',{name:'Cancel',exact:true}).click();await settled();assert.equal((await state()).revision,beforeGuided);assert.equal(await page.evaluate(()=>!!history.state?.glassesReview),false);
 await select(guidedCard);await guidedPreview();await modal().getByRole('button',{name:'Bring forward',exact:true}).click();await settled();await ready();assert.equal(await detail().getAttribute('data-glasses-id'),guided.taskId);assert.equal(await detail().getAttribute('data-running'),'true');
 const beforeGuidedDone=(await state()).revision;
 await key('ArrowRight');await guidedPreview();await page.goBack();await settled();await ready();assert.equal(await page.evaluate(()=>history.state?.glassesTask),guided.taskId);assert.equal((await state()).revision,beforeGuidedDone);
 await page.goForward();await page.waitForFunction(()=>!history.state?.glassesReview);await settled();await ready();assert.equal(await page.evaluate(()=>!!history.state?.glassesReview),false,'Forward must skip a canceled review marker');assert.equal(await page.evaluate(()=>history.state?.glassesTask),guided.taskId);
 await page.goBack();await settled();assert.equal(await page.locator('.gq-list').count(),1,'Back after skipping a canceled review must return to the list');assert.equal((await state()).revision,beforeGuidedDone);
 await page.goForward();await settled();await ready();
 await key('ArrowRight');await guidedPreview();await page.waitForFunction(()=>document.querySelector('[data-completion-time] .wq-effort'));
 const guidedWrites=[];const recordGuided=r=>{if(r.method()==='POST'&&r.url()===base+'/api/working-queue')guidedWrites.push(r.postDataJSON());};page.on('request',recordGuided);
 await modal().getByRole('button',{name:'Complete',exact:true}).click();await page.waitForTimeout(150);assert.equal(guidedWrites.length,0,'empty outcome must not freeze an invalid retry receipt');
 await modal().locator('[data-outcome]').fill('Confirmed synthetic review complete.');
 let failGuided=true;await page.route('**/api/working-queue',route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='done'&&failGuided){failGuided=false;return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Synthetic guided save failure'})});}return route.continue();});
 await modal().getByRole('button',{name:'Complete',exact:true}).click();await modal().getByText(/Completion not confirmed/).waitFor();assert.equal((await state()).revision,beforeGuidedDone);
 await modal().getByRole('button',{name:'Complete',exact:true}).click();await settled();await page.locator('.gq-list').waitFor();page.off('request',recordGuided);await page.unroute('**/api/working-queue');
 assert.equal(guidedWrites.length,2);assert.equal(guidedWrites[0].sourceEventId,guidedWrites[1].sourceEventId);assert.equal((await api('/api/guided/tasks/'+guided.taskId)).session.state,'completed');assert.equal(await page.evaluate(()=>!!history.state?.glassesReview),false);
 check('guided Native Back cancels transient review first; confirmed start, required outcome and same-receipt retry restore navigation');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors,synthetic:true,physicalMeta:false},null,2));
} catch(error){console.log(await page.locator('#working-queue-root').innerText());console.log(await page.evaluate(()=>({active:document.activeElement?.outerHTML,inert:document.getElementById('tab-working-queue')?.inert,history:history.state,notes:document.querySelector('.gq-notes')?.innerText})));await page.screenshot({path:path.join(out,'failure.png')});throw error;} finally {await browser.close();}
