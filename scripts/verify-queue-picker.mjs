/* global window, document, innerWidth */
// Isolated PostgreSQL + real API/UI; no .env, live tasks, or shared browser profile.
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (
  !process.env.DCC_TEST_DATABASE_URL ||
  !["localhost", "127.0.0.1"].includes(new URL(process.env.DCC_TEST_DATABASE_URL).hostname)
)
  throw new Error("A disposable localhost database is required");
const ctx = await require("../test-support/activity-db").createActivityDb();
Object.assign(ctx, { APP_TIME_ZONE: "UTC", broadcast() {} });
await ctx.pool.query(require("../conversation-store").FOREGROUND_INDEX_SQL);
const make = (id, title, p = {}) =>
  ctx.blockDB.createBlock({
    id,
    type: "block",
    date: "2099-01-02",
    user_id: 1,
    workspace_id: "ws-1",
    properties: { local_id: id, title, type: "task", duration: 30, status: "open", ...p }
  });
await make("older", "Finish earlier work");
await ctx.pool.query("UPDATE blocks SET date='2020-01-01' WHERE id='older'");
await make("rich-notes", "Subtask with rich notes", {html:"<p>Preserve details</p>",text:"Preserve details",_taskNotes:{text:"Keep notes"}});
for(let i=0;i<58;i++)await make("valid-"+String(i).padStart(2,'0'),"Eligible task "+String(i).padStart(2,'0'));
for(let i=0;i<125;i++)await ctx.blockDB.createBlock({id:'note-'+i,type:'block',user_id:1,workspace_id:'ws-1',properties:{html:'<p>Keep note</p>',text:'Keep note',_sourceTaskId:'older'}});
await ctx.pool.query("UPDATE blocks SET date=NULL WHERE id='valid-00'");
await make("done", "Completed sentinel", {status:"completed"});
process.env.DCC_CONVERSATION_ENABLED = "true";
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.session = { userId: 1 };
  req.workspaceId = "ws-1";
  res.set("Cache-Control", "no-store");
  next();
});
app.use("/public", express.static(path.join(root, "public")));
require("../routes/working-queue")(app, ctx);
require("../routes/guided")(app, ctx);
app.get("/fixture/tasks", async (_req, res) =>
  res.json((await ctx.pool.query("SELECT * FROM blocks WHERE type='block' AND deleted_at IS NULL")).rows)
);
app.get("/", (_req, res) =>
  res.type("html")
    .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"></head><body style="padding:20px"><nav id="tab-bar" aria-label="Pages"><button class="tab active" type="button" data-page="tasks">Tasks</button><button class="tab" type="button" data-page="budget" data-tab="budget">Budget</button></nav><div id="task-view-switch" role="tablist"><button type="button" role="tab" data-task-view="queue">Working Queue</button><button type="button" role="tab" data-task-view="list">Itinerary</button><button type="button" role="tab" data-task-view="calendar">Calendar</button></div><button type="button" id="task-actual-toggle" aria-pressed="false" hidden>Actual</button><div class="tab-content" id="tab-schedule">Itinerary fixture</div><div class="tab-content active" id="tab-working-queue"><div id="working-queue-root"></div></div><div class="tab-content" id="tab-budget">Budget fixture</div><div id="toast-container"></div>
<script>window.__state={date:"2099-01-02"};window.addActionItem=()=>{};window.closeNotesDrawer=()=>{};window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'ws-1'};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/task-types.js"></script><script src="/public/js/task-model.js"></script><script src="/public/js/nav-state.js"></script><script src="/public/js/tabs.js"></script>
<script>window.scheduled=[];window.backlog=[];window.fixtureRows=[];window.isDone=t=>t.status==='done';window.render=()=>{};
window.blockStore={get:id=>fixtureRows.find(r=>r.id===id),getByType:()=>fixtureRows,acceptWorkRotation:rows=>{for(const row of rows){const i=fixtureRows.findIndex(r=>r.id===row.id);if(i>=0)fixtureRows[i]=row;else fixtureRows.push(row);}scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));}};
window.fixtureLoad=async()=>{fixtureRows=await fetch('/fixture/tasks').then(r=>r.json());scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));};window.petDeliveries=[];DCC.PetNudge={deliverWorkCheckIn:async(text,options)=>{petDeliveries.push(text);DCC.toast(text,'info',60000,{label:'Open queue',onClick:options.open});}};
</script>${require("../test-support/queue-browser-components")()}<script src="/public/js/work-checkin-policy.js"></script><script src="/public/js/queue-policy.js"></script><script src="/public/js/work-sessions.js"></script><script src="/public/js/work-completion.js"></script><script src="/public/js/completed-queue-filter.js"></script><script src="/public/js/working-queue.js"></script><script>fixtureLoad().then(()=>dispatchEvent(new Event('dcc:data-ready')));</script></body></html>`)
);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
const errors=[];
try {
  for(const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:1000}});
    page.on('pageerror',error=>errors.push(error.message));
    const requests=[];page.on('request',request=>{if(request.url().includes('/api/working-queue/tasks?'))requests.push(request.url());});
    await page.goto(base);await page.getByRole('button',{name:'Add tasks',exact:true}).waitFor();
    const open=async()=>{await page.getByRole('button',{name:'Add tasks',exact:true}).click();await page.getByRole('dialog').waitFor();};
    const input=()=>page.getByRole('searchbox');
    await open();await page.locator('[data-add-id]').first().waitFor();
    assert.equal(await page.locator('[data-add-id]').count(),50);
    assert.ok(!(await page.getByRole('dialog').innerText()).includes('sentinel'));
    // More is serialized even when a second click is dispatched immediately.
    const beforeMore=requests.length;
    await page.locator('[data-more]').evaluate(el=>{el.click();el.click();});
    await page.locator('[data-add-id]').nth(59).waitFor();
    assert.equal(await page.locator('[data-add-id]').count(),60);
    assert.equal(requests.length,beforeMore+1);
    assert.equal(await page.locator('[data-more]').isVisible(),false);
    assert.equal(await page.locator('[data-add-id="valid-00"] small').innerText(),'Unscheduled');
    assert.ok(await page.locator('[data-add-id="older"]').isVisible());
    assert.ok(await page.locator('[data-add-id="rich-notes"]').isVisible());
    await input().fill('No such task');await page.getByText('No matching open tasks.',{exact:false}).waitFor();
    assert.equal(await page.locator('[data-add-id]').count(),0);
    await input().fill('earlier');await page.locator('[data-add-id="older"]').waitFor();
    assert.equal(await page.locator('[data-add-id]').count(),1);
    // A delayed older query cannot replace a newer query, including its error status.
    let unblock,started;const slowStarted=new Promise(resolve=>{started=resolve;});const slowGate=new Promise(resolve=>{unblock=resolve;});
    await page.route('**/api/working-queue/tasks?**',async route=>{if(new URL(route.request().url()).searchParams.get('query')!=='slow'){await route.continue();return;}started();await slowGate;await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'STALE ERROR'})}).catch(()=>{});});
    await input().fill('slow');await slowStarted;await input().fill('Eligible task 01');
    await page.locator('[data-add-id="valid-01"]').waitFor();unblock();
    assert.equal(await page.locator('[data-add-id]').count(),1);assert.ok(!(await page.getByRole('dialog').innerText()).includes('STALE ERROR'));
    await page.unroute('**/api/working-queue/tasks?**');
    await input().fill('Eligible task '+(width===1440?'01':'02'));
    const add=page.locator('[data-add-id="'+(width===1440?'valid-01':'valid-02')+'"]');await add.waitFor();
    let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url()===base+'/api/working-queue')writes++;});
    await add.evaluate(el=>{el.click();el.click();});await page.getByText('Added to queue.',{exact:true}).waitFor();assert.equal(writes,1);assert.equal(await add.isDisabled(),true);
    await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
    await open();await page.locator('[data-add-id]').first().waitFor();
    await page.screenshot({path:'/tmp/dcc-picker-'+width+'-synthetic.png'});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    // Closing while a query is in flight invalidates it; a new picker owns a new search.
    let release,signal;const pending=new Promise(resolve=>{signal=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/working-queue/tasks?**',async route=>{if(new URL(route.request().url()).searchParams.get('query')!=='closing'){await route.continue();return;}signal();await gate;await route.fulfill({json:{tasks:[{id:'stale',title:'STALE CLOSED'}],nextOffset:null}}).catch(()=>{});});
    await input().fill('closing');await pending;await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
    await open();await page.locator('[data-add-id]').first().waitFor();release();assert.equal(await page.getByText('STALE CLOSED').count(),0);
    await page.evaluate(()=>window.DCC.nav.go({page:'budget'}));await page.getByRole('dialog').waitFor({state:'detached'});
    await page.close();console.log('PASS picker desktop/mobile '+width+': prefiltered pages, More, older/unscheduled/notes, empty/search, duplicate clicks, stale errors, close/reopen, navigation');
  }
  assert.deepEqual(errors,[]);console.log('PASS zero browser errors');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await ctx.close();}
