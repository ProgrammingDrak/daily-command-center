/* global window, document, buildProgress, switchToDate */
// Disposable review server only; no account data or external requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const base='http://127.0.0.1:18781';
assert.equal((await fetch(base+'/api/health').then(r=>r.json())).reviewOnly,true);
const out=process.env.DCC_PROGRESS_REVIEW_OUT||'test-results/progress-bars';
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'UTC'});
await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(base+'/?tab=tasks&view=list');
 await page.waitForFunction(()=>!!window.DCC?.ProgressActual&&!!window.DCC?.nav);
 const today=await page.evaluate(()=>window.DCC.dates.todayKey());
 await fetch(base+'/api/review/actual/seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({today})});
 await page.reload();
 await page.waitForSelector('#pactual [data-entry-id="actual-te-a"]');
 assert.equal(await page.locator('#task-actual-toggle').count(),0);
 assert.equal(await page.locator('#list-view').isVisible(),true);
 assert.equal(await page.locator('#pactual button').count(),3);
 assert.match(await page.locator('#pactual-note').innerText(),/25m recorded without a reliable clock time/);
 assert.match(await page.locator('#pactual-note').innerText(),/7m unknown time/);
 const aligned=await page.evaluate(()=>{
  const plan=document.querySelector('#ptrack'),actual=document.querySelector('#pactual'),seg=actual.querySelector('[data-entry-id="actual-te-a"]');
  const pr=plan.getBoundingClientRect(),ar=actual.getBoundingClientRect(),sr=seg.getBoundingClientRect();
  const start=Number(plan.dataset.startMin),total=Number(plan.dataset.endMin)-start;
  return {left:Math.abs(pr.left-ar.left),width:Math.abs(pr.width-ar.width),segment:Math.abs(sr.left-(pr.left+(555-start)/total*pr.width)),now:document.querySelector('#pnow').getAttribute('aria-label')};
 });
 assert.ok(aligned.left<1&&aligned.width<1&&aligned.segment<1,JSON.stringify(aligned));
 const assertAxisVisible=async()=>assert.equal(await page.evaluate(()=>{
  const axis=document.querySelector('.progress-axis').getBoundingClientRect(),wrap=document.querySelector('.progress-wrap').getBoundingClientRect();
  return axis.bottom<=wrap.bottom+1;
 }),true,'shared clock axis is not clipped');
 await assertAxisVisible();
 await page.locator('.progress-box').screenshot({path:out+'/recorded-desktop.png'});
 // Fixture-only ongoing and concurrent sessions; the actual bar reads the same
 // canonical active-session accessor as the dock without writing any task.
 await page.evaluate(()=>{
  window._reviewActive=window.DCCWorkSessions.activeTasks;
  window.DCCWorkSessions.activeTasks=()=>[{id:'review-live',title:'Ongoing review work',startedAt:new Date(Date.now()-600000).toISOString()},{id:'review-live-2',title:'Concurrent work',startedAt:new Date(Date.now()-300000).toISOString()}];
  buildProgress();
 });
 assert.equal(await page.locator('#pactual .live').count(),2);
 assert.ok(await page.locator('#pactual').evaluate(el=>el.getBoundingClientRect().height>=38));
 await page.locator('.progress-box').screenshot({path:out+'/ongoing-desktop.png'});
 for(const width of [375,320]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no page overflow at '+width);
  await assertAxisVisible();
  await page.locator('.progress-box').screenshot({path:out+'/ongoing-'+width+'.png'});
 }
 await page.locator('#pactual button').first().focus();
 assert.ok(await page.locator('#day-progress-tooltip').isVisible());
 await page.keyboard.press('Escape');
 await page.locator('#progress-day-review').click();
 await page.waitForSelector('#actual-view .dr-root');
 assert.equal(await page.locator('#list-view').isVisible(),true);
 await page.evaluate(async()=>{
  window.DCCWorkSessions.activeTasks=window._reviewActive;
  await switchToDate('2026-01-04');buildProgress();
 });
 await page.waitForFunction(()=>document.querySelector('#pactual-note').textContent.includes('No timed activity'));
 assert.equal(await page.locator('#pactual button').count(),0);
 await page.locator('.progress-box').screenshot({path:out+'/empty-mobile.png'});
 // No application script exceptions; intentionally blocked external fonts are transport noise.
 assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/results.json',JSON.stringify({checks:['recorded evidence','unplaced and unknown minutes','same pixel axis','two ongoing overlapping sessions','mobile 320/375','keyboard tooltip','day review preserves itinerary','empty past date'],aligned,errors},null,2));
 console.log('PASS progress bars: recorded, empty, ongoing, overlap, timezone, alignment, mobile, keyboard, day review');
}finally{await browser.close();}
