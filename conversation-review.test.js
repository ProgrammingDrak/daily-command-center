const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createBudget, createIngress } = require("./lib/conversation-limits");
const { createActivityDb } = require("./test-support/activity-db");
const { createConversationStore, FOREGROUND_INDEX_SQL } = require("./conversation-store");

test("bounded ingress rejects floods before database/session work and ignores identity headers", () => {
  let time = 0;
  const budget = createBudget({ limit: 2, maxKeys: 2, windowMs: 1000, now: () => time });
  assert.equal(budget("a"), true);
  assert.equal(budget("a"), true);
  assert.equal(budget("a"), false);
  assert.equal(budget("b"), true);
  assert.equal(budget("c"), false);
  time = 1001;
  assert.equal(budget("c"), true);
  const ingress = createIngress({ peer: { limit: 2 }, global: { limit: 5 } });
  let dbCalls = 0,
    rejected = 0;
  const res = {
    status(n) {
      assert.equal(n, 429);
      rejected++;
      return this;
    },
    set() {
      return this;
    },
    json() {}
  };
  for (let i = 0; i < 20; i++)
    ingress(
      { path: i % 2 ? "/OAUTH/DCC/TOKEN/" : "/oauth/dcc/token", ip: "127.0.0.1", headers: { "x-user-id": String(i) } },
      res,
      () => dbCalls++
    );
  assert.equal(dbCalls, 2);
  assert.equal(rejected, 18);
});

test(
  "review regressions: corrections, descendants, existing clients and lock order",
  {
    skip: !process.env.DCC_TEST_DATABASE_URL && !process.env.DCC_PGLITE_MODULE
  },
  async (t) => {
    const ctx = await createActivityDb();
    t.after(() => ctx.close());
    await ctx.pool.query(FOREGROUND_INDEX_SQL);
    const owner = { userId: 1, workspaceId: "ws-1" },
      store = createConversationStore(ctx);
    const make = (id, props = {}) =>
      ctx.blockDB.createBlock({
        id,
        type: "block",
        user_id: 1,
        workspace_id: "ws-1",
        date: "2026-10-21",
        properties: { local_id: id, type: "task", title: id, status: "open", ...props }
      });
    let event = 0;
    const exec = async (action, taskId, at, extra = {}) =>
      store.execute(
        {
          action,
          taskId,
          at,
          sourceEventId: "review-" + ++event,
          expectedRevision: (await store.state(owner)).revision,
          ...extra
        },
        owner
      );
    await t.test("reallocation preserves unsegmented actuals and publishes every changed task", async () => {
      await make("source");
      await make("destination", { actualMinutes: 90 });
      await exec("start", "source", "2026-10-21T13:00:00Z");
      await exec("pause", "source", "2026-10-21T13:20:00Z");
      const source = (await store.get("source", owner)).sessions[0];
      const result = await store.execute(
        {
          action: "correct",
          at: "2026-10-21T13:21:00Z",
          sourceEventId: "review-correction",
          expectedRevision: (await store.state(owner)).revision,
          entryId: source.id,
          reason: "User corrected selected task",
          parts: [
            { kind: "focused", taskId: "destination", start: "2026-10-21T13:00:00Z", end: "2026-10-21T13:20:00Z" }
          ]
        },
        owner
      );
      assert.equal((await store.get("destination", owner)).task.properties.actualMinutes, 110);
      assert.equal((await store.get("source", owner)).task.properties.actualMinutes, undefined);
      assert.deepEqual(result.affectedTasks.map((r) => r.id).sort(), ["destination", "source"]);
    });
    await t.test("parent completion bounds descendant focus, closes background and reports all children", async () => {
      await make("parent");
      await make("child", { subtaskOf: "parent" });
      await make("child-background", { subtaskOf: "parent", estimatedMinutes: 90 });
      await exec("background-start", "child-background", "2026-10-21T14:00:00Z");
      await exec("start", "child", "2026-10-21T15:00:00Z");
      const result = await exec("done", "parent", "2026-10-21T17:00:00Z");
      assert.equal((await store.get("child", owner)).task.properties.actualMinutes, 50);
      assert.equal(result.uncertainIntervals[0].start, "2026-10-21T15:50:00.000Z");
      assert.equal(result.uncertainIntervals[0].end, "2026-10-21T17:00:00Z");
      assert.equal(result.state.background.length, 0);
      assert.deepEqual(result.affectedTasks.map((r) => r.id).sort(), ["child", "child-background", "parent"]);
      assert.equal((await store.get("child-background", owner)).task.properties.actualTimeUnknown, true);
    });
    await t.test("external completion and deletion hide stale background rows", async () => {
      await make("external");
      await exec("background-start", "external", "2026-10-21T18:00:00Z");
      await ctx.blockDB.setTaskCompletion({
        taskRef: "external",
        completed: true,
        mutationId: "external-complete",
        userId: 1,
        workspaceId: "ws-1"
      });
      assert.equal((await store.state(owner)).background.length, 0);
      await make("deleted");
      await exec("background-start", "deleted", "2026-10-21T18:01:00Z");
      await ctx.blockDB.deleteBlock("deleted");
      assert.equal((await store.state(owner)).background.length, 0);
    });
    await t.test("calendar snapshots and materialized meetings share canonical event identity", async () => {
      await ctx.pool.query(
        "INSERT INTO dcc_state(date,user_id,workspace_id,state_json,updated_at) VALUES($1,$2,$3,$4,NOW())",
        [
          "2026-10-21",
          1,
          "ws-1",
          { meetings: [{ event_id: "event-canonical", source_id: "legacy-source", title: "Review meeting" }] }
        ]
      );
      await make("meeting-block", { type: "meeting", source_id: "event-canonical", title: "Review meeting" });
      const events = await store.calendarEvents({ date: "2026-10-21" }, owner);
      assert.equal(events.events.length, 1);
      assert.equal(events.events[0].calendarEventId, "event-canonical");
    });
    await t.test("late continuation starts a fresh session and remains pausable", async () => {
      await make("late-continue");
      await exec("start", "late-continue", "2026-10-22T00:00:00Z");
      const result = await exec("continue", "late-continue", "2026-10-22T09:00:00Z");
      assert.equal(result.task.properties.startedAt, "2026-10-22T09:00:00.000Z");
      assert.equal(result.task.properties.actualMinutes, 50);
      assert.equal(result.uncertainIntervals[0].start, "2026-10-22T00:50:00.000Z");
      const paused = await exec("pause", "late-continue", "2026-10-22T09:10:00Z");
      assert.equal(paused.task.properties.actualMinutes, 60);
      assert.equal(paused.state.foreground.length, 0);
      assert.ok(paused.entries.some((row) => row.properties.durSec === 600));
    });
    await t.test(
      "legacy reconciliation returns newly closed sessions in its first read and preserves plans",
      async () => {
        const previous = process.env.DCC_CONVERSATION_ENABLED;
        process.env.DCC_CONVERSATION_ENABLED = "true";
        try {
          await make("reconcile-review", { estimatedMinutes: 90, start: "09:00", end: "10:30" });
          await exec("start", "reconcile-review", "2026-10-23T13:00:00Z");
          await ctx.blockDB.setTaskCompletion({
            taskRef: "reconcile-review",
            completed: true,
            completedAt: "2026-10-23T13:30:00Z",
            mutationId: "review-reconcile-done",
            userId: 1,
            workspaceId: "ws-1"
          });
          const rows = [await ctx.blockDB.getBlock("reconcile-review")];
          const timing = require("./lib/task-timing")({ ...ctx });
          assert.equal(await timing.reconcileTiming(rows, owner), 1);
          assert.equal(rows[0].properties.actualMinutes, 30);
          assert.equal(rows[0].properties.estimatedMinutes, 90);
          assert.ok(rows.some((row) => row.type === "time_entry" && row.properties.durSec === 1800));
        } finally {
          if (previous === undefined) delete process.env.DCC_CONVERSATION_ENABLED;
          else process.env.DCC_CONVERSATION_ENABLED = previous;
        }
      }
    );
    await t.test("enabled legacy completion never infers planned effort; guided locks account first", async () => {
      const previous = process.env.DCC_CONVERSATION_ENABLED;
      process.env.DCC_CONVERSATION_ENABLED = "true";
      try {
        const timing = require("./lib/task-timing")({ ...ctx });
        const item = await make("legacy-unmeasured", { estimatedMinutes: 90 });
        await timing.completeWork({ block: item, atMs: Date.parse("2026-10-21T19:00:00Z"), actionId: "legacy-done" });
        assert.equal(item.properties.actualMinutes, undefined);
        assert.equal(item.properties.actualTimeUnknown, true);
        const { createGuidedStore } = require("./guided-store");
        const guided = createGuidedStore(ctx);
        const definition = await guided.saveDefinition(
          {
            id: crypto.randomUUID(),
            expectedRevision: 0,
            definition: {
              title: "Review guided",
              goal: "Check integration",
              starterPrompt: "Use synthetic data",
              completionCriteria: "Confirmed outcome",
              checklist: []
            }
          },
          owner
        );
        const view = await guided.createTask(
          { id: crypto.randomUUID(), definitionId: definition.id, date: "2026-10-21" },
          owner
        );
        const trace = [],
          original = ctx.pool.connect;
        ctx.pool.connect = async () => {
          const q = await original.call(ctx.pool);
          const query = q.query.bind(q);
          q.query = (sql, args) => {
            trace.push(String(sql));
            return query(sql, args);
          };
          return q;
        };
        try {
          const result = await guided.act(
            view.taskId,
            {
              action: "start",
              operationId: crypto.randomUUID(),
              expectedRevision: view.revision,
              expectedDefinitionRevision: view.definitionRevision,
              expectedContextVersion: view.contextVersion
            },
            owner
          );
          assert.equal(result.session.state, "active");
          const advisory = trace.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
          const rowLock = trace.findIndex((sql) => sql.includes("FOR UPDATE"));
          assert.ok(advisory >= 0 && rowLock > advisory, "all guided row locks follow the account lock");
        } finally {
          ctx.pool.connect = original;
        }
      } finally {
        if (previous === undefined) delete process.env.DCC_CONVERSATION_ENABLED;
        else process.env.DCC_CONVERSATION_ENABLED = previous;
      }
    });
  }
);
