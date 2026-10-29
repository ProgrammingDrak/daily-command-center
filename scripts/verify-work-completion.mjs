/* global document, DCCWorkingQueue, innerWidth, getComputedStyle */
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
</script><script src="/public/js/work-checkin-policy.js"></script><script src="/public/js/work-sessions.js"></script><script src="/public/js/work-completion.js"></script><script src="/public/js/working-queue.js"></script><script>fixtureLoad().then(()=>dispatchEvent(new Event('dcc:data-ready')));</script></body></html>`)
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
const card = (id) => page.locator('[data-queue-id="' + id + '"]'),
  button = (id, action) => card(id).locator('[data-queue-action="' + action + '"]');
const closed = () => page.waitForFunction(() => !document.querySelector("[role=dialog]"));
const task = (id) => ctx.blockDB.getBlock(id);

try {
  const note='Next: compare the two sources. '+('Detailed operational history remains available here. '.repeat(25));
  const store=require('../conversation-store').createConversationStore(ctx),owner={userId:1,workspaceId:'ws-1'};
  await store.execute({action:'queue-note',taskId:'a',note,sourceEventId:'fixture-note',expectedRevision:0,at:new Date().toISOString()},owner);
  await page.goto(base);await page.waitForSelector('.wq-focus');
  assert.ok((await card('a').innerText()).length<700,'card has bounded context');
  assert.equal(await card('a').locator('.wq-context').evaluate(el=>el.open),false);
  await card('a').locator('.wq-context > summary').click();assert.equal(await card('a').locator('.wq-note').innerText(),note);
  await page.evaluate(()=>DCCWorkingQueue.render());assert.equal(await card('a').locator('.wq-context').evaluate(el=>el.open),true);
  await card('a').locator('.wq-context > summary').click();
  await page.screenshot({path:path.join(output,'owner-queue-desktop.png'),fullPage:true});
  for(const width of [1280,375]){
    await page.setViewportSize({width,height:900});await button('a','complete').click();
    await page.getByRole('dialog').getByText('Previously recorded',{exact:true}).waitFor();
    assert.match(await page.getByRole('dialog').innerText(),/90m/);assert.match(await page.getByRole('dialog').innerText(),/After completion \(estimated\)/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.dcc-overlay')).opacity==='1');
    await page.screenshot({path:path.join(output,width===375?'owner-completion-mobile.png':'owner-completion-desktop.png'),fullPage:false});
    await page.getByRole('button',{name:'Cancel',exact:true}).click();await closed();
    assert.equal((await task('a')).properties.startedAt,at);assert.equal((await task('a')).properties.actualMinutes,90);
  }
  await page.setViewportSize({width:1280,height:950});
  // Commit succeeds but response disappears: no confirmed total, identical retry envelope.
  let first=null,posts=0;const bodies=[];
  await page.route('**/api/working-queue',async route=>{
    if(route.request().method()==='POST'&&route.request().postDataJSON().action==='done'){
      bodies.push(route.request().postDataJSON());posts++;
      if(!first){first=bodies[0];await route.fetch();return route.abort();}
    }
    return route.continue();
  });
  await button('a','complete').click();await page.getByRole('dialog').getByText('Previously recorded',{exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'Complete',exact:true}).evaluate(el=>{el.click();el.click();});
  await page.getByRole('dialog').getByRole('status').filter({hasText:'Completion not confirmed'}).waitFor();
  assert.equal(posts,1);assert.equal(await page.getByText(/^Task completed ·/).count(),0);
  await page.getByRole('dialog').getByRole('button',{name:'Complete',exact:true}).click();await closed();
  assert.equal(posts,2);assert.deepEqual(bodies[1],first);
  const expectedMinutes=90+Math.max(1,Math.round((Date.parse(first.at)-Date.parse(at))/60000));
  assert.equal((await task('a')).properties.actualMinutes,expectedMinutes);assert.equal((await ctx.blockDB.getTaskTimeEntries('a','ws-1')).length,1);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['short context with full accessible history','completion desktop/mobile','cancel writes nothing','legacy recorded history','double click','lost response unconfirmed','same envelope retry','one saved session'],screenshots:output}));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await ctx.close();}
