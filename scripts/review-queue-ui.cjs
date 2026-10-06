/* global __dirname, fetch, URL, window, document, innerWidth, getComputedStyle, console, process */
const {chromium}=require('playwright-core');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const base='http://127.0.0.1:8301';
(async()=>{
 const health=await(await fetch(base+'/api/health')).json();if(health.database!=='fixture')throw Error('Synthetic server required');
 for(const [id,properties] of [['waiting-review-one',{kind:'delegated_item',myTask:'Finalize the project estimate',title:'Supplier quote',delegatee:{name:'Alex'},notes:'Need the revised materials estimate before approving the plan.',status:'open',checkInDate:'2026-10-06',checkInRepeat:false,checkInDays:7}],['waiting-review-two',{kind:'delegated_item',myTask:'Book the workshop',delegatee:{name:'Facilities'},status:'open',checkInDate:'2026-10-12',checkInRepeat:false,checkInDays:7}]])await fetch(base+'/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,type:'block',date:null,properties})});
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(base);await page.waitForFunction(()=>window.openTasksDrawer&&window.blockStore);
  await page.evaluate(async()=>{await window.blockStore.loadGlobals();window.renderDelegatedSidebar();});
  await page.locator('#waiting-pill-nav').click();await page.locator('#tasks-drawer.open').waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({path:path.join(__dirname,'../design/task-details/screenshots/waiting-'+(process.argv[2]||'before')+'-390.png'),fullPage:false});
  console.log(await page.locator('#tasks-drawer').innerText());
  console.log(JSON.stringify(await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,dialog:document.querySelector('#tasks-drawer .side-drawer-body').getBoundingClientRect().toJSON()}))));
  await page.keyboard.press('Escape');
  const results=[];
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:844});
   await page.waitForTimeout(250);
   const baselineWidth=await page.evaluate(()=>document.documentElement.scrollWidth);
   for(const kind of ['triage','unscheduled','whenever','waiting']){
    await page.locator('#'+kind+'-pill-nav').click();
    await page.waitForTimeout(300);
    const state=await page.evaluate(()=>{
     const drawer=document.querySelector('#tasks-drawer');
     const rect=drawer.querySelector('.side-drawer-body').getBoundingClientRect();
     const visible=el=>!!el&&el.getBoundingClientRect().height>0&&getComputedStyle(el).display!=='none';
     return {queue:drawer.dataset.queue,title:document.querySelector('#tasks-drawer-title').textContent,
      x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom,width:innerWidth,
      overflow:document.documentElement.scrollWidth>innerWidth,pageWidth:document.documentElement.scrollWidth,
      contentOverflow:drawer.querySelector('.side-drawer-content').scrollWidth>drawer.querySelector('.side-drawer-content').clientWidth,
      tabs:visible(document.querySelector('#mobile-sheet-segments')),
      all:visible(document.querySelector('#tasks-drawer-all')),
      sections:[...drawer.querySelectorAll('.untimed-sub')].filter(visible).map(e=>e.id)};
    });
    assert.equal(state.queue,kind);assert.equal(state.title.toLowerCase(),kind);
    assert(state.pageWidth<=baselineWidth&&!state.contentOverflow&&!state.tabs&&!state.all,JSON.stringify(state));
    assert.equal(state.pageWidth,width,'page header fits at '+width);
    assert(state.x>=0&&state.y>=0&&state.right<=width+1&&state.bottom<=845,JSON.stringify(state));
    assert.deepEqual(state.sections,kind==='waiting'?[]:[kind+'-sub']);
    if(kind==='waiting'){
     const card=page.locator('.delegated-card[data-id="waiting-review-one"]');
     await card.locator('summary').click();assert(await card.locator('[data-delegated-action="edit"]').isVisible());
     await card.locator('summary').click();
     if(width===390||width===1440)await page.screenshot({path:path.join(__dirname,'../design/task-details/screenshots/waiting-after-'+width+'.png')});
    }
    results.push(state);await page.keyboard.press('Escape');
    assert.equal(await page.locator('#tasks-drawer').getAttribute('aria-hidden'),'true');
    assert.equal(await page.evaluate(()=>document.activeElement.id),kind+'-pill-nav');
   }
  }
  fs.writeFileSync(path.join(__dirname,'../design/task-details/screenshots/queue-viewport-checks.json'),JSON.stringify(results,null,2));
  console.log('PASS: 16 pill/viewport combinations; own queue only, on-screen dialog, no dialog overflow or added page overflow, More actions, Escape and focus return. Page header also fits at 768px. Synthetic data only.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
