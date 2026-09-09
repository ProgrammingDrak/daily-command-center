const test = require("node:test");
const assert = require("node:assert/strict");

function loadDbWithMock(mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const dbPath = require.resolve("./db");
  delete require.cache[poolPath];
  delete require.cache[dbPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };
  return require("./db");
}

function makePool(row) {
  const queries = [];
  const client = {
    async query(sql) {
      const text = String(sql).trim();
      queries.push(text);
      if (/SELECT \* FROM blocks WHERE id = \$1 FOR UPDATE/.test(text)) return { rows: [{ ...row }] };
      if (text === "BEGIN" || text === "ROLLBACK" || text === "COMMIT") return { rows: [] };
      throw new Error("unexpected query: " + text);
    },
    release() {},
  };
  return { connect: async () => client, query: async () => ({ rows: [] }), queries };
}

test("reschedule transaction rejects a plan whose parent moved after route discovery", async () => {
  const current = {
    id: "parent", type: "block", date: "2026-08-02", properties: { local_id: "p" },
    updated_at: "2026-08-08T12:00:01.000Z", deleted_at: null,
  };
  const pool = makePool(current);
  const db = loadDbWithMock(pool);

  await assert.rejects(
    () => db.rescheduleBlocks([{
      id: "parent", date: "2026-08-03", properties: current.properties,
      expectedDate: "2026-08-01", expectedUpdatedAt: "2026-08-08T12:00:00.000Z",
    }], []),
    (error) => error.statusCode === 409 && error.code === "RESCHEDULE_STALE"
  );
  assert.ok(pool.queries.includes("ROLLBACK"));
  assert.ok(!pool.queries.some((sql) => sql.startsWith("UPDATE blocks")),
    "no part of the stale subtree plan is applied");
});

test("same-day stale placement is rejected by its version even when the date matches", async () => {
  const current = {
    id: "parent", type: "block", date: "2026-08-02", properties: { local_id: "p", start: "10:00", end: "10:30" },
    updated_at: "2026-08-08T12:00:01.000Z", deleted_at: null,
  };
  const pool = makePool(current);
  const db = loadDbWithMock(pool);

  await assert.rejects(
    () => db.rescheduleBlocks([{
      id: "parent", date: current.date, properties: { ...current.properties, start: "11:00", end: "11:30" },
      expectedDate: current.date, expectedUpdatedAt: "2026-08-08T12:00:00.000Z",
    }], []),
    (error) => error.code === "RESCHEDULE_STALE"
  );
  assert.ok(!pool.queries.some((sql) => sql.startsWith("UPDATE blocks")));
});

test("Unplanned promotion updates both parent edge spaces in the existing transaction",async()=>{
  const rows=[{id:'parent',type:'block',date:'2026-09-09',parent_id:'outer',properties:{subtaskOf:'outer-local'},sort_order:1},{id:'child',type:'block',date:'2026-09-09',parent_id:'parent',properties:{subtaskOf:'parent'},sort_order:2}];
  const writes=[],queries=[];
  const client={release(){},async query(sql,params){queries.push(sql);if(sql.startsWith('SELECT *'))return {rows:[rows.find(row=>row.id===params[0])]};if(sql.startsWith('UPDATE'))writes.push(params);return {rows:[]};}};
  const db=loadDbWithMock({connect:async()=>client,query:async()=>({rows:[]})});
  const result=await db.rescheduleBlocks([{id:'parent',date:'2026-09-09',parentId:null,properties:{duration:30}},{id:'child',date:'2026-09-09',properties:{subtaskOf:'parent',duration:0}}],[]);
  assert.equal(writes[0][5],null);assert.equal(writes[1][5],'parent');
  assert.equal(result.blocks[0].parent_id,null);assert.equal(result.blocks[1].parent_id,'parent');
  assert.equal(queries.at(-1),'COMMIT');
});
