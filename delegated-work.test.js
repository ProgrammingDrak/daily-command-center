const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const M = require("./lib/conversation-model");
const { codingIdentity, createReporter } = require("./lib/delegated-work-adapter");
const uid = () => crypto.randomUUID(),
  owner = { userId: 1, workspaceId: "ws-1" };
const work = { source: "codex", id: "request:email-draft-1", kind: "email-draft" };
const report = (extra = {}) => ({
  work,
  sequence: 1,
  phase: "working",
  note: "Drafting the requested reply",
  reviewActions: [],
  ...extra
});
test("delegation requires explicit handoff, stable identity and bounded meaningful reports", () => {
  const base = {
    action: "delegated-register",
    sourceEventId: "event",
    expectedRevision: 0,
    at: "2026-10-26T12:00:00Z",
    delegation: report({ intent: "explicit-work-handoff", title: "Draft reply", createIfMissing: true })
  };
  assert.equal(M.command(base).action, "delegated-register");
  for (const d of [
    { intent: "question" },
    { sequence: 0 },
    { phase: "needs-review" },
    { note: "x".repeat(1001) },
    { work: { ...work, accountId: 2 } },
    { phase: "sent" }
  ])
    assert.throws(() => M.command({ ...base, delegation: { ...base.delegation, ...d } }));
  assert.throws(() => M.command({ ...base, action: "delegated-update" }));
  const coding = {
    source: "codex",
    repository: "org/repo",
    worktreeId: "stable-worktree-id",
    codingTaskId: "stable-thread-id"
  };
  assert.deepEqual(codingIdentity(coding), codingIdentity(coding));
  assert.notEqual(codingIdentity(coding).id, codingIdentity({ ...coding, codingTaskId: "new-thread" }).id);
});
test("reporter persists exact retries across resume and blocks a newer pending milestone", async () => {
  const saved = new Map(),
    calls = [];
  let lose = true,
    revision = 3;
  const journal = {
    load: async (k) => structuredClone(saved.get(k)),
    save: async (k, v) => saved.set(k, structuredClone(v)),
    clear: async (k) => saved.delete(k)
  };
  const callTool = async (name, args) => {
    if (name === "dcc_working_queue") return { revision: revision++ };
    calls.push(structuredClone(args));
    if (lose) {
      lose = false;
      throw new Error("response lost");
    }
    return { ok: true };
  };
  const event = {
    action: "delegated-register",
    sourceEventId: "stable-message",
    at: "2026-10-26T12:00:00Z",
    delegation: report({
      intent: "explicit-work-handoff",
      taskId: undefined,
      title: "Draft reply",
      createIfMissing: true
    })
  };
  delete event.delegation.taskId;
  await assert.rejects(
    createReporter({ callTool, journal, connectionId: "account-1:ws-1:grant-1" }).report(event),
    /response lost/
  );
  const resumed = createReporter({ callTool, journal, connectionId: "account-1:ws-1:grant-1" });
  await assert.rejects(resumed.report({ ...event, sourceEventId: "next" }), /pending lifecycle/);
  await resumed.report(event);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(saved.size, 0);
});
test("reporter retains the exact envelope when MCP returns a tool error", async () => {
  const saved = new Map();
  const calls = [];
  const journal = {
    load: async (k) => saved.get(k),
    save: async (k, v) => saved.set(k, v),
    clear: async (k) => saved.delete(k)
  };
  let denied = true;
  const reporter = createReporter({
    connectionId: "test",
    journal,
    callTool: async (name, args) => {
      if (name === "dcc_working_queue") return { structuredContent: { revision: 0 } };
      calls.push(structuredClone(args));
      return denied
        ? { isError: true, content: [{ type: "text", text: "Permission revoked" }] }
        : { structuredContent: { ok: true } };
    }
  });
  const input = {
    action: "delegated-register",
    sourceEventId: "event",
    at: "2026-10-26T12:00:00Z",
    delegation: report({ intent: "explicit-work-handoff", title: "Review draft", createIfMissing: true })
  };
  await assert.rejects(reporter.report(input), /Permission revoked/);
  assert.equal(saved.size, 1);
  denied = false;
  await reporter.report(input);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(saved.size, 0);
});
test(
  "delegated lifecycle is private, canonical, idempotent and never human effort",
  { skip: !process.env.DCC_TEST_DATABASE_URL && !process.env.DCC_PGLITE_MODULE },
  async (t) => {
    const ctx = await require("./test-support/activity-db").createActivityDb(),
      old = process.env.DCC_CONVERSATION_ENABLED;
    process.env.DCC_CONVERSATION_ENABLED = "true";
    t.after(async () => {
      if (old === undefined) delete process.env.DCC_CONVERSATION_ENABLED;
      else process.env.DCC_CONVERSATION_ENABLED = old;
      await ctx.close();
    });
    const { createConversationStore, FOREGROUND_INDEX_SQL } = require("./conversation-store");
    await ctx.pool.query(FOREGROUND_INDEX_SQL);
    const store = createConversationStore(ctx);
    let time = Date.now() - 3600000;
    const make = (id, extra = {}, who = owner) =>
      ctx.blockDB.createBlock({
        id,
        type: "block",
        user_id: who.userId,
        workspace_id: who.workspaceId,
        properties: { local_id: id, title: id, type: "task", kind: "backlog", status: "open", ...extra }
      });
    const command = async (action, delegation, extra = {}) => ({
      action,
      sourceEventId: uid(),
      expectedRevision: (await store.state(owner)).revision,
      at: new Date(time).toISOString(),
      delegation,
      ...extra
    });
    const send = async (action, delegation, extra = {}) =>
      store.execute(await command(action, delegation, extra), owner);
    await t.test("delegated reports have RLS and no public table grants", async () => {
      const privacy = (
        await ctx.pool.query("SELECT relrowsecurity,relacl FROM pg_class WHERE oid='delegated_work'::regclass")
      ).rows[0];
      assert.equal(privacy.relrowsecurity, true);
      assert.ok(!(privacy.relacl || []).some((acl) => acl.startsWith("=")), "PUBLIC receives no report privileges");
    });
    let id, registration;
    await t.test("create once, replay/resume one identity, background only and no invented schedule", async () => {
      registration = await command(
        "delegated-register",
        report({ intent: "explicit-work-handoff", createIfMissing: true, title: "Draft response for review" })
      );
      const result = await store.execute(registration, owner);
      id = result.task.id;
      assert.equal(result.delegated.created, true);
      assert.equal(result.state.foreground.length, 0);
      assert.equal(result.task.properties.startedAt, undefined);
      assert.equal(result.task.properties.actualMinutes, undefined);
      assert.equal(result.task.date, null);
      assert.equal(result.state.queue.items[0].status, "background");
      assert.equal((await store.execute(registration, owner)).duplicate, true);
      await send("delegated-register", registration.delegation);
      assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM delegated_work")).rows[0].n, 1);
      assert.equal(
        (await ctx.pool.query("SELECT count(*)::int AS n FROM blocks WHERE properties->>'source'='delegated-work'"))
          .rows[0].n,
        1
      );
    });
    await t.test("same draft revisions enter Needs You without sending or completing", async () => {
      time += 60000;
      const ready = report({
        sequence: 2,
        phase: "needs-review",
        note: "Draft revised with the requested figures; ready for review",
        reviewActions: ["Review the wording", "Send the email when approved"]
      });
      const result = await send("delegated-update", ready);
      assert.equal(result.task.id, id);
      assert.equal(result.task.properties.status, "open");
      assert.equal(result.state.queue.items[0].needsYou, true);
      assert.equal(result.state.queue.items[0].delegated[0].note, ready.note);
      assert.equal(
        result.task.properties.delegatedWork,
        undefined,
        "private reports never enter shareable task properties"
      );
      await assert.rejects(send("delegated-update", report({ sequence: 1 })), { statusCode: 409 });
      await assert.rejects(
        send("delegated-update", report({ sequence: 3, phase: "completed", note: "Draft finished" })),
        { statusCode: 409 }
      );
      const before = (await store.get(id, owner)).delegated[0];
      assert.equal(before.sequence, 2);
      assert.equal(before.phase, "needs-review");
      assert.ok(Date.parse(before.receivedAt) > Date.parse(before.at));
    });
    await t.test("human focus, context, removal and generic task edits survive progress", async () => {
      time += 60000;
      await store.execute(
        {
          action: "start",
          taskId: id,
          sourceEventId: uid(),
          expectedRevision: (await store.state(owner)).revision,
          at: new Date(time).toISOString()
        },
        owner
      );
      const start = (await ctx.blockDB.getBlock(id)).properties.startedAt;
      await send(
        "delegated-update",
        report({ sequence: 3, phase: "working", note: "Applying the requested wording change" })
      );
      assert.equal((await ctx.blockDB.getBlock(id)).properties.startedAt, start);
      assert.equal((await ctx.blockDB.getTaskTimeEntries(id, "ws-1")).length, 0);
      await ctx.blockDB.updateBlock(id, { properties: { title: "User edited title" } });
      assert.equal((await store.get(id, owner)).delegated[0].sequence, 3);
      time += 60000;
      await store.execute(
        {
          action: "pause",
          taskId: id,
          sourceEventId: uid(),
          expectedRevision: (await store.state(owner)).revision,
          at: new Date(time).toISOString()
        },
        owner
      );
      const actual = (await ctx.blockDB.getBlock(id)).properties.actualMinutes;
      await send(
        "delegated-update",
        report({
          sequence: 4,
          phase: "needs-review",
          note: "Revised draft is ready",
          reviewActions: ["Review and send"]
        })
      );
      assert.equal((await ctx.blockDB.getBlock(id)).properties.actualMinutes, actual);
    });
    await t.test("only confirmed whole-request completion permits lifecycle completed", async () => {
      time += 60000;
      await store.execute(
        {
          action: "done",
          taskId: id,
          sourceEventId: uid(),
          expectedRevision: (await store.state(owner)).revision,
          at: new Date(time).toISOString()
        },
        owner
      );
      const result = await send(
        "delegated-update",
        report({ sequence: 5, phase: "completed", note: "User confirmed the email was sent and request is complete" })
      );
      assert.equal(result.task.properties.status, "done");
      assert.equal(result.state.queue.items[0].needsYou, false);
      await assert.rejects(send("delegated-update", report({ sequence: 6 })), { statusCode: 409 });
    });
    await t.test(
      "link before create; duplicate titles, ambiguous relinks and foreign accounts fail closed",
      async () => {
        await make("existing");
        const identity = { ...work, id: "existing-work" };
        await assert.rejects(
          send(
            "delegated-register",
            report({ work: identity, intent: "explicit-work-handoff", createIfMissing: true, title: "existing" })
          ),
          { statusCode: 409 }
        );
        const linked = await send("delegated-register", report({ work: identity, intent: "explicit-work-handoff" }), {
          taskId: "existing"
        });
        assert.equal(linked.task.id, "existing");
        assert.equal(linked.delegated.created, false);
        await make("different");
        await assert.rejects(
          send("delegated-register", report({ work: identity, intent: "explicit-work-handoff" }), {
            taskId: "different"
          }),
          { statusCode: 409 }
        );
        await make("foreign", {}, { userId: 2, workspaceId: "ws-2" });
        await assert.rejects(
          send("delegated-register", report({ work: { ...work, id: "foreign" }, intent: "explicit-work-handoff" }), {
            taskId: "foreign"
          }),
          { statusCode: 404 }
        );
        await assert.rejects(
          store.execute(await command("delegated-update", report()), { userId: 3, workspaceId: "ws-1" }),
          { statusCode: 403 }
        );
        await ctx.blockDB.deleteBlock("existing");
        await assert.rejects(send("delegated-update", report({ work: identity, sequence: 2 })), { statusCode: 410 });
      }
    );
    await t.test("coding closed but deployment blocked remains Needs You, parent nesting stays explicit", async () => {
      await make("umbrella");
      const coding = codingIdentity({
        source: "codex",
        repository: "org/repo",
        worktreeId: "worktree-1",
        codingTaskId: "thread-1"
      });
      const first = await send(
        "delegated-register",
        report({
          work: coding,
          intent: "explicit-work-handoff",
          createIfMissing: true,
          title: "Implement the requested feature",
          parentTaskId: "umbrella"
        })
      );
      assert.equal(first.task.parent_id, "umbrella");
      time += 60000;
      const result = await send(
        "delegated-update",
        report({
          work: coding,
          sequence: 2,
          phase: "blocked",
          note: "Implementation and tests complete; deployment awaits verified backup",
          reviewActions: ["Provide or verify the production backup"]
        })
      );
      assert.equal(result.task.id, first.task.id);
      assert.equal(result.task.properties.status, "open");
      assert.equal(result.task.properties.actualMinutes, undefined);
      assert.equal(result.state.queue.items.find((i) => i.task.id === first.task.id).needsYou, true);
      const again = await send(
        "delegated-register",
        report({
          work: coding,
          sequence: 3,
          intent: "explicit-work-handoff",
          phase: "working",
          note: "Resumed review of the same worktree"
        })
      );
      assert.equal(again.task.id, first.task.id);
    });
  }
);
