/* global window, document, localStorage, DCCWorkingQueue, petDeliveries, innerWidth */
// Isolated PostgreSQL + real API/UI; no .env, live tasks, or shared browser profile.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { performance } from "node:perf_hooks";
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
const streams = new Set();
function broadcast(type, data = {}, workspaceId = "ws-1") {
  for (const stream of streams) {
    if (stream.workspaceId === workspaceId) stream.res.write("data: " + JSON.stringify({ type, ...data }) + "\n\n");
  }
}
Object.assign(ctx, { APP_TIME_ZONE: "UTC", broadcast });
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
  activeWorkSessionId: "fixture-a"
});
await make("b", "Research options", {start:"09:00",end:"09:30"});
await make("d", "Next recurring occurrence", {responsibilityId:"routine",taskPriority:"Low"});
await make("legacy-pq", "Legacy activity needs review", {actualMinutes:0});
await make("c", "Prepare outline");
process.env.DCC_CONVERSATION_ENABLED = "true";
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const userId = req.headers.cookie?.includes("fixture-account=2") ? 2 : 1;
  req.session = { userId };
  req.workspaceId = "ws-" + userId;
  res.set("Cache-Control", "no-store");
  next();
});
app.get("/api/events", (req, res) => {
  const stream = { res, workspaceId: req.workspaceId };
  res.type("text/event-stream").write("data: connected\n\n");
  streams.add(stream);
  req.on("close", () => streams.delete(stream));
});
app.use("/public", express.static(path.join(root, "public")));
require("../routes/working-queue")(app, ctx);
require("../routes/guided")(app, ctx);
app.get("/fixture/tasks", async (_req, res) =>
  res.json((await ctx.pool.query("SELECT * FROM blocks WHERE type='block' AND deleted_at IS NULL AND user_id=$1", [_req.session.userId])).rows)
);
app.get("/", (req, res) =>
  res.type("html")
    .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"></head><body style="padding:20px"><nav id="tab-bar" aria-label="Pages"><button class="tab active" type="button" data-page="tasks">Tasks</button><button class="tab" type="button" data-page="budget" data-tab="budget">Budget</button></nav><div id="task-view-switch" role="tablist"><button type="button" role="tab" data-task-view="queue">Working Queue</button><button type="button" role="tab" data-task-view="list">Itinerary</button><button type="button" role="tab" data-task-view="calendar">Calendar</button></div><button type="button" id="task-actual-toggle" aria-pressed="false" hidden>Actual</button><div class="tab-content" id="tab-schedule">Itinerary fixture</div><div class="tab-content active" id="tab-working-queue"><div id="working-queue-root"></div></div><div class="tab-content" id="tab-budget">Budget fixture</div><div id="toast-container"></div>
<script>window.__state={date:"2099-01-02"};window.addActionItem=()=>{};window.closeNotesDrawer=()=>{};window.DCC_ACCOUNT_CONTEXT={userId:${req.session.userId},workspaceId:${JSON.stringify(req.workspaceId)}};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/task-types.js"></script><script src="/public/js/task-model.js"></script><script src="/public/js/nav-state.js"></script><script src="/public/js/tabs.js"></script>
<script>window.scheduled=[];window.backlog=[];window.fixtureRows=[];window.isDone=t=>t.status==='done';window.render=()=>{};
window.blockStore={handleBlocksChanged:()=>window.fixtureLoad(),get:id=>fixtureRows.find(r=>r.id===id),getByType:()=>fixtureRows,acceptWorkRotation:rows=>{for(const row of rows){const i=fixtureRows.findIndex(r=>r.id===row.id);if(i>=0)fixtureRows[i]=row;else fixtureRows.push(row);}scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));}};
window.fixtureLoad=async()=>{fixtureRows=await fetch('/fixture/tasks').then(r=>r.json());scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));};window.petDeliveries=[];DCC.PetNudge={deliverWorkCheckIn:async(text,options)=>{petDeliveries.push(text);DCC.toast(text,'info',60000,{label:'Open queue',onClick:options.open});}};
</script>${require("../test-support/queue-browser-components")()}<script src="/public/js/work-checkin-policy.js"></script><script src="/public/js/queue-policy.js"></script><script src="/public/js/work-sessions.js"></script><script src="/public/js/work-completion.js"></script><script src="/public/js/completed-queue-filter.js"></script><script src="/public/js/working-queue.js"></script><script src="/public/js/refresh-coordinator.js"></script><script src="/public/js/sse.js"></script><script>fixtureLoad().then(()=>dispatchEvent(new Event('dcc:data-ready')));</script></body></html>`)
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
if (process.env.DCC_QUEUE_BENCHMARK === "1") {
  let snapshotBuilds = 0, databaseQueries = 0, databaseResultBytes = 0;
  let gets = 0, httpBodyBytes = 0;
  for (let n = 0; n < 90; n++) {
    await make("bench-" + n, "Synthetic task " + n, { notes: "Synthetic queue detail ".repeat(105) });
  }
  const ids = Array.from({length:90}, (_,n)=>"bench-"+n);
  await ctx.pool.query("INSERT INTO work_rotations(user_id,workspace_id,state) VALUES(1,'ws-1',$1)",
    [{version:2,order:ids,items:Object.fromEntries(ids.map(id=>[id,{status:"queued"}]))}]);
  const observed = new WeakSet();
  let measuring = false;
  ctx.pool.on("acquire", client => {
    if (observed.has(client)) return;
    observed.add(client);
    const query = client.query;
    client.query = function (sql, ...args) {
      if (measuring) {
        databaseQueries++;
        if (sql.includes("SELECT state FROM work_rotations")) snapshotBuilds++;
      }
      return query.call(this, sql, ...args);
    };
    client.connection.on("dataRow", msg => { if (measuring) databaseResultBytes += msg.length + 1; });
  });
  const second = await browser.newPage({viewport:{width:1280,height:950}});
  for (const tab of [page,second]) tab.on("response", response => {
    if (!measuring || response.request().method() !== "GET" || !response.url().endsWith("/api/working-queue")) return;
    gets++;
    httpBodyBytes += Number(response.headers()["content-length"] || 0);
  });
  try {
    await Promise.all([page,second].map(tab => tab.goto(base)));
    await Promise.all([page,second].map(tab => tab.waitForFunction(() => DCCWorkingQueue.getState().queue.order.length === 91)));
    assert.equal(streams.size, 2);
    assert.deepEqual(await Promise.all([page,second].map(tab=>tab.evaluate(()=>document.visibilityState))), ["visible","visible"]);
    await new Promise(r=>setTimeout(r,1000));
    measuring = true;
    const idleMs = Number(process.env.DCC_QUEUE_IDLE_MS || 300000);
    await new Promise(r=>setTimeout(r,idleMs));
    measuring = false;
    const idle = {idleMs,gets,snapshotBuilds,databaseQueries,databaseResultBytes,httpBodyBytes};
    const remoteStarted = performance.now();
    await ctx.blockDB.updateBlock("bench-0", { properties: { title: "Remote synthetic edit" } });
    ctx.broadcast("blocks-changed", { action:"update", blockIds:["bench-0"] }, "ws-1");
    const remoteChangeMs = await Promise.all([page,second].map(async tab=>{
      await tab.waitForFunction(()=>DCCWorkingQueue.getState().queue.items.some(item=>item.task.properties.title==="Remote synthetic edit"));
      return Math.round(performance.now()-remoteStarted);
    }));
    console.log(JSON.stringify({idle,remoteChangeMs}));
    if (process.env.DCC_QUEUE_REQUIRE_IDLE_GUARD === "1") {
      assert.equal(snapshotBuilds, 0, "unchanged visible tabs must not build snapshots");
      assert.ok(remoteChangeMs.every(ms => ms < 5000), "both tabs see the SSE edit within five seconds");
    }
    // Start immediately after the next fallback so the dropped-event test spans a full interval.
    await Promise.all([page,second].map(tab=>tab.waitForResponse(response =>
      response.url().endsWith("/api/working-queue") && response.request().method()==="GET", {timeout:32000})));
    const missedStarted = performance.now();
    await ctx.blockDB.updateBlock("bench-1", { properties: { title: "Edit without event" } });
    await Promise.all([page,second].map(tab => tab.waitForFunction(() =>
      DCCWorkingQueue.getState().queue.items.some(item=>item.task.properties.title==="Edit without event"), null, {timeout:32000})));
    console.log(JSON.stringify({missedEventMs: Math.round(performance.now()-missedStarted)}));
    for (const stream of streams) stream.res.end();
    const reconnectStarted = performance.now();
    await ctx.blockDB.updateBlock("bench-2", { properties: { title: "Edit during disconnect" } });
    await Promise.all([page,second].map(tab => tab.waitForFunction(() =>
      DCCWorkingQueue.getState().queue.items.some(item=>item.task.properties.title==="Edit during disconnect"), null, {timeout:8000})));
    console.log(JSON.stringify({reconnectMs: Math.round(performance.now()-reconnectStarted)}));
    const orderingStarted = performance.now();
    await page.evaluate(async () => {
      const {revision, queue} = DCCWorkingQueue.getState();
      await DCCWorkingQueue.send({action:"queue-reorder",sourceEventId:crypto.randomUUID(),
        expectedRevision:revision,at:new Date().toISOString(),order:[...queue.order].reverse()});
    });
    await second.waitForFunction(() => DCCWorkingQueue.getState().queue.order[0]==="a", null, {timeout:5000});
    console.log(JSON.stringify({remoteOrderMs: Math.round(performance.now()-orderingStarted)}));

    const dueAt = new Date(Date.now()+2500).toISOString();
    await ctx.pool.query(`UPDATE work_rotations SET state=jsonb_set(state,'{items,bench-0}',$1)
      WHERE user_id=1 AND workspace_id='ws-1'`, [{
      status:"queued", pausedOperationId:null, generation:"bench-reminder", dueAt, snoozedUntil:dueAt
    }]);
    ctx.broadcast("blocks-changed", {action:"working-queue",blockIds:["bench-0"]}, "ws-1");
    await Promise.all([page,second].map(tab=>tab.waitForFunction(() =>
      document.querySelector('.wq-background [data-queue-id="bench-0"]'),null,{timeout:2300})));
    await Promise.all([page,second].map(tab=>tab.waitForFunction(() =>
      document.querySelector('.wq-needs [data-queue-id="bench-0"]'),null,{timeout:19000})));
    const deliveries = async () => (await Promise.all([page,second].map(tab=>
      tab.evaluate(()=>petDeliveries.length)))).reduce((total,count)=>total+count,0);
    const deadline = Date.parse(dueAt)+17000;
    while (await deliveries()===0 && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    assert.equal(await deliveries(),1,"only one tab delivers the reminder");
    console.log(JSON.stringify({reminderMs: Math.max(0,Date.now()-Date.parse(dueAt))}));
    // Capture a response from account one, then release it after the page changes scope.
    let requestArrived, requestFailed, releaseResponse;
    const arrived = new Promise((resolve,reject) => { requestArrived = resolve; requestFailed = reject; });
    const release = new Promise(resolve => { releaseResponse = resolve; });
    await ctx.blockDB.updateBlock("bench-3", {properties:{title:"Obsolete private response"}});
    await page.route("**/api/working-queue", async route => {
      try {
        const headers = {...await route.request().allHeaders()};
        delete headers["x-dcc-queue-version"];
        const response = await route.fetch({headers});
        const value = await response.json();
        assert.ok(value.state.queue.items.some(item => item.task.properties.title === "Obsolete private response"));
        requestArrived();
        await release;
        await route.fulfill({response});
      } catch (error) {
        requestFailed(error);
        await route.abort();
      }
    });
    const inFlight = page.evaluate(() => DCCWorkingQueue.refresh().catch(()=>{}));
    await Promise.race([arrived,inFlight.then(()=>{throw new Error("Expected an intercepted queue response");})]);
    await page.evaluate(() => { window.DCC_ACCOUNT_CONTEXT = {userId:2,workspaceId:"ws-2"}; });
    releaseResponse();
    await inFlight;
    assert.equal(await page.locator("[data-queue-id]").count(), 0, "obsolete response never renders on a switched account");
    await page.unroute("**/api/working-queue");
    await page.evaluate(() => { window.DCC_ACCOUNT_CONTEXT = {userId:1,workspaceId:"ws-1"}; });
    await context.addCookies([{name:"fixture-account",value:"2",url:base}]);
    const rejected = page.waitForResponse(response =>
      response.url().endsWith("/api/working-queue") && response.status()===409, {timeout:5000});
    await page.evaluate(async () => {
      await DCCWorkingQueue.refresh().catch(()=>{});
      await DCCWorkingQueue.refresh().catch(()=>{});
    });
    await rejected;
    assert.equal(await page.locator("[data-queue-id]").count(), 0, "old tab hides its queue on server account mismatch");
    await Promise.all([page.waitForResponse(response => response.url().endsWith("/api/working-queue") && response.status()===200), page.reload()]);
    assert.deepEqual(await page.evaluate(() => ({account:window.DCC_ACCOUNT_CONTEXT, order:DCCWorkingQueue.getState().queue.order})),
      {account:{userId:2,workspaceId:"ws-2"},order:[]});
    console.log(JSON.stringify({accountSwitch:"passed"}));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(r=>server.close(r));
    await ctx.close();
  }
  process.exit(0);
}
const card = (id) => page.locator('[data-queue-id="' + id + '"]'),
  button = (id, action) => card(id).locator('[data-queue-action="' + action + '"]');
const closed = () => page.waitForFunction(() => !Array.from(document.querySelectorAll("[role=dialog]")).some(el=>el.getClientRects().length));
let switchCancelChecked=false;
const focus = async (id) => {
  const previous=await page.evaluate(()=>DCCWorkingQueue.getState().foreground.filter(row=>row.id));
  await button(id, "focus").click();
  if(previous.some(row=>row.id!==id)){
    const dialog=page.getByRole('dialog');
    await dialog.getByText('Moving to Background',{exact:true}).waitFor();
    for(const row of previous)await dialog.getByText(row.title,{exact:true}).waitFor();
    await dialog.getByText('Moving to Foreground',{exact:true}).waitFor();
    assert.equal(await dialog.getByLabel('Snooze duration',{exact:true}).count(),1);
    const layout=await page.locator('.wq-switch-old').evaluate(el=>{const title=el.querySelector('div').getBoundingClientRect(),select=el.querySelector('select').getBoundingClientRect();return {title,select};});
    assert.ok(layout.select.left>=layout.title.right,'reminder inline with outgoing task');
    if(!switchCancelChecked){
      const revision=await page.evaluate(()=>DCCWorkingQueue.getState().revision);
      await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await closed();
      assert.equal(await page.evaluate(()=>DCCWorkingQueue.getState().revision),revision,'cancel sends no mutation');
      assert.deepEqual(await page.evaluate(()=>DCCWorkingQueue.getState().foreground.map(row=>row.id)),previous.map(row=>row.id));
      await button(id,'focus').click();switchCancelChecked=true;
    }
    await page.getByRole('dialog').getByRole('button',{name:'Bring forward',exact:true}).press('Enter');
  }
  await closed();
  try{await page.waitForFunction(
    (id) => document.querySelector('[data-queue-id="' + id + '"]')?.classList.contains("wq-focus"),id,{timeout:5000});}
  catch(error){console.error('FOCUS DEBUG',await page.locator('body').innerText(),await page.evaluate(()=>DCCWorkingQueue.getState()));throw error;}
};
const add = async (ids) => {
  await page.getByRole("button", { name: "Add tasks", exact: true }).click();
  for (const id of ids) {
    await page.locator('[data-add-id="' + id + '"]').click();
    await page.waitForFunction((id) => DCCWorkingQueue.getState().queue.order.includes(id), id);
  }
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  await closed();
};
// Snooze goes through the delay chooser, then waits in Background.
const snoozeVia = async (id) => {
  await button(id, "snooze").click();
  await page.getByRole("dialog").locator("[data-minutes]").selectOption("5");
  await page.getByRole("dialog").getByRole("button", { name: "Snooze", exact: true }).click();
  await closed();
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector('[data-queue-id="' + id + '"]');
      return el?.closest(".wq-background") && el.textContent.includes("Snoozed until");
    },
    id
  );
};
const task = (id) => ctx.blockDB.getBlock(id);
const setDueInDatabase = async (id) =>
  ctx.pool.query(
    "UPDATE work_rotations SET state=jsonb_set(jsonb_set(state,ARRAY['items',$1,'dueAt'],to_jsonb($2::text)),ARRAY['items',$1,'notifiedAt'],'null')",
    [id, new Date(Date.now() - 1000).toISOString()]
  );
async function due(id) {
  await setDueInDatabase(id);
  // The test's SQL bypasses SSE. Load the changed schedule before driving the local claim tick.
  await page.evaluate(() => DCCWorkingQueue.refresh());
}
try {
  await page.goto(base);
  await page.waitForSelector(".wq-focus");
  const panel=()=>page.locator('.tab-content.active').getAttribute('id');
  const navState=()=>page.evaluate(()=>window.DCC.nav.get());
  assert.equal(await panel(),'tab-working-queue');
  assert.deepEqual(await navState(),{page:'tasks',view:'queue',actual:false});
  await page.locator('[data-task-view="list"]').click();await page.locator('.tab[data-page="budget"]').click();
  await page.goBack();assert.equal(await panel(),'tab-schedule');
  await page.goBack();assert.equal(await panel(),'tab-working-queue');
  await page.goForward();assert.equal(await panel(),'tab-schedule');
  // Old Itinerary links still open the list; retired pages land on the queue.
  await page.goto(base+'/?tab=schedule&task=keep');assert.equal(await panel(),'tab-schedule');
  assert.equal(new URL(page.url()).searchParams.get('task'),'keep','deep-link parameters survive the rewrite');
  await page.reload();assert.equal(await panel(),'tab-schedule');
  await page.goto(base+'/?tab=social');assert.equal(await panel(),'tab-working-queue');
  assert.equal(new URL(page.url()).searchParams.get('tab'),'tasks');
  await page.goto(base+'/?tab=tasks&view=calendar&actual=1');
  assert.deepEqual(await navState(),{page:'tasks',view:'calendar',actual:true});
  assert.equal(await page.locator('#task-actual-toggle').getAttribute('aria-pressed'),'true');
  await page.locator('#task-actual-toggle').click();
  assert.equal(new URL(page.url()).searchParams.get('actual'),'0','explicit Actual off remains in the URL across reload');
  await page.locator('[data-task-view="queue"]').click();
  assert.equal(await page.locator('#task-actual-toggle').isHidden(),true,'Actual is not offered on the Working Queue');
  await page.goto(base);await page.waitForSelector('.wq-focus');
  assert.equal((await task('a')).properties.startedAt,at,'view, page and history navigation never start or change a timer');
  assert.equal((await task('a')).properties.startedAt,at,'default navigation never starts or changes a timer');
  await add(["b", "c"]);
  await add(['d','legacy-pq']);
  const setPriority=async(id,value)=>{
    for(let attempt=0;attempt<5;attempt++){
      if((await task(id)).properties.taskPriority===value)return;
      const before=(await task(id)).properties.taskPriority||'Medium';
      const levels=['Very low','Low','Medium','High','Very high'],next=levels[(levels.indexOf(before)+1)%5];
      await button(id,'priority').click();
      await page.waitForFunction(({id,next})=>DCCWorkingQueue.getState().queue.items.find(i=>i.task.id===id)?.taskPriority===next&&!localStorage.getItem('dcc-working-queue:ws-1:1:pending'),{id,next});
    }
    assert.equal((await task(id)).properties.taskPriority,value);
  };
  await setPriority('c','High');
  assert.deepEqual(await page.locator('.wq-next [data-queue-id]').evaluateAll(rows=>rows.map(r=>r.dataset.queueId)),['c','b','legacy-pq','d']);
  assert.equal(await page.locator('.wq-next [data-queue-id="legacy-pq"]').count(),1,'legacy time is not fresh worker execution');
  await button('c','priority').press('Shift+Enter');
  await page.getByRole('dialog').getByLabel('Priority',{exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').locator('option').count(),5);
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await closed();
  assert.equal((await task('c')).properties.taskPriority,'High','opening/cancelling chooser never cycles');
  await button('c','priority').dispatchEvent('pointerdown',{pointerId:66,button:0,pointerType:'mouse',clientX:0,clientY:0});
  await page.waitForTimeout(600);
  await button('c','priority').dispatchEvent('pointerup',{pointerId:66,button:0,pointerType:'mouse'});
  await button('c','priority').dispatchEvent('click',{detail:1,pointerId:66});
  await page.getByRole('dialog').getByLabel('Priority',{exact:true}).waitFor();
  assert.equal((await task('c')).properties.taskPriority,'High','hold release does not also cycle');
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await closed();
  await button('c','priority').dispatchEvent('pointerdown',{pointerId:67,button:0,pointerType:'touch',clientX:0,clientY:0});
  await button('c','priority').dispatchEvent('pointerup',{pointerId:67,button:0,pointerType:'touch'});
  await button('c','priority').dispatchEvent('click',{detail:1,pointerId:67});
  await page.getByRole('dialog').getByLabel('Priority',{exact:true}).waitFor();
  assert.equal((await task('c')).properties.taskPriority,'High','touch tap opens choices without cycling');
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await closed();

  assert.equal(await page.locator('.wq-style-options').count(),0,'comparison UI is not shipped');
  assert.equal(await page.locator('#working-queue-root').getAttribute('data-priority-style'),'outline');
  await page.dragAndDrop('[data-queue-id="c"]','.wq-foreground');
  await page.getByRole('dialog').getByText('Moving to Background',{exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await closed();
  assert.equal((await task('a')).properties.startedAt,at,'cancelled drop preserves current timer');

  assert.deepEqual(await page.locator('.wq-next [data-queue-id]').evaluateAll(rows=>rows.map(r=>r.dataset.queueId)),['c','b','legacy-pq','d']);
  assert.equal(await page.locator('.wq-next [data-queue-id="legacy-pq"]').count(),1);
  assert.equal((await task('b')).properties.start,'09:00','schedule-only task remains unstarted');
  assert.equal((await task('b')).properties.startedAt,undefined);
  assert.equal((await task('a')).properties.startedAt,at,'priority changes preserve current foreground');
  await page.screenshot({path:process.env.DCC_PRIORITY_DESKTOP_SCREENSHOT||'/tmp/dcc-priority-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('.wq-next').scrollIntoViewIfNeeded();
  await page.screenshot({path:process.env.DCC_PRIORITY_MOBILE_SCREENSHOT||'/tmp/dcc-priority-mobile.png',fullPage:false});
  await page.setViewportSize({width:1280,height:950});
  const priorityOrder=await page.locator('.wq-next [data-queue-id]').evaluateAll(rows=>rows.map(r=>r.dataset.queueId));
  await button('b','up').click();
  assert.deepEqual(await page.locator('.wq-next [data-queue-id]').evaluateAll(rows=>rows.map(r=>r.dataset.queueId)),priorityOrder,'arrows cannot silently change priority');
  await page.evaluate(() => DCCWorkingQueue.openBlocked(DCCWorkingQueue.taskAnchor("d").ev));
  await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();await closed();
  await page.waitForFunction(()=>{const item=DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='d');return item?.blocked&&item.snoozed;});
  assert.equal((await task('d')).properties.actualMinutes,undefined,'blocking and Snooze add no focused effort');
  await page.evaluate(() => DCCWorkingQueue.openBlocked(DCCWorkingQueue.taskAnchor("d").ev));
  await page.waitForFunction(()=>{const item=DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='d');return item?.status==='queued'&&!item.blocked;});
  assert.equal(await page.locator('.wq-next [data-queue-id="d"]').count(),1,'unblock preserves history without claiming running execution');
  await page.reload();await page.waitForSelector('[data-queue-id="b"]');
  await setPriority('c','Medium');

  await button("b", "focus").click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await closed();
  assert.equal((await task("a")).properties.startedAt, at);
  await button("b", "focus").click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByRole("button",{name:"Cancel",exact:true}).waitFor();
  await page.keyboard.press("Escape");
  await closed();
  assert.equal((await task("b")).properties.startedAt, undefined);
  await card("b").locator(".ttl").click();
  await page.getByRole("dialog").getByText("Queue context",{exact:true}).click();
  await page.getByRole("dialog").locator("textarea").fill("Next: compare the two sources");
  await page.getByRole("dialog").getByRole("button", { name: "Save context", exact: true }).click();
  await page.getByText("Context saved.",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Close",exact:true}).last().click();
  await closed();
  await card("c").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForFunction(
    () => DCCWorkingQueue.getState().queue.order.indexOf("c") < DCCWorkingQueue.getState().queue.order.indexOf("b")
  );
  await focus("b");
  assert.equal((await task("a")).properties.actualMinutes, 2);
  assert.equal((await task("a")).properties.subtaskOf, "parent");
  assert.equal((await task("a")).date, "2099-01-02");
  await page.reload();
  await page.waitForSelector('[data-queue-id="a"]');
  assert.match(await card("a").innerText(), /Launch project › Review copy/);
  assert.match(await card("b").innerText(), /Next: compare/);
  await due("a");
  await page.evaluate(() => DCCWorkingQueue.tick());
  assert.equal(await page.evaluate(() => petDeliveries.length), 1);
  await page.reload();
  await page.waitForSelector('[data-queue-id="a"]');
  await page.evaluate(() => DCCWorkingQueue.tick());
  assert.equal(await page.evaluate(() => petDeliveries.length), 0);
  const second = await context.newPage();
  await second.goto(base);
  await second.waitForSelector('[data-queue-id="a"]');
  await second.evaluate(() => DCCWorkingQueue.tick());
  assert.equal(await second.evaluate(() => petDeliveries.length), 0);
  let gets = 0;
  context.on("request", (r) => {
    if (r.url().endsWith("/api/working-queue") && r.method() === "GET") gets++;
  });
  await page.evaluate(() => DCCWorkingQueue.refresh());
  await page.waitForTimeout(250);
  assert.ok(gets < 6, "storage writes do not ping-pong");
  await second.close();
  await snoozeVia("a");
  await button("a", "snooze").click();
  await page.getByRole("dialog").getByLabel("Snooze duration",{exact:true}).selectOption("30");
  await page.getByRole("dialog").getByRole("button",{name:"Snooze",exact:true}).click();await closed();
  await page.waitForFunction(() =>
    Date.parse(DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='a')?.dueAt)-Date.now()>29*60000
  );
  // A late claim cannot present after a new snooze generation or completion.
  await due("a");
  let fetched, release;
  let fetchedPromise = new Promise((r) => (fetched = r)),
    releasePromise = new Promise((r) => (release = r));
  await page.route("**/api/working-queue", async (route) => {
    if (route.request().method() === "POST" && route.request().postDataJSON().action === "queue-claim") {
      const response = await route.fetch();
      fetched();
      await releasePromise;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.evaluate(() => {
    window.fixtureTick = DCCWorkingQueue.tick();
  });
  await fetchedPromise;
  await page.evaluate(() => DCCWorkingQueue.refresh());
  await snoozeVia("a");
  await button("a", "snooze").click();
  await page.getByRole("dialog").getByLabel("Snooze duration",{exact:true}).selectOption("30");
  await page.getByRole("dialog").getByRole("button",{name:"Snooze",exact:true}).click();await closed();
  await page.waitForFunction(() =>
    Date.parse(DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='a')?.dueAt)-Date.now()>29*60000
  );
  release();
  await page.evaluate(() => window.fixtureTick);
  assert.equal(await page.evaluate(() => petDeliveries.length), 0);
  await page.unroute("**/api/working-queue");
  await focus("a");
  await button("b", "dismiss").click();
  await page.waitForFunction(() => !document.querySelector('[data-queue-id="b"] [data-queue-action="dismiss"]'));
  assert.equal(await card("b").count(), 1, "dismiss retains queue membership");
  // Lost response after commit: retry exact envelope after reload, no duplicate effort.
  let lost = false, originalEnvelope=null;const retriedEnvelopes=[];
  await page.route("**/api/working-queue", async (route) => {
    if (!lost && route.request().method() === "POST" && route.request().postDataJSON().action === "start") {
      lost = true;
      originalEnvelope=route.request().postDataJSON();
      await route.fetch();
      return route.abort();
    }
    if(route.request().method()==="POST")retriedEnvelopes.push(route.request().postDataJSON());
    return route.continue();
  });
  await button("c", "focus").click();
  await page.getByRole("dialog").getByRole("button", { name: "Bring forward", exact: true }).click();
  await page.waitForSelector('[data-queue-action="retry"]');
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await closed();
  const before = (await ctx.blockDB.getTaskTimeEntries("a", "ws-1")).length;
  await page.reload();
  await page.waitForFunction(() => DCCWorkingQueue.getState().foreground[0]?.id === "c" && !localStorage.getItem('dcc-working-queue:ws-1:1:pending') && !document.querySelector('[data-queue-action="retry"]'));
  assert.ok(retriedEnvelopes.some(body=>JSON.stringify(body)===JSON.stringify(originalEnvelope)),"reload retries the exact persisted command envelope");
  assert.equal((await ctx.blockDB.getTaskTimeEntries("a", "ws-1")).length, before);
  await page.unroute("**/api/working-queue");
  await page.evaluate(() =>
    localStorage.setItem(
      "dcc-working-queue:ws-1:1:pending",
      JSON.stringify({
        action: "queue-note",
        taskId: "a",
        note: "offline context",
        sourceEventId: "offline",
        expectedRevision: 0,
        at: new Date().toISOString()
      })
    )
  );
  await page.route("**/api/working-queue", (route) => route.abort());
  await page.reload();
  await page.waitForSelector('[data-queue-action="retry"]');
  assert.equal(await card("a").count(), 1);
  await page.evaluate(() => localStorage.removeItem("dcc-working-queue:ws-1:1:pending"));
  await page.unroute("**/api/working-queue");
  await page.reload();
  await page.waitForSelector('[data-queue-id="a"]');
  await due("a");
  fetchedPromise = new Promise((r) => (fetched = r));
  releasePromise = new Promise((r) => (release = r));
  await page.route("**/api/working-queue", async (route) => {
    if (route.request().method() === "POST" && route.request().postDataJSON().action === "queue-claim") {
      const response = await route.fetch();
      fetched();
      await releasePromise;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.evaluate(() => {
    window.fixtureTick = DCCWorkingQueue.tick();
  });
  await fetchedPromise;
  await ctx.blockDB.setTaskCompletion({
    taskRef: "a",
    completed: true,
    mutationId: "fixture-done",
    expectedRevision: (await task("a")).properties._completionRevision || null,
    userId: 1,
    workspaceId: "ws-1"
  });
  await page.evaluate(() => DCCWorkingQueue.refresh());
  release();
  await page.evaluate(() => window.fixtureTick);
  assert.equal(await page.evaluate(() => petDeliveries.length), 0);
  assert.equal(
    (await page.evaluate(() => DCCWorkingQueue.getState().queue.items.find((i) => i.task.id === "a"))).status,
    "completed"
  );
  await page.unroute("**/api/working-queue");
  await card('b').locator('.ttl').click();
  await page.waitForFunction(()=>window.fixtureDetails==='b');
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).last().click();await closed();
  assert.equal((await task('b')).properties.startedAt,undefined,'shared task details do not start a clock');
  const coordinator=require('../conversation-store').createConversationStore(ctx),owner={userId:1,workspaceId:'ws-1'};
  await coordinator.execute({action:'delegated-register',taskId:'b',sourceEventId:'fixture-review',expectedRevision:(await coordinator.state(owner)).revision,at:new Date().toISOString(),delegation:{work:{source:'codex',id:'fixture-draft',kind:'email-draft'},sequence:1,phase:'needs-review',note:'Draft ready; not sent',reviewActions:['Review and send the draft'],intent:'explicit-work-handoff'}},owner);
  await page.evaluate(()=>DCCWorkingQueue.refresh());
  assert.match(await page.locator('.wq-needs').innerText(),/Draft ready; not sent/);
  assert.match(await page.locator('.wq-needs').innerText(),/Review and send the draft/);
  await page.evaluate(()=>DCCWorkingQueue.tick());
  assert.equal((await task('b')).properties.status,'open');
  const queueCommand=async(action,extra)=>coordinator.execute({action,sourceEventId:crypto.randomUUID(),expectedRevision:(await coordinator.state(owner)).revision,at:new Date().toISOString(),...extra},owner);
  await queueCommand('queue-unblock',{taskId:'b'});
  await page.evaluate(()=>DCCWorkingQueue.refresh());
  assert.equal(await card('b').count(),1,'queued work needing review appears in only one lane');
  assert.equal(await page.locator('.wq-next [data-queue-id="b"]').count(),0);
  await queueCommand('background-start',{taskId:'b',remindMinutes:60});
  await make('timer-only','Overdue background check');
  await queueCommand('background-start',{taskId:'timer-only',remindMinutes:1});
  await due('timer-only');
  const order=(await coordinator.state(owner)).queue.order;
  await queueCommand('queue-reorder',{order:['b','timer-only',...order.filter(id=>!['b','timer-only'].includes(id))]});
  await page.evaluate(()=>{petDeliveries.length=0;});
  await page.evaluate(()=>DCCWorkingQueue.tick());
  assert.deepEqual(await page.evaluate(()=>petDeliveries),['Time to check back on Overdue background check.']);
  const future=(await coordinator.state(owner)).queue.items.find(i=>i.task.id==='b');
  assert.equal(future.notifiedAt,null,'future check-back is not claimed merely because review is needed');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({
    path: process.env.DCC_QUEUE_SCREENSHOT || "/tmp/dcc-working-queue-mobile.png",
    fullPage: true
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "priority High/Medium/Low ordering and same-priority arrows",
        "schedule-only task stays unstarted",
        "setting aside and unblocking retain inactive work in Priority",
        "new recurrence occurrence and legacy actuals classification",
        "desktop/mobile priority screenshots and overflow",
        "default queue entry",
        "explicit tab link and reload",
        "back/forward navigation",
        "delegated review actions without clock changes",
        "future review timer cannot starve overdue reminders",
        "review-ready queued task has one card",
        "add",
        "cancel",
        "Escape",
        "context",
        "keyboard reorder",
        "foreground switch",
        "effort",
        "hierarchy",
        "reload",
        "timer expiry",
        "single claim across tabs",
        "snooze",
        "late response",
        "return",
        "dismiss retains membership",
        "lost response reload retry",
        "offline cache",
        "completion during delayed claim",
        "details",
        "mobile overflow"
      ]
    })
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await ctx.close();
}
