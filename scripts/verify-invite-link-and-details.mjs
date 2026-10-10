/* global DCC, DCCCommitmentSync, window, document, navigator */
// Fictional local QA only; uses a separate headless Mac Chrome profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
const origin='http://127.0.0.1:8107';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const contexts=[];
async function account(user,url='/'){
 const context=await browser.newContext({viewport:{width:390,height:900},permissions:['clipboard-read','clipboard-write']});contexts.push(context);
 await context.addCookies([{name:'dcc_review_user',value:String(user),url:origin}]);
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(10000);await page.goto(origin+url,{waitUntil:'domcontentloaded'});
 return {page,context};
}
try {
 const {page:owner}=await account(1);await owner.waitForFunction(()=>!!window.DCCCommitmentSync);
 await owner.request.post(origin+'/review/commitments/reset');await owner.reload();await owner.waitForFunction(()=>!!window.DCCCommitmentSync);
 await owner.locator('[data-nav-key=__more]').click();await owner.locator('#mobile-more-sheet').getByRole('button',{name:'People & sharing',exact:true}).click();
 assert.equal(await owner.locator('#social-you-copy').count(),0);
 assert.equal(await owner.locator('.social-topline > div:first-child #friend-invite-create').count(),1);
 await owner.locator('#friend-invite-create').click();
 const field=owner.locator('[aria-label="Friend Invite Link"]');await field.waitFor();const link=await field.inputValue(),path=new URL(link).pathname;
 await owner.getByRole('button',{name:'Copy Invite Link',exact:true}).click();assert.equal(await owner.evaluate(()=>navigator.clipboard.readText()),link);
 await fs.mkdir('test-results/accountability-completion',{recursive:true});
 for(const width of [320,390,760,1024,1440]){await owner.setViewportSize({width,height:900});assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Invite Link overflow '+width);await owner.screenshot({path:'test-results/accountability-completion/invite-link-header-'+width+'.png'});} 
 await owner.setViewportSize({width:390,height:900});
 const {page:anonymous}=await account(0,path);await anonymous.getByRole('link',{name:'Set up and add friend',exact:true}).click();
 assert.equal(new URL(anonymous.url()).searchParams.get('next'),path);
 await anonymous.locator('#username').fill('fictional-devon');await anonymous.locator('#password').fill('fictional-qa-password');await anonymous.locator('#confirmPassword').fill('fictional-qa-password');await anonymous.locator('#submitBtn').click();
 await anonymous.waitForURL(origin+path);await anonymous.getByRole('button',{name:'Add alex as a friend',exact:true}).waitFor();
 // Simulate interruption after the backend commits but before the UI receives its acknowledgement.
 let lost=true;
 await anonymous.route('**/api/public/friend-invites/*/accept',async r=>{if(lost){lost=false;await r.fetch();await r.abort();}else await r.continue();});
 await anonymous.getByRole('button',{name:'Add alex as a friend',exact:true}).click();await anonymous.getByRole('button',{name:'Add alex as a friend',exact:true}).waitFor({state:'visible'});
 await anonymous.getByRole('button',{name:'Add alex as a friend',exact:true}).click();await anonymous.waitForFunction(()=>document.getElementById('invite-message').textContent.includes('already friends'));
 const {page:existing,context:existingContext}=await account(5,path);await existing.getByRole('button',{name:'Add alex as a friend',exact:true}).waitFor();
 await existingContext.addCookies([{name:'dcc_review_user',value:'3',url:origin}]);await existing.getByRole('button',{name:'Add alex as a friend',exact:true}).click();await existing.waitForFunction(()=>document.getElementById('invite-message').textContent.includes('account changed'));
 await existingContext.addCookies([{name:'dcc_review_user',value:'5',url:origin}]);await existing.reload();await existing.getByRole('button',{name:'Add alex as a friend',exact:true}).click();await existing.waitForFunction(()=>document.getElementById('invite-message').textContent.includes('now friends'));
 await existing.reload();await existing.getByRole('button',{name:'Add alex as a friend',exact:true}).click();await existing.waitForFunction(()=>document.getElementById('invite-message').textContent.includes('already friends'));
 const {page:login}=await account(0,path);await login.getByRole('link',{name:'Already use DCC? Sign in and add',exact:true}).click();
 assert.equal(new URL(login.url()).searchParams.get('next'),path);
 await login.waitForFunction(()=>typeof window.dccAuthNext==='function');
 assert.deepEqual(await login.evaluate(()=>['//evil.test','https://evil.test','/\\evil.test','/safe\npath','/friend-invite/token'].map(window.dccAuthNext)),['/','/','/','/','/friend-invite/token']);
 await login.locator('#username').fill('fictional-devon');await login.locator('#password').fill('fictional-qa-password');await login.locator('#submitBtn').click();await login.waitForURL(origin+path);
 // Exercise the actual drake-auth adapter with a fictional managed session.
 // No Clerk account, external identity or remote request is created.
 const {page:managed,context:managedContext}=await account(0,path);
 await managedContext.addInitScript(()=>{
  window.Clerk={user:{id:'fictional-clerk-user'},load:async()=>{},session:{getToken:async()=> 'fictional-test-token'}};
 });
 await managed.route('**/api/auth/config',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({clerkPublishableKey:'pk_test_'+Buffer.from('fictional.clerk.test$').toString('base64')})}));
 let managedSyncs=0;
 managed.on('request',r=>{if(new URL(r.url()).pathname==='/api/auth/clerk-sync')managedSyncs++;});
 await managed.goto(origin+'/login?next='+encodeURIComponent(path)+'&auth=verifying',{waitUntil:'domcontentloaded'});
 await managed.waitForURL(origin+path);await managed.getByRole('button',{name:'Add alex as a friend',exact:true}).waitFor();assert.equal(managedSyncs,1);
 // New-user widget callback uses the same safe return URL and waits for sync.
 const {page:widget,context:widgetContext}=await account(0,path);
 await widgetContext.addInitScript(()=>{
  window.Clerk={user:null,load:async()=>{},session:{getToken:async()=> 'fictional-test-token'},
   mountSignIn:(_el,options)=>{window.fixtureClerkOptions=options;},addListener:listener=>{window.fixtureClerkListener=listener;return()=>{};},unmountSignIn:()=>{}};
 });
 await widget.route('**/api/auth/config',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({clerkPublishableKey:'pk_test_'+Buffer.from('fictional.clerk.test$').toString('base64')})}));
 await widget.goto(origin+'/register?next='+encodeURIComponent(path),{waitUntil:'domcontentloaded'});await widget.waitForFunction(()=>!!window.fixtureClerkListener);
 const returnUrl=await widget.evaluate(()=>window.fixtureClerkOptions.signUpForceRedirectUrl);assert.equal(new URL(returnUrl,origin).searchParams.get('next'),path);
 await widget.evaluate(()=>window.fixtureClerkListener({user:{id:'fictional-clerk-user'}}));await widget.waitForURL(origin+path);await widget.getByRole('button',{name:'Add alex as a friend',exact:true}).waitFor();
 await owner.locator('[data-friend-invite-revoke]').first().click();await existing.reload();await existing.waitForFunction(()=>document.getElementById('invite-message').textContent.includes('unavailable'));
 console.log('PASS: Invite Link create/copy, anonymous signup and login return, explicit existing-user add, account switch, interrupted acknowledgement, repeat/revoke and actual drake-auth managed-return/widget callbacks (fictional provider)');
 const {page:details,context:detailContext}=await account(5);await details.waitForFunction(()=>!!window.DCCCommitmentSync);
 const ids=await details.evaluate(async()=>{
  const ids=[];for(let i=0;i<2;i++){const id=crypto.randomUUID();ids.push(id);await DCC.api('/api/commitments',{method:'POST',body:{id,actionId:crypto.randomUUID(),title:'Fictional paged outcome '+i,definitionDone:'Reviewed result',committedDate:'2026-10-08',timeZone:'UTC'}});}
  for(let n=0;n<36;n++){const r=await DCC.api('/api/commitments/'+ids[0]);await DCC.api('/api/commitments/'+ids[0]+'/actions?limit=30',{method:'POST',body:{actionId:crypto.randomUUID(),expectedRevision:r.revision,kind:'comment',note:'Paged fictional comment '+n}});}
  await DCCCommitmentSync.refresh();return ids;
 });
 const latest=await details.evaluate(id=>DCCCommitmentSync.detail(id),ids[0]);assert.equal(latest.events.length,30);
 const paged=await details.evaluate(async({id,before})=>{await DCCCommitmentSync.detail(id,before);return (await DCCCommitmentSync.cached()).find(r=>r.id===id);},{id:ids[0],before:latest.nextBeforeRevision});assert.equal(paged.events.length,37);assert.equal(new Set(paged.events.map(e=>e.id)).size,37);
 await detailContext.setOffline(true);
 assert.equal(await details.evaluate(async id=>(await DCCCommitmentSync.detail(id)).events.length,ids[0]),37);
 assert.match(await details.evaluate(async id=>{try{await DCCCommitmentSync.detail(id);}catch(e){return e.message;}},ids[1]),/Connect to load/);
 await detailContext.setOffline(false);
 // A late history response cannot recreate a record removed by another tab's complete collection.
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 await details.route('**/api/commitments/'+ids[0]+'?limit=30',async r=>{const response=await r.fetch();entered();await gate;await r.fulfill({response});});
 const request=details.evaluate(id=>DCCCommitmentSync.detail(id),ids[0]);await started;
 const other=await detailContext.newPage();await other.route('**/api/commitments?summary=1',r=>r.fulfill({status:200,contentType:'application/json',body:'[]'}));await other.goto(origin,{waitUntil:'domcontentloaded'});await other.waitForFunction(()=>!!window.DCCCommitmentSync);await other.evaluate(()=>DCCCommitmentSync.refresh());release();await request;
 assert.equal(await details.evaluate(async id=>(await DCCCommitmentSync.cached()).some(r=>r.id===id),ids[0]),false);
 console.log('PASS: paged cache merge, no duplicate history, viewed/offline versus unviewed/connect-required, late detail versus cross-tab removal');
} finally {await Promise.all(contexts.map(c=>c.close()));await browser.close();}
