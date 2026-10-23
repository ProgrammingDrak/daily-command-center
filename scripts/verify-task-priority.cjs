/* global requestAnimationFrame, console, fetch, process, window, document, scheduled, switchToDate, schedView, __state, itineraryListModel, _orderUnscheduled, openAddModal, closeAddModal, blockStore, innerWidth, localStorage */
// Uses only scripts/ui-review-server.mjs synthetic tasks and a fresh browser profile.
const assert=require('node:assert/strict');
const {URL}=require('node:url');
const {chromium}=require('playwright-core');
const base=process.argv[2]||'http://127.0.0.1:8108';
const output=process.env.DCC_PRIORITY_SCREENSHOTS||'/tmp';
const id='review-detail-task';
(async()=>{
 const health=await(await fetch(base+'/api/health')).json();assert.equal(health.reviewOnly,true,'refuse a live server');
 const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
 try{for(const width of (process.env.DCC_PRIORITY_WIDTHS||'1440,375').split(',').map(Number)){
  assert.equal((await fetch(base+'/api/review/task-details/reset',{method:'POST'})).ok,true);
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  await context.addInitScript(()=>{window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'review-priority'};});
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.text().includes('WAL'))console.log(m.text());});
  const ready=async()=>{await page.waitForFunction(()=>window.DCCPriorityUI&&typeof scheduled!=='undefined'&&scheduled.some(t=>t.id==='review-detail-task'));};
  await page.goto(base);await ready();
  assert.equal(await page.evaluate(()=>scheduled.find(t=>t.id==='review-detail-task').taskPriority),'Medium','legacy High is inert');
  assert.equal(await page.locator('[data-view="itinerary"]').getAttribute('aria-pressed'),'true');
  const baseline=await page.evaluate(()=>scheduled.map(t=>({id:t.id,start:t.start,end:t.end})));
  const priorityWrites=[];
  page.on('request',request=>{if(request.method()==='PATCH'&&new URL(request.url()).pathname==='/api/blocks/'+id)priorityWrites.push(request.postDataJSON());});
  const persistedBefore=await(await page.request.get(base+'/api/blocks/'+id)).json();
  for(const data of [{taskPriority:'urgent'},{taskPriority:'Low',date:null}]){
   assert.equal((await page.request.patch(base+'/api/blocks/'+id,{data})).status(),400);
   assert.deepEqual(await(await page.request.get(base+'/api/blocks/'+id)).json(),persistedBefore);
  }
  await page.evaluate(()=>openAddModal('review-detail-task'));
  const choice=page.locator('#am-priority select');
  for(const value of ['Medium','Low','High']){
   console.log('Checking',width,value);await choice.selectOption(value);await page.waitForFunction(()=>document.querySelector('#am-priority [role=status]').textContent==='Saved');
   assert.deepEqual(Object.fromEntries(Object.entries(priorityWrites.at(-1)).filter(([key])=>key!=='_clientId')),{taskPriority:value},'priority sends only its field plus transport metadata, never a stale placement snapshot');
   await page.reload();await ready();
   assert.equal(await page.evaluate(()=>scheduled.find(t=>t.id==='review-detail-task').taskPriority),value);
   await page.evaluate(()=>openAddModal('review-detail-task'));assert.equal(await choice.inputValue(),value);
  }
  const persistedAfter=await(await page.request.get(base+'/api/blocks/'+id)).json();
  for(const key of ['date','sort_order','parent_id'])assert.deepEqual(persistedAfter[key],persistedBefore[key]);
  for(const key of ['start','end','duration','priority'])assert.deepEqual(persistedAfter.properties[key],persistedBefore.properties[key]);
  assert.deepEqual(await page.evaluate(()=>scheduled.map(t=>({id:t.id,start:t.start,end:t.end}))),baseline);
  // A rejected save restores both the visible selector and the cached model.
  await page.route('**/api/blocks/'+id,route=>route.request().method()==='PATCH'?route.fulfill({status:403,json:{error:'Fixture rejection'}}):route.continue());
  await choice.selectOption('Low');await page.waitForFunction(()=>document.querySelector('#am-priority [role=status]').textContent.includes('Not saved'));
  assert.equal(await choice.inputValue(),'High');assert.equal(await page.evaluate(()=>blockStore.get('review-detail-task').properties.taskPriority),'High');
  await page.unroute('**/api/blocks/'+id);
  await page.evaluate(()=>openAddModal('review-detail-task'));
  await page.screenshot({path:output+'/priority-v2-details-'+width+'.png'});
  await page.evaluate(()=>{closeAddModal();return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  const cardAction=page.locator('[data-priority-id="'+id+'"]:visible').first();
  assert.equal(await cardAction.innerText(),'↑ High');assert.match(await cardAction.getAttribute('aria-label'),/High/);
  await cardAction.focus();await page.keyboard.press('Enter');await page.waitForSelector('#task-priority-popover:popover-open');
  assert.equal(await page.locator('#task-priority-popover select').inputValue(),'High');
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#task-priority-popover').matches(':popover-open'));
  await page.waitForFunction(()=>document.activeElement.dataset.priorityId==='review-detail-task');
  // Medium is a quiet flag, Low/High include words and direction, not color alone.
  await cardAction.click();await page.locator('#task-priority-popover select').selectOption('Medium');
  await page.waitForFunction(()=>document.querySelector('#task-priority-popover [role=status]').textContent==='Saved');
  await page.locator('#task-priority-popover button').click();assert.equal(await cardAction.innerText(),'⚑');
  await cardAction.click();await page.locator('#task-priority-popover select').selectOption('Low');
  await page.waitForFunction(()=>document.querySelector('#task-priority-popover [role=status]').textContent==='Saved');
  await page.locator('#task-priority-popover button').click();assert.equal(await cardAction.innerText(),'↓ Low');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  await page.screenshot({path:output+'/priority-v2-cards-'+width+'.png',fullPage:width>760});
  await cardAction.click();await page.screenshot({path:output+'/priority-v2-picker-'+width+'.png'});
  await page.keyboard.press('Escape');
  // Offline edit is explicitly queued and survives reload/reconnect without altering placement.
  await page.evaluate(()=>openAddModal('review-detail-task'));
  await page.route('**/api/blocks/'+id,route=>route.request().method()==='PATCH'?route.abort('internetdisconnected'):route.continue());
  await choice.selectOption('High');await page.waitForFunction(()=>document.querySelector('#am-priority [role=status]').textContent.startsWith('Queued'));
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('blockstore-wal:')&&localStorage.getItem(k).includes('taskPriority'))),true);
  await page.unroute('**/api/blocks/'+id);await page.reload();await ready();
  await page.waitForFunction(()=>scheduled.find(t=>t.id==='review-detail-task').taskPriority==='High');
  assert.deepEqual(await page.evaluate(()=>scheduled.map(t=>({id:t.id,start:t.start,end:t.end}))),baseline);
  // Explicit view switching is read-only, keeps the selected day, and persists.
  // Set one other synthetic fixture Low to exercise every group alongside defaults.
  const other=await(await page.request.get(base+'/api/blocks/review-workout')).json();
  await page.request.patch(base+'/api/blocks/review-workout',{data:{properties:{...other.properties,taskPriority:'Low'}}});
  const child=await(await page.request.get(base+'/api/blocks/review-detail-step')).json();
  await page.request.patch(base+'/api/blocks/review-detail-step',{data:{properties:{...child.properties,taskPriority:'High'}}});
  await page.reload();await ready();
  await page.waitForFunction(()=>!blockStore.debug().walEntries);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const beforeViews=await page.evaluate(()=>({date:__state.date,tasks:JSON.stringify(scheduled),model:itineraryListModel().day}));
  const writes=[];const track=request=>{if(['POST','PATCH','DELETE','PUT'].includes(request.method()))writes.push({url:request.url(),body:request.postData()});};
  page.on('request',track);
  await page.locator('[data-view="list"]').click();
  assert.equal(await page.locator('[data-view="list"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(await page.locator('[data-priority-group]').evaluateAll(nodes=>nodes.map(n=>n.dataset.priorityGroup)),['High','Medium','Low']);
  const expected=await page.evaluate(()=>{const m=itineraryListModel();return window.DCC.TaskPriority.group(window.DCC.TaskModel.selectTree(m.day.timed.concat(_orderUnscheduled(m.day.unscheduled)),{pool:m.day.visible,isCollapsed:()=>false}).map(n=>n.ev)).map(g=>({priority:g.priority,ids:g.tasks.map(t=>String(t.id))}));});
  const actual=await page.locator('[data-priority-group]').evaluateAll(nodes=>nodes.map(n=>({priority:n.dataset.priorityGroup,ids:Array.from(n.querySelectorAll('.it-list-item[data-id]')).map(r=>r.dataset.id)})));
  assert.deepEqual(actual,expected,'stable group order includes scheduled and unscheduled work');
  assert.ok(await page.locator('#sched-view-toggle').evaluate(el=>el.offsetHeight<60),'compact view navigation fits one row');
  assert.equal(await page.locator('.sched-drag-hint:visible').count(),0,'no reorder hint in grouped List');
  const ids=actual.flatMap(g=>g.ids);assert.equal(new Set(ids).size,ids.length,'no duplicated tasks');
  assert.equal(await page.locator('#list-view [data-id="review-detail-step"] .btn-schedule').count(),0,'timeless subtask stays timeless');
  assert.equal(await page.locator('#list-view [data-id="review-detail-step"] .start-time').count(),0);
  assert.ok(ids.includes('review-unscheduled'));assert.ok(ids.includes('review-detail-step'),'collapsed parent does not hide child priority');
  assert.ok(!ids.includes('review-whenever'));assert.ok(!ids.includes('review-waiting'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'List fits viewport');
  await page.screenshot({path:output+'/priority-v2-list-'+width+'.png',fullPage:width>760});
  await page.locator('[data-view="itinerary"]').click();
  assert.equal(await page.locator('[data-priority-group]').count(),0);
  assert.deepEqual(await page.evaluate(()=>({date:__state.date,tasks:JSON.stringify(scheduled)})),{date:beforeViews.date,tasks:beforeViews.tasks});
  assert.deepEqual(writes,[],'switching views sends no mutations');page.off('request',track);
  await page.screenshot({path:output+'/priority-v2-itinerary-'+width+'.png',fullPage:width>760});
  await page.locator('[data-view="list"]').click();await page.reload();await ready();
  assert.equal(await page.evaluate(()=>schedView),'list');
  assert.equal(await page.locator('[data-view="list"]').getAttribute('aria-pressed'),'true');
  // Priority changes regroup immediately, including keyboard focus after rerender.
  const listAction=page.locator('#list-view [data-priority-id="'+id+'"]');
  await listAction.click();await page.locator('#task-priority-popover select').selectOption('Low');
  await page.waitForFunction(()=>document.querySelector('#task-priority-popover [role=status]').textContent==='Saved');
  assert.equal(await listAction.evaluate(el=>el.closest('[data-priority-group]').dataset.priorityGroup),'Low');
  await page.locator('#task-priority-popover button').click();
  await page.waitForFunction(()=>document.activeElement.dataset.priorityId==='review-detail-task');
  assert.deepEqual(await page.evaluate(()=>scheduled.map(t=>({id:t.id,start:t.start,end:t.end}))),baseline);
  assert.equal(await page.locator('#list-view [data-id="review-detail-step"]').evaluate(el=>el.closest('[data-priority-group]').dataset.priorityGroup),'High','child priority is independent of its parent');
  // Failed saves restore the group and count, not just the value in the picker.
  await listAction.click();
  await page.route('**/api/blocks/'+id,route=>route.request().method()==='PATCH'?route.fulfill({status:403,json:{error:'Fixture rejection'}}):route.continue());
  await page.locator('#task-priority-popover select').selectOption('High');
  await page.waitForFunction(()=>document.querySelector('#task-priority-popover [role=status]').textContent.includes('Not saved'));
  assert.equal(await listAction.evaluate(el=>el.closest('[data-priority-group]').dataset.priorityGroup),'Low');
  assert.equal(await page.locator('#list-view [data-id="'+id+'"]').count(),1);
  await page.unroute('**/api/blocks/'+id);await page.locator('#task-priority-popover button').click();
  // A queued save rejected on reconnect also returns to the durable group.
  await listAction.click();
  await page.route('**/api/blocks/'+id,route=>route.request().method()==='PATCH'?route.abort('internetdisconnected'):route.continue());
  await page.locator('#task-priority-popover select').selectOption('High');
  await page.waitForFunction(()=>document.querySelector('#task-priority-popover [role=status]').textContent.startsWith('Queued'));
  assert.equal(await listAction.evaluate(el=>el.closest('[data-priority-group]').dataset.priorityGroup),'High');
  await page.unroute('**/api/blocks/'+id);
  await page.route('**/api/blocks/'+id,route=>route.request().method()==='PATCH'?route.fulfill({status:403,json:{error:'Fixture rejection'}}):route.continue());
  await page.reload();await ready();await page.waitForFunction(()=>blockStore.debug().walEntries===0);
  await page.waitForFunction(()=>document.querySelector('#list-view [data-priority-id="review-detail-task"]')?.closest('[data-priority-group]').dataset.priorityGroup==='Low');
  await page.unroute('**/api/blocks/'+id);
  // Selected date and view remain independent; no today's tasks leak into tomorrow.
  const tomorrow=await page.evaluate(()=>{const d=new Date(__state.date+'T12:00:00');d.setDate(d.getDate()+1);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');});
  await page.request.post(base+'/api/blocks',{data:{id:'review-priority-tomorrow',type:'block',date:tomorrow,properties:{local_id:'review-priority-tomorrow',title:'Tomorrow fixture',type:'task',start:'09:00',end:'09:30',taskPriority:'Low'}}});
  await page.evaluate(date=>switchToDate(date),tomorrow);
  await page.waitForFunction(date=>__state.date===date&&scheduled.some(t=>t.id==='review-priority-tomorrow'),tomorrow);
  assert.equal(await page.evaluate(()=>schedView),'list');
  assert.equal(await page.locator('#list-view [data-id="review-detail-task"]').count(),0);
  const futureBefore=await page.evaluate(()=>JSON.stringify(scheduled));
  await page.locator('[data-view="itinerary"]').click();await page.locator('[data-view="list"]').click();
  assert.equal(await page.evaluate(()=>__state.date),tomorrow);assert.equal(await page.evaluate(()=>JSON.stringify(scheduled)),futureBefore);
  await page.evaluate(date=>switchToDate(date),beforeViews.date);await ready();
  assert.equal(await page.evaluate(()=>schedView),'list');
  await page.locator('[data-view="calendar"]').click();await page.reload();await ready();
  assert.equal(await page.evaluate(()=>schedView),'calendar');await page.waitForSelector('#calendar-view .iwc-week-scroll');
  await page.locator('[data-view="actual"]').click();await page.reload();await ready();
  assert.equal(await page.evaluate(()=>schedView),'actual');await page.waitForFunction(()=>document.getElementById('actual-view').children.length>0);
  await page.locator('[data-view="list"]').click();
  assert.deepEqual(errors,[]);console.log('PASS '+width+'px: priorities/reload/rollback/offline/keyboard/layout; both views, stable groups, scoped tasks, read-only switching, date navigation and persisted selection');
  await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
