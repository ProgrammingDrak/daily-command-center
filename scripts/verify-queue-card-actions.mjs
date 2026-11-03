// Full-app regression using an isolated synthetic account and real canonical APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
/* global window, document, navigator, DCCWorkingQueue, innerWidth */
const port=process.env.QUEUE_CARD_REVIEW_PORT||'8192',base='http://127.0.0.1:'+port;
const server=spawn(process.execPath,['scripts/ui-review-server.mjs'],{env:{...process.env,PORT:port,DCC_WORKING_QUEUE_REVIEW:'1'},stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.once('error',reject);server.once('exit',code=>reject(new Error('Preview exited '+code)));server.stdout.on('data',b=>{if(String(b).includes('UI review server:'))resolve();});});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const page=await browser.newPage({viewport:{width:1280,height:1100}}),errors=[],commands=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/working-queue'))commands.push(r.postDataJSON());});
const out=process.env.DCC_QA_OUTPUT||'/tmp/dcc-queue-card-actions';fs.mkdirSync(out,{recursive:true});
const date=new Date().toISOString().slice(0,10),past=new Date(Date.now()-2*86400000).toISOString().slice(0,10);
const api=async(path,data)=>{const r=data?await page.request.post(base+path,{data}):await page.request.get(base+path);assert.ok(r.ok(),await r.text());return r.json();};
const make=(id,title,p={},day=date,parent_id=null,type='block')=>api('/api/blocks',{id,type,date:day,parent_id,properties:{local_id:id,title,type:'task',duration:30,status:'open',...p}});
const command=async(action,taskId,extra={})=>{const state=await api('/api/working-queue');return api('/api/working-queue',{action,taskId,...extra,expectedRevision:state.revision,sourceEventId:crypto.randomUUID(),at:new Date().toISOString()});};
const card=id=>page.locator('[data-queue-id="'+id+'"]'),button=(id,action)=>card(id).locator('[data-queue-action="'+action+'"]');
const order=()=>page.locator('.wq-next [data-queue-id]').evaluateAll(els=>els.map(el=>el.dataset.queueId));
const refresh=()=>page.evaluate(()=>DCCWorkingQueue.refresh());
const count=()=>commands.filter(c=>c.action==='queue-reorder').length;
const waitOrder=ids=>page.waitForFunction(ids=>JSON.stringify([...document.querySelectorAll('.wq-next [data-queue-id]')].map(el=>el.dataset.queueId))===JSON.stringify(ids),ids);
async function hold(id,action){const target=button(id,action);await target.scrollIntoViewIfNeeded();const b=await target.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.waitForTimeout(620);await page.mouse.up();}
async function closeDetails(){await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#add-modal-overlay.open'));}
try{
 await api('/api/queue-review/reset',{});
 for(const id of ['a','b','c']){await make(id,({a:'Review design proposal',b:'Compare launch options',c:'Prepare release notes'})[id],id==='b'?{start:'09:00',end:'09:30',_taskNotes:{text:'Saved canonical itinerary notes',html:'<p>Saved canonical itinerary notes</p>'}}:{});await command('queue-add',id);}
 await make('b-child','Cached current-day child',{subtaskOf:'b'});
 await make('b-action','',{_sourceTaskId:'b',text:'Cached current-day action',tags:['action-item']},date,'b');
 await make('old','Previous occurrence',{local_id:'repeat-alias'},past);await make('today','Current occurrence',{local_id:'repeat-alias'});
 await make('old-note','',{_sourceTaskId:'repeat-alias',html:'<p>Earlier occurrence notes</p>',text:'Earlier occurrence notes'},past,'old', 'note');
 await make('today-note','',{_sourceTaskId:'repeat-alias',html:'<p>Current occurrence notes</p>',text:'Current occurrence notes'},date,'today','note');
 await make('old-child','Earlier occurrence child',{subtaskOf:'repeat-alias'},past);
 await make('today-child','Current occurrence child',{subtaskOf:'repeat-alias'});
 await make('old-action','',{_sourceTaskId:'repeat-alias',text:'Earlier follow-up',tags:['action-item']},past,'old');
 await make('today-action','',{_sourceTaskId:'repeat-alias',text:'Current follow-up',tags:['action-item']},date,'today');
 await command('queue-add','old');
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.DCCWorkingQueue);await refresh();
 assert.deepEqual(await order(),['a','b','c','old']);
 await page.evaluate(()=>{window.copyLog=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copyLog.push(text)}});});
 const copiedBefore=commands.length;
 await card('b').getByRole('button',{name:'Copy task title: Compare launch options',exact:true}).click();
 await page.waitForFunction(()=>window.copyLog?.[0]==='Compare launch options');
 assert.equal(commands.length,copiedBefore,'copy never mutates task state');
 assert.equal(await page.locator('#add-modal-overlay.open,.done-modal-overlay.open,.dcc-overlay').count(),0,'copy never opens details or completion');
 await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new Error('Clipboard denied');};document.execCommand=()=>false;});
 await card('b').getByRole('button',{name:'Copy task title: Compare launch options',exact:true}).press('Enter');
 await page.getByText('Could not copy title. Select the title and copy it manually.',{exact:true}).waitFor();
 await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});document.execCommand=()=>{window.fallbackTitle=document.activeElement.value;return true;};});
 await card('b').getByRole('button',{name:'Copy task title: Compare launch options',exact:true}).click();
 await page.waitForFunction(()=>window.fallbackTitle==='Compare launch options');
 assert.equal(await card('b').getByRole('button',{name:'Copy task title: Compare launch options',exact:true}).evaluate(el=>el===document.activeElement),true,'clipboard fallback restores keyboard focus');
 assert.equal(commands.length,copiedBefore);
 assert.equal(await page.locator('.wq-style-options').count(),0);
 let before=count();await button('c','up').click();await waitOrder(['a','c','b','old']);assert.equal(count(),before+1);
 before=count();await hold('b','up');await waitOrder(['b','a','c','old']);await page.waitForTimeout(150);assert.equal(count(),before+1);
 before=count();await hold('c','down');await waitOrder(['c','b','a','old']);assert.equal(count(),before+1,'down hold also jumps top');
 before=count();await button('a','down').focus();await page.keyboard.press('Shift+Enter');await waitOrder(['a','c','b','old']);assert.equal(count(),before+1);
 before=count();await button('b','up').focus();await page.keyboard.press('Shift+Space');await waitOrder(['b','a','c','old']);assert.equal(count(),before+1);
 for(const kind of ['cancel','move','blur','rerender']){
  const target=button('c','up');await target.scrollIntoViewIfNeeded();before=count();
  await target.dispatchEvent('pointerdown',{pointerId:77,button:0,clientX:10,clientY:10});
  if(kind==='cancel')await target.dispatchEvent('pointercancel',{pointerId:77});
  if(kind==='move')await target.dispatchEvent('pointermove',{pointerId:77,clientX:40,clientY:10});
  if(kind==='blur')await target.dispatchEvent('blur');
  if(kind==='rerender')await page.evaluate(()=>DCCWorkingQueue.render());
  await page.waitForTimeout(620);await target.dispatchEvent('pointerup',{pointerId:77,button:0});assert.equal(count(),before,kind+' cancels hold');
 }
 assert.equal(await page.locator('#add-modal-overlay.open,.done-modal-overlay.open').count(),0,'ordering never opens details or completion');
 // Opening an itinerary task with an inferred queue anchor retains its saved notes.
 await page.locator('[data-task-view="list"]').click();
 await page.getByRole('button',{name:'Open task details: Compare launch options',exact:true}).click();
 await page.waitForFunction(()=>window._amBlockEditor?.toMarkdown().includes('Saved canonical itinerary notes'));
 await page.locator('#am-items-list').getByText('Cached current-day child',{exact:true}).waitFor();
 await page.locator('#am-items-list').getByText('Cached current-day action',{exact:true}).waitFor();
 await closeDetails();
 assert.equal((await api('/api/blocks/b')).properties._taskNotes.text,'Saved canonical itinerary notes');
 await page.locator('[data-task-view="queue"]').click();await refresh();
 // Date-scoped legacy notes: same local_id, different canonical rows and days.
 await card('old').locator('.ttl').click();await page.waitForFunction(()=>window._amBlockEditor?.toMarkdown().includes('Earlier occurrence notes'));
 assert.match(await page.locator('#am-items-list').innerText(),/Earlier occurrence child/);
 assert.match(await page.locator('#am-items-list').innerText(),/Earlier follow-up/);
 assert.doesNotMatch(await page.locator('#am-items-list').innerText(),/Current occurrence child|Current follow-up/);
 const oldChild=page.locator('#am-items-list .am-item').filter({hasText:'Earlier occurrence child'});
 await oldChild.getByRole('checkbox').click();await page.waitForFunction(async()=>{const r=await fetch('/api/blocks/old-child').then(r=>r.json());return r.properties.status==='done';});
 await page.waitForFunction(()=>document.querySelector('#am-items-list [data-id="old-child"] .am-check')?.getAttribute('aria-checked')==='true');
 await oldChild.getByRole('checkbox').click();await page.waitForFunction(async()=>{const r=await fetch('/api/blocks/old-child').then(r=>r.json());return r.properties.status!=='done';});
 await oldChild.locator('.am-del').click();await page.waitForFunction(()=>!document.querySelector('#am-items-list [data-id="old-child"]'));
 await page.locator('#am-item-type').selectOption('subtask');await page.locator('#am-item-input').fill('New origin-date child');await page.locator('#am-item-add').click();
 await page.locator('#am-items-list').getByText('New origin-date child',{exact:true}).waitFor();
 await page.locator('#am-item-type').selectOption('action');await page.locator('#am-item-input').fill('New origin-date action');await page.locator('#am-item-add').click();
 await page.locator('#am-items-list').getByText('New origin-date action',{exact:true}).waitFor();
 assert.equal((await api('/api/blocks/today-child')).properties.status,'open');
 const originRows=await api('/api/blocks/range?start='+past+'&end='+past);assert.ok(originRows.some(r=>r.properties.title==='New origin-date child'));assert.ok(originRows.some(r=>r.properties.text==='New origin-date action'));

 await closeDetails();assert.equal((await api('/api/blocks/old')).properties._taskNotes,undefined,'untouched open never saves notes');
 await button('old','complete').click();await page.getByRole('dialog').getByText('Previously recorded',{exact:true}).waitFor();
 assert.match(await page.evaluate(()=>window._dmBlockEditor.toMarkdown()),/Earlier occurrence notes/);
 assert.match(await page.locator('#dm-ai-list').innerText(),/Earlier follow-up/);assert.doesNotMatch(await page.locator('#dm-ai-list').innerText(),/Current follow-up/);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await api('/api/blocks/old')).properties.status,'open');
 await button('old','complete').click();await page.getByRole('dialog').getByText('Previously recorded',{exact:true}).waitFor();
 const editor=page.locator('#dm-notes-editor [contenteditable=true]').first();await editor.fill('Completion note retained for retry');
 let reject=true,patches=0;
 await page.route('**/api/blocks/old',route=>{if(route.request().method()==='PATCH'){patches++;if(reject)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic note conflict'})});}return route.continue();});
 const doneBefore=commands.filter(c=>c.action==='done').length;
 await page.getByRole('button',{name:'Mark Complete',exact:true}).click();await page.getByRole('status').filter({hasText:'Task completed; notes were not saved'}).waitFor();
 assert.equal((await api('/api/blocks/old')).properties.status,'done');assert.match(await editor.innerText(),/retained for retry/);
 reject=false;await page.getByRole('button',{name:'Save notes',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.done-modal-overlay.open'));
 assert.equal(commands.filter(c=>c.action==='done').length,doneBefore+1,'notes retry never repeats completion');assert.equal(patches,2);
 assert.equal((await api('/api/blocks/old')).properties._taskNotes.text,'Completion note retained for retry');
 assert.equal((await api('/api/blocks/today')).properties._taskNotes,undefined);assert.equal((await api('/api/blocks/today-note')).properties.text,'Current occurrence notes');
 // Schedule uses the same date chooser/placement picker; blocked state pauses atomically.
 await card('a').getByRole('button',{name:'Schedule',exact:true}).click();await page.locator('.resched-popover').getByText('Tomorrow',{exact:true}).click();
 await page.locator('#sched-picker-overlay.open').waitFor();await page.screenshot({path:out+'/schedule-desktop.png'});
 await page.getByRole('button',{name:'⚡ Earliest free',exact:true}).click();
 await page.waitForFunction(()=>!window.DCCWorkingQueue.getState().queue.items.some(i=>i.task.id==='a'));
 const moved=await api('/api/blocks/a');assert.notEqual(moved.date,date);assert.ok(moved.properties.start);assert.equal(moved.properties.startedAt,undefined);
 await command('start','a');await refresh();const running=(await api('/api/blocks/a')).properties.startedAt;
 await card('a').getByRole('button',{name:'Schedule',exact:true}).click();await page.getByRole('button',{name:'Blocked / Waiting…',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>window.DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='a')?.blocked===true);
 await page.waitForFunction(()=>!document.querySelector('.dcc-overlay'));
 const blocked=await api('/api/blocks/a');assert.ok(running);assert.ok(!blocked.properties.startedAt);assert.ok(blocked.properties.actualMinutes>=0);assert.notEqual(blocked.properties.status,'done');
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
 await page.waitForFunction(()=>!document.body.classList.contains('dcc-shell-scrolled'));
 await card('a').getByRole('button',{name:'Schedule',exact:true}).click();await page.getByRole('button',{name:'Unblock task',exact:true}).click();await page.waitForFunction(()=>window.DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='a')?.blocked===false);
 // Same alias on different dates cannot redirect Schedule's blocked action.
 await make('block-old','Earlier check-in',{local_id:'block-alias'},past);await command('queue-add','block-old');await command('queue-block','block-old',{remindMinutes:null});
 await make('block-current','Current check-in',{local_id:'block-alias'});await command('start','block-current');await refresh();
 await card('block-current').getByRole('button',{name:'Schedule',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Unblock task',exact:true}).count(),0);
 await page.getByRole('button',{name:'Blocked / Waiting…',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();
 await page.waitForFunction(()=>window.DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='block-current')?.blocked===true);
 assert.equal(commands.filter(c=>c.action==='queue-block').at(-1).taskId,'block-current');assert.ok(!(await api('/api/blocks/block-current')).properties.startedAt);
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.DCCWorkingQueue);await refresh();
 // Undated queue tasks use the task library's canonical date-only assignment.
 await make('undated-schedule','Undated scheduling task',{},null);await command('queue-add','undated-schedule');await refresh();
 await card('undated-schedule').getByRole('button',{name:'Schedule',exact:true}).click();
 await page.locator('.resched-popover').getByText('Tomorrow',{exact:true}).click();
 await page.waitForFunction(()=>!window.DCCWorkingQueue.getState().queue.items.some(i=>i.task.id==='undated-schedule'));
 assert.notEqual((await api('/api/blocks/undated-schedule')).date,null);
 // Direct attention drops close only this foreground timer and show Needs You.
 await make('attention-drop','Attention drop task');await command('start','attention-drop');await refresh();
 await page.dragAndDrop('[data-queue-id="attention-drop"]','.wq-needs');
 await page.waitForFunction(()=>window.DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='attention-drop')?.needsYou===true);
 assert.ok(!(await api('/api/blocks/attention-drop')).properties.startedAt);
 assert.equal(await page.locator('.wq-needs [data-queue-id="attention-drop"]').count(),1);
 assert.equal(await card('attention-drop').locator('.wq-status').innerText(),'Needs You');
 // Scheduling active work away records its timer and removes membership atomically.
 await make('schedule-active','Schedule active task',{actualMinutes:40});await command('start','schedule-active');await refresh();
 await card('schedule-active').getByRole('button',{name:'Schedule',exact:true}).click();await page.locator('.resched-popover').getByText('Tomorrow',{exact:true}).click();
 await page.locator('#sched-picker-overlay.open').waitFor();await page.getByRole('button',{name:'⚡ Earliest free',exact:true}).click();
 await page.waitForFunction(()=>!window.DCCWorkingQueue.getState().queue.items.some(i=>i.task.id==='schedule-active'));
 const scheduledActive=await api('/api/blocks/schedule-active');assert.ok(!scheduledActive.properties.startedAt);assert.ok(scheduledActive.properties.actualMinutes>=40);assert.notEqual(scheduledActive.date,date);
 for(const width of [1280,375,320]){
  await page.setViewportSize({width,height:1100});await page.evaluate(()=>window.scrollTo(0,0));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.equal(await card('b').getByRole('button',{name:'Context',exact:true}).count(),0);
  await card('b').getByText('Focused actuals unknown',{exact:true}).waitFor();
  for(const target of [button('b','complete'),button('b','up'),card('b').getByRole('button',{name:'Schedule',exact:true})]){const box=await target.boundingBox();assert.ok(box.width>=44&&box.height>=44,'44px touch target');}
  await button('b','complete').focus();await page.keyboard.press('Enter');await page.getByRole('dialog').getByText('Previously recorded',{exact:true}).waitFor();await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.done-modal-overlay.open'));
  await page.screenshot({path:out+'/queue-'+width+'.png',fullPage:true});
 }
 assert.deepEqual(errors,[]);console.log('PASS: shared details and notes, canonical occurrence isolation, note-only retry, ordering/hold/keyboard/cancellation, Schedule, block timer, mobile layouts.');
}catch(error){await page.screenshot({path:out+'/failure.png',fullPage:true});console.log(await page.locator('#working-queue-root').innerText());throw error;}finally{fs.writeFileSync(out+'/results.json',JSON.stringify({errors,commands},null,2));await browser.close();server.kill();}
