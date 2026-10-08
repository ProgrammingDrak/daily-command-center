// Fixture-only: PORT=8108 DCC_REVIEW_TASK_DETAILS=1 node scripts/ui-review-server.mjs
// Then node scripts/verify-date-picker-consistency.mjs [fixture URL]. Never point at live data.
/* global window, document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const out = process.env.DCC_QA_OUTPUT || 'test-results/date-picker-consistency';
const base = process.argv[2] || 'http://127.0.0.1:8108';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname),'QA requires a local fixture server');
const health=await fetch(base+'/api/health').then(r=>r.json());
assert.equal(health.reviewOnly,true,'QA requires the database-free review server');
fs.mkdirSync(out,{recursive:true});
try {
for (const width of [1280,375]) {
 const ctx=await browser.newContext({viewport:{width,height:900},timezoneId:'America/New_York'});
 const page=await ctx.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);
 await page.waitForFunction(()=>typeof window.openDelegatedModal==='function' && document.querySelector('#dm-check-in-date').__tw);
 const writes=[];
 page.on('request',r=>{if(/waiting-items/.test(r.url())&&r.method()!=='GET')writes.push(r.url());});
 const keys=await page.evaluate(()=>{const n=new Date();const iso=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');const today=iso(n);n.setDate(n.getDate()+1);return [today,iso(n)];});
 await page.evaluate(()=>window.openDelegatedModal(null,{myTask:'Date picker QA',checkInDate:'2026-12-19'}));
 const field=page.locator('#dm-check-in-date');
 const chip=page.locator('#dm-date-fields .tw-field-date');
 const expectDate=async (value,preset)=>{
  assert.equal(await field.inputValue(),value);
  assert.equal(await chip.innerText(),await page.evaluate(v=>new Date(v+'T12:00:00').toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}),value));
  for(const token of ['today','tomorrow'])assert.equal(await page.locator('[data-dm-date="'+token+'"]').getAttribute('aria-pressed'),String(token===preset));
 };
 await page.locator('[data-dm-date="today"]').click();await expectDate(keys[0],'today');
 await page.locator('[data-dm-date="tomorrow"]').focus();await page.keyboard.press('Enter');await expectDate(keys[1],'tomorrow');
 await chip.click();assert.equal(await page.locator('.tw-cal-day.sel').innerText(),String(Number(keys[1].slice(-2))));
 await page.keyboard.press('Escape');assert(await page.locator('#delegated-modal-overlay').evaluate(e=>e.classList.contains('open')));
 await chip.click();await page.locator('.tw-cal-day').filter({hasText:/^15$/}).click();
 const custom=await field.inputValue();await expectDate(custom,custom===keys[0]?'today':custom===keys[1]?'tomorrow':null);
 await chip.click();await page.locator('.tw-now').click();await expectDate(keys[0],'today');
 await page.screenshot({path:out+'/waiting-'+width+'.png'});
 await page.locator('#dm-cancel').click();
 await page.evaluate(()=>window.openDelegatedModal(null,{myTask:'Reopen',checkInDate:'2026-12-19'}));
 await expectDate('2026-12-19',null);assert.equal(writes.length,0);
 await page.locator('#dm-cancel').click();
 // The PR399 prompt keeps native date validity and explicit Save.
 await page.evaluate(()=>{window.completeWaitingCheckIn('review-waiting');});
 await page.locator('#wci-date').waitFor();
 assert.equal(await page.locator('#wci-date').getAttribute('type'),'date');
 assert.equal(await page.locator('#wci-date').getAttribute('min'),keys[0]);
 await page.locator('#wci-date').fill('2026-01-01');
 assert.equal(await page.locator('#wci-date').evaluate(e=>e.validity.rangeUnderflow),true);
 await page.locator('[data-wci-cancel]').click();assert.equal(writes.length,0);
 await page.evaluate(()=>window.openDelegatedModal(null,{myTask:'Save QA'}));
 await page.locator('[data-dm-date="tomorrow"]').click();
 const saveRequest=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/waiting-items'));
 await page.locator('#dm-save').click();
 assert.equal((await saveRequest).postDataJSON().properties.checkInDate,keys[1]);
 assert.equal(writes.length,1);
 await page.waitForFunction(()=>!document.querySelector('#delegated-modal-overlay').classList.contains('open'));
 await page.evaluate(()=>window.openSchedulePicker('Placement QA',30,{}));
 await page.locator('[data-sched-day="tomorrow"]').click();
 assert.equal(await page.locator('#sched-date-input').inputValue(),keys[1]);
 await page.locator('#sched-after-back').click();await page.locator('#sched-pick-date-btn').click();
 assert.equal(await page.locator('.tw-cal-day.sel').innerText(),String(Number(keys[1].slice(-2))));
 await page.keyboard.press('Escape');
 await page.locator('[data-sched-day="today"]').click();await page.locator('#sched-after-back').click();
 assert.equal(await page.locator('#sched-date-input').inputValue(),keys[0]);
 assert.equal(await page.locator('[data-sched-day="today"]').getAttribute('aria-pressed'),'true');
 await page.screenshot({path:out+'/placement-'+width+'.png'});
 await page.locator('#sched-picker-close').click();await page.evaluate(()=>window.openSchedulePicker('New session',30,{}));
 assert.equal(await page.locator('#sched-date-input').inputValue(),'');assert.match(await page.locator('#sched-pick-date-btn').innerText(),/Pick a date/);
 await page.locator('#sched-picker-close').click();
 await page.evaluate(()=>{window.qaPicked=null;window.openDatePickPopover(document.querySelector('#waiting-pill-nav'),{onPick:date=>{window.qaPicked=date;return new Promise(()=>{});}});});
 await page.locator('.resched-btn[data-target="tomorrow"]').click();
 assert.equal(await page.locator('.resched-date-input').inputValue(),keys[1]);
 assert.equal(await page.evaluate(()=>window.qaPicked),keys[1]);
 assert.equal(await page.locator('.resched-btn[data-target="tomorrow"]').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('.resched-custom .tw-field-date').innerText(),await chipLabel(page,keys[1]));
 assert.deepEqual(errors,[]);
 console.log('PASS desktop/mobile preset switches, calendar selection, keyboard, cancel/reopen, popover: '+width);
 await ctx.close();
}
for(const [tz,before,after,today,tomorrow] of [
 ['America/New_York','2026-03-08T04:59:59Z','2026-03-08T05:00:01Z','2026-03-08','2026-03-09'],
 ['America/New_York','2026-11-01T03:59:59Z','2026-11-01T04:00:01Z','2026-11-01','2026-11-02'],
 ['America/Los_Angeles','2026-12-31T23:59:59-08:00','2027-01-01T00:00:01-08:00','2027-01-01','2027-01-02'],
 ['Pacific/Auckland','2026-09-27T00:59:59+12:00','2026-09-27T03:00:01+13:00','2026-09-27','2026-09-28']
]) {
 const ctx=await browser.newContext({timezoneId:tz});const page=await ctx.newPage();
 await page.clock.setFixedTime(new Date(before));await page.goto(base);
 await page.waitForFunction(()=>typeof window.openDelegatedModal==='function'&&document.querySelector('#dm-check-in-date').__tw);
 await page.evaluate(()=>window.openDelegatedModal(null,{myTask:'Boundary QA'}));
 await page.clock.setFixedTime(new Date(after));
 await page.locator('[data-dm-date="today"]').click();assert.equal(await page.locator('#dm-check-in-date').inputValue(),today);
 await page.locator('[data-dm-date="tomorrow"]').click();assert.equal(await page.locator('#dm-check-in-date').inputValue(),tomorrow);
 await page.locator('#dm-cancel').click();await page.evaluate(()=>window.openSchedulePicker('Boundary',30,{}));
 await page.locator('[data-sched-day="today"]').click();assert.equal(await page.locator('#sched-date-input').inputValue(),today);
 await page.locator('#sched-after-back').click();await page.locator('[data-sched-day="tomorrow"]').click();assert.equal(await page.locator('#sched-date-input').inputValue(),tomorrow);
 console.log('PASS boundary '+tz+' '+today);await ctx.close();
}
} finally {await browser.close();}
async function chipLabel(page,value){return page.evaluate(v=>new Date(v+'T12:00:00').toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}),value);}
