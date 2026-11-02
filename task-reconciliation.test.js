const test = require("node:test"),
  assert = require("node:assert/strict");
const { createActivityDb } = require("./test-support/activity-db");
const { createConversationStore, FOREGROUND_INDEX_SQL } = require("./conversation-store");
const R = require("./lib/task-reconciliation");
const configured = !!process.env.DCC_TEST_DATABASE_URL;
test("explicit task reconciliation through the real coordinator and PostgreSQL", { skip: !configured }, async (t) => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  await ctx.pool.query(FOREGROUND_INDEX_SQL);
  const owner = { userId: 1, workspaceId: "ws-1" },
    store = createConversationStore(ctx);
  let n = 0;
  const make = (id, properties = {}, extra = {}) =>
    ctx.blockDB.createBlock({
      id,
      type: "block",
      date: "2026-11-01",
      user_id: 1,
      workspace_id: "ws-1",
      properties: { type: "task", title: id, notes: "Keep notes", actualMinutes: 17, status: "open", ...properties },
      ...extra
    });
  const read = (id) => ctx.blockDB.getBlockIncludingDeleted(id);
  const envelope = async (id, choice, extra = {}) => ({
    action: "reconcile",
    sourceEventId: "message:" + ++n,
    expectedRevision: (await store.state(owner)).revision,
    at: "2026-11-02T12:00:00Z",
    taskId: id,
    reconciliation: { choice, expectedTaskVersion: R.version(await read(id)), ...extra }
  });
  const act = async (id, choice, extra = {}) => store.execute(await envelope(id, choice, extra), owner);
  await t.test("done is durable and idempotent, preserves notes, effort and report-time uncertainty", async () => {
    await make("done");
    const b = await envelope("done", "done", { outcome: "Called the card companies" });
    const result = await store.execute(b, owner);
    assert.equal(result.saveStatus, "verified_saved");
    const row = await read("done");
    assert.equal(row.properties.status, "done");
    assert.equal(row.properties.notes, "Keep notes");
    assert.equal(row.properties.actualMinutes, 17);
    assert.equal(row.properties.completionTimeKnown, false);
    assert.equal((await store.execute(b, owner)).duplicate, true);
    await assert.rejects(
      () => store.execute({ ...b, reconciliation: { ...b.reconciliation, outcome: "Different" } }, owner),
      /already used/
    );
    const undo = await act("done", "undo", { undoEventId: b.sourceEventId });
    assert.equal(undo.saveStatus, "verified_saved");
    assert.equal((await read("done")).properties.done, undefined);
    const replay = await store.execute(b, owner);
    assert.equal(replay.saveStatus, "stale_conflict");
    assert.notEqual((await read("done")).properties.status, "done");
  });
  await t.test("meaningful progress closes one iteration and creates exactly one linked successor", async () => {
    await make("iteration", { title: "Fix DnD delete buttons", estimatedMinutes: 90 });
    const b = await envelope("iteration", "step_done", {
      outcome: "Reproduced the constraint failure and narrowed the cause",
      completedTitle: "Investigate delete failure",
      nextStep: {
        title: "Fix the identified delete constraint",
        summary: "Update deletion order and run regression checks"
      }
    });
    const result = await store.execute(b, owner);
    assert.equal(result.saveStatus, "verified_saved");
    assert.equal(result.reconciliation.broaderGoalComplete, false);
    const next = await read(result.task.properties.nextStepId);
    assert.equal(next.properties.previousStepId, "iteration");
    assert.equal(next.properties.remainingWork, "Update deletion order and run regression checks");
    assert.equal(next.properties.goalId, "iteration");
    assert.equal(next.properties.actualMinutes, undefined);
    assert.equal(next.properties.estimatedMinutes, undefined);
    assert.equal(next.date, null);
    assert.equal(next.properties.publicVisibility, "private");
    const before = await read("iteration");
    assert.equal(before.properties.originalGoal, "Fix DnD delete buttons");
    assert.equal(before.properties.actualMinutes, 17);
    await store.execute(b, owner);
    assert.equal(
      (await ctx.pool.query("SELECT count(*)::int AS n FROM blocks WHERE properties->>'previousStepId'='iteration'"))
        .rows[0].n,
      1
    );
    await act("iteration", "undo", { undoEventId: b.sourceEventId });
    assert.equal((await read("iteration")).properties.title, "Fix DnD delete buttons");
    assert.ok((await read(next.id)).deleted_at);
  });
  await t.test("existing successor is linked, not duplicated, and undo preserves it", async () => {
    await make("existing-origin", {}, { date: null });
    await make("existing-next", {}, { date: null });
    const result = await act("existing-origin", "step_done", {
      outcome: "A useful iteration finished",
      completedTitle: "Completed iteration",
      nextStep: {
        taskId: "existing-next",
        expectedTaskVersion: R.version(await read("existing-next")),
        summary: "Finish the remaining integration"
      }
    });
    assert.deepEqual(result.reconciliation.createdIds, []);
    assert.equal((await read("existing-next")).properties.previousStepId, "existing-origin");
    await act("existing-origin", "undo", { undoEventId: result.sourceEventId });
    assert.equal((await read("existing-next")).properties.previousStepId, undefined);
    assert.equal((await read("existing-next")).deleted_at, null);
  });
  await t.test("partial scope never cascades into children; a selected child preserves parent", async () => {
    await make("parent");
    await make("child", { subtaskOf: "parent" });
    await assert.rejects(() => act("parent", "done", { outcome: "Some progress" }), /concrete completed subtask/);
    await act("child", "done", { outcome: "Child done" });
    assert.equal((await read("parent")).properties.status, "open");
    const childBefore = await read("child");
    await act("parent", "done", { outcome: "All scope now finished" });
    assert.deepEqual((await read("child")).properties, childBefore.properties);
  });
  await t.test(
    "recurring progress keeps the occurrence/definition open with child iteration and next action",
    async () => {
      await ctx.blockDB.createBlock({
        id: "definition",
        type: "block",
        date: null,
        user_id: 1,
        workspace_id: "ws-1",
        properties: {
          kind: "responsibility_item",
          title: "Weekly cleanup",
          status: "active",
          openInstanceBlockId: "occurrence"
        }
      });
      const definition = await read("definition");
      await make("occurrence", { responsibilityId: "definition" });
      const result = await act("occurrence", "step_done", {
        outcome: "Sorted one room",
        completedTitle: "Sort the first room",
        nextStep: { title: "Sort the next room", summary: "Continue the same cleanup in the study" }
      });
      assert.equal((await read("occurrence")).properties.status, "open");
      assert.deepEqual((await read("definition")).properties, definition.properties);
      assert.equal(result.reconciliation.createdIds.length, 2);
      const children = await ctx.blockDB.getSubtree(["occurrence"], "ws-1");
      assert.equal(children.filter((r) => r.properties.done).length, 1);
      await act("occurrence", "undo", { undoEventId: result.sourceEventId });
      assert.equal((await ctx.blockDB.getSubtree(["occurrence"], "ws-1")).length, 1);
      await assert.rejects(() => act("definition", "drop"), /canonical task occurrence/);
    }
  );
  await t.test("drop is a reversible occurrence tombstone, never a completion or effort change", async () => {
    await make("drop", { responsibilityId: "definition" });
    const result = await act("drop", "drop");
    assert.equal(result.saveStatus, "verified_saved");
    assert.ok((await read("drop")).deleted_at);
    assert.equal((await read("drop")).properties.actualMinutes, 17);
    assert.notEqual((await read("drop")).properties.status, "done");
    await act("drop", "undo", { undoEventId: result.sourceEventId });
    assert.equal((await read("drop")).deleted_at, null);
  });
  await t.test("stale task or successor, concurrent choices and later undo conflicts refuse overwrites", async () => {
    await make("concurrent");
    const a = await envelope("concurrent", "done", { outcome: "Finished" }),
      b = { ...a, sourceEventId: "other-message" };
    const settled = await Promise.allSettled([store.execute(a, owner), store.execute(b, owner)]);
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
    const winner = settled.find((r) => r.status === "fulfilled").value;
    const row = await read("concurrent");
    await ctx.blockDB.updateBlock(row.id, { properties: { ...row.properties, notes: "New note" } });
    await assert.rejects(() => act("concurrent", "undo", { undoEventId: winner.sourceEventId }), /Task changed/);
    await make("stale");
    const stale = await envelope("stale", "drop");
    await ctx.blockDB.updateBlock("stale", { properties: { ...(await read("stale")).properties, title: "Renamed" } });
    await assert.rejects(() => store.execute(stale, owner), /Task changed/);
    await make("stale-successor", {}, { date: null });
    await make("stale-origin", {}, { date: null });
    const split = await envelope("stale-origin", "step_done", {
      outcome: "Progress",
      completedTitle: "Progress made",
      nextStep: {
        taskId: "stale-successor",
        expectedTaskVersion: R.version(await read("stale-successor")),
        summary: "Next"
      }
    });
    await ctx.blockDB.updateBlock("stale-successor", {
      properties: { ...(await read("stale-successor")).properties, notes: "Changed" }
    });
    await assert.rejects(() => store.execute(split, owner), /Task changed/);
    assert.equal((await read("stale-origin")).properties.status, "open");
  });
  await t.test(
    "failure after successor creation or completion rolls back all records; exact retry recovers",
    async () => {
      for (const failure of ["after-create", "after-complete"]) {
        await make(failure);
        const b = await envelope(failure, "step_done", {
          outcome: "Made meaningful progress",
          completedTitle: "Progress recorded",
          nextStep: { title: "Continue next iteration", summary: "Do the remaining work" }
        });
        const create = ctx.blockDB.createBlock,
          complete = ctx.blockDB.setTaskCompletion;
        if (failure === "after-create")
          ctx.blockDB.createBlock = async (...args) => {
            await create(...args);
            throw new Error("Injected after create");
          };
        else
          ctx.blockDB.setTaskCompletion = async (...args) => {
            await complete(...args);
            throw new Error("Injected after complete");
          };
        try {
          await assert.rejects(() => store.execute(b, owner), /Injected/);
        } finally {
          ctx.blockDB.createBlock = create;
          ctx.blockDB.setTaskCompletion = complete;
        }
        assert.equal((await read(failure)).properties.status, "open");
        assert.equal(
          (
            await ctx.pool.query("SELECT count(*)::int AS n FROM blocks WHERE properties->>'previousStepId'=$1", [
              failure
            ])
          ).rows[0].n,
          0
        );
        assert.equal((await store.execute(b, owner)).saveStatus, "verified_saved");
      }
    }
  );
  await t.test("stale generic property saves preserve outcome and lineage", async () => {
    await make("offline");
    const stale = (await read("offline")).properties;
    const result = await act("offline", "step_done", {
      outcome: "Progress persisted",
      completedTitle: "Iteration finished",
      nextStep: { title: "Next concrete action", summary: "Remaining work" }
    });
    await ctx.blockDB.updateBlock("offline", { properties: { ...stale, notes: "Independent edit" } });
    const current = await read("offline");
    assert.equal(current.properties.completionOutcome, "Progress persisted");
    assert.equal(current.properties.nextStepId, result.task.properties.nextStepId);
    assert.equal(current.properties.notes, "Independent edit");
  });
  await t.test("progress on a prerequisite preserves the blocked goal and dependency", async () => {
    await make("prerequisite");
    await ctx.blockDB.createBlock({
      id: "waiting-link",
      type: "block",
      user_id: 1,
      workspace_id: "ws-1",
      date: null,
      properties: { kind: "delegated_item", blockerType: "task", blockerBlockId: "prerequisite", status: "open" }
    });
    const result = await act("prerequisite", "step_done", {
      outcome: "Made useful progress",
      completedTitle: "Prerequisite iteration",
      nextStep: { title: "Continue prerequisite", summary: "Finish remaining prerequisite scope" }
    });
    assert.equal(result.saveStatus, "verified_saved");
    assert.equal((await read("prerequisite")).properties.status, "open");
    assert.equal((await read("waiting-link")).properties.status, "open");
  });
  await t.test("uncertain postcommit readback never reports saved; replay verifies without writing again", async () => {
    await make("uncertain");
    const b = await envelope("uncertain", "done", { outcome: "Done" }),
      originalQuery = ctx.pool.query.bind(ctx.pool);
    ctx.pool.query = async (sql, args) => {
      if (String(sql).startsWith("SELECT * FROM blocks WHERE id=$1 AND user_id=$2"))
        throw new Error("Readback unavailable");
      return originalQuery(sql, args);
    };
    try {
      assert.equal((await store.execute(b, owner)).saveStatus, "save_uncertain");
    } finally {
      ctx.pool.query = originalQuery;
    }
    const retry = await store.execute(b, owner);
    assert.equal(retry.saveStatus, "verified_saved");
    assert.equal(retry.duplicate, true);
  });
  await t.test("review is deterministic, timezone aware and interrupted choices persist", async () => {
    await make("review-first");
    await make("review-second");
    const a = await store.completionReview({ date: "2026-11-01" }, owner),
      b = await store.completionReview({ date: "2026-11-01" }, owner);
    assert.deepEqual(a, b);
    assert.equal(R.localDate("2026-11-02T02:00:00Z"), "2026-11-01");
    const picked = a.candidates[0];
    assert.ok(picked.choices.includes("step_done"));
    await act(picked.taskId, "still_working", { reviewDate: "2026-11-01" });
    const next = await store.completionReview({ date: "2026-11-01" }, owner);
    assert.ok(!next.candidates.some((r) => r.taskId === picked.taskId));
    assert.equal((await read("review-second")).properties.status, "open");
    const later = await store.completionReview({ date: "2026-11-02" }, owner);
    assert.ok(later.candidates.some((r) => r.taskId === picked.taskId));
  });
  await t.test(
    "ambiguous references, cross-account access, active work and invalid envelopes fail closed",
    async () => {
      await make("alias-a", { local_id: "same", title: "Ambiguous" });
      await make("alias-b", { local_id: "same", title: "Ambiguous" });
      await assert.rejects(() => store.get("same", owner), /Ambiguous/);
      assert.equal((await store.search({ query: "Ambiguous" }, owner)).tasks.length, 2);
      await assert.rejects(() => store.completionReview({}, { userId: 2, workspaceId: "ws-1" }), /owner access/);
      await make("active", { startedAt: "2026-11-02T11:00:00Z" });
      await assert.rejects(() => act("active", "done", { outcome: "Done" }), /Pause active work/);
      const cmd = await envelope("review-second", "step_done", {
        outcome: "Progress",
        completedTitle: "Progress",
        nextStep: { title: "Next" }
      });
      await assert.rejects(() => store.execute(cmd, owner), /remaining work summary/);
    }
  );
});
