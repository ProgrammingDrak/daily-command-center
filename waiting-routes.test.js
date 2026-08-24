const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";
const TODAY = "2026-08-14";

function waitingRow() {
  return {
    id: "waiting-1",
    type: "block",
    date: null,
    workspace_id: MINE,
    user_id: 1,
    created_at: "2026-08-07T12:00:00.000Z",
    properties: {
      kind: "delegated_item",
      myTask: "Launch plan",
      title: "Legal approval",
      waitingReason: "blocked",
      delegatee: { name: "Alex", kind: "person" },
      contact: { channel: "gmail", address: "alex@example.com", sourceRef: "https://mail.google.com/thread/1" },
      checkInDate: TODAY,
      checkInDays: 7,
      status: "open",
    },
  };
}

function mountApp(suppressionBlocks = []) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });
  const waiting = waitingRow();
  const task = {
    id: "task-1", type: "block", date: TODAY, workspace_id: MINE, user_id: 1,
    properties: { kind: "task", title: "Launch plan", local_id: "launch-plan" },
  };
  const prerequisite = {
    id: "task-2", type: "block", date: null, workspace_id: MINE, user_id: 1,
    properties: { kind: "backlog", title: "Get legal approval", local_id: "get-legal-approval" },
  };
  const rows = new Map([[waiting.id, waiting], [task.id, task], [prerequisite.id, prerequisite]]);
  const updates = [];
  const completions = [];
  const batches = [];
  const slackSync = [];
  const broadcasts = [];
  const transactionQueries = [];
  const ctx = {
    blockDB: {
      getDelegatedItems: async () => [...rows.values()].filter(row => !row.deleted_at && (row.properties || {}).kind === "delegated_item"),
      getBlockIncludingDeleted: async id => rows.get(id) || null,
      getBlock: async id => rows.get(id) || null,
      ensureDayRoot: async date => `day-root-${MINE}-${date}`,
      getTaskTimeEntries: async blockId => [...rows.values()].filter(row => !row.deleted_at
        && row.type === "time_entry" && String((row.properties || {}).blockId) === String(blockId)),
      getWaitingClusterTasks: async itemId => [...rows.values()].filter(row => !row.deleted_at
        && String((row.properties || {}).delegatedItemId || "") === String(itemId)),
      findUniqueLiveBlockByReference: async blockRef => {
        const direct = rows.get(blockRef);
        if (direct && !direct.deleted_at) return direct;
        const matches = [...rows.values()].filter(row => !row.deleted_at && String((row.properties || {}).local_id || "") === String(blockRef));
        if (matches.length > 1) { const error = new Error("Task reference is ambiguous"); error.statusCode = 409; throw error; }
        return matches[0] || null;
      },
      updateBlock: async (id, patch) => {
        const row = rows.get(id);
        if (patch.properties) row.properties = patch.properties;
        if (Object.prototype.hasOwnProperty.call(patch, "date")) row.date = patch.date;
        updates.push({ id, patch });
        return row;
      },
      createBlock: async input => {
        const created = { id: "dependency-" + rows.size, created_at: new Date().toISOString(), deleted_at: null, ...input };
        rows.set(created.id, created);
        return created;
      },
      deleteBlock: async id => {
        const row = rows.get(id);
        if (row) row.deleted_at = new Date().toISOString();
        return row || { id };
      },
      undeleteBlock: async id => {
        const row = rows.get(id);
        if (!row) throw new Error("Block not found: " + id);
        row.deleted_at = null;
        return row;
      },
      getSubtree: async ids => {
        const wanted = new Set(ids.map(String));
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of rows.values()) {
            if (!row.deleted_at && row.parent_id && wanted.has(String(row.parent_id)) && !wanted.has(String(row.id))) {
              wanted.add(String(row.id));
              changed = true;
            }
          }
        }
        return [...rows.values()].filter(row => wanted.has(String(row.id)) && !row.deleted_at);
      },
      isTaskRow: row => !!row && ["block", "added_task"].includes(row.type)
        && !["delegated_item", "tag", "day_root"].includes((row.properties || {}).kind),
      setTaskCompletion: async input => {
        completions.push(input);
        const target = rows.get(input.taskRef);
        target.properties = {
          ...target.properties,
          status: "done",
          done: true,
          completedAt: input.completedAt,
          _completionRevision: "rev-complete",
        };
        const companionBlocks = (input.companionUpdates || []).map(update => {
          const row = rows.get(update.id);
          row.properties = update.properties;
          updates.push({ id: row.id, patch: { properties: update.properties } });
          return row;
        });
        return {
          task: target,
          affectedTasks: [target],
          companionBlocks,
          broadcastIds: [target.id, ...companionBlocks.map(row => row.id)],
          persistenceTarget: "test",
        };
      },
      getCarryoverPool: async () => ({ rows: [], dayRoots: [], overlays: {}, scanned: 0 }),
      batchOp: async operations => {
        batches.push(operations);
        const blocks = [];
        for (const op of operations) {
          if (op.op === "update") blocks.push(await ctx.blockDB.updateBlock(op.id, op));
          else if (op.op === "delete") blocks.push(await ctx.blockDB.deleteBlock(op.id));
          else blocks.push({ id: op.id || "created" });
        }
        return { batchId: "b", blocks };
      },
      reorderBlocks: async () => {},
      getBlocksByDate: async () => [],
      getBlocksByTypes: async () => [],
      getRescheduleSubtreePool: async () => [],
      getBlocksByDateRange: async () => [],
      getResponsibilityBlocks: async () => [],
      getBlocksByKind: async (kind) => {
        if (typeof suppressionBlocks === "function") return suppressionBlocks(kind);
        return suppressionBlocks.filter((b) => (b.properties || {}).kind === kind);
      },
    },
    broadcast: (event, payload, workspaceId) => { broadcasts.push({ event, payload, workspaceId }); },
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: rows => rows,
    getScheduleBlocks: async () => [],
    getTodayStr: () => TODAY,
    isAllowedSweepBlockItem: () => true,
    isValidDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
    pool: {
      query: async () => ({ rows: [{ workspace_id: MINE, user_id: 1 }] }),
      connect: async () => ({
        query: async sql => { transactionQueries.push(String(sql)); return { rows: [] }; },
        release() {},
      }),
    },
    APP_TIME_ZONE: "America/New_York",
    waitingItems: require("./waiting-items"),
    syncSlackTaskReactions: async row => { slackSync.push(row); return true; },
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, ctx, waiting, task, prerequisite, rows, updates, completions, batches, slackSync, broadcasts, transactionQueries };
}

async function request(app, path, method = "GET", body) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("attention returns one stable internal draft for a due Waiting cycle", async () => {
  const { app } = mountApp();
  const result = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.items[0].attentionScore, 100);
  assert.equal(result.body.draft_items[0].id, "waiting-checkin:waiting-1:" + TODAY);
  assert.equal(result.body.draft_items[0].draft_type, "internal");
  assert.match(result.body.draft_items[0].draft_preview, /Hi Alex/);
  assert.equal(result.body.draft_items[0].waiting_item_id, "waiting-1");
});

test("snooze removes Waiting from attention until the chosen day", async () => {
  const { app, waiting } = mountApp();
  const snoozed = await request(app, "/api/waiting-items/waiting-1/snooze", "POST", { until: "2026-08-16" });
  assert.equal(snoozed.status, 200);
  assert.equal(waiting.properties.snoozedUntil, "2026-08-16");
  const attention = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.deepEqual(attention.body.items, []);
});

test("scheduling a check-in ties the cadence to a real 15-minute task date", async () => {
  const { app, waiting, task } = mountApp();
  task.date = "2026-08-15";
  const wrong = await request(app, "/api/waiting-items/waiting-1/check-ins/schedule", "POST", { date: TODAY, taskBlockId: task.id });
  assert.equal(wrong.status, 400);
  task.date = TODAY;
  const scheduled = await request(app, "/api/waiting-items/waiting-1/check-ins/schedule", "POST", { date: TODAY, taskBlockId: task.id });
  assert.equal(scheduled.status, 200);
  assert.equal(waiting.properties.checkInTaskId, task.id);
  assert.equal(waiting.properties.checkInDate, TODAY);
});

test("completing a check-in rejects an invalid timestamp without losing the next reminder", async () => {
  const { app, waiting, updates } = mountApp();
  const result = await request(app, "/api/waiting-items/waiting-1/check-ins/complete", "POST", {
    cycleKey: "waiting:waiting-1:" + TODAY,
    completedAt: "not-a-time",
  });
  assert.equal(result.status, 400);
  assert.equal(waiting.properties.checkInDate, TODAY);
  assert.equal(updates.length, 0);
});

test("unblock only closes Waiting after its underlying task is on the requested day", async () => {
  const { app, waiting, task } = mountApp();
  task.date = "2026-08-15";
  const refused = await request(app, "/api/waiting-items/waiting-1/unblock", "POST", { date: TODAY, taskBlockId: task.id });
  assert.equal(refused.status, 400);
  assert.equal(waiting.properties.status, "open");
  task.date = TODAY;
  const result = await request(app, "/api/waiting-items/waiting-1/unblock", "POST", { date: TODAY, taskBlockId: task.id });
  assert.equal(result.status, 200);
  assert.equal(waiting.properties.status, "unblocked");
  assert.equal(waiting.properties.unblockedTaskId, task.id);
});

test("complete closes Waiting and completes its linked task through the canonical transaction", async () => {
  const { app, waiting, task, completions } = mountApp();
  waiting.properties.linkedBlockId = task.id;
  const completedAt = "2026-08-14T16:00:00.000Z";
  const result = await request(app, "/api/waiting-items/waiting-1/complete", "POST", { completedAt });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "completed");
  assert.equal(waiting.properties.status, "done");
  assert.equal(waiting.properties.completedAt, completedAt);
  assert.equal(task.properties.status, "done");
  assert.equal(task.properties.done, true);
  assert.equal(task.properties.completedAt, completedAt);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].taskRef, task.id);
  assert.equal(completions[0].companionUpdates[0].id, waiting.id);
});

test("complete rejects a linked row that is not a task", async () => {
  const { app, waiting, task, completions } = mountApp();
  task.type = "day_root";
  task.properties = { date: TODAY };
  waiting.properties.linkedBlockId = task.id;
  const result = await request(app, "/api/waiting-items/waiting-1/complete", "POST", {
    completedAt: "2026-08-14T16:00:00.000Z",
  });
  assert.equal(result.status, 400);
  assert.equal(waiting.properties.status, "open");
  assert.equal(completions.length, 0);
});

test("complete resolves a linked task stored by local id", async () => {
  const { app, waiting, task, completions } = mountApp();
  waiting.properties.linkedBlockId = task.properties.local_id;
  const result = await request(app, "/api/waiting-items/waiting-1/complete", "POST", {
    completedAt: "2026-08-14T16:00:00.000Z",
  });
  assert.equal(result.status, 200);
  assert.equal(waiting.properties.status, "done");
  assert.equal(task.properties.status, "done");
  assert.equal(completions[0].taskRef, task.id);
});

test("complete rejects an ambiguous linked local id without closing Waiting", async () => {
  const { app, waiting, task, rows, completions } = mountApp();
  waiting.properties.linkedBlockId = task.properties.local_id;
  const duplicate = {
    ...task,
    id: "task-2",
    properties: { ...task.properties },
  };
  rows.set(duplicate.id, duplicate);
  const result = await request(app, "/api/waiting-items/waiting-1/complete", "POST", {
    completedAt: "2026-08-14T16:00:00.000Z",
  });
  assert.equal(result.status, 409);
  assert.equal(waiting.properties.status, "open");
  assert.equal(completions.length, 0);
});

test("complete ignores a deleted local-id collision", async () => {
  const { app, waiting, task, rows, completions } = mountApp();
  waiting.properties.linkedBlockId = task.properties.local_id;
  rows.set("task-deleted", {
    ...task,
    id: "task-deleted",
    deleted_at: "2026-08-14T15:00:00.000Z",
    properties: { ...task.properties },
  });
  const result = await request(app, "/api/waiting-items/waiting-1/complete", "POST", {
    completedAt: "2026-08-14T16:00:00.000Z",
  });
  assert.equal(result.status, 200);
  assert.equal(completions[0].taskRef, task.id);
});

test("complete also closes a text-only Waiting item", async () => {
  const { app, waiting, slackSync } = mountApp();
  waiting.properties.source = "slack-delegate";
  waiting.properties.slack_channel = "C1";
  waiting.properties.slack_ts = "123.45";
  const result = await request(app, "/api/waiting-items/waiting-1/complete", "POST", {
    completedAt: "2026-08-14T16:00:00.000Z",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.task, null);
  assert.equal(waiting.properties.status, "done");
  assert.equal(slackSync.length, 1);
  assert.equal(slackSync[0].id, waiting.id);
  assert.equal(slackSync[0].properties.status, "done");
});

test("deleting Waiting removes its generated task cluster and syncs Slack", async () => {
  const { app, waiting, rows, slackSync, transactionQueries } = mountApp();
  waiting.properties.source = "slack-delegate";
  waiting.properties.slack_channel = "C1";
  waiting.properties.slack_ts = "123.4";
  const checkIn = {
    id: "check-in-1", type: "block", date: TODAY, workspace_id: MINE, user_id: 1,
    properties: { kind: "task", source: "waiting-check-in", delegatedItemId: waiting.id },
  };
  const completion = {
    id: "delegate-task-1", type: "block", date: TODAY, workspace_id: MINE, user_id: 1,
    properties: {
      kind: "task", source: "slack-delegate-completion", delegatedItemId: waiting.id,
      slack_channel: "C1", slack_ts: "123.4",
    },
  };
  rows.set(checkIn.id, checkIn);
  rows.set(completion.id, completion);

  const result = await request(app, "/api/waiting-items/" + waiting.id, "DELETE");
  assert.equal(result.status, 200);
  assert.ok(waiting.deleted_at);
  assert.ok(checkIn.deleted_at);
  assert.ok(completion.deleted_at);
  assert.deepEqual(waiting.properties.slackDelegateClusterIds.sort(), [checkIn.id, completion.id].sort());
  assert.ok(slackSync.some(row => row.id === waiting.id && row.deleted_at));
  assert.ok(slackSync.some(row => row.id === completion.id && row.deleted_at));
  assert.ok(transactionQueries.some(sql => sql.includes("pg_advisory_xact_lock")));
});

test("deleting Waiting settles a task that starts between discovery and locking", async () => {
  const { app, ctx, waiting, rows } = mountApp();
  const completion = {
    id: "delegate-task-race", type: "block", date: TODAY, workspace_id: MINE, user_id: 1,
    properties: {
      kind: "task", source: "slack-delegate-completion", delegatedItemId: waiting.id,
      estimatedMinutes: 5,
    },
  };
  rows.set(completion.id, completion);
  const originalScan = ctx.blockDB.getWaitingClusterTasks;
  let scans = 0;
  ctx.blockDB.getWaitingClusterTasks = async (...args) => {
    scans += 1;
    if (scans === 2) {
      completion.properties.startedAt = new Date(Date.now() - 60_000).toISOString();
      completion.properties.activeWorkSessionId = "race-session";
      completion.properties.startedBy = "dcc";
    }
    return originalScan(...args);
  };

  const result = await request(app, "/api/waiting-items/" + waiting.id, "DELETE");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(scans >= 4);
  assert.equal(completion.properties.startedAt, undefined);
  assert.ok(completion.properties.actualMinutes >= 1);
  assert.ok(completion.deleted_at);
});

test("restoring Waiting undeletes the same generated task cluster", async () => {
  const { app, ctx, waiting, rows, transactionQueries } = mountApp();
  waiting.properties.source = "slack-delegate";
  const checkIn = {
    id: "check-in-restore", type: "block", date: TODAY, workspace_id: MINE, user_id: 1,
    properties: { kind: "task", source: "waiting-check-in", delegatedItemId: waiting.id },
  };
  rows.set(checkIn.id, checkIn);
  await request(app, "/api/waiting-items/" + waiting.id, "DELETE");

  const result = await ctx.restoreWaitingCluster({
    itemId: waiting.id,
    restoredAt: "2026-08-14T18:00:00.000Z",
    workspaceId: MINE,
  });
  assert.deepEqual(result.blockIds.sort(), [waiting.id, checkIn.id].sort());
  assert.equal(waiting.deleted_at, null);
  assert.equal(checkIn.deleted_at, null);
  assert.equal(waiting.properties.slackDelegateChangedAt, "2026-08-14T18:00:00.000Z");
  assert.ok(transactionQueries.filter(sql => sql.includes("pg_advisory_xact_lock")).length >= 2);
});

test("restoring Waiting rejects a stored cluster id from another workspace", async () => {
  const { ctx, waiting, rows } = mountApp();
  const foreign = {
    id: "foreign-deleted", type: "block", date: TODAY, workspace_id: "ws-other", user_id: 9,
    deleted_at: "2026-08-14T12:00:00.000Z",
    properties: { kind: "task", source: "waiting-check-in", delegatedItemId: waiting.id },
  };
  waiting.deleted_at = "2026-08-14T12:00:00.000Z";
  waiting.properties.slackDelegateClusterIds = [foreign.id];
  rows.set(foreign.id, foreign);

  await assert.rejects(
    ctx.restoreWaitingCluster({ itemId: waiting.id, workspaceId: MINE }),
    error => error && error.statusCode === 404
  );
  assert.equal(foreign.deleted_at, "2026-08-14T12:00:00.000Z");
});

test("generic DCC delete and undo use the same Waiting cluster lifecycle", async () => {
  const { app, waiting, rows, broadcasts } = mountApp();
  const checkIn = {
    id: "check-in-generic", type: "block", date: TODAY, workspace_id: MINE, user_id: 1,
    properties: { kind: "task", source: "waiting-check-in", delegatedItemId: waiting.id },
  };
  rows.set(checkIn.id, checkIn);

  const deleted = await request(app, "/api/blocks/" + waiting.id, "DELETE");
  assert.equal(deleted.status, 200);
  assert.ok(waiting.deleted_at);
  assert.ok(checkIn.deleted_at);

  const restored = await request(app, "/api/blocks/" + waiting.id + "/undelete", "POST", {});
  assert.equal(restored.status, 200);
  assert.equal(waiting.deleted_at, null);
  assert.equal(checkIn.deleted_at, null);
  const undo = broadcasts.find(call => call.payload.action === "undelete");
  assert.deepEqual(undo.payload.undeletedIds.sort(), [waiting.id, checkIn.id].sort());
});

test("creating a task dependency moves the blocked task to Waiting", async () => {
  const { app, task, prerequisite, rows } = mountApp();
  const result = await request(app, "/api/waiting-items", "POST", { properties: {
    kind: "delegated_item",
    blockerType: "task",
    blockerBlockId: prerequisite.id,
    linkedBlockId: task.id,
    title: prerequisite.properties.title,
    myTask: task.properties.title,
  } });
  assert.equal(result.status, 200);
  assert.equal(result.body.properties.status, "open");
  assert.equal(result.body.properties.blockerBlockId, prerequisite.id);
  assert.equal(task.date, null);
  assert.equal(task.properties.dependencyWaitingItemId, result.body.id);
  assert.equal(rows.get(result.body.id).properties.linkedBlockId, task.id);
});

test("task dependency validation rejects a cycle", async () => {
  const { app, task, prerequisite } = mountApp();
  const first = await request(app, "/api/waiting-items", "POST", { properties: {
    kind: "delegated_item", blockerType: "task",
    blockerBlockId: prerequisite.id, linkedBlockId: task.id,
    title: prerequisite.properties.title, myTask: task.properties.title,
  } });
  assert.equal(first.status, 200);
  const cycle = await request(app, "/api/waiting-items", "POST", { properties: {
    kind: "delegated_item", blockerType: "task",
    blockerBlockId: task.id, linkedBlockId: prerequisite.id,
    title: task.properties.title, myTask: prerequisite.properties.title,
  } });
  assert.equal(cycle.status, 409);
  assert.match(cycle.body.error, /cycle/i);
});

test("a ready dependency can release its task to Backlog", async () => {
  const { app, task, prerequisite, rows } = mountApp();
  const created = await request(app, "/api/waiting-items", "POST", { properties: {
    kind: "delegated_item", blockerType: "task",
    blockerBlockId: prerequisite.id, linkedBlockId: task.id,
    title: prerequisite.properties.title, myTask: task.properties.title,
  } });
  rows.get(created.body.id).properties.status = "ready";
  const released = await request(app, `/api/waiting-items/${created.body.id}/unblock`, "POST", {
    destination: "backlog", taskBlockId: task.id,
  });
  assert.equal(released.status, 200);
  assert.equal(released.body.item.properties.status, "unblocked");
  assert.equal(task.date, null);
  assert.equal("dependencyWaitingItemId" in task.properties, false);
});

test("a dependency release cannot target an unrelated task", async () => {
  const { app, task, prerequisite, rows } = mountApp();
  const created = await request(app, "/api/waiting-items", "POST", { properties: {
    kind: "delegated_item", blockerType: "task",
    blockerBlockId: prerequisite.id, linkedBlockId: task.id,
    title: prerequisite.properties.title, myTask: task.properties.title,
  } });
  const unrelated = {
    id: "task-unrelated", type: "block", date: null, workspace_id: MINE, user_id: 1,
    properties: { kind: "backlog", title: "Unrelated", local_id: "unrelated" },
  };
  rows.set(unrelated.id, unrelated);
  const result = await request(app, `/api/waiting-items/${created.body.id}/unblock`, "POST", {
    destination: "backlog", taskBlockId: unrelated.id,
  });
  assert.equal(result.status, 400);
  assert.equal(rows.get(created.body.id).properties.status, "open");
  assert.equal(task.properties.dependencyWaitingItemId, created.body.id);
});

test("a descendant cannot be chosen as its parent task's prerequisite", async () => {
  const { app, task, rows } = mountApp();
  const child = {
    id: "task-child", type: "block", parent_id: task.id, date: TODAY, workspace_id: MINE, user_id: 1,
    properties: { kind: "task", title: "Child step", local_id: "child-step" },
  };
  rows.set(child.id, child);
  const result = await request(app, "/api/waiting-items", "POST", { properties: {
    kind: "delegated_item", blockerType: "task",
    blockerBlockId: child.id, linkedBlockId: task.id,
    title: child.properties.title, myTask: task.properties.title,
  } });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /inside the blocked task/i);
  assert.equal(task.properties.dependencyWaitingItemId, undefined);
});

test("creating a prerequisite and dependency is one canonical server transaction", async () => {
  const { app, task, rows } = mountApp();
  const result = await request(app, "/api/waiting-items", "POST", {
    properties: {
      kind: "delegated_item", blockerType: "task", linkedBlockId: task.id,
      myTask: task.properties.title, title: "Buy fixture",
    },
    newBlocker: { title: "Buy fixture", duration: 45, priority: "High" },
  });
  assert.equal(result.status, 200);
  const blocker = rows.get(result.body.properties.blockerBlockId);
  assert.ok(blocker);
  assert.equal(blocker.properties.kind, "backlog");
  assert.match(blocker.properties.local_id, /^dependency-prerequisite-/);
  assert.equal(blocker.properties.duration, 45);
  assert.equal(blocker.properties.durMin, 45);
  assert.equal(task.properties.dependencyWaitingItemId, result.body.id);
});

test("an active dependency prevents deleting its prerequisite", async () => {
  const { app, task, prerequisite } = mountApp();
  const created = await request(app, "/api/waiting-items", "POST", { properties: {
    kind: "delegated_item", blockerType: "task",
    blockerBlockId: prerequisite.id, linkedBlockId: task.id,
    title: prerequisite.properties.title, myTask: task.properties.title,
  } });
  assert.equal(created.status, 200);
  const deleted = await request(app, `/api/blocks/${prerequisite.id}`, "DELETE");
  assert.equal(deleted.status, 409);
  assert.match(deleted.body.error, /unlocks/i);
});

test("deleting a blocked task closes its dependency and clears the restore marker", async () => {
  const { app, task, prerequisite, rows } = mountApp();
  const created = await request(app, "/api/waiting-items", "POST", { properties: {
    kind: "delegated_item", blockerType: "task",
    blockerBlockId: prerequisite.id, linkedBlockId: task.id,
    title: prerequisite.properties.title, myTask: task.properties.title,
  } });
  assert.equal(created.status, 200);
  const deleted = await request(app, `/api/blocks/${task.id}`, "DELETE");
  assert.equal(deleted.status, 200);
  assert.equal(rows.get(created.body.id).properties.status, "done");
  assert.equal(rows.get(created.body.id).properties.closureReason, "dependent-deleted");
  assert.equal("dependencyWaitingItemId" in task.properties, false);
});

test("batch deletion enforces prerequisite protection and dependent cleanup", async () => {
  const { app, task, prerequisite, rows, batches } = mountApp();
  const created = await request(app, "/api/waiting-items", "POST", { properties: {
    kind: "delegated_item", blockerType: "task",
    blockerBlockId: prerequisite.id, linkedBlockId: task.id,
    title: prerequisite.properties.title, myTask: task.properties.title,
  } });
  assert.equal(created.status, 200);

  const refused = await request(app, "/api/blocks/batch", "POST", {
    operations: [{ op: "delete", id: prerequisite.id }],
  });
  assert.equal(refused.status, 409);
  assert.equal(prerequisite.deleted_at, undefined);

  const deleted = await request(app, "/api/blocks/batch", "POST", {
    operations: [{ op: "delete", id: task.id }],
  });
  assert.equal(deleted.status, 200);
  assert.equal(rows.get(created.body.id).properties.status, "done");
  assert.equal("dependencyWaitingItemId" in task.properties, false);
  assert.ok(batches[0].some(op => op.op === "update" && op.id === created.body.id));
  assert.ok(batches[0].some(op => op.op === "delete" && op.id === task.id));
});

test("generic block surfaces cannot bypass task dependency validation", async () => {
  const { app, task, prerequisite } = mountApp();
  const properties = {
    kind: "delegated_item", blockerType: "task",
    blockerBlockId: prerequisite.id, linkedBlockId: task.id,
    title: prerequisite.properties.title, myTask: task.properties.title,
  };
  const rawCreate = await request(app, "/api/blocks", "POST", {
    type: "block", date: null, properties,
  });
  assert.equal(rawCreate.status, 409);
  const stringCreate = await request(app, "/api/blocks", "POST", {
    type: "block", date: null, properties: JSON.stringify(properties),
  });
  assert.equal(stringCreate.status, 409);

  const created = await request(app, "/api/waiting-items", "POST", { properties });
  assert.equal(created.status, 200);
  const rawPatch = await request(app, `/api/blocks/${created.body.id}`, "PATCH", {
    properties: { ...created.body.properties, title: "Bypassed" },
  });
  assert.equal(rawPatch.status, 409);
  const stringPatch = await request(app, `/api/blocks/${task.id}`, "PATCH", {
    properties: JSON.stringify(properties),
  });
  assert.equal(stringPatch.status, 409);
  const stringBatch = await request(app, "/api/blocks/batch", "POST", {
    operations: [{ op: "update", id: task.id, properties: JSON.stringify(properties) }],
  });
  assert.equal(stringBatch.status, 409);
  const rawBatch = await request(app, "/api/blocks/batch", "POST", {
    operations: [{ op: "delete", id: created.body.id }],
  });
  assert.equal(rawBatch.status, 409);
});

// ── draft_items is a PUBLISH surface, so suppressions have to reach it ────────
//
// Sweep Suite's `dcc-waiting-checkins` source polls /api/waiting-items/attention every
// 15 minutes and hands each draft_items entry to draft-replies, which writes a real
// Gmail or Slack draft. The endpoint applied no suppressions, so handling a check-in in
// the DCC stopped the card on the day response and did nothing here: the sweep kept
// drafting replies to something already dealt with, four times an hour.
//
// The asymmetry is deliberate and load-bearing: draft_items is gated, `items` is not.
// `items` drives the Waiting sidebar's urgency display, where a still-open dependency
// should keep showing after its current check-in is handled. Suppression means "stop
// asking me to act", not "pretend the dependency is gone".

function suppressionBlock(triageId, key, reason = "done") {
  return {
    id: "sup-" + triageId,
    type: "block",
    workspace_id: MINE,
    created_at: "2026-08-14T12:00:00.000Z",
    properties: {
      kind: "triage_suppression",
      triage_id: triageId,
      key,
      itemTitle: "Check in: Launch plan",
      reason,
      at: "2026-08-14T12:00:00.000Z",
      active: true,
    },
  };
}

const DUE_TRIAGE_ID = "waiting-checkin:waiting-1:" + TODAY;
const DUE_KEY = "waiting_checkin|waiting:waiting-1:" + TODAY;

test("a handled check-in is withheld from draft_items so the sweep stops re-drafting it", async () => {
  const { app } = mountApp([suppressionBlock(DUE_TRIAGE_ID, DUE_KEY)]);
  const res = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.draft_items, [], "nothing left for draft-replies to act on");
  assert.equal(res.body.suppressed_draft_count, 1, "and the drop is reported, not silent");
});

test("the Waiting item still shows in items, because the dependency is still open", async () => {
  const { app } = mountApp([suppressionBlock(DUE_TRIAGE_ID, DUE_KEY)]);
  const res = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.equal(res.body.items.length, 1, "the sidebar must not lose a live dependency");
  assert.equal(res.body.items[0].id, "waiting-1");
  assert.equal(res.body.items[0].attentionScore, 100);
});

test("a suppression matching on the bare id alone is enough", async () => {
  // The two match arms exist because the composite key is built from fields the sweep
  // controls; the bare id is the client's handle and survives a reader changing shape.
  const { app } = mountApp([suppressionBlock(DUE_TRIAGE_ID, "")]);
  const res = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.deepEqual(res.body.draft_items, []);
});

test("a suppression matching on the composite key alone is enough", async () => {
  const { app } = mountApp([suppressionBlock("", DUE_KEY)]);
  const res = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.deepEqual(res.body.draft_items, []);
});

test("a suppression for a DIFFERENT cycle does not withhold the due one", async () => {
  // The id embeds the due date, so last cycle's record must not silence this cycle.
  const stale = "waiting-checkin:waiting-1:2026-08-07";
  const { app } = mountApp([suppressionBlock(stale, "waiting_checkin|waiting:waiting-1:2026-08-07")]);
  const res = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.equal(res.body.draft_items.length, 1, "this cycle is still owed a draft");
  assert.equal(res.body.draft_items[0].id, DUE_TRIAGE_ID);
  assert.equal(res.body.suppressed_draft_count, 0);
});

test("a suppression for a different Waiting item is ignored", async () => {
  const { app } = mountApp([suppressionBlock("waiting-checkin:waiting-9:" + TODAY, "waiting_checkin|waiting:waiting-9:" + TODAY)]);
  const res = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.equal(res.body.draft_items.length, 1);
});

test("a deactivated suppression stops withholding, so Undo restores the draft", async () => {
  const block = suppressionBlock(DUE_TRIAGE_ID, DUE_KEY);
  block.properties.active = false;
  const { app } = mountApp([block]);
  const res = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.equal(res.body.draft_items.length, 1, "an undone decision must re-offer the draft");
});

test("no suppressions at all behaves exactly as before", async () => {
  const { app } = mountApp();
  const res = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.equal(res.body.draft_items.length, 1);
  assert.equal(res.body.suppressed_draft_count, 0);
});

test("an unreadable suppression store offers everything rather than failing the sweep", async () => {
  // Best-effort, same contract as server.js buildDayResponse. A duplicate draft is a
  // smaller failure than a follow-up that silently never goes out. The store genuinely
  // throws here; asserting this against a healthy store would be a test that cannot fail.
  const { app } = mountApp(() => { throw new Error("postgres is down"); });
  const res = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.equal(res.status, 200, "the sweep read must not fail outright");
  assert.equal(res.body.draft_items.length, 1, "degrades to offering the draft");
  assert.equal(res.body.suppressed_draft_count, 0);
});
