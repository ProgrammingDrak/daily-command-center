// Opt in only to the disposable private Unix-socket server used for this audit.
// Never reads DATABASE_URL or the app's local/production connection settings.
const test = require("node:test"),
  assert = require("node:assert/strict");
const socket = process.env.DCC_HIERARCHY_TEST_PG_SOCKET;
test("real PostgreSQL hierarchy persistence and deep subtree operations", { skip: !socket }, async (t) => {
  assert.equal(socket, "/tmp/dcc-hierarchy-date-audit/socket");
  const { Pool } = require("pg"),
    crypto = require("node:crypto");
  const cfg = { host: socket, port: 55447, database: "postgres", user: process.env.USER };
  const schema = "hierarchy_" + crypto.randomUUID().replaceAll("-", "");
  const admin = new Pool(cfg);
  await admin.query("CREATE SCHEMA " + schema);
  const pool = new Pool({ ...cfg, options: "-c search_path=" + schema });
  const poolPath = require.resolve("./pg-pool"),
    dbPath = require.resolve("./db"),
    previous = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  delete require.cache[dbPath];
  const db = require("./db");
  t.after(async () => {
    await pool.end();
    await admin.query("DROP SCHEMA " + schema + " CASCADE");
    await admin.end();
    delete require.cache[dbPath];
    if (previous) require.cache[poolPath] = previous;
    else delete require.cache[poolPath];
  });
  await pool.query(`CREATE TABLE blocks(id TEXT PRIMARY KEY,type TEXT NOT NULL,parent_id TEXT,date DATE,properties JSONB DEFAULT '{}',sort_order DOUBLE PRECISION DEFAULT 0,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,deleted_at TIMESTAMPTZ,user_id INTEGER,workspace_id TEXT);
    CREATE INDEX ON blocks(parent_id);
    CREATE TABLE operations(id SERIAL PRIMARY KEY,block_id TEXT,op_type TEXT,before_data JSONB,after_data JSONB,timestamp TIMESTAMPTZ,batch_id TEXT);
    CREATE FUNCTION dcc_is_task_row(TEXT,JSONB) RETURNS BOOLEAN LANGUAGE SQL AS $$ SELECT $1 NOT IN ('day_root','time_entry') $$;
    CREATE FUNCTION dcc_resolve_local_id(TEXT,DATE,TEXT) RETURNS TEXT LANGUAGE SQL AS $$
      SELECT CASE WHEN COUNT(*)=1 THEN MIN(id) END FROM blocks WHERE workspace_id IS NOT DISTINCT FROM $1 AND date IS NOT DISTINCT FROM $2 AND deleted_at IS NULL AND (id=$3 OR properties->>'local_id'=$3) $$;`);
  const create = (id, props = {}, date = "2026-10-07", ws = "ws-1") =>
    db.createBlock({
      id,
      type: "block",
      date,
      workspace_id: ws,
      sort_order: 1000,
      properties: { title: id, kind: "task", local_id: "local-" + id, ...props }
    });
  const graph = Array.from({ length: 600 }, (_, i) => ({
    id: "deep-" + i,
    type: "block",
    parent_id: i ? "deep-" + (i - 1) : null,
    date: "2026-10-07",
    workspace_id: "ws-1",
    properties: {
      kind: "task",
      title: "Deep " + i,
      local_id: "alias-" + i,
      ...(i ? { subtaskOf: i % 2 ? "alias-" + (i - 1) : "deep-" + (i - 1) } : {}),
      notes: "original note " + i,
      status: "open"
    }
  }));
  await pool.query(
    `INSERT INTO blocks(id,type,parent_id,date,workspace_id,properties,created_at,updated_at)
    SELECT id,type,parent_id,date::date,workspace_id,properties,NOW(),NOW() FROM jsonb_to_recordset($1) AS x(id TEXT,type TEXT,parent_id TEXT,date TEXT,workspace_id TEXT,properties JSONB)`,
    [JSON.stringify(graph)]
  );
  await t.test("600 levels survive SQL subtree collection, legacy alias-only edges and a cycle", async () => {
    await pool.query("UPDATE blocks SET parent_id=NULL WHERE id='deep-80'");
    assert.equal((await db.getSubtree("deep-0", "ws-1")).length, 600);
    await pool.query(
      "UPDATE blocks SET properties=properties||'{\"subtaskOf\":\"deep-599\"}',parent_id='deep-599' WHERE id='deep-0'"
    );
    const rows = await db.getSubtree("deep-0", "ws-1");
    assert.equal(rows.length, 600);
    assert.equal(new Set(rows.map((r) => r.id)).size, 600);
    await pool.query("UPDATE blocks SET properties=properties-'subtaskOf',parent_id=NULL WHERE id='deep-0'");
  });
  await t.test("subtask reparent synchronizes parent_id; descendants and notes survive reload", async () => {
    const target = await create("target"),
      leaf = await db.getBlock("deep-150");
    const updated = await db.updateBlock(leaf.id, {
      properties: { ...leaf.properties, subtaskOf: target.properties.local_id, wrapId: null }
    });
    assert.equal(updated.parent_id, target.id);
    assert.equal(updated.properties.rel, "subtask");
    assert.equal(updated.properties.notes, "original note 150");
    assert.equal((await db.getSubtree(target.id, "ws-1")).length, 451);
    assert.equal((await db.getSubtree("deep-0", "ws-1")).length, 150);
    await db.updateBlock(leaf.id, { properties: { ...updated.properties, subtaskOf: "alias-149" } });
  });
  await t.test("cycles beyond 50 levels and self-parenting reject atomically", async () => {
    const root = await db.getBlock("deep-0");
    await assert.rejects(db.updateBlock(root.id, { properties: { ...root.properties, subtaskOf: "alias-599" } }), {
      statusCode: 409
    });
    await assert.rejects(create("self", { subtaskOf: "self" }), { statusCode: 409 });
    assert.equal((await db.getBlock(root.id)).parent_id, null);
    assert.equal(await db.getBlock("self"), null);
  });
  await t.test("ride-along conversion and promotion synchronize both stored references", async () => {
    const child = await create("child", {
      subtaskOf: "local-target",
      notes: "keep me",
      status: "done",
      done: true,
      completedAt: "2026-10-07T12:00:00Z"
    });
    assert.equal(child.parent_id, "target");
    const wrapped = await db.updateBlock(child.id, {
      properties: { ...child.properties, subtaskOf: null, wrapId: "target", status: "open", done: false }
    });
    assert.equal(wrapped.parent_id, "target");
    assert.equal(wrapped.properties.rel, "ride_along");
    assert.equal(wrapped.properties.status, "done");
    const promoted = await db.updateBlock(child.id, { properties: { ...wrapped.properties, wrapId: null } });
    assert.equal(promoted.parent_id, null);
    assert.equal(promoted.properties.rel, undefined);
    assert.equal(promoted.properties.notes, "keep me");
    assert.equal(promoted.properties.completedAt, "2026-10-07T12:00:00Z");
  });
  await t.test("create detects a cycle through a previously dangling alias", async () => {
    await create("future-parent", { subtaskOf: "future-alias" });
    await assert.rejects(create("future-child", { local_id: "future-alias", subtaskOf: "local-future-parent" }), {
      statusCode: 409
    });
    assert.equal(await db.getBlock("future-child"), null);
  });
  await t.test("wrong-day and foreign-workspace parents reject without changing the row", async () => {
    const target = await create("other-date", {}, "2026-10-08"),
      foreign = await create("foreign", {}, "2026-10-07", "ws-2"),
      root = await db.getBlock("deep-0");
    for (const parent of [target, foreign])
      await assert.rejects(db.updateBlock(root.id, { properties: { ...root.properties, subtaskOf: parent.id } }), {
        statusCode: 409
      });
    assert.equal((await db.getBlock(root.id)).parent_id, null);
  });
  await t.test("creation and concurrent reparenting cannot introduce conflicting or cyclic parents", async () => {
    const a = await create("concurrent-a"),
      b = await create("concurrent-b");
    const results = await Promise.allSettled([
      db.updateBlock(a.id, { properties: { ...a.properties, subtaskOf: b.id } }),
      db.updateBlock(b.id, { properties: { ...b.properties, subtaskOf: a.id } })
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.statusCode, 409);
    await assert.rejects(
      db.createBlock({
        id: "conflicting-create",
        type: "block",
        date: "2026-10-07",
        workspace_id: "ws-1",
        sort_order: 1000,
        parent_id: "target",
        properties: { kind: "task", subtaskOf: a.id }
      }),
      { statusCode: 409 }
    );
    await assert.rejects(
      db.createBlock({
        id: "foreign-create",
        type: "block",
        date: "2026-10-07",
        workspace_id: "ws-1",
        sort_order: 1000,
        parent_id: "foreign",
        properties: { kind: "task" }
      }),
      { statusCode: 409 }
    );
    await pool.query(
      "UPDATE blocks SET properties=jsonb_set(properties,'{subtaskOf}',to_jsonb('concurrent-b'::text)) WHERE id='concurrent-a'"
    );
    await pool.query(
      "UPDATE blocks SET properties=jsonb_set(properties,'{subtaskOf}',to_jsonb('concurrent-a'::text)) WHERE id='concurrent-b'"
    );
    await assert.rejects(create("cyclic-parent-child", { subtaskOf: a.id }), { statusCode: 409 });
  });
  await t.test("completion reaches 600 levels by row or local ID and leaves ride-alongs open", async () => {
    await create("rider", { wrapId: "alias-300" });
    const done = await db.setTaskCompletion({
      taskRef: "deep-0",
      completed: true,
      taskDate: "2026-10-07",
      mutationId: "deep-complete",
      workspaceId: "ws-1"
    });
    assert.equal(done.affectedTasks.length, 600);
    assert.equal((await db.getBlock("deep-599")).properties.status, "done");
    assert.equal((await db.getBlock("rider")).properties.status, "open");
    await db.setTaskCompletion({
      taskRef: "deep-599",
      completed: false,
      taskDate: "2026-10-07",
      mutationId: "deep-reopen",
      workspaceId: "ws-1",
      expectedRevision: (await db.getBlock("deep-599")).properties._completionRevision
    });
    assert.equal((await db.getBlock("deep-599")).properties.status, "open");
    assert.equal((await db.getBlock("deep-598")).properties.status, "done");
  });
  await t.test("undated deep tree assignment, stale retry, date move and delete/revive keep one durable tree", async () => {
    const {plan}=require("./lib/whenever-placement"), {collectSubtreeBlockIds}=require("./lib/reschedule");
    const nodes=Array.from({length:90},(_,i)=>({id:"pool-"+i,type:"block",date:null,workspace_id:"ws-1",parent_id:i?"pool-"+(i-1):null,
      properties:{kind:"backlog",type:"task",local_id:"pool-local-"+i,title:"Pool "+i,notes:"Keep pool "+i,duration:i?0:30,...(i?{subtaskOf:"pool-local-"+(i-1)}:{})}}));
    await pool.query(`INSERT INTO blocks(id,type,parent_id,date,workspace_id,properties,created_at,updated_at)
      SELECT id,type,parent_id,date::date,workspace_id,properties,NOW(),NOW() FROM jsonb_to_recordset($1) AS x(id TEXT,type TEXT,parent_id TEXT,date TEXT,workspace_id TEXT,properties JSONB)`,[JSON.stringify(nodes)]);
    const rows=await db.getSubtree("pool-0","ws-1"), root=rows.find(r=>r.id==="pool-0");
    const placement=plan(root,rows,{targetDate:"2026-10-08",placement:{kind:"pool_date"}});
    assert.equal(placement.moves.length,90);
    await db.rescheduleBlocks(placement.moves,[]);
    await assert.rejects(db.rescheduleBlocks(placement.moves,[]),{code:"RESCHEDULE_STALE"});
    let current=await db.getSubtree("pool-0","ws-1");
    assert.equal(current.length,90);assert.ok(current.every(r=>r.date==="2026-10-08"&&r.properties.start===null));
    const ids=collectSubtreeBlockIds(current,current.find(r=>r.id==="pool-0"));
    await db.rescheduleBlocks(ids.map(id=>{const r=current.find(r=>r.id===id);return {id,date:"2026-10-09",expectedDate:r.date,expectedUpdatedAt:r.updated_at};}),[]);
    for(let round=0;round<2;round++){
      await db.batchOp(ids.map(id=>({op:"delete",id})));
      assert.equal((await db.getSubtree("pool-0","ws-1")).length,0);
      for(const id of ids)await db.undeleteBlock(id);
      current=await db.getSubtree("pool-0","ws-1");assert.equal(current.length,90);
      for(const r of current){assert.equal(r.date,"2026-10-09");assert.equal(r.properties.notes,"Keep pool "+r.id.slice(5));}
    }
    const total=await pool.query("SELECT COUNT(*)::int AS total FROM blocks WHERE id LIKE 'pool-%'");assert.equal(total.rows[0].total,90);
  });

});
