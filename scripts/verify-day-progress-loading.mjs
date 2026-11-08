/* global window, document, viewDate, switchToDate, scheduled, render, requestAnimationFrame, buildProgress, getComputedStyle */
// Disposable fixture server only: exercise core-data readiness independently of
// Working Queue and unrelated comment/reaction fetches. No user data is written.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {measureQueueCapsule} from './queue-capsule-smoke.mjs';
const base=process.env.DCC_PROGRESS_REVIEW_URL||'http://127.0.0.1:18781';
assert.match(base,/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
assert.equal((await fetch(base+'/api/health').then(r=>r.json())).reviewOnly,true);
const fixtureToday=(await fetch(base+'/api/state/day').then(r=>r.json())).date;
const nextDay=new Date(fixtureToday+'T12:00:00Z');nextDay.setUTCDate(nextDay.getUTCDate()+1);
const fixtureTomorrow=nextDay.toISOString().slice(0,10);
const out=process.env.DCC_PROGRESS_REVIEW_OUT||'test-results/day-progress-loading';
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results=[];
const frames=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
try {
 for(const mode of ['pending','failed','forbidden','normal']) {
  const context=await browser.newContext({viewport:{width:835,height:1000},timezoneId:'UTC'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.__dayReady=false;window.addEventListener('dcc:day-data-ready',()=>window.__dayReady=true);});
  let release;const gate=new Promise(r=>release=r);
  await page.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(mode==='pending'&&!['/api/working-queue','/api/auth/me','/api/health','/api/me'].includes(path))await gate;
   if(['failed','forbidden'].includes(mode)&&path==='/api/state/day')return route.fulfill({status:mode==='forbidden'?403:503,json:{error:'Synthetic unavailable'}});
   if(mode==='normal'&&path==='/api/state/tomorrow')return route.fulfill({json:{date:fixtureTomorrow,schedule:{timeline:[]}}});
   return route.continue();
  });
  await page.goto(base+'/?tab=tasks&view=queue');
  await page.waitForSelector('#working-queue-root h1');
  await page.locator('#day-progress-title').click();
  const measure=()=>({date:typeof viewDate!=='undefined'?viewDate:null,axisDate:document.querySelector('#ptrack').dataset.date,tally:document.querySelector('#ppct').textContent,start:document.querySelector('#pstart').textContent,gap:document.querySelector('#pactual').getBoundingClientRect().top-document.querySelector('#ptrack').getBoundingClientRect().bottom,busy:document.querySelector('#ptrack').getAttribute('aria-busy'),reviewDisabled:document.querySelector('#progress-day-review').disabled,note:document.querySelector('#pactual-note').textContent});
  if(mode==='pending') {
   await frames(page);const m=await page.evaluate(measure);results.push({mode,...m});
   assert.equal(m.tally,'Loading…');assert.equal(m.start,'');assert.equal(m.busy,'true');assert.equal(m.reviewDisabled,true);assert.equal(m.gap,20);
   await page.screenshot({path:out+'/loading-queue.png'});release();
  }
  await page.waitForFunction(()=>window.__dayReady);await frames(page);
  const ready=await page.evaluate(measure);results.push({mode:mode+'-ready',...ready});
  assert.equal(ready.busy,'false');
  if(['failed','forbidden'].includes(mode)) {
   assert.equal(ready.tally,'Unavailable');assert.equal(ready.start,'');assert.equal(ready.reviewDisabled,true);assert.match(ready.note,/unavailable/);
   await page.screenshot({path:out+'/unavailable-queue.png'});
  } else {
   assert.equal(ready.axisDate,ready.date);assert.equal(ready.reviewDisabled,false);assert.doesNotMatch(ready.tally,/Loading|Unavailable|--/);
  }
  if(mode==='normal') {
   // A populated day must be cleared when the next block snapshot fails,
   // then recover through the same date lifecycle without a reload.
   await page.evaluate(()=>{scheduled.push({id:'loaded-progress',title:'Loaded fixture task',type:'task',start:'08:00',end:'08:30'});buildProgress();});
   assert.ok(await page.locator('#ptrack button').count()>0);
   await page.evaluate(async()=>{const original=window.blockStore.loadDay;window.blockStore.loadDay=async()=>{throw new Error('Synthetic block failure');};try{await switchToDate('2026-01-03');}finally{window.blockStore.loadDay=original;}});
   assert.equal(await page.locator('#ptrack button, #pactual button').count(),0);
   assert.equal(await page.locator('#ptrack').getAttribute('data-date'),null);
   assert.equal(await page.locator('#ppct').innerText(),'Unavailable');
   assert.equal(await page.locator('#progress-day-review').isDisabled(),true);
   // Suppress incidental comment/reaction renders while allowing core date data.
   await page.route('**/api/todo-share/**',r=>r.fulfill({json:{comments:[],reactions:[]}}));
   await page.evaluate(()=>switchToDate('2026-01-04'));await frames(page);
   assert.equal(await page.locator('#ptrack').getAttribute('data-date'),'2026-01-04');
   assert.match(await page.locator('#pactual-note').innerText(),/No timed activity/);
   await page.evaluate(()=>{scheduled.push({id:'progress-test',title:'Fixture schedule edit',type:'task',start:'06:00',end:'06:30'});render('schedule');});
   await frames(page);assert.equal(await page.locator('#ptrack').getAttribute('data-start-min'),'360');
   // Repeated view changes preserve date, focus and shared progress.
   for(const view of ['list','calendar','queue']) {await page.locator('#task-view-'+view).click();assert.equal(await page.locator('#ptrack').getAttribute('data-date'),'2026-01-04');}
   await page.locator('#dn-date-btn').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#date-picker-drop').isVisible(),true);
   await page.locator('#dn-date-btn').click();assert.equal(await page.locator('#date-picker-drop').isVisible(),false);
   await page.waitForSelector('#dn-tomorrow-btn',{state:'visible'});
   for(const width of [1440,835,760,375,320]) {
    await page.setViewportSize({width,height:1000});await frames(page);
    const capsule=await page.evaluate(measureQueueCapsule,999);
    assert.ok(Object.values(capsule).every(Boolean),JSON.stringify({width,capsule}));
    const layout=await page.evaluate(()=>{
     const rect=id=>document.querySelector(id).getBoundingClientRect(),date=rect('#date-nav'),header=rect('.progress-label'),plan=rect('#ptrack'),actual=rect('#pactual'),pill=rect('#queue-pill'),sw=rect('#task-view-switch');
     const dateTargets=[...document.querySelectorAll('#date-nav button')].filter(b=>getComputedStyle(b).display!=='none').map(b=>({box:b.getBoundingClientRect(),width:b.clientWidth,scroll:b.scrollWidth}));
     const targetsFit=dateTargets.every(({box,width,scroll})=>box.left>=header.left&&box.right<=header.right+1&&scroll<=width+1&&box.height>=24);
     const targetsSeparate=dateTargets.every((a,i)=>dateTargets.slice(i+1).every(b=>a.box.right<=b.box.left+1||b.box.right<=a.box.left+1||a.box.bottom<=b.box.top+1||b.box.bottom<=a.box.top+1));
     return {targetsFit,targetsSeparate,overflow:document.documentElement.scrollWidth>window.innerWidth,heights:[plan.height,actual.height],gap:actual.top-plan.bottom,dateCentered:Math.abs((date.left+date.right-header.left-header.right)/2)<1,sameRow:Math.abs(pill.top-sw.top)<10,topHeight:rect('#task-workspace-head').height};
    });
    assert.equal(layout.targetsFit,true,JSON.stringify({width,layout}));assert.equal(layout.targetsSeparate,true);assert.equal(layout.overflow,false);assert.equal(layout.heights[0],layout.heights[1]);assert.equal(layout.gap,20);assert.equal(layout.dateCentered,true);
    if(width>=835)assert.equal(layout.sameRow,true);
    results.push({width,...layout});await page.locator('#task-workspace-head').screenshot({path:out+'/header-'+width+'.png'});
   }
   await page.locator('#dn-tomorrow-btn').click();
   await page.waitForFunction(date=>document.querySelector('#ptrack').dataset.date===date,fixtureTomorrow);
   await page.locator('#dn-today-btn').click();
   await page.waitForFunction(date=>document.querySelector('#ptrack').dataset.date===date,fixtureToday);
   // Date-only Activity page remains usable after moving date into Progress.
   await page.evaluate(()=>window.DCC.nav.go({page:'activity'}));
   assert.equal(await page.locator('#date-nav').isVisible(),true);assert.equal(await page.locator('#ptrack').isVisible(),false);
  }
  assert.deepEqual(errors,[]);await context.close();
 }
 await fs.writeFile(out+'/measurements.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
} finally {await browser.close();}
