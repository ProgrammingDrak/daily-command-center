// P2 transaction hardening: proves db.js batchOp() is genuinely atomic — its
// update/delete/reorder branches run on the tx CLIENT (not the pool), wrapped
// by one BEGIN/COMMIT, and a mid-sequence throw ROLLBACKs with no partial
// state. Before this fix, updateBlock/deleteBlock/reorderBlocks hardcoded the
// pool, so those branches escaped the "transaction" entirely. routes/blocks.js
// apply-forward and task-menu delete both funnel their multi-writes through
// batchOp, so this is the atomicity guard for "no half-applied forward days"
// and "no menu deleted with dangling refs" too.
//
// Harness: inject a transaction-faithful mock pool into require.cache before
// loading db.js (same trick as budget-store.test.js). The client stages writes
// in an overlay Map and only merges them into the committed store on COMMIT;
// ROLLBACK discards the overlay — so "committed" reflects exactly what a real
// Postgres tx would leave behind.
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

function makeMockPool(initialRows = []) {
  const committed = new Map(initialRows.map((r) => [r.id, { ...r }]));
  const log = [];

  // staged: a Map overlay for a tx client; null for the pool (autocommit).
  function makeExec(tag, staged) {
    async function query(sql, params = []) {
      const text = String(sql).trim();
      log.push({ tag, text });
      if (text === "BEGIN") return { rows: [] };
      if (text === "COMMIT") {
        for (const [k, v] of staged) { if (v === null) committed.delete(k); else committed.set(k, v); }
        staged.clear();
        return { rows: [] };
      }
      if (text === "ROLLBACK") { staged.clear(); return { rows: [] }; }

      const keyOf = (r) => {
        const p = r && (typeof r.properties === "string" ? JSON.parse(r.properties) : r.properties);
        return (p && p.idempotency_key) || null;
      };
      const view = (id) => (staged && staged.has(id)) ? staged.get(id) : (committed.has(id) ? committed.get(id) : null);
      const put = (id, row) => { if (staged) staged.set(id, row); else if (row === null) committed.delete(id); else committed.set(id, row); };

      // C6c: createBlock asks for the day's next `sort_order` slot when the caller gives none.

      // Answered from the mock's own rows so the real max-then-round-up logic is exercised.

      if (/COALESCE\(MAX\(sort_order\), 0\) AS mx/.test(text)) {

        const _d = params[0], _ws = params[1];

        const _all = (typeof committed !== "undefined" ? [...committed.values()] : [])

          .concat(typeof staged !== "undefined" && staged ? [...staged.values()] : []);

        const _mx = _all.reduce((m, r) => {

          if (!r || r.deleted_at) return m;

          if ((r.date || null) !== (_d || null)) return m;

          if ((r.workspace_id || null) !== (_ws || null)) return m;

          const n = Number(r.sort_order);

          return Number.isFinite(n) && n > m ? n : m;

        }, 0);

        return { rows: [{ mx: _mx }] };

      }

      if (/^SELECT \* FROM blocks WHERE id/.test(text)) {
        const row = view(params[0]);
        // A3's createBlock fallback scopes its re-read by workspace, so the mock has to
        // model that predicate or a cross-workspace collision would look like a hit.
        if (/workspace_id IS NOT DISTINCT FROM/.test(text)) {
          const want = params[1] === undefined ? null : params[1];
          return { rows: row && (row.workspace_id || null) === (want || null) ? [{ ...row }] : [] };
        }
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/^SELECT \* FROM blocks\s+WHERE properties->>'idempotency_key'/.test(text)) {
        const all = [...committed.values(), ...(staged ? staged.values() : [])].filter(Boolean);
        const hits = all.filter(r => keyOf(r) === params[0] && (r.workspace_id || null) === (params[1] || null));
        const row = hits.find(r => !r.deleted_at) || hits[0];
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/^INSERT INTO blocks/.test(text)) {
        // pg-schema.js idx_blocks_idem_unique, modelled: a LIVE row already holding this
        // key raises 23505. Partial on `deleted_at IS NULL`, so a tombstone does not
        // reserve its key — which is why a resolved conflict is always a live row.
        const key = keyOf({ properties: params[4] });
        if (key) {
          // The index carries NULLS NOT DISTINCT, so a NULL workspace DOES collide with
          // another NULL workspace. Modelled explicitly because the default the other
          // way round is the trap: a plain multicolumn unique index treats NULLs as
          // distinct, and a fake that quietly assumed either behaviour would assert a
          // conflict Postgres may or may not raise.
          const wsEq = (a, b) => (a ?? null) === (b ?? null);
          const clash = [...committed.values(), ...(staged ? staged.values() : [])]
            .find(r => r && r.id !== params[0] && !r.deleted_at && keyOf(r) === key && wsEq(r.workspace_id, params[7]));
          if (clash) {
            const err = new Error('duplicate key value violates unique constraint "idx_blocks_idem_unique"');
            err.code = "23505";
            err.constraint = "idx_blocks_idem_unique";
            throw err;
          }
        }
        // ON CONFLICT (id) DO NOTHING RETURNING * — modelled properly, because getting
        // this wrong is invisible: a mock that returns no rows makes EVERY create look
        // like a conflict, so createBlock silently takes its fallback path on every
        // call and the suite still passes. Caught exactly that way.
        const conflict = /ON CONFLICT \(id\) DO NOTHING/.test(text) && view(params[0]) !== null;
        if (conflict) return { rows: [] };
        const created = {
          id: params[0], type: params[1], parent_id: params[2], date: params[3],
          properties: params[4], sort_order: params[5], user_id: params[6],
          workspace_id: params[7], created_at: params[8], updated_at: params[9], deleted_at: null,
        };
        put(params[0], created);
        return { rows: /RETURNING \*/.test(text) ? [{ ...created }] : [] };
      }
      // TWO different statements start this way and their params differ:
      //   deleteBlock   SET deleted_at = $1, updated_at = $2 WHERE id = $3
      //   undeleteBlock SET deleted_at = NULL, updated_at = $1 WHERE id = $2
      // Matching only the first shape made undelete a silent no-op in this fake, which
      // is why its 409 path looked untestable.
      if (/^UPDATE blocks SET deleted_at = NULL/.test(text)) {
        const id = params[1];
        const cur = view(id);
        if (cur) {
          // Clearing deleted_at moves the row INTO idx_blocks_idem_unique's partial
          // predicate, so a live row already holding the key raises here.
          const key = keyOf(cur);
          const clash = key && [...committed.values(), ...(staged ? staged.values() : [])]
            .find(r => r && r.id !== id && !r.deleted_at && keyOf(r) === key && (r.workspace_id ?? null) === (cur.workspace_id ?? null));
          if (clash) {
            const err = new Error('duplicate key value violates unique constraint "idx_blocks_idem_unique"');
            err.code = "23505";
            err.constraint = "idx_blocks_idem_unique";
            throw err;
          }
          put(id, { ...cur, deleted_at: null, updated_at: params[0] });
        }
        return { rows: [] };
      }
      if (/^UPDATE blocks SET deleted_at/.test(text)) {
        const cur = view(params[2]);
        if (cur) put(params[2], { ...cur, deleted_at: params[0], updated_at: params[1] });
        return { rows: [] };
      }
      if (/^UPDATE blocks SET properties/.test(text)) {
        const cur = view(params[5]);
        if (cur) put(params[5], { ...cur, properties: params[0], sort_order: params[1], parent_id: params[2], date: params[3], updated_at: params[4] });
        return { rows: [] };
      }
      if (/^UPDATE blocks SET sort_order/.test(text)) {
        const cur = view(params[2]);
        if (cur) put(params[2], { ...cur, sort_order: params[0], updated_at: params[1] });
        return { rows: [] };
      }
      if (/^INSERT INTO operations/.test(text)) return { rows: [] };
      throw new Error("Unhandled mock query: " + text.slice(0, 60));
    }
    return { query };
  }

  return {
    query: (sql, params) => makeExec("pool", null).query(sql, params),
    connect: async () => {
      const staged = new Map();
      const { query } = makeExec("client", staged);
      return { query, release() {} };
    },
    _committed: committed,
    _log: log,
  };
}

function row(id, name) {
  return { id, type: "block", parent_id: null, date: "2026-07-11", properties: { name }, sort_order: 0, created_at: "t0", updated_at: "t0", deleted_at: null };
}

test("batchOp: update + delete + create commit together, all on the tx client (never the pool)", async () => {
  const pool = makeMockPool([row("b1", "A"), row("b2", "B")]);
  const db = loadDbWithMock(pool);

  const res = await db.batchOp([
    { op: "update", id: "b1", properties: { name: "A2" } },
    { op: "delete", id: "b2" },
    { op: "create", type: "block", parent_id: null, date: "2026-07-11", properties: { name: "C" }, sort_order: 10, user_id: null, workspace_id: null, id: "b3" },
  ]);
  assert.equal(res.blocks.length, 3);

  // Committed store reflects every op.
  assert.equal(pool._committed.get("b1").properties.name, "A2");
  assert.ok(pool._committed.get("b2").deleted_at, "b2 soft-deleted");
  assert.equal(pool._committed.get("b3").properties.name, "C");

  // The whole batch ran on ONE client, wrapped by BEGIN..COMMIT, nothing on the pool.
  const client = pool._log.filter((l) => l.tag === "client");
  assert.equal(client[0].text, "BEGIN");
  assert.equal(client[client.length - 1].text, "COMMIT");
  assert.ok(client.some((l) => l.text.startsWith("UPDATE blocks SET properties")), "update ran on client");
  assert.ok(client.some((l) => l.text.startsWith("UPDATE blocks SET deleted_at")), "delete ran on client");
  assert.ok(!pool._log.some((l) => l.tag === "pool"), "no write escaped to the pool (the pre-fix bug)");
});

test("batchOp: reorder runs on the tx client too (client threaded through reorderBlocks)", async () => {
  const pool = makeMockPool([row("b1", "A"), row("b2", "B")]);
  const db = loadDbWithMock(pool);

  // Well-separated sort_orders => no collision => no rebalance SELECT, so this
  // isolates the client-threading of the plain reorder writes.
  await db.batchOp([
    { op: "reorder", items: [{ id: "b1", sort_order: 100 }, { id: "b2", sort_order: 200 }] },
  ]);
  assert.equal(pool._committed.get("b1").sort_order, 100);
  assert.equal(pool._committed.get("b2").sort_order, 200);

  const client = pool._log.filter((l) => l.tag === "client");
  assert.equal(client[0].text, "BEGIN");
  assert.ok(client.some((l) => l.text.startsWith("UPDATE blocks SET sort_order")), "reorder wrote on the client");
  assert.ok(client.some((l) => l.text === "COMMIT"));
  assert.ok(!pool._log.some((l) => l.tag === "pool"), "no reorder write escaped to the pool");
});

test("batchOp: a throw mid-sequence rolls everything back — no partial state", async () => {
  const pool = makeMockPool([row("b1", "A"), row("b2", "B")]);
  const db = loadDbWithMock(pool);

  await assert.rejects(
    () => db.batchOp([
      { op: "update", id: "b1", properties: { name: "A2" } }, // staged
      { op: "update", id: "ghost", properties: { name: "X" } }, // Block not found -> throws
      { op: "delete", id: "b2" }, // never reached
    ]),
    /Block not found/
  );

  // The earlier, "successful" update was staged then discarded on ROLLBACK.
  assert.equal(pool._committed.get("b1").properties.name, "A", "b1 unchanged");
  assert.ok(!pool._committed.get("b2").deleted_at, "b2 not deleted");
  const client = pool._log.filter((l) => l.tag === "client");
  assert.ok(client.some((l) => l.text === "ROLLBACK"), "rolled back");
  assert.ok(!client.some((l) => l.text === "COMMIT"), "never committed");
});

// ── A3: ON CONFLICT (id) DO NOTHING — the line B2 is waiting on ────────────────
//
// Until this landed, a create whose caller-minted id already existed raised 23505
// and aborted the caller's whole transaction. B2 makes the CLIENT mint block ids, so
// a WAL replay after a lost ack posts a create for a row the server already has —
// which is the normal case there, not an error case.

test("createBlock: replaying a create with the same id returns the existing row, no second insert", async () => {
  const pool = makeMockPool([]);
  const db = loadDbWithMock(pool);

  const first = await db.createBlock({ id: "client-minted-1", type: "block", date: "2026-07-11", properties: { name: "once" }, workspace_id: "ws-1" });
  const replay = await db.createBlock({ id: "client-minted-1", type: "block", date: "2026-07-11", properties: { name: "once" }, workspace_id: "ws-1" });

  assert.equal(first.id, "client-minted-1");
  assert.equal(replay.id, "client-minted-1", "the replay resolves to the SAME row, not a new uuid");
  assert.equal(pool._committed.size, 1, "exactly one row exists");

  // The op log must not claim a create that did not happen — this is what makes the
  // replay a genuine no-op rather than a silent duplicate in the audit trail.
  const opInserts = pool._log.filter((l) => l.text.startsWith("INSERT INTO operations"));
  assert.equal(opInserts.length, 1, "one create op logged across both calls");
});

test("createBlock: the DO NOTHING fallback is workspace-scoped — a foreign id 404s instead of leaking the row", async () => {
  // Raised by Track B against this exact line before it was written. DO NOTHING
  // returns no rows, so the fallback SELECT is what answers the request; written the
  // obvious way (WHERE id = $1) it turns the CREATE path into a cross-workspace READ,
  // and ids are guessable — day roots are literally `day-root-<workspace>-<date>`.
  const foreign = { ...row("day-root-ws-victim-2026-07-11", "victim's day"), workspace_id: "ws-victim" };
  const pool = makeMockPool([foreign]);
  const db = loadDbWithMock(pool);

  await assert.rejects(
    () => db.createBlock({ id: "day-root-ws-victim-2026-07-11", type: "block", date: "2026-07-11", properties: { name: "mine" }, workspace_id: "ws-attacker" }),
    (err) => {
      assert.match(String(err.message), /Block not found/, "404-shaped, matching assertBlockOwnership — a 409 would confirm the id exists");
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  assert.equal(pool._committed.get("day-root-ws-victim-2026-07-11").properties.name, "victim's day", "the foreign row is untouched");
});

test("createBlock: a conflicting create inside a batch does NOT abort the transaction", async () => {
  // The whole point for B2: before ON CONFLICT, one already-present id in a replayed
  // batch raised 23505 and took every sibling op down with it.
  const pool = makeMockPool([row("already-here", "existing")]);
  const db = loadDbWithMock(pool);

  const res = await db.batchOp([
    { op: "create", type: "block", date: "2026-07-11", properties: { name: "dup" }, id: "already-here", workspace_id: null },
    { op: "create", type: "block", date: "2026-07-11", properties: { name: "fresh" }, id: "brand-new", workspace_id: null },
  ]);

  assert.equal(res.blocks.length, 2);
  assert.equal(res.blocks[0].properties.name, "existing", "the conflicting create resolved to the row on disk");
  assert.equal(res.blocks[0]._resolvedExisting, true, "flagged — routes/blocks.js rowAt() branches on exactly this field");
  assert.equal(pool._committed.get("brand-new").properties.name, "fresh", "its sibling still committed");
  const client = pool._log.filter((l) => l.tag === "client");
  assert.ok(client.some((l) => l.text === "COMMIT"), "committed rather than rolled back");
});

// ── A3: the unique idempotency index, resolved at the primitive ────────────────
//
// Four routes create keyed rows and every one already looks the key up first, so the
// only way to reach a 23505 is losing the narrow race between that lookup and the
// insert. Resolving it in createBlock covers all four (and anything added later)
// instead of four copies of the same catch.

test("createBlock: an idempotency conflict OUTSIDE a transaction resolves to the live winner", async () => {
  const winner = { ...row("winner", "Won the race"), workspace_id: "ws-1", properties: { name: "Won the race", idempotency_key: "k1" } };
  const pool = makeMockPool([winner]);
  const db = loadDbWithMock(pool);

  const res = await db.createBlock({ type: "block", date: "2026-07-11", properties: { name: "loser", idempotency_key: "k1" }, workspace_id: "ws-1" });

  assert.equal(res.id, "winner", "the caller gets the row that won, not an error");
  assert.equal(res._resolvedExisting, true, "flagged, so the caller does not broadcast a create or award points for it");
  assert.equal(pool._committed.size, 1, "the loser planted nothing");
});

test("createBlock: the same conflict INSIDE a transaction rethrows — recovery is the caller's", async () => {
  // The error has already aborted the tx, so no further query on that client can
  // succeed. routes/blocks.js /batch re-resolves and re-runs the whole batch instead.
  const winner = { ...row("winner", "Won"), workspace_id: "ws-1", properties: { name: "Won", idempotency_key: "k2" } };
  const pool = makeMockPool([winner]);
  const db = loadDbWithMock(pool);

  await assert.rejects(
    () => db.batchOp([{ op: "create", type: "block", date: "2026-07-11", properties: { name: "loser", idempotency_key: "k2" }, workspace_id: "ws-1" }]),
    (err) => { assert.equal(err.code, "23505"); assert.equal(err.constraint, "idx_blocks_idem_unique"); return true; }
  );
  const client = pool._log.filter((l) => l.tag === "client");
  assert.ok(client.some((l) => l.text === "ROLLBACK"), "rolled back, so the retry starts from a clean slate");
});

test("createBlock: a tombstone does NOT reserve its key — the index is live-only", async () => {
  // The half the index deliberately does not enforce. Refusing to resurrect is the
  // route layer's rule (lib/materialize-guard.js); at this level the insert succeeds.
  const dead = { ...row("dead", "Removed"), workspace_id: "ws-1", deleted_at: "2026-07-10T00:00:00Z", properties: { name: "Removed", idempotency_key: "k3" } };
  const pool = makeMockPool([dead]);
  const db = loadDbWithMock(pool);

  const res = await db.createBlock({ type: "block", date: "2026-07-11", properties: { name: "fresh", idempotency_key: "k3" }, workspace_id: "ws-1" });
  assert.ok(!res._resolvedExisting, "a new row, not a resolved conflict");
  assert.equal(pool._committed.size, 2);
});

test("createBlock: a conflict whose winner vanishes before the re-read rethrows rather than looping", async () => {
  // db.createBlock resolves a 23505 by re-reading the key — but the winner can be
  // deleted between the conflict and that read. `if (!winner) throw err` is the only
  // thing between that state and a caller retrying forever against a key that resolves
  // to nothing.
  const winner = { ...row("winner", "Won"), workspace_id: "ws-1", properties: { name: "Won", idempotency_key: "k4" } };
  const pool = makeMockPool([winner]);
  const db = loadDbWithMock(pool);
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    // The conflict fires, then the winner disappears before the resolver looks.
    if (/^SELECT \* FROM blocks\s+WHERE properties->>'idempotency_key'/.test(String(sql).trim())) return { rows: [] };
    return realQuery(sql, params);
  };

  await assert.rejects(
    () => db.createBlock({ type: "block", date: "2026-07-11", properties: { name: "loser", idempotency_key: "k4" }, workspace_id: "ws-1" }),
    (err) => { assert.equal(err.code, "23505"); return true; }
  );
});

test("createBlock: a NULL-workspace key collides too — the index is NULLS NOT DISTINCT", async () => {
  // The clause pg-schema.js adds, and the reader half it exists to agree with. A
  // multicolumn unique index treats NULLs as DISTINCT by default, so without
  // NULLS NOT DISTINCT these two rows both insert and the write side disagrees with
  // findByIdempotencyKey's `workspace_id IS NOT DISTINCT FROM $2` and admin-model's
  // GROUP BY, either of which would then report "enforced" over a live duplicate.
  // blocks.workspace_id is nullable and createBlock passes `workspace_id || null`, so
  // this group is reachable.
  const winner = { ...row("winner", "Won"), workspace_id: null, properties: { name: "Won", idempotency_key: "k-null" } };
  const pool = makeMockPool([winner]);
  const db = loadDbWithMock(pool);

  const res = await db.createBlock({ type: "block", date: "2026-07-11", properties: { name: "loser", idempotency_key: "k-null" } });
  assert.equal(res.id, "winner", "two NULL workspaces are the SAME tenant to this index");
  assert.equal(res._resolvedExisting, true);
  assert.equal(pool._committed.size, 1);
});

test("undeleteBlock: 409, not 500, when a live row already holds the key", async () => {
  // Clearing deleted_at moves the row INTO idx_blocks_idem_unique's partial predicate.
  // route() maps an unclassified throw to 500, so without the catch a legitimate undo
  // failure is indistinguishable from a server fault — and B2 is about to wire this
  // route to the undo button. The prod restore's 32 duplicate key groups are all
  // exactly this shape (a live row plus tombstones).
  const dead = { ...row("dead", "Removed"), workspace_id: "ws-1", deleted_at: "2026-07-28T00:00:00Z", properties: { name: "Removed", idempotency_key: "k-occupied" } };
  const live = { ...row("live", "Here"), workspace_id: "ws-1", properties: { name: "Here", idempotency_key: "k-occupied" } };
  const pool = makeMockPool([dead, live]);
  const db = loadDbWithMock(pool);

  await assert.rejects(
    () => db.undeleteBlock("dead"),
    (err) => {
      assert.equal(err.statusCode, 409, "not an unclassified throw, which route() would map to 500");
      assert.match(err.message, /already holds this idempotency key/);
      return true;
    }
  );
  assert.ok(pool._committed.get("dead").deleted_at, "the tombstone is still a tombstone");
});
