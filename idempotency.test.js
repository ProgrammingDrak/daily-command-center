// A3: the generic create paths honor an idempotency key.
//
// POST /api/blocks and POST /api/blocks/batch were the last create paths with no
// idempotency handling at all — routes/dcc.js honors a key on all three of its
// writers, and these two would mint a second row for a request the server had already
// committed. /batch matters most: B1 (#256) made it the client's canonical write
// route, so a lost ack replays the whole batch through the WAL.
//
// Same harness as delete-contract.test.js / blocks-batch-authz.test.js — routes/blocks.js
// is an (app, ctx) factory, so it mounts on a bare express app with fake stores.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";
const TOMB = "2026-07-29T10:00:00Z";

// The real db.js error for a violation of pg-schema.js's idx_blocks_idem_unique.
// Verified against Postgres 17.6: a bare CREATE UNIQUE INDEX (no table constraint
// behind it) still reports the index name in err.constraint, which is what
// db.isIdempotencyConflict matches on.
function idemConflict() {
  const err = new Error('duplicate key value violates unique constraint "idx_blocks_idem_unique"');
  err.code = "23505";
  err.constraint = "idx_blocks_idem_unique";
  return err;
}

function mountApp({ seed = {}, onCreate = null, serviceAuth = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = MINE;
    req.session = { userId: 1 };
    // server.js lets a `scope: "sweep"` service token reach POST /api/blocks and
    // nothing else, stamping req.dccServiceAuth. Modelled so the scope gate can be
    // exercised — it is the only caller class that is not a full session.
    if (serviceAuth) req.dccServiceAuth = { userId: 1, workspaceId: MINE, source: "sweep-suite" };
    next();
  });

  const blocks = { ...seed };
  const calls = { created: [], batches: [] };
  const broadcasts = [];
  let n = 0;

  const keyOf = (row) => (row.properties || {}).idempotency_key || null;

  function insert(item) {
    // db.createBlock's ON CONFLICT (id) DO NOTHING: a caller-minted id that already
    // exists resolves to the row on disk instead of inserting. Modelled here because
    // it is the path B2's replayed client ids take, and a fake that overwrote silently
    // would make that whole branch untestable.
    if (item.id && blocks[item.id]) {
      const found = blocks[item.id];
      // The real fallback re-reads WHERE id = $1 AND workspace_id IS NOT DISTINCT FROM $2
      // and 404s otherwise — model the scoping, or this fake is more permissive than the
      // code it stands in for and a route-layer regression would be invisible here.
      if ((found.workspace_id || null) !== (item.workspace_id || MINE)) {
        const err = new Error("Block not found"); err.statusCode = 404; throw err;
      }
      return { ...found, _resolvedExisting: true };
    }
    n += 1;
    const id = item.id || `made-${n}`;
    const props = typeof item.properties === "string" ? JSON.parse(item.properties) : (item.properties || {});
    const row = { id, type: item.type || "block", date: item.date || null, workspace_id: item.workspace_id || MINE, properties: props, deleted_at: null };
    blocks[id] = row;
    calls.created.push(row);
    return row;
  }

  const ctx = {
    blockDB: {
      // Live-first, tombstone-inclusive, date-blind — db.js findByIdempotencyKey's
      // actual contract, which lib/materialize-guard.js delegates to.
      findByIdempotencyKey: async (workspaceId, key) => {
        const hits = Object.values(blocks).filter(b => keyOf(b) === key && (b.workspace_id || null) === (workspaceId || null));
        return hits.find(b => !b.deleted_at) || hits[0] || null;
      },
      isIdempotencyConflict: (err) => !!(err && err.code === "23505" && err.constraint === "idx_blocks_idem_unique"),
      createBlock: async (item) => {
        // onCreate(op, blocks) may return an error to raise INSTEAD of inserting, and
        // may seed `blocks` first — which is how a concurrent winner is modelled: the
        // row appears only in the window between our lookup and our insert.
        if (onCreate) {
          const forced = onCreate(item, blocks);
          if (forced) {
            // FAITHFUL to db.js createBlock: OUTSIDE a transaction it resolves an
            // idempotency conflict itself and returns the live winner tagged
            // `_resolvedExisting`. Modelling it as a bare throw would test a recovery path the
            // real code no longer takes.
            const props = typeof item.properties === "string" ? JSON.parse(item.properties) : (item.properties || {});
            const winner = forced.constraint === "idx_blocks_idem_unique"
              ? Object.values(blocks).find(b => keyOf(b) === props.idempotency_key && !b.deleted_at)
              : null;
            if (!winner) throw forced;
            return { ...winner, _resolvedExisting: true };
          }
        }
        return insert(item);
      },
      batchOp: async (ops) => {
        calls.batches.push(ops);
        if (onCreate) {
          // Real batchOp is transactional: a throw rolls back everything, so the fake
          // raises BEFORE inserting anything rather than part-way through.
          for (const op of ops) {
            if (op.op !== "create") continue;
            const forced = onCreate(op, blocks);
            if (forced) throw forced;
          }
        }
        return { batchId: "b", blocks: ops.map(op => op.op === "create" ? insert(op) : { reordered: 1 }) };
      },
      getBlockIncludingDeleted: async (id) => blocks[id] || null,
      getBlock: async (id) => blocks[id] || null,
      getChildren: async () => [],
      reorderBlocks: async () => {},
      getBlocksByDate: async () => [],
      // `_appearedLate` rows are invisible to the day load but visible to the key
      // lookup — that IS the race: the winner commits after the check-then-act guard
      // has already read the day, so only the index can catch it.
      getBlocksByDateIncludingDeleted: async (date, workspaceId) => Object.values(blocks).filter(b => b.date === date && b.workspace_id === workspaceId && !b._appearedLate),
      createItineraryTask: async (b) => insert(b),
      // Atomic, and capable of raising: the real primitive runs one transaction, so a
      // conflicting item must leave NOTHING behind — the property the task-group
      // recovery branch depends on.
      createItineraryTasks: async (items) => {
        for (const it of items) {
          const k = (it.properties || {}).idempotency_key;
          if (k && Object.values(blocks).some(b => !b.deleted_at && keyOf(b) === k)) throw idemConflict();
        }
        return items.map(insert);
      },
      getBlocksByTypes: async () => [],
      getDelegatedItems: async () => [],
      getUndatedTaskBlocks: async () => [],
      getBlocksByDateRange: async () => [],
      getResponsibilityBlocks: async () => [],
      getBlocksByKind: async () => [],
    },
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: (b) => b,
    getScheduleBlocks: async () => [],
    getTodayStr: () => "2026-07-30",
    // VERBATIM from server.js — a stub returning true would make the scope test pass
    // no matter what the route does.
    isAllowedSweepBlockItem: (it) => { const p = it && it.properties; return !!(it && it.type === "block" && p && p.kind === "sweep_suite_task"); },
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")),
    pool: { query: async () => ({ rows: [{ workspace_id: MINE, user_id: 1 }] }) },
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, blocks, calls, broadcasts };
}

async function call(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await resp.json(); } catch { /* empty body */ }
    return { status: resp.status, json };
  } finally { server.close(); }
}

const item = (key, title = "Thing") => ({ type: "block", date: "2026-07-30", properties: key ? { title, idempotency_key: key } : { title } });

// ── POST /api/blocks ──────────────────────────────────────────────────────────

test("POST /api/blocks: a repeated key returns the SAME row and creates nothing", async () => {
  const { app, calls } = mountApp();
  const first = await call(app, "POST", "/api/blocks", item("agent-retry-1"));
  const again = await call(app, "POST", "/api/blocks", item("agent-retry-1"));

  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.json.id, first.json.id, "the retry resolves to the row the first attempt committed");
  assert.equal(again.json._dedupe, "skipped_duplicate");
  assert.equal(calls.created.length, 1, "exactly one row exists");
});

test("★ POST /api/blocks: a key matching only a TOMBSTONE still CREATES — this is undo", async () => {
  // The regression this route must not have. public/js/state.js undoDeleteTask replays
  // a deleted subtree as `{op:"create", ..., properties: r.properties}` — the original
  // properties bag, idempotency_key included. If a tombstone match skipped the create,
  // the lookup would find the tombstone OF THE VERY ROW BEING RESTORED and undo would
  // silently restore nothing, for every task carrying a key (199 of 3,106 rows on the
  // prod restore).
  //
  // The no-resurrect rule still governs the AGENT writers (routes/dcc.js, the
  // materializers, the task-group guard) — see the tombstone tests in
  // delete-contract.test.js. It does not govern the human client's own write path.
  const seed = { "dead-1": { id: "dead-1", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: TOMB, properties: { title: "Removed", idempotency_key: "slack-bookmark:C1:1.0" } } };
  const { app, calls } = mountApp({ seed });
  const { status, json } = await call(app, "POST", "/api/blocks", item("slack-bookmark:C1:1.0"));

  assert.equal(status, 200);
  assert.equal(calls.created.length, 1, "the restore lands");
  assert.notEqual(json.id, "dead-1", "a new live row, not the tombstone handed back");
  assert.equal(json._dedupe, undefined, "nothing was deduped");
});

test("POST /api/blocks: no key means no change — this is inert for every client create today", async () => {
  const { app, calls } = mountApp();
  await call(app, "POST", "/api/blocks", item(null));
  await call(app, "POST", "/api/blocks", item(null));
  assert.equal(calls.created.length, 2, "two keyless creates are two rows, exactly as before A3");
});

test("POST /api/blocks: one request carrying the same key twice creates one row", async () => {
  const { app, calls } = mountApp();
  const { json } = await call(app, "POST", "/api/blocks", [item("dup-in-payload"), item("dup-in-payload")]);
  assert.equal(json.length, 2, "the response still answers item-for-item");
  assert.equal(json[0].id, json[1].id);
  assert.equal(json[1]._dedupe, "skipped_duplicate");
  assert.equal(calls.created.length, 1);
});

test("POST /api/blocks: the broadcast carries only ids this request actually created", async () => {
  // Announcing a "create" for a deduped row makes every other tab re-fetch a row that
  // did not change, and on a replay storm that is a re-fetch per attempt.
  const seed = { "live-dup": { id: "live-dup", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: null, properties: { title: "Already here", idempotency_key: "sweep:42" } } };
  const { app, broadcasts } = mountApp({ seed });

  await call(app, "POST", "/api/blocks", item("sweep:42"));
  assert.equal(broadcasts.length, 0, "an all-deduped request broadcasts nothing at all");

  await call(app, "POST", "/api/blocks", [item("sweep:42"), item("fresh-key")]);
  const created = broadcasts.filter(b => b.payload.action === "create");
  assert.equal(created.length, 1);
  assert.equal(created[0].payload.blockIds.length, 1, "only the genuinely new row is announced");
});

// A concurrent winner: the key is absent when the route looks it up, and present by
// the time the insert runs. That interleaving is the ONLY thing the unique index
// catches that the route-level lookup cannot, so it is the thing worth modelling.
function racingWinner(id, key) {
  return (op, blocks) => {
    if (blocks[id]) return null;   // already lost once; let the retry through
    blocks[id] = { id, type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: null, properties: { title: "Won the race", idempotency_key: key || (op.properties || {}).idempotency_key } };
    return idemConflict();
  };
}

test("POST /api/blocks: a concurrent writer that wins the index is answered, not 500'd", async () => {
  const { app, calls } = mountApp({ onCreate: racingWinner("winner-1", "racy") });
  const { status, json } = await call(app, "POST", "/api/blocks", item("racy"));

  assert.equal(status, 200, "not a 500 — the API has a defined answer for this");
  assert.equal(json.id, "winner-1", "we hand back the row the winner committed");
  assert.equal(json._dedupe, "skipped_duplicate");
  assert.equal(calls.created.length, 0, "we planted nothing");
});

// ── POST /api/blocks/batch ────────────────────────────────────────────────────

test("batch: a replayed create dedupes and the results stay aligned with the operations", async () => {
  // result.blocks[i] must still answer operations[i]. Deduped creates are removed from
  // the ops handed to batchOp and spliced back at their original index — get that
  // wrong and every caller pairing the two arrays reads the wrong row.
  const { app, calls } = mountApp();
  const ops = [
    { op: "create", ...item("wal-a", "A") },
    { op: "create", ...item("wal-b", "B") },
  ];
  const first = await call(app, "POST", "/api/blocks/batch", { operations: ops });
  assert.equal(first.json.blocks.length, 2);

  const replay = await call(app, "POST", "/api/blocks/batch", { operations: ops });
  assert.equal(replay.json.blocks.length, 2, "same shape as the original");
  assert.equal(replay.json.blocks[0].properties.title, "A", "index 0 still answers operations[0]");
  assert.equal(replay.json.blocks[1].properties.title, "B", "index 1 still answers operations[1]");
  assert.equal(replay.json.blocks[0]._dedupe, "skipped_duplicate");
  assert.equal(calls.created.length, 2, "the replay minted nothing");
});

test("batch: a mixed replay keeps non-create ops in position", async () => {
  const seed = { "live-1": { id: "live-1", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: null, properties: { title: "Existing" } } };
  const { app } = mountApp({ seed });
  const ops = [
    { op: "create", ...item("mixed-a", "A") },
    { op: "reorder", items: [{ id: "live-1", sort_order: 10 }] },
    { op: "create", ...item("mixed-b", "B") },
  ];
  await call(app, "POST", "/api/blocks/batch", { operations: ops });
  const { json } = await call(app, "POST", "/api/blocks/batch", { operations: ops });

  assert.equal(json.blocks.length, 3);
  assert.equal(json.blocks[0]._dedupe, "skipped_duplicate");
  assert.ok(json.blocks[1].reordered, "the reorder is still at index 1, not shifted up by the dropped creates");
  assert.equal(json.blocks[2]._dedupe, "skipped_duplicate");
});

test("batch: the same key twice inside ONE batch creates one row and echoes it", async () => {
  // This one cannot be answered by a lookup — the row does not exist yet. Letting both
  // run would put two rows with one key inside a single transaction, where the index
  // conflict is unrecoverable: the retry re-reads the same uncommitted nothing and loops.
  const { app, calls } = mountApp();
  const { json } = await call(app, "POST", "/api/blocks/batch", {
    operations: [{ op: "create", ...item("same-key") }, { op: "create", ...item("same-key") }],
  });
  assert.equal(json.blocks.length, 2);
  assert.equal(json.blocks[0].id, json.blocks[1].id);
  assert.equal(json.blocks[1]._dedupe, "skipped_duplicate");
  assert.equal(calls.created.length, 1);
});

test("batch: an index conflict is retried exactly once, against the now-visible winner", async () => {
  const { app, calls } = mountApp({ onCreate: racingWinner("race-winner", "batch-race") });
  const { status, json } = await call(app, "POST", "/api/blocks/batch", {
    operations: [{ op: "create", ...item("batch-race") }],
  });

  assert.equal(status, 200, "the retry resolved it — no 500 leaked out");
  assert.equal(json.blocks[0].id, "race-winner");
  assert.equal(json.blocks[0]._dedupe, "skipped_duplicate");
  assert.equal(calls.created.length, 0, "the losing batch rolled back to nothing, not part-way");
  assert.equal(calls.batches.length, 1, "the retry deduped at the lookup, so batchOp ran only for the first attempt");
});

test("batch: an error that is NOT an idempotency conflict still propagates", async () => {
  // The retry is scoped to one narrow race. Swallowing anything else would turn a real
  // failure into a silent second attempt.
  const boom = Object.assign(new Error("connection terminated"), { code: "57P01" });
  const { app } = mountApp({ onCreate: () => boom });
  const { status } = await call(app, "POST", "/api/blocks/batch", {
    operations: [{ op: "create", ...item("whatever") }],
  });
  assert.equal(status, 500);
});

// ── Task groups: added scope (c), in the shape that can actually work ─────────

test("task groups: each item carries a (group, date, index) key, and force clears them", async () => {
  // A unique index on (workspace_id, date, taskGroupId) — the shape A3 inherited —
  // CANNOT work: taskGroupId is stamped on every item a group mints, so a two-item
  // group would collide with itself on an empty database. (group, date, item index)
  // is the tuple that is genuinely unique per row.
  const seed = {
    "grp-1": { id: "grp-1", type: "block", date: null, workspace_id: MINE, deleted_at: null, properties: {
      kind: "task_group", title: "Morning routine",
      items: [{ title: "Inbox zero", duration: 30 }, { title: "Standup prep", duration: 15 }],
    } },
  };
  const { app, calls } = mountApp({ seed });
  await call(app, "POST", "/api/task-groups/grp-1/schedule", { date: "2026-07-30" });
  assert.deepEqual(
    calls.created.map(r => r.properties.idempotency_key),
    ["tg:grp-1:2026-07-30:0", "tg:grp-1:2026-07-30:1"],
    "per-item, so the group's own members never collide with each other"
  );

  // force is the deliberate re-add. A deterministic key would refuse the exact thing
  // the flag exists to permit, so those rows stay unkeyed.
  const { app: app2, calls: calls2 } = mountApp({ seed });
  await call(app2, "POST", "/api/task-groups/grp-1/schedule", { date: "2026-07-30", force: true });
  assert.deepEqual(calls2.created.map(r => r.properties.idempotency_key), [undefined, undefined]);
});

// ── routes/dcc.js: the three writers that already had keys ────────────────────
//
// These did not need A3 to become idempotent — they have looked their key up since
// #253. What they needed was to survive the constraint A3 put underneath them: a
// concurrent writer winning the key now raises 23505 where it used to just make a
// duplicate. db.createBlock absorbs that and hands back the live winner tagged
// `_resolvedExisting`; these routes have to take the same branch the lookup would have.

function mountDcc({ rows = [], dedupeCreate = null } = {}) {
  const app = express();
  app.use(express.json());
  const created = [];
  const credits = [];
  const broadcasts = [];

  const ctx = {
    DAY_STATE_FILE: "/dev/null/day-state.json",
    DATA_DIR: "/dev/null",
    addMinutesHHMM: (hhmm, mins) => {
      const [h, m] = hhmm.split(":").map(Number);
      const t = h * 60 + m + mins;
      return String(Math.floor(t / 60) % 24).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
    },
    blockDB: {
      findByIdempotencyKey: async (workspaceId, key) => {
        const hits = rows.filter(r => (r.properties || {}).idempotency_key === key && r.workspace_id === workspaceId);
        return hits.find(r => !r.deleted_at) || hits[0] || null;
      },
      getBlocksByDateIncludingDeleted: async () => rows,
      // `dedupeCreate` stands in for db.createBlock losing the race: it returns the
      // live winner tagged `_resolvedExisting` instead of the row it was asked to insert.
      createItineraryTask: async (b) => {
        if (dedupeCreate) return { ...dedupeCreate, _resolvedExisting: true };
        created.push(b);
        return { id: "created-" + created.length, ...b };
      },
      saveDccState: async () => {},
    },
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    buildSkeletonState: (d) => ({ date: d }),
    getDayFilePath: (d) => `/dev/null/${d}.json`,
    getTodayStr: () => "2026-07-30",
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")),
    meetingIdentity: (m) => m && m.id,
    meetingMaterializer: { materializeMeetings: async () => ({ created: 0, updated: 0, cancelled: 0, blockIds: [] }) },
    previousDateStr: (d) => d,
    readJSON: (_p, fallback) => (fallback === null ? null : (fallback || {})),
    resolveOwnerLenient: () => ({ userId: 1, workspaceId: MINE }),
    resolveOwnerStrict: async () => ({ userId: 1, workspaceId: MINE }),
    slotStore: { earnTaskCredit: async (_ws, _u, payload) => { credits.push(payload); return { awarded: true, credits: 10 }; } },
    writeJSON: () => {},
  };
  require("./routes/dcc.js")(app, ctx);
  return { app, created, credits, broadcasts };
}

test("quick-task: a lost key race reports skipped_duplicate, not a 500 and not a lie", async () => {
  // Before A3 this produced a second task. With the index and no handling it would be
  // a 500 on a double-click. It is the MCP/CLI retry shape too: those now mint one key
  // before the retry loop, so a timeout retry can overlap the request the server is
  // still committing.
  const winner = { id: "winner-qt", date: "2026-07-30", deleted_at: null, properties: { title: "Won" } };
  const { app, created } = mountDcc({ dedupeCreate: winner });
  const { status, json } = await call(app, "POST", "/api/dcc/quick-task", { title: "Standup", date: "2026-07-30", idempotency_key: "mcp-schedule:abc" });

  assert.equal(status, 200);
  assert.equal(json.status, "skipped_duplicate", "the same verdict the lookup would have given");
  assert.equal(json.block.id, "winner-qt");
  assert.equal(created.length, 0);
});

test("brief/log-done: a lost key race follows the WINNER's date into the ledger key", async () => {
  // The double-credit trap A2 documented, reached through the race instead of the
  // lookup: keying the ledger to the POSTED date would mint a second credit row for a
  // block already credited under its own date.
  const winner = { id: "winner-ld", date: "2026-07-28", deleted_at: null, properties: { title: "Won" } };
  const { app, credits } = mountDcc({ dedupeCreate: winner });
  const { status, json } = await call(app, "POST", "/api/dcc/brief/log-done", { title: "Ship it", date: "2026-07-30", idempotency_key: "day-review:2026-07-30:x" });

  assert.equal(status, 200);
  assert.equal(json.status, "skipped_duplicate");
  assert.equal(credits.length, 1);
  assert.equal(credits[0].source_key, "2026-07-28:winner-ld", "keyed to the row's own day, not the posted one");
});

test("brief/push-next: a lost key race reports skipped_duplicate", async () => {
  const winner = { id: "winner-pn", date: "2026-07-31", deleted_at: null, properties: { title: "Won" } };
  const { app, created } = mountDcc({ dedupeCreate: winner });
  const { json } = await call(app, "POST", "/api/dcc/brief/push-next", { title: "Tomorrow", date: "2026-07-31", idempotency_key: "day-review-followup:2026-07-31:y" });
  assert.equal(json.status, "skipped_duplicate");
  assert.equal(json.block.id, "winner-pn");
  assert.equal(created.length, 0);
});

// ── Scope: a dedupe answer is a row the caller did not supply ─────────────────

const sweepItem = (key) => ({ type: "block", properties: { kind: "sweep_suite_task", title: "Sweep thing", idempotency_key: key } });
const foreignRow = (key, kind) => ({ id: "not-yours", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: null,
  properties: { kind, title: "Private meeting notes", notes: "salary numbers", idempotency_key: key } });

test("service token: honoring a key must not read back a row outside the token's scope", async () => {
  // POST /api/blocks is one of the few endpoints a write-only Sweep Suite token can
  // reach, and its scope gate validates the item being CREATED. Dedupe returns a row
  // the caller never supplied, so without a second check the token becomes an
  // arbitrary reader: guess a key, get the row. Several vocabularies are guessable —
  // `slack-bookmark:<channel>:<ts>` is readable off any Slack message.
  const seed = { "not-yours": foreignRow("slack-bookmark:C0123:1753900000.001", "task") };
  const { app } = mountApp({ seed, serviceAuth: true });
  const { status, json } = await call(app, "POST", "/api/blocks", sweepItem("slack-bookmark:C0123:1753900000.001"));

  assert.equal(status, 404, "404 not 403 — that the key exists is the fact being withheld");
  assert.equal(json.error, "Block not found");
  assert.ok(!JSON.stringify(json).includes("salary"), "no row content leaks in the refusal");
});

test("service token: a dedupe hit INSIDE its scope still answers normally", async () => {
  // The guard must refuse the out-of-scope read without breaking the legitimate case
  // the key exists for: a Sweep Suite retry landing on its own earlier row.
  const seed = { "own-row": { ...foreignRow("sweep:own", "sweep_suite_task"), id: "own-row" } };
  const { app } = mountApp({ seed, serviceAuth: true });
  const { status, json } = await call(app, "POST", "/api/blocks", sweepItem("sweep:own"));

  assert.equal(status, 200);
  assert.equal(json.id, "own-row");
  assert.equal(json._dedupe, "skipped_duplicate");
});

test("session caller: the scope guard does not apply", async () => {
  // A real session already passes assertBlockOwnership on the workspace; the scope
  // gate is specifically about a token that may only write one kind of row.
  const seed = { "not-yours": foreignRow("k-any", "task") };
  const { app } = mountApp({ seed });
  const { status, json } = await call(app, "POST", "/api/blocks", { type: "block", properties: { title: "x", idempotency_key: "k-any" } });
  assert.equal(status, 200);
  assert.equal(json.id, "not-yours");
  assert.equal(json._dedupe, "skipped_duplicate");
});

// ── Gaps the fakes previously could not reach ─────────────────────────────────

test("batch: a replayed CLIENT-MINTED id normalizes to the same _dedupe verdict as a key match", async () => {
  // B2 makes the client mint block ids, so a WAL replay posts creates for rows the
  // server already has. db.createBlock's ON CONFLICT (id) path returns the existing row
  // tagged `_resolvedExisting`; runBatch has to translate that into the same wire
  // vocabulary a key match produces, or B2 gets two spellings of one outcome.
  const { app, calls } = mountApp();
  const op = { op: "create", id: "client-minted-1", type: "block", date: "2026-07-30", properties: { title: "minted" } };
  await call(app, "POST", "/api/blocks/batch", { operations: [op] });
  const { json } = await call(app, "POST", "/api/blocks/batch", { operations: [op] });

  assert.equal(json.blocks[0].id, "client-minted-1");
  assert.equal(json.blocks[0]._dedupe, "skipped_duplicate");
  assert.equal(json.blocks[0]._resolvedExisting, undefined, "the internal flag is stripped, not forwarded to the client");
  assert.equal(calls.created.length, 1);
});

test("batch: a conflict that persists through the retry surfaces instead of spinning", async () => {
  // The retry is deliberately ONE attempt. Without this, turning it into a loop — or
  // removing the bound — passes every other test in the file.
  const { app, calls } = mountApp({ onCreate: () => idemConflict() });   // no winner is ever planted
  const { status } = await call(app, "POST", "/api/blocks/batch", { operations: [{ op: "create", ...item("never-resolves") }] });

  assert.equal(status, 500, "an unresolvable conflict surfaces");
  assert.equal(calls.batches.length, 2, "one retry, not a loop");
});

test("a key owned by ANOTHER workspace does not dedupe", async () => {
  // The index is (workspace_id, key) and findByIdempotencyKey scopes the same way. If
  // either side dropped the tenant, one workspace could block another's key.
  const seed = { "theirs": { id: "theirs", type: "block", date: "2026-07-30", workspace_id: "ws-other", deleted_at: null, properties: { title: "Theirs", idempotency_key: "shared-key" } } };
  const { app, calls } = mountApp({ seed });
  const { json } = await call(app, "POST", "/api/blocks", item("shared-key"));

  assert.notEqual(json.id, "theirs");
  assert.equal(json._dedupe, undefined);
  assert.equal(calls.created.length, 1, "our create lands; their row is not our match");
});

test("task groups: a lost race rolls the whole group back and answers with the winner", async () => {
  // The recovery branch: db.createItineraryTasks is one transaction, so the loser
  // plants nothing and gets the established `{created: [], duplicate, deleted, task}`
  // shape back — the same shape the check-then-act guard returns, so the client's
  // re-add flow does not need a second case.
  const seed = {
    "grp-1": { id: "grp-1", type: "block", date: null, workspace_id: MINE, deleted_at: null, properties: {
      kind: "task_group", title: "Morning routine",
      items: [{ title: "Inbox zero", duration: 30 }, { title: "Standup prep", duration: 15 }],
    } },
    // The concurrent winner: item 0 of the same group, same day, already committed.
    "winner-0": { id: "winner-0", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: null, _appearedLate: true,
      properties: { title: "Inbox zero", taskGroupId: "grp-1", idempotency_key: "tg:grp-1:2026-07-30:0" } },
  };
  const { app, calls } = mountApp({ seed });
  const { status, json } = await call(app, "POST", "/api/task-groups/grp-1/schedule", { date: "2026-07-30" });

  assert.equal(status, 200, "not a 500 — the route has a defined answer");
  assert.deepEqual(json.created, []);
  assert.equal(json.duplicate, true);
  assert.equal(json.deleted, false);
  assert.equal(json.task.id, "winner-0", "the row comes back under the named key the client already reads");
  assert.equal(calls.created.length, 0, "atomic: the loser left nothing behind");
});

test("★ batch: undo-delete restores a keyed row — the tombstone must not swallow the create", async () => {
  // THE regression guard, on the path the client actually uses. public/js/state.js
  // undoDeleteTask replays the deleted subtree through blockStore.batchOp ->
  // POST /api/blocks/batch, carrying `properties` verbatim including idempotency_key.
  // A tombstone-inclusive match here finds the tombstone OF THE ROW BEING RESTORED and
  // restores nothing — and the client compounds it, caching the dead row and
  // re-pointing the task's _blockId at a tombstone.
  //
  // /api/blocks and /batch drifted apart on exactly this once already: the live-only
  // rule was applied to one and not the other. Both routes are pinned now.
  const seed = { "dead-1": { id: "dead-1", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: TOMB, properties: { title: "Deleted task", idempotency_key: "slack-bookmark:C1:1.0" } } };
  const { app, calls } = mountApp({ seed });
  const { json } = await call(app, "POST", "/api/blocks/batch", {
    operations: [{ op: "create", type: "block", date: "2026-07-30", properties: { title: "Deleted task", idempotency_key: "slack-bookmark:C1:1.0" } }],
  });

  assert.equal(calls.created.length, 1, "the undo actually restores");
  assert.notEqual(json.blocks[0].id, "dead-1", "a live row, not the tombstone handed back");
  assert.equal(json.blocks[0]._dedupe, undefined);
});

test("service token: a row won by a RACE is scope-checked too, not just one the lookup found", async () => {
  // assertServiceScope has TWO call sites and only the lookup one was pinned — deleting
  // the other left the whole suite green. Same leak as the one the fix closed, reached
  // through the index race instead of the lookup: the token posts a sweep_suite_task
  // create with a guessed key, loses the race, and db.createBlock hands back the
  // foreign row that won.
  const { app } = mountApp({
    serviceAuth: true,
    onCreate: (op, blocks) => { blocks["not-yours"] = foreignRow("slack-bookmark:C1:9.9", "task"); return idemConflict(); },
  });
  const { status, json } = await call(app, "POST", "/api/blocks", sweepItem("slack-bookmark:C1:9.9"));

  assert.equal(status, 404);
  assert.ok(!JSON.stringify(json).includes("salary"), "the raced-into row must not leak either");
});

test("an id colliding with a TOMBSTONE returns the tombstone and creates nothing (handed to B2)", async () => {
  // Pinned as a DECISION, not left as an accident. The key path was narrowed to
  // live-only so a tombstone cannot swallow a restore; the ID path underneath is still
  // tombstone-inclusive, so the same silent no-op is reachable from the other identity
  // scheme — a create whose caller-minted id matches a tombstone creates nothing and
  // reports skipped_deleted.
  //
  // Latent today: verified that no client path posts a create with an explicit id
  // (public/js/state.js:1416 mints none) and db.ensureDayRoot pre-checks
  // tombstone-inclusive so it never reaches the conflict path. It goes LIVE in B2,
  // which is the phase that makes the client mint ids — and B2 also replaces undo with
  // POST /:id/undelete, which is the right answer for a restore. B2 owns the call:
  // keep this, or make it an explicit 409 pointing at /undelete.
  const seed = { "tombstoned-id": { id: "tombstoned-id", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: TOMB, properties: { title: "Deleted" } } };
  const { app, calls } = mountApp({ seed });
  const { json } = await call(app, "POST", "/api/blocks", { id: "tombstoned-id", type: "block", date: "2026-07-30", properties: { title: "Recreate me" } });

  assert.equal(json.id, "tombstoned-id");
  assert.equal(json._dedupe, "skipped_deleted", "the one path on these routes that can still say this");
  assert.equal(calls.created.length, 0);
});

test("★ service token: an AGENT still must not resurrect — the tombstone rule holds for it", async () => {
  // The live-only narrowing was justified as "these routes are the human client's write
  // path". True of /batch (session-only), NOT true of POST /api/blocks: server.js makes
  // it the Sweep Suite token's one reachable write, and a sweep replaying its key is
  // exactly the agent lib/materialize-guard.js exists to stop. Same endpoint, two
  // callers, opposite right answers — `req.dccServiceAuth` is the discriminator.
  const seed = { "swept-away": { id: "swept-away", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: TOMB, properties: { kind: "sweep_suite_task", title: "Deleted sweep item", idempotency_key: "slack-bookmark:C9:1.0" } } };
  const { app, calls } = mountApp({ seed, serviceAuth: true });
  const { status, json } = await call(app, "POST", "/api/blocks", sweepItem("slack-bookmark:C9:1.0"));

  assert.equal(status, 200);
  assert.equal(json.id, "swept-away");
  assert.equal(json._dedupe, "skipped_deleted", "the sweep is told it was removed, not handed a fresh row");
  assert.equal(calls.created.length, 0, "the item the user deleted does not come back");
});

test("★ a mid-loop refusal still announces the rows already committed", async () => {
  // POST /api/blocks accepts an array and the loop is NOT a transaction — each item
  // autocommits. When a later item's dedupe answer fails the scope check, the earlier
  // rows are already in the database. Without the broadcast in a finally they exist but
  // no tab ever hears about them, while the caller is told the request failed: a
  // permanently invisible row until someone reloads.
  const seed = { "not-yours": foreignRow("forbidden-key", "task") };
  const { app, broadcasts, calls } = mountApp({ seed, serviceAuth: true });
  const { status } = await call(app, "POST", "/api/blocks", [sweepItem("fine-key"), sweepItem("forbidden-key")]);

  assert.equal(status, 404, "the request still fails on the row it may not read");
  assert.equal(calls.created.length, 1, "the first item did commit");
  const created = broadcasts.filter(b => b.payload.action === "create");
  assert.equal(created.length, 1, "and it was announced anyway");
  assert.deepEqual(created[0].payload.blockIds, [calls.created[0].id]);
});

test("batch: the scope guard is enforced there too, not just asserted in a comment", async () => {
  // No service token can reach /batch today — that is a property of five separate
  // attach sites in server.js, none of which routes here. This change set has already
  // shipped three bugs whose root cause was an invariant asserted in a comment across
  // two call sites instead of enforced in code, so /batch checks scope anyway. The
  // guard is a no-op for a session; this pins that it is not a no-op for a token.
  const seed = { "not-yours": foreignRow("batch-forbidden", "task") };
  const { app } = mountApp({ seed, serviceAuth: true });
  const { status, json } = await call(app, "POST", "/api/blocks/batch", {
    operations: [{ op: "create", ...sweepItem("batch-forbidden") }],
  });

  assert.equal(status, 404);
  assert.ok(!JSON.stringify(json).includes("salary"), "no row content leaks through the batch path either");
});
