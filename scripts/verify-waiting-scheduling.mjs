/* global window */
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const base=process.argv[2]||'http://127.0.0.1:8355';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname));
assert.equal((await(await fetch(base+'/api/health')).json()).reviewOnly,true);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
for(const width of [1280,390,320])for(const mode of ['follow-up-complete','unlinked','existing','loose-ends']){
 const ids=await(await fetch(base+'/api/review/waiting/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({followUpComplete:mode==='follow-up-complete'||mode==='unlinked',unlinked:mode==='unlinked',existing:mode==='existing'})})).json();
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
 const read=async()=> (await(await page.request.get(base+'/api/review/waiting/state')).json());
 await page.goto(base);await page.waitForFunction(()=>window.DCC?.Waiting?.all().length>0);
 const before=await read();
 if(mode==='loose-ends'){
  await page.locator('#loose-ends-pill').click();await page.locator('.cu-waiting-row .ttl').first().click();await page.locator('.cu-wait-schedule').first().click();
 }else{
  await page.locator('#waiting-pill-nav').click();
  const card=page.locator('#delegated-blocked-list .delegated-card[data-id="'+ids.item+'"]');
  if(mode==='follow-up-complete'||mode==='unlinked')await card.getByText('Follow-up complete',{exact:true}).waitFor();
  await card.locator('[data-delegated-action="schedule"]').click();
 }
 const response=page.waitForResponse(r=>r.url().endsWith('/check-ins/schedule')&&r.request().method()==='POST');
 await page.locator('.resched-popover [data-target="tomorrow"]').click();
 const res=await response;assert.equal(res.status(),200,await res.text());
 const saved=await read(),item=saved.rows[1].properties,scheduled=saved.allRows.find(r=>r.id===item.checkInTaskId);
 assert.ok(scheduled);assert.equal(scheduled.date.slice(0,10),new Date(Date.parse(ids.date+'T12:00:00Z')+86400000).toISOString().slice(0,10));assert.equal(scheduled.date.slice(0,10),item.checkInDate);assert.equal(item.checkInScheduledFor,item.checkInDate);
 assert.equal(scheduled.properties.delegatedItemId,ids.item);assert.notEqual(scheduled.properties.completed,true);assert.ok(scheduled.properties.start&&scheduled.properties.end);
 assert.equal(item.status,'open');assert.deepEqual(saved.rows[0],before.rows[0]);assert.deepEqual(item.checkInHistory,before.rows[1].properties.checkInHistory);
 if(mode==='existing')assert.equal(scheduled.id,ids.reminder,'rescheduling retains existing reminder identity');
 await page.reload();await page.waitForFunction(()=>window.DCC?.Waiting?.all().length>0);
 const reloaded=await read();assert.equal(reloaded.rows[1].properties.checkInTaskId,scheduled.id);assert.deepEqual(reloaded.allRows.find(r=>r.id===scheduled.id),scheduled);
 // Retry the same date after reload: no duplicate reminder or history entry.
 const ok=await page.evaluate(({id,date})=>window.DCC.Waiting.scheduleCheckIn(id,null,null,date),{id:ids.item,date:scheduled.date.slice(0,10)});assert.equal(ok,true);
 const retried=await read();assert.equal(retried.rows[1].properties.checkInTaskId,scheduled.id);assert.equal(retried.allRows.length,reloaded.allRows.length);assert.deepEqual(retried.rows[1].properties.checkInHistory,reloaded.rows[1].properties.checkInHistory);
 await page.reload();await page.waitForFunction(()=>window.DCC?.Waiting?.all().length>0);
 const later=new Date(Date.parse(ids.date+'T12:00:00Z')+2*86400000).toISOString().slice(0,10);
 assert.equal(await page.evaluate(({id,date})=>window.DCC.Waiting.scheduleCheckIn(id,null,null,date),{id:ids.item,date:later}),true);
 const moved=await read();assert.equal(moved.rows[1].properties.checkInTaskId,scheduled.id,'cross-day reschedule after reload retains identity');assert.equal(moved.allRows.find(r=>r.id===scheduled.id).date.slice(0,10),later);assert.equal(moved.allRows.filter(r=>r.properties.source==='waiting-checkin').length,retried.allRows.filter(r=>r.properties.source==='waiting-checkin').length);
 console.log('PASS '+mode+' '+width+': request, placement, identity, reload, retry, original task/history preserved');await page.close();
}
}finally{await browser.close();}
