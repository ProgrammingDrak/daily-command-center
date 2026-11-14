const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createActivityDb } = require("./test-support/activity-db");
const configured = !!process.env.DCC_TEST_DATABASE_URL;

test("browser queue validators cover private dependencies and skip the foreground lock on a hit", { skip: !configured }, async (t) => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  await ctx.pool.query(require("./conversation-store").FOREGROUND_INDEX_SQL);
  const now = Date.now();
  let clock = now;
  ctx.now = () => clock;
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: Number(req.get("X-Test-User") || 1) };
    req.workspaceId = req.get("X-Test-Workspace") || "ws-1";
    next();
  });
  require("./routes/working-queue")(app, ctx, { enabled: true });
  const server = await new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port + "/api/working-queue";
  const scope = encodeURIComponent(JSON.stringify([1, "ws-1"]));
  const read = (version = "", headers = {}, signal) => fetch(url, {
    headers: { "X-DCC-Queue-Scope": scope, "X-DCC-Queue-Version": version, ...headers },
    signal
  });
  const query = (sql, args) => ctx.pool.query(sql, args);
  await query(`INSERT INTO blocks(id,type,date,properties,user_id,workspace_id,created_at,updated_at)
    VALUES ('queued','block','2026-10-20','{"type":"task","title":"Initial","local_id":"legacy-local"}',1,'ws-1',NOW(),NOW()),
           ('next','block','2026-10-20','{"type":"task","title":"Next"}',1,'ws-1',NOW(),NOW())`);
  await query("INSERT INTO conversation_background(user_id,workspace_id,task_id,started_at) VALUES(1,'ws-1','queued',NOW())");
  let initial = await read();
  assert.equal(initial.headers.get("cache-control"), "private, no-store");
  let current = await initial.json();
  assert.ok(current.version, JSON.stringify(current));
  assert.deepEqual(current.state.queue.order, ["queued"]);

  const held = await ctx.pool.connect();
  await held.query("BEGIN");
  await held.query("SELECT pg_advisory_xact_lock(hashtextextended('dcc-foreground:1',0))");
  try {
    const hit = await read(current.version, {}, globalThis.AbortSignal.timeout(2000));
    assert.match(hit.headers.get("server-timing"), /^queue-unchanged;dur=/);
    assert.deepEqual(await hit.json(), { unchanged: true });
  } finally {
    await held.query("ROLLBACK");
    held.release();
  }

  async function changed(sql, args) {
    if (sql) await query(sql, args);
    const response = await read(current.version);
    assert.match(response.headers.get("server-timing"), /^queue-snapshot;dur=/);
    const next = await response.json();
    assert.ok(next.version && next.version !== current.version, JSON.stringify(next));
    assert.equal(next.state.revision, 0, "fixture writes bypass the command revision");
    current = next;
    return next.state;
  }
  await changed("UPDATE conversation_background SET started_at=started_at - interval '1 hour'");
  const title = await changed("UPDATE blocks SET properties=properties || '{\"title\":\"Edited\"}' WHERE id='queued'");
  assert.equal(title.queue.items[0].task.properties.title, "Edited");
  await changed(`INSERT INTO blocks(id,type,date,properties,user_id,workspace_id,created_at,updated_at)
    VALUES ('session-test','time_entry','2026-10-20','{"blockId":"legacy-local"}',1,'ws-1',NOW(),NOW())`);
  const completed = await changed(`INSERT INTO blocks(id,type,date,properties,user_id,workspace_id,created_at,updated_at)
    VALUES ('test-day','day_root','2026-10-20','{"_done":{"ids":["legacy-local"]}}',1,'ws-1',NOW(),NOW())`);
  assert.equal(completed.queue.items[0].status, "completed");

  await changed("DELETE FROM blocks WHERE id='test-day'");
  const due = new Date(now + 1000).toISOString();
  const rotation = {
    version: 2, order: ["next", "queued"],
    items: { next: { status: "queued" }, queued: {
      status: "paused", pausedOperationId:null, dueAt:due, snoozedUntil:due, generation:"test"
    } }
  };
  const ordered = await changed("INSERT INTO work_rotations(workspace_id,user_id,state) VALUES('ws-1',1,$1)", [rotation]);
  assert.deepEqual(ordered.queue.order, ["next", "queued"]);
  assert.equal(ordered.queue.items[1].snoozed, true);
  clock += 1000;
  assert.equal((await changed()).queue.items[1].needsYou, true);

  const report = {
    phase:"working", work:{source:"test",id:"lease"}, at:due,
    execution:{state:"running",observedAt:due,validUntil:new Date(now+2000).toISOString()}
  };
  await changed("INSERT INTO delegated_work(user_id,workspace_id,task_id,work_key,report) VALUES(1,'ws-1','next','lease',$1)", [report]);
  assert.equal(current.state.queue.items[0].execution.state, "running");
  clock += 1000;
  const expired = await read(current.version);
  current = await expired.json();
  assert.equal(current.state.queue.items[0].execution.state, "stale");

  const remote = await changed(`INSERT INTO blocks(id,type,date,properties,user_id,workspace_id,created_at,updated_at)
    VALUES ('other','block','2026-10-20',$1,1,'ws-2',NOW(),NOW())`, [
    { type:"task", title:"Other workspace focus", startedAt:due }
  ]);
  assert.equal(remote.otherWorkspaceForeground, true);
  const store = require("./conversation-store").createConversationStore(ctx);
  await assert.rejects(store.execute({
    action: "start", taskId: "next", expectedRevision: 0,
    sourceEventId: "blocked-other-foreground", at: due, expectedForegroundTaskId: null
  }, {userId:1, workspaceId:"ws-1"}), /Release foreground work in the other workspace/);
  assert.equal((await query("SELECT properties->>'startedAt' AS started FROM blocks WHERE id='other'")).rows[0].started, due);
  const noRemote = await changed("UPDATE blocks SET properties=properties-'startedAt' WHERE id='other'");
  assert.equal(noRemote.otherWorkspaceForeground, false);
  const retained = await changed("INSERT INTO work_rotations(workspace_id,user_id,state) VALUES('ws-2',1,$1)", [
    { version:2, order:["other"], items:{other:{status:"foreground",breakStartedAt:due,breakOperationId:null}} }
  ]);
  assert.equal(retained.otherWorkspaceForeground, true);
  assert.equal((await changed("DELETE FROM blocks WHERE id='other'")).otherWorkspaceForeground, false);

  // Commit an ordinary block edit after the validator reads its snapshot.
  // The old payload must never acquire the fingerprint of the new row.
  const pgConnect = ctx.pool.connect;
  let editedDuringRead = false;
  ctx.pool.connect = async function (...args) {
    if (args.length) return pgConnect.apply(this, args);
    const client = await pgConnect.call(this);
    const clientQuery = client.query;
    const release = client.release;
    client.query = async function (sql, ...params) {
      const result = await clientQuery.call(this, sql, ...params);
      if (!editedDuringRead && sql.includes("current_tasks AS MATERIALIZED")) {
        editedDuringRead = true;
        await query("UPDATE blocks SET properties=properties || '{\"title\":\"Committed during read\"}' WHERE id='queued'");
      }
      return result;
    };
    client.release = function (...params) {
      client.query = clientQuery;
      return release.apply(this, params);
    };
    return client;
  };
  try {
    current = await (await read()).json();
    assert.ok(editedDuringRead && current.version);
    assert.equal(current.state.queue.items[1].task.properties.title, "Edited");
  } finally {
    ctx.pool.connect = pgConnect;
  }
  assert.equal((await changed()).queue.items[1].task.properties.title, "Committed during read");

  const otherHeaders = { "X-Test-User": "2", "X-Test-Workspace": "ws-2" };
  assert.equal((await read(current.version, otherHeaders)).status, 409);
  assert.equal((await read(current.version, { "X-Test-User": "3", "X-DCC-Queue-Scope": encodeURIComponent(JSON.stringify([3,"ws-1"])) })).status, 403);
  const other = await read(current.version, { ...otherHeaders, "X-DCC-Queue-Scope": encodeURIComponent(JSON.stringify([2,"ws-2"])) });
  assert.deepEqual((await other.json()).state.queue.order, []);
  assert.deepEqual((await (await fetch(url)).json()).queue.order, ["next", "queued"]);

  // Simulate a validator outage at the query boundary. Legacy clients and the
  // browser's full-read fallback still return the same authoritative queue.
  const poolQuery = ctx.pool.query;
  ctx.pool.query = function (sql, ...args) {
    if (sql.includes("current_tasks AS MATERIALIZED")) return Promise.reject(new Error("synthetic validator outage"));
    return poolQuery.call(this, sql, ...args);
  };
  try {
    const fallback = await read(current.version);
    assert.match(fallback.headers.get("server-timing"), /^queue-snapshot;dur=/);
    assert.deepEqual((await fallback.json()).state.queue.order, ["next", "queued"]);
  } finally {
    ctx.pool.query = poolQuery;
  }
});
