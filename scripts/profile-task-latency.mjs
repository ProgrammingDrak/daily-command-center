#!/usr/bin/env node
// Synthetic loopback-only profiling. No credentials or production writes.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* global window, performance, scheduled, manualDone, viewDate, commitDoneOnDate, rescheduleTaskToDate, _markDirty, _doRender, requestAnimationFrame */
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=process.argv[2]||'http://127.0.0.1:8314';
assert.ok(['127.0.0.1','localhost'].includes(new URL(base).hostname),'Only a local synthetic server is permitted');
const health=await fetch(base+'/api/health').then(r=>r.json());assert.equal(health.reviewOnly,true);
const baseline=process.env.DCC_PROFILE_BASE||'71091e9';
const browser=await chromium.launch({executablePath:process.env.DCC_CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 for(const mode of ['baseline','updated']){
  const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  if(mode==='baseline')for(const name of ['boot','day-context','state','block-store','schedule']){
   const body=execFileSync('git',['show',baseline+':public/js/'+name+'.js'],{cwd:root,encoding:'utf8'});
   await page.route('**/public/js/'+name+'.js*',route=>route.fulfill({contentType:'text/javascript',body}));
  }
  await page.addInitScript(()=>{window.__latency={};window.addEventListener('dcc:data-ready',()=>{window.__latency.ready=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__latency.painted=performance.now();}));});});
  const rows=await fetch(base+'/api/blocks?type=block').then(r=>r.json());const records=new Map(rows.map(r=>[r.id,r]));
  await page.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url()),pathname=url.pathname;
   const mutation=/\/(completion|reschedule)$/.test(pathname);
   await new Promise(resolve=>setTimeout(resolve,mutation?1000:['/api/state/tomorrow','/api/prep','/api/state/archives'].includes(pathname)?1500:100));
   if(pathname==='/api/blocks'&&request.method()==='GET'){
    const date=url.searchParams.get('date');return route.fulfill({json:[...records.values()].filter(r=>!date||r.date===date)});
   }
   if(mutation){
    const body=request.postDataJSON(),id=decodeURIComponent(pathname.split('/')[3]),row=records.get(id);assert.ok(row);
    if(pathname.endsWith('/completion')){
     const task={...row,properties:{...row.properties,status:body.completed?'done':'open',done:body.completed,completedAt:body.completedAt,_completionRevision:body.mutationId,_completionMutationId:body.mutationId}};
     records.set(id,task);return route.fulfill({json:{ok:true,task,mutationId:body.mutationId,affectedTasks:[]}});
    }
    const moved=[...records.values()].filter(r=>r.id===id||r.properties.subtaskOf===id).map(r=>({...r,date:body.targetDate}));moved.forEach(r=>records.set(r.id,r));
    return route.fulfill({json:{moved:moved.map(r=>r.id),blocks:moved,created:[]}});
   }
   return route.continue();
  });
  await page.goto(base,{waitUntil:'load'});await page.waitForFunction(()=>window.__latency.painted);
  const timings=await page.evaluate(async()=>{
   const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const start=performance.now();for(let i=0;i<5;i++){_markDirty();_doRender();}const renderMs=performance.now()-start;
   const mark=performance.now();const completion=commitDoneOnDate('review-unscheduled',viewDate,{silent:true});await frames();
   const completionFeedbackMs=performance.now()-mark;const completionOptimistic=manualDone.has('review-unscheduled');await completion;const completionAckMs=performance.now()-mark;
   const moveStart=performance.now();const move=rescheduleTaskToDate('review-detail-task','2026-11-01',{pinnedStart:'09:00',silent:true});await frames();
   const movePreviewMs=performance.now()-moveStart;const previewRemoved=!scheduled.some(r=>r.id==='review-detail-task');await move;const moveAckMs=performance.now()-moveStart;await frames();
   return {readyMs:window.__latency.ready,paintedMs:window.__latency.painted,fullRender5Ms:renderMs,completionFeedbackMs,completionOptimistic,completionAckMs,movePreviewMs,previewRemoved,moveAckMs};
  });
  assert.equal(timings.completionOptimistic,true);assert.equal(timings.previewRemoved,mode==='updated');
  assert.equal(await page.evaluate(()=>scheduled.some(r=>r.id==='review-detail-task')),false);
  await page.reload({waitUntil:'load'});await page.waitForFunction(()=>window.__latency.painted);
  assert.equal(await page.evaluate(()=>manualDone.has('review-unscheduled')),true,'acknowledged completion survives fresh reads');
  assert.equal(await page.evaluate(()=>scheduled.some(r=>r.id==='review-detail-task')),false,'acknowledged move survives fresh reads');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({mode,...timings,reload:'passed',pageErrors:errors}));await page.close();
 }
}finally{await browser.close();}
