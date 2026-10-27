/* global localStorage, window, document, innerWidth, DCCWorkRotation, petDeliveries */
// Disposable review fixture: real PostgreSQL, real rotation routes and browser UI.
// Never starts server.js or reads the application's live environment/database.
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright-core";
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
if(!process.env.DCC_TEST_DATABASE_URL || !["localhost","127.0.0.1"].includes(new URL(process.env.DCC_TEST_DATABASE_URL).hostname))throw new Error("An isolated localhost test database is required");
const ctx=await require("../test-support/activity-db").createActivityDb();
Object.assign(ctx,{APP_TIME_ZONE:"UTC",broadcast(){}});
const app=express();app.use(express.json());
app.use((req,res,next)=>{req.session={userId:1};req.workspaceId="ws-1";res.setHeader("Cache-Control","no-store");next();});
app.use("/public",express.static(path.join(root,"public")));
require("../routes/work-rotation")(app,ctx);require("../routes/guided")(app,ctx);
const make=async(id,title,extra={})=>ctx.blockDB.createBlock({id,type:"block",date:"2099-01-02",workspace_id:"ws-1",user_id:1,properties:{local_id:id,title,type:"task",duration:30,...extra}});
const at=new Date(Date.now()-120000).toISOString();
await make("parent","Launch project");await make("a","Review copy",{subtaskOf:"parent",startedAt:at,workStateChangedAt:at,activeWorkSessionId:"fixture-session"});await make("b","Research options");await make("c","Prepare outline");
app.get("/fixture/tasks",async(_req,res)=>res.json((await ctx.pool.query("SELECT * FROM blocks WHERE type='block' AND workspace_id='ws-1' AND deleted_at IS NULL")).rows));
app.get("/",(_req,res)=>res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/core-ui.css"></head><body style="padding:20px"><h1>Manual task switching · synthetic review</h1><div id="active-work-dock"></div><div id="toast-container"></div>
<script>window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'ws-1'};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/task-types.js"></script><script src="/public/js/task-model.js"></script>
<script>
window.scheduled=[];window.backlog=[];window.fixtureRows=[];window.isDone=t=>t.status==='done'||!!t.completedAt;window.render=()=>{};
window.blockStore={get:id=>fixtureRows.find(r=>r.id===id),getByType:()=>fixtureRows,acceptWorkRotation:rows=>{for(const row of rows){const i=fixtureRows.findIndex(r=>r.id===row.id);if(i>=0)fixtureRows[i]=row;else fixtureRows.push(row);}scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));DCCWorkSessions.refresh();}};
window.fixtureLoad=async()=>{fixtureRows=await fetch('/fixture/tasks').then(r=>r.json());scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));DCCWorkSessions.refresh();};
window.petDeliveries=[];DCC.PetNudge={deliverWorkCheckIn:async(text,options)=>{petDeliveries.push(text);DCC.toast(text,'info',60000,{label:'Open',onClick:options.open});}};
</script><script src="/public/js/work-checkin-policy.js"></script><script src="/public/js/work-sessions.js"></script><script src="/public/js/work-rotation.js"></script><script>fixtureLoad().then(()=>dispatchEvent(new Event('dcc:data-ready')));</script></body></html>`));
const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
const base="http://127.0.0.1:"+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
page.on("pageerror",e=>errors.push(e.message));
const task=id=>ctx.blockDB.getBlock(id);
const open=async()=>{await page.getByRole("button",{name:"Switch tasks",exact:true}).first().click();await page.waitForFunction(()=>document.querySelector('[data-switch-target]'));};
const submit=async target=>{await page.locator('[data-switch-target]').selectOption(target);await page.getByRole("dialog").getByRole("button",{name:"Switch tasks",exact:true}).click();};
try {
 await page.goto(base);await page.waitForSelector('[data-work-switch="a"]');
 await open();await page.getByRole("button",{name:"Cancel",exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));assert.equal((await task("a")).properties.startedAt,at);assert.equal((await task("b")).properties.startedAt,undefined);
 await open();await page.keyboard.press("Escape");await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));assert.equal((await task("b")).properties.startedAt,undefined);
 await open();await submit("b");await page.waitForSelector('[data-work-switch="b"]');assert.equal((await task("a")).properties.startedAt,undefined);assert.equal((await task("a")).properties.subtaskOf,"parent");assert.equal((await task("a")).properties.actualMinutes,2);
 await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
 await page.reload();await page.waitForSelector('[data-background-id="a"]');assert.match(await page.locator('#background-work-dock').innerText(),/Launch project › Review copy/);
 // Simulate a slept tab crossing its persisted deadline without wall-clock sleeps.
 await ctx.pool.query("UPDATE work_rotations SET state=jsonb_set(state,'{background,a,dueAt}',to_jsonb($1::text))",[new Date(Date.now()-1000).toISOString()]);
 await page.evaluate(()=>DCCWorkRotation.tick());assert.equal(await page.evaluate(()=>petDeliveries.length),1);
 await page.reload();await page.waitForSelector('[data-background-id="a"]');await page.evaluate(()=>DCCWorkRotation.tick());assert.equal(await page.evaluate(()=>petDeliveries.length),0);
 const second=await context.newPage();await second.goto(base);await second.waitForSelector('[data-background-id="a"]');await second.evaluate(()=>DCCWorkRotation.tick());assert.equal(await second.evaluate(()=>petDeliveries.length),0);
 // The storage listener must not create a cross-tab refresh/write feedback loop.
 let gets=0;context.on("request",r=>{if(r.url().endsWith('/api/work-rotation')&&r.method()==='GET')gets++;});
 await page.evaluate(()=>DCCWorkRotation.refresh());await page.waitForTimeout(250);assert.ok(gets<5,"storage update does not ping-pong between tabs");
 await page.locator('[data-background-id="a"] [data-background-action="snooze"]').click();await page.waitForFunction(()=>document.querySelector('#background-work-dock').textContent.includes('Check back in 5m'));
 assert.equal((await ctx.pool.query("SELECT state FROM work_rotations")).rows[0].state.background.a.notifiedAt,null);
 await second.close();
 // A claimed reminder arriving after snooze must not present the old generation.
 await ctx.pool.query("UPDATE work_rotations SET state=jsonb_set(state,'{background,a,dueAt}',to_jsonb($1::text))",[new Date(Date.now()-1000).toISOString()]);
 let claimFetched,releaseClaim;
 const fetched=new Promise(resolve=>{claimFetched=resolve;}),released=new Promise(resolve=>{releaseClaim=resolve;});
 await page.route('**/api/work-rotation',async route=>{
  if(route.request().method()==='POST'&&route.request().postDataJSON().action==='claim'){
   const response=await route.fetch();claimFetched();await released;return route.fulfill({response});
  }
  return route.continue();
 });
 await page.evaluate(()=>{window.fixtureTick=DCCWorkRotation.tick();});await fetched;
 await page.evaluate(()=>DCCWorkRotation.refresh());
 await page.locator('[data-background-id="a"] [data-background-action="snooze"]').click();
 await page.waitForFunction(()=>document.querySelector('#background-work-dock').textContent.includes('Check back in 5m'));
 releaseClaim();await page.evaluate(()=>window.fixtureTick);assert.equal(await page.evaluate(()=>petDeliveries.length),0);
 await page.unroute('**/api/work-rotation');
 await page.locator('[data-background-id="a"] [data-background-action="return"]').click();await page.getByRole("dialog").getByRole("button",{name:"Switch tasks",exact:true}).click();await page.waitForSelector('[data-work-switch="a"]');await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
 await page.locator('[data-background-id="b"] [data-background-action="dismiss"]').click();await page.waitForFunction(()=>!document.querySelector('[data-background-id="b"]'));assert.ok(await task("b"));
 // Lose the POST response after it committed: reload + Retry must not switch twice.
 let lost=false;await page.route('**/api/work-rotation',async route=>{if(!lost&&route.request().method()==='POST'&&route.request().postDataJSON().action==='switch'){lost=true;await route.fetch();return route.abort();}return route.continue();});
 await open();await submit("c");await page.waitForSelector('[data-rotation-retry]');await page.getByRole("button",{name:"Cancel",exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
 const before=(await ctx.blockDB.getTaskTimeEntries('a','ws-1')).length;await page.locator('[data-rotation-retry]').click();await page.waitForFunction(()=>!document.querySelector('[data-rotation-retry]'));assert.equal((await ctx.blockDB.getTaskTimeEntries('a','ws-1')).length,before);
 await page.waitForSelector('[data-work-switch="c"]');
 await page.unroute('**/api/work-rotation');
 // Persist an uncertain next switch, then recover its exact operation after reload.
 lost=false;await page.route('**/api/work-rotation',async route=>{if(!lost&&route.request().method()==='POST'&&route.request().postDataJSON().action==='switch'){lost=true;await route.fetch();return route.abort();}return route.continue();});
 await open();await submit("b");await page.waitForSelector('[data-rotation-retry]');await page.reload();await page.waitForSelector('[data-rotation-retry]');await page.locator('[data-rotation-retry]').click();await page.waitForFunction(()=>!document.querySelector('[data-rotation-retry]'));await page.waitForSelector('[data-work-switch="b"]');
 await page.unroute('**/api/work-rotation');
 // Cached backgrounds and pending Retry remain visible when the endpoint is offline.
 await page.evaluate(()=>{const key='dcc-work-rotation:ws-1:1:pending';localStorage.setItem(key,JSON.stringify({action:'dismiss',operationId:'synthetic-offline',expectedRevision:0,taskId:'a',generation:'stale'}));});
 await page.route('**/api/work-rotation',route=>route.abort());
 await page.reload();await page.waitForSelector('[data-background-id="a"]');await page.waitForSelector('[data-rotation-retry]');
 await page.evaluate(()=>localStorage.removeItem('dcc-work-rotation:ws-1:1:pending'));await page.unroute('**/api/work-rotation');
 await page.reload();await page.waitForSelector('[data-background-id="a"]');
 // Completion filters a background out without changing rotation revision.
 await ctx.pool.query("UPDATE work_rotations SET state=jsonb_set(jsonb_set(state,'{background,a,dueAt}',to_jsonb($1::text)),'{background,a,notifiedAt}','null')",[new Date(Date.now()-1000).toISOString()]);
 let completedClaimFetched,releaseCompletedClaim;
 const completedFetched=new Promise(resolve=>{completedClaimFetched=resolve;}),completedReleased=new Promise(resolve=>{releaseCompletedClaim=resolve;});
 await page.route('**/api/work-rotation',async route=>{
  if(route.request().method()==='POST'&&route.request().postDataJSON().action==='claim'){
   const response=await route.fetch();completedClaimFetched();await completedReleased;return route.fulfill({response});
  }
  return route.continue();
 });
 await page.evaluate(()=>{window.fixtureTick=DCCWorkRotation.tick();});await completedFetched;
 await ctx.pool.query("UPDATE blocks SET properties=properties || $2::jsonb WHERE id=$1",['a',{completedAt:new Date().toISOString(),status:'done'}]);
 await page.evaluate(()=>DCCWorkRotation.refresh());assert.equal(await page.locator('[data-background-id="a"]').count(),0);
 releaseCompletedClaim();await page.evaluate(()=>window.fixtureTick);
 assert.equal(await page.locator('[data-background-id="a"]').count(),0);assert.equal(await page.evaluate(()=>petDeliveries.length),0);
 await page.unroute('**/api/work-rotation');
 await page.setViewportSize({width:375,height:812});await page.screenshot({path:process.env.DCC_ROTATION_SCREENSHOT||'/tmp/dcc-work-rotation-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:["cancel","escape","switch","effort","hierarchy","reload","expiry","one delivery across tabs","snooze","return","dismiss","lost response retry","late reminder response","offline cache and retry","completion during delayed claim","mobile overflow"]}));
}finally{await browser.close();await new Promise(r=>server.close(r));await ctx.close();}
