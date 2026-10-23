/* global __dirname, process, console, document, window, getComputedStyle, dStart, dEnd, dOver, dDrop, dBlockOver, dBlockDrop, writes, scheduled, messages, row, anchor, DCC, refoldTaskStateFromBlockCache, openSchedulePopover */
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
// Synthetic fixtures only: no live app requests or existing browser profiles.
const repo=path.resolve(__dirname,'..');
const output=path.resolve(process.argv[2]||'/tmp/dcc-unscheduled-browser');
fs.mkdirSync(output,{recursive:true});
const {chromium}=require('playwright-core');
const read=p=>fs.readFileSync(path.join(repo,p),'utf8');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.DCC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800},timezoneId:'America/New_York'});
  await page.route('**/*',route=>route.abort());
  await page.setContent(`<div id="list-view"><div class="it-list-item" id="anchor" style="position:absolute;left:70px;top:130px;width:400px;height:90px">Respond fixture 11:30–12:00</div><div class="time-block-drop-zone" id="zone" data-block-start="19:00" style="position:absolute;left:70px;top:600px;width:400px;height:80px">Evening block</div></div><div class="side-drawer-backdrop show"></div><div class="side-drawer open queue-focused" id="tasks-drawer" data-queue="unscheduled"><div class="side-drawer-body"><h2>Unscheduled</h2><div id="source" class="it-list-item" draggable="true" style="height:90px;padding:15px">Bankrate fixture <button id="schedule">Schedule</button></div><div id="other" class="it-list-item" style="height:90px">Another unscheduled fixture</div></div></div>`);
  await page.addStyleTag({content:read('public/css/dashboard.css')});
  await page.addStyleTag({content:read('public/css/ui-optimization.css')});
  await page.addStyleTag({content:'.it-drag-ghost{pointer-events:none!important;position:fixed;z-index:9999}.it-list-item{background:#dde4f0;color:#172033}'});
  await page.addScriptTag({content:read('public/js/task-model.js')});
  await page.addScriptTag({content:`
   var row={id:'bankrate-row',type:'block',date:null,properties:{local_id:'bankrate-fixture',title:'Bankrate fixture',duration:30,responsibilityId:'definition-fixture'}};
   var anchor={id:'anchor',title:'Respond fixture',type:'meeting',start:'11:30',end:'12:00'};
   var scheduled=[anchor,DCC.TaskModel.fromBlock(row)],viewDate='2026-10-22',__state={date:viewDate},messages=[],writes=[];
   function pt(t){return Number(t.slice(0,2))*60+Number(t.slice(3))}function fmt(n){return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')}
   function dur(t){return pt(t.end)-pt(t.start)}function _viewedDateStr(){return viewDate}function _prettyDateLabel(d){return d}
   function _findTaskBlockForDate(){return row}function showToast(m,k){messages.push({m,k})}function render(){}
   function isDone(){return false}function parentIdOf(t){return t.subtaskOf||t.wrapId||null}function isMeeting(t){return t.type==='meeting'}function isFixed(t){return isMeeting(t)}
   function refoldTaskStateFromBlockCache(){scheduled=[anchor,DCC.TaskModel.fromBlock(JSON.parse(JSON.stringify(row)))]}
   window.blockStore={rescheduleBlock:async(id,date,o)=>{writes.push({id,date,start:o.parentStart,end:o.parentEnd});o.onQueued();await new Promise(r=>setTimeout(r,50));row.date=date;row.properties.start=o.parentStart;row.properties.end=o.parentEnd;return {moved:[id],blocks:[row]}}};
   window.closeTasksDrawer=()=>{document.querySelector('#tasks-drawer').classList.remove('open');document.querySelector('.side-drawer-backdrop').classList.remove('show')};
  `});
  const state=read('public/js/state.js');
  await page.addScriptTag({content:state.slice(state.indexOf('const _untimedPlacements ='),state.indexOf('// Restore a task from the amber'))});
  await page.addScriptTag({content:read('public/js/drag.js')});
  await page.evaluate(()=>{
   document.querySelector('#source').addEventListener('dragstart',e=>dStart(e,'bankrate-fixture'));
   document.querySelector('#source').addEventListener('dragend',dEnd);
   const target=document.querySelector('#anchor');target.addEventListener('dragover',e=>dOver(e,'anchor'));target.addEventListener('drop',e=>dDrop(e,'anchor'));
   const zone=document.querySelector('#zone');zone.addEventListener('dragover',dBlockOver);zone.addEventListener('drop',dBlockDrop);
  });
  await page.waitForTimeout(250);
  const browserErrors=[];page.on('pageerror',e=>browserErrors.push(e.message));
  await page.screenshot({path:path.join(output,'unscheduled-before-debug.png')});
  const source=await page.locator('#source').boundingBox();

  await page.mouse.move(source.x+40,source.y+30);await page.mouse.down();
  await page.mouse.move(source.x+45,source.y+35,{steps:3});
  await page.mouse.move(80,100,{steps:15});
  await page.waitForFunction(()=>document.body.classList.contains('unscheduled-drag-out'),null,{timeout:3000});
  assert.equal(await page.locator('#tasks-drawer .side-drawer-body').evaluate(e=>getComputedStyle(e).pointerEvents),'none');
  await page.mouse.move(200,205,{steps:8});await page.mouse.move(201,206);await page.mouse.up();
  await page.waitForFunction(()=>writes.length===1&&!scheduled[1].untimed);
  const result=await page.evaluate(()=>({writes,messages,row,anchor,projected:DCC.TaskModel.fromBlock(JSON.parse(JSON.stringify(row)))}));
  assert.deepEqual(result.writes,[{id:'bankrate-row',date:'2026-10-22',start:'12:00',end:'12:30'}]);
  assert.equal(result.anchor.start,'11:30');assert.equal(result.projected.untimed,false);assert.equal(result.projected.id,'bankrate-fixture');
  assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('unscheduled-drag-out')),false);
  await page.screenshot({path:path.join(output,'unscheduled-drag-browser.png')});
  await page.addScriptTag({content:read('public/js/schedule-popover.js')});
  await page.evaluate(()=>{
    window.escHtml=s=>String(s);window.ms=n=>n+'m';
    row.date=null;delete row.properties.start;delete row.properties.end;refoldTaskStateFromBlockCache();
    document.querySelector('#tasks-drawer').classList.add('open');document.querySelector('.side-drawer-backdrop').classList.add('show');
    document.querySelector('#schedule').onclick=()=>openSchedulePopover({mode:'reschedule',view:'time',id:'bankrate-fixture',anchorEl:document.querySelector('#schedule')});
  });
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
  await page.locator('#schedule').focus();await page.keyboard.press('Enter');
  await page.getByLabel('Start time',{exact:true}).fill('12:00');
  await page.keyboard.press('Tab');
  await page.waitForFunction(()=>writes.length===2&&!scheduled[1].untimed);
  assert.deepEqual(await page.evaluate(()=>writes[1]),{id:'bankrate-row',date:'2026-10-22',start:'12:00',end:'12:30'});
  assert.deepEqual(browserErrors,[]);
  await page.screenshot({path:path.join(output,'unscheduled-mobile-browser.png')});
  fs.writeFileSync(path.join(output,'unscheduled-browser-evidence.json'),JSON.stringify({passed:true,browser:'Headless Chromium',timezone:'America/New_York',scenarios:['Native mouse drag from Unscheduled modal to after fixed 11:30–12:00 anchor','390px keyboard-opened scheduling alternative with labelled time control'],...result},null,2));
  console.log('PASS native drag; 12:00–12:30 saved placement; same ID; fixed anchor unchanged; modal cleanup; rehydrated classification; mobile keyboard scheduling');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
