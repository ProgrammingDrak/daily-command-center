const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { createActivityDb } = require("./test-support/activity-db");
const { createConversationStore } = require("./conversation-store");
const { createOAuth } = require("./conversation-oauth");
const M = require("./lib/conversation-model");
const configured = !!(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL);
test("command semantics reject inferred starts, timezone-free intervals and identity injection", () => {
  const base = {
    action: "start",
    sourceEventId: "message-1",
    expectedRevision: 0,
    taskId: "a",
    at: "2026-10-20T09:00:00-04:00"
  };
  assert.equal(M.command(base).action, "start");
  for (const change of [
    { action: "mention" },
    { action: "question" },
    { at: "2026-10-20T09:00:00" },
    { userId: 2 },
    { workspaceId: "ws-2" },
    { expectedRevision: null }
  ])
    assert.throws(() => M.command({ ...base, ...change }));
  assert.equal(M.digest({ a: 1, b: 2 }), M.digest({ b: 2, a: 1 }));
});
test("account conversation persistence, race, rollback, corrections and OAuth", { skip: !configured }, async (t) => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  await ctx.pool.query(require("./conversation-store").FOREGROUND_INDEX_SQL);
  const store = createConversationStore(ctx),
    owner = { userId: 1, workspaceId: "ws-1" },
    other = { userId: 2, workspaceId: "ws-2" };
  const task = async (id, title, who = owner, properties = {}) =>
    ctx.blockDB.createBlock({
      id,
      type: "block",
      date: "2026-10-20",
      user_id: who.userId,
      workspace_id: who.workspaceId,
      properties: {
        local_id: id,
        title,
        type: "task",
        kind: "manual_task",
        status: "open",
        estimatedMinutes: 90,
        ...properties
      }
    });
  await task("a", "Alpha");
  await task("b", "Beta");
  await task("foreign", "Foreign", other);
  await task("unknown-done", "Unmeasured");
  const cmd = (action, taskId, revision, event, at) => ({
    action,
    taskId,
    expectedRevision: revision,
    sourceEventId: event,
    at: at || "2026-10-20T13:00:00Z"
  });
  await t.test("reads never start; search includes completed and recurring definitions", async () => {
    assert.equal((await store.state(owner)).foreground.length, 0);
    assert.equal((await store.search({ query: "Alpha" }, owner)).tasks[0].id, "a");
    assert.equal((await store.state(owner)).revision, 0);
    assert.equal((await store.search({ query: "Foreign" }, owner)).tasks.length, 0);
    await assert.rejects(store.get("foreign", owner), { statusCode: 404 });
    await assert.rejects(store.state({ userId: 3, workspaceId: "ws-1" }), { statusCode: 403 });
  });
  await t.test("switch is atomic, retry is stable, conflict cannot overwrite newer activity", async () => {
    const start = cmd("start", "a", 0, "start-a");
    await store.execute(start, owner);
    const switched = await store.execute(cmd("start", "b", 1, "start-b", "2026-10-20T13:10:00Z"), owner);
    assert.equal(switched.state.foreground[0].id, "b");
    assert.equal(switched.task.date, "2026-10-20");
    assert.ok(switched.affectedTasks.every((r) => r.date === "2026-10-20"));
    assert.equal(switched.state.foreground.length, 1);
    const a = await store.get("a", owner);
    assert.equal(a.task.properties.actualMinutes, 10);
    assert.equal(a.task.properties.estimatedMinutes, 90);
    const replay = await store.execute(start, owner);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.currentState.foreground[0].id, "b");
    await assert.rejects(store.execute({ ...start, taskId: "b" }, owner), { statusCode: 409 });
    await assert.rejects(store.execute(cmd("pause", "b", 1, "stale", "2026-10-20T13:11:00Z"), owner), {
      statusCode: 409
    });
    const attempts = await Promise.allSettled([
      store.execute(cmd("pause", "b", 2, "race-a", "2026-10-20T13:20:00Z"), owner),
      store.execute(cmd("start", "a", 2, "race-b", "2026-10-20T13:20:00Z"), owner)
    ]);
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(attempts.find((r) => r.status === "rejected").reason.statusCode, 409);
  });
  await t.test("background effort is distinct and no-timer done retains unknown actuals", async () => {
    let revision = (await store.state(owner)).revision;
    await store.execute(cmd("background-start", "b", revision, "background", "2026-10-20T13:25:00Z"), owner);
    const before = await store.get("b", owner);
    assert.equal(before.background.length, 1);
    assert.equal(before.foreground.length, 0);
    revision = (await store.state(owner)).revision;
    await store.execute(cmd("background-stop", "b", revision, "background-stop", "2026-10-20T13:35:00Z"), owner);
    assert.equal((await store.get("b", owner)).task.properties.actualMinutes, before.task.properties.actualMinutes);
    revision = (await store.state(owner)).revision;
    await store.execute(cmd("done", "unknown-done", revision, "done-no-estimate", "2026-10-20T13:40:00Z"), owner);
    const done = await store.get("unknown-done", owner);
    assert.equal(done.task.properties.status, "done");
    assert.equal(done.task.properties.actualMinutes, undefined);
    assert.equal(done.sessions.length, 0);
    assert.equal((await store.search({ query: "Unmeasured" }, owner)).tasks[0].status, "done");
  });
  await t.test("50 minute synthetic session becomes 30 minute existing meeting plus 7+13 unknown", async () => {
    await task("synthetic-quickbuy", "Synthetic QuickBuy");
    let revision = (await store.state(owner)).revision;
    await store.execute(cmd("start", "synthetic-quickbuy", revision, "fixture-start", "2026-10-20T13:53:00Z"), owner);
    await store.execute(
      cmd("pause", "synthetic-quickbuy", revision + 1, "fixture-stop", "2026-10-20T14:43:00Z"),
      owner
    );
    const before = await store.get("synthetic-quickbuy", owner),
      entry = before.sessions[0];
    assert.equal(before.task.properties.actualMinutes, 50);
    await ctx.pool.query(
      "INSERT INTO dcc_state(date,state_json,user_id,workspace_id,updated_at) VALUES('2026-10-20',$1,1,'ws-1',NOW())",
      [{ meetings: [{ id: "synthetic-mike-occurrence", title: "Synthetic Mike 1:1", start: "10:00", end: "10:30" }] }]
    );
    const fix = {
      action: "correct",
      expectedRevision: before.revision,
      sourceEventId: "fixture-correct",
      entryId: entry.id,
      at: "2026-10-20T14:44:00Z",
      reason: "Explicit user confirmation; remainder unknown",
      parts: [
        { kind: "unknown", start: "2026-10-20T09:53:00-04:00", end: "2026-10-20T10:00:00-04:00" },
        {
          kind: "meeting",
          calendarEventId: "synthetic-mike-occurrence",
          start: "2026-10-20T10:00:00-04:00",
          end: "2026-10-20T10:30:00-04:00"
        },
        { kind: "unknown", start: "2026-10-20T10:30:00-04:00", end: "2026-10-20T10:43:00-04:00" }
      ]
    };
    const out = await store.execute(fix, owner);
    assert.deepEqual(
      out.entries.map((e) => e.properties.durSec),
      [420, 1800, 780]
    );
    assert.equal(out.entries[1].properties.calendarEventId, "synthetic-mike-occurrence");
    assert.equal((await store.get("synthetic-quickbuy", owner)).task.properties.actualMinutes, undefined);
    assert.ok((await ctx.blockDB.getBlockIncludingDeleted(entry.id)).deleted_at);
    assert.equal((await store.search({ query: "Mike" }, owner)).tasks.length, 0, "no duplicate meeting task");
    assert.equal((await store.execute(fix, owner)).duplicate, true);
    assert.equal(
      (await store.history(owner)).find((e) => e.source_event_id === "fixture-correct").result.sourceEntry.properties
        .durSec,
      3000
    );
  });
  await t.test("bad allocation and injected mid-switch failure roll back every write", async () => {
    let revision = (await store.state(owner)).revision;
    await store.execute(cmd("start", "a", revision, "rollback-start", "2026-10-20T15:00:00Z"), owner);
    revision++;
    const broken = createConversationStore({
      ...ctx,
      blockDB: {
        ...ctx.blockDB,
        updateBlock: async (id, p, q) => {
          if (id === "b" && p.properties.startedAt) throw new Error("synthetic interrupt");
          return ctx.blockDB.updateBlock(id, p, q);
        }
      }
    });
    await assert.rejects(
      broken.execute(cmd("start", "b", revision, "interrupted", "2026-10-20T15:10:00Z"), owner),
      /synthetic interrupt/
    );
    assert.equal((await store.state(owner)).foreground[0].id, "a");
    assert.equal((await store.state(owner)).revision, revision);
    assert.equal((await store.get("a", owner)).sessions.length, 1);
    const retry = await store.execute(cmd("start", "b", revision, "interrupted", "2026-10-20T15:10:00Z"), owner);
    assert.equal(retry.state.foreground[0].id, "b");
    const entry = (await store.get("a", owner)).sessions.at(-1),
      base = {
        action: "correct",
        sourceEventId: "bad-fix",
        expectedRevision: retry.state.revision,
        at: "2026-10-20T15:11:00Z",
        entryId: entry.id,
        reason: "test",
        parts: [
          { kind: "focused", taskId: "foreign", start: entry.properties.startedAt, end: entry.properties.endedAt }
        ]
      };
    await assert.rejects(store.execute(base, owner), { statusCode: 404 });
    assert.equal((await ctx.blockDB.getBlock(entry.id)).deleted_at, null);
  });
  await t.test("legacy clients use the same coordinator and generic stale writes cannot revive a timer", async () => {
    process.env.DCC_CONVERSATION_ENABLED = "true";
    try {
      const timing = require("./lib/task-timing")({ ...ctx });
      const a = await ctx.blockDB.getBlock("a");
      await timing.startWork({ block: a, atMs: Date.parse("2026-10-20T15:20:00Z"), actionId: "browser-start" });
      assert.equal((await store.state(owner)).foreground[0].id, "a");
      assert.equal((await store.state(owner)).foreground.length, 1);
      await ctx.blockDB.updateBlock("b", {
        properties: { ...(await ctx.blockDB.getBlock("b")).properties, startedAt: "2026-10-20T15:10:00Z" }
      });
      assert.equal((await store.state(owner)).foreground.length, 1);
    } finally {
      delete process.env.DCC_CONVERSATION_ENABLED;
    }
  });
  await t.test("midnight, DST, long silence and database foreground constraint", async () => {
    await task("dst", "DST work", other);
    await store.execute(cmd("start", "dst", 0, "dst-start", "2026-03-08T01:50:00-05:00"), other);
    await store.execute(cmd("pause", "dst", 1, "dst-pause", "2026-03-08T03:10:00-04:00"), other);
    assert.equal((await store.get("dst", other)).task.properties.actualMinutes, 20);
    await store.execute(cmd("start", "dst", 2, "midnight-start", "2026-03-08T23:50:00-04:00"), other);
    await store.execute(cmd("pause", "dst", 3, "midnight-pause", "2026-03-09T00:10:00-04:00"), other);
    const entries = (await store.get("dst", other)).sessions;
    assert.deepEqual(
      entries.slice(-2).map((r) => r.properties.durSec),
      [600, 600]
    );
    await store.execute(cmd("start", "dst", 4, "silence-start", "2026-03-09T10:00:00-04:00"), other);
    const end = await store.execute(cmd("pause", "dst", 5, "silence-stop", "2026-03-09T13:00:00-04:00"), other);
    assert.equal(end.uncertainIntervals[0].start, "2026-03-09T14:50:00.000Z");
    assert.equal(end.task.properties.actualMinutes, 90, "20+20+50 focused minutes, not 220 elapsed");
    await store.execute(cmd("start", "dst", 6, "unique-start", "2026-03-09T14:00:00-04:00"), other);
    await assert.rejects(
      ctx.pool.query("UPDATE blocks SET properties=properties||$1::jsonb WHERE id='foreign'", [
        { startedAt: "2026-03-09T18:01:00Z" }
      ]),
      (e) => e.code === "23505"
    );
    assert.equal((await store.state(other)).foreground.length, 1);
    assert.equal((await store.state(owner)).foreground[0].id, "a", "other account is independent");
  });
  await t.test("recurring definitions appear in discovery, calendar reads preserve event identity", async () => {
    await ctx.blockDB.createBlock({
      id: "definition",
      type: "block",
      user_id: 1,
      workspace_id: "ws-1",
      properties: { kind: "responsibility_item", title: "Recurring report", repeatType: "scheduled" }
    });
    const result = await store.search({ query: "Recurring" }, owner);
    assert.equal(result.tasks[0].type, "recurring-definition");
    assert.equal(
      (await store.calendarEvents({ date: "2026-10-20" }, owner)).events[0].calendarEventId,
      "synthetic-mike-occurrence"
    );
    assert.equal((await store.calendarEvents({ date: "2026-10-20" }, other)).events.length, 0);
  });
  await t.test("explicit corrected timestamps preserve seconds and refuse overlapping activity", async () => {
    let revision = (await store.state(owner)).revision;
    await store.execute(cmd("pause", "a", revision, "clock-stop-old", "2026-10-20T15:30:00Z"), owner);
    await task("clock-fix", "Corrected clock");
    revision++;
    await store.execute(cmd("start", "clock-fix", revision, "clock-start", "2026-10-20T15:45:00Z"), owner);
    await store.execute(cmd("pause", "clock-fix", revision + 1, "clock-pause", "2026-10-20T15:55:00Z"), owner);
    const before = await store.get("clock-fix", owner),
      window = { start: "2026-10-20T15:44:44Z", end: "2026-10-20T15:55:00Z" };
    const fixed = await store.execute(
      {
        action: "correct",
        sourceEventId: "clock-correction",
        expectedRevision: before.revision,
        entryId: before.sessions[0].id,
        at: "2026-10-20T16:00:00Z",
        reason: "User supplied exact start instant",
        correctedWindow: window,
        parts: [{ kind: "focused", taskId: "clock-fix", ...window }]
      },
      owner
    );
    assert.equal(fixed.originalWindow.durSec, 600);
    assert.equal(fixed.correctedWindow.durSec, 616);
    assert.equal(fixed.entries[0].properties.startedAt, "2026-10-20T15:44:44.000Z");
    const overlap = { start: "2026-10-20T15:15:00Z", end: window.end };
    await assert.rejects(
      store.execute(
        {
          action: "correct",
          sourceEventId: "overlapping-correction",
          expectedRevision: fixed.state.revision,
          entryId: fixed.entries[0].id,
          at: "2026-10-20T16:01:00Z",
          reason: "Invalid overlap",
          correctedWindow: overlap,
          parts: [{ kind: "focused", taskId: "clock-fix", ...overlap }]
        },
        owner
      ),
      { statusCode: 409 }
    );
    assert.equal((await store.get("clock-fix", owner)).task.properties.estimatedMinutes, 90);
  });
  await t.test("OAuth isolation, S256, code reuse, refresh rotation, expiry, scopes and revocation", async () => {
    const oauth = createOAuth({
      pool: ctx.pool,
      baseUrl: "https://dcc.example",
      clients: { chatgpt: { name: "ChatGPT", redirect_uris: ["https://chatgpt.com/callback"] } }
    });
    const verifier = crypto.randomBytes(32).toString("base64url"),
      challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const request = {
      client_id: "chatgpt",
      response_type: "code",
      redirect_uri: "https://chatgpt.com/callback",
      state: "state-123",
      resource: oauth.resource,
      scope: "dcc.read dcc.work",
      code_challenge_method: "S256",
      code_challenge: challenge
    };
    assert.throws(() => oauth.validateRequest({ ...request, redirect_uri: "https://evil.example/callback" }));
    assert.throws(() => oauth.validateRequest({ ...request, code_challenge_method: "plain" }));
    await assert.rejects(oauth.consent(oauth.validateRequest(request), { userId: 3, workspaceId: "ws-1" }), {
      statusCode: 403
    });
    const redirect = new URL(await oauth.consent(oauth.validateRequest(request), owner));
    assert.equal(redirect.searchParams.get("state"), "state-123");
    const exchange = {
      grant_type: "authorization_code",
      client_id: "chatgpt",
      redirect_uri: request.redirect_uri,
      resource: oauth.resource,
      code: redirect.searchParams.get("code"),
      code_verifier: verifier
    };
    await assert.rejects(oauth.token({ ...exchange, code_verifier: "x".repeat(43) }));
    const tokens = await oauth.token(exchange),
      identity = await oauth.verify(tokens.access_token, "dcc.read");
    assert.equal(identity.userId, 1);
    assert.equal(identity.workspaceId, "ws-1");
    await assert.rejects(oauth.token(exchange));
    await assert.rejects(oauth.verify(tokens.access_token, "dcc.correct"), { statusCode: 403 });
    assert.equal((await oauth.list(other)).length, 0);
    await oauth.revoke(identity.grantId, other);
    await oauth.verify(tokens.access_token, "dcc.read");
    const accessHash = crypto.createHash("sha256").update(tokens.access_token).digest("hex");
    await ctx.pool.query("UPDATE conversation_oauth_tokens SET expires_at=NOW()-INTERVAL '1 second' WHERE hash=$1", [
      accessHash
    ]);
    await assert.rejects(oauth.verify(tokens.access_token, "dcc.read"), { statusCode: 401 });
    const refreshed = await oauth.token({
      grant_type: "refresh_token",
      client_id: "chatgpt",
      resource: oauth.resource,
      refresh_token: tokens.refresh_token
    });
    await assert.rejects(
      oauth.token({
        grant_type: "refresh_token",
        client_id: "chatgpt",
        resource: oauth.resource,
        refresh_token: tokens.refresh_token
      })
    );
    await assert.rejects(oauth.verify(refreshed.access_token, "dcc.read"), { statusCode: 401 }); // refresh reuse revoked its family
    await oauth.revoke(identity.grantId, owner);
    await assert.rejects(oauth.verify(refreshed.access_token, "dcc.read"), { statusCode: 401 });
    await assert.rejects(oauth.verify("legacy-shared-admin-token"), { statusCode: 401 });
    const persisted = (await ctx.pool.query("SELECT hash FROM conversation_oauth_tokens")).rows;
    assert.ok(persisted.every((r) => /^[0-9a-f]{64}$/.test(r.hash)));
  });
});
