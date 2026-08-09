// Phase A1 — canonical task model. Pins the JS half of the contract:
//
//   • isTaskRow, the ONE task-row predicate (SQL twin: dcc_is_task_row)
//   • create-time dual-write: local_id === id, status='open', rel, parent_id edge
//   • the primitives that later phases consume, especially the two whose VALUE is an
//     omission — findByIdempotencyKey must NOT filter tombstones, and
//     getBlockIncludingDeleted must return them
//
// Harness: a transaction-faithful mock pool injected into require.cache before db.js
// loads, same trick as batchop-tx.test.js / budget-store.test.js, so `npm test` stays
// hermetic. The migration SQL itself is verified against a real restore of prod —
// synthetic rows cannot reproduce the Date.now() local_id collisions that drive the
// ambiguity handling, so asserting on them here would prove nothing.
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

// resolveMap: { [ref]: blockId | null } — stands in for dcc_resolve_local_id, whose
// real ambiguity logic lives in SQL and is exercised against the prod restore.
function makeMockPool(initialRows = [], resolveMap = {}) {
  const committed = new Map(initialRows.map((r) => [r.id, { ...r }]));
  const log = [];

  function makeExec(staged) {
    async function query(sql, params = []) {
      const text = String(sql).trim();
      log.push({ text, params });
      if (text === "BEGIN" || text === "ROLLBACK") { if (staged) staged.clear(); return { rows: [] }; }
      if (text === "COMMIT") {
        for (const [k, v] of staged) { if (v === null) committed.delete(k); else committed.set(k, v); }
        staged.clear();
        return { rows: [] };
      }
      const view = (id) => (staged && staged.has(id)) ? staged.get(id) : (committed.get(id) || null);
      const put = (id, r) => { if (staged) staged.set(id, r); else committed.set(id, r); };

      // C6c: createBlock asks for the day's next `sort_order` slot when the caller gives none.
      // Answered from the mock's own rows so the real max-then-round-up logic is exercised, not
      // stubbed past -- a constant here would hide the whole one-number-space change.
      // C6c: createBlock asks for the day's next `sort_order` slot when the caller gives none.
      // Answered from the mock's own rows so the real max-then-round-up logic is exercised, not
      // stubbed past -- a constant here would hide the whole one-number-space change.
      if (/COALESCE\(MAX\(sort_order\), 0\) AS mx/.test(text)) {
        const [d, ws] = params;
        const all = [...committed.values()].concat(staged ? [...staged.values()] : []);
        const mx = all.reduce((m, r) => {
          if (!r || r.deleted_at) return m;
          if ((r.date || null) !== (d || null)) return m;
          if ((r.workspace_id || null) !== (ws || null)) return m;
          const n = Number(r.sort_order);
          return Number.isFinite(n) && n > m ? n : m;
        }, 0);
        return { rows: [{ mx }] };
      }
      if (/dcc_resolve_local_id/.test(text)) {
        const ref = params[2];
        return { rows: [{ pid: Object.prototype.hasOwnProperty.call(resolveMap, ref) ? resolveMap[ref] : null }] };
      }
      if (/^SELECT \* FROM blocks\s+WHERE properties->>'idempotency_key'/.test(text)) {
        const hits = [...committed.values()].filter(
          (r) => (r.properties || {}).idempotency_key === params[0]
            && (r.workspace_id || null) === (params[1] || null));
        return { rows: hits.length ? [{ ...hits[0] }] : [] };
      }
      if (/^SELECT (\*|id) FROM blocks WHERE id/.test(text)) {
        const r = view(params[0]);
        return { rows: r ? [{ ...r }] : [] };
      }
      if (/^INSERT INTO blocks/.test(text)) {
        put(params[0], {
          id: params[0], type: params[1], parent_id: params[2], date: params[3],
          properties: params[4], sort_order: params[5], user_id: params[6],
          workspace_id: params[7], created_at: params[8], updated_at: params[9], deleted_at: null,
        });
        return { rows: [] };
      }
      if (/^UPDATE blocks SET deleted_at = NULL/.test(text)) {
        const cur = view(params[1]);
        if (cur) put(params[1], { ...cur, deleted_at: null, updated_at: params[0] });
        return { rows: [] };
      }
      if (/^UPDATE blocks SET deleted_at/.test(text)) {
        const cur = view(params[2]);
        if (cur) put(params[2], { ...cur, deleted_at: params[0], updated_at: params[1] });
        return { rows: [] };
      }
      if (/^UPDATE blocks SET properties = /.test(text)) {
        const cur = view(params[5]);
        const properties = params[0];
        if (cur) put(params[5], {
          ...cur, properties, sort_order: params[1], parent_id: params[2], date: params[3], updated_at: params[4],
        });
        return { rows: cur ? [{ properties }] : [] };
      }
      if (/^INSERT INTO operations/.test(text)) return { rows: [] };
      throw new Error("Unhandled mock query: " + text.slice(0, 70));
    }
    return { query };
  }

  return {
    query: (sql, params) => makeExec(null).query(sql, params),
    connect: async () => ({ ...makeExec(new Map()), release() {} }),
    _committed: committed,
    _log: log,
  };
}

function row(id, props = {}, over = {}) {
  return {
    id, type: "block", parent_id: null, date: "2026-07-29", properties: props,
    sort_order: 0, created_at: "t0", updated_at: "t0", deleted_at: null,
    user_id: null, workspace_id: "ws-1", ...over,
  };
}

// ── isTaskRow: the one predicate ──

test("isTaskRow admits real tasks and rejects containers and scaffolding", () => {
  const db = loadDbWithMock(makeMockPool());

  // Included — shells and meetings ARE task rows.
  assert.equal(db.isTaskRow({ type: "block", properties: { title: "x" } }), true);
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "shell" } }), true);
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "meeting" } }), true);
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "backlog" } }), true);
  assert.equal(db.isTaskRow({ type: "added_task", properties: {} }), true);

  // Excluded.
  assert.equal(db.isTaskRow({ type: "day_root", properties: { date: "2026-07-29" } }), false);
  assert.equal(db.isTaskRow({ type: "time_entry", properties: {} }), false);
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "delegated_item" } }), false);
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "task_group" } }), false);
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "reschedule_tombstone" } }), false);
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "slack_reaction_tombstone" } }), false);
  // responsibility* is a prefix match, so every variant is covered by one rule.
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "responsibility_item" } }), false);
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "responsibility_trigger" } }), false);
  assert.equal(db.isTaskRow({ type: "block", properties: { kind: "responsibility_task" } }), false);

  assert.equal(db.isTaskRow(null), false);
});

test("a stale reconciler update cannot reopen a completed task", async () => {
  const pool = makeMockPool([row("task-1", {
    title: "Persist me", status: "done", done: true,
    completedAt: "2026-08-08T14:00:00.000Z", completedBy: "itinerary",
  })]);
  const db = loadDbWithMock(pool);

  const result = await db.updateBlock("task-1", { properties: {
    title: "Persist me", status: "open", actualMinutes: 25, actualMinutesFrom: "reconcile",
  } });

  assert.equal(result.properties.status, "done");
  assert.equal(result.properties.done, true);
  assert.equal(result.properties.completedAt, "2026-08-08T14:00:00.000Z");
  assert.equal(result.properties.completedBy, "itinerary");
  assert.equal(result.properties.actualMinutes, 25);
  assert.equal(pool._committed.get("task-1").properties.status, "done");
});

test("updateBlock locks the row before deriving completion state", async () => {
  const pool = makeMockPool([row("task-1", {
    title: "Race me", status: "done", done: true,
    completedAt: "2026-08-08T14:00:00.000Z", completedBy: "other-tab",
  })]);
  const db = loadDbWithMock(pool);

  const result = await db.updateBlock("task-1", { properties: {
    title: "Race me", status: "open", actualMinutes: 25, actualMinutesFrom: "reconcile",
  } });

  assert.equal(result.properties.status, "done");
  assert.equal(result.properties.completedAt, "2026-08-08T14:00:00.000Z");
  assert.equal(result.properties.completedBy, "other-tab");
  assert.equal(result.properties.actualMinutes, 25);
  assert.ok(pool._log.some(entry => /SELECT \* FROM blocks WHERE id = \$1 FOR UPDATE/.test(entry.text)));
  assert.ok(pool._log.some(entry => entry.text === "BEGIN"));
  assert.ok(pool._log.some(entry => entry.text === "COMMIT"));
});

test("a stale done snapshot cannot re-complete a task after explicit reopen", async () => {
  const stale = { title: "Race me", status: "done", done: true,
    completedAt: "2026-08-08T14:00:00.000Z" };
  const pool = makeMockPool([row("task-1", stale)]);
  const db = loadDbWithMock(pool);

  await db.updateBlock("task-1", {
    properties: { title: "Race me", status: "open" }, completionIntent: "reopen",
  });
  const result = await db.updateBlock("task-1", { properties: { ...stale, actualMinutes: 25 } });

  assert.equal(result.properties.status, "open");
  assert.equal(result.properties.done, undefined);
  assert.equal(result.properties.completedAt, undefined);
  assert.equal(result.properties.actualMinutes, 25);
});

test("a properties-omitting update leaves the locked row properties untouched", async () => {
  const completedAt = "2026-08-08T14:00:00.000Z";
  const pool = makeMockPool([row("task-1", { title: "Move me", status: "done", done: true, completedAt })]);
  const db = loadDbWithMock(pool);

  const result = await db.updateBlock("task-1", { sort_order: 2000 });

  assert.equal(result.properties.status, "done");
  assert.equal(result.properties.completedAt, completedAt);
  assert.equal(result.sort_order, 2000);
});

test("ordinary non-completion status changes remain writable", async () => {
  const pool = makeMockPool([row("task-1", { title: "Start me", status: "open" })]);
  const db = loadDbWithMock(pool);

  const result = await db.updateBlock("task-1", { properties: { title: "Start me", status: "in_progress" } });

  assert.equal(result.properties.status, "in_progress");
});

test("ordinary open-row edits preserve the latest completion revision", async () => {
  const pool = makeMockPool([row("task-1", {
    title: "Before", status: "open", _completionRevision: "reopen-r2",
  })]);
  const db = loadDbWithMock(pool);

  const result = await db.updateBlock("task-1", { properties: { title: "After", status: "open" } });

  assert.equal(result.properties.title, "After");
  assert.equal(result.properties._completionRevision, "reopen-r2");
});

test("only an explicit completion intent may reopen a completed task", async () => {
  const pool = makeMockPool([row("task-1", {
    title: "Reopen me", status: "done", done: true, completedAt: "2026-08-08T14:00:00.000Z",
  })]);
  const db = loadDbWithMock(pool);

  const result = await db.updateBlock("task-1", {
    properties: { title: "Reopen me", status: "open", completedAt: "stale" },
    completionIntent: "reopen",
  });

  assert.equal(result.properties.status, "open");
  for (const key of ["done", "completed", "completedAt", "doneAt", "completedBy"]) {
    assert.equal(key in result.properties, false, key + " must be cleared by the explicit reopen");
  }
});

test("same-state explicit retries preserve the transition revision", async () => {
  const pool = makeMockPool([row("task-1", {
    title: "Already open", status: "open",
    _completionRevision: "reopen-r1", _completionMutationId: "reopen-m1",
  })]);
  const db = loadDbWithMock(pool);

  const result = await db.updateBlock("task-1", {
    properties: { title: "Still open", status: "open" },
    completionIntent: "reopen",
    completionMutationId: "reopen-m2",
    completionBaseRevision: "reopen-r1",
  });

  assert.equal(result.properties._completionRevision, "reopen-r1");
  assert.equal(result.properties._completionMutationId, "reopen-m1");
});

test("a stale cross-device completion transition is rejected by base revision", async () => {
  const pool = makeMockPool([row("task-1", {
    title: "Newest", status: "open",
    _completionRevision: "reopen-new", _completionMutationId: "reopen-new-mutation",
  })]);
  const db = loadDbWithMock(pool);

  await assert.rejects(
    db.updateBlock("task-1", {
      properties: { title: "Old snapshot", status: "done", done: true },
      completionIntent: "complete",
      completionMutationId: "complete-old-mutation",
      completionBaseRevision: "complete-old-base",
    }),
    error => error && error.statusCode === 409 && error.publicCode === "COMPLETION_CONFLICT"
  );
  assert.equal(pool._committed.get("task-1").properties.status, "open");
});

// ── Create-time dual-write ──

test("createBlock does NOT stamp local_id — its presence is the fold's admission flag", async () => {
  // persistence.js:262 admits a row into the itinerary when it has a local_id, so
  // stamping one is a visibility change, not an identifier. persistence.js:274 already
  // falls back to block.id, so the invariant costs nothing to leave unwritten.
  const db = loadDbWithMock(makeMockPool());
  const b = await db.createBlock({
    type: "block", date: "2026-07-29", properties: { title: "Ship A1" }, workspace_id: "ws-1",
  });
  assert.equal(b.properties.local_id, undefined, "writing this would promote non-tasks into the itinerary");
  assert.equal(b.properties.status, "open");
});

test("createBlock never overwrites a caller's local_id or status", async () => {
  const db = loadDbWithMock(makeMockPool());
  const b = await db.createBlock({
    id: "row-1", type: "block", date: "2026-07-29",
    properties: { title: "x", local_id: "legacy-999", status: "done" }, workspace_id: "ws-1",
  });
  // Existing client references point at the OLD local_id; clobbering it would break them.
  assert.equal(b.properties.local_id, "legacy-999");
  assert.equal(b.properties.status, "done");
});

test("createBlock leaves non-task rows completely alone", async () => {
  const db = loadDbWithMock(makeMockPool());
  const root = await db.createBlock({ id: "day-root-ws-1-2026-07-29", type: "day_root", date: "2026-07-29", properties: { date: "2026-07-29" } });
  assert.equal(root.properties.status, undefined);

  const resp = await db.createBlock({ type: "block", properties: { kind: "responsibility_item" }, workspace_id: "ws-1" });
  assert.equal(resp.properties.status, undefined);
});

test("createBlock does not mutate the caller's properties object", async () => {
  // responsibility-store.js applyForwardDiff pushes the SAME properties object once per
  // future date into one batchOp. Aliasing it meant the first create stamped the shared
  // object and every later row inherited those values.
  const db = loadDbWithMock(makeMockPool());
  const shared = { title: "apply forward" };
  const a = await db.createBlock({ type: "block", date: "2026-07-30", properties: shared, workspace_id: "ws-1" });
  const b = await db.createBlock({ type: "block", date: "2026-07-31", properties: shared, workspace_id: "ws-1" });

  assert.equal(shared.status, undefined, "the caller's object must come back untouched");
  assert.equal(a.properties.status, "open");
  assert.equal(b.properties.status, "open");
  assert.notEqual(a.id, b.id);
});

test("createBlock resolves subtaskOf into a parent_id edge and stamps rel", async () => {
  const pool = makeMockPool([row("parent-row", { local_id: "legacy-parent" })], { "legacy-parent": "parent-row" });
  const db = loadDbWithMock(pool);
  const kid = await db.createBlock({
    type: "block", date: "2026-07-29", workspace_id: "ws-1",
    properties: { title: "kid", subtaskOf: "legacy-parent" },
  });
  assert.equal(kid.parent_id, "parent-row");
  assert.equal(kid.properties.rel, "subtask");
});

test("createBlock stamps rel='ride_along' for wrapId", async () => {
  const pool = makeMockPool([row("wrap-row", {})], { "wrap-1": "wrap-row" });
  const db = loadDbWithMock(pool);
  const kid = await db.createBlock({
    type: "block", date: "2026-07-29", workspace_id: "ws-1",
    properties: { title: "ride", wrapId: "wrap-1" },
  });
  assert.equal(kid.parent_id, "wrap-row");
  assert.equal(kid.properties.rel, "ride_along");
});

test("an unresolvable or ambiguous ref leaves the row a root rather than guessing", async () => {
  // resolveMap has no entry -> the SQL resolver returned NULL, meaning "no match OR a
  // Date.now() collision". Degrading to a root is exactly today's flat behavior; a
  // guess would silently re-parent a real task.
  const db = loadDbWithMock(makeMockPool([], {}));
  const kid = await db.createBlock({
    type: "block", date: "2026-07-29", workspace_id: "ws-1",
    properties: { title: "orphan", subtaskOf: "collides-with-two-rows" },
  });
  assert.equal(kid.parent_id, null);
  assert.equal(kid.properties.rel, "subtask", "rel records the intent even when the edge fails");
});

test("the task-tree edge replaces a day_root container but never an explicit parent", async () => {
  const pool = makeMockPool([row("parent-row", {})], { "ref-1": "parent-row" });
  const db = loadDbWithMock(pool);

  const overRoot = await db.createBlock({
    type: "block", parent_id: "day-root-ws-1-2026-07-29", date: "2026-07-29", workspace_id: "ws-1",
    properties: { title: "a", subtaskOf: "ref-1" },
  });
  assert.equal(overRoot.parent_id, "parent-row", "a day_root parent is just the container");

  const explicit = await db.createBlock({
    type: "block", parent_id: "chosen-parent", date: "2026-07-29", workspace_id: "ws-1",
    properties: { title: "b", subtaskOf: "ref-1" },
  });
  assert.equal(explicit.parent_id, "chosen-parent", "a deliberate parent wins");
});

test("createBlock survives a database with no dcc_resolve_local_id function", async () => {
  // pg-schema's post-schema pass is non-fatal by design, so the helper can be absent.
  // A create must still succeed — just without the edge.
  const base = makeMockPool();
  const wrapped = {
    ...base,
    query: async (sql, params) => {
      if (/dcc_resolve_local_id/.test(String(sql))) throw new Error("function dcc_resolve_local_id does not exist");
      return base.query(sql, params);
    },
  };
  const db = loadDbWithMock(wrapped);
  const kid = await db.createBlock({
    type: "block", date: "2026-07-29", workspace_id: "ws-1",
    properties: { title: "x", subtaskOf: "ref-1" },
  });
  assert.equal(kid.parent_id, null);
  assert.equal(kid.properties.rel, "subtask", "rel still records the intent");
});

test("a missing resolver inside a TRANSACTION degrades the row, not the whole batch", async () => {
  // The path that actually matters and was untested. resolveParentRef runs on the
  // caller's client before the INSERT, so without a SAVEPOINT a failed probe leaves
  // Postgres in the aborted state (25P02) and every later statement in the batch dies.
  // The mock models that: once poisoned, only ROLLBACK/RELEASE/COMMIT are accepted.
  const base = makeMockPool();
  const wrapped = {
    ...base,
    connect: async () => {
      const c = await base.connect();
      let poisoned = false;
      return {
        release() {},
        query: async (sql, params) => {
          const t = String(sql).trim();
          if (/dcc_resolve_local_id/.test(t)) { poisoned = true; throw new Error("function dcc_resolve_local_id does not exist"); }
          if (/^ROLLBACK TO SAVEPOINT/i.test(t)) { poisoned = false; return { rows: [] }; }
          if (/^(SAVEPOINT|RELEASE SAVEPOINT)/i.test(t)) return { rows: [] };
          if (poisoned && !/^(ROLLBACK|COMMIT)/i.test(t)) {
            throw new Error("current transaction is aborted, commands ignored until end of transaction block");
          }
          return c.query(sql, params);
        },
      };
    },
  };
  const db = loadDbWithMock(wrapped);
  const res = await db.batchOp([{
    op: "create", type: "block", date: "2026-07-29", workspace_id: "ws-1",
    properties: { title: "kid", subtaskOf: "ref-1" },
  }]);
  assert.equal(res.blocks.length, 1, "the batch must still commit");
  assert.equal(res.blocks[0].parent_id, null, "the row degrades to a root");
});

test("a ref resolving to the row itself is refused, not self-parented", async () => {
  // blocks_no_self_parent is enforced on new rows even though it is added NOT VALID, so
  // a self edge would 500 the create. POST /api/blocks spreads a client-supplied item
  // straight into createBlock, so the id and the ref can both be attacker-chosen.
  const db = loadDbWithMock(makeMockPool([], { "row-1": "row-1" }));
  const b = await db.createBlock({
    id: "row-1", type: "block", date: "2026-07-29", workspace_id: "ws-1",
    properties: { title: "x", subtaskOf: "row-1" },
  });
  assert.equal(b.parent_id, null);
});

test("createBlock never overwrites a caller's rel", async () => {
  const db = loadDbWithMock(makeMockPool([row("p", {})], { r: "p" }));
  const b = await db.createBlock({
    type: "block", date: "2026-07-29", workspace_id: "ws-1",
    properties: { title: "x", subtaskOf: "r", rel: "custom" },
  });
  assert.equal(b.properties.rel, "custom");
});

test("createItineraryTask inherits the dual-write instead of duplicating it", async () => {
  const pool = makeMockPool([{ id: "day-root-ws-1-2026-07-29", type: "day_root", properties: {} }]);
  const db = loadDbWithMock(pool);
  const t = await db.createItineraryTask({
    date: "2026-07-29", workspaceId: "ws-1", properties: { title: "quick", start: "09:30" },
  });
  assert.equal(t.properties.status, "open");
  assert.equal(t.properties.local_id, undefined, "same no-local_id rule as createBlock");
});

// ── Primitives ──

test("undeleteBlock clears a tombstone and is idempotent on a live row", async () => {
  const pool = makeMockPool([row("gone", { title: "x" }, { deleted_at: "2026-07-28T00:00:00Z" })]);
  const db = loadDbWithMock(pool);

  const back = await db.undeleteBlock("gone");
  assert.equal(back.deleted_at, null);
  assert.equal(pool._committed.get("gone").deleted_at, null);

  const again = await db.undeleteBlock("gone");
  assert.equal(again.deleted_at, null);
});

test("undeleteBlock rejects an id that does not exist", async () => {
  const db = loadDbWithMock(makeMockPool());
  await assert.rejects(() => db.undeleteBlock("nope"), /Block not found/);
});

test("getBlockIncludingDeleted returns tombstoned rows", async () => {
  const pool = makeMockPool([row("gone", { title: "x" }, { deleted_at: "2026-07-28T00:00:00Z" })]);
  const db = loadDbWithMock(pool);
  const b = await db.getBlockIncludingDeleted("gone");
  assert.ok(b && b.deleted_at, "a tombstone must still be visible to this call");
});

test("findByIdempotencyKey matches a SOFT-DELETED row — the omission is the point", async () => {
  // Filtering `AND deleted_at IS NULL` here IS the resurrection bug: delete a
  // quick-task and the next agent retry finds no live match and recreates it.
  const pool = makeMockPool([
    row("dead", { idempotency_key: "brief:2026-07-29:a" }, { deleted_at: "2026-07-28T00:00:00Z" }),
  ]);
  const db = loadDbWithMock(pool);
  const hit = await db.findByIdempotencyKey("ws-1", "brief:2026-07-29:a");
  assert.ok(hit, "a tombstoned row must be found so the caller does NOT re-create it");
  assert.ok(hit.deleted_at);
  assert.equal(await db.findByIdempotencyKey("ws-1", null), null);
});

test("getSubtree walks parent_id, stops at day_roots, and excludes tombstones", async () => {
  // The recursive CTE runs in Postgres; assert on the SQL contract instead of
  // re-implementing the walk in the mock, which would only test the mock.
  const pool = makeMockPool();
  const db = loadDbWithMock(pool);
  pool.query = async (sql, params) => { pool._log.push({ text: String(sql), params }); return { rows: [] }; };

  assert.deepEqual(await db.getSubtree([], "ws-1"), [], "no roots means no query at all");
  assert.equal(pool._log.length, 0);

  await db.getSubtree("root-1", "ws-1");
  const sql = pool._log[0].text;
  assert.match(sql, /WITH RECURSIVE/);
  assert.match(sql, /c\.parent_id = t\.id/, "walks the parent_id edge");
  assert.match(sql, /type <> 'day_root'/, "a container is not part of a task subtree");
  assert.match(sql, /deleted_at IS NULL/);
  assert.match(sql, /t\.depth < 32/, "depth cap so a stray cycle cannot spin forever");
  assert.match(sql, /DISTINCT ON \(id\)/, "a diamond must yield each row once");
  assert.deepEqual(pool._log[0].params[0], ["root-1"], "a bare id is accepted as well as an array");
});

test("findByIdempotencyKey prefers a LIVE row over an older tombstone", async () => {
  // Matches routes/dcc.js findBriefBlock (`ORDER BY deleted_at IS NULL DESC`), which
  // later phases migrate onto this function. Ordering by created_at alone would hand
  // back the tombstone — and the case is real, because migration step 6 partitions only
  // over live rows, so a user tombstone can be older than the row it shares a key with.
  const db = loadDbWithMock(makeMockPool());
  const sqlSeen = [];
  const base = makeMockPool();
  base.query = async (sql) => { sqlSeen.push(String(sql)); return { rows: [] }; };
  const db2 = loadDbWithMock(base);
  await db2.findByIdempotencyKey("ws-1", "brief:2026-07-29:a");
  assert.match(sqlSeen[0], /ORDER BY \(deleted_at IS NULL\) DESC, created_at ASC/);
  assert.ok(!/deleted_at IS NULL\s*$/m.test(sqlSeen[0].split("ORDER BY")[0]),
    "must not FILTER tombstones out; that is the resurrection bug");
  assert.equal(await db.findByIdempotencyKey("ws-1", null), null);
});

// A1 added getOpenTasksBefore speculatively, for C2, with no callers. C2 measured it
// against a prod restore and it did not fit: `type='block' AND status='open'` returned
// 1576 rows where the lane shows 47, because itinerary completion writes the day_root
// _done overlay rather than the row's status, and because most of what it admitted was
// meetings. It is replaced by getCarryoverPool, pinned in open-tasks-query.test.js.
// This replaces a test that kept getOpenTasksBefore and idx_blocks_open byte-identical.
// That guard is genuinely gone rather than relocated, so rather than leave a marker
// that can only fail if someone re-adds dead code, it now holds the invariant that
// SURVIVED the removal: the index is orphaned and must not silently be treated as
// live cover for the replacement query.
test("idx_blocks_open no longer backs any query, and says so (C2)", async () => {
  const db = loadDbWithMock(makeMockPool());
  assert.equal(db.getOpenTasksBefore, undefined, "the speculative primitive must not linger as dead code");
  assert.equal(typeof db.getCarryoverPool, "function");

  const schema = require("node:fs").readFileSync(require.resolve("./pg-schema.js"), "utf8");
  const idx = schema.slice(schema.indexOf("idx_blocks_open") - 700, schema.indexOf("idx_blocks_open") + 400);
  assert.ok(!/db\.getOpenTasksBefore\)/.test(idx),
    "the index comment must not name a function this repo no longer has");
  assert.match(idx, /ORPHANED|A4/,
    "an index nothing references has to be labelled, or the next reader assumes it is load-bearing");
  // And the reason it cannot serve the replacement: that predicate has no status term.
  assert.match(idx, /COALESCE\(properties->>'status', 'open'\) = 'open'/);
});
