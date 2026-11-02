const test = require("node:test");
const assert = require("node:assert/strict");
const Policy = require("./public/js/queue-policy");
const M = require("./lib/conversation-model");
const now = Date.parse("2026-11-02T12:00:00Z");
const live = (extra = {}) => ({
  work: { source: "codex", id: "synthetic-job", kind: "research" },
  phase: "working",
  reviewActions: [],
  execution: {
    state: "running",
    observedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 600000).toISOString()
  },
  ...extra
});
test("only bounded fresh explicit worker observations establish Background; cache expiry is read-only", () => {
  assert.equal(Policy.execution([live()], now).state, "running");
  for (const report of [
    live({ execution: undefined }),
    live({ phase: "paused" }),
    live({ execution: { ...live().execution, observedAt: new Date(now + 1).toISOString() } }),
    live({ execution: { ...live().execution, validUntil: new Date(now + 3600000).toISOString() } }),
    live({ work: {} })
  ])
    assert.notEqual(Policy.execution([report], now).state, "running");
  const item = {
    status: "background",
    delegated: [live()],
    task: { id: "a", properties: { actualMinutes: 13 } },
    note: "Keep context"
  };
  const before = structuredClone(item);
  assert.equal(Policy.presentation(item, now + 600000).status, "queued");
  assert.deepEqual(item, before);
  assert.equal(Policy.presentation({ ...item, status: "foreground" }, now + 600000).status, "foreground");
  assert.equal(Policy.execution([live({ execution: { state: "stopped" } })], now).state, "stopped");
  assert.equal(Policy.reviewRequested([live({ phase: "blocked", reviewActions: [] })]), false);
  assert.equal(Policy.reviewRequested([live({ phase: "blocked", reviewActions: ["Approve the draft"] })]), true);
});
test("worker evidence validation rejects unbounded, future and contradictory assertions", () => {
  const command = {
    action: "delegated-update",
    sourceEventId: "report",
    expectedRevision: 0,
    at: new Date(now).toISOString(),
    taskId: "a",
    delegation: { ...live(), sequence: 2, note: "Observed running process" }
  };
  assert.equal(M.command(command, now).delegation.execution.state, "running");
  for (const execution of [
    { state: "running", observedAt: command.at },
    { state: "running", observedAt: command.at, validUntil: new Date(now + 3600000).toISOString() },
    { state: "stopped", observedAt: command.at, validUntil: command.at },
    { state: "unknown", observedAt: new Date(now + 1).toISOString() }
  ])
    assert.throws(() => M.command({ ...command, delegation: { ...command.delegation, execution } }, now));
  assert.throws(() => M.command({ ...command, delegation: { ...command.delegation, phase: "paused" } }, now));
});
test(
  "queue liveness, return, attention and exclusive foreground preserve identity and history",
  { skip: !process.env.DCC_TEST_DATABASE_URL },
  async (t) => {
    const ctx = await require("./test-support/activity-db").createActivityDb();
    t.after(() => ctx.close());
    const { createConversationStore, FOREGROUND_INDEX_SQL } = require("./conversation-store");
    await ctx.pool.query(FOREGROUND_INDEX_SQL);
    let clock = now,
      sequence = 0;
    const owner = { userId: 1, workspaceId: "ws-1" },
      store = createConversationStore({ ...ctx, enabled: true, now: () => clock });
    const old = process.env.DCC_CONVERSATION_ENABLED;
    process.env.DCC_CONVERSATION_ENABLED = "true";
    t.after(() => {
      if (old === undefined) delete process.env.DCC_CONVERSATION_ENABLED;
      else process.env.DCC_CONVERSATION_ENABLED = old;
    });
    const send = async (action, taskId, extra = {}) =>
      store.execute(
        {
          action,
          taskId,
          sourceEventId: "policy:" + sequence++,
          expectedRevision: (await store.state(owner)).revision,
          at: new Date(clock).toISOString(),
          ...extra
        },
        owner
      );
    const entry = async (id) => (await store.state(owner)).queue.items.find((row) => row.task.id === id);
    for (const id of ["a", "b", "c"]) {
      await ctx.blockDB.createBlock({
        id,
        type: "block",
        user_id: 1,
        workspace_id: "ws-1",
        date: null,
        properties: {
          type: "task",
          title: id,
          status: "open",
          actualMinutes: 17,
          notes: "Keep notes",
          taskPriority: "High"
        }
      });
      await send("queue-add", id);
    }
    await send("queue-note", "b", { note: "Keep queue context" });
    const taskBefore = await ctx.blockDB.getBlock("b");
    await send("delegated-register", "b", {
      delegation: { ...live(), sequence: 1, note: "Running an isolated job", intent: "explicit-work-handoff" }
    });
    assert.equal((await entry("b")).status, "background");
    await assert.rejects(
      send("reconcile", "b", {
        reconciliation: {
          choice: "done",
          outcome: "Reported done",
          expectedTaskVersion: require("./lib/task-reconciliation").version(await ctx.blockDB.getBlock("b"))
        }
      }),
      /Pause active work/
    );
    await assert.rejects(send("queue-return", "b"), /still reports running/);
    const snapshotBefore = (await ctx.pool.query("SELECT state FROM work_rotations")).rows;
    clock += 600001;
    assert.equal((await entry("b")).status, "queued");
    assert.equal((await entry("b")).execution.state, "stale");
    assert.deepEqual(
      (await ctx.pool.query("SELECT state FROM work_rotations")).rows,
      snapshotBefore,
      "expiry never rewrites saved history"
    );
    const command = {
      action: "queue-return",
      taskId: "b",
      sourceEventId: "return-once",
      expectedRevision: (await store.state(owner)).revision,
      at: new Date(clock).toISOString()
    };
    await store.execute(command, owner);
    assert.equal((await store.execute(command, owner)).duplicate, true);
    await assert.rejects(store.execute({ ...command, sourceEventId: "stale-return" }, owner), { statusCode: 409 });
    assert.deepEqual((await store.state(owner)).queue.order, ["a", "b", "c"]);
    assert.equal((await entry("b")).note, "Keep queue context");
    assert.deepEqual((await ctx.blockDB.getBlock("b")).properties, taskBefore.properties);
    await send("delegated-update", "b", {
      delegation: {
        ...live({
          phase: "blocked",
          execution: { state: "stopped", observedAt: new Date(clock).toISOString() },
          reviewActions: ["Approve the next step"]
        }),
        sequence: 2,
        note: "Waiting for approval"
      }
    });
    assert.equal((await entry("b")).needsYou, true);
    await assert.rejects(send("queue-return", "b"), /Resolve the review/);
    await send("delegated-update", "b", {
      delegation: {
        ...live({ phase: "paused", execution: { state: "stopped", observedAt: new Date(clock).toISOString() } }),
        sequence: 3,
        note: "Review resolved; job stopped"
      }
    });
    await send("queue-return", "b");
    await send("background-start", "b", { remindMinutes: 5 });
    assert.equal((await entry("b")).status, "queued", "setting aside never proves worker execution");
    const due = (await entry("b")).dueAt;
    await send("queue-return", "b");
    assert.equal((await entry("b")).dueAt, due, "future manual reminder preserved");
    clock += 300001;
    assert.equal((await entry("b")).needsYou, true, "manual check-back reaches attention while inactive");
    await assert.rejects(send("queue-return", "b"), /Resolve the review/);
    await send("queue-dismiss", "b", { generation: (await entry("b")).generation });
    await send("queue-return", "b");
    await send("start", "a");
    clock += 60000;
    await send("start", "c");
    assert.deepEqual(
      (await store.state(owner)).foreground.map((row) => row.id),
      ["c"]
    );
    await assert.rejects(send("queue-return", "c"), /Pause foreground/);
    assert.equal((await entry("a")).status, "queued");
    assert.equal((await ctx.blockDB.getBlock("b")).properties.notes, "Keep notes");
  }
);
