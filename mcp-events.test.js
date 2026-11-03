const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const W = require("./lib/mcp-event-webhook");
const E = require("./mcp-events");
const key = Buffer.alloc(32, 7).toString("base64");
const secret = "whsec_" + Buffer.alloc(32, 9).toString("base64");
const configured = !!(process.env.DCC_TEST_DATABASE_URL || process.env.DCC_PGLITE_MODULE);
test("webhook transport rejects non-public destinations and pins validated DNS", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.2.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "192.0.2.1",
    "198.18.1.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2001:0000::1",
    "2001:1ff::1",
    "2002:808:808::1"
  ])
    assert.equal(W.publicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(W.publicAddress(address), true, address);
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/#fragment",
    "https://example.com:9443"
  ])
    assert.throws(() => W.callbackUrl(url));
  let requests = 0;
  await assert.rejects(
    W.post(
      "https://rebind.example",
      "{}",
      {},
      {
        lookup: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 }
        ],
        request: () => {
          requests++;
          throw new Error("Unexpected unsafe callback connection");
        }
      }
    ),
    /Non-public/
  );
  assert.equal(requests, 0, "mixed DNS never opens a socket");
  let lookedUp = 0,
    pinned;
  const result = await W.post(
    "https://callback.example/events",
    "{}",
    {},
    {
      lookup: async () => {
        lookedUp++;
        return [{ address: "8.8.8.8", family: 4 }];
      },
      request: (url, options, respond) => {
        requests++;
        assert.equal(url.hostname, "callback.example", "TLS retains hostname");
        assert.equal(options.autoSelectFamily, false, "pinned lookup uses the single-address Node contract");
        assert.equal(options.family, 4);
        options.lookup("callback.example", {}, (_e, address) => {
          pinned = address;
        });
        const req = new EventEmitter();
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = 302;
          respond(res);
          res.emit("data", Buffer.from("{}"));
          res.emit("end");
          req.emit("close");
        };
        return req;
      }
    }
  );
  assert.equal(lookedUp, 1);
  assert.equal(pinned, "8.8.8.8");
  assert.equal(result.status, 302);
  assert.equal(requests, 1, "redirect is never followed");
});
test("Standard Webhooks signature uses exact bytes and challenge echo is required", async () => {
  let request;
  const transport = W.createTransport({
    now: () => 1700000000000,
    send: async (url, body, headers) => {
      request = { url, body, headers };
      return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
    }
  });
  const sub = { id: "sub", url: "https://callback.example/events", secret };
  await transport.verify(sub);
  assert.equal(JSON.parse(request.body).type, "verification");
  const event = { eventId: "event", data: { prompt: "Sitrep?" } };
  await transport.deliver(sub, event);
  const expected = crypto
    .createHmac("sha256", Buffer.alloc(32, 9))
    .update("event.1700000000." + JSON.stringify(event))
    .digest("base64");
  assert.equal(request.headers["webhook-signature"], "v1," + expected);
  assert.equal(request.headers["X-MCP-Subscription-Id"], "sub");
  const bad = W.createTransport({
    send: async (_url, body) => {
      const challenge = JSON.parse(body).challenge;
      return {
        status: 200,
        body: JSON.stringify({ challenge: (challenge[0] === "x" ? "y" : "x") + challenge.slice(1) })
      };
    }
  });
  await assert.rejects(bad.verify(sub), /verification failed/);
  const denied = W.createTransport({ send: async (_url, body) => ({ status: 302, body }) });
  await assert.rejects(denied.verify(sub), /verification failed/);
  for (const s of ["whsec_abc", "whsec_!!", secret + "x"]) assert.throws(() => W.signingKey(s));
});
test("stored callback secrets are authenticated ciphertext", () => {
  const cipher = E.cipher(key),
    encrypted = cipher.seal({ secret });
  assert.ok(!encrypted.includes(secret));
  assert.deepEqual(cipher.open(encrypted), { secret });
  const damaged = Buffer.from(encrypted, "base64");
  damaged[15] ^= 1;
  assert.throws(() => cipher.open(damaged.toString("base64")));
  assert.throws(() => E.cipher("invalid"));
});
test("only the live subscribed task deadline produces a minimal attention event", () => {
  const s = { id: "sub", task_id: "a", activated_at: "2026-11-03T12:00:00Z" };
  const item = { task: { id: "a" }, generation: "g", dueAt: "2026-11-03T12:01:00Z", needsYou: true, status: "queued" };
  const now = Date.parse("2026-11-03T12:02:00Z");
  const event = E.dueEvent(s, item, now);
  assert.ok(event?.eventId);
  assert.deepEqual(event.data, { task_id: "a", generation: "g", due_at: item.dueAt, prompt: "Sitrep?" });
  assert.equal(
    E.dueEvent(s, { ...item, notifiedAt: "2026-11-03T12:01:01Z" }, now).eventId,
    event.eventId,
    "pet claim does not consume the chat event"
  );
  for (const change of [
    { dueAt: null },
    { dueAt: "2026-11-03T12:03:00Z" },
    { dueAt: "2026-11-03T11:59:00Z" },
    { generation: null },
    { status: "completed" },
    { status: "foreground" },
    { snoozed: true },
    { needsYou: false },
    { task: { id: "other" } }
  ])
    assert.equal(E.dueEvent(s, { ...item, ...change }, now), null, JSON.stringify(change));
  assert.notEqual(E.dueEvent(s, { ...item, generation: "new" }, now).eventId, event.eventId);
});
test(
  "PostgreSQL: native subscriptions, timer lifecycle, durable retries and authorization",
  { skip: !configured },
  async (t) => {
    const ctx = await require("./test-support/activity-db").createActivityDb();
    t.after(() => ctx.close());
    await ctx.pool.query(require("./conversation-store").FOREGROUND_INDEX_SQL);
    let now = Date.now(),
      revision = 0,
      sequence = 0,
      status = 503;
    const owner = { userId: 1, workspaceId: "ws-1", grantId: "event-grant", scopes: ["dcc.read", "dcc.events"] };
    await ctx.pool.query(`INSERT INTO conversation_grants(id,user_id,workspace_id,client_id,scopes) VALUES
    ('event-grant',1,'ws-1','synthetic','["dcc.read","dcc.events"]'),('other-grant',2,'ws-2','synthetic','["dcc.read","dcc.events"]')`);
    const store = require("./conversation-store").createConversationStore({ ...ctx, now: () => now });
    for (const [id, user] of [
      ["a", 1],
      ["b", 1],
      ["foreign", 2]
    ])
      await ctx.blockDB.createBlock({
        id,
        type: "block",
        date: "2026-11-03",
        user_id: user,
        workspace_id: "ws-" + user,
        properties: { type: "task", kind: "manual_task", local_id: id, title: id, status: "open" }
      });
    async function command(action, taskId, extra = {}) {
      const result = await store.execute(
        {
          action,
          taskId,
          ...extra,
          sourceEventId: "test-" + ++sequence,
          at: new Date(now).toISOString(),
          expectedRevision: revision
        },
        owner
      );
      revision = result.state.revision;
      return result;
    }
    await command("queue-add", "a");
    await command("queue-add", "b");
    let verified = 0;
    const sent = [];
    const transport = {
      verify: async () => {
        verified++;
      },
      deliver: async (sub, event, previous) => {
        sent.push({ sub, event, previous });
        return { status };
      }
    };
    const options = { ...ctx, key, now: () => now, transport };
    let events = E.createEvents(options);
    const params = {
      name: E.NAME,
      arguments: { task_id: "a" },
      delivery: { mode: "webhook", url: "https://callback.example/events", secret }
    };
    const sub = await events.subscribe(owner, params);
    assert.ok(sub.id);
    assert.equal(verified, 1);
    assert.equal((await events.subscribe(owner, params)).id, sub.id);
    assert.equal(verified, 1);
    assert.equal((await ctx.pool.query("SELECT * FROM dcc_event_subscriptions")).rows.length, 1);
    const persisted = (await ctx.pool.query("SELECT secrets FROM dcc_event_subscriptions")).rows[0].secrets;
    assert.ok(!persisted.includes(secret));
    assert.deepEqual(events.list({ ...owner, scopes: ["dcc.read"] }), { events: [] });
    await assert.rejects(events.subscribe({ ...owner, scopes: ["dcc.read"] }, params), /consent required/);
    await assert.rejects(events.subscribe(owner, { ...params, arguments: { task_id: "foreign" } }), /open task/);
    await assert.rejects(
      events.subscribe({ ...owner, userId: 2, workspaceId: "ws-2" }, params),
      /no longer authorized/
    );
    await assert.rejects(events.subscribe(owner, { ...params, cursor: "invented" }), /Invalid event/);
    const failed = E.createEvents({
      ...options,
      transport: {
        ...transport,
        verify: async () => {
          throw new Error("private response");
        }
      }
    });
    await assert.rejects(
      failed.subscribe(owner, { ...params, delivery: { ...params.delivery, url: "https://another.example" } }),
      (e) => e.rpcCode === -32015 && e.reason === "challenge_failed"
    );
    assert.equal(
      (await ctx.pool.query("SELECT * FROM dcc_event_subscriptions")).rows.length,
      1,
      "unverified subscription is not persisted"
    );
    await command("background-start", "a", { remindMinutes: 1 });
    await events.tick();
    assert.equal(sent.length, 0, "future timer does not wake chat");
    now += 61000;
    await events.tick();
    assert.equal(sent.length, 1);
    const first = sent[0].event;
    assert.equal(first.data.prompt, "Sitrep?");
    await events.tick();
    assert.equal(sent.length, 1, "backoff suppresses immediate retry");
    events = E.createEvents(options);
    now += 16000;
    status = 200;
    await events.tick();
    assert.equal(sent.length, 2, "restart resumes durable delivery");
    assert.equal(sent[1].event.eventId, first.eventId, "retry preserves event identity");
    now += 16000;
    await events.tick();
    assert.equal(sent.length, 2, "successful generation is not sent twice");
    await command("background-start", "b", { remindMinutes: 1 });
    const bParams = {
      ...params,
      arguments: { task_id: "b" },
      delivery: { ...params.delivery, url: "https://callback.example/b" }
    };
    await events.subscribe(owner, bParams);
    now += 61000;
    await Promise.all([events.tick(), E.createEvents(options).tick()]);
    assert.equal(sent.length, 3, "two worker processes deliver one successful event");
    await events.unsubscribe(owner, bParams);
    await command("queue-snooze", "a", { generation: first.data.generation, remindMinutes: 1 });
    now += 61000;
    status = 503;
    await events.tick();
    assert.equal(sent.length, 4);
    assert.notEqual(sent.at(-1).event.eventId, first.eventId);
    const dismissed = sent.at(-1).event;
    await command("queue-dismiss", "a", { generation: dismissed.data.generation });
    now += 16000;
    await events.tick();
    assert.equal(sent.length, 4, "dismiss cancels pending retries");
    assert.equal(
      (await ctx.pool.query("SELECT status FROM dcc_event_deliveries WHERE event_id=$1", [dismissed.eventId])).rows[0]
        .status,
      "cancelled"
    );
    await command("background-start", "a", { remindMinutes: 1 });
    now += 61000;
    await events.tick();
    assert.equal(sent.length, 5);
    await command("queue-remove", "a");
    now += 16000;
    await events.tick();
    assert.equal(sent.length, 5, "queue removal cancels retry");
    await command("queue-add", "a");
    await command("background-start", "a", { remindMinutes: 1 });
    now += 61000;
    status = 413;
    await events.tick();
    const after413 = sent.length;
    now += 3600001;
    await events.tick();
    assert.equal(sent.length, after413, "413 is terminal");
    const rotated = "whsec_" + Buffer.alloc(32, 3).toString("base64");
    await events.subscribe(owner, { ...params, delivery: { ...params.delivery, secret: rotated } });
    assert.equal(verified, 3);
    await command("background-start", "a", { remindMinutes: 1 });
    now += 61000;
    status = 200;
    await events.tick();
    assert.equal(sent.at(-1).previous, secret, "rotation signs with both keys temporarily");
    await command("background-start", "a", { remindMinutes: 1 });
    now += 61000;
    status = 503;
    await events.tick();
    const superseded = sent.at(-1).event;
    await command("queue-snooze", "a", { generation: superseded.data.generation, remindMinutes: 1 });
    const countBeforeSnooze = sent.length;
    now += 16000;
    await events.tick();
    assert.equal(sent.length, countBeforeSnooze, "rescheduling cancels pending old generation");
    now += 61000;
    status = 200;
    await events.tick();
    assert.notEqual(sent.at(-1).event.eventId, superseded.eventId);
    await command("background-start", "a", { remindMinutes: 1 });
    now += 61000;
    status = 503;
    await events.tick();
    const beforeFocus = sent.length;
    await command("start", "a");
    now += 16000;
    await events.tick();
    assert.equal(sent.length, beforeFocus, "foreground resume invalidates check-back");
    await command("background-start", "a", { remindMinutes: 1 });
    now += 61000;
    await events.tick();
    const beforeDone = sent.length;
    await command("done", "a");
    now += 16000;
    await events.tick();
    assert.equal(sent.length, beforeDone, "completion invalidates retry");
    await assert.rejects(events.subscribe(owner, params), /open task/);
    await events.unsubscribe(owner, params);
    // A second task exercises pet claims, expiry and ownership loss independently.
    await events.subscribe(owner, bParams);
    await command("background-start", "b", { remindMinutes: 1 });
    now += 61000;
    const bItem = (await store.state(owner)).queue.items.find((i) => i.task.id === "b");
    await command("queue-claim", "b", { generation: bItem.generation });
    status = 200;
    await events.tick();
    assert.equal(sent.at(-1).event.data.task_id, "b");
    const beforeRevoke = sent.length;
    await command("background-start", "b", { remindMinutes: 1 });
    await ctx.pool.query("UPDATE conversation_grants SET revoked_at=NOW() WHERE id='event-grant'");
    now += 61000;
    await events.tick();
    assert.equal(sent.length, beforeRevoke, "revoked grant stops event delivery");
    await ctx.pool.query("UPDATE conversation_grants SET revoked_at=NULL WHERE id='event-grant'");
    await ctx.pool.query("UPDATE workspace_members SET role='viewer' WHERE user_id=1 AND workspace_id='ws-1'");
    await events.tick();
    assert.equal(sent.length, beforeRevoke, "ownership loss stops event delivery");
    await ctx.pool.query("UPDATE workspace_members SET role='owner' WHERE user_id=1 AND workspace_id='ws-1'");
    await events.subscribe(owner, { ...bParams, ttlMs: 1000 });
    now += 16000;
    await events.tick();
    assert.equal(sent.length, beforeRevoke, "expired subscription cannot deliver");
    await events.subscribe(owner, bParams);
    await command("background-start", "b", { remindMinutes: 1 });
    now += 61000;
    status = 503;
    const beforeRetries = sent.length;
    for (let attempt = 1; attempt <= 8; attempt++) {
      await events.tick();
      now += 15000 * 2 ** (attempt - 1) + 16000;
    }
    await events.tick();
    assert.equal(sent.length, beforeRetries + 8, "transient retries are bounded");
    assert.equal(
      (await ctx.pool.query("SELECT status FROM dcc_event_deliveries WHERE event_id=$1", [sent.at(-1).event.eventId]))
        .rows[0].status,
      "failed"
    );
    await command("background-start", "b", { remindMinutes: 1 });
    now += 61000;
    status = 410;
    await events.tick();
    assert.equal(
      (
        await ctx.pool.query("SELECT disabled FROM dcc_event_subscriptions WHERE id=$1", [
          E.subscriptionId(owner, bParams)
        ])
      ).rows[0].disabled,
      true
    );
    const beforeDeleted = sent.length;
    now += 16000;
    await events.tick();
    assert.equal(sent.length, beforeDeleted, "410 stops subscription delivery");
    await events.subscribe(owner, bParams);
    await command("background-start", "b", { remindMinutes: 1 });
    now += 61000;
    await ctx.blockDB.deleteBlock("b");
    await events.tick();
    assert.equal(sent.length, beforeDeleted, "deleted task cannot deliver");
    await events.unsubscribe(owner, bParams);
    await events.unsubscribe(owner, bParams);
    assert.equal((await ctx.pool.query("SELECT * FROM dcc_event_subscriptions")).rows.length, 0);
    assert.equal(
      (await ctx.pool.query("SELECT * FROM dcc_event_deliveries")).rows.length,
      0,
      "unsubscribe erases callback and pending events"
    );
  }
);
