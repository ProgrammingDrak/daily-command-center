const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createActivityDb } = require("./test-support/activity-db");
const { route, isValidDate } = require("./lib/route-helpers");

const configured = !!(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL);

test("canonical completion HTTP transitions drive private collaboration detail and summary", { skip: !configured }, async t => {
  const ctx = await createActivityDb();
  t.after(ctx.close);
  const date = "2026-10-21";
  Object.assign(ctx, {
    route,
    APP_TIME_ZONE: "UTC",
    getTodayStr: () => date,
    getScheduleBlocks: async () => [],
    filterLegacyGcalBlocks: rows => rows,
    isValidDate,
    broadcast() {},
  });
  const task = await ctx.blockDB.createItineraryTask({
    date, userId: 1, workspaceId: "ws-1",
    properties: {
      kind: "task", type: "task", status: "open", publicVisibility: "private",
      title: "PRIVATE-TASK-TITLE", detail: "PRIVATE-TASK-NOTES",
      source: "gmail", source_message_preview: "PRIVATE-SOURCE-PREVIEW",
      local_id: "private-canonical-local-id",
    },
  });
  await ctx.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES(1,2,'accepted')");

  // Supply only the session/workspace boundary. Both HTTP handlers and the
  // canonical completion writer are production implementations, not fakes.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const coach = req.headers["x-test-user"] === "coach";
    req.session = { userId: coach ? 2 : 1 };
    req.workspaceId = coach ? "ws-2" : "ws-1";
    next();
  });
  require("./routes/blocks")(app, ctx);
  require("./routes/commitments")(app, ctx);
  const server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(path, { user = "owner", method = "GET", body } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", "x-test-user": user },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const post = (path, body, user = "owner") => request(path, { method: "POST", body, user });
  const ok = response => {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const created = ok(await post("/api/commitments", {
    id: ctx.crypto.randomUUID(), actionId: ctx.crypto.randomUUID(),
    title: "Explicitly shared outcome", definitionDone: "Reviewed conclusion",
    committedDate: date, timeZone: "UTC", sourceBlockId: task.id,
  }));
  const commitmentPath = "/api/commitments/" + created.id;
  const invited = ok(await post(commitmentPath + "/actions", {
    kind: "invite", userId: 2, role: "coach",
    actionId: ctx.crypto.randomUUID(), expectedRevision: created.revision,
  }));
  const accepted = ok(await post(commitmentPath + "/actions", {
    kind: "accept", actionId: ctx.crypto.randomUUID(), expectedRevision: invited.revision,
  }, "coach"));
  assert.equal(accepted.role, "coach");

  async function assertProjections(status) {
    const canonical = await ctx.blockDB.getBlock(task.id);
    assert.equal(ctx.blockDB.isCompletedTaskProps(canonical.properties), status === "completed");
    for (const user of ["owner", "coach"]) {
      const detail = ok(await request(commitmentPath, { user }));
      const summaries = ok(await request("/api/commitments?date=" + date + "&summary=1", { user }));
      assert.equal(summaries.length, 1);
      const summary = summaries.find(item => item.id === created.id);
      assert.ok(summary);
      assert.equal(summary.summary, true);
      assert.equal(summary.events, undefined);
      assert.equal(summary.members, undefined);
      for (const projection of [detail, summary]) {
        assert.equal(projection.status, status, user + " projection");
        assert.equal(projection.title, "Explicitly shared outcome");
        assert.equal(projection.linked, true);
        assert.equal(projection.capabilities.complete, false);
        assert.doesNotMatch(JSON.stringify(projection), /PRIVATE-TASK|PRIVATE-SOURCE|source_message_preview|publicVisibility/);
        if (user === "coach") {
          for (const field of ["source_block_id", "source_local_id", "workspace_id", "task_available", "properties"]) {
            assert.equal(Object.hasOwn(projection, field), false, field);
          }
          assert.ok(!JSON.stringify(projection).includes(task.id));
          assert.ok(!JSON.stringify(projection).includes(task.properties.local_id));
        }
      }
    }
    return canonical;
  }
  await assertProjections("open");

  // The former browser fixture replaced properties wholesale and let this PATCH
  // look like a completion. The real generic writer must ignore that status.
  const patched = ok(await request("/api/blocks/" + task.id, {
    method: "PATCH", body: { properties: { ...task.properties, status: "done" } },
  }));
  assert.equal(patched.properties.status, "open");
  await assertProjections("open");

  const completionPath = "/api/tasks/" + task.id + "/completion";
  const denied = await post(completionPath, {
    completed: true, mutationId: ctx.crypto.randomUUID(), expectedRevision: null,
  }, "coach");
  assert.equal(denied.status, 404);
  assert.equal(denied.body.code, "COMPLETION_TARGET_NOT_FOUND");
  assert.equal(denied.body.currentTask, undefined);
  assert.doesNotMatch(JSON.stringify(denied.body), /PRIVATE-TASK|PRIVATE-SOURCE/);
  await assertProjections("open");

  const mutation = {
    completed: true, completedAt: date + "T15:00:00Z",
    mutationId: ctx.crypto.randomUUID(), expectedRevision: null,
  };
  const completed = ok(await post(completionPath, mutation));
  assert.equal(completed.ok, true);
  assert.equal(completed.persistenceTarget, "task_row");
  assert.equal(completed.duplicate, false);
  assert.equal(completed.task.id, task.id);
  assert.ok(completed.revision);
  assert.equal(completed.task.properties._completionRevision, completed.revision);
  const firstDone = await assertProjections("completed");
  const completionWrites = async () => Number((await ctx.pool.query(
    "SELECT COUNT(*) AS count FROM operations WHERE block_id=$1 AND op_type='completion'", [task.id]
  )).rows[0].count);
  const writes = await completionWrites();
  assert.equal(writes, 1);
  const duplicate = ok(await post(completionPath, mutation));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.revision, completed.revision);
  assert.equal(await completionWrites(), writes);
  assert.deepEqual((await assertProjections("completed")).properties, firstDone.properties);

  const reopened = ok(await post(completionPath, {
    completed: false, mutationId: ctx.crypto.randomUUID(), expectedRevision: completed.revision,
  }));
  assert.equal(reopened.duplicate, false);
  assert.notEqual(reopened.revision, completed.revision);
  await assertProjections("open");

  // A delayed retry from the previous completion cannot undo an explicit reopen.
  const stale = await post(completionPath, mutation);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "COMPLETION_CONFLICT");
  await assertProjections("open");
  const recompleted = ok(await post(completionPath, {
    completed: true, mutationId: ctx.crypto.randomUUID(), expectedRevision: reopened.revision,
  }));
  assert.equal(recompleted.duplicate, false);
  assert.notEqual(recompleted.revision, reopened.revision);
  await assertProjections("completed");
  assert.equal(await completionWrites(), writes + 2);
});
