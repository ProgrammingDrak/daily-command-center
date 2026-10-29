/* global window, document, localStorage, DCCWorkingQueue, petDeliveries, innerWidth */
// Isolated PostgreSQL + real API/UI; no .env, live tasks, or shared browser profile.
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
    .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"></head><body style="padding:20px"><button class="tab" data-tab="schedule">Itinerary</button><button class="tab active" data-tab="working-queue">Working Queue</button><button class="tab" data-tab="budget">Budget</button><div class="tab-content" id="tab-schedule">Itinerary fixture</div><div class="tab-content active" id="tab-working-queue"><div id="working-queue-root"></div></div><div class="tab-content" id="tab-budget">Budget fixture</div><div id="toast-container"></div>
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
const focus = async (id) => {
  await button(id, "focus").click();
  await page.getByRole("dialog").getByRole("button", { name: "Bring forward", exact: true }).click();
  await closed();
  await page.waitForFunction(
    (id) => document.querySelector('[data-queue-id="' + id + '"]')?.classList.contains("wq-focus"),
    id
  );
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
const task = (id) => ctx.blockDB.getBlock(id);
const due = async (id) =>
  ctx.pool.query(
    "UPDATE work_rotations SET state=jsonb_set(jsonb_set(state,ARRAY['items',$1,'dueAt'],to_jsonb($2::text)),ARRAY['items',$1,'notifiedAt'],'null')",
    [id, new Date(Date.now() - 1000).toISOString()]
  );
try {
  await page.goto(base);
  await page.waitForSelector(".wq-focus");
  assert.equal(await page.locator('.tab.active').getAttribute('data-tab'),'working-queue');
  await page.locator('.tab[data-tab="schedule"]').click();await page.locator('.tab[data-tab="budget"]').click();
  await page.goBack();assert.equal(await page.locator('.tab.active').getAttribute('data-tab'),'schedule');
  await page.goBack();assert.equal(await page.locator('.tab.active').getAttribute('data-tab'),'working-queue');
  await page.goForward();assert.equal(await page.locator('.tab.active').getAttribute('data-tab'),'schedule');
  await page.goto(base+'/?tab=schedule');assert.equal(await page.locator('.tab.active').getAttribute('data-tab'),'schedule');
  await page.reload();assert.equal(await page.locator('.tab.active').getAttribute('data-tab'),'schedule');
  await page.goto(base);await page.waitForSelector('.wq-focus');
  assert.equal((await task('a')).properties.startedAt,at,'default navigation never starts or changes a timer');
  await add(["b", "c"]);
  await add(['d','legacy-pq']);
  const setPriority=async(id,value)=>{
    await button(id,'priority').click();
    await page.getByRole('dialog').locator('[data-priority]').selectOption(value);
    await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();await closed();
  };
  await setPriority('c','High');
  assert.deepEqual(await page.locator('.wq-next [data-queue-id]').evaluateAll(rows=>rows.map(r=>r.dataset.queueId)),['c','b','d']);
  assert.equal(await page.locator('.wq-background [data-queue-id="legacy-pq"]').count(),1);
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
  await button('d','background').click();
  await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();await closed();
  assert.equal(await page.locator('.wq-next [data-queue-id="d"]').count(),0);
  assert.equal((await task('d')).properties.actualMinutes,undefined,'background is not focused effort');
  await button('d','block').click();await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();await closed();
  await button('d','unblock').click();
  await page.waitForFunction(()=>DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='d')?.status==='paused');
  assert.equal(await page.locator('.wq-next [data-queue-id="d"]').count(),0,'unblock preserves start history');
  await page.reload();await page.waitForSelector('[data-queue-id="b"]');
  assert.equal(await page.locator('.wq-next [data-queue-id="d"]').count(),0);
  await setPriority('c','Medium');

  await button("b", "focus").click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await closed();
  assert.equal((await task("a")).properties.startedAt, at);
  await button("b", "focus").click();
  await page.keyboard.press("Escape");
  await closed();
  assert.equal((await task("b")).properties.startedAt, undefined);
  await button("b", "note").click();
  await page.getByRole("dialog").locator("textarea").fill("Next: compare the two sources");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
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
  await button("a", "snooze").click();
  await page.waitForFunction(() =>
    document.querySelector('[data-queue-id="a"]').textContent.includes("Check back in 5m")
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
  await button("a", "snooze").click();
  await page.waitForFunction(() =>
    document.querySelector('[data-queue-id="a"]').textContent.includes("Check back in 5m")
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
  await button("b", "details").click();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last().click();
  await closed();
  await page.evaluate(()=>{window.DCCTaskWorkspace={preview:task=>{window.fixturePreview=task.id;},open:()=>{throw new Error('Details must not start focus');}};});
  await button('b','details').click();
  assert.equal(await page.evaluate(()=>window.fixturePreview),'b');
  assert.equal((await task('b')).properties.startedAt,undefined,'workspace details do not start a clock');
  await page.evaluate(()=>{delete window.DCCTaskWorkspace;});
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
        "background start and unblock never return to Priority Queue",
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
  await new Promise((r) => server.close(r));
  await ctx.close();
}
