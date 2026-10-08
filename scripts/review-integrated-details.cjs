/* global __dirname, fetch, URL, window, document, innerWidth, console, process, openAddModal, closeAddModal, refoldTaskStateFromBlockCache, render, viewMode: writable */
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');const path=require('node:path');
const base='http://127.0.0.1:8301';const date='2026-10-06';
(async()=>{
 assert.equal((await(await fetch(base+'/api/health')).json()).database,'fixture');
 for(const [id,properties] of [
  ['detail-review',{local_id:'detail-review',title:'Prepare the project handoff with the revised launch notes',type:'task',start:'10:00',end:'10:30',duration:30,tags:[],commuteToMinutes:15}],
  ['detail-child',{local_id:'detail-child',title:'Attach the latest mockups',type:'task',subtaskOf:'detail-review',duration:0,start:'10:00',end:'10:00'}],
  ['detail-other',{local_id:'detail-other',title:'Second task for interrupted-flow checks',type:'task',start:'11:00',end:'11:30',duration:30}]
 ]){
  await fetch(base+'/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,type:'block',date,properties})});
  await fetch(base+'/api/blocks/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({properties})});
 }
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto(base);await page.waitForFunction(()=>window.blockStore&&typeof openAddModal==='function');
 await page.evaluate(async date=>{await window.blockStore.loadDay(date);refoldTaskStateFromBlockCache();render();},date);
 await page.evaluate(()=>openAddModal('detail-review'));
 await page.locator('#am-work-actions [data-work-action="start"]').waitFor();
 await page.waitForTimeout(5300); // Let the initial data-loaded notice clear for screenshots.
 assert.equal(await page.locator('#am-next-step').textContent(),'Attach the latest mockups');
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:844});await page.waitForTimeout(300);
  const geometry=await page.evaluate(()=>{const modal=document.querySelector('#add-modal-overlay .add-modal'),body=modal.querySelector('.add-modal-body'),r=modal.getBoundingClientRect(),a=document.querySelector('#am-work-actions').getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,overflow:body.scrollWidth>body.clientWidth,actionBottom:a.bottom,pageWidth:document.documentElement.scrollWidth,width:innerWidth};});
  assert(geometry.x>=0&&geometry.right<=width+1&&geometry.y>=0&&geometry.bottom<=845&&!geometry.overflow,JSON.stringify(geometry));
  assert(geometry.actionBottom<760,JSON.stringify(geometry));
  assert.equal(geometry.pageWidth,width,'header must fit at '+width);
  await page.screenshot({path:path.join(__dirname,'../design/task-details/screenshots/integrated-details-'+width+'.png')});
 }
 await page.setViewportSize({width:390,height:844});
 await page.locator('#am-work-actions [data-work-action="start"]').click();
 await page.locator('#am-work-actions [data-work-action="pause"]').waitFor();
 assert((await(await fetch(base+'/api/blocks/detail-review/work')).json()).block.properties.startedAt);
 await page.locator('#am-work-actions [data-work-action="pause"]').click();
 await page.locator('#am-work-actions [data-work-action="start"]').waitFor();
 assert(!(await(await fetch(base+'/api/blocks/detail-review/work')).json()).block.properties.startedAt);
 await page.locator('#add-modal-title').click();await page.locator('.am-title-edit').fill('Saved handoff title');await page.locator('.am-title-edit').press('Enter');
 await page.getByText('Task settings',{exact:true}).click();await page.locator('#am-commute-to-input').fill('20');
 await page.locator('#add-modal-save').click();
 await page.waitForFunction(async()=>{const b=await(await fetch('/api/blocks/detail-review/work')).json();return b.block.properties.title==='Saved handoff title'&&b.block.properties.commuteToMinutes===20;});
 await page.evaluate(()=>closeAddModal());await page.evaluate(()=>openAddModal('detail-review'));
 assert.equal(await page.locator('#add-modal-title').textContent(),'Saved handoff title');
 await page.locator('#add-modal-title').click();await page.locator('.am-title-edit').fill('Discard this draft');await page.locator('.am-title-edit').press('Enter');
 await page.locator('#add-modal-cancel-edit').click();assert.equal(await page.locator('#add-modal-title').textContent(),'Saved handoff title');
 await page.evaluate(()=>{closeAddModal();viewMode='archive';openAddModal('detail-review');});
 await page.waitForTimeout(300);
 assert(await page.locator('#am-work-actions button').first().isDisabled());
 assert(await page.locator('#am-item-input').isDisabled());
 assert.equal(await page.locator('#am-task-status').textContent(),'Archived · read only');
 await page.evaluate(()=>{closeAddModal();if(viewMode==='archive')viewMode='today';});
 console.log('PASS: integrated detail geometry at 320/390/768/1440; real synthetic work start/pause; serialized title/commute save and reopen; cancel draft; async archived controls.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
