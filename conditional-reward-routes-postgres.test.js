const test = require("node:test");
const assert = require("node:assert/strict");
const { createActivityDb } = require("./test-support/activity-db");
const routeHelpers = require("./lib/route-helpers");

const configured = !!process.env.DCC_TEST_DATABASE_URL;

test("conditional reward handlers use locked canonical eligibility, not stale timeline twins", { skip: !configured }, async t => {
  const ctx = await createActivityDb();
  t.after(ctx.close);
  const { pool, blockDB, crypto } = ctx;
  const date = "2026-10-23";
  let state = { schedule: { timeline: [] } }, prepareHook = null;
  const handlers = new Map();
  Object.assign(ctx, routeHelpers, {
    APP_TIME_ZONE: "UTC", capabilities: require("./capabilities"),
    slotStore: require("./slot-store"), socialStore: require("./social-store"),
    scoreTaskPoints: require("./slot-scoring").scoreTaskPoints,
    getTodayStr: () => date, filterLegacyGcalBlocks: rows => rows, broadcast() {},
    buildDayResponse: async () => {
      const prepared = structuredClone(state);
      const hook = prepareHook; prepareHook = null;
      if (hook) await hook();
      return prepared;
    },
  });
  require("./routes/social-todo")({
    get: (path, fn) => handlers.set("GET " + path, fn),
    post: (path, fn) => handlers.set("POST " + path, fn),
    delete() {},
  }, ctx);
  await ctx.slotStore.ensureSchema();
  const share = (await pool.query("INSERT INTO todo_shares(workspace_id,token,created_by) VALUES('ws-1','conditional-route-fixture',1) RETURNING *")).rows[0];
  const root = await blockDB.ensureDayRoot(date, 1, "ws-1");
  async function call(path, { userId = 1, workspaceId = "ws-1", body = {}, params = {} } = {}) {
    let status = 200, result;
    const res = { status(n) { status = n; return this; }, json(value) { result = value; this.headersSent = true; return this; } };
    await handlers.get(path)({ workspaceId, session: { userId }, query: {}, body, params }, res);
    assert.equal(status, 200, JSON.stringify(result));
    return result;
  }
  async function setup({ props = {}, blockDate = date, bound = true, overlay = null } = {}) {
    await pool.query("UPDATE todo_sponsorships SET status='dismissed' WHERE status='approved'");
    await pool.query("UPDATE blocks SET properties=$2 WHERE id=$1", [root, overlay ? { _done: overlay } : {}]);
    const blockId = crypto.randomUUID(), taskId = "task-" + blockId;
    if (bound) await pool.query(`INSERT INTO blocks(id,type,date,properties,workspace_id,user_id,created_at,updated_at)
      VALUES($1,'block',$2,$3,'ws-1',1,NOW(),NOW())`, [blockId, blockDate, {
      title: "Synthetic public task", kind: "task", type: "task", local_id: taskId,
      publicVisibility: "public", status: "done", ...props,
    }]);
    state = { schedule: { timeline: [{ id: taskId, block_id: bound ? blockId : undefined, label: "Stale synthetic task", completed: true }] } };
    const condition = { type: "task", taskId, ...(bound ? { blockId } : {}) };
    const offer = (await pool.query(`INSERT INTO todo_sponsorships(workspace_id,share_id,task_id,task_date,task_block_id,
      task_title,sponsor_name,sponsor_user_id,kind,reward_title,status,offer_settings)
      VALUES('ws-1',$1,$2,$3,$4,'Synthetic task','Synthetic sponsor',2,'reward','Synthetic reward','approved',$5) RETURNING *`,
    [share.id, taskId, date, bound ? blockId : null, { condition }])).rows[0];
    return { offer, blockId, taskId };
  }
  async function assertEarned(offer, earned) {
    const saved = (await pool.query("SELECT * FROM todo_sponsorships WHERE id=$1", [offer.id])).rows[0];
    assert.equal(saved.status, earned ? "earned" : "approved");
    for (const table of ["reward_queue_items", "reward_events"]) {
      const rows = (await pool.query(`SELECT * FROM ${table} WHERE source_type='shared_condition' AND source_id=$1`, [String(offer.id)])).rows;
      assert.equal(rows.length, earned ? 1 : 0, table);
    }
  }
  for (const [name, mutation] of [
    ["moved to another date", "UPDATE blocks SET date='2026-10-24' WHERE id=$1"],
    ["moved to another workspace", "UPDATE blocks SET workspace_id='ws-2' WHERE id=$1"],
    ["made private", "UPDATE blocks SET properties=properties || '{\"publicVisibility\":\"private\"}' WHERE id=$1"],
    ["made a private task type", "UPDATE blocks SET properties=properties || '{\"type\":\"meal\"}' WHERE id=$1"],
    ["soft-deleted", "UPDATE blocks SET deleted_at=NOW() WHERE id=$1"],
    ["removed", "DELETE FROM blocks WHERE id=$1"],
    ["removed from global triage", "UPDATE blocks SET date=NULL,properties=properties || '{\"triageBlock\":false}' WHERE id=$1"],
  ]) await t.test("a bound task " + name + " after preparation never earns", async () => {
    const { offer, blockId } = await setup();
    prepareHook = () => pool.query(mutation, [blockId]);
    await call("GET /api/social/rewards/queue");
    await assertEarned(offer, false);
  });
  await t.test("wrong-owner and wrong-workspace queue reads cannot reconcile an eligible offer", async () => {
    const { offer } = await setup();
    await call("GET /api/social/rewards/queue", { userId: 2 });
    await assertEarned(offer, false);
    await call("GET /api/social/rewards/queue", { workspaceId: "ws-2" });
    await assertEarned(offer, false);
  });
  await t.test("canonical undo overrides stale completed timeline and legacy overlay", async () => {
    const { offer, blockId, taskId } = await setup();
    prepareHook = async () => {
      await blockDB.setTaskCompletion({ taskRef: blockId, completed: false, mutationId: crypto.randomUUID(), userId: 1, workspaceId: "ws-1" });
      await pool.query("UPDATE blocks SET properties=$2 WHERE id=$1", [root, { _done: { ids: [taskId] } }]);
    };
    await call("GET /api/social/rewards/queue");
    assert.ok((await blockDB.getBlock(blockId)).properties._completionRevision);
    await assertEarned(offer, false);
  });
  await t.test("an open bound row cannot borrow completion from a timeline twin", async () => {
    const { offer } = await setup({ props: { status: "open" } });
    await call("GET /api/social/rewards/queue");
    await assertEarned(offer, false);
  });
  for (const props of [{ status: "done" }, { status: "open", done: true }, { status: "open", completed: true },
    { status: "open", completedAt: date + "T12:00:00Z" }, { status: "open", doneAt: date + "T12:00:00Z" }]) {
    await t.test("current canonical completion earns once: " + JSON.stringify(props), async () => {
      const { offer } = await setup({ props });
      await call("GET /api/social/rewards/queue");
      await call("GET /api/todo-share/sponsorships");
      await assertEarned(offer, true);
    });
  }
  for (const kind of ["ids", "at"]) await t.test("unmigrated canonical rows preserve legacy _done." + kind, async () => {
    const { offer, taskId } = await setup({ props: { status: "open" } });
    await pool.query("UPDATE blocks SET properties=$2 WHERE id=$1", [root, { _done: kind === "ids" ? { ids: [taskId] } : { at: { [taskId]: date + "T12:00:00Z" } } }]);
    await call("GET /api/social/rewards/queue");
    await assertEarned(offer, true);
  });
  await t.test("genuine unbound legacy timeline completion still earns", async () => {
    const { offer } = await setup({ bound: false });
    await call("GET /api/social/rewards/queue");
    await assertEarned(offer, true);
  });
  await t.test("current undated global triage membership still earns", async () => {
    const { offer } = await setup({ blockDate: null, props: { triageBlock: true } });
    await call("GET /api/social/rewards/queue");
    await assertEarned(offer, true);
  });
  await t.test("an undated child in a current global triage tree still earns", async () => {
    const { offer, blockId } = await setup({ blockDate: null });
    const parentId = crypto.randomUUID();
    await pool.query(`INSERT INTO blocks(id,type,properties,workspace_id,user_id,created_at,updated_at)
      VALUES($1,'block',$2,'ws-1',1,NOW(),NOW())`, [parentId, { title: "Synthetic triage parent", kind: "task", triageBlock: true }]);
    await pool.query("UPDATE blocks SET parent_id=$2 WHERE id=$1", [blockId, parentId]);
    await call("GET /api/social/rewards/queue");
    await assertEarned(offer, true);
  });
});
