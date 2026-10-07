/* global console, __dirname, fetch, URL, window, document, process, openAddModal, closeAddModal, refoldTaskStateFromBlockCache, render, viewMode: writable */
// Run against PORT=8319 DCC_REVIEW_TASK_DETAILS=1 npm run ui-review:serve.
// Health guard requires synthetic fixture storage before any writes.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base=process.env.DCC_DETAIL_REVIEW_URL || 'http://127.0.0.1:8319', date=new Date().toISOString().slice(0,10);
const out=require('node:path').resolve(__dirname,'../test-results/task-detail-tabs');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 assert.equal((await(await fetch(base+'/api/health')).json()).database,'fixture');
 for(const [id,properties] of [
 ['tabs-populated',{local_id:'tabs-populated',title:'Prepare project handoff',type:'task',duration:30,start:'10:00',end:'10:30',commuteToMinutes:15,tags:[],description:'Review the revised launch notes.',sourceReferences:[{url:'https://example.test/brief',name:'Project brief',kind:'link'}]}],
 ['tabs-child',{local_id:'tabs-child',title:'Attach the latest mockups',type:'task',subtaskOf:'tabs-populated',duration:0,start:'10:00',end:'10:00'}],
 ['tabs-empty',{local_id:'tabs-empty',title:'Empty detail example',type:'task',duration:30,start:'11:00',end:'11:30',tags:[]}]
 ]) await fetch(base+'/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,type:'block',date,properties})});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const checks=[], geometry=[], errors=[];
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
 await page.goto(base);await page.waitForFunction(()=>window.blockStore&&typeof openAddModal==='function');
 await page.evaluate(async d=>{await window.blockStore.loadDay(d);refoldTaskStateFromBlockCache();render();},date);
 const open=async id=>{await page.evaluate(id=>openAddModal(id),id);await page.locator('#am-work-actions button').first().waitFor();await page.waitForTimeout(150);};
 const tab=key=>page.locator('#am-tab-'+key);
 await page.locator('#triage-pill-nav').focus();await open('tabs-populated');
 assert.equal(await page.locator('#am-activity-entry').count(),0);
 assert.equal(await page.locator('.am-detail-panel:visible').count(),1);
 assert.equal(await tab('subtasks').getAttribute('aria-selected'),'true');
 assert((await page.locator('#am-items-list').innerText()).includes('Attach the latest mockups'));
 assert(await page.locator('#tab-bar').evaluate(e=>e.inert));
 await tab('subtasks').focus();await page.keyboard.press('ArrowRight');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'am-tab-notes');
 await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),'am-tab-automation');
 await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.id),'am-tab-subtasks');
 await page.keyboard.press('ArrowLeft');assert.equal(await page.evaluate(()=>document.activeElement.id),'am-tab-automation');
 await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.id),'am-tab-subtasks');
 checks.push('single visible panel; roving focus; ArrowLeft/Right wrap; Home/End; background inert');
 for(const id of ['tabs-populated','tabs-empty']){
  await page.evaluate(()=>closeAddModal());await open(id);
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:844});
   for(const key of ['subtasks','notes','settings','history','automation']){
    await tab(key).click();await page.waitForTimeout(70);
    assert.equal(await page.locator('.am-detail-panel:visible').count(),1);
    assert(await page.locator('#am-panel-'+key).isVisible());
    const g=await page.evaluate(()=>{const m=document.querySelector('#add-modal-overlay .add-modal'),b=m.querySelector('.add-modal-body'),r=m.getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,bodyOverflow:b.scrollWidth>b.clientWidth,tabOverflow:document.querySelector('.am-detail-tabs').scrollWidth>document.querySelector('.am-detail-tabs').clientWidth};});
    assert(g.x>=0&&g.right<=width+1&&g.y>=0&&g.bottom<=845&&!g.bodyOverflow&&!g.tabOverflow,JSON.stringify({id,width,key,g}));
    assert(await tab(key).evaluate(e=>e.getBoundingClientRect().height>=36));
    geometry.push({id,width,key,...g});
    if((width===390||width===1440)&&id==='tabs-populated') await page.screenshot({path:out+'/populated-'+width+'-'+key+'.png'});
    if(width===320&&id==='tabs-empty'&&key==='subtasks')await page.screenshot({path:out+'/empty-320.png'});
   }
  }
 }
 checks.push('empty/populated panels at 320/390/768/1440; no modal/body/tab clipping; minimum 36px tabs');
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>closeAddModal());await open('tabs-populated');
 await page.locator('#am-item-input').fill('Review checklist draft');await page.locator('#am-item-add').click();
 await page.waitForFunction(()=>document.querySelector('#am-items-list').textContent.includes('Review checklist draft'));
 await tab('notes').click();assert((await page.locator('#am-source-references').innerText()).includes('Project brief'));
 await page.locator('#am-source-form [name="url"]').fill('https://example.test/launch');
 await page.locator('#am-source-form [name="name"]').fill('Launch notes');await page.locator('#am-source-form button').click();
 await page.waitForFunction(()=>document.querySelector('#am-source-references').textContent.includes('Launch notes'));
 await page.evaluate(()=>window._amBlockEditor.setBlocks([{type:'paragraph',content:'Persist notes across tabs'}]));
 await tab('settings').click();await page.locator('#am-commute-to-input').fill('25');
 await tab('notes').click();assert((await page.locator('#am-notes-block-editor').innerText()).includes('Persist notes across tabs'));
 await tab('settings').click();await page.locator('#add-modal-save').click();
 await page.waitForFunction(async()=>{const r=await(await fetch('/api/blocks/tabs-populated/work')).json();return r.block.properties.commuteToMinutes===25;});
 assert(await tab('notes').isEnabled());await tab('notes').click();
 await page.locator('#add-modal-close').click();await open('tabs-populated');
 assert((await page.locator('#am-items-list').innerText()).includes('Review checklist draft'));
 await tab('notes').click();assert((await page.locator('#am-notes-block-editor').innerText()).includes('Persist notes across tabs'));
 assert((await page.locator('#am-source-references').innerText()).includes('Launch notes'));
 await tab('settings').click();await page.locator('#am-commute-to-input').fill('50');await page.locator('#add-modal-cancel-edit').click();
 assert.equal(await page.locator('#am-commute-to-input').inputValue(),'25');
 await tab('history').click();assert(await tab('history').isEnabled());
 checks.push('notes persist across switches and close/reopen; sources preserved; Save persists commute; Cancel restores; read-mode tabs enabled');
 await page.locator('#add-modal-edit').click();
 await page.locator('#am-work-actions [data-work-action="start"]').click();await page.locator('#am-work-actions [data-work-action="pause"]').waitFor();
 await page.locator('#am-work-actions [data-work-action="pause"]').click();await page.locator('#am-work-actions [data-work-action="start"]').waitFor();
 await tab('history').click();assert((await page.locator('#am-work-history').innerText()).trim().length>0);
 checks.push('Start/Pause retained; populated history renders');
 for(let i=0;i<3;i++){await tab('automation').click();await page.locator('#add-modal-close').click();await open('tabs-empty');assert.equal(await tab('subtasks').getAttribute('aria-selected'),'true');}
 await page.locator('#add-modal-title').focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'add-modal-save');
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'add-modal-title');
 await page.locator('#add-modal-close').click();assert(!await page.locator('#tab-bar').evaluate(e=>e.inert));
 await page.evaluate(()=>{viewMode='archive';openAddModal('tabs-empty');});await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>viewMode),'archive');
 await tab('notes').click();assert(await tab('notes').isEnabled());assert(await page.locator('#am-source-form button').isDisabled());
 await tab('automation').click();assert(await page.locator('#add-modal-repeat').isDisabled());
 checks.push('repeat open/close resets tab; dialog focus trap; inert restored; archived tabs navigate while editing remains blocked');
 await page.evaluate(()=>{closeAddModal();viewMode='today';openAddModal('tabs-empty');});await tab('automation').click();
 await page.locator('#add-modal-repeat').click();await page.waitForTimeout(250);
 assert(!await page.locator('#add-modal-overlay').evaluate(e=>e.classList.contains('open')));
 assert(await page.locator('#responsibility-modal-overlay').evaluate(e=>e.classList.contains('open')));
 checks.push('Make repeat retained and hands off from task detail');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(out+'/validation.json',JSON.stringify({checks,geometry,pageErrors:errors,syntheticOnly:true},null,2));
 console.log(JSON.stringify({checks,geometryCases:geometry.length,pageErrors:errors}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
