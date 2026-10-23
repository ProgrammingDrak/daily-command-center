/* global window, document */
// Synthetic responses only; no live token, account, task or mutation is used.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
const origin=process.argv[2]||'http://127.0.0.1:8319';assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const out=process.env.DCC_QA_OUTPUT||'test-results/shared-todo-composers';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),page=await context.newPage();
const errors=[],posts=[],checks=[];let reads=0,failNext=false,holdReward=false,releaseReward,holdComment=false,releaseComment;
const fixture={workspaceName:'Synthetic shared to do list',ownerUsername:'Morgan-demo',date:'2026-10-21',updatedAt:'2026-10-21T12:00:00Z',calendars:[],blocks:[],viewer:{loggedIn:true,username:'Riley-demo',tier:'friend',capabilities:{comment:true,sponsor_reward:true,place_bounty:true}},tasks:[
{id:'one',blockId:'block-one',title:'Morning workout',start:'07:00',end:'07:30',durationMinutes:30,status:'open',itemType:'task',comments:[{authorName:'Morgan-demo',body:'Existing instructions stay visible',createdAt:'2026-10-21T12:00:00Z'}],sponsorships:[{kind:'reward',rewardTitle:'Existing smoothie reward',status:'pending'}]},
{id:'two',blockId:'block-two',title:'Read together',start:'08:00',end:'08:30',durationMinutes:30,status:'open',itemType:'task'},
{id:'three',blockId:'block-three',title:'Evening walk',start:'17:00',end:'17:30',durationMinutes:30,status:'open',itemType:'task'},
{id:'done',title:'Completed task remains readable',start:'06:00',end:'06:30',status:'done',itemType:'task'}]};
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
await page.addInitScript(()=>{window.EventSource=class {constructor(){window.__sharedEvents=this;}};});
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
 if(!url.pathname.startsWith('/api/public/todo-share/'))return route.continue();
 if(req.method()==='GET'){reads++;return route.fulfill({json:fixture});}
 const body=req.postDataJSON();posts.push({url:url.pathname,body});
 if(failNext){failNext=false;return route.fulfill({status:503,json:{error:'Synthetic retryable failure'}});}
 if(holdReward && url.pathname.endsWith('/sponsorships'))await new Promise(resolve=>{releaseReward=resolve;});
 if(holdComment && url.pathname.endsWith('/comments'))await new Promise(resolve=>{releaseComment=resolve;});
 const task=fixture.tasks.find(t=>t.id===body.taskId);
 if(url.pathname.endsWith('/comments')){task.comments=[...(task.comments||[]),{authorName:'Riley-demo',body:body.body,createdAt:'2026-10-21T12:01:00Z'}];return route.fulfill({json:{comments:task.comments}});}
 if(url.pathname.endsWith('/reactions'))return route.fulfill({json:{counts:{'👍':1},viewerReactions:['👍']}});
 if(url.pathname.endsWith('/sponsorships'))task.sponsorships=[...(task.sponsorships||[]),{kind:'reward',rewardTitle:body.rewardTitle,status:'pending'}];
 return route.fulfill({json:{ok:true}});
});
const form=(kind,id='one')=>page.locator('[data-composer-form="'+kind+'"][data-task-id="'+id+'"]');
const toggle=(kind,id='one')=>page.getByRole('button',{name:(kind==='reward'?'Offer reward':'Add comment')+' for '+fixture.tasks.find(t=>t.id===id).title,exact:true});
const mark=text=>{checks.push(text);console.log('PASS '+text);};
async function refresh(){const n=reads;await page.evaluate(()=>window.__sharedEvents.onmessage({data:'changed'}));await page.waitForFunction(()=>!document.getElementById('todo-public-content').hidden);while(reads===n)await new Promise(r=>setTimeout(r,5));await page.waitForTimeout(50);}
try{
 await page.goto(origin+'/public-todo.html');await toggle('reward').waitFor();
 assert.equal(await page.locator('[data-composer-form]:visible').count(),0);assert.equal(await page.locator('#todo-guest-add-form').isVisible(),false);
 for(const kind of ['reward','comment'])assert.equal(await toggle(kind).getAttribute('aria-expanded'),'false');
 assert.equal(await page.getByText('Existing instructions stay visible',{exact:true}).isVisible(),true);assert.equal(await page.getByText('Reward: Existing smoothie reward',{exact:true}).isVisible(),true);
 assert.equal(await page.getByText('Completed task remains readable',{exact:true}).isVisible(),true);
 const initialHeight=(await form('reward','two').locator('xpath=ancestor::*[contains(@class,"tl-item")][1]').boundingBox()).height;
 mark('all optional composers start collapsed while task identity, completed rows and submitted content remain visible');
 await toggle('reward').focus();await page.keyboard.press('Enter');assert.equal(await form('reward').isVisible(),true);assert.equal(await form('reward').locator('[name=rewardTitle]').evaluate(e=>e===document.activeElement),true);
 await form('reward').locator('[name=rewardTitle]').fill('Coffee after workout');await form('reward').locator('[name=sponsorName]').fill('Riley');await form('reward').locator('[name=value]').fill('5');
 await toggle('comment').focus();await page.keyboard.press('Space');await form('comment').locator('input').fill('My unsent note');await page.keyboard.press('Escape');
 assert.equal(await toggle('comment').evaluate(e=>e===document.activeElement),true);assert.equal(await form('comment').isVisible(),false);assert.equal(await form('reward').isVisible(),true);
 await toggle('reward').click();await toggle('reward').click();assert.equal(await form('reward').locator('[name=rewardTitle]').inputValue(),'Coffee after workout');assert.equal(await form('reward').locator('[name=value]').inputValue(),'5');
 assert.equal(posts.length,0);mark('keyboard disclosure, Escape focus return and independent fields preserve drafts without sending');
 await toggle('comment','two').click();await form('comment','two').locator('input').fill('Second task draft');
 await form('reward').locator('[name=rewardTitle]').focus();await form('reward').locator('[name=rewardTitle]').evaluate(e=>e.setSelectionRange(4,4));await refresh();
 assert.equal(await form('reward').locator('[name=rewardTitle]').inputValue(),'Coffee after workout');assert.equal(await form('reward').locator('[name=rewardTitle]').evaluate(e=>e===document.activeElement&&e.selectionStart===4),true);
 await page.locator('[data-status-filter=open]').click();await page.locator('[data-status-filter=open]').click();
 assert.equal(await form('comment','two').locator('input').inputValue(),'Second task draft');
 await page.locator('[data-task-id="one"][data-reaction-emoji="👍"]').click();await page.waitForTimeout(70);
 assert.equal(await form('reward').locator('[name=sponsorName]').inputValue(),'Riley');
 mark('live refresh, filter changes and reaction rerenders retain separate task drafts and input caret');
 await toggle('comment').click();failNext=true;await form('comment').getByRole('button',{name:'Send',exact:true}).click();await page.waitForTimeout(70);assert.equal(await form('comment').locator('input').inputValue(),'My unsent note');assert.equal(await form('comment').locator('input').isEnabled(),true);
 holdComment=true;await form('comment').getByRole('button',{name:'Send',exact:true}).click();while(!releaseComment)await new Promise(r=>setTimeout(r,5));await refresh();assert.equal(await form('comment').locator('input').isDisabled(),true);releaseComment();await page.getByText('My unsent note',{exact:true}).waitFor();assert.equal(await form('comment').isVisible(),false);assert.equal(await form('reward').locator('[name=rewardTitle]').inputValue(),'Coffee after workout');
 holdReward=true;await form('reward').getByRole('button',{name:'Send',exact:true}).click();while(!releaseReward)await new Promise(r=>setTimeout(r,5));await refresh();assert.equal(await form('reward').locator('[name=rewardTitle]').isDisabled(),true);assert.equal(await form('reward').getByRole('button',{name:'Send',exact:true}).isDisabled(),true);await toggle('reward').click();await toggle('reward').click();assert.equal(posts.filter(p=>p.url.endsWith('/sponsorships')).length,1);releaseReward();await page.getByText('Reward: Coffee after workout',{exact:true}).waitFor();assert.equal(await form('reward').isVisible(),false);
 assert.equal(await form('comment','two').locator('input').inputValue(),'Second task draft');mark('failed sends retain drafts; pending sends survive refresh without duplicates; success clears only its own composer');
 await toggle('comment','two').click();const before=posts.length;
 for(const width of [1440,375]){await page.setViewportSize({width,height:1100});await page.screenshot({path:path.join(out,width===1440?'desktop-collapsed.png':'mobile-collapsed.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
 const rects=await page.locator('#todo-public-list .tl-item').evaluateAll(items=>items.map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));for(let i=1;i<rects.length;i++)assert.ok(rects[i].top>=rects[i-1].bottom);
 assert.ok((await toggle('comment','two').boundingBox()).height>=44);await toggle('reward','two').click();const openHeight=(await form('reward','two').locator('xpath=ancestor::*[contains(@class,"tl-item")][1]').boundingBox()).height;assert.ok(openHeight>initialHeight);await toggle('reward','two').click();}
 assert.equal(posts.length,before);mark('desktop/mobile cards stack without overflow; composers use 44px targets');
 // A late response from the old viewer must not erase or disable a new viewer's draft.
 await toggle('comment','two').click();await form('comment','two').locator('input').fill('Old viewer pending comment');
 holdComment=true;releaseComment=undefined;await form('comment','two').getByRole('button',{name:'Send',exact:true}).click();while(!releaseComment)await new Promise(r=>setTimeout(r,5));
 fixture.viewer.username='Mid-send-synthetic-viewer';await refresh();await toggle('comment','two').click();await form('comment','two').locator('input').fill('New viewer unsent draft');
 const settled=page.waitForResponse(response=>response.url().endsWith('/comments')&&response.request().method()==='POST');releaseComment();await settled;await page.evaluate(()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))));holdComment=false;
 assert.equal(await form('comment','two').locator('input').inputValue(),'New viewer unsent draft');assert.equal(await form('comment','two').locator('input').isDisabled(),false);assert.equal(await page.getByText('Old viewer pending comment',{exact:true}).count(),0);mark('late submission responses from a prior viewer do not overwrite the current draft or rendered comments');
 fixture.viewer.username='Other-synthetic-viewer';await refresh();await toggle('comment','two').click();assert.equal(await form('comment','two').locator('input').inputValue(),'');
 fixture.viewer.capabilities.comment=false;fixture.viewer.capabilities.sponsor_reward=false;await refresh();assert.equal(await page.locator('[data-composer-toggle]').count(),0);assert.equal(await page.getByText('My unsent note',{exact:true}).isVisible(),true);
 assert.deepEqual(errors,[]);mark('viewer changes discard prior unsent drafts; capability loss removes composers without hiding submitted content');
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,synthetic:true},null,2));
}finally{await browser.close();}
