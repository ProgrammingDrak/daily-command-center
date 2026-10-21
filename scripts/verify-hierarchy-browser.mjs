/* global window, document, scheduled, DCC, innerWidth, scrollY */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
const base=process.argv[2]||'http://127.0.0.1:8147';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
assert.equal((await fetch(base+'/api/health').then(r=>r.json())).reviewOnly,true);
assert.equal((await fetch(base+'/api/review/hierarchy/reset',{method:'POST'})).status,200);
const out=process.env.DCC_QA_OUTPUT||'test-results/hierarchy';fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const row=(page,id)=>page.locator('.it-list-item[data-id="'+id+'"]');
async function stored(page,id){return page.request.get(base+'/api/blocks/'+id).then(r=>r.json());}
async function ready(page){await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof scheduled!=='undefined'&&scheduled.some(e=>e.id==='review-wrap'));}
async function persisted(page,id,edge,parent){
 await page.waitForFunction(([id,edge,parent])=>window.blockStore.get(id)?.properties[edge]===parent,[id,edge,parent]);
 await assertEventually(async()=>{const r=await stored(page,id);assert.equal(r.properties[edge]||null,parent);assert.equal(r.parent_id||null,parent);});
}
async function assertEventually(check){let last;for(let i=0;i<40;i++){try{await check();return;}catch(e){last=e;await new Promise(r=>setTimeout(r,100));}}throw last;}
async function native(page,id,target,sub){
 await assertEventually(()=>row(page,id).scrollIntoViewIfNeeded());
 const from=await row(page,id).locator('.grip').boundingBox(),to=await row(page,target).boundingBox();
 assert(to&&from);const x=from.x+from.width/2,y=from.y+from.height/2;
 if(sub)await page.keyboard.down('Shift');
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+8,{steps:4});
 await page.mouse.move(sub?to.x+Math.min(190,to.width/2):x,to.y+to.height/2,{steps:18});
 await page.mouse.up();if(sub)await page.keyboard.up('Shift');
}
try{
 console.log('Starting native hierarchy browser checks');
 const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(e.message));await ready(page);
 await page.evaluate(()=>{window.qaDragEvents=[];for(const type of ['dragstart','dragover','drop','dragend'])document.addEventListener(type,e=>window.qaDragEvents.push({type,trusted:e.isTrusted,id:e.target.closest('[data-id]')?.dataset.id}),true);});
 await native(page,'review-wrap','review-parent-step',true);
 await persisted(page,'review-wrap','subtaskOf','review-parent-step');
 const nodes=await page.evaluate(()=>DCC.TaskModel.selectTree(scheduled,{pool:scheduled}).filter(n=>n.ev.id.startsWith('review-')).map(n=>({id:n.ev.id,depth:n.depth})));
 assert.equal(nodes.find(n=>n.id==='review-deep-80').depth,82);
 assert.equal(nodes.filter(n=>/^review-(deep-|wrap$|parent)/.test(n.id)).length,83);
 const events=await page.evaluate(()=>window.qaDragEvents);for(const type of ['dragstart','drop'])assert(events.some(e=>e.type===type&&e.trusted));
 await page.reload();await page.waitForFunction(()=>typeof scheduled!=='undefined'&&scheduled.find(e=>e.id==='review-wrap')?.subtaskOf==='review-parent-step');
 for(let i=1;i<=80;i++){const r=await stored(page,'review-deep-'+i);assert.equal(r.properties.notes,'Keep level '+i+' notes');assert.equal(r.properties.subtaskOf,i===1?'review-wrap':'review-deep-'+(i-1));}
 await page.screenshot({path:out+'/native-nested-desktop.png'});
 console.log('PASS trusted native HTML5 drag nests a wrap at depth 2; all 80 descendants, edges, notes and IDs survive reload');
 // Move back to the top level with a straight gesture, then repeat the nest.
 await row(page,'review-wrap').locator('.wrap-collapse').click();
 await native(page,'review-wrap','review-parent',false);
 await persisted(page,'review-wrap','subtaskOf',null);
 await native(page,'review-wrap','review-parent-step',true);
 await persisted(page,'review-wrap','subtaskOf','review-parent-step');
 console.log('PASS repeated native promote/nest persists one root and no duplicates');
 assert.deepEqual(errors,[]);await context.close();
 for(const width of [320,390,768]){
  const ctx=await browser.newContext({viewport:{width,height:1000},hasTouch:true,isMobile:true}),p=await ctx.newPage();await ready(p);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const deepest=row(p,'review-deep-80');await deepest.scrollIntoViewIfNeeded();const bounds=await deepest.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.width>=200);
  assert((await deepest.locator('.ttl').boundingBox()).width>=70,'deep task title retains readable space');
  await p.screenshot({path:out+'/deep-mobile-'+width+'.png'});
  console.log('PASS '+width+'px deep tree stays within viewport with usable rows');await ctx.close();
 }
 const mobile=await browser.newContext({viewport:{width:390,height:1000},hasTouch:true,isMobile:true}),p=await mobile.newPage();await ready(p);
 await row(p,'review-wrap').scrollIntoViewIfNeeded();
 // Source and destination are adjacent. Touch holds the grip, moves vertically,
 // then sideways to choose the subtask mode through the real pointer adapter.
 const source=await row(p,'review-wrap').locator('.ttl').boundingBox(),dest=await row(p,'review-parent-step').boundingBox();
 await p.evaluate(()=>{window.qaTouch=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.addEventListener(type,e=>window.qaTouch.push({type,trusted:e.isTrusted}),true);});
 const session=await mobile.newCDPSession(p);const start={x:Math.round(source.x+10),y:Math.round(source.y+source.height/2)};
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});await p.waitForTimeout(380);
 await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x,y:Math.round(dest.y+dest.height/2)}]});
 await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:Math.max(dest.x+10,start.x-80),y:Math.round(dest.y+dest.height/2)}]});
 await p.waitForTimeout(100);await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 const touchEvents=await p.evaluate(()=>window.qaTouch);assert(touchEvents.some(e=>e.type==='pointerup'&&e.trusted));assert(!touchEvents.some(e=>e.type==='pointercancel'));
 await persisted(p,'review-wrap','wrapId','review-parent-step');
 await p.reload({waitUntil:'domcontentloaded'});await p.waitForFunction(()=>typeof scheduled!=='undefined'&&scheduled.find(e=>e.id==='review-wrap')?.wrapId==='review-parent-step');
 assert.equal(await p.evaluate(()=>DCC.TaskModel.descendantsOf('review-wrap',scheduled).length),81);
 await p.screenshot({path:out+'/touch-nested-mobile.png'});
 console.log('PASS real touch long-press and sideways drag converts the nested root into independent-time work; all descendants survive reload');
 await row(p,'review-deep-15').scrollIntoViewIfNeeded();
 const swipe=await row(p,'review-deep-15').locator('.ttl').boundingBox(),before=await p.evaluate(()=>scrollY);
 const point={x:Math.round(swipe.x+10),y:Math.round(swipe.y+swipe.height/2)};
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
 await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y-70}]});
 await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y-140}]});
 await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(200);
 assert(await p.evaluate(()=>scrollY)>before,'a swipe before lift still scrolls the page');
 console.log('PASS ordinary mobile swipe still scrolls before the long-press threshold');
 await mobile.close();
}finally{await browser.close();}
