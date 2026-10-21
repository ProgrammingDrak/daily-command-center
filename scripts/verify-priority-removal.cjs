/* Fixture-only browser regression. Start scripts/ui-review-server.mjs with
   DCC_REVIEW_TASK_DETAILS=1 and pass its URL. Uses a fresh browser profile. */
const assert=require('node:assert/strict');
const {chromium}=require(process.env.DCC_PLAYWRIGHT_MODULE||'playwright-core');
const base=process.argv[2]||'http://127.0.0.1:8107';
const oldView={activeViewId:'all-open',query:'',filters:[{key:'priority',op:'in',value:['High']}],columns:['select','title','priority','readiness','duration'],sort:{key:'priority',dir:'desc'},groupBy:'priority',matrixRows:'priority',matrixColumns:'priority',mode:'table'};
const tasks=[['high','High',2],['low','Low',1],['waiting','High',3]].map(([id,priority,sort_order])=>({id,type:'block',date:null,sort_order,properties:{kind:'backlog',local_id:id,title:id,priority,stage:id==='high'?'Priority':'Backlog',duration:30}}));
const payload={tasks,projects:[],facets:[],views:[{id:'saved',properties:{name:'Legacy saved view',...oldView}}],builtinViews:[],readiness:{waiting:{state:'blocked',total:1,satisfied:0,blockers:[]}}};
(async()=>{const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});try{
for(const width of [1440,375]){
 const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>window.DCCTaskLibrary&&typeof scheduled!=='undefined'&&scheduled.length>0);
 await page.evaluate(()=>{openAddModal('review-detail-task');});
 await page.waitForSelector('#add-modal-overlay.open');
 assert.doesNotMatch(await page.locator('#add-modal-overlay').innerText(),/high priority|priority:/i);
 assert.equal(await page.locator('#notes-action-priority,#dm-action-priority,#td-new-priority,#tg-add-fixed-pri,[data-field="priority"]').count(),0);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no page overflow '+width);
 await page.screenshot({path:'/tmp/dcc-priority-details-'+width+'.png',fullPage:true});
 await page.evaluate(()=>closeAddModal());
 const ordering=await page.evaluate(()=>{const before=scheduled.map(t=>t.id);scheduled.forEach((t,i)=>{t.priority=i%2?'High':'Low';});render();return {before,after:scheduled.map(t=>t.id)};});
 assert.deepEqual(ordering.after,ordering.before);assert.deepEqual(errors,[]);console.log('PASS task details, controls, ordinary ordering, overflow and browser errors at '+width+'px');
 await context.close();
}
for(const source of ['local','url','saved']){
 const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
 await page.route('**/api/task-library',route=>route.fulfill({json:payload}));
 if(source==='local')await context.addInitScript(view=>localStorage.setItem('dcc.task-library.state.v1',JSON.stringify(view)),oldView);
 await page.goto(base+(source==='url'?'/?tl='+Buffer.from(JSON.stringify(oldView)).toString('base64'):''));
 await page.waitForSelector('.tlb-table');
 if(source==='saved'){await page.evaluate(()=>openTasksToSection('tm-task-library-section'));await page.locator('[data-view-id="saved"]').click();}
 const names=await page.locator('.tlb-title-btn').allTextContents();
 assert.deepEqual(names,['low','high','waiting'],source+' retained tasks and canonical order');
 assert.equal(await page.locator('[data-sort="priority"],.tlb-priority').count(),0);
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('dcc.task-library.state.v1')));
 assert.equal(stored.filters.length,0);assert.equal(stored.groupBy,'none');assert.notEqual(stored.matrixRows,'priority');assert.notEqual(stored.matrixColumns,'priority');
 // An unrelated Waiting filter must survive alongside the obsolete priority filter.
 await page.evaluate(view=>localStorage.setItem('dcc.task-library.state.v1',JSON.stringify({...view,filters:[...view.filters,{key:'status',op:'in',value:['waiting']}]})),oldView);
 await page.goto(base+'/?tl='+Buffer.from(JSON.stringify({...oldView,filters:[...oldView.filters,{key:'status',op:'in',value:['waiting']}]})).toString('base64'));await page.waitForSelector('.tlb-table');
 assert.deepEqual(await page.locator('.tlb-title-btn').allTextContents(),['waiting']);
 console.log('PASS '+source+' legacy view and Waiting filter compatibility');await context.close();
}
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
