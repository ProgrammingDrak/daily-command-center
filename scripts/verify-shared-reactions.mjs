/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
const origin=process.argv[2]||'http://127.0.0.1:8328';assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const out='test-results/shared-reactions';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const checks=[],errors=[];
try{
 for(const touch of [false,true]){
  const context=await browser.newContext({viewport:{width:touch?390:1440,height:1000},hasTouch:touch,isMobile:touch}),page=await context.newPage();
  const fixture={workspaceName:'Shared reaction review',ownerUsername:'Morgan',date:'2026-10-22',updatedAt:'2026-10-22T12:00:00Z',calendars:[],blocks:[],viewer:{loggedIn:true,username:'Riley',capabilities:{react:true}},tasks:['open','done'].map((status,i)=>({id:status,title:status+' task',start:'0'+(8+i)+':00',status,itemType:'task',reactions:{'👍':2},viewerReactions:[]}))};
  let posts=0;
  page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{window.EventSource=class{};});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/public/'))return route.continue();
   if(route.request().method()==='GET')return route.fulfill({json:fixture});
   posts++;const body=route.request().postDataJSON(),task=fixture.tasks.find(t=>t.id===body.taskId);
   const active=task.viewerReactions.includes(body.emoji);task.viewerReactions=active?[]:[body.emoji];task.reactions[body.emoji]=active?2:3;
   await new Promise(r=>setTimeout(r,80));return route.fulfill({json:{counts:task.reactions,viewerReactions:task.viewerReactions}});
  });
  await page.goto(origin+'/public-todo.html');await page.getByText('open task',{exact:true}).waitFor();
  for(const id of ['open','done']){
   const button=page.locator('[data-task-id="'+id+'"][data-reaction-emoji="👍"]'),wrap=button.locator('xpath=ancestor::*[contains(@class,"todo-reaction-disclosure")]');
   if(touch){await page.getByRole('button',{name:'Reactions for '+id+' task',exact:true}).tap();await button.waitFor({state:'visible'});}
   else{
    await page.mouse.move(0,0);await page.locator('h1').click();assert.equal(await wrap.evaluate(e=>getComputedStyle(e).opacity),'0');
    await page.getByText(id+' task',{exact:true}).hover();assert.equal(await wrap.evaluate(e=>getComputedStyle(e).opacity),'1');
    await page.mouse.move(0,0);await button.focus();assert.equal(await wrap.evaluate(e=>getComputedStyle(e).opacity),'1');
   }
   assert.equal(await button.locator('b').textContent(),'2');
   const before=posts;await button.click();await button.evaluate(e=>e.click());await page.waitForTimeout(150);
   assert.equal(posts,before+1);assert.equal(await button.getAttribute('aria-pressed'),'true');assert.equal(await button.locator('b').textContent(),'3');
   await button.click();await page.waitForTimeout(150);assert.equal(await button.getAttribute('aria-pressed'),'false');assert.equal(await button.locator('b').textContent(),'2');
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  await page.screenshot({path:out+'/'+(touch?'touch':'desktop')+'.png',fullPage:true});
  const message=(touch?'touch disclosure':'desktop hover/focus')+' works on completed and incomplete tasks; counts and repeated toggles stay correct';checks.push(message);console.log('PASS '+message);
  await context.close();
 }
 assert.deepEqual(errors,[]);await fs.writeFile(out+'/results.json',JSON.stringify({checks,errors,synthetic:true},null,2));
}finally{await browser.close();}
