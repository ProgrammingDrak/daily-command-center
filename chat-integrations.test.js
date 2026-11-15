const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("./lib/chat-permissions");
const page = require("./lib/chat-integration-page");
test("permission choices cannot manufacture authority or grant writes through read access", () => {
  assert.deepEqual(P.defaults(), ["dcc.tasks.read"]);
  assert.deepEqual(P.selected({ tasks: "write" }), ["dcc.tasks.read", "dcc.tasks.write"]);
  assert.throws(() => P.selected({ tasks: "write" }, ["dcc.tasks.read"]), /not available/);
  assert.throws(() => P.selected({ tasks: "admin" }), /Invalid/);
  assert.equal(P.level(["dcc.read"], "tasks"), "off", "legacy grants are displayed separately");
  const html = page.consent({
    request: { scopes: ["dcc.tasks.read"], clientName: "<script>" },
    csrf: "a",
    granted: P.defaults(),
    account: "Owner",
    workspace: "ws-1"
  });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /name="tasks" value="write"/);
  assert.match(html, /name="tasks"/);
});
test("consent uses DCC tokens and returns management to the in-app Connections view", () => {
  const html = page.consent({
    request: { clientName: "ChatGPT", scopes: P.scopes },
    csrf: "safe",
    granted: P.defaults(),
    account: "Owner",
    workspace: "ws-1"
  });
  assert.match(html, /public\/css\/tokens.css/);
  assert.match(html, /dcc-connection-consent/);
  assert.match(html, /settings=connections&amp;connection=chatgpt/);
  assert.match(html, /role="radiogroup"/);
});

test(
  "real PostgreSQL permissions, versioned edits, recurrence cleanup, undo and effective completion",
  { skip: !process.env.DCC_TEST_DATABASE_URL && !process.env.DCC_PGLITE_MODULE },
  async (t) => {
    const ctx = await require("./test-support/activity-db").createActivityDb();
    t.after(() => ctx.close());
    const { createChatControlStore } = require("./chat-control-store");
    const store = createChatControlStore({ ...ctx, getTodayStr: () => "2026-11-14" });
    const actor = { userId: 1, workspaceId: "ws-1", scopes: P.categories.flatMap((c) => [c.read, c.write]) };
    const read = { ...actor, scopes: ["dcc.tasks.read"] };
    await assert.rejects(
      store.tasks({ action: "create", sourceEventId: "denied", input: { title: "No" } }, read),
      /Insufficient scope/
    );
    const create = {
      action: "create",
      sourceEventId: "create-task",
      input: { title: "Review integration", date: "2026-11-14" }
    };
    const first = await store.tasks(create, actor);
    assert.equal(first.saveStatus, "verified_saved");
    assert.deepEqual(await store.tasks(create, actor), first, "exact replay does not create duplicates");
    await assert.rejects(store.tasks({ ...create, input: { title: "Different" } }, actor), /identity reused/);
    const task = await store.tasks({ action: "get", id: first.task.id }, actor);
    await store.tasks(
      {
        action: "update",
        id: task.id,
        expectedVersion: task.version,
        sourceEventId: "edit",
        input: { title: "Updated" }
      },
      actor
    );
    await assert.rejects(
      store.tasks(
        {
          action: "update",
          id: task.id,
          expectedVersion: task.version,
          sourceEventId: "stale",
          input: { title: "Lost update" }
        },
        actor
      ),
      /Record changed/
    );
    await assert.rejects(
      store.tasks({ action: "get", id: task.id }, { ...actor, userId: 2, workspaceId: "ws-2" }),
      /not found/
    );
    const add = async (id, properties, date = null, parent_id = null) =>
      ctx.blockDB.createBlock({ id, type: "block", properties, date, parent_id, user_id: 1, workspace_id: "ws-1" });
    await add("series", {
      kind: "responsibility_item",
      title: "Routine",
      slug: "routine",
      status: "active",
      repeatType: "readiness",
      cadence: "as_needed",
      asNeeded: true,
      importance: 10,
      estimatedMinutes: 30
    });
    await add(
      "routine",
      {
        type: "task",
        title: "Routine",
        responsibilityId: "series",
        repeatSeriesId: "series",
        local_id: "routine-local"
      },
      "2026-11-14"
    );
    await add("step", { type: "task", title: "Step", subtaskOf: "routine-local" }, "2026-11-14", "routine");
    await add(
      "finished",
      {
        type: "task",
        title: "Finished",
        responsibilityId: "series",
        status: "done",
        completedAt: "2026-11-13T12:00:00Z"
      },
      "2026-11-13"
    );
    await add(
      "legacy",
      { type: "task", title: "Legacy completed", responsibilityId: "series", local_id: "legacy-local" },
      "2026-08-04"
    );
    await ctx.blockDB.createBlock({
      id: "legacy-root",
      type: "day_root",
      date: "2026-08-04",
      user_id: 1,
      workspace_id: "ws-1",
      properties: { _done: { ids: ["legacy-local"] } }
    });
    const open = await store.tasks({ action: "list", status: "open" }, actor);
    assert.ok(!open.tasks.some((x) => x.id === "legacy"));
    const library = await require("./project-store").createProjectStore(ctx).listLibrary("ws-1");
    assert.ok(library.completedTaskIds.includes("legacy"));
    await assert.rejects(
      store.bulk(
        { action: "prepare", allRepeats: true, sourceEventId: "bad-cleanup" },
        { ...actor, scopes: ["dcc.tasks.read", "dcc.tasks.write"] }
      ),
      /Insufficient scope/
    );
    await add("workout-series", {
      kind: "responsibility_item",
      title: "Training",
      repeatType: "scheduled",
      status: "active"
    });
    await add(
      "workout",
      {
        type: "workout",
        title: "Training",
        local_id: "workout-local",
        responsibilityId: "workout-series",
        repeatSeriesId: "workout-series"
      },
      "2026-11-14"
    );
    const prepared = await store.bulk({ action: "prepare", allRepeats: true, sourceEventId: "cleanup" }, actor);
    assert.equal(prepared.count, 5, "completed historical occurrences are not in the removal manifest");
    const result = await store.bulk({ action: "run", jobId: prepared.jobId }, actor);
    assert.equal(result.status, "completed");
    assert.equal(result.deleted, 5);
    assert.ok(
      (await ctx.blockDB.getBlockIncludingDeleted("workout")).deleted_at,
      "recurring workouts use recoverable deletion too"
    );
    assert.ok((await ctx.blockDB.getBlockIncludingDeleted("series")).deleted_at);
    assert.equal((await ctx.blockDB.getBlockIncludingDeleted("finished")).deleted_at, null);
    assert.equal((await ctx.blockDB.getBlockIncludingDeleted("legacy")).deleted_at, null);
    const reps = require("./responsibility-store")({
      ...ctx,
      getTodayStr: () => "2026-11-14",
      assertBlockOwnership: () => {}
    });
    assert.deepEqual(
      await reps.materializeTriageResponsibility({ id: "series", userId: 1, workspaceId: "ws-1" }),
      [],
      "retired series cannot regenerate"
    );
    assert.equal(
      (await store.bulk({ action: "run", jobId: prepared.jobId }, actor)).deleted,
      5,
      "run replay never deletes new scope"
    );
    assert.equal((await store.bulk({ action: "undo", jobId: prepared.jobId }, actor)).status, "restored");
    assert.equal((await ctx.blockDB.getBlockIncludingDeleted("series")).deleted_at, null);
    assert.equal((await ctx.blockDB.getBlockIncludingDeleted("routine")).deleted_at, null);
    // Intervening edits are reported per item rather than overwritten.
    const conflict = await store.bulk({ action: "prepare", ids: [task.id], sourceEventId: "conflict-cleanup" }, actor);
    const current = await store.tasks({ action: "get", id: task.id }, actor);
    await store.tasks(
      {
        action: "update",
        id: task.id,
        expectedVersion: current.version,
        sourceEventId: "intervening",
        input: { title: "Keep this edit" }
      },
      actor
    );
    assert.equal(
      (await store.bulk({ action: "run", jobId: conflict.jobId }, actor)).status,
      "completed_with_conflicts"
    );
    assert.equal((await store.tasks({ action: "get", id: task.id }, actor)).title, "Keep this edit");
    // New scopes are independent from legacy grants and reduction is immediate.
    const { createOAuth } = require("./conversation-oauth");
    const oauth = createOAuth({ pool: ctx.pool, baseUrl: "https://dcc.example" });
    await ctx.pool.query(
      "INSERT INTO conversation_grants(id,user_id,workspace_id,client_id,scopes) VALUES('grant',1,'ws-1','chatgpt',$1)",
      [JSON.stringify(["dcc.tasks.read", "dcc.tasks.write"])]
    );
    await oauth.reduce("grant", ["dcc.tasks.read"], actor);
    await assert.rejects(oauth.reduce("grant", ["dcc.tasks.read", "dcc.tasks.write"], actor), /new authorization/);
    await assert.rejects(oauth.reduce("grant", [], { userId: 2, workspaceId: "ws-2" }), /not found/);
    await oauth.revoke("grant", actor);
    assert.ok((await oauth.list(actor)).find((g) => g.id === "grant").revoked_at);
    // Scheduling uses the same atomic subtree writer as the app.
    const child = await store.tasks(
      { action: "create", sourceEventId: "child", input: { title: "Child", parentId: task.id, duration: 5 } },
      actor
    );
    const parent = await store.tasks({ action: "get", id: task.id }, actor);
    await store.tasks(
      {
        action: "schedule",
        id: parent.id,
        expectedVersion: parent.version,
        sourceEventId: "schedule",
        input: { date: "2026-11-15", start: "09:00" }
      },
      actor
    );
    assert.equal((await store.tasks({ action: "get", id: child.task.id }, actor)).date, "2026-11-15");
    const organization = await store.organization(
      { action: "create", kind: "project", sourceEventId: "project", input: { name: "Integration" } },
      actor
    );
    const projects = await store.organization({ action: "list" }, actor);
    assert.equal(projects.projects.find((p) => p.id === organization.id).version, organization.version);
    await assert.rejects(
      store.bulk({ action: "prepare", ids: [organization.id], sourceEventId: "cannot-delete-project-as-task" }, actor),
      /tasks and repeat definitions only/
    );
    const createdRepeat = await store.repeats(
      { action: "create", sourceEventId: "repeat-create", input: { title: "New routine", asNeeded: true } },
      actor
    );
    const savedRepeat = (await store.repeats({ action: "get", id: createdRepeat.definitionId }, actor)).definitions[0];
    await store.repeats(
      { action: "pause", id: savedRepeat.id, expectedVersion: savedRepeat.version, sourceEventId: "pause-repeat" },
      actor
    );
    assert.equal(
      (await store.repeats({ action: "get", id: savedRepeat.id }, actor)).definitions[0].properties.pausedUntil,
      "forever"
    );
    // Attachment capabilities stay independent of general task-reading access.
    const bytes = new Map();
    const attachmentStore = require("./task-attachment-store").createStore({
      pool: ctx.pool,
      storage: { configured: true, put: async (key, data) => bytes.set(key, data), get: async (key) => bytes.get(key) }
    });
    const fileControl = createChatControlStore({ ...ctx, taskAttachmentStore: attachmentStore });
    const fileActor = { ...actor, scopes: ["dcc.files.read", "dcc.files.write"] };
    const fileId = require("node:crypto").randomUUID();
    const file = await fileControl.files(
      {
        action: "upload",
        taskId: task.id,
        id: fileId,
        filename: "notes.txt",
        mime: "text/plain",
        base64: Buffer.from("Private file").toString("base64")
      },
      fileActor
    );
    assert.equal(file.filename, "notes.txt");
    assert.equal(
      Buffer.from(
        (await fileControl.files({ action: "download", taskId: task.id, id: fileId }, fileActor)).base64,
        "base64"
      ).toString(),
      "Private file"
    );
    await fileControl.files({ action: "remove", taskId: task.id, id: fileId }, fileActor);
    await assert.rejects(
      fileControl.files({ action: "download", taskId: task.id, id: fileId }, fileActor),
      /unavailable/
    );
    await fileControl.files({ action: "restore", taskId: task.id, id: fileId }, fileActor);
    assert.equal((await fileControl.files({ action: "list", taskId: task.id }, fileActor)).files[0].removed, false);
    const many = [];
    for (let i = 0; i < 26; i++) {
      const id = "chunk-task-" + i;
      await add(id, { type: "task", title: "Chunk " + i });
      many.push(id);
    }
    const chunked = await store.bulk({ action: "prepare", ids: many, sourceEventId: "chunked" }, actor);
    assert.equal((await store.bulk({ action: "run", jobId: chunked.jobId }, actor)).status, "running");
    const checkpoint = await store.bulk({ action: "status", jobId: chunked.jobId }, actor);
    assert.equal(checkpoint.processed, 25);
    assert.ok(
      checkpoint.results.every((result) => !result.before),
      "status does not disclose private recovery snapshots"
    );
    assert.equal((await store.bulk({ action: "run", jobId: chunked.jobId }, actor)).status, "completed");
    assert.equal((await store.bulk({ action: "undo", jobId: chunked.jobId }, actor)).status, "restoring");
    assert.equal((await store.bulk({ action: "undo", jobId: chunked.jobId }, actor)).status, "restored");
  }
);
