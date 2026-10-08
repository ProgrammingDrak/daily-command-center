/* global document, innerWidth */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.env.DCC_QA_OUTPUT||'fitness-preview-qa');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.DCC_CHROMIUM_PATH?{executablePath:process.env.DCC_CHROMIUM_PATH}:{})});
const page=await browser.newPage(),errors=[],network=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
const url=pathToFileURL(root+'/docs/fitness-preview/preview.html').href;
const checks=[];
try{
 for(const id of ['run','missing','duplicate','cross','revised','midnight','revoked','invalid']){
  await page.goto(url+'#'+id);await page.locator('#metrics dd').first().waitFor();
  const selected=await page.locator('#scenario').inputValue();assert.equal(await page.locator('#duplicate-label').isVisible(),id==='cross');assert.equal(selected,id==='invalid'?'run':id);
  await page.reload();assert.equal(await page.locator('#scenario').inputValue(),selected);
  if(id==='run'){
   await page.locator('#accept').click();assert.match(await page.locator('#status').innerText(),/Approve attaching/);
   await page.locator('#consent').check();await page.locator('#accept').click();assert.match(await page.locator('#status').innerText(),/Attached in memory/);
   assert.match(await page.locator('#result').innerText(),/"seconds": 1800/);
   await page.locator('#accept').click();assert.match(await page.locator('#status').innerText(),/already attached/);
   await page.locator('#reset').click();assert.equal(await page.locator('#consent').isChecked(),false);
   assert.equal(await page.locator('#result').innerText(),'');
  }
  if(id==='cross'){
   await page.locator('#consent').check();await page.locator('#accept').click();assert.match(await page.locator('#status').innerText(),/possible duplicate/);
   await page.locator('#duplicate-consent').check();await page.locator('#accept').click();assert.match(await page.locator('#status').innerText(),/Attached in memory/);
  }
  if(['duplicate','revised','revoked'].includes(id)){
   await page.locator('#consent').check();await page.locator('#accept').click();assert.doesNotMatch(await page.locator('#status').innerText(),/Attached in memory/);
  }
  if(id==='missing')assert.match(await page.locator('#metrics').innerText(),/Unknown/);
  if(id==='midnight')assert.match(await page.locator('#metrics').innerText(),/2026-10-07/);
  checks.push(id+': direct URL, reload and guarded state');
 }
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});await page.goto(url+'#run');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.locator('#scenario').focus();await page.keyboard.press('Tab');assert.equal(await page.locator('#reset').evaluate(el=>el===document.activeElement),true);
  await page.screenshot({path:output+'/preview-'+width+'.png',fullPage:true});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
 const fileRequests=network.slice();
 await page.route('https://preview.example.invalid/**',async route=>{const name=new URL(route.request().url()).pathname.split('/').pop()||'preview.html';const body=await fs.readFile(root+'/docs/fitness-preview/'+name);await route.fulfill({status:200,contentType:name.endsWith('.js')?'text/javascript':'text/html',body});});
 await page.goto('https://preview.example.invalid/preview.html');await page.getByText('This synthetic preview is available only as a local file or on localhost.',{exact:true}).waitFor();assert.equal(await page.locator('#accept').count(),0);checks.push('hosted origin: preview controls excluded');assert.deepEqual(errors,[]);
 await fs.writeFile(output+'/results.json',JSON.stringify({synthetic:true,checks,errors,fileRequests,hostedOriginMocked:true},null,2));console.log('PASS all fixture states, reset, consent, duplicates, local date, keyboard, widths; no network requests');
}finally{await browser.close();}
