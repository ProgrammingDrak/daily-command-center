/* global window, scheduled, convertTaskType */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
const base=process.argv[2]||'http://127.0.0.1:8296';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname));
const info=await (await fetch(base+'/api/activity-review-info')).json();
assert.equal(info.synthetic,true);assert.equal(info.storage,'memory');
const output=path.resolve(process.env.DCC_QA_OUTPUT||'quick-add-qa');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.DCC_CHROMIUM_PATH?{executablePath:process.env.DCC_CHROMIUM_PATH}:{})});
const page=await browser.newPage(),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const mark=s=>{checks.push(s);console.log('PASS '+s);};
try{
 await page.goto(base);await page.locator('#api-loading').waitFor({state:'detached'});
 const launcher=page.locator('#task-add-launcher');
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});
  await page.locator('#dcc-launcher-btn').click();
  await launcher.locator('.tab-title').fill('DEMO · Quick run '+width);
  await launcher.locator('.tab-dur').selectOption('90');
  await page.getByRole('button',{name:'Log workout',exact:true}).click();
  await page.locator('.act-editor [data-path="duration"]').waitFor();
  assert.equal(await page.locator('.act-editor [data-path="duration"]').inputValue(),'90');
  assert.equal(await page.locator('#dcc-compose').getAttribute('aria-hidden'),'true');
  assert.equal(await page.locator('.act-editor').evaluate(el=>!!el.closest('[inert]')),false);
  assert.equal(await page.locator('.dcc-modal').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  await page.screenshot({path:path.join(output,'workout-'+width+'.png')});
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.locator('.dcc-modal').waitFor({state:'detached'});
  await page.locator('#dcc-launcher-btn').click();
  assert.equal(await launcher.locator('.tab-title').inputValue(),'DEMO · Quick run '+width);
  assert.equal(await launcher.locator('.tab-dur').inputValue(),'90');assert.equal(await launcher.locator('.tab-dest').inputValue(),'workout');
  await launcher.locator('.tab-add').click();await page.locator('.act-editor [data-path="duration"]').waitFor();
  await page.getByRole('button',{name:'Create task',exact:true}).click();
  await page.getByRole('button',{name:'Save record',exact:true}).waitFor();
  const records=await (await fetch(base+'/api/activity?from='+info.date+'&to='+info.date)).json();
  const row=records.records.find(r=>r.title==='DEMO · Quick run '+width);assert.ok(row);assert.equal(row.completed,false);
  const saved=await (await fetch(base+'/api/blocks/'+row.taskId)).json();
  assert.equal(saved.properties.duration,90);assert.equal(saved.properties.type,'workout');assert.equal(saved.properties.publicVisibility,'private');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.locator('.dcc-modal').waitFor({state:'detached'});
  const result=await page.evaluate(async({taskId})=>{
   await window.blockStore.handleBlocksChanged({blockIds:[taskId]});
   const block=window.blockStore.get(taskId);
   const ev={id:block.properties.local_id||taskId,_blockId:taskId,type:'workout',publicVisibility:'private',start:'09:00',end:'10:30',duration:90,title:block.properties.title};
   scheduled.push(ev);
   const result=await convertTaskType(ev.id,'task');
   return {result,type:ev.type,privacy:ev.publicVisibility};
  },row);
  assert.deepEqual(result,{result:false,type:'workout',privacy:'private'});
  mark(width+'px: discoverable logging, 90m handoff, cancel recovery, saved private task, protected conversion');
 }
 await page.locator('#dcc-launcher-btn').click();await launcher.locator('.tab-title').fill('DEMO · Failed meal');await launcher.locator('.tab-dur').selectOption('60');
 await launcher.locator('.tab-dest').selectOption('meal');await launcher.locator('.tab-add').click();
 await page.route('**/api/activity/tasks',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic save failure'})}),{times:1});
 await page.getByRole('button',{name:'Create task',exact:true}).click();await page.getByText('Synthetic save failure',{exact:true}).waitFor();
 assert.equal(await page.locator('.act-editor [data-path="duration"]').inputValue(),'60');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.locator('.dcc-modal').waitFor({state:'detached'});await page.locator('#dcc-launcher-btn').click();
 assert.equal(await launcher.locator('.tab-title').inputValue(),'DEMO · Failed meal');assert.equal(await launcher.locator('.tab-dest').inputValue(),'meal');
 await launcher.locator('.tab-add').click();await page.getByRole('button',{name:'Create task',exact:true}).click();await page.getByRole('button',{name:'Save record',exact:true}).waitFor();
 mark('Meal dropdown: failed save retains draft, retry creates 60m record');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'results.json'),JSON.stringify({synthetic:true,checks,errors},null,2));
}finally{await browser.close();}
