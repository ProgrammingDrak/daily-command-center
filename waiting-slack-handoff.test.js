// The routes/blocks.js half of the Slack ⇄ Waiting bridge:
//
//   - closing or reopening a Waiting item projects to its Slack message
//   - the ✅ reaction and the Complete button run the SAME function
//   - 🔖 → 👥 (create with convertedFromBlockId) and 👥 → 🔖 (unblock) hand the
//     message over and RETIRE the losing idempotency key
//   - a client cannot write Slack provenance, on create or on PATCH
//
// The retirement is the load-bearing part. Leave a losing key in place and the
// next 🔖 undeletes the old task beside the new Waiting item, while the next 👥
// finds the closed item and mints nothing — both silent.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const P = require("./lib/slack-provenance.js");

const MINE = "ws-1";
const TODAY = "2026-08-19";
const CH = "C1";
const TS = "1783790506.232729";
const PERMALINK = `https://co.slack.com/archives/${CH}/p1783790506232729`;
// A SECOND message, for the 🔖 fixture. One message can have exactly one live row —
// idx_blocks_idem_unique enforces it — so seeding a task and an item against the
// same (channel, ts) would be a state production cannot reach, and every conversion
// out of it would correctly refuse.
const TS_TASK = "1783790777.100200";
const PERMALINK_TASK = `https://co.slack.com/archives/${CH}/p1783790777100200`;

// A 👥 item shaped exactly as routes/slack-events.js handleDelegate mints one.
function slackWaitingRow() {
  return {
    id: "waiting-slack", type: "block", date: null, workspace_id: MINE, user_id: 1,
    created_at: "2026-08-18T12:00:00.000Z", updated_at: "2026-08-18T12:00:00.000Z",
    properties: {
      kind: "delegated_item", source: "slack-delegate",
      idempotency_key: P.slackKeyFor("delegate", CH, TS),
      slack_channel: CH, slack_ts: TS, slack_thread_ts: TS,
      slack_author: "U_ALEX", slack_channel_name: "launch",
      source_id: PERMALINK, source_message_preview: "can you chase the signed contract?",
      contact: { channel: "slack", address: CH, sourceRef: PERMALINK, threadTs: TS, messageTs: TS },
      title: "", myTask: "Chase the signed contract",
      captureTitle: "Chase the signed contract",
      captureNotes: "Delegated from Slack\n" + PERMALINK,
      aiSummary: "Alex owes the signed contract before Friday.",
      notes: "Alex said Thursday at the latest.",
      waitingReason: "delegated", status: "open",
      checkInMode: "date", checkInDate: TODAY, checkInDays: 1,
    },
  };
}
// A 🔖 task shaped as handleBookmark mints one.
function slackTaskRow() {
  return {
    id: "task-slack", type: "block", date: TODAY, workspace_id: MINE, user_id: 1,
    created_at: "2026-08-18T12:00:00.000Z", updated_at: "2026-08-18T12:00:00.000Z",
    properties: {
      kind: "task", source: "slack-bookmark",
      idempotency_key: P.slackKeyFor("bookmark", CH, TS_TASK),
      slack_channel: CH, slack_ts: TS_TASK, slack_thread_ts: TS_TASK,
      slack_author: "U_ALEX", slack_channel_name: "launch",
      source_id: PERMALINK_TASK, source_message_preview: "can you chase the signed contract?",
      contact: { channel: "slack", address: CH, sourceRef: PERMALINK_TASK, threadTs: TS_TASK, messageTs: TS_TASK },
      title: "Chase the signed contract", local_id: "chase-contract",
      captureTitle: "Chase the signed contract",
      captureNotes: "Bookmarked from Slack\n" + PERMALINK_TASK,
      aiSummary: "Alex owes the signed contract before Friday.",
      status: "open", estimatedMinutes: 5, start: "09:00", end: "09:05",
    },
  };
}

function mountApp(extraRows = []) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });

  const waiting = slackWaitingRow();
  const plainTask = {
    id: "task-plain", type: "block", date: TODAY, workspace_id: MINE, user_id: 1,
    properties: { kind: "task", title: "Chase the signed contract", local_id: "plain", source: "waiting-unblock" },
  };
  const rows = new Map([[waiting.id, waiting], [plainTask.id, plainTask]]);
  for (const r of extraRows) rows.set(r.id, r);

  const synced = [];
  let seq = 0;
  const ctx = {
    blockDB: {
      getDelegatedItems: async () => [...rows.values()].filter(r => !r.deleted_at && (r.properties || {}).kind === "delegated_item"),
      getBlockIncludingDeleted: async (id) => rows.get(id) || null,
      getBlock: async (id) => { const r = rows.get(id); return r && !r.deleted_at ? r : null; },
      findUniqueLiveBlockByReference: async (ref) => {
        const direct = rows.get(ref);
        if (direct && !direct.deleted_at) return direct;
        return [...rows.values()].find(r => !r.deleted_at && String((r.properties || {}).local_id || "") === String(ref)) || null;
      },
      updateBlock: async (id, patch) => {
        const r = rows.get(id);
        if (!r) throw new Error("not found " + id);
        if (patch.properties) r.properties = patch.properties;
        if (Object.prototype.hasOwnProperty.call(patch, "date")) r.date = patch.date;
        return r;
      },
      createBlock: async (input) => {
        const created = { id: input.id || `made-${++seq}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null, ...input };
        created.workspace_id = input.workspace_id || MINE;
        rows.set(created.id, created);
        return created;
      },
      createItineraryTask: async ({ date, properties, userId, workspaceId }) => {
        const created = { id: `made-${++seq}`, type: "block", date, properties, user_id: userId, workspace_id: workspaceId || MINE, deleted_at: null };
        rows.set(created.id, created);
        return created;
      },
      deleteBlock: async (id) => {
        const r = rows.get(id);
        if (r) r.deleted_at = new Date().toISOString();
        return r || { id };
      },
      isTaskRow: (r) => !!r && ["block", "added_task"].includes(r.type)
        && !["delegated_item", "tag", "day_root"].includes((r.properties || {}).kind),
      setTaskCompletion: async (input) => {
        const target = rows.get(input.taskRef);
        target.properties = {
          ...target.properties,
          status: input.completed ? "done" : "open",
          done: input.completed || undefined,
          completedAt: input.completed ? input.completedAt : undefined,
          _completionRevision: "rev-1",
        };
        const companionBlocks = (input.companionUpdates || []).map(u => {
          const row = rows.get(u.id);
          row.properties = u.properties;
          return row;
        });
        return { task: target, affectedTasks: [target], companionBlocks,
          broadcastIds: [target.id, ...companionBlocks.map(r => r.id)], persistenceTarget: "task_row" };
      },
      getSubtree: async (ids) => [...rows.values()].filter(r => ids.map(String).includes(String(r.id)) && !r.deleted_at),
      getCarryoverPool: async () => ({ rows: [], dayRoots: [], overlays: {}, scanned: 0 }),
      batchOp: async () => ({ batchId: "b", blocks: [] }),
      reorderBlocks: async () => {},
      getBlocksByDate: async () => [],
      getBlocksByTypes: async () => [],
      getRescheduleSubtreePool: async () => [],
      getBlocksByDateRange: async () => [],
      getResponsibilityBlocks: async () => [],
      getBlocksByKind: async () => [],
      getTaskTimeEntries: async () => [],
      // idx_blocks_idem_unique is UNIQUE on (workspace_id, idempotency_key) across
      // LIVE rows, so freeSlackKey has to be able to see the current holder.
      findByIdempotencyKey: async (workspaceId, key) => {
        const hits = [...rows.values()].filter(r => (r.properties || {}).idempotency_key === key
          && (r.workspace_id || MINE) === workspaceId);
        return hits.find(r => !r.deleted_at) || hits[0] || null;
      },
    },
    broadcast: () => {},
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: (r) => r,
    getScheduleBlocks: async () => [],
    getTodayStr: () => TODAY,
    isAllowedSweepBlockItem: () => true,
    isValidDate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)),
    pool: {
      query: async () => ({ rows: [{ workspace_id: MINE, user_id: 1 }] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    },
    APP_TIME_ZONE: "America/New_York",
    waitingItems: require("./waiting-items"),
    // Stand in for routes/slack-events.js. Records the block AS PROJECTED, so a
    // test can assert both that the projection happened and what state it saw.
    syncSlackTaskReactions: async (blockOrId) => {
      const block = typeof blockOrId === "object" ? blockOrId : rows.get(blockOrId);
      synced.push(block ? { id: block.id, properties: { ...(block.properties || {}) }, deleted_at: block.deleted_at || null } : { id: blockOrId, missing: true });
      return true;
    },
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, ctx, rows, waiting, plainTask, synced };
}

async function request(app, path, method = "GET", body) {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise(r => server.close(r));
  }
}
const syncedIds = (synced) => synced.map(s => s.id);

// ══ closing and reopening project to Slack ═══════════════════════════════════

test("completing a Waiting item projects the ITEM, not only its linked task", async () => {
  // /complete already called syncSlack for the linked task; the item itself — the
  // row that actually wears 👥 on the message — was never projected, which is why
  // closing a delegated item left the message without its ✅.
  const { app, rows, synced } = mountApp();
  const result = await request(app, "/api/waiting-items/waiting-slack/complete", "POST", {});
  assert.equal(result.status, 200);
  assert.equal(rows.get("waiting-slack").properties.status, "done");
  assert.ok(syncedIds(synced).includes("waiting-slack"));
  const projected = synced.find(s => s.id === "waiting-slack");
  assert.equal(projected.properties.status, "done", "the projector must see the CLOSED state, not the pre-write one");
});

test("the ✅ reaction and the Complete button run the same function", async () => {
  const { ctx, rows } = mountApp();
  assert.equal(typeof ctx.completeWaitingItem, "function", "published for routes/slack-events.js");
  const item = rows.get("waiting-slack");
  const out = await ctx.completeWaitingItem({
    item, completedAt: "2026-08-19T15:00:00.000Z", userId: 1, workspaceId: MINE, completedBy: "slack",
  });
  assert.equal(out.status, "completed");
  assert.equal(rows.get("waiting-slack").properties.status, "done");
  assert.equal(rows.get("waiting-slack").properties.completedBy, "slack");
  // And the HTTP route still stamps its own actor.
  const fresh = mountApp();
  await request(fresh.app, "/api/waiting-items/waiting-slack/complete", "POST", {});
  assert.equal(fresh.rows.get("waiting-slack").properties.completedBy, "waiting");
});

test("reopenWaitingItem is the full inverse of completeWaitingItem", async () => {
  const { ctx, rows, synced } = mountApp();
  const item = rows.get("waiting-slack");
  await ctx.completeWaitingItem({ item, completedAt: "2026-08-19T15:00:00.000Z", userId: 1, workspaceId: MINE });
  await ctx.reopenWaitingItem({ item: rows.get("waiting-slack"), atMs: Date.parse("2026-08-19T16:00:00.000Z"), userId: 1, workspaceId: MINE });

  const props = rows.get("waiting-slack").properties;
  assert.equal(props.status, "open");
  for (const key of ["completedAt", "completedBy", "unblockedAt", "unblockedTaskId", "unblockedDestination"]) {
    assert.ok(!(key in props), `${key} must be cleared, not merely overwritten`);
  }
  // The provenance is untouched, so the message still resolves to this row.
  assert.equal(props.idempotency_key, P.slackKeyFor("delegate", CH, TS));
  const last = synced[synced.length - 1];
  assert.equal(last.id, "waiting-slack");
  assert.equal(last.properties.status, "open");
});

test("reopening restores the check-in cadence rather than going quiet", async () => {
  const { ctx, rows } = mountApp();
  await ctx.completeWaitingItem({ item: rows.get("waiting-slack"), completedAt: "2026-08-19T15:00:00.000Z", userId: 1, workspaceId: MINE });
  // /complete nulls checkInScheduledFor and checkInTaskId on the way out.
  await ctx.reopenWaitingItem({ item: rows.get("waiting-slack"), atMs: Date.now(), userId: 1, workspaceId: MINE });
  const item = rows.get("waiting-slack");
  assert.ok(require("./waiting-items").isOpen(item), "a reopened item is open again");
  assert.ok(require("./waiting-items").dueDate(item), "and has a due date the sweep can act on");
});

test("deleting a Waiting item strips its reactions from the message", async () => {
  const { app, synced } = mountApp();
  const result = await request(app, "/api/waiting-items/waiting-slack", "DELETE");
  assert.equal(result.status, 200);
  const projected = synced.find(s => s.id === "waiting-slack");
  assert.ok(projected, "the delete must project too, the way a bookmarked task's delete does");
  assert.ok(projected.deleted_at, "and it must be projected in its DELETED shape so the reactions come off");
});

// ══ 👥 → 🔖 : unblock hands the message to the task ══════════════════════════

test("unblocking a Slack-delegated item moves the message onto the task", async () => {
  const { app, rows } = mountApp();
  const result = await request(app, "/api/waiting-items/waiting-slack/unblock", "POST", {
    destination: "schedule", taskBlockId: "task-plain", date: TODAY,
  });
  assert.equal(result.status, 200);

  const task = rows.get("task-plain").properties;
  assert.equal(task.source, "slack-bookmark", "the task is what the message IS now");
  assert.equal(task.idempotency_key, P.slackKeyFor("bookmark", CH, TS));
  assert.equal(task.slack_channel, CH);
  assert.equal(task.slack_ts, TS);
  assert.equal(task.source_id, PERMALINK, "the permalink is carried, never rotated");
  assert.equal(task.aiSummary, "Alex owes the signed contract before Friday.");

  const item = rows.get("waiting-slack").properties;
  assert.equal(item.status, "unblocked");
  assert.ok(P.isRetiredKey(item.idempotency_key),
    "leave this key live and the next 👥 finds a closed item and mints nothing");
  assert.ok(!P.slackKeysFor(CH, TS).includes(item.idempotency_key));
});

test("unblock does not rewrite the title the client already chose", async () => {
  // unblockWaitingItem() names the task it places from the item's myTask, and the
  // user may have edited it. The handoff carries provenance, not text.
  const { app, rows } = mountApp();
  rows.get("task-plain").properties.title = "Chase Alex re: contract (mine)";
  await request(app, "/api/waiting-items/waiting-slack/unblock", "POST", {
    destination: "schedule", taskBlockId: "task-plain", date: TODAY,
  });
  assert.equal(rows.get("task-plain").properties.title, "Chase Alex re: contract (mine)");
});

test("unblocking a non-Slack Waiting item changes no keys", async () => {
  const plain = {
    id: "waiting-plain", type: "block", date: null, workspace_id: MINE, user_id: 1,
    properties: { kind: "delegated_item", myTask: "Legal sign-off", waitingReason: "blocked", status: "open" },
  };
  const { app, rows } = mountApp([plain]);
  const result = await request(app, "/api/waiting-items/waiting-plain/unblock", "POST", {
    destination: "schedule", taskBlockId: "task-plain", date: TODAY,
  });
  assert.equal(result.status, 200);
  assert.equal(rows.get("task-plain").properties.source, "waiting-unblock", "untouched");
  assert.ok(!("idempotency_key" in rows.get("task-plain").properties));
});

// ══ 🔖 → 👥 : create inherits, but only on an explicit convert ════════════════

test("creating a Waiting item from a bookmarked task moves the message to it", async () => {
  const task = slackTaskRow();
  const { app, rows } = mountApp([task]);
  const result = await request(app, "/api/waiting-items", "POST", {
    properties: { myTask: "Chase the signed contract", waitingReason: "delegated", checkInDays: 1 },
    convertedFromBlockId: "task-slack",
  });
  assert.equal(result.status, 200);

  const created = rows.get(result.body.id).properties;
  assert.equal(created.source, "slack-delegate");
  assert.equal(created.idempotency_key, P.slackKeyFor("delegate", CH, TS_TASK));
  assert.equal(created.slack_ts, TS_TASK);
  // Caught against local Postgres: the first normalize ran before `source` existed
  // and defaulted this to "blocked", and inferReason honours an existing value, so
  // the item wore a Blocked pill while the message wore 👥.
  assert.equal(created.waitingReason, "delegated", "re-derived once the source landed");
  assert.deepEqual(created.contact, task.properties.contact);
  assert.ok(P.isRetiredKey(rows.get("task-slack").properties.idempotency_key),
    "leave this live and the next 🔖 undeletes the task beside the new item");
});

// A converted item is not an auto-created one. delegate_auto_snapshot is what lets
// un-👥 delete a pristine item, and losing everything the user typed in the modal
// to a stray un-reaction would be worse than an orphaned item.
test("a hand-converted item gets no pristine snapshot, so un-👥 cannot delete it", async () => {
  const task = slackTaskRow();
  const { app, rows } = mountApp([task]);
  const result = await request(app, "/api/waiting-items", "POST", {
    properties: { myTask: "Chase the signed contract" },
    convertedFromBlockId: "task-slack",
  });
  assert.ok(!("delegate_auto_snapshot" in rows.get(result.body.id).properties));
});

// linkedBlockId means "I am blocked on something FOR that task" and leaves the task
// alive under its own 🔖. Only convertedFromBlockId says the item IS the task.
test("a plain linkedBlockId does not steal the task's Slack message", async () => {
  const task = slackTaskRow();
  const { app, rows } = mountApp([task]);
  const result = await request(app, "/api/waiting-items", "POST", {
    properties: { myTask: "Chase the signed contract", linkedBlockId: "task-slack", waitingReason: "blocked" },
  });
  assert.equal(result.status, 200);
  const created = rows.get(result.body.id).properties;
  assert.ok(!("idempotency_key" in created), "no key, so no reaction resolves to it");
  assert.equal(rows.get("task-slack").properties.idempotency_key, P.slackKeyFor("bookmark", CH, TS_TASK),
    "the task keeps its message");
});

test("convertedFromBlockId naming a task with no Slack provenance is a no-op", async () => {
  const { app, rows } = mountApp();
  const result = await request(app, "/api/waiting-items", "POST", {
    properties: { myTask: "Something local" },
    convertedFromBlockId: "task-plain",
  });
  assert.equal(result.status, 200);
  assert.ok(!("idempotency_key" in rows.get(result.body.id).properties));
});

// ══ the hijack guard ═════════════════════════════════════════════════════════
//
// The reaction lookup is `idempotency_key` within a workspace. A caller that can
// write one can point its own row at a teammate's Slack message and collect that
// person's ✅; one that can write slack_channel + slack_ts can make the server
// react on any message the token can see.

test("a client cannot set Slack provenance when creating a Waiting item", async () => {
  const { app, rows } = mountApp();
  const result = await request(app, "/api/waiting-items", "POST", {
    properties: {
      myTask: "Not mine",
      idempotency_key: P.slackKeyFor("delegate", "C_THEIRS", "9.9"),
      slack_channel: "C_THEIRS", slack_ts: "9.9",
      delegate_auto_snapshot: {},
    },
  });
  assert.equal(result.status, 200);
  const created = rows.get(result.body.id).properties;
  for (const key of ["idempotency_key", "slack_channel", "slack_ts", "delegate_auto_snapshot"]) {
    assert.ok(!(key in created), `${key} is server-owned and must be dropped`);
  }
});

test("a client cannot repoint an existing Waiting item at another message", async () => {
  const { app, rows } = mountApp();
  const result = await request(app, "/api/waiting-items/waiting-slack", "PATCH", {
    properties: {
      myTask: "Chase the signed contract",
      idempotency_key: P.slackKeyFor("delegate", "C_THEIRS", "9.9"),
      slack_channel: "C_THEIRS", slack_ts: "9.9",
    },
  });
  assert.equal(result.status, 200);
  const props = rows.get("waiting-slack").properties;
  assert.equal(props.idempotency_key, P.slackKeyFor("delegate", CH, TS), "the row's own key survives the edit");
  assert.equal(props.slack_channel, CH);
  assert.equal(props.slack_ts, TS);
});

test("an ordinary edit still lands, and the user-owned contact fields still move", async () => {
  // The strip must not be so broad that it eats the modal's own fields.
  const { app, rows } = mountApp();
  await request(app, "/api/waiting-items/waiting-slack", "PATCH", {
    properties: { myTask: "Chase the countersigned contract", notes: "Alex: Friday", contact: { channel: "gmail", address: "alex@example.com" } },
  });
  const props = rows.get("waiting-slack").properties;
  assert.equal(props.myTask, "Chase the countersigned contract");
  assert.equal(props.notes, "Alex: Friday");
  assert.equal(props.contact.channel, "gmail");
});

// ══ convertSlackMessageKind ══════════════════════════════════════════════════

test("converting 👥 → 🔖 retires and removes the loser before the winner exists", async () => {
  const { ctx, rows } = mountApp();
  const item = rows.get("waiting-slack");
  const out = await ctx.convertSlackMessageKind({
    row: item, fromKind: "delegate", toKind: "bookmark",
    atMs: Date.parse("2026-08-19T17:00:00.000Z"), userId: 1, workspaceId: MINE,
    taskDefaults: { date: TODAY, estimatedMinutes: 5, priority: "Medium", start: "09:00", end: "09:05" },
  });
  assert.equal(out.converted, true);

  const winner = rows.get(out.winner.id).properties;
  assert.equal(winner.source, "slack-bookmark");
  assert.equal(winner.idempotency_key, P.slackKeyFor("bookmark", CH, TS));
  assert.equal(winner.title, "Chase the signed contract", "the work text moves into the task's field");
  assert.equal(winner.myTask, "", "and does not linger in the item's field");
  assert.equal(winner.notes, "Alex said Thursday at the latest.", "the user's notes survive");
  assert.equal(winner.aiSummary, "Alex owes the signed contract before Friday.");
  assert.equal(winner.estimatedMinutes, 5);
  assert.ok(!("date" in winner), "the day column owns the date, not the properties");

  const loser = rows.get("waiting-slack");
  assert.ok(loser.deleted_at, "one live row per message");
  assert.ok(P.isRetiredKey(loser.properties.idempotency_key));
  assert.equal(loser.properties.slackKindChangedAt, "2026-08-19T17:00:00.000Z");
});

test("converting 🔖 → 👥 produces a Waiting item with the work in myTask", async () => {
  const task = slackTaskRow();
  const { ctx, rows } = mountApp([task]);
  const out = await ctx.convertSlackMessageKind({
    row: task, fromKind: "bookmark", toKind: "delegate",
    atMs: Date.parse("2026-08-19T17:00:00.000Z"), userId: 1, workspaceId: MINE,
    itemDefaults: { kind: "delegated_item", waitingReason: "delegated", status: "open", checkInMode: "date", checkInDate: "2026-08-20", checkInDays: 1 },
  });
  assert.equal(out.converted, true);
  const winner = rows.get(out.winner.id).properties;
  assert.equal(winner.kind, "delegated_item");
  assert.equal(winner.source, "slack-delegate");
  assert.equal(winner.idempotency_key, P.slackKeyFor("delegate", CH, TS_TASK));
  assert.equal(winner.myTask, "Chase the signed contract");
  assert.equal(winner.title, "");
  assert.equal(winner.checkInDate, "2026-08-20");
  assert.equal(winner.waitingReason, "delegated");
  assert.ok(rows.get("task-slack").deleted_at);
  assert.ok(P.isRetiredKey(rows.get("task-slack").properties.idempotency_key));
});

test("convertSlackMessageKind refuses a row it cannot address, changing nothing", async () => {
  const orphan = {
    id: "waiting-orphan", type: "block", date: null, workspace_id: MINE, user_id: 1,
    properties: { kind: "delegated_item", source: "slack-delegate", myTask: "No coordinates", status: "open" },
  };
  const { ctx, rows } = mountApp([orphan]);
  const out = await ctx.convertSlackMessageKind({
    row: orphan, fromKind: "delegate", toKind: "bookmark", atMs: Date.now(), userId: 1, workspaceId: MINE,
    taskDefaults: { date: TODAY },
  });
  assert.equal(out.converted, false);
  assert.ok(!rows.get("waiting-orphan").deleted_at, "a refused conversion must not delete the row");
});

test("convertSlackMessageKind refuses a same-kind request", async () => {
  const { ctx, rows } = mountApp();
  const out = await ctx.convertSlackMessageKind({
    row: rows.get("waiting-slack"), fromKind: "delegate", toKind: "delegate",
    atMs: Date.now(), userId: 1, workspaceId: MINE,
  });
  assert.equal(out.converted, false);
  assert.ok(!rows.get("waiting-slack").deleted_at);
});

// ══ the unique index ═════════════════════════════════════════════════════════
//
// idx_blocks_idem_unique is UNIQUE on (workspace_id, idempotency_key) for live rows.
// A reaction TOMBSTONE is written whenever a removal is delivered before its add,
// and it stays LIVE holding the key — so it can be sitting on exactly the key a
// conversion needs. This is not hypothetical: it is the ordinary outcome of
// un-reacting and re-reacting quickly.

function tombstone(kind, ts = TS, id = "tomb-1") {
  return {
    id, type: "block", date: null, workspace_id: MINE, user_id: 1, deleted_at: null,
    properties: {
      kind: "slack_reaction_tombstone", source: kind === "delegate" ? "slack-delegate" : "slack-bookmark",
      status: "cancelled", hidden: true,
      idempotency_key: P.slackKeyFor(kind, CH, ts), slack_channel: CH, slack_ts: ts,
    },
  };
}
// A real, live row already holding a key — the state that must make a handoff back
// out rather than delete anything.
function squatter(kind, ts, id = "squatter-1") {
  return {
    id, type: "block", date: kind === "bookmark" ? TODAY : null, workspace_id: MINE, user_id: 1, deleted_at: null,
    properties: {
      kind: kind === "bookmark" ? "task" : "delegated_item",
      source: kind === "delegate" ? "slack-delegate" : "slack-bookmark",
      idempotency_key: P.slackKeyFor(kind, CH, ts),
      slack_channel: CH, slack_ts: ts, title: "Already tracked", status: "open",
    },
  };
}

test("a conversion clears a tombstone squatting on the key it needs", async () => {
  // Without this, db.createBlock absorbs the 23505 by returning the CONFLICTING row
  // tagged _resolvedExisting — so the conversion would delete the real item and hand
  // back the tombstone as its winner. A 200 with the data gone.
  const { ctx, rows } = mountApp([tombstone("bookmark")]);
  const out = await ctx.convertSlackMessageKind({
    row: rows.get("waiting-slack"), fromKind: "delegate", toKind: "bookmark",
    atMs: Date.parse("2026-08-19T17:00:00.000Z"), userId: 1, workspaceId: MINE,
    taskDefaults: { date: TODAY, estimatedMinutes: 5, start: "09:00", end: "09:05" },
  });
  assert.equal(out.converted, true);
  assert.ok(rows.get("tomb-1").deleted_at, "the tombstone was cleared, as handleBookmark clears one before creating");
  const winner = rows.get(out.winner.id).properties;
  assert.equal(winner.idempotency_key, P.slackKeyFor("bookmark", CH, TS));
  assert.notEqual(winner.kind, "slack_reaction_tombstone", "the winner is a real task, not the row that was in the way");
});

test("a conversion refuses rather than destroying anything when a real row holds the key", async () => {
  // Two live rows claiming one message should never happen; if it does, the safe
  // answer is to change nothing rather than delete the row we were handed.
  const { ctx, rows } = mountApp([squatter("bookmark", TS)]);
  const out = await ctx.convertSlackMessageKind({
    row: rows.get("waiting-slack"), fromKind: "delegate", toKind: "bookmark",
    atMs: Date.now(), userId: 1, workspaceId: MINE, taskDefaults: { date: TODAY },
  });
  assert.equal(out.converted, false);
  assert.ok(!rows.get("waiting-slack").deleted_at, "the item survives");
  assert.ok(!rows.get("squatter-1").deleted_at, "and so does the row that was in the way");
});

test("the unblock handoff clears a tombstone rather than 500ing on the index", async () => {
  // updateBlock does NOT absorb a key conflict, so this path fails louder than the
  // conversion one — a 500 on a button press.
  const { app, rows } = mountApp([tombstone("bookmark")]);
  const result = await request(app, "/api/waiting-items/waiting-slack/unblock", "POST", {
    destination: "schedule", taskBlockId: "task-plain", date: TODAY,
  });
  assert.equal(result.status, 200);
  assert.ok(rows.get("tomb-1").deleted_at);
  assert.equal(rows.get("task-plain").properties.idempotency_key, P.slackKeyFor("bookmark", CH, TS));
});

test("unblock leaves the item keyed when a real row already holds the target key", async () => {
  const { app, rows } = mountApp([squatter("bookmark", TS)]);
  const result = await request(app, "/api/waiting-items/waiting-slack/unblock", "POST", {
    destination: "schedule", taskBlockId: "task-plain", date: TODAY,
  });
  // The unblock itself still succeeds — it is a real user action about the WORK, and
  // refusing it over a provenance collision would strand the item. Only the handoff
  // backs out, so the message stays with whoever already owns it.
  assert.equal(result.status, 200);
  assert.equal(rows.get("waiting-slack").properties.status, "unblocked");
  assert.ok(!("idempotency_key" in rows.get("task-plain").properties), "no message was stolen");
  assert.equal(rows.get("waiting-slack").properties.idempotency_key, P.slackKeyFor("delegate", CH, TS),
    "and the item keeps its own key, since nothing took it over");
});

test("converting on create refuses with a 409 when a real row holds the delegate key", async () => {
  const task = slackTaskRow();
  const { app } = mountApp([task, squatter("delegate", TS_TASK, "other-item")]);
  const result = await request(app, "/api/waiting-items", "POST", {
    properties: { myTask: "Chase the signed contract" },
    convertedFromBlockId: "task-slack",
  });
  assert.equal(result.status, 409, "createBlock would otherwise absorb this and return the other item");
});

test("converting on create clears a tombstone on the delegate key", async () => {
  const task = slackTaskRow();
  const { app, rows } = mountApp([task, tombstone("delegate", TS_TASK)]);
  const result = await request(app, "/api/waiting-items", "POST", {
    properties: { myTask: "Chase the signed contract" },
    convertedFromBlockId: "task-slack",
  });
  assert.equal(result.status, 200);
  assert.ok(rows.get("tomb-1").deleted_at);
  assert.equal(rows.get(result.body.id).properties.idempotency_key, P.slackKeyFor("delegate", CH, TS_TASK));
});

test("an explicit waitingReason from the client still wins over the re-derivation", async () => {
  // Only the DEFAULT is re-derived. Someone who deliberately files a Slack-sourced
  // item as Blocked ("I am waiting on a system, not a person") keeps that.
  const task = slackTaskRow();
  const { app, rows } = mountApp([task]);
  const result = await request(app, "/api/waiting-items", "POST", {
    properties: { myTask: "Chase the signed contract", waitingReason: "blocked" },
    convertedFromBlockId: "task-slack",
  });
  assert.equal(rows.get(result.body.id).properties.waitingReason, "blocked");
});
