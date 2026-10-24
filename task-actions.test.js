const test = require("node:test"),
  assert = require("node:assert/strict");
const policy = require("./public/js/task-action-policy"),
  store = require("./task-action-store");
test("task capabilities fail closed and never promote existing roles", () => {
  for (const role of ["viewer", "commenter", "coach", "manager", "none", "typo"])
    assert.deepEqual(Object.values(policy.resolve({ allowed: true, role })), Array(7).fill("view"));
  assert.equal(policy.valid({ edit: "execute" }), true);
  assert.equal(policy.valid({ edit: "admin" }), false);
  assert.equal(policy.valid({ grant: "execute" }), false);
  assert.equal(policy.resolve({ owner: true, allowed: true }).complete, "execute");
  assert.equal(policy.resolve({ owner: true, allowed: true, preview: true }).complete, "view");
  assert.equal(policy.resolve({ allowed: true, permissions: { edit: "suggest" } }).edit, "suggest");
  assert.equal(policy.resolve({ allowed: false, permissions: { edit: "execute" } }).edit, "view");
  assert.equal(policy.mode({ grant: "execute" }, "grant"), "view");
});
test("commands strip authority overrides and validate proposed values", () => {
  assert.deepEqual(store.validate("edit", { title: " New ", workspaceId: "ws-2", role: "owner", done: true }), {
    title: "New"
  });
  for (const payload of [
    { date: "2026-02-30", start: "09:00", end: "10:00" },
    { date: "2026-10-23", start: "10:00", end: "09:00" }
  ])
    assert.throws(() => store.validate("schedule", payload));
  assert.throws(() => store.validate("complete", { completed: "true" }));
  assert.throws(() => store.validate("react", { emoji: "x", active: true }));
});

test(
  "task actions enforce grants, suggestions, owner review and canonical task transitions",
  { skip: !process.env.DCC_TEST_DATABASE_URL && !process.env.DCC_PGLITE_MODULE },
  async (t) => {
    const ctx = await require("./test-support/activity-db").createActivityDb();
    t.after(ctx.close);
    Object.assign(ctx, {
      accessStore: require("./access-store"),
      socialStore: require("./social-store"),
      ...require("./lib/route-helpers"),
      getTodayStr: () => "2026-10-23",
      APP_TIME_ZONE: "UTC",
      getScheduleBlocks: async () => [],
      broadcast() {}
    });
    await require("./slot-store").ensureSchema();
    const app = require("express")();
    app.use(require("express").json());
    app.use((req, res, next) => {
      req.session = { userId: Number(req.headers["x-fixture-user"]) || undefined };
      req.workspaceId = "ws-1";
      next();
    });
    require("./routes/blocks")(app, ctx);
    require("./routes/task-actions")(app, ctx);
    const service = ctx.taskActionStore;
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => server.close());
    const http = async (path, { actor = 1, method = "GET", body } = {}) => {
      const r = await fetch("http://127.0.0.1:" + server.address().port + path, {
        method,
        headers: { "content-type": "application/json", "x-fixture-user": String(actor) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: r.status, body: await r.json() };
    };
    const mk = async (title = "Task", owner = 1) =>
      ctx.blockDB.createItineraryTask({
        date: "2026-10-23",
        workspaceId: "ws-" + owner,
        userId: owner,
        properties: { title, kind: "task", type: "task", start: "09:00", end: "09:30", duration: 30 }
      });
    const task = await mk(),
      foreign = await mk("Foreign", 2);
    assert.equal((await http("/api/task-view/self/access", { actor: 0 })).status, 401);
    assert.equal((await http("/api/task-view/1/tasks/" + task.id, { actor: 3 })).status, 403);
    const input = {
      actor: 3,
      owner: 1,
      taskId: task.id,
      action: "edit",
      payload: { title: "Proposal" },
      requestKey: "request-edit-000001"
    };
    await assert.rejects(service.submit(input), (e) => e.statusCode === 403);
    await ctx.pool.query("INSERT INTO access_grants(owner_user_id,grantee_user_id,role) VALUES(1,3,'manager')");
    await assert.rejects(service.submit(input), (e) => e.statusCode === 403);
    await ctx.pool.query("UPDATE access_grants SET task_permissions=$1", [
      {
        edit: "suggest",
        complete: "execute",
        schedule: "execute",
        delegate: "execute",
        react: "execute",
        bounty: "execute",
        reward: "execute"
      }
    ]);
    const suggestion = await service.submit(input);
    assert.equal(suggestion.status, "pending");
    assert.equal((await ctx.blockDB.getBlock(task.id)).properties.title, "Task");
    assert.equal((await service.submit(input)).id, suggestion.id);
    await assert.rejects(service.submit({ ...input, payload: { title: "Different" } }), (e) => e.statusCode === 409);
    await assert.rejects(
      service.decide({ actor: 3, owner: 1, id: suggestion.id, decision: "approve" }),
      (e) => e.statusCode === 403
    );
    const accepted = await service.decide({ actor: 1, owner: 1, id: suggestion.id, decision: "approve" });
    assert.equal(accepted.status, "applied");
    assert.equal((await ctx.blockDB.getBlock(task.id)).properties.title, "Proposal");
    assert.equal(
      (await service.decide({ actor: 1, owner: 1, id: suggestion.id, decision: "approve" })).status,
      "applied"
    );
    assert.equal((await ctx.blockDB.getBlock(task.id)).properties.start, "09:00");
    const rejected = await service.submit({ ...input, requestKey: "request-edit-reject" });
    assert.equal(
      (await service.decide({ actor: 1, owner: 1, id: rejected.id, decision: "reject" })).status,
      "rejected"
    );
    assert.equal((await ctx.blockDB.getBlock(task.id)).properties.title, "Proposal");
    const stale = await service.submit({ ...input, requestKey: "request-edit-stale-1" });
    const row = await ctx.blockDB.getBlock(task.id);
    await ctx.blockDB.updateBlock(task.id, { properties: { ...row.properties, title: "New owner title" } });
    await assert.rejects(
      service.decide({ actor: 1, owner: 1, id: stale.id, decision: "approve" }),
      (e) => e.statusCode === 409
    );
    await assert.rejects(
      service.submit({ ...input, taskId: foreign.id, requestKey: "request-foreign-001" }),
      (e) => e.statusCode === 404
    );
    const command = async (action, payload, key, id = task.id, actor = 3) =>
      service.submit({ actor, owner: 1, taskId: id, action, payload, requestKey: key });
    assert.equal(
      (await command("schedule", { date: "2026-10-24", start: "11:00", end: "11:30" }, "request-schedule-001")).status,
      "applied"
    );
    let updated = await ctx.blockDB.getBlock(task.id);
    assert.equal(updated.date, "2026-10-24");
    assert.equal(updated.properties.start, "11:00");
    assert.equal((await command("complete", { completed: true }, "request-complete-001")).status, "applied");
    assert.equal((await ctx.blockDB.getBlock(task.id)).properties.status, "done");
    assert.equal((await command("complete", { completed: false }, "request-reopen-00001")).status, "applied");
    const wait = await command("delegate", { who: "Synthetic supplier" }, "request-delegate-001");
    assert.equal(wait.status, "applied");
    assert.equal(wait.result.properties.delegatee.name, "Synthetic supplier");
    assert.equal((await ctx.blockDB.getBlock(task.id)).date, null);
    const waitingBefore = await ctx.blockDB.getBlock(wait.result.id);
    const parkedBefore = await ctx.blockDB.getBlock(task.id);
    await command('edit',{title:'Renamed Waiting task'},'rename-waiting-001',task.id,1);
    assert.deepEqual((await ctx.blockDB.getBlock(task.id)).properties,{...parkedBefore.properties,title:'Renamed Waiting task'});
    assert.equal((await ctx.blockDB.getBlock(task.id)).date,null);
    assert.deepEqual((await ctx.blockDB.getBlock(wait.result.id)).properties,{...waitingBefore.properties,myTask:'Renamed Waiting task'});
    const self = await mk("Self incentives");
    assert.equal(
      (await command("react", { emoji: "🔥", active: true }, "request-react-owner1", self.id, 1)).status,
      "applied"
    );
    assert.equal(
      (await command("react", { emoji: "🔥", active: true }, "request-react-owner2", self.id, 1)).status,
      "applied"
    );
    assert.equal((await ctx.pool.query("SELECT COUNT(*)::int AS n FROM todo_task_reactions")).rows[0].n, 1);
    assert.equal((await command("bounty", {}, "request-bounty-owner", self.id, 1)).status, "applied");
    await assert.rejects(command("bounty", {}, "request-bounty-twice", self.id, 1), (e) => e.statusCode === 409);
    const reward = await command("reward", { title: "A walk in the park" }, "request-reward-owner", self.id, 1);
    assert.equal(reward.status, "applied");

    const detail = await http("/api/task-view/self/tasks/" + self.id);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.task.completed, false);
    assert.equal(detail.body.task.properties.privateNotes, undefined);
    const forged = await http("/api/task-view/2/tasks/" + foreign.id + "/actions", {
      actor: 3,
      method: "POST",
      body: {
        action: "edit",
        payload: { title: "Stolen" },
        owner: 1,
        actor: 2,
        workspaceId: "ws-2",
        requestKey: "forged-owner-00001"
      }
    });
    assert.equal(forged.status, 403);
    const beforeTitle = (await ctx.blockDB.getBlock(self.id)).properties.title;
    assert.equal(
      (
        await http("/api/task-view/self/tasks/" + self.id + "/actions", {
          method: "POST",
          body: {
            action: "edit",
            payload: { title: "Stale" },
            expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
            requestKey: "stale-client-00001"
          }
        })
      ).status,
      409
    );
    assert.equal((await ctx.blockDB.getBlock(self.id)).properties.title, beforeTitle);
    const permission = await http("/api/access/grants/3/task-permissions", {
      method: "PUT",
      body: { permissions: { edit: "execute" } }
    });
    assert.equal(permission.status, 200);
    assert.equal(
      (
        await ctx.pool.query(
          "SELECT COUNT(*)::int AS n FROM access_grant_events WHERE event_type='task_permissions_changed'"
        )
      ).rows[0].n,
      1
    );
    assert.equal(
      (
        await http("/api/access/grants/3/task-permissions", {
          actor: 2,
          method: "PUT",
          body: { permissions: { edit: "execute" }, ownerUserId: 1 }
        })
      ).status,
      404
    );
    const saved = await http("/api/task-view/1/tasks/" + self.id + "/actions", {
      actor: 3,
      method: "POST",
      body: { action: "edit", payload: { title: "Authorized title", completed: true }, requestKey: "http-edit-0000001" }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, "applied");
    assert.equal(saved.body.result, undefined);
    assert.equal(saved.body.workspace_id, undefined);
    // Permission downgrade at the actual transaction boundary must stop the write.
    const authorize = service.authorize;
    service.authorize = async (request, client) => {
      await client.query("UPDATE access_grants SET task_permissions='{}' WHERE owner_user_id=1 AND grantee_user_id=3");
      return authorize(request, client);
    };
    await assert.rejects(
      command("edit", { title: "Must not write" }, "downgrade-race-001", self.id),
      (e) => e.statusCode === 403
    );
    service.authorize = authorize;
    assert.equal((await ctx.blockDB.getBlock(self.id)).properties.title, "Authorized title");
    // The transaction rollback also rolls back the synthetic downgrade.
    const known = store.createStore({
      ...ctx,
      execute: async () => {
        throw Object.assign(new Error("Known rejected"), { statusCode: 409 });
      }
    });
    const unknown = store.createStore({
      ...ctx,
      execute: async () => {
        throw new Error("Uncertain transport outcome");
      }
    });
    const countBefore = (await ctx.pool.query("SELECT COUNT(*)::int AS n FROM task_action_requests")).rows[0].n;
    await assert.rejects(
      known.submit({
        actor: 1,
        owner: 1,
        taskId: self.id,
        action: "edit",
        payload: { title: "No write" },
        requestKey: "known-failure-0001"
      }),
      /Known rejected/
    );
    assert.equal(
      (
        await known.submit({
          actor: 1,
          owner: 1,
          taskId: self.id,
          action: "edit",
          payload: { title: "No write" },
          requestKey: "known-failure-0001"
        })
      ).status,
      "failed"
    );
    await assert.rejects(
      unknown.submit({
        actor: 1,
        owner: 1,
        taskId: self.id,
        action: "edit",
        payload: { title: "Unknown" },
        requestKey: "unknown-failure-01"
      }),
      /Uncertain/
    );
    assert.equal(
      (
        await unknown.submit({
          actor: 1,
          owner: 1,
          taskId: self.id,
          action: "edit",
          payload: { title: "Unknown" },
          requestKey: "unknown-failure-01"
        })
      ).status,
      "executing"
    );
    assert.equal(
      (await ctx.pool.query("SELECT COUNT(*)::int AS n FROM task_action_requests")).rows[0].n,
      countBefore + 2
    );
    const reschedule = ctx.blockDB.rescheduleBlocks;
    ctx.blockDB.rescheduleBlocks = async () => {
      throw new Error("Synthetic unknown COMMIT outcome");
    };
    const uncertainSchedule = {
      actor: 1,
      owner: 1,
      taskId: self.id,
      action: "schedule",
      payload: { date: "2026-10-24", start: "12:00", end: "12:30" },
      requestKey: "uncertain-schedule-01"
    };
    await assert.rejects(service.submit(uncertainSchedule), (e) => e.statusCode === 500);
    assert.equal((await service.submit(uncertainSchedule)).status, "executing");
    ctx.blockDB.rescheduleBlocks = reschedule;
    // Same-key overlapping submissions execute exactly once, with PG row/advisory locks.
    let calls = 0;
    const concurrent = store.createStore({
      ...ctx,
      execute: async () => {
        calls++;
        return { ok: true };
      }
    });
    const parallel = {
      actor: 1,
      owner: 1,
      taskId: self.id,
      action: "edit",
      payload: { title: "Concurrent" },
      requestKey: "parallel-request-01"
    };
    const receipts = await Promise.all([
      concurrent.submit(parallel),
      concurrent.submit(parallel),
      concurrent.submit(parallel)
    ]);
    assert.equal(calls, 1);
    assert.equal(new Set(receipts.map((r) => r.id)).size, 1);
    // Applied receipts cannot crowd pending suggestions out of the owner review queue.
    const pendingBefore = (await service.list(1, 1)).map((r) => r.id);
    assert.ok(pendingBefore.includes(stale.id));
    await ctx.pool.query(
      `INSERT INTO task_action_requests(id,owner_user_id,actor_user_id,workspace_id,task_id,action,payload,snapshot,request_key,status)
 SELECT 'applied-'||n,1,1,'ws-1',$1,'edit','{}','{}','history-'||n,'applied' FROM generate_series(1,105) n`,
      [self.id]
    );
    assert.ok((await service.list(1, 1)).some((r) => r.id === stale.id));
    await ctx.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES(1,3,'blocked')");
    await assert.rejects(
      command("react", { emoji: "🔥", active: true }, "request-blocked-user", self.id),
      (e) => e.statusCode === 403
    );
    await ctx.pool.query("DELETE FROM friendships");
    await ctx.pool.query("DELETE FROM access_grants");
    await assert.rejects(
      command("complete", { completed: true }, "request-revoked-user", self.id),
      (e) => e.statusCode === 403
    );
  }
);
