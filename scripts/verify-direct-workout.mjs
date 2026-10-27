// Local synthetic acceptance only. Never run against a user database or live browser.
/* global document, window, schedView:writable, buildSchedule, render */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require=createRequire(import.meta.url),W=require('../public/js/workout-model');
const base=process.argv[2]||'http://127.0.0.1:8198';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname));
const json=async(url,method='GET',body)=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,200,await response.clone().text());return response.json();};
const info=await json('/api/activity-review-info');assert.equal(info.synthetic,true);assert.equal(info.storage,'memory');
const out=path.resolve(process.env.DCC_QA_OUTPUT||'/tmp/direct-workout-qa');await fs.mkdir(out,{recursive:true});
const plan=W.empty();
plan.plan.exercises=[['bench','bench-press','Bench Press',[170,175,180],6,8,'total'],['ohp','overhead-barbell-press','Overhead Barbell Press',[95,95,95,95],10,12,'total'],['curls','dumbbell-curls','Dumbbell Curls',[35,35,35,35],10,null,'per-dumbbell']].map(([id,catalogExerciseId,name,loads,reps,repsMax,loadMode])=>({id,catalogExerciseId,name,sets:loads.map((weight,i)=>({id:id+'-'+i,round:i+1,...W.measurement({weight,reps,loadMode}),...(repsMax?{repsMax}:{})}))}));
plan.plan.groups=[{id:'bench-group',kind:'single',rounds:3,exerciseIds:['bench']},{id:'superset',kind:'superset',rounds:4,exerciseIds:['ohp','curls']}];
// Give each run distinct canonical exercise IDs so other synthetic runs cannot supply history.
for(const e of plan.plan.exercises){const def=await json('/api/activity/exercises','POST',{name:'Fixture '+e.name+' '+crypto.randomUUID(),loadMode:e.sets[0].loadMode});e.catalogExerciseId=def.id;}
const yesterday=new Date(Date.parse(info.date+'T12:00:00Z')-86400000).toISOString().slice(0,10);
const previous=structuredClone(plan);previous.occurredOn=yesterday;previous.baseline=structuredClone(previous.plan);
previous.actual.sets=[{id:'prev-bench',exerciseId:'bench',planSetId:'bench-0',round:1,status:'logged',loggedAt:null,...W.measurement({reps:7,weight:165})},{id:'prev-curls',exerciseId:'curls',planSetId:'curls-0',round:1,status:'logged',loggedAt:null,...W.measurement({reps:9,weight:15,unit:'kg',loadMode:'per-dumbbell'})}];
await json('/api/activity/tasks','POST',{title:'SYNTHETIC previous strength',date:yesterday,record:previous});
const title='SYNTHETIC Strength Training '+Date.now();
const row=await json('/api/activity/tasks','POST',{title,date:info.date,duration:45,record:plan});
// Distinct local and canonical IDs catch task-detail navigation mistakes.
await json('/api/blocks/'+row.taskId,'PATCH',{properties:{...(await json('/api/blocks/'+row.taskId)).properties,local_id:'synthetic-workout-local-'+row.taskId,all_day:false,all_day_start:null,all_day_end:null,start:'08:00',end:'08:45',duration:45,untimed:false}});
const browser=await chromium.launch({headless:true,...(process.env.DCC_CHROMIUM_PATH?{executablePath:process.env.DCC_CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1440,height:1050},reducedMotion:'reduce'}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const mark=s=>{checks.push(s);console.log('PASS '+s);};
const planner=()=>page.locator('.wp-dialog .workout-planner');
const action=a=>planner().locator('[data-w-act="'+a+'"]');
const close=async()=>{await page.locator('.wp-dialog .dcc-overlay-actions').getByRole('button',{name:'Close',exact:true}).click();await page.locator('.wp-dialog').waitFor({state:'detached'});};
const loaded=async()=>{await planner().locator('.wp-status').waitFor();};
const openList=async()=>{await page.locator('.svt-btn[data-view="list"]').click();await page.locator('#list-view .ttl').filter({hasText:title}).click();await loaded();};
const setRow=(id,t)=>planner().locator('[data-entry-id="'+id+'"][data-target-id="'+t+'"]');
const overflow=async()=>assert.equal(await planner().evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
try{
 await page.goto(base);await page.locator('#api-loading').waitFor({state:'detached'});
 await openList();assert.match(await planner().innerText(),/6–8 reps · 170 lb total/);assert.match(await planner().innerText(),/6–8 reps · 175 lb total/);assert.match(await planner().innerText(),/6–8 reps · 180 lb total/);
 assert.equal(await planner().locator('.wp-set-row').count(),11);assert.equal(await planner().locator('.wp-round h4').count(),4);
 assert.match(await setRow('curls','curls-0').innerText(),/35 lb per hand/);assert.match(await setRow('ohp','ohp-0').innerText(),/10–12 reps · 95 lb/);
 assert.match(await setRow('bench','bench-0').innerText(),/7 reps · 165 lb/);assert.match(await setRow('bench','bench-1').innerText(),/No matching recorded set/);
 assert.equal(await setRow('bench','bench-0').getByLabel('Actual reps',{exact:true}).inputValue(),'');
 assert.equal((await json('/api/activity/tasks/'+row.taskId)).record.actual.sets.length,0);
 await overflow();await page.screenshot({path:path.join(out,'desktop-plan.png'),fullPage:false});mark('List title opens exact targets, four superset rounds, per-hand load and real prior sets directly');
 await page.locator('.wp-dialog .dcc-overlay-actions').getByRole('button',{name:'Task details',exact:true}).click();
 await page.locator('#add-modal-overlay.open').waitFor();await page.locator('.wp-dialog').waitFor({state:'detached'});assert.match(await page.locator('#am-activity-entry').innerText(),/Open workout/);
 // Internal Cancel must rebuild generic details instead of opening another workout overlay.
 await page.evaluate(()=>window.cancelAddModalEdits());assert.equal(await page.locator('.wp-dialog').count(),0);assert.equal(await page.locator('#add-modal-overlay.open').count(),1);
 await page.locator('#am-activity-entry button').click();await loaded();mark('Generic details and Cancel preserve the distinct local task ID and return to workout');
 await close();await page.evaluate(()=>{schedView='plan';render('schedule');buildSchedule();document.getElementById('timeline').style.display='block';document.getElementById('list-view').style.display='none';});
 await page.locator('#timeline .ttl').filter({hasText:title}).click();await loaded();await close();mark('Timeline title opens the same dedicated workout');
 await openList();await action('edit-plan').click();await planner().locator('[data-w-path="plan.exercises.0.sets.0.repsMax"]').fill('9');await action('save').click();await planner().getByRole('status').filter({hasText:/Synced/}).waitFor();await action('view-session').click();
 assert.match(await setRow('bench','bench-0').innerText(),/6–9 reps/);assert.equal((await json('/api/activity/tasks/'+row.taskId)).record.actual.sets.length,0);
 await page.reload();await page.locator('#api-loading').waitFor({state:'detached'});await openList();assert.match(await setRow('bench','bench-0').innerText(),/6–9 reps/);mark('Plan save/reload retains ranges and creates no actuals');
 await action('extra').first().click();await page.getByRole('button',{name:'Cancel',exact:true}).click();await loaded();assert.match(await planner().innerText(),/Plan & track/);mark('Subdialog Cancel returns to focused workout');
 await setRow('bench','bench-0').getByLabel('Actual reps',{exact:true}).fill('7');await setRow('bench','bench-0').getByLabel('Actual load',{exact:true}).fill('170');
 const save=page.waitForResponse(r=>r.url().endsWith('/api/activity/tasks/'+row.taskId)&&r.request().method()==='PUT');await setRow('bench','bench-0').getByRole('button',{name:'Log set',exact:true}).dblclick();assert.equal((await save).status(),200);await planner().getByRole('status').filter({hasText:/Synced/}).waitFor();
 let saved=await json('/api/activity/tasks/'+row.taskId);assert.equal(saved.record.actual.sets.length,1);assert.equal(saved.completed,false);assert.equal(saved.record.session.events.length,0);assert.match(await setRow('bench','bench-0').innerText(),/Reps on target · Load on target/);
 await page.reload();await page.locator('#api-loading').waitFor({state:'detached'});await openList();assert.match(await setRow('bench','bench-0').innerText(),/7 reps · 170 lb/);mark('Explicit logging survives reload without duplicate sets, duration or task completion');
 // Concurrent edits keep local intent until an explicit reload.
 await setRow('bench','bench-1').getByLabel('Actual reps',{exact:true}).fill('5');
 saved=await json('/api/activity/tasks/'+row.taskId);await json('/api/activity/tasks/'+row.taskId,'PUT',{record:saved.record,expectedRevision:saved.revision,mutationId:crypto.randomUUID()});
 await setRow('bench','bench-1').getByRole('button',{name:'Log set',exact:true}).click();await planner().getByRole('status').filter({hasText:'Not saved'}).waitFor();assert.match(await planner().locator('[role="alert"]').innerText(),/changed|revision|conflict/i);assert.equal((await json('/api/activity/tasks/'+row.taskId)).record.actual.sets.length,1);
 await action('reload').click();await action('retry').waitFor({state:'detached'});mark('Stale revision rejects overwrite and reload recovers');
 // Reject one request, then retry the identical payload.
 const payloads=[];await page.route('**/api/activity/tasks/'+row.taskId,async route=>{if(route.request().method()==='PUT'){payloads.push(route.request().postDataJSON());if(payloads.length===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic offline failure'})});}return route.continue();});
 await setRow('bench','bench-1').getByLabel('Actual reps',{exact:true}).fill('5');await setRow('bench','bench-1').getByLabel('Actual load',{exact:true}).fill('80');await setRow('bench','bench-1').locator('[data-w-path="drafts.bench__bench-1.unit"]').selectOption('kg');await setRow('bench','bench-1').getByRole('button',{name:'Log set',exact:true}).click();await action('retry').click();await planner().getByRole('status').filter({hasText:/Synced/}).waitFor();assert.deepEqual(payloads[0],payloads[1]);assert.match(await setRow('bench','bench-1').innerText(),/-1 reps below target/);assert.match(await setRow('bench','bench-1').innerText(),/\+1.4 lb vs target/);await page.unroute('**/api/activity/tasks/'+row.taskId);mark('Failed save retains exact retry; kg/lb and below-target comparison are accurate');
 for(const width of [390,375,320]){await close();await page.setViewportSize({width,height:844});await openList();await overflow();assert.equal(await setRow('curls','curls-0').getByLabel('Actual reps',{exact:true}).isVisible(),true);await page.screenshot({path:path.join(out,'mobile-'+width+'.png'),fullPage:false});}
 await setRow('curls','curls-0').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'mobile-superset-320.png')});
 mark('Mobile 390/375/320px direct entry and actual inputs without horizontal overflow');
 assert.deepEqual(errors,[]);saved=await json('/api/activity/tasks/'+row.taskId);assert.equal(saved.taskId,row.taskId);assert.equal(saved.completed,false);assert.equal(saved.record.actual.sets.length,2);assert.equal(saved.record.session.events.length,0);
 // Reproduce the existing record shape: ranges authored as card notes before native ranges existed.
 const flex=structuredClone(plan);flex.plan.runs=[];
 flex.plan.exercises[0].movement={goalKind:'strength',visualInstructions:'PLANNED BENCH — 3 sets, 6–8 reps each. Loads 170 / 175 / 180 lb total.'};
 flex.plan.exercises[1].movement={goalKind:'strength',visualInstructions:'PLANNED SUPERSET — 4 rounds. Overhead press 95 lb for 10–12 reps, then curls 35 lb per hand for 10 reps.'};
 for(const e of flex.plan.exercises.slice(0,2))for(const t of e.sets){t.reps=null;delete t.repsMax;}
 const flexTitle='SYNTHETIC flexible actuals '+Date.now(),flexRow=await json('/api/activity/tasks','POST',{title:flexTitle,date:info.date,record:flex});
 await page.reload();await page.locator('#api-loading').waitFor({state:'detached'});await page.locator('#list-view .ttl').filter({hasText:flexTitle}).click();await loaded();
 assert.match(await planner().innerText(),/6–8 reps each/);assert.match(await planner().innerText(),/10–12 reps/);
 const logActual=async(id,target,reps,load,perSide=false)=>{const el=setRow(id,target);await el.getByLabel('Actual reps',{exact:true}).fill(String(reps));await el.getByLabel('Actual load',{exact:true}).fill(String(load));if(perSide){await el.locator('summary').click();await el.locator('[data-w-path$=".repsMode"]').selectOption('per-side');}const response=page.waitForResponse(r=>r.url().endsWith('/api/activity/tasks/'+flexRow.taskId)&&r.request().method()==='PUT');await el.getByRole('button',{name:'Log set',exact:true}).click();assert.equal((await response).status(),200);await planner().getByRole('status').filter({hasText:/Synced/}).waitFor();};
 await logActual('bench','bench-0',8,136);await logActual('bench','bench-1',8,157.5);await logActual('bench','bench-2',6,165);
 await setRow('bench','bench-0').getByRole('button',{name:'Edit actual',exact:true}).click();await page.getByLabel('Load',{exact:true}).fill('135');await page.getByRole('button',{name:'Save actual',exact:true}).click();await loaded();
 await action('extra').first().click();await page.getByLabel('Reps',{exact:true}).fill('3');await page.getByLabel('Load',{exact:true}).fill('180');await page.getByRole('button',{name:'Log extra set',exact:true}).click();await loaded();
 await planner().locator('.wp-extra .wp-saved-result').getByRole('button',{name:'Edit actual',exact:true}).click();await page.getByLabel('Load',{exact:true}).fill('185');await page.getByRole('button',{name:'Save actual',exact:true}).click();await loaded();
 for(let i=0;i<3;i++){await logActual('ohp','ohp-'+i,[6,8,8][i],95);await logActual('curls','curls-'+i,10,30,true);}
 let flexibleSaved=await json('/api/activity/tasks/'+flexRow.taskId);assert.equal(flexibleSaved.record.actual.sets.length,10);assert.deepEqual(flexibleSaved.record.plan,W.validate(flex).plan);assert.deepEqual(flexibleSaved.record.baseline,W.validate(flex).plan);assert.equal(flexibleSaved.completed,false);assert.equal(flexibleSaved.record.session.events.length,0);
 assert.deepEqual(flexibleSaved.record.actual.sets.filter(a=>a.exerciseId==='bench').map(a=>[a.weight,a.reps]),[[135,8],[157.5,8],[165,6],[185,3]]);assert.equal(flexibleSaved.record.actual.sets.filter(a=>a.status==='skipped').length,0);
 assert.equal(await setRow('ohp','ohp-3').getByLabel('Actual reps',{exact:true}).inputValue(),'');assert.equal(await setRow('curls','curls-3').getByLabel('Actual load',{exact:true}).inputValue(),'');
 assert.match(await planner().innerText(),/4 confirmed \/ 3 planned · 1 extra · 0 without a recorded result/);assert.match(await planner().innerText(),/3 confirmed \/ 4 planned · 0 extra · 1 without a recorded result/);
 await page.reload();await page.locator('#api-loading').waitFor({state:'detached'});await page.locator('#list-view .ttl').filter({hasText:flexTitle}).click();await loaded();await overflow();await page.screenshot({path:path.join(out,'flexible-actuals-mobile.png')});
 await page.setViewportSize({width:1440,height:1050});await page.screenshot({path:path.join(out,'flexible-actuals-desktop.png')});assert.deepEqual(errors,[]);mark('Legacy notes, fractional corrections, fourth extra bench set and three of four superset rounds preserve plan and reload exactly');
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,taskId:row.taskId,synthetic:true},null,2));console.log('Evidence: '+out);
}catch(e){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});console.log('Browser errors',errors);console.log((await page.locator('body').innerText()).slice(-6500));throw e;}finally{await browser.close();}
