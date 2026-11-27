// Instant-action regression (docs/instant-interactions.md): with every queue
// save held for 2 s, each one-tap action must change the screen within 100 ms,
// refused saves must undo only themselves, and pending changes must survive a
// reload or going offline. Isolated synthetic account; never touches user data.
//   DCC_TEST_DATABASE_URL=postgres://…localhost…/scratch node scripts/verify-queue-instant.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
/* global window, document, performance, localStorage, Event, DCCWorkingQueue */
const port=process.env.QUEUE_INSTANT_PORT||'8194',base='http://127.0.0.1:'+port;
const BUDGET_MS=100,SAVE_DELAY_MS=2000;
const server=spawn(process.execPath,['scripts/ui-review-server.mjs'],{env:{...process.env,PORT:port,DCC_WORKING_QUEUE_REVIEW:'1'},stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.once('error',reject);server.once('exit',code=>reject(new Error('Preview exited '+code)));server.stdout.on('data',b=>{if(String(b).includes('UI review server:'))resolve();});});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:1280,height:1100},reducedMotion:'reduce'});
const page=await context.newPage(),errors=[],timings={};
page.on('pageerror',e=>errors.push(e.message));
const out=process.env.DCC_QA_OUTPUT||'/tmp/dcc-queue-instant';fs.mkdirSync(out,{recursive:true});
const date=new Date().toISOString().slice(0,10);
const api=async(path,data)=>{const r=data?await page.request.post(base+path,{data}):await page.request.get(base+path);assert.ok(r.ok(),await r.text());return r.json();};
const make=(id,title,p={})=>api('/api/blocks',{id,type:'block',date,properties:{local_id:id,title,type:'task',duration:30,status:'open',...p}});
const command=async(action,taskId,extra={})=>{const state=await api('/api/working-queue');return api('/api/working-queue',{action,taskId,...extra,expectedRevision:state.revision,sourceEventId:crypto.randomUUID(),at:new Date().toISOString()});};
const card=id=>page.locator('[data-queue-id="'+id+'"]');
const order=()=>page.locator('.wq-next [data-queue-id]').evaluateAll(els=>els.map(el=>el.dataset.queueId));
const serverItem=async id=>(await api('/api/working-queue')).queue.items.find(i=>i.task.id===id);
const intentsLeft=()=>page.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes(':intent:')).length);
const settled=()=>page.waitForFunction(()=>!Object.keys(localStorage).some(k=>k.includes(':intent:')),null,{timeout:20000});
// Hold every queue save; `reject` lets one chosen command be refused by "the server".
let reject=null;
await page.route('**/api/working-queue',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  const body=route.request().postDataJSON();
  try{
    await new Promise(r=>setTimeout(r,SAVE_DELAY_MS));
    if(reject&&reject(body)){reject=null;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic refusal for '+body.action})});}
    return await route.continue();
  }catch{/* page reloaded mid-save */}
});
// Time from the tap to the first frame where `cond` holds, measured in the page.
// A hold is timed from the release, since the hold itself is the gesture.
async function timed(name,tap,cond,arg,{fromRelease=false}={}){
  await page.evaluate(start=>{window.__t0=null;window.__t1=null;document.addEventListener(start,()=>{window.__t0??=performance.now();},{capture:true,once:true});document.addEventListener('click',()=>{window.__t0??=performance.now();},{capture:true,once:true});},fromRelease?'pointerup':'pointerdown');
  await tap();
  await page.waitForFunction(([src,a])=>{const ok=new Function('a','return ('+src+')(a)')(a);if(ok&&window.__t1==null)window.__t1=performance.now();return ok;},[cond.toString(),arg],{polling:'raf',timeout:5000});
  const ms=await page.evaluate(()=>window.__t1-window.__t0);
  timings[name]=Math.round(ms*10)/10;
  assert.ok(ms<BUDGET_MS,name+' took '+ms.toFixed(1)+'ms (budget '+BUDGET_MS+'ms)');
  assert.ok(await intentsLeft()>0,name+' appeared while its save was still pending');
}
const tile=async id=>{const c=card(id);if(await c.evaluate(el=>el.classList.contains('wq-row')))await c.locator('[data-queue-action="expand"]').click();await page.locator('[data-queue-id="'+id+'"].wq-tile').waitFor();return c;};
async function hold(locator){const b=await locator.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.waitForTimeout(620);await page.mouse.up();}
try{
  await api('/api/queue-review/reset',{});
  for(const [id,title] of [['a','Alpha task'],['b','Bravo task'],['c','Charlie task'],['d','Delta task']]){await make(id,title);await command('queue-add',id);}
  await command('queue-snooze','d',{remindMinutes:30});
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.DCCWorkingQueue);await page.evaluate(()=>DCCWorkingQueue.refresh());
  await page.locator('[data-task-view="queue"]').click().catch(()=>{});
  assert.deepEqual(await order(),['a','b','c']);

  // 1. Priority: row tap cycles instantly.
  const level=()=>card('a').locator('[data-queue-action="priority"]').getAttribute('data-priority-level');
  const before=await level();
  await timed('priority',()=>card('a').locator('[data-queue-action="priority"]').click(),a=>document.querySelector('[data-queue-id="a"] [data-queue-action="priority"]')?.dataset.priorityLevel!==a,before);
  await settled();assert.equal((await serverItem('a')).taskPriority,'High','priority saved');
  // Put a back to Medium (via the picker path is a dialog; reuse the API).
  await page.evaluate(()=>DCCWorkingQueue.refresh());

  // 2. Reorder: Up on an opened tile, then two quick Ups (double tap), then hold-to-top.
  await command('queue-priority','a',{taskPriority:'Medium'});await page.evaluate(()=>DCCWorkingQueue.refresh());
  await page.waitForFunction(()=>[...document.querySelectorAll('.wq-next [data-queue-id]')].map(e=>e.dataset.queueId).join()==='a,b,c');
  await tile('c');
  await timed('move up',()=>card('c').locator('[data-queue-action="up"]').click(),()=>[...document.querySelectorAll('.wq-next [data-queue-id]')].map(e=>e.dataset.queueId).join()==='a,c,b');
  await card('c').locator('[data-queue-action="up"]').click();
  assert.deepEqual(await order(),['c','a','b'],'second quick tap applies on top of the first');
  assert.ok(await intentsLeft()>=1,'both taps are queued, not refused');
  await settled();
  assert.deepEqual((await api('/api/working-queue')).queue.priorityOrder||await order(),['c','a','b']);
  await tile('b');
  await timed('hold to top',()=>hold(card('b').locator('[data-queue-action="up"]')),()=>document.querySelector('.wq-next [data-queue-id]')?.dataset.queueId==='b',undefined,{fromRelease:true});
  await settled();
  assert.deepEqual(await order(),['b','c','a']);

  // 3. Bring forward with nothing in Foreground: no dialog, no wait.
  await timed('bring forward',()=>card('a').locator('[data-queue-action="focus"]').first().click(),()=>!!document.querySelector('.wq-foreground [data-queue-id="a"].wq-focus'));
  assert.equal(await page.getByRole('dialog').count(),0);
  await settled();assert.equal((await serverItem('a')).status,'foreground');
  // 4. Pause and resume.
  await timed('pause',()=>card('a').locator('.wq-bar [data-queue-action="pause"]').click(),()=>!!document.querySelector('[data-queue-id="a"] .wq-break-veil'));
  await settled();assert.equal((await serverItem('a')).onBreak,true);
  await timed('resume',()=>card('a').locator('.wq-break-veil [data-queue-action="focus"]').click(),()=>!document.querySelector('[data-queue-id="a"] .wq-break-veil')&&!!document.querySelector('[data-queue-id="a"].wq-focus'));
  await settled();assert.equal((await serverItem('a')).onBreak,false);
  // 5. Drag Foreground to Needs You.
  await timed('drag to Needs You',()=>page.dragAndDrop('[data-queue-id="a"]','.wq-needs'),()=>!!document.querySelector('.wq-needs [data-queue-id="a"]'));
  await settled();assert.equal((await serverItem('a')).needsYou,true);
  // 6. Dismiss the snoozed reminder on d (Background → Priority).
  await tile('d');
  await timed('dismiss reminder',()=>card('d').locator('[data-queue-action="dismiss"]').click(),()=>!!document.querySelector('.wq-next [data-queue-id="d"]'));
  await settled();assert.equal((await serverItem('d')).snoozed,false);

  // 7. Refused save: undo only that change; a change made right after it stays.
  const cBefore=await card('c').locator('[data-queue-action="priority"]').getAttribute('data-priority-level');
  reject=body=>body.action==='queue-priority'&&body.taskId==='c';
  await card('c').locator('[data-queue-action="priority"]').click();
  assert.notEqual(await card('c').locator('[data-queue-action="priority"]').getAttribute('data-priority-level'),cBefore,'shown at once');
  const orderBefore=await order();
  await tile('b');await card('b').locator('[data-queue-action="down"]').click();
  const moved=await order();assert.notDeepEqual(moved,orderBefore,'second change shown at once');
  await page.getByText('Priority change was not saved',{exact:false}).waitFor({timeout:10000});
  await settled();
  assert.equal(await card('c').locator('[data-queue-action="priority"]').getAttribute('data-priority-level'),cBefore,'refused change undone');
  assert.deepEqual(await order(),moved,'the later change is kept');
  assert.equal((await serverItem('c')).taskPriority,'Medium');

  // 8. Reload while a save is pending: the change stays visible and still saves.
  await card('d').locator('[data-queue-action="priority"]').click();
  const dShown=await card('d').locator('[data-queue-action="priority"]').getAttribute('data-priority-level');
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.DCCWorkingQueue);
  await card('d').waitFor();
  assert.equal(await card('d').locator('[data-queue-action="priority"]').getAttribute('data-priority-level'),dShown,'pending change survives reload');
  await settled();assert.equal((await serverItem('d')).taskPriority,'High','pending change saved after reload');

  // 9. Offline: change is kept on this device, then syncs when back online.
  await context.setOffline(true);
  await card('b').locator('[data-queue-action="priority"]').click();
  await page.getByText('Queue changes are saved on this device. Waiting to sync.',{exact:true}).waitFor({timeout:15000});
  assert.equal(await intentsLeft(),1);
  await context.setOffline(false);
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await settled();assert.equal((await serverItem('b')).taskPriority,'High');

  await page.screenshot({path:out+'/queue-instant.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,budgetMs:BUDGET_MS,saveDelayMs:SAVE_DELAY_MS,timingsMs:timings,checks:['priority','move up','double tap','hold to top','bring forward (no dialog)','pause','resume','drag to Needs You','dismiss reminder','refused change undone narrowly','reload mid-save','offline then sync']}));
}catch(error){await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});console.log('timings so far',JSON.stringify(timings));throw error;}
finally{await browser.close();server.kill();}
