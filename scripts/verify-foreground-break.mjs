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
await make("parent", "Journey planning");
await make("a", "Plan Japan airport transfers and intercity travel", {
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
    .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/tokens.css"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"></head><body style="padding:20px"><nav id="tab-bar" aria-label="Pages"><button class="tab active" type="button" data-page="tasks">Tasks</button><button class="tab" type="button" data-page="budget" data-tab="budget">Budget</button></nav><div role="tablist"><button type="button" role="tab" data-task-view="queue">Working Queue</button><button type="button" role="tab" data-task-view="list">Itinerary</button></div><div class="tab-content" id="tab-schedule">Itinerary fixture</div><div class="tab-content active" id="tab-working-queue"><div id="working-queue-root"></div></div><div class="tab-content" id="tab-budget">Budget fixture</div><div id="toast-container"></div>
<script>window.__state={date:"2099-01-02"};window.addActionItem=()=>{};window.closeNotesDrawer=()=>{};window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'ws-1'};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/task-types.js"></script><script src="/public/js/task-model.js"></script><script src="/public/js/nav-state.js"></script><script src="/public/js/tabs.js"></script>
<script>window.scheduled=[];window.backlog=[];window.fixtureRows=[];window.isDone=t=>t.status==='done';window.render=()=>{};
window.blockStore={get:id=>fixtureRows.find(r=>r.id===id),getByType:()=>fixtureRows,acceptWorkRotation:rows=>{for(const row of rows){const i=fixtureRows.findIndex(r=>r.id===row.id);if(i>=0)fixtureRows[i]=row;else fixtureRows.push(row);}scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));}};
window.fixtureLoad=async()=>{fixtureRows=await fetch('/fixture/tasks').then(r=>r.json());scheduled=fixtureRows.map(r=>DCC.TaskModel.fromBlock(r));};window.petDeliveries=[];DCC.PetNudge={deliverWorkCheckIn:async(text,options)=>{petDeliveries.push(text);DCC.toast(text,'info',60000,{label:'Open queue',onClick:options.open});}};
</script>${require("../test-support/queue-browser-components")()}<script src="/public/js/work-checkin-policy.js"></script><script src="/public/js/queue-policy.js"></script><script src="/public/js/work-sessions.js"></script><script src="/public/js/work-completion.js"></script><script src="/public/js/completed-queue-filter.js"></script><script src="/public/js/working-queue.js"></script><script>fixtureLoad().then(()=>dispatchEvent(new Event('dcc:data-ready')));</script></body></html>`)
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
page.setDefaultTimeout(10000);
const task = (id) => ctx.blockDB.getBlock(id);

try {
  await page.goto(base);await page.waitForSelector('.wq-focus');
  const state=()=>store.state(owner),store=require('../conversation-store').createConversationStore(ctx),owner={userId:1,workspaceId:'ws-1'};
  const post=async(action,id,extra={})=>store.execute({action,taskId:id,sourceEventId:ctx.crypto.randomUUID(),expectedRevision:(await state()).revision,at:new Date().toISOString(),...extra},owner);
  for(const id of ['b','c'])await post('queue-add',id);
  await page.evaluate(()=>DCCWorkingQueue.refresh());
  // Measure the real shared card before and after pause, with its icon gutter,
  // wrapped task path, action row and production fonts. The frost adds no flow height.
  await page.evaluate(()=>document.fonts.ready);
  const geometry=[];
  const themeStyle=await page.addStyleTag({content:'/* theme fixture */'});
  for(const theme of ['dark','light']){
    await themeStyle.evaluate((el,mode)=>{el.textContent=mode==='light'?':root{--bg:#f5f7fb;--card:#fff;--card-hover:#f0f3f8;--border:#cbd5e1;--text:#182030;--text-muted:#526177}':'';},theme);
    for(const width of [1440,1280,435,375,358]){
      await page.setViewportSize({width,height:1000});
      await page.evaluate((w)=>{document.querySelector('.wq-grid').style.gridTemplateColumns=w===1280?'435px minmax(0,1fr)':'';},width);
      const before=await card('a').boundingBox();
      await button('a','pause').click();await card('a').locator('.wq-break-veil').waitFor();
      await page.evaluate((w)=>{document.querySelector('.wq-grid').style.gridTemplateColumns=w===1280?'435px minmax(0,1fr)':'';},width);
      const measured=await card('a').evaluate(el=>{
        const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        const veil=el.querySelector('.wq-break-veil'),title=veil.querySelector('.wq-break-title'),header=veil.querySelector('.wq-break-header'),body=veil.querySelector('.wq-break-body');
        const controls=[...veil.querySelectorAll('button')];
        return{card:rect(el),veil:rect(veil),title:rect(title),header:rect(header),body:rect(body),controls:controls.map(rect),headerChildren:[...header.children].map(rect),bodyChildren:[...body.children].map(rect),titleReadable:title.scrollHeight<=title.clientHeight,overflow:veil.scrollHeight>veil.clientHeight||veil.scrollWidth>veil.clientWidth,underlyingInert:[...el.children].filter(n=>n!==veil).every(n=>n.inert&&n.getAttribute('aria-hidden')==='true'),mainPadding:getComputedStyle(el.querySelector('.it-list-main')).paddingBottom};
      });
      const within=(inner,outer)=>inner.x>=outer.x-1&&inner.y>=outer.y-1&&inner.right<=outer.right+1&&inner.bottom<=outer.bottom+1;
      assert.ok(Math.abs(measured.card.width-measured.veil.width)<=2&&Math.abs(measured.card.height-measured.veil.height)<=2,'veil fits full card including gutter');
      assert.ok(Math.abs(measured.card.height-before.height)<=2,'pause preserves card height');
      for(const edge of ['x','y','right','bottom'])assert.ok(Math.abs(measured.card[edge]-measured.veil[edge])<=1.1,'veil matches card edge '+edge);
      assert.equal(measured.mainPadding,'0px','no blank spacer');
      assert.equal(measured.overflow,false,'overlay contents fit');assert.equal(measured.titleReadable,true);
      assert.equal(measured.underlyingInert,true,'covered controls are inert and hidden from accessibility tree');
      assert.ok(measured.header.bottom<=measured.body.y+1,'heading and body do not overlap');
      for(const box of [measured.title,measured.header,measured.body,...measured.controls,...measured.headerChildren,...measured.bodyChildren])assert.ok(within(box,measured.veil),'all content stays inside frost');
      for(const boxes of [measured.headerChildren,measured.bodyChildren])for(let i=1;i<boxes.length;i++)assert.ok(boxes[i-1].right<=boxes[i].x+1,'sibling content does not overlap');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      for(const control of await card('a').locator('.wq-break-veil button').all()){await control.focus();assert.equal(await control.evaluate(el=>el===document.activeElement),true);}
      await button('a','break-options').focus();await page.keyboard.press('Tab');assert.equal(await button('a','focus').evaluate(el=>el===document.activeElement),true);
      await page.keyboard.press('Shift+Tab');assert.equal(await button('a','break-options').evaluate(el=>el===document.activeElement),true);
      await card('a').locator('.it-list-main [data-queue-action=pause]').evaluate(el=>el.focus());
      assert.equal(await card('a').locator('.it-list-main [data-queue-action=pause]').evaluate(el=>el===document.activeElement),false,'underlying control cannot receive focus');
      await card('a').screenshot({path:path.join(output,'fitted-break-'+theme+'-'+width+'.png')});
      geometry.push({theme,width,beforeHeight:before.height,...measured});
      await button('a','focus').click();await page.waitForFunction(()=>!document.querySelector('.wq-break-veil'));
    }
  }
  await (await import('node:fs/promises')).writeFile(path.join(output,'geometry.json'),JSON.stringify(geometry,null,2));
  await themeStyle.evaluate(el=>{el.textContent='';});await page.setViewportSize({width:1280,height:950});await page.evaluate(()=>DCCWorkingQueue.render());
  const initial=await state(),originalOrder=initial.queue.order;
  const pause=button('a','pause');await pause.focus();await page.keyboard.press('Enter');
  await card('a').locator('.wq-break-veil').waitFor();
  assert.equal((await state()).foreground[0].id,'a');
  assert.equal((await task('a')).properties.startedAt,undefined);
  const actual=(await task('a')).properties.actualMinutes;
  assert.equal((await card('a').locator('[data-queue-action=focus]').evaluate(el=>el===document.activeElement)),true);
  await page.waitForFunction(()=>document.querySelector('[data-break-clock]')?.textContent!=='0:00');
  const clock=await card('a').locator('[data-break-clock]').innerText();assert.notEqual(clock,'0:00');
  await page.reload();await card('a').locator('.wq-break-veil').waitFor();
  assert.equal((await task('a')).properties.actualMinutes,actual);
  assert.deepEqual((await state()).queue.order,originalOrder);
  for(const width of [1280,375,358]){
    await page.setViewportSize({width,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile overflow');
    const veil=card('a').locator('.wq-break-veil');
    assert.ok(await veil.isVisible());assert.ok(await card('a').getByText('On a break',{exact:true}).isVisible());
    assert.ok(await card('a').locator('.wq-break-title').isVisible());
    assert.equal(await card('a').locator('.wq-break-title').evaluate(el=>el.scrollHeight<=el.clientHeight),true,'task title remains fully readable');
    assert.notEqual(await veil.evaluate(el=>getComputedStyle(el).backdropFilter),'none');
    const resume=button('a','focus'),box=await resume.boundingBox();assert.ok(box.height>=44);
    await card('a').screenshot({path:path.join(output,'foreground-break-'+width+'.png')});
  }
  // Same queued command recovers a response lost after the transaction commits.
  let attempts=0,first;
  await page.route('**/api/working-queue',async route=>{
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON();
      if(body.action==='start'&&body.taskId==='a'){
        attempts++;if(attempts===1){first=body;await route.fetch();return route.abort('failed');}
        assert.deepEqual(body,first);
      }
    }
    return route.continue();
  });
  await button('a','focus').evaluate(el=>{el.click();el.click();});
  await page.getByRole('button',{name:'Retry saved update',exact:true}).waitFor();
  assert.equal(attempts,1);await page.getByRole('button',{name:'Retry saved update',exact:true}).click();
  await card('a').locator('.wq-break-veil').waitFor({state:'detached'});
  assert.equal(attempts,2);assert.equal((await task('a')).properties.actualMinutes,actual);
  assert.equal((await state()).queue.items.find(i=>i.task.id==='a').onBreak,false);
  await page.unroute('**/api/working-queue');
  await button('a','pause').click();await card('a').locator('.wq-break-veil').waitFor();
  await button('a','break-options').focus();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'Paused task options'}).waitFor();
  await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Paused task options'}).waitFor({state:'detached'});
  assert.equal(await button('a','break-options').evaluate(el=>el===document.activeElement),true,'options dismissal restores focus');
  await button('a','break-options').click();await page.getByRole('dialog',{name:'Paused task options'}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'Return to Priority',exact:true}).click();
  await page.waitForFunction(()=>DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='a')?.status==='queued');
  assert.equal((await state()).foreground.length,0);assert.equal((await task('a')).properties.startedAt,undefined);
  // Other tabs observe the durable pause; stale updates cannot resume an old task.
  await button('a','focus').click();await card('a').locator('.wq-break-veil').waitFor({state:'detached'});
  const second=await context.newPage();await second.goto(base);await second.waitForSelector('.wq-focus');
  await button('a','pause').click();await card('a').locator('.wq-break-veil').waitFor();
  await second.evaluate(()=>DCCWorkingQueue.refresh());await second.locator('.wq-break-veil').waitFor();
  await button('b','focus').click();await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(),/Moving to Background/);
  await page.getByRole('dialog').getByRole('button',{name:'Bring forward',exact:true}).click();
  await card('b').locator('[data-queue-action=pause]').waitFor();
  assert.equal((await state()).queue.items.find(i=>i.task.id==='a').snoozed,true);
  await second.close();
  await page.route('**/api/working-queue',async route=>{const response=await route.fetch(),data=await response.json();data.otherWorkspaceForeground=true;return route.fulfill({response,json:data});});
  await page.evaluate(()=>DCCWorkingQueue.refresh());
  await page.getByText(/Another workspace holds Foreground/).waitFor();
  await button('c','focus').click();await page.locator('#toast-container').getByText(/choose Return to Priority before switching/).waitFor();
  await page.unroute('**/api/working-queue');
  await post('start','a',{remindMinutes:30,attentionMode:'snooze'});await page.evaluate(()=>DCCWorkingQueue.refresh());
  await button('a','pause').click();await card('a').locator('.wq-break-veil').waitFor();
  await button('a','break-options').click();await page.getByRole('dialog').getByRole('button',{name:'Task details',exact:true}).click();
  await page.getByRole('dialog',{name:'Task details'}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
  assert.equal((await state()).queue.items.find(i=>i.task.id==='a').onBreak,true);
  await button('a','break-options').click();await page.getByRole('dialog').getByRole('button',{name:'Send to background',exact:true}).click();
  await page.getByRole('dialog',{name:'Set task aside'}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});assert.equal((await state()).queue.items.find(i=>i.task.id==='a').snoozed,true);
  await button('a','focus').click();await page.waitForFunction(()=>DCCWorkingQueue.getState().queue.items.find(i=>i.task.id==='a')?.status==='foreground');
  await button('a','pause').click();await card('a').locator('.wq-break-veil').waitFor();
  await button('a','break-options').click();await page.getByRole('dialog').getByRole('button',{name:'Complete task',exact:true}).click();
  await page.getByRole('dialog').getByText('Previously recorded',{exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
  assert.equal((await state()).queue.items.find(i=>i.task.id==='a').onBreak,true,'cancel keeps the retained break');
  await button('a','break-options').click();await page.getByRole('dialog').getByRole('button',{name:'Complete task',exact:true}).click();
  await page.getByRole('dialog').getByText('Previously recorded',{exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'Mark Complete',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
  assert.equal((await state()).queue.items.find(i=>i.task.id==='a').status,'completed');assert.equal((await task('a')).properties.actualMinutes,actual);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,testUrl:base,checks:['keyboard pause/resume focus','retained foreground','frozen work actuals','separate break clock','refresh','1280/375/358px','card-bounded frost','zero pause-height growth','no overlap/overflow','inert underlay','long title','dark/light semantic tokens','435px lane','44px resume','double click','lost response replay','explicit Priority move','multi-tab refresh','switch preserves snooze','Task options details/background/completion/cancel'],screenshots:output}));
} catch(error){console.error(error);console.error(await page.locator('body').innerText());throw error;} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await ctx.close();}
