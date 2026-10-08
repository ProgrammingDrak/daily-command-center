// Run against the database-free DCC review fixture, never a live workspace.
/* global window */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
const base=process.argv[2]||'http://127.0.0.1:8108';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
assert.equal((await fetch(base+'/api/health').then(r=>r.json())).reviewOnly,true);
const out=process.env.DCC_QA_OUTPUT||'test-results/undated-scheduling';fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
for(const width of [1280,375]){
 const context=await browser.newContext({viewport:{width,height:900},timezoneId:'America/Los_Angeles'});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 // UTC and Eastern already read Oct 8; the user's PDT day is still Oct 7.
 await page.clock.setFixedTime(new Date('2026-10-08T05:30:00Z'));
 await page.goto(base);
 await page.waitForFunction(()=>!!window.DCCTaskLibrary);
 const keys=await page.evaluate(()=>{const date=new Date();const key=()=>[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');const today=key();date.setDate(date.getDate()+1);return [today,key()];});
 assert.deepEqual(keys,['2026-10-07','2026-10-08']);
 for(const [index,selection] of ['today','tomorrow','custom'].entries()){
  const id='qa-undated-'+Date.now()+'-'+width+'-'+index,child=id+'-child';
  for(const [blockId,props,parent] of [
   [id,{kind:'backlog',local_id:id,title:'Synthetic date-only '+selection+' '+width,type:'task',duration:30,detail:'Fixture notes must survive',source:'manual'},null],
   [child,{kind:'backlog',local_id:child,title:'Synthetic child',type:'task',duration:0,subtaskOf:id,detail:'Child notes'},id],
  ])await page.request.post(base+'/api/blocks',{data:{id:blockId,type:'block',date:null,parent_id:parent,properties:props}});
  await page.evaluate(()=>window.DCCTaskLibrary.open());await page.evaluate(()=>window.DCCTaskLibrary.refresh());
  await page.locator('[data-schedule-task="'+id+'"]').click();
  const request=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/blocks/'+id+'/reschedule'));
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/blocks/'+id+'/reschedule'));
  if(selection==='custom'){
   await page.locator('.resched-custom .tw-field-date').click();await page.locator('.tw-cal-day').filter({hasText:/^15$/}).click();
  }else{
   const button=page.locator('.resched-btn[data-target="'+selection+'"]');
   if(selection==='tomorrow'){await button.waitFor({state:'visible'});await button.press('Enter');}else await button.click();
  }
  const selected=selection==='custom'?'2026-10-15':keys[selection==='today'?0:1];
  const sent=(await request).postDataJSON();
  assert.equal(sent.targetDate,selected);assert.deepEqual(sent.placement,{kind:'pool_date'});
  assert.equal(sent.fromDate,undefined);assert.equal(sent.parentStart,undefined);assert.equal(sent.parentEnd,undefined);
  const reply=await response;assert.equal(reply.status(),200);const result=await reply.json();
  assert.deepEqual(new Set(result.moved),new Set([id,child]));assert.deepEqual(result.created,[]);
  const rows=await page.request.get(base+'/api/blocks').then(r=>r.json());
  const root=rows.find(row=>row.id===id),kid=rows.find(row=>row.id===child);
  assert.equal(root.date,selected);assert.equal(root.properties.detail,'Fixture notes must survive');assert.equal(root.properties.start,null);assert.equal(root.properties.end,null);
  assert.equal(kid.date,selected);assert.equal(kid.properties.duration,0);assert.equal(kid.properties.subtaskOf,id);
  assert.equal(rows.filter(row=>row.properties.local_id===id).length,1);
  await page.reload();await page.waitForFunction(()=>!!window.DCCTaskLibrary);
  await page.evaluate(()=>window.DCCTaskLibrary.open());await page.evaluate(()=>window.DCCTaskLibrary.refresh());
  await page.locator('[data-schedule-task="'+id+'"]').first().waitFor();
  assert.equal(await page.locator('tr').filter({has:page.locator('[data-schedule-task="'+id+'"]')}).locator('.tlb-date-btn').innerText(),await page.evaluate(value=>new Date(value+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}),selected));
  if(selection==='tomorrow'){await page.locator('tr').filter({has:page.locator('[data-schedule-task="'+id+'"]')}).locator('.tlb-date-btn').scrollIntoViewIfNeeded();await page.screenshot({path:out+'/task-library-tomorrow-'+width+'.png'});}
  console.log('PASS '+width+' '+selection+' -> '+selected+'; same IDs/notes/subtree, no time/source date, survives reload');
 }
 assert.deepEqual(errors,[]);await context.close();
}
}finally{await browser.close();}
