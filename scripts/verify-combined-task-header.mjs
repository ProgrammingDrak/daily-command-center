/* global window, document, DCCWorkingQueue, innerWidth */
// Real queue snapshots from an isolated DB, rendered with the full app header.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';
const require=createRequire(import.meta.url),base=process.env.DCC_PROGRESS_REVIEW_URL||'http://127.0.0.1:18781';
assert.match(base,/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
assert.equal((await fetch(base+'/api/health').then(r=>r.json())).reviewOnly,true);
const date=(await fetch(base+'/api/state/day').then(r=>r.json())).date;
assert.equal((await fetch(base+'/api/review/actual/seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({today:date})})).ok,true);
const next=new Date(date+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);const tomorrow=next.toISOString().slice(0,10);
const out=process.env.DCC_COMBINED_REVIEW_OUT||'test-results/combined-task-header';await fs.mkdir(out,{recursive:true});
const ctx=await require('../test-support/activity-db').createActivityDb();
Object.assign(ctx,{APP_TIME_ZONE:'UTC'});process.env.DCC_CONVERSATION_ENABLED='true';
await ctx.pool.query(require('../conversation-store').FOREGROUND_INDEX_SQL);
await ctx.blockDB.createBlock({id:'combined-focus',type:'block',date,user_id:1,workspace_id:'ws-1',properties:{type:'task',title:'Plan Japan airport transfers and intercity travel',status:'open',actualMinutes:83,duration:30}});
const store=require('../conversation-store').createConversationStore(ctx),owner={userId:1,workspaceId:'ws-1'};
const execute=async(action,at)=>store.execute({action,taskId:'combined-focus',at:new Date(at).toISOString(),sourceEventId:ctx.crypto.randomUUID(),expectedRevision:(await store.state(owner)).revision},owner);
const active=(await execute('start',Date.now()-120000)).state;
const paused=(await execute('pause',Date.now())).state;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const measurements=[];
try{
 for(const width of [1440,835,435,375,358,320]){
  const context=await browser.newContext({viewport:{width,height:1100},timezoneId:'UTC'});
  await context.addInitScript(()=>{window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'ws-1'};});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await context.route('**/api/state/tomorrow',route=>route.fulfill({json:{date:tomorrow,schedule:{timeline:[]}}}));
  let snapshot=active;
  await context.route('**/api/working-queue',route=>route.fulfill({json:snapshot}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?tab=tasks&view=queue');await page.waitForSelector('[data-queue-id="combined-focus"]');
  await page.waitForFunction(()=>!!document.querySelector('#ptrack').dataset.date);
  await page.waitForSelector('#ptrack button');await page.waitForSelector('#pactual button');
  await page.evaluate(()=>document.fonts.ready);
  const card=page.locator('[data-queue-id="combined-focus"]'),before=await card.boundingBox();
  snapshot=paused;await page.evaluate(()=>DCCWorkingQueue.refresh());await card.locator('.wq-break-veil').waitFor();
  const m=await page.evaluate(()=>{
   const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
   const card=document.querySelector('[data-queue-id="combined-focus"]'),veil=card.querySelector('.wq-break-veil');
   const header=document.querySelector('.progress-header'),date=document.querySelector('#date-nav'),plan=document.querySelector('#ptrack'),actual=document.querySelector('#pactual');
   const h=rect(header),d=rect(date),p=rect(plan),a=rect(actual);
   return{card:rect(card),veil:rect(veil),head:rect(document.querySelector('#task-workspace-head')),header:h,date:d,plan:p,actual:a,gap:a.y-p.bottom,dateCentered:Math.abs((d.x+d.right-h.x-h.right)/2)<1,progressReady:plan.dataset.date,tally:document.querySelector('#ppct').textContent,overflow:document.documentElement.scrollWidth>innerWidth};
  });
  assert.equal(m.overflow,false);assert.equal(m.dateCentered,true);assert.equal(m.gap,20);
  assert.equal(m.plan.height,width<=760?14:18);assert.equal(m.actual.height,m.plan.height);
  assert.doesNotMatch(m.tally,/Loading|Unavailable|--/);assert.ok(m.progressReady);
  assert.ok(Math.abs(m.card.height-before.height)<=2,'full app pause preserves card height');
  for(const edge of ['x','y','right','bottom'])assert.ok(Math.abs(m.card[edge]-m.veil[edge])<=1.1,'full app frost matches edge '+edge);
  assert.ok(m.head.bottom<=m.card.y,'header and card do not overlap');
  await page.screenshot({path:out+'/combined-'+width+'.png',clip:{x:0,y:Math.max(0,m.head.y-8),width,height:m.card.bottom-Math.max(0,m.head.y-8)+12}});
  measurements.push({width,beforeHeight:before.height,...m});assert.deepEqual(errors,[]);await context.close();
 }
 await fs.writeFile(out+'/measurements.json',JSON.stringify(measurements,null,2));
 console.log(JSON.stringify({passed:true,viewports:measurements.map(m=>m.width),checks:['full production header and queue together','canonical active and paused snapshots','centered date','both rails aligned','no loading placeholders after ready','no header/card overlap','card-sized frost','unchanged card height','no mobile overflow'],out}));
}finally{await browser.close();await ctx.close();}
