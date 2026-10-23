/* global window, document */
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
const origin=process.argv[2]||'http://127.0.0.1:8328';assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const out=process.env.DCC_QA_OUTPUT||'test-results/nested-rewards';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();
const checks=[],errors=[],posts=[];let reads=0,lost=true,hold=false,release;
const fixture={workspaceName:'Shared day · review fixture',ownerUsername:'Morgan',date:'2026-10-22',updatedAt:'2026-10-22T12:00:00Z',calendars:[],blocks:[],viewer:{loggedIn:true,username:'Riley',tier:'user',capabilities:{comment:true,sponsor_reward:true,place_bounty:true}},tasks:
['Write proposal','Read chapter','Walk outside','Stretch'].map((title,i)=>({id:String(i+1),blockId:'block-'+i,title,status:'open',itemType:i===3?'repeat':'task',start:'0'+(i+7)+':00',durationMinutes:30}))};
page.on('pageerror',e=>errors.push(e.message));const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());d.accept();});
await page.addInitScript(()=>{window.EventSource=class{constructor(){window.__events=this;}};});
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
 if(!url.pathname.startsWith('/api/public/'))return route.continue();
 if(req.method()==='GET'){reads++;return route.fulfill({json:fixture});}
 const body=req.postDataJSON();posts.push(body);
 if(hold)await new Promise(resolve=>release=resolve);
 if(lost){lost=false;return route.abort('failed');}
 fixture.tasks[0].sponsorships=[{kind:'reward',rewardTitle:body.rewardTitle,status:'pending',conditionText:'ALL (Write proposal; ANY (Read chapter; ALL (Walk outside; Stretch)))'}];
 return route.fulfill({json:{id:7,status:'pending'}});
});
const mark=s=>{checks.push(s);console.log('PASS '+s);};
const form=page.locator('[data-composer-form="reward"][data-task-id="1"]');
const group=path=>form.locator('[data-group-path="'+path+'"]');
const pick=async(path,id)=>{await group(path).locator('.reward-condition-picker summary').click();await group(path).locator('[data-condition-task="'+id+'"]').check();};
async function refresh(){const before=reads;await page.evaluate(()=>window.__events.onmessage({data:'changed'}));await page.waitForFunction(()=>!document.getElementById('todo-public-content').hidden);while(reads===before)await page.waitForTimeout(10);await page.waitForTimeout(50);}
try{
 await page.goto(origin+'/public-todo.html');await page.getByRole('button',{name:'Offer reward for Write proposal',exact:true}).click();
 await form.locator('[name=rewardTitle]').fill('Coffee together');await form.locator('[name=sponsorName]').fill('Riley');
 await form.getByRole('button',{name:'Group tasks (ALL / ANY)'}).click();
 await group('').getByRole('button',{name:'Add nested group',exact:true}).click();
 await pick('1','2');await group('1').getByRole('button',{name:'Add nested group',exact:true}).click();
 await group('1.1').locator('[data-condition-op]').selectOption('all');await pick('1.1','3');
 await group('1.1').locator('[data-condition-task="4"]').check();
 assert.equal(await group('1.1').locator('[data-condition-task="1"]').isDisabled(),true);
 await refresh();assert.equal(await group('1.1').locator('[data-condition-op]').inputValue(),'all');
 await group('1').locator(':scope > summary').click();await group('1.1').waitFor({state:'detached'});
 await group('1').locator(':scope > summary').click();await group('1.1').waitFor();
 mark('mixed ALL/ANY tree, multi-select, nested edits, duplicate prevention, disclosure and refresh retention');
 await page.reload();await form.waitFor();assert.equal(await form.locator('[name=rewardTitle]').inputValue(),'Coffee together');await group('1.1').waitFor();
 mark('scoped reward draft and nested groups survive browser reload');
 for(const width of [1440,390]){await page.setViewportSize({width,height:1100});await page.screenshot({path:out+'/'+width+'-nested.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));}
 mark('desktop and mobile nested editor fit viewport');
 await form.getByRole('button',{name:'Send',exact:true}).click();await page.waitForTimeout(100);
 assert.equal(posts.length,1);assert.equal(await form.locator('[name=rewardTitle]').inputValue(),'Coffee together');
 await page.reload();await form.waitFor();hold=true;await form.getByRole('button',{name:'Send',exact:true}).click();
 while(!release)await page.waitForTimeout(10);await refresh();assert.equal(await form.getByRole('button',{name:'Send',exact:true}).isDisabled(),true);
 assert.equal(posts.length,2);assert.equal(posts[0].requestKey,posts[1].requestKey);assert.deepEqual(posts[0],posts[1]);
 assert.equal(posts[1].condition.children[1].children[1].children.length,2);
 release();await page.waitForTimeout(200);assert.equal(await form.isVisible(),false);
 mark('lost response followed by reload retries identical idempotent request; in-flight refresh cannot double-submit');
 await page.getByRole('button',{name:'Offer reward for Write proposal',exact:true}).click();await form.getByRole('button',{name:'Group tasks (ALL / ANY)'}).click();
 await group('').getByRole('button',{name:'Add nested group',exact:true}).click();await form.locator('[name=rewardTitle]').fill('Empty invalid');
 const before=posts.length;await form.getByRole('button',{name:'Send',exact:true}).click();assert.equal(posts.length,before);assert.ok(dialogs.some(s=>s.includes('Every group')));
 await group('1').getByRole('button',{name:'Remove group',exact:true}).click();assert.equal(await group('1').count(),0);
 mark('empty nested group blocks submission and can be removed without losing remaining selection');
 assert.deepEqual(errors,[]);await fs.writeFile(out+'/results.json',JSON.stringify({checks,errors,synthetic:true},null,2));
}finally{await browser.close();}
