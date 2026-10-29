/* global document, DCCWorkingQueue, innerWidth */
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
const output=process.env.DCC_QA_OUTPUT||"/tmp/dcc-shared-queue-qa";
await (await import("node:fs/promises")).mkdir(output,{recursive:true});
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
const at = new Date(Date.now() - 120000).toISOString();
await make("parent", "Launch project");
await make("a", "Review copy", {
  subtaskOf: "parent",
  startedAt: at,
  workStateChangedAt: at,
  actualMinutes:90, activeWorkSessionId: "fixture-a"
});
await make("b", "Research options", {start:"09:00",end:"09:30"});
await make("d", "Next recurring occurrence", {responsibilityId:"routine",taskPriority:"Low"});
await make("legacy-pq", "Legacy activity needs review", {actualMinutes:0});
await make("c", "Prepare outline");
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
    .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/tokens.css"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"></head><body style="padding:20px"><button class="tab" data-tab="schedule">Itinerary</button><button class="tab active" data-tab="working-queue">Working Queue</button><button class="tab" data-tab="budget">Budget</button><div class="tab-content" id="tab-schedule">Itinerary fixture</div><div class="tab-content active" id="tab-working-queue"><div id="working-queue-root"></div></div><div class="tab-content" id="tab-budget">Budget fixture</div><div id="toast-container"></div>
<script>window.__state={date:"2099-01-02"};window.addActionItem=()=>{};window.closeNotesDrawer=()=>{};window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'ws-1'};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/task-types.js"></script><script src="/public/js/task-model.js"></script><script src="/public/js/tabs.js"></script>
<script>window.scheduled=[];window.backlog=[];window.fixtureRows=[];window.isDone=t=>t.status==='done';window.render=()=>{};
window.blockStore={get:id=>fixtureRows.find(r=>r.id===id),getByType:()=>fixtureRows,acceptWorkRotation:rows=>{for(const row of rows){const i=fixtureRows.findIndex(r=>r.id===row.id);if(i>=0)fixtureRows[i]=row;else fixtureRows.push(row);}scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));}};
window.fixtureLoad=async()=>{fixtureRows=await fetch('/fixture/tasks').then(r=>r.json());scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));};window.petDeliveries=[];DCC.PetNudge={deliverWorkCheckIn:async(text,options)=>{petDeliveries.push(text);DCC.toast(text,'info',60000,{label:'Open queue',onClick:options.open});}};
</script><script src="/public/js/work-checkin-policy.js"></script><script src="/public/js/work-sessions.js"></script><script src="/public/js/work-completion.js"></script><script src="/public/js/completed-queue-filter.js"></script><script src="/public/js/working-queue.js"></script><script>fixtureLoad().then(()=>dispatchEvent(new Event('dcc:data-ready')));</script></body></html>`)
);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});
const context = await browser.newContext({ viewport: { width: 1280, height: 950 } }),
  page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  const now=Date.parse('2026-10-29T16:00:00.000Z'),today=new Date(now).setUTCHours(0,0,0,0),order=[],items={};
  await page.clock.install({time:now});
  for(const [id,title,at] of [['recent','Finish the launch checklist',now-600000],['tie','Review the welcome screens',now-600000],['yesterday','Publish the previous draft',today-60000],['week','Complete the first review',now-3*86400000],['month','Review the initial concept',now-14*86400000],['old','Archive the earlier milestone',now-45*86400000],['unknown','Imported completed task',null]]){
    await make(id,title,{status:'done',...(at===null?{}:{completedAt:new Date(at).toISOString()})});order.push(id);items[id]={status:'completed'};
  }
  await ctx.pool.query('INSERT INTO work_rotations(user_id,workspace_id,state) VALUES(1,$1,$2)',['ws-1',{version:2,order,items}]);
  const before=(await ctx.pool.query('SELECT id,properties FROM blocks ORDER BY id')).rows;let posts=0;
  page.on('request',r=>{if(r.method()==='POST')posts++;});
  await page.goto(base);await page.waitForSelector('.wq-focus');
  await page.locator('.wq-completed > summary').click();
  const select=page.getByRole('combobox',{name:'Completed timeframe'}),cards=page.locator('.wq-completed [data-queue-id]');
  assert.equal(await select.inputValue(),'today');assert.equal(await cards.count(),2);
  await select.selectOption('latest');assert.equal(await cards.count(),1);assert.equal(await cards.first().getAttribute('data-queue-id'),'recent');
  await select.selectOption('hour');assert.equal(await cards.count(),2);
  await select.selectOption('day');assert.equal(await cards.count(),3);
  await select.selectOption('week');assert.equal(await cards.count(),4);
  await select.selectOption('month');assert.equal(await cards.count(),5);
  await select.selectOption('all');assert.equal(await cards.count(),7);await page.getByText('Completion time unavailable',{exact:true}).waitFor();
  await select.focus();await page.keyboard.press('t');await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
  assert.equal(await select.inputValue(),'today');assert.equal(await select.evaluate(el=>el===document.activeElement),true);
  await select.selectOption('all');await page.evaluate(()=>DCCWorkingQueue.refresh());assert.equal(await select.inputValue(),'all');
  await page.reload();await page.waitForSelector('.wq-focus');await page.locator('.wq-completed > summary').click();assert.equal(await select.inputValue(),'today');
  for(const width of [1280,375]){
    await page.setViewportSize({width,height:900});await page.locator('.wq-completed').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('.wq-completed').screenshot({path:path.join(output,width===375?'completed-filter-mobile.png':'completed-filter-desktop.png')});
  }
  // Empty dated result still exposes every choice; use the same API with synthetic old timestamps.
  await page.route('**/api/working-queue',async route=>{const response=await route.fetch(),data=await response.json();for(const item of data.queue.items)if(item.status==='completed'&&item.completedAt!==null)item.completedAt=now-2*3600000;return route.fulfill({response,json:data});});
  await select.selectOption('hour');await page.evaluate(()=>DCCWorkingQueue.refresh());await page.getByText('No completed tasks in this time range.',{exact:true}).waitFor();assert.equal(await select.isVisible(),true);
  assert.equal(posts,0);assert.deepEqual((await ctx.pool.query('SELECT id,properties FROM blocks ORDER BY id')).rows,before);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['Today default/reload','all seven ranges','latest tie','unknown timestamp','empty range','refresh retains choice','keyboard focus','375px/desktop','zero writes'],screenshots:output}));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await ctx.close();}
