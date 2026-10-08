/* global __dirname, fetch, URL, window, document, console, process, openAddModal, closeAddModal, openDeleteConfirm: writable, refoldTaskStateFromBlockCache, render, scheduled, buildTaskRadialItems, buildMeetingRadialItems, buildCarryoverRadialItems */
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const base=process.env.DCC_REVIEW_URL||'http://127.0.0.1:8303';
(async()=>{
 assert.equal((await(await fetch(base+'/api/health')).json()).database,'fixture');
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await page.goto(base);await page.waitForFunction(()=>window.blockStore&&typeof openAddModal==='function');
  const date=new Date().toISOString().slice(0,10);
  await page.evaluate(async date=>{await window.blockStore.loadDay(date);refoldTaskStateFromBlockCache();render();},date);
  const row=page.locator('.it-list-item[data-id="review-detail-task"]').first();
  await row.waitFor();
  await page.waitForTimeout(5500);
  const results=[];
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:844});
   await row.scrollIntoViewIfNeeded();await page.waitForTimeout(300);
   for(const selector of ['.row-add-menu','.btn-duration','.btn-del-task','[data-work-action]','.ttl[role="button"]'])assert(await row.locator(selector).first().isVisible(),selector+' visible at '+width);
   await row.locator('.btn-task-radial').click();
   assert.deepEqual(await page.locator('button.dest-radial-item').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Subtask…','Unscheduled','Convert…','Delegate / block','Blocked by task','Repeat','Solo','Whenever','Lock']);
   assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Subtask…');
   await page.getByRole('button',{name:'Delegate / block',exact:true}).waitFor();
   await page.keyboard.press('End');await page.keyboard.press('Tab');
   assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Subtask…');
   await page.waitForTimeout(500);
   const bounds=await page.locator('button.dest-radial-item').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {label:n.getAttribute('aria-label'),x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
   for(const r of bounds)assert(r.x>=0&&r.y>=0&&r.right<=width&&r.bottom<=844,JSON.stringify(r));
   if(width===390||width===1440)await page.screenshot({path:path.join(__dirname,'../design/task-details/screenshots/radial-change-'+width+'.png')});
   await page.getByRole('button',{name:/^Convert/}).click();
   assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Back');
   await page.getByRole('button',{name:'Back',exact:true}).click();
   assert.equal(await page.locator('button.dest-radial-item').count(),9);
   await page.keyboard.press('Escape');
   assert.equal(await page.locator('button.dest-radial-item').count(),0);
   assert(await row.locator('.btn-task-radial').evaluate(n=>n===document.activeElement));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,'page width');
   results.push({width,barActionsVisible:true,nestedBackAndEscape:true,bounds});
  }
  await row.locator('.btn-duration').click();await page.locator('.dur-custom-input').waitFor();
  await page.keyboard.press('Escape');
  // Reload clears any legacy popover without changing a task.
  await page.reload();await row.waitFor();
  await row.locator('.row-add-menu').click();
  assert(await page.locator('button.dest-radial-item').count()>0||await page.locator('[class*="add-pop"]').count()>0,'add placement opens');
  await page.keyboard.press('Escape');await page.reload();await row.waitFor();
  await row.locator('.ttl').focus();await page.keyboard.press('Enter');
  await page.locator('#add-modal-overlay.open').waitFor();await page.evaluate(()=>closeAddModal());
  await page.evaluate(()=>{window.reviewOriginalDelete=openDeleteConfirm;openDeleteConfirm=id=>{window.reviewDeleteTarget=id;};});
  await row.locator('.btn-del-task').click();
  assert.equal(await page.evaluate(()=>window.reviewDeleteTarget),'review-detail-task','canonical delete entry point');
  const variants=await page.evaluate(()=>({
   recurring:buildTaskRadialItems({...scheduled.find(t=>t.id==='review-detail-task'),repeatMode:'scheduled'},{}).map(i=>i.label),
   meeting:buildMeetingRadialItems({start:'23:59'},{}).map(i=>i.label),
   carryover:buildCarryoverRadialItems({}, {}, {}).map(i=>i.label)
  }));
  assert.deepEqual(variants.recurring,['Subtask…','Unscheduled','Convert…','Delegate / block','Blocked by task','Repeat','Solo','Whenever','Repeat options…','Lock']);
  assert.deepEqual(variants.carryover,['Move…','Solo']);
  fs.writeFileSync(path.join(__dirname,'../design/task-details/radial-checks.json'),JSON.stringify({results,variants,syntheticOnly:true},null,2));
  console.log('PASS: four widths, visible bar actions, keyboard combined actions/Convert/Back, Escape focus return, duration/add/details dialogs and delete handler, recurring/meeting/carryover menus. No destructive action submitted.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
