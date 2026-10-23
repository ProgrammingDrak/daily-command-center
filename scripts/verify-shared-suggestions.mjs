/* global window, document */
import assert from 'node:assert/strict';import {chromium} from 'playwright-core';import fs from 'node:fs/promises';
const origin=process.argv[2]||'http://127.0.0.1:8328';assert.ok(['localhost','127.0.0.1'].includes(new URL(origin).hostname));
const out='test-results/shared-suggestions';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],posts=[],checks=[];
let fail=true,hold=false,release;
const fixture={workspaceName:'Morgan’s shared day',date:'2026-10-22',timeZone:'America/New_York',ownerUsername:'Morgan',updatedAt:'2026-10-22T12:00:00Z',calendars:[],blocks:[],viewer:{loggedIn:false,tier:'guest',capabilities:{react:true,comment:true,sponsor_reward:true}},tasks:[{id:'a',title:'Write proposal',itemType:'task',status:'open'},{id:'b',title:'Walk outside',itemType:'repeat',status:'done'},{id:'c',title:'Weekly call',itemType:'calendar',status:'open'}]};
page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{window.EventSource=class{};});
await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/public/'))return route.continue();if(req.method()==='GET')return route.fulfill({json:fixture});posts.push(req.postDataJSON());if(hold)await new Promise(r=>release=r);if(fail){fail=false;return route.fulfill({status:503,json:{error:'Synthetic retryable failure'}});}return route.fulfill({json:{triageItem:{id:'synthetic-once'}}});});
const mark=s=>{checks.push(s);console.log('PASS '+s);};
try{
 await page.goto(origin+'/public-todo.html');const opener=page.getByRole('button',{name:'Suggest a Task',exact:true});await opener.waitFor();
 assert.equal(await page.locator('#todo-create-title').count(),0);
 await page.getByRole('button',{name:'Remove all',exact:true}).click();assert.equal(await page.getByText('Write proposal',{exact:true}).count(),0);assert.equal(await page.getByText('Walk outside',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Tasks',exact:true}).click();await page.getByRole('button',{name:'Repeat',exact:true}).click();assert.equal(await page.getByText('Write proposal',{exact:true}).count(),1);assert.equal(await page.getByText('Walk outside',{exact:true}).count(),1);assert.equal(await page.getByText('Weekly call',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Show all',exact:true}).click();mark('independent inclusive pill filters support subsets, none and restore all');
 await opener.click();let dialog=page.getByRole('dialog',{name:'Suggest a Task'});await dialog.waitFor();await page.waitForTimeout(50);
 assert.equal(await page.locator('#todo-create-title').evaluate(e=>e===document.activeElement),true);assert.equal(await page.locator('main').evaluate(e=>e.inert),true);
 await page.locator('#todo-create-title').fill('Read in the park');await page.locator('#todo-create-duration').selectOption('45');
 // Use the same time wheel as the main DCC task flow, not a duplicate picker.
 await dialog.locator('.tw-field-time').click();await page.locator('.tw-overlay.open').waitFor();await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true);
 await dialog.locator('.tw-field-time').click();await page.locator('.tw-overlay.open').waitFor();
 const wheels=page.locator('.tw-overlay.open .tw-col');
 for(const [column,label] of [[0,'2'],[1,'30'],[2,'PM']]){await wheels.nth(column).getByText(label,{exact:true}).click();await page.waitForTimeout(550);}
 await page.locator('.tw-overlay.open').getByRole('button',{name:'Set',exact:true}).click();assert.equal(await page.locator('#todo-create-time').inputValue(),'14:30');
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await dialog.waitFor({state:'detached'});assert.equal(await opener.evaluate(e=>e===document.activeElement),true);assert.equal(posts.length,0);
 await opener.click();dialog=page.getByRole('dialog',{name:'Suggest a Task'});await dialog.locator('.tw-field-time').click();await page.locator('.tw-overlay.open').waitFor();assert.equal(await page.locator('.tw-overlay').evaluate(e=>e.inert),false);await page.keyboard.press('Escape');assert.equal(await page.locator('#todo-create-title').inputValue(),'Read in the park');assert.equal(await page.locator('#todo-create-time').inputValue(),'14:30');
 await dialog.getByRole('button',{name:'Send suggestion',exact:true}).focus();await page.keyboard.press('Tab');assert.ok(await dialog.evaluate(e=>e.contains(document.activeElement)));
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(posts.length,0);mark('modal focus, inert background, keyboard trap, nested picker Escape, cancellation and draft restoration');
 await opener.click();dialog=page.getByRole('dialog',{name:'Suggest a Task'});await dialog.getByRole('button',{name:'Send suggestion',exact:true}).click();await page.getByText('Synthetic retryable failure',{exact:true}).waitFor();
 assert.equal(await page.locator('#todo-create-title').inputValue(),'Read in the park');
 await page.reload();await opener.click();dialog=page.getByRole('dialog',{name:'Suggest a Task'});hold=true;await dialog.getByRole('button',{name:'Send suggestion',exact:true}).click();while(!release)await page.waitForTimeout(10);
 assert.equal(await dialog.getByRole('button',{name:'Send suggestion',exact:true}).isDisabled(),true);await page.keyboard.press('Enter');assert.equal(posts.length,2);assert.deepEqual(posts[0],posts[1]);assert.equal(posts[1].durationMinutes,'45');assert.equal(posts[1].suggestedTime,'14:30');release();await dialog.waitFor({state:'detached'});await page.getByText('Suggestion sent to the owner for review.').waitFor();
 mark('error retains draft; reload retries identical request; repeated submit is blocked; duration/time are sent');
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:out+'/'+width+'-header.png',fullPage:true});await opener.click();await page.getByRole('dialog',{name:'Suggest a Task'}).waitFor();await page.waitForTimeout(300);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));await page.screenshot({path:out+'/'+width+'-modal.png',fullPage:true});await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('dialog',{name:'Suggest a Task'}).waitFor({state:'detached'});}
 mark('desktop/mobile header and modal fit the viewport');assert.deepEqual(errors,[]);await fs.writeFile(out+'/results.json',JSON.stringify({checks,errors,synthetic:true},null,2));
}finally{await browser.close();}
