/* global document, getComputedStyle, DCCWorkingQueue, petDeliveries */
// Needs You snooze regression: isolated PostgreSQL + the real queue API and UI.
// No .env, auth, live tasks, shared browser profile or external notifications.
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
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
const APP_ZONE = "America/New_York";
const screenshotDir=process.env.DCC_QUEUE_SNOOZE_OUT||"/tmp/dcc-queue-snooze-all";
await fs.mkdir(screenshotDir,{recursive:true});
const ctx = await require("../test-support/activity-db").createActivityDb();
Object.assign(ctx, { APP_TIME_ZONE: APP_ZONE, broadcast() {} });
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
const startedAt = new Date(Date.now() - 120000).toISOString();
await make("fg", "Focused writing", { startedAt, workStateChangedAt: startedAt, activeWorkSessionId: "fixture-fg" });
await make("rev", "Draft needs review");
await make("blk", "Blocked on access");
await make("chk", "Check on export");
await make("plain", "Plain priority task");
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
app.get("/", (_req, res) =>
  res.type("html")
    .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/dashboard.css"><link rel="stylesheet" href="/public/css/tokens.css"><link rel="stylesheet" href="/public/css/core-ui.css"><link rel="stylesheet" href="/public/css/working-queue.css"></head><body style="padding:20px"><div class="tab-content active" id="tab-working-queue"><div id="working-queue-root"></div></div><div id="toast-container"></div>
<script>window.__state={date:"2099-01-02"};window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'ws-1'};</script><script src="/public/js/core.js"></script><script src="/public/js/core-ui.js"></script><script src="/public/js/task-types.js"></script><script src="/public/js/task-model.js"></script>
<script>window.petDeliveries=[];DCC.PetNudge={deliverWorkCheckIn:async text=>{petDeliveries.push(text);}};</script>${require("../test-support/queue-browser-components")()}<script src="/public/js/completed-queue-filter.js"></script><script src="/public/js/task-priority.js"></script><script src="/public/js/queue-policy.js"></script><script src="/public/js/working-queue.js"></script><script>dispatchEvent(new Event('dcc:data-ready'));</script></body></html>`)
);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + server.address().port;
// Setup goes through the same canonical command API the page uses.
const api = async (body) => {
  const state = await fetch(base + "/api/working-queue").then((r) => r.json());
  const res = await fetch(base + "/api/working-queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceEventId: "setup:" + crypto.randomUUID(), expectedRevision: state.revision, at: new Date().toISOString(), ...body })
  });
  assert.ok(res.ok, "setup " + body.action + ": " + (await res.text()));
};
for (const taskId of ["rev", "blk", "chk", "plain"]) await api({ action: "queue-add", taskId });
await api({ action: "queue-block", taskId: "blk", remindMinutes: null });
await api({ action: "background-start", taskId: "chk", remindMinutes: 5 });
await ctx.pool.query(
  "INSERT INTO delegated_work(user_id,workspace_id,task_id,work_key,report) VALUES(1,'ws-1','rev','fixture',$1)",
  [{ phase: "needs-review", reviewActions: ["Review the draft"], at: new Date().toISOString(), note: "Draft is ready for review", work: { source: "fixture", id: "w-rev" } }]
);
const queueItem = async (id) =>
  (await ctx.pool.query("SELECT state FROM work_rotations WHERE user_id=1 AND workspace_id='ws-1'")).rows[0].state.items[id];
// Simulates time passing: both deadlines move to the past together.
const expire = (id, snoozed = true) =>
  ctx.pool.query(
    "UPDATE work_rotations SET state=jsonb_set(jsonb_set(state,ARRAY['items',$1,'dueAt'],to_jsonb($2::text)),ARRAY['items',$1,'snoozedUntil'],$3::jsonb)",
    [id, new Date(Date.now() - 1000).toISOString(), snoozed ? JSON.stringify(new Date(Date.now() - 1000).toISOString()) : "null"]
  );
await expire("chk", false);
const fgBefore = (await ctx.blockDB.getBlock("fg")).properties;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});
// Browser zone differs from the app zone, so the label must come from the app.
const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, timezoneId: "Asia/Tokyo" });
await context.route("**/*", (r) => (new URL(r.request().url()).origin === base ? r.continue() : r.abort()));
const page = await context.newPage(),
  errors = [],
  writes = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.method() !== "GET" && r.url().includes("/api/")) writes.push(r.postDataJSON?.() || {});
});
const userWrites = () => writes.filter((w) => w.action !== "queue-claim");
const card = (id) => page.locator('[data-queue-id="' + id + '"]'),
  button = (id, action) => card(id).locator('[data-queue-action="' + action + '"]');
const dialog = () => page.getByRole("dialog");
const closed = () => page.waitForFunction(() => !document.querySelector(".dcc-overlay [role=dialog]"));
const inLane = (id, lane) =>
  page.waitForFunction(([id, lane]) => document.querySelector('[data-queue-id="' + id + '"]')?.closest(".wq-lane")?.classList.contains(lane), [id, lane]);
const passed = [];
const check = (name) => passed.push(name);
try {
  await page.goto(base);
  await inLane("rev","wq-needs");
  const bulk=()=>page.locator('[data-queue-action="snooze-all"]');
  assert.equal(await bulk().count(),1);
  assert.match(await bulk().getAttribute('aria-label'),/3 Needs You/);
  // Keyboard opener, focus trap, Escape and explicit Cancel never write.
  const before=userWrites().length;
  await bulk().focus();await page.keyboard.press('Enter');await dialog().waitFor();
  assert.match(await dialog().textContent(),/Snooze all 3 Needs You items/);
  assert.equal(await dialog().locator('[data-minutes] option[value="0"]').count(),0);
  for(let i=0;i<8;i++){await page.keyboard.press('Tab');assert.ok(await dialog().evaluate(el=>el.contains(document.activeElement)));}
  await page.evaluate(()=>DCCWorkingQueue.refresh());
  await page.keyboard.press('Escape');await closed();
  assert.equal(await bulk().evaluate(el=>el===document.activeElement),true);
  await bulk().click();await dialog().getByRole('button',{name:'Cancel',exact:true}).click();await closed();
  assert.equal(userWrites().length,before);
  check('keyboard open, focus trap, Escape, Cancel and focus restoration');
  for(const width of [358,375,1280]){
    await page.setViewportSize({width,height:950});
    await bulk().click();await dialog().waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page overflow at '+width);
    const box=await dialog().boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.dcc-overlay')).opacity==='1');
    await page.screenshot({path:path.join(screenshotDir,'snooze-all-'+width+'.png')});
    await page.keyboard.press('Escape');await closed();
  }
  check('358px, 375px and desktop layouts');
  // Independent queue writer invalidates the preview, with no partial snooze.
  await bulk().click();
  await api({action:'queue-note',taskId:'plain',note:'Concurrent synthetic edit'});
  await dialog().getByRole('button',{name:'Snooze 3 items',exact:true}).click();
  await page.waitForFunction(()=>/changed/i.test(document.querySelector('.dcc-overlay [role=dialog] [role=status]')?.textContent||''));
  for(const id of ['rev','blk','chk'])assert.equal((await queueItem(id)).snoozedUntil??null,null);
  await page.keyboard.press('Escape');await closed();
  await page.locator('[data-queue-action="clear-conflict"]').click();
  check('concurrent change rejects the whole batch');
  await bulk().click();
  await dialog().locator('[data-minutes]').selectOption('custom');
  await dialog().locator('[data-custom] input').fill('0');
  await dialog().getByRole('button',{name:'Snooze 3 items',exact:true}).click();
  await page.waitForFunction(()=>/1–1440/.test(document.querySelector('.dcc-overlay [role=dialog] [role=status]')?.textContent||''));
  await dialog().locator('[data-custom] input').fill('45');
  assert.match(await dialog().locator('[data-snooze-preview]').textContent(),/(EST|EDT)/);
  let dropped=false;
  // Commit the request, then lose its response. Retry must find the same receipt.
  await page.route('**/api/working-queue',async r=>{
    if(r.request().method()==='POST'&&r.request().postDataJSON().action==='queue-snooze-all'&&!dropped){dropped=true;await r.fetch();await r.abort();}else await r.continue();
  });
  const count=userWrites().filter(w=>w.action==='queue-snooze-all').length;
  await dialog().getByRole('button',{name:'Snooze 3 items',exact:true}).dblclick();
  await page.waitForFunction(()=>/not confirmed/.test(document.querySelector('.dcc-overlay [role=dialog] [role=status]')?.textContent||''));
  assert.ok(await dialog().locator('[data-minutes]').isDisabled());
  assert.ok(await bulk().isDisabled());
  await dialog().getByRole('button',{name:'Snooze 3 items',exact:true}).click();await closed();
  await page.unroute('**/api/working-queue');
  const commands=userWrites().filter(w=>w.action==='queue-snooze-all').slice(count);
  assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);
  for(const id of ['rev','blk','chk']){
    await inLane(id,'wq-background');
    const item=await queueItem(id);assert.equal(item.generation,commands[0].sourceEventId);
    assert.equal(Date.parse(item.dueAt)-Date.parse(commands[0].at),45*60000);
  }
  assert.ok(await bulk().isDisabled(),'empty Needs You disables bulk action');
  assert.match(await bulk().getAttribute('aria-label'),/0 Needs You/);
  assert.deepEqual((await ctx.blockDB.getBlock('fg')).properties,fgBefore);
  await page.reload();for(const id of ['rev','blk','chk'])await inLane(id,'wq-background');
  check('custom duration, invalid duration, busy and empty states, double click and committed-response retry');
  for(const id of ['rev','blk','chk'])await expire(id);
  await page.reload();for(const id of ['rev','blk','chk'])await inLane(id,'wq-needs');
  for(let i=0;i<20;i++){await page.evaluate(()=>DCCWorkingQueue.tick());if(await page.evaluate(()=>petDeliveries.length===3))break;await page.waitForTimeout(100);}
  await page.waitForFunction(()=>petDeliveries.length===3);
  await page.evaluate(()=>DCCWorkingQueue.tick());assert.equal(await page.evaluate(()=>petDeliveries.length),3);
  assert.deepEqual((await ctx.blockDB.getBlock('fg')).properties,fgBefore);
  for(const id of ['rev','blk','chk'])assert.equal((await ctx.blockDB.getBlock(id)).properties.actualMinutes??null,null);
  check('reload durability, expiry, one notification per item and no foreground or actuals changes');
  assert.deepEqual(errors,[]);
  for(const name of passed)console.log('ok - '+name);
} catch(error) {console.error('Page errors:',errors);console.error((await page.locator('body').textContent()).slice(0,2000));throw error;} finally {await browser.close();server.close();await ctx.close();}
