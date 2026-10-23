/* global window, document */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
const base=process.argv[2]||'http://127.0.0.1:8355';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname));
assert.equal((await(await fetch(base+'/api/health')).json()).reviewOnly,true);
const out=process.env.DCC_QA_OUTPUT||'test-results/waiting-titles';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
for(const width of [1280,390,320])for(const surface of ['itinerary','loose-ends']){
 const ids=await(await fetch(base+'/api/review/waiting/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
 page.setDefaultTimeout(10000);
 console.log('START '+surface+' '+width);
 const read=async()=> (await(await page.request.get(base+'/api/review/waiting/state')).json()).rows;
 await page.goto(base);await page.screenshot({path:out+'/initial-'+width+'.png'});console.log('LOADED');await page.waitForFunction(()=>window.DCC?.Waiting?.all().length>0);
 if(surface==='itinerary'){
  await page.locator('#waiting-pill-nav').click();
  await page.locator('#delegated-blocked-list [data-delegated-action="rename"][data-id="'+ids.item+'"]').click();
 }else{
  await page.locator('#loose-ends-pill').click();
  await page.locator('.cu-waiting-row .ttl').first().click();
  await page.locator('.cu-wait-rename').first().click();
 }
 await page.locator('#waiting-title-input').waitFor();
 const before=await read();
 await page.locator('#waiting-title-input').fill('Cancelled title');await page.keyboard.press('Escape');
 await page.locator('.dcc-overlay').waitFor({state:'detached'});
 assert.deepEqual(await read(),before);
 // Reopen using the same public action used by the compact Waiting title.
 await page.evaluate(id=>window.DCC.Waiting.rename(id,document.activeElement),ids.item);
 await page.locator('#waiting-title-input').fill('DEMO · Renamed waiting work');
 let fail=true;await page.route('**/api/waiting-items/*/title',async r=>{if(fail && r.request().method()==='PATCH'){fail=false;await r.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic failed save"}'});}else await r.continue();});
 await page.getByRole('button',{name:'Save title',exact:true}).click();await page.getByRole('alert').filter({hasText:'Synthetic failed save'}).waitFor();
 assert.deepEqual(await read(),before);assert.equal(await page.locator('#waiting-title-input').inputValue(),'DEMO · Renamed waiting work');
 const bounds=await page.locator('.dcc-overlay-body').evaluate(e=>({w:e.clientWidth,s:e.scrollWidth}));assert.ok(bounds.s<=bounds.w);
 await page.screenshot({path:out+'/'+surface+'-'+width+'.png'});
 await page.getByRole('button',{name:'Save title',exact:true}).click();await page.locator('.dcc-overlay').waitFor({state:'detached'});
 const saved=await read();assert.deepEqual(saved[0].properties,{...before[0].properties,title:'DEMO · Renamed waiting work'});assert.deepEqual(saved[1].properties,{...before[1].properties,myTask:'DEMO · Renamed waiting work'});
 assert.deepEqual(saved.slice(2),before.slice(2));
 await page.reload();await page.waitForFunction(()=>window.DCC?.Waiting?.all().some(i=>i.properties.myTask==='DEMO · Renamed waiting work'));
 assert.equal((await read())[0].properties.title,'DEMO · Renamed waiting work');
 console.log('PASS '+surface+' '+width+' title: cancel, failed-save retry, metadata preservation and reload');await page.close();
}
} finally {await browser.close();}
