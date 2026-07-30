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

function mountApp({ seed = {}, onCreate = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });

  const blocks = { ...seed };
  const calls = { created: [], batches: [] };
  const broadcasts = [];
  let n = 0;

  const keyOf = (row) => (row.properties || {}).idempotency_key || null;

  function insert(item) {
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
            // `_deduped`. Modelling it as a bare throw would test a recovery path the
            // real code no longer takes.
            const props = typeof item.properties === "string" ? JSON.parse(item.properties) : (item.properties || {});
            const winner = forced.constraint === "idx_blocks_idem_unique"
              ? Object.values(blocks).find(b => keyOf(b) === props.idempotency_key && !b.deleted_at)
              : null;
            if (!winner) throw forced;
            return { ...winner, _deduped: true };
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
      getBlocksByDateIncludingDeleted: async (date, workspaceId) => Object.values(blocks).filter(b => b.date === date && b.workspace_id === workspaceId),
      createItineraryTask: async (b) => insert(b),
      createItineraryTasks: async (items) => items.map(insert),
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
    isAllowedSweepBlockItem: () => true,
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
  assert.equal(again.json._dedupe, "duplicate");
  assert.equal(calls.created.length, 1, "exactly one row exists");
});

test("POST /api/blocks: a key matching a TOMBSTONE refuses rather than resurrecting", async () => {
  // THE no-resurrect rule (lib/materialize-guard.js): a soft-deleted match is still a
  // match. The unique index cannot enforce this half — it is partial on
  // `deleted_at IS NULL`, so a tombstone does not reserve its key. Both halves needed.
  const seed = { "dead-1": { id: "dead-1", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: TOMB, properties: { title: "Removed", idempotency_key: "sweep:42" } } };
  const { app, calls } = mountApp({ seed });
  const { status, json } = await call(app, "POST", "/api/blocks", item("sweep:42"));

  assert.equal(status, 200, "the repo's established shape: 200 + a named verdict, not a new status code Track B's replay classifier would read as transient");
  assert.equal(json.id, "dead-1");
  assert.equal(json._dedupe, "deleted", "named, so a caller can tell 'already there' from 'you deleted this'");
  assert.equal(calls.created.length, 0, "the row the user deleted does not come back");
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
  assert.equal(json[1]._dedupe, "duplicate");
  assert.equal(calls.created.length, 1);
});

test("POST /api/blocks: the broadcast carries only ids this request actually created", async () => {
  // Announcing a "create" for a deduped row makes every other tab re-fetch it — and
  // for a tombstoned match that is a fetch A2 deliberately made 404.
  const seed = { "dead-1": { id: "dead-1", type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: TOMB, properties: { title: "Removed", idempotency_key: "sweep:42" } } };
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
  assert.equal(json._dedupe, "duplicate");
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
  assert.equal(replay.json.blocks[0]._dedupe, "duplicate");
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
  assert.equal(json.blocks[0]._dedupe, "duplicate");
  assert.ok(json.blocks[1].reordered, "the reorder is still at index 1, not shifted up by the dropped creates");
  assert.equal(json.blocks[2]._dedupe, "duplicate");
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
  assert.equal(json.blocks[1]._dedupe, "duplicate");
  assert.equal(calls.created.length, 1);
});

test("batch: an index conflict is retried exactly once, against the now-visible winner", async () => {
  const { app, calls } = mountApp({ onCreate: racingWinner("race-winner", "batch-race") });
  const { status, json } = await call(app, "POST", "/api/blocks/batch", {
    operations: [{ op: "create", ...item("batch-race") }],
  });

  assert.equal(status, 200, "the retry resolved it — no 500 leaked out");
  assert.equal(json.blocks[0].id, "race-winner");
  assert.equal(json.blocks[0]._dedupe, "duplicate");
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
// `_deduped`; these routes have to take the same branch the lookup would have.

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
      // live winner tagged `_deduped` instead of the row it was asked to insert.
      createItineraryTask: async (b) => {
        if (dedupeCreate) return { ...dedupeCreate, _deduped: true };
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
