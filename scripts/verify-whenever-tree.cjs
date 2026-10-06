const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const {chromium}=require('playwright-core');
const plan=require(root+'/lib/whenever-placement').plan;
const source=file=>fs.readFileSync(root+'/'+file,'utf8');
const slice=(file,start,end)=>{const s=source(file);return s.slice(s.indexOf(start),s.indexOf(end,s.indexOf(start)));};
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
for(const width of [1280,390]){
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('__plan',payload=>plan(payload.parent,payload.rows,payload.args));
 await page.setContent('<style>'+source('public/css/tokens.css')+source('public/css/dashboard.css')+source('public/css/ui-optimization.css')+'</style><div style="max-width:740px;padding:12px;margin:10px auto" class="queue-theme--sage"><h2>Whenever <span id="whenever-count"></span></h2><div id="whenever-list"></div><button id="whenever-pick">Surprise me</button></div>');
 await page.addScriptTag({path:root+'/public/js/task-model.js'});await page.addScriptTag({path:root+'/public/js/task-serialize.js'});await page.addScriptTag({path:root+'/public/js/task-sources.js'});await page.addScriptTag({path:root+'/public/js/itinerary-card.js'});
 await page.evaluate(()=>{
  window.rows=[{id:'row-parent',type:'block',date:null,workspace_id:'mine',properties:{local_id:'parent',kind:'backlog',stage:'Whenever',title:'Grab things from my house',type:'task',duration:30,durMin:30,publicVisibility:'private',source:'slack',source_id:'https://clever.slack.com/archives/C1/p1'}}];
  window.scheduled=[];window.backlog=rows.map(DCC.TaskModel.fromBacklogBlock);window.consider=[];window.viewDate='2026-10-06';window.deletedSet=new Set();window.manualDone=new Set();window.__completed=[];window.__writes=[];window.__fail=false;
  window.isDone=ev=>manualDone.has(ev.id)||ev.status==='done';window.escHtml=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));window.showToast=(message,type)=>{window.__toast={message,type};};window.render=()=>{if(window.buildWhenever)buildWhenever();};window._resolvedTodayDate=()=>viewDate;
  window.fmt=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');window.pt=s=>Number(s.slice(0,2))*60+Number(s.slice(3));window.ms=n=>n+'m';window.dur=ev=>ev.duration??ev.durMin??30;
  window.taskAnchorById=id=>{const ev=backlog.find(t=>t.id===id);return ev?{ev,date:null,blockId:ev._blockId,whenever:true}:null;};
  window.blockStore={getByType:()=>rows.filter(r=>!r.deleted_at),get:id=>rows.find(r=>r.id===id),createBlock:async(type,properties,extra)=>{const row={id:'created-'+rows.length,type,properties,date:extra.date,workspace_id:'mine'};rows.push(row);return row;},rescheduleBlock:async(id,targetDate,args)=>{
   if(__fail)throw new Error('Synthetic write rejected');const result=await __plan({parent:rows.find(r=>r.id===id),rows,args:{targetDate,...args}});__writes.push(result.ids);
   result.moves.forEach(move=>{const row=rows.find(r=>r.id===move.id);Object.assign(row,{date:move.date,properties:move.properties});});return {moved:result.ids,blocks:rows.filter(r=>result.ids.includes(r.id))};
  }};
  window.enqueueRowPropsWrite=async(id,merge,extra)=>{const row=rows.find(r=>r.id===id);row.properties=merge(row.properties);if(extra&&extra.parent_id!==undefined)row.parent_id=extra.parent_id;return row;};
  window.refoldTaskStateFromBlockCache=()=>{backlog=DCC.TaskModel.selectWheneverPoolBlocks(rows).map(DCC.TaskModel.fromBacklogBlock);scheduled=rows.filter(r=>r.date===viewDate).map(DCC.TaskModel.fromBlock);};window.recalcTimes=()=>{};window._computeRescheduleSlot=async()=>({start:'10:00',end:'10:30'});
  window.rescheduleTaskToDate=async()=>{};window.toggleDone=id=>{__completed.push(id);manualDone.add(id);};window.persistRowProp=()=>Promise.resolve();window.openAddModal=(id,title)=>{window.__opened={id,title};};window.openDeleteConfirm=id=>{window.__deleted=id;};window.openDurPopover=ev=>setDurAbsolute(ev.id,45);
 });
 await page.addScriptTag({content:slice('public/js/tabs.js','function addSubtask(','// Re-read the carryover')});await page.addScriptTag({content:slice('public/js/tabs.js','function addStackedTask(','// Re-parent an EXISTING')});await page.addScriptTag({content:slice('public/js/tabs.js','function openTaskAdd(','// Legacy name;')});await page.addScriptTag({content:slice('public/js/schedule.js','function addToSchedule(','function addFollowupToSchedule(')});await page.addScriptTag({content:slice('public/js/schedule.js','function setDurAbsolute(','// ======== START TIME ADJUSTMENT')});
 await page.addScriptTag({path:root+'/public/js/whenever.js'});
 assert.equal(await page.locator('.whenever-row.it-list-item').count(),1);
 await page.getByRole('button',{name:'Add subtask or nested task to Grab things from my house',exact:true}).click();await page.locator('.sub-add-input').fill('Pack charger');await page.locator('.sub-add-go').click();await page.waitForFunction(()=>rows.length===2);
 await page.locator('.task-add-place[data-place=nested]').click();await page.locator('.sub-add-input').fill('Choose supplies');await page.locator('.sub-add-go').click();await page.waitForFunction(()=>rows.length===3);await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Add subtask or nested task to Choose supplies',exact:true}).click();await page.locator('.sub-add-input').fill('Collect the cables');await page.locator('.sub-add-go').click();await page.waitForFunction(()=>rows.length===4);await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('.whenever-row').length===4);
 assert.equal(await page.locator('#whenever-count').textContent(),'1');assert.deepEqual(await page.evaluate(()=>rows.map(r=>r.date)),[null,null,null,null]);assert.equal(await page.evaluate(()=>scheduled.length),0);
 await page.getByRole('button',{name:'Collapse Grab things from my house',exact:true}).click();assert.equal(await page.locator('.whenever-row').count(),1);await page.getByRole('button',{name:'Expand Grab things from my house',exact:true}).click();assert.equal(await page.locator('.whenever-row').count(),4);
 await page.getByRole('button',{name:'Open task details: Grab things from my house',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>__opened.id),'parent');
 await page.locator('.whenever-row[data-id=parent] .btn-duration').click();assert.equal(await page.evaluate(()=>rows[0].properties.duration),45);
 await page.evaluate(()=>{refoldTaskStateFromBlockCache();buildWhenever();});assert.equal(await page.locator('.whenever-row').count(),4);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:'/tmp/whenever-tree-'+width+'.png'});
 await page.evaluate(()=>__fail=true);await page.locator('.whenever-row[data-id=parent] .whenever-now').click();await page.waitForFunction(()=>__toast&&__toast.type==='error');assert.equal(await page.evaluate(()=>rows.every(r=>r.date===null)),true);assert.equal(await page.locator('.whenever-row').count(),4);
 await page.evaluate(()=>__fail=false);await page.locator('.whenever-row[data-id=parent] .whenever-now').click();await page.waitForFunction(()=>scheduled.length===4);assert.equal(await page.evaluate(()=>__writes.length),1);assert.equal(await page.evaluate(()=>rows.every(r=>r.date==='2026-10-06')),true);assert.equal(await page.evaluate(()=>scheduled.find(t=>t.title==='Collect the cables').subtaskOf),await page.evaluate(()=>scheduled.find(t=>t.title==='Choose supplies').id));assert.deepEqual(errors,[]);
 await page.evaluate(()=>{rows.forEach(row=>{row.date=null;row.properties.kind='backlog';row.properties.stage='Whenever';});__writes=[];refoldTaskStateFromBlockCache();buildWhenever();});
 await page.evaluate(()=>DCC.Whenever.markDone(backlog.find(t=>t.title==='Collect the cables').id));
 assert.equal(await page.evaluate(()=>__writes.length),1);assert.equal(await page.evaluate(()=>scheduled.length),4);assert.deepEqual(await page.evaluate(()=>__completed),[await page.evaluate(()=>scheduled.find(t=>t.title==='Collect the cables').id)]);
 console.log('PASS Whenever '+width+'px: shared row, normal add picker, subtask, nested task, grandchild, collapse, keyboard editor, duration, reload, failed move, atomic schedule, no overflow');await page.close();
}
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exit(1)});
