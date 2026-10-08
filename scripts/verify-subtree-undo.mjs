/* global window, scheduled, deletedSet, deleteTaskWithUndo, undoDeleteTask */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
const base=process.argv[2]||'http://127.0.0.1:8147';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
assert.equal((await fetch(base+'/api/health').then(r=>r.json())).reviewOnly,true);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const post=(path,data={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
async function live(){return fetch(base+'/api/blocks').then(r=>r.json());}
const treeIds=rows=>rows.filter(row=>/^review-(wrap$|deep-|own-time$)/.test(row.id)).map(row=>row.id).sort();
try{
 for(const width of [1280,390]){
  await post('/api/review/hierarchy/reset');await post('/api/review/hierarchy/restore-failure',{status:409});
  const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width<500,isMobile:width<500}),page=await context.newPage();page.setDefaultTimeout(15000);
  await context.addInitScript(()=>{window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'review-fixture'};});
  const errors=[];page.on('pageerror',e=>errors.push(e.stack));
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof scheduled!=='undefined'&&scheduled.find(e=>e.id==='review-wrap'));
  const before=await live(),ids=treeIds(before);assert.equal(ids.length,82);
  await page.evaluate(()=>deleteTaskWithUndo('review-wrap'));
  await page.evaluate(()=>undoDeleteTask('review-wrap'));
  assert.deepEqual(treeIds(await live()),[]);
  await page.locator('.toast').filter({hasText:'Could not restore the task tree'}).waitFor();
  assert.equal(await page.locator('.toast').filter({hasText:'Task restored'}).count(),0);
  await page.reload({waitUntil:'domcontentloaded'});
  const retry=page.locator('.toast').filter({hasText:'Could not restore the task tree'}).getByRole('button',{name:'Retry'});await retry.waitFor();
  await page.waitForTimeout(500);assert.equal(await retry.count(),1);
  await post('/api/review/hierarchy/restore-failure',{status:0});await retry.click();
  await page.waitForFunction(()=>typeof scheduled!=='undefined'&&scheduled.some(e=>e.id==='review-deep-80')&&!deletedSet.has('review-wrap'));
  assert.deepEqual(treeIds(await live()),ids);
  for(const old of before.filter(row=>ids.includes(row.id))){const now=(await live()).find(row=>row.id===old.id);assert.equal(now.properties.notes,old.properties.notes);assert.equal(now.properties.subtaskOf,old.properties.subtaskOf);assert.equal(now.properties.wrapId,old.properties.wrapId);assert.equal(now.parent_id,old.parent_id);}
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof scheduled!=='undefined'&&scheduled.some(e=>e.id==='review-deep-80')&&!deletedSet.has('review-wrap'));
  assert.equal(await page.locator('.toast').filter({hasText:'Could not restore the task tree'}).count(),0);
  await page.evaluate(()=>deleteTaskWithUndo('review-wrap'));await page.evaluate(()=>undoDeleteTask('review-wrap'));
  assert.deepEqual(treeIds(await live()),ids);
  // A transient failure replays through the real BlockStore event listener after reload.
  await post('/api/review/hierarchy/restore-failure',{status:503});
  await page.evaluate(()=>deleteTaskWithUndo('review-wrap'));await page.evaluate(()=>undoDeleteTask('review-wrap'));
  assert.deepEqual(treeIds(await live()),[]);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.toast').filter({hasText:'Task tree restore pending'}).getByRole('button',{name:'Retry'}).waitFor();
  assert.equal(await page.locator('.toast').filter({hasText:'Task restored'}).count(),0);
  await post('/api/review/hierarchy/restore-failure',{status:0});await page.evaluate(()=>window.blockStore.replayWAL());
  await page.waitForFunction(()=>!deletedSet.has('review-wrap')&&scheduled.some(e=>e.id==='review-deep-80'));
  assert.deepEqual(treeIds(await live()),ids);assert.deepEqual(errors,[]);
  fs.mkdirSync('test-results/hierarchy',{recursive:true});await page.screenshot({path:'test-results/hierarchy/atomic-undo-'+width+'.png'});
  console.log('PASS '+width+'px atomic tree Undo: injected rejection, no false success, reload retains Retry, original 82 rows/edges/notes restored, reload and repeat preserve tree');
  await context.close();
 }
}finally{await browser.close();}
