/* global window, document, buildProgress, switchToDate, localStorage, sessionStorage, initCatchUp */
// Disposable review server only; no account data or external requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const base=process.env.DCC_PROGRESS_REVIEW_URL||'http://127.0.0.1:18781';
assert.match(base,/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
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
 await page.waitForFunction(()=>!!window.DCC?.ProgressActual&&!!window.DCC?.nav&&!!document.querySelector('#ptrack').dataset.date);
 const today=await page.evaluate(()=>window.DCC.dates.todayKey());
 // The fixture server may run in UTC while the app projects New York dates.
 // Anchor ongoing sessions inside the selected fixture day without pausing timers.
 await page.clock.setFixedTime(new Date(today+'T17:00:00Z'));
 await fetch(base+'/api/review/actual/seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({today})});
 await page.reload();
 assert.equal(await page.locator('#day-progress-bars').isVisible(),false);
 await page.locator('#day-progress-title').click();
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
 const compactMeasurements=[];
 const assertCompact=async(width)=>{
  // Match the reference screenshot tally so narrow-header coverage is realistic.
  await page.locator("#ppct").evaluate(el=>{el.textContent="8 / 25 done · 32%";});
  const m=await page.evaluate(()=>{
   const plan=document.querySelector('#ptrack').getBoundingClientRect(),actual=document.querySelector('#pactual').getBoundingClientRect(),heading=document.querySelector('.progress-label').getBoundingClientRect(),button=document.querySelector('#progress-day-review').getBoundingClientRect();
   return {plan:plan.height,actual:actual.height,gap:actual.top-plan.bottom,heading:heading.height,reviewHeight:button.height,reviewInHeading:button.top>=heading.top&&button.bottom<=heading.bottom+1,segments:[...document.querySelectorAll('#pactual button')].map(b=>{const r=b.getBoundingClientRect();return {height:r.height,inside:r.top>=actual.top-.1&&r.bottom<=actual.bottom+.1,label:b.getAttribute('aria-label')};})};
  });
  assert.equal(m.actual,m.plan,'equal total track height at '+width);
  assert.equal(m.plan,width<=760?14:18);
  assert.ok(m.gap<=21,'compact inter-bar gap at '+width+': '+m.gap);
  assert.ok(m.heading<=(width<=760?80:24)&&m.reviewHeight>=24&&m.reviewInHeading,'compact accessible review header');
  assert.ok(m.segments.every(s=>s.height>0&&s.inside&&s.label),'all activity portions visible and labeled');
  compactMeasurements.push({width,...m});
 };
 await assertCompact(1440);
 await page.locator('.progress-box').screenshot({path:out+'/ongoing-desktop.png'});
 for(const width of [375,320]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no page overflow at '+width);
  await assertAxisVisible();
  await assertCompact(width);
  await page.locator('.progress-box').screenshot({path:out+'/ongoing-'+width+'.png'});
 }
 // Three simultaneous sessions must remain distinct within the fixed track.
 await page.evaluate(()=>{
  window.DCCWorkSessions.activeTasks=()=>[1,2,3].map(n=>({id:'dense-'+n,title:'Concurrent task '+n,startedAt:new Date(Date.now()-600000).toISOString()}));
  buildProgress();
 });
 assert.equal(await page.locator('#pactual .live').count(),3);
 const liveLanes=await page.locator('#pactual .live').evaluateAll(nodes=>nodes.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}).sort((a,b)=>a.top-b.top));
 assert.ok(liveLanes.slice(1).every((lane,i)=>liveLanes[i].bottom<=lane.top+.1),'concurrent portions occupy distinct visible bands');
 await assertCompact(320);
 await page.keyboard.press('Tab');
 await page.locator('#pactual .live').last().focus();
 assert.ok(await page.locator('#day-progress-tooltip').isVisible());
 assert.equal(await page.locator('#pactual .live').last().evaluate(el=>el.getBoundingClientRect().height),14,'focused portion expands within fixed-height track');
 await page.locator('.progress-box').screenshot({path:out+'/focused-overlap-320.png'});
 await page.locator('#pactual button').first().focus();
 assert.ok(await page.locator('#day-progress-tooltip').isVisible());
 await page.keyboard.press('Escape');
 const focusKey=await page.locator('#pactual button').first().getAttribute('data-entry-id');
 await page.evaluate(()=>buildProgress());
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.entryId),focusKey,'actual focus survives refresh');
 await page.locator('#ptrack button').first().focus();
 const planFocus=await page.evaluate(()=>document.activeElement.dataset.progressKey);
 await page.evaluate(()=>buildProgress());
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.progressKey),planFocus,'plan focus survives refresh');
 const savedActual=await page.evaluate(()=>localStorage.getItem('dcc-itinerary-actual'));
 await page.locator('#progress-day-review').click();
 await page.waitForSelector('#actual-view .dr-root');
 assert.equal(await page.locator('#list-view').isVisible(),true);
 assert.equal(await page.evaluate(()=>window.DCC.nav.get().actual),false);
 assert.equal(await page.evaluate(()=>localStorage.getItem('dcc-itinerary-actual')),savedActual);
 await page.locator('#progress-day-review').click();
 assert.equal(await page.locator('#actual-view').isHidden(),true);
 await page.reload();
 await page.waitForFunction(()=>!!window.DCC?.nav);
 assert.equal(await page.evaluate(()=>window.DCC.nav.get().actual),false,'review never persists the overlay');
 assert.equal(await page.locator('#actual-view').isHidden(),true,'review panel is ephemeral');
 await page.goto(base+'/?tab=tasks&view=queue');
 await page.waitForFunction(()=>!!document.querySelector('#ptrack').dataset.date);
 await page.locator('#progress-day-review').click();
 await page.waitForSelector('#actual-view .dr-root');
 assert.equal(await page.locator('#list-view').isVisible(),true,'queue review opens itinerary');
 await page.goBack();
 await page.waitForFunction(()=>window.DCC.nav.get().view==='queue');
 assert.equal(await page.locator('#progress-day-review').getAttribute('aria-expanded'),'false');
 await page.goto(base+'/?tab=tasks&view=list&actual=1');
 await page.locator('#day-progress-title').click();
 await page.waitForSelector('.actual-details-dismiss');
 await page.locator('.actual-details-dismiss').click();
 assert.equal(await page.evaluate(()=>window.DCC.nav.get().actual),false);
 await page.reload();
 await page.waitForFunction(()=>!!window.DCC?.nav);
 assert.equal(await page.evaluate(()=>window.DCC.nav.get().actual),false,'legacy overlay dismissal survives reload');
 await page.evaluate(()=>localStorage.setItem('dcc-itinerary-actual','1'));
 await page.goto(base+'/?tab=tasks&view=calendar');
 await page.locator('#day-progress-title').click();
 await page.waitForSelector('.actual-details-dismiss');
 await page.locator('.actual-details-dismiss').click();
 assert.equal(await page.evaluate(()=>window.DCC.nav.get().actual),false,'legacy saved preference can be dismissed');
 await page.goto(base+'/?tab=tasks&view=actual');
 await page.locator('#day-progress-title').click();
 await page.waitForSelector('.actual-details-dismiss');
 await page.locator('.actual-details-dismiss').click();
 assert.equal(await page.evaluate(()=>window.DCC.nav.get().actual),false,'legacy Actual view link can be dismissed');
 // Isolate clock/empty fixtures from legacy-overlay review preferences and
 // metadata saves accumulated by the preceding navigation walkthrough.
 await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();});
 await page.goto(base+'/?tab=tasks&view=list&actual=0');
 await page.locator('#day-progress-title').click();
 await page.waitForFunction(()=>!!document.querySelector('#ptrack').dataset.date);
 // Finish the unrelated boot recap's day-root metadata save before navigating.
 // The block cache intentionally rejects hydration while a save is in flight.
 await page.evaluate(()=>initCatchUp());
 await page.waitForFunction(()=>!window.blockStore.hasPendingWrites());

 await page.evaluate(async()=>{
  if(typeof window._reviewActive==="function")window.DCCWorkSessions.activeTasks=window._reviewActive;
  await switchToDate('2026-01-04');buildProgress();
 });
 await page.waitForFunction(()=>document.querySelector('#pactual-note').textContent.includes('No timed activity'));
 assert.equal(await page.locator('#pactual button').count(),0);
 await page.locator('.progress-box').screenshot({path:out+'/empty-mobile.png'});
 for(const fixture of [{date:'2026-11-01',startedAt:'2026-11-01T05:50:00Z',label:/1:50 AM EDT.*1:10 AM EST/},{date:'2026-03-08',startedAt:'2026-03-08T06:50:00Z',label:/1:50 AM EST.*3:10 AM EDT/},{date:'2026-02-03',start:'23:50',label:/11:50 PM/}]){
  await fetch(base+'/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'clock-review-'+fixture.date,type:'time_entry',date:fixture.date,properties:{taskTitle:'Clock transition review',startedAt:fixture.startedAt,start:fixture.start,durSec:1200}})});
  await page.evaluate(async date=>{await switchToDate(date);buildProgress();},fixture.date);
  await page.waitForSelector('#pactual button');
  const segments=page.locator('#pactual button');
  assert.equal(await segments.count(),fixture.start?1:2);
  assert.match(await segments.first().getAttribute('aria-label'),fixture.label);
  if(fixture.start){assert.equal(await page.locator('#ptrack').getAttribute('data-end-min'),'1440');assert.match(await page.locator('#pend').innerText(),/next day|1 day/);}
  await page.locator('.progress-box').screenshot({path:out+'/clock-'+fixture.date+'.png'});
 }
 // No application script exceptions; intentionally blocked external fonts are transport noise.
 assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/results.json',JSON.stringify({checks:['equal total height desktop/mobile','compact spacing and header','three overlaps retained and focusable','recorded evidence','unplaced and unknown minutes','same pixel axis','two ongoing overlapping sessions','mobile 320/375','keyboard tooltip and focus survives refresh','independent review open-close-reload','queue review and Back','legacy URL and saved preference dismissal','day review preserves itinerary','empty past date'],aligned,compactMeasurements,errors},null,2));
 console.log('PASS progress bars: recorded, empty, ongoing, overlap, timezone, alignment, mobile, keyboard, day review');
}finally{await browser.close();}
