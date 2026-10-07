/* global __dirname, process, URL, Event, console, window, document, openTaskRadial, refoldTaskStateFromBlockCache, render, scheduled, buildTaskRadialItems */
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const dir=require('node:path').join(__dirname,'../design/task-radial');
fs.mkdirSync(dir,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.goto(process.env.DCC_REVIEW_URL||'http://127.0.0.1:8317');await page.waitForFunction(()=>window.blockStore&&typeof openTaskRadial==='function');
 await page.evaluate(async()=>{await window.blockStore.loadDay(new Date().toISOString().slice(0,10));refoldTaskStateFromBlockCache();render();});
 const row=page.locator('.it-list-item[data-id="review-detail-task"]').first();await row.waitFor();await page.waitForTimeout(5500);
 const results=[];
 for(const width of [320,390,768,1440]){
 await page.setViewportSize({width,height:844});await row.scrollIntoViewIfNeeded();
 await row.locator('.btn-task-radial').click();await page.waitForTimeout(550);
 const labels=await page.locator('button.dest-radial-item').evaluateAll(ns=>ns.map(n=>n.getAttribute('aria-label')));
 assert(!labels.includes('Back')&&!labels.includes('Change task…'));assert(labels.includes('Lock')&&labels.includes('Convert…'));
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Subtask…');
 await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Cancel');await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Subtask…');
 await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Back',exact:true}).click();
 assert.equal(await page.locator('button.dest-radial-item').count(),labels.length);await page.keyboard.press('Escape');
 assert.equal(await page.locator('button.dest-radial-item').count(),0);assert(await row.locator('.btn-task-radial').evaluate(n=>n===document.activeElement));
 for(const pos of [[0,0],[width-24,0],[0,820],[width-24,820],[width-24,420]]){
 await page.evaluate(pos=>{let t=document.getElementById('qa-trigger');if(!t){t=document.createElement('button');t.id='qa-trigger';t.textContent='Actions';document.body.appendChild(t);}t.style.cssText=`position:fixed;left:${pos[0]}px;top:${pos[1]}px;width:24px;height:24px`;openTaskRadial({...scheduled.find(t=>t.id==='review-detail-task'),untimed:false,repeatMode:'scheduled',subtaskOf:'qa-parent'},t);},pos);
 await page.waitForTimeout(650);
 const boxes=await page.locator('.dest-radial-circle-item').evaluateAll(ns=>ns.map(n=>{const b=n.getBoundingClientRect();return {label:n.getAttribute('aria-label'),x:b.x,y:b.y,right:b.right,bottom:b.bottom,cx:b.x+b.width/2,cy:b.y+b.height/2,width:b.width};}));
 for(const b of boxes)assert(b.x>=15&&b.y>=15&&b.right<=width-15&&b.bottom<=829,JSON.stringify(b));
 for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert(Math.hypot(boxes[i].cx-boxes[j].cx,boxes[i].cy-boxes[j].cy)>=boxes[i].width+2,'circle targets overlap');
 if(pos[1]===420&&(width===390||width===1440))await page.screenshot({path:dir+'/radial-'+width+'.png'});
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 results.push({width,pos,items:boxes.length,inset:16});
 }
 }
 await page.evaluate(()=>document.getElementById('qa-trigger').remove());
 await row.locator('.btn-task-radial').click();await page.mouse.click(4,4);assert.equal(await page.locator('button.dest-radial-item').count(),0);
 for(let i=0;i<3;i++){await row.locator('.btn-task-radial').tap();await page.keyboard.press('Escape');}
 await row.locator('.btn-task-radial').tap();await page.getByRole('button',{name:'Lock',exact:true}).tap();
 assert(await page.evaluate(()=>scheduled.find(t=>t.id==='review-detail-task')._locked));
 await row.locator('.btn-task-radial').tap();await page.getByRole('button',{name:'Unlock',exact:true}).tap();
 assert(!await page.evaluate(()=>scheduled.find(t=>t.id==='review-detail-task')._locked));
 await row.locator('.btn-task-radial').click();await page.evaluate(()=>document.dispatchEvent(new Event('scroll')));assert.equal(await page.locator('button.dest-radial-item').count(),0);
 await row.locator('.btn-task-radial').click();await page.setViewportSize({width:500,height:700});assert.equal(await page.locator('button.dest-radial-item').count(),0);
 const calls=await page.evaluate(()=>{
 const saved={},names=['openMakeSubtaskOf','promoteToTopLevel','moveTaskToUnplanned','openConvertToRadial','convertTaskToDelegated','openTaskDependencyModal','openRepeatResponsibilityFromTask','moveTaskToBacklog','moveTaskToWhenever','openScheduledOccurrenceActions','toggleLock'];
 const calls=[];for(const name of names){saved[name]=window[name];window[name]=(...args)=>calls.push({name,id:typeof args[0]==='object'?args[0].id:args[0]});}
 try{const ev={id:'qa-task',_blockId:'qa-block',untimed:false,subtaskOf:'qa-parent',repeatMode:'scheduled'};for(const item of buildTaskRadialItems(ev,{}))item.onPick();return calls;}finally{for(const name of names)window[name]=saved[name];}
 });
 assert.equal(calls.length,11);assert(calls.some(c=>c.name==='openTaskDependencyModal'&&c.id==='qa-block'));assert(calls.every(c=>c.id==='qa-task'||c.id==='qa-block'));
 fs.writeFileSync(dir+'/radial-qa.json',JSON.stringify({results,calls,lockUnlock:true,keyboard:true,touch:true,dismissal:true},null,2));
 console.log('PASS: all 11 action callbacks; real lock/unlock; 20 edge placements at four widths; nonoverlapping circle targets; Convert/Back; keyboard focus/Tab/Escape; touch/repeated opens; Cancel/outside/scroll/resize dismissal.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
