// Unit tests for routes/slack-events.js — the Slack reaction → DCC task timer.
// Mocks ctx (no DB): asserts signature verification, url_verification, and that
// each reaction drives the right create / start / complete + points + time_entry.
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const mount = require("./routes/slack-events.js");

const SECRET = "test-signing-secret";
const DRAKE = "U_DRAKE";

// Build a fresh harness per test: fresh in-memory store + freshly-mounted handler.
// opts.drakeUid overrides the actor-gate env var, which the route reads at MOUNT
// time, so it has to be set before mount(). opts.slotStore merges into the slot
// mock so a test can make a call fail.
function makeHarness(opts = {}) {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.DRAKE_SLACK_USER_ID = opts.drakeUid !== undefined ? opts.drakeUid : DRAKE;
  process.env.DCC_SERVICE_USER_ID = "1";
  process.env.DCC_SERVICE_WORKSPACE_ID = "ws-1";
  process.env.SLACK_DELEGATE_IMPORT_AFTER = opts.delegateImportAfter || "2026-01-01T00:00:00.000Z";
  if (opts.anthropicKey) process.env.ANTHROPIC_API_KEY = opts.anthropicKey;
  else delete process.env.ANTHROPIC_API_KEY;
  process.env.SLACK_RECONCILE_ENABLED = "0";

  const blocks = [];            // {id, date, properties, type}
  const calls = { credit: [], revoke: [], broadcast: [], reactionsAdd: [], fetch: [] };
  let seq = 0;
  // Stand in for the day_root `_done` overlay the browser writes. Handlers that
  // ask "was this finished elsewhere?" read it through blockDB.getBlock.
  const overlay = { _done: { ids: [], at: {} } };
  // The real createItineraryTask ensures the day root, so it always exists by the
  // time a handler reads the overlay. Kept OUT of `blocks` and served through
  // getBlock/updateBlock instead: the tests index `blocks[0]` as the task under
  // test, so a day_root sitting in that array would shift every one of them.
  const dayRootRow = { id: "day-root-ws-1-2026-07-28", date: "2026-07-28", type: "day_root", properties: overlay };
  let dayRootWriteFails = false;
  const failDayRootWrite = (v) => { dayRootWriteFails = v; };

  // reactions.add is the one outbound Slack call (re-add 🔖 after an un-✅).
  // Headers are captured too: "this must be a USER token, not a bot token" is a
  // load-bearing invariant (a bot's reaction never matches the poller's
  // `hasmy::bookmark:` search), and it is invisible unless asserted.
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  let fetchImpl = async (url, _init) => {
    if (String(url).includes("reactions.get")) {
      const parsed = new URL(url);
      const ts = parsed.searchParams.get("timestamp");
      return { ok: true, status: 200, json: async () => ({
        ok: true,
        message: { ts, text: "Please review the launch checklist with Alex tomorrow", user: "U_ALEX" },
      }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  global.fetch = async (url, init) => {
    calls.fetch.push({ url: String(url), init: init || {} });
    if (String(url).includes("reactions.add")) {
      calls.reactionsAdd.push({ url, headers: init.headers, body: Object.fromEntries(new URLSearchParams(init.body)) });
    }
    return fetchImpl(url, init);
  };
  const setFetch = (fn) => { fetchImpl = fn; };

  const ctx = {
    crypto,
    getTodayStr: () => "2026-07-28",
    APP_TIME_ZONE: "America/New_York",
    broadcast: (ev, payload) => calls.broadcast.push({ ev, payload }),
    slotStore: {
      earnTaskCredit: async (_ws, _uid, body) => { calls.credit.push(body); return { awarded: true }; },
      revokeTaskCredit: async (_ws, _uid, sourceKey) => { calls.revoke.push(sourceKey); return { revoked: true }; },
      ...(opts.slotStore || {}),
    },
    blockDB: {
      getBlock: async (id) => (id === dayRootRow.id ? dayRootRow : blocks.find(b => b.id === id) || null),
      createItineraryTask: async ({ date, properties }) => {
        const b = { id: `blk-${++seq}`, date, type: "block", properties };
        blocks.push(b); return { id: b.id };
      },
      createBlock: async ({ id, type, date, properties }) => {
        const b = { id: id || `blk-${++seq}`, date, type, properties };
        blocks.push(b); return { id: b.id };
      },
      updateBlock: async (id, { properties }) => {
        if (id === dayRootRow.id) {
          if (dayRootWriteFails) throw new Error("day_root write failed");
          dayRootRow.properties = properties; return { id };
        }
        const b = blocks.find(x => x.id === id);
        if (!b) throw new Error("not found " + id);
        b.properties = properties; return { id };
      },
      deleteBlock: async (id) => {
        const b = blocks.find(x => x.id === id);
        if (b) b.deleted = true; return { id };
      },
      ensureDayRoot: async () => dayRootRow.id,
    },
    pool: {
      query: async (sql, params) => {
        if (sql.includes("idempotency_key")) {
          // Tombstones are INCLUDED, live rows first — the route's own ORDER BY.
          // The route decides what a tombstoned hit means; the mock must not
          // hide it, or the no-resurrection guard goes untested.
          const hits = blocks
            .filter(b => b.properties && b.properties.idempotency_key === params[0] && b.type !== "time_entry")
            .sort((a, b) => (a.deleted ? 1 : 0) - (b.deleted ? 1 : 0));
          const hit = hits[0];
          return { rows: hit ? [{ id: hit.id, date: hit.date, properties: hit.properties, deleted_at: hit.deleted ? "2026-07-28T00:00:00Z" : null, workspace_id: "ws-1" }] : [] };
        }
        if (/^\s*DELETE/i.test(sql)) {
          // Honor the route's real predicates (type AND the workspace fence), so a
          // regression that dropped either would show up here instead of passing.
          assert.match(sql, /type = 'time_entry'/);
          assert.match(sql, /workspace_id/);
          const ws = params[1];
          const i = blocks.findIndex(b => b.id === params[0] && b.type === "time_entry"
            && (ws == null || b.workspace_id == null || b.workspace_id === ws));
          if (i >= 0) blocks.splice(i, 1);
          return { rows: [] };
        }
        if (sql.includes("WHERE id = $1")) {
          const hit = blocks.find(b => b.id === params[0]);
          return { rows: hit ? [{ id: hit.id }] : [] };
        }
        return { rows: [] };
      },
    },
  };

  let handler;
  const app = { post: (path, fn) => { if (path === "/api/slack/events") handler = fn; } };
  const api = mount(app, ctx);
  return { handler, api, blocks, calls, overlay, dayRootRow, setFetch, failDayRootWrite };
}

function sign(rawBody, ts) {
  return "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${rawBody}`).digest("hex");
}
function mockRes() {
  const r = { code: 200, body: null, ended: false };
  const res = {
    status(c) { r.code = c; return res; },
    json(o) { r.body = o; r.ended = true; return res; },
    end() { r.ended = true; return res; },
    _r: r,
  };
  return res;
}
// Fire the handler like Express would, with a valid (or intentionally bad) signature.
async function post(handler, obj, { badSig = false, ts = String(Math.floor(Date.now() / 1000)) } = {}) {
  const rawBody = JSON.stringify(obj);
  const res = mockRes();
  const req = {
    headers: {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": badSig ? "v0=deadbeef" : sign(rawBody, ts),
    },
    rawBody: Buffer.from(rawBody, "utf8"),
    body: obj,
  };
  handler(req, res);
  await new Promise(r => setTimeout(r, 80)); // let fire-and-forget processEvent settle
  return res._r;
}

const reaction = (name, ts, evTs, user = DRAKE) => ({
  type: "event_callback",
  event: { type: "reaction_added", user, reaction: name, item: { type: "message", channel: "C1", ts }, event_ts: evTs },
});

test("url_verification echoes challenge with a valid signature", async () => {
  const { handler } = makeHarness();
  const r = await post(handler, { type: "url_verification", challenge: "xyz123" });
  assert.equal(r.code, 200);
  assert.equal(r.body.challenge, "xyz123");
});

test("bad signature is rejected 401 and does nothing", async () => {
  const { handler, blocks } = makeHarness();
  const r = await post(handler, reaction("bookmark", "111.1", "111.5"), { badSig: true });
  assert.equal(r.code, 401);
  assert.equal(blocks.length, 0);
});

test("🔖 creates a useful captured task keyed by channel:ts before AI is available", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "222.2", "222.9"));
  assert.equal(blocks.length, 1);
  const p = blocks[0].properties;
  assert.equal(p.idempotency_key, "slack-bookmark:C1:222.2");
  assert.equal(p.estimatedMinutes, 5);
  assert.equal(p.title, "Please review the launch checklist with Alex tomorrow");
  assert.equal(p.captureTitle, p.title);
  assert.equal(p.capture_status, "captured");
  assert.equal(p.enrichment_status, "waiting_for_key");
  assert.equal(p.source, "slack-bookmark");
  assert.equal(p.status, "open");
  // source_id must be an http(s) URL so the DCC row renders the "Slack ↗" pill
  assert.match(p.source_id, /^https:\/\/.*slack\.com\/archives\//);
});

test("👥 creates a delegated item with tomorrow's check-in and removes an untouched item", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("busts_in_silhouette", "222.3", "222.9"));
  assert.equal(blocks.length, 1);
  const item = blocks[0];
  assert.equal(item.date, null);
  assert.equal(item.properties.kind, "delegated_item");
  assert.equal(item.properties.idempotency_key, "slack-delegate:C1:222.3");
  assert.equal(item.properties.myTask, "Please review the launch checklist with Alex tomorrow");
  assert.equal(item.properties.checkInMode, "date");
  assert.equal(item.properties.checkInDate, "2026-07-29");
  assert.match(item.properties.source_id, /^https:\/\/.*slack\.com\/archives\//);
  assert.ok(calls.broadcast.some((b) => b.payload.action === "slack-delegate-create"));

  await post(handler, removal("busts_in_silhouette", "222.3"));
  assert.equal(item.deleted, true);
  assert.ok(calls.broadcast.some((b) => b.payload.action === "slack-delegate-cancel"));
});

test("removing 👥 preserves a completed delegated item", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("busts_in_silhouette", "222.4", "222.9"));
  blocks[0].properties.status = "done";
  blocks[0].properties.completedAt = "2026-07-28T18:00:00.000Z";
  await post(handler, removal("busts_in_silhouette", "222.4"));
  assert.equal(blocks[0].deleted, undefined);
  assert.ok(blocks[0].properties.slack_delegate_reaction_removed_at);
});

test("removing 👥 preserves any user-edited delegated item fields", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("busts_in_silhouette", "222.41", "222.9"));
  blocks[0].properties.notes = "Morgan owns this, ask for legal approval first.";
  blocks[0].properties.delegatee = { name: "Morgan" };
  blocks[0].properties.checkInDate = "2026-08-03";
  await post(handler, removal("busts_in_silhouette", "222.41"));
  assert.equal(blocks[0].deleted, undefined);
  assert.equal(blocks[0].properties.delegatee.name, "Morgan");
  assert.equal(blocks[0].properties.checkInDate, "2026-08-03");
  assert.match(blocks[0].properties.notes, /legal approval/);
});

test("a removal that arrives before creation leaves a durable tombstone, not a phantom delegate", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, removal("busts_in_silhouette", "222.42"));
  await post(handler, reaction("busts_in_silhouette", "222.42", "1000.1"));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].deleted, undefined);
  assert.equal(blocks[0].properties.kind, "slack_reaction_tombstone");
  assert.equal(blocks[0].properties.hidden, true);
  assert.equal(blocks[0].properties.idempotency_key, "slack-delegate:C1:222.42");
});

test("hidden reaction tombstones are never captured or enriched", async () => {
  const { handler, api, blocks, calls } = makeHarness({ anthropicKey: "test-anthropic" });
  await post(handler, removal("busts_in_silhouette", "222.421"));
  const before = calls.fetch.length;
  const result = await api.reconcileMatch("delegate", {
    ts: "222.421", text: "This must never become a visible task", channel: { id: "C1", name: "general" },
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(await api.enrichBlock(blocks[0].id), false);
  assert.equal(calls.fetch.length, before);
  assert.equal(blocks[0].properties.kind, "slack_reaction_tombstone");
  assert.equal(blocks[0].properties.title, undefined);
});

test("delayed message capture re-reads the row and preserves concurrent user edits", async () => {
  const { handler, blocks, setFetch } = makeHarness();
  setFetch(async (url) => {
    if (String(url).includes("reactions.get")) {
      blocks[0].properties.notes = "Keep this user-authored context.";
      blocks[0].properties.myTask = "Keep this user-authored delegate title";
      blocks[0].properties.delegatee = { name: "Taylor" };
      return { ok: true, status: 200, json: async () => ({ ok: true, message: {
        ts: "222.43", text: "Please follow up on the renewal packet tomorrow", user: "U1",
      } }) };
    }
    if (String(url).includes("chat.getPermalink")) return { ok: true, status: 200, json: async () => ({ ok: true, permalink: "https://example.slack.com/archives/C1/p22243" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  await post(handler, reaction("busts_in_silhouette", "222.43", "222.9"));
  assert.equal(blocks[0].properties.notes, "Keep this user-authored context.");
  assert.equal(blocks[0].properties.myTask, "Keep this user-authored delegate title");
  assert.deepEqual(blocks[0].properties.delegatee, { name: "Taylor" });
  assert.equal(blocks[0].properties.source_message_preview, "Please follow up on the renewal packet tomorrow");
});

test("delayed bookmark capture never replaces user-authored notes", async () => {
  const { handler, blocks, setFetch } = makeHarness();
  setFetch(async (url) => {
    if (String(url).includes("reactions.get")) {
      blocks[0].properties.notes = "Keep my investigation notes.";
      return { ok: true, status: 200, json: async () => ({ ok: true, message: {
        ts: "222.44", text: "Please investigate the failed renewal workflow", user: "U1",
      } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  await post(handler, reaction("bookmark", "222.44", "222.9"));
  assert.equal(blocks[0].properties.notes, "Keep my investigation notes.");
  assert.equal(blocks[0].properties.source_message_preview, "Please investigate the failed renewal workflow");
});

test("Haiku enriches from the full thread while retaining capture metadata", async () => {
  const { handler, blocks, setFetch, calls } = makeHarness({ anthropicKey: "test-anthropic" });
  setFetch(async (url) => {
    if (String(url).includes("reactions.get")) return { ok: true, status: 200, json: async () => ({ ok: true, message: { ts: "222.5", thread_ts: "222.0", text: "Can you get this launch issue sorted with Jamie?", user: "U1" } }) };
    if (String(url).includes("conversations.replies")) return { ok: true, status: 200, json: async () => ({ ok: true, messages: [
      { ts: "222.0", user: "U2", text: "Launch is blocked on the pricing approval." },
      { ts: "222.5", user: "U1", text: "Can you get this launch issue sorted with Jamie?" },
      { ts: "222.6", user: "U3", text: "Jamie has the approval packet." },
    ] }) };
    if (String(url).includes("api.anthropic.com")) return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ title: "Get Jamie's pricing approval for launch", summary: "The launch is blocked until Jamie completes the pricing approval packet." }) }] }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  await post(handler, reaction("bookmark", "222.5", "222.9"));
  const props = blocks[0].properties;
  assert.equal(props.title, "Get Jamie's pricing approval for launch");
  assert.equal(props.captureTitle, "Can you get this launch issue sorted with Jamie?");
  assert.equal(props.aiSummary, "The launch is blocked until Jamie completes the pricing approval packet.");
  assert.equal(props.detail, props.aiSummary);
  assert.equal(props.enrichment_status, "complete");
  const anthropicCall = calls.fetch.find((c) => c.url.includes("api.anthropic.com"));
  const payload = JSON.parse(anthropicCall.init.body);
  const promptData = JSON.parse(payload.messages[0].content);
  assert.equal(promptData.thread.length, 3, "the root, reacted message, and reply reach Haiku");
});

test("thread enrichment paginates replies and stores Slack's canonical permalink", async () => {
  const { handler, blocks, setFetch, calls } = makeHarness({ anthropicKey: "test-anthropic" });
  setFetch(async (url) => {
    const value = String(url);
    if (value.includes("reactions.get")) return { ok: true, status: 200, json: async () => ({ ok: true, message: {
      ts: "222.55", thread_ts: "222.50", text: "Please resolve the final launch dependency", user: "U1",
    } }) };
    if (value.includes("chat.getPermalink")) return { ok: true, status: 200, json: async () => ({
      ok: true,
      permalink: "https://example.slack.com/archives/C1/p22255?thread_ts=222.50&cid=C1",
    }) };
    if (value.includes("conversations.replies")) {
      const cursor = new URL(value).searchParams.get("cursor");
      return cursor === "page-2"
        ? { ok: true, status: 200, json: async () => ({ ok: true, messages: [{ ts: "222.56", user: "U2", text: "The final approval arrived." }], response_metadata: { next_cursor: "" } }) }
        : { ok: true, status: 200, json: async () => ({ ok: true, messages: [{ ts: "222.50", user: "U3", text: "Launch dependency thread." }, { ts: "222.55", user: "U1", text: "Please resolve the final launch dependency" }], response_metadata: { next_cursor: "page-2" } }) };
    }
    if (value.includes("api.anthropic.com")) return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ title: "Resolve the final launch dependency", summary: "The final approval has arrived." }) }] }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  await post(handler, reaction("bookmark", "222.55", "222.9"));
  assert.equal(blocks[0].properties.source_id, "https://example.slack.com/archives/C1/p22255?thread_ts=222.50&cid=C1");
  const replyCalls = calls.fetch.filter((c) => c.url.includes("conversations.replies"));
  assert.equal(replyCalls.length, 2);
  assert.equal(new URL(replyCalls[1].url).searchParams.get("cursor"), "page-2");
  const anthropicCall = calls.fetch.find((c) => c.url.includes("api.anthropic.com"));
  const prompt = JSON.parse(JSON.parse(anthropicCall.init.body).messages[0].content);
  assert.ok(prompt.thread.some((message) => message.text === "The final approval arrived."));
});

test("Haiku metadata never overwrites a title edited while enrichment is running", async () => {
  const { handler, blocks, setFetch } = makeHarness({ anthropicKey: "test-anthropic" });
  setFetch(async (url) => {
    if (String(url).includes("reactions.get")) return { ok: true, status: 200, json: async () => ({
      ok: true,
      message: { ts: "222.51", thread_ts: "222.51", text: "Please investigate the customer billing failure today", user: "U1" },
    }) };
    if (String(url).includes("conversations.replies")) {
      blocks[0].properties.title = "Keep my manually edited title";
      return { ok: true, status: 200, json: async () => ({ ok: true, messages: [
        { ts: "222.51", user: "U1", text: "Please investigate the customer billing failure today" },
      ] }) };
    }
    if (String(url).includes("api.anthropic.com")) return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({
      title: "Investigate customer billing failure",
      summary: "A customer billing failure needs investigation today.",
    }) }] }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  await post(handler, reaction("bookmark", "222.51", "222.59"));
  assert.equal(blocks[0].properties.title, "Keep my manually edited title");
  assert.equal(blocks[0].properties.aiTitle, "Investigate customer billing failure");
  assert.equal(blocks[0].properties.aiSummary, "A customer billing failure needs investigation today.");
});

test("malformed Haiku output keeps the useful fallback and schedules a retry", async () => {
  const { handler, blocks, setFetch } = makeHarness({ anthropicKey: "test-anthropic" });
  setFetch(async (url) => {
    if (String(url).includes("reactions.get")) return { ok: true, status: 200, json: async () => ({
      ok: true,
      message: { ts: "222.52", text: "Please investigate the customer billing failure today", user: "U1" },
    }) };
    if (String(url).includes("conversations.replies")) return { ok: true, status: 200, json: async () => ({ ok: true, messages: [
      { ts: "222.52", user: "U1", text: "Please investigate the customer billing failure today" },
    ] }) };
    if (String(url).includes("api.anthropic.com")) return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "not json" }] }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  await post(handler, reaction("bookmark", "222.52", "222.59"));
  const p = blocks[0].properties;
  assert.equal(p.title, "Please investigate the customer billing failure today");
  assert.equal(p.enrichment_status, "retry");
  assert.equal(p.enrichment_attempts, 1);
  assert.ok(Date.parse(p.enrichment_next_attempt_at) > Date.now());
});

test("server reconciliation searches both portable reactions and backfills each record type", async () => {
  const { api, blocks, calls, setFetch } = makeHarness();
  const nowTs = `${Math.floor(Date.now() / 1000) + 1}.000001`;
  setFetch(async (url) => {
    if (String(url).includes("search.messages")) {
      const query = new URL(url).searchParams.get("query");
      const delegate = query === "hasmy::busts_in_silhouette:";
      return { ok: true, status: 200, json: async () => ({ ok: true, messages: {
        matches: [{
          ts: delegate ? nowTs : "222.53",
          text: delegate ? "Follow up with Morgan about the signed contract" : "Review the renewal proposal before Friday afternoon",
          user: "U1",
          channel: { id: "C1", name: "general" },
        }],
        paging: { pages: 1 },
      } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const stats = await api.runReconciliation();
  assert.equal(stats.bookmarks, 1);
  assert.equal(stats.delegates, 1);
  assert.ok(blocks.some((b) => b.properties.idempotency_key === "slack-bookmark:C1:222.53"));
  assert.ok(blocks.some((b) => b.properties.idempotency_key === `slack-delegate:C1:${nowTs}`));
  const queries = calls.fetch
    .filter((c) => c.url.includes("search.messages"))
    .map((c) => new URL(c.url).searchParams.get("query"));
  assert.deepEqual(queries, ["hasmy::bookmark:", "hasmy::busts_in_silhouette:"]);
});

test("reconciliation repairs legacy poller rows that only stored the idempotency key", async () => {
  const { handler, api, blocks, calls, setFetch } = makeHarness();
  await post(handler, reaction("bookmark", "222.531", "222.9"));
  const legacy = blocks[0].properties;
  delete legacy.slack_channel;
  delete legacy.slack_ts;
  delete legacy.source_message_preview;
  legacy.capture_status = "retry";
  setFetch(async (url) => {
    assert.doesNotMatch(String(url), /reactions\.get/, "the search result is the capture seed");
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const result = await api.reconcileMatch("bookmark", {
    ts: "222.531",
    text: "Review the repaired legacy capture before launch",
    user: "U1",
    channel: { id: "C1", name: "general" },
  });
  assert.deepEqual(result, { updated: true });
  assert.equal(blocks[0].properties.slack_channel, "C1");
  assert.equal(blocks[0].properties.slack_ts, "222.531");
  assert.equal(blocks[0].properties.source_message_preview, "Review the repaired legacy capture before launch");
  assert.equal(calls.fetch.some((call) => call.url.includes("reactions.get")), true, "the original webhook capture still used reactions.get");
});

test("completion mirroring selects only rows with valid Slack coordinates", () => {
  const source = require("node:fs").readFileSync(require.resolve("./routes/slack-events.js"), "utf8");
  assert.match(source, /NULLIF\(properties->>'slack_channel', ''\) IS NOT NULL/);
  assert.match(source, /NULLIF\(properties->>'slack_ts', ''\) IS NOT NULL/);
  assert.match(source, /if \(!props\.slack_channel \|\| !props\.slack_ts\) continue/);
});

test("🔖 is idempotent — a duplicate bookmark event makes no second task", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "333.3", "333.9"));
  await post(handler, reaction("bookmark", "333.3", "334.0"));
  assert.equal(blocks.length, 1);
});

test("⌛ then ✅ records exact elapsed, points, and a time_entry", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "444.4", "444.9"));
  await post(handler, reaction("hourglass", "444.4", "1720000000.000000"));
  const started = blocks[0].properties.startedAt;
  assert.ok(started, "startedAt stamped by ⌛");
  // ✅ exactly 40 minutes later
  await post(handler, reaction("white_check_mark", "444.4", "1720002400.000000"));
  const p = blocks[0].properties;
  assert.equal(p.done, true);
  assert.equal(p.completed, true);
  assert.equal(p.actualMinutes, 40);
  assert.ok(p.completedAt, "completedAt stamped");
  assert.match(p.notes, /Took ~40m/);
  // points credited with both estimate and actual
  assert.equal(calls.credit.length, 1);
  assert.equal(calls.credit[0].actual_minutes, 40);
  // a time_entry segment exists for Day Review
  const te = blocks.find(b => b.type === "time_entry");
  assert.ok(te, "time_entry created");
  assert.equal(te.properties.blockId, blocks[0].id);
  assert.equal(te.properties.durSec, 2400);
  assert.equal(te.properties.source, "slack");
});

test(":hourglass_flowing_sand: no longer starts the Slack timer", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "legacy.1", "legacy.9"));
  await post(handler, reaction("hourglass_flowing_sand", "legacy.1", "1720000000.000000"));
  assert.equal(blocks[0].properties.startedAt, undefined);
  assert.equal(blocks[0].properties.everStarted, undefined);

  await post(handler, reaction("white_check_mark", "legacy.1", "1720002400.000000"));
  assert.equal(blocks[0].properties.actualMinutes, 5, "ignored legacy reaction uses the no-timer fallback");
  assert.equal(calls.credit[0].actual_minutes, 5);
});

test("🔖 → ✅ with no ⌛ defaults to 5 minutes", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "555.5", "555.9"));
  await post(handler, reaction("white_check_mark", "555.5", "1720000000.000000"));
  const p = blocks[0].properties;
  assert.equal(p.actualMinutes, 5);
  assert.match(p.notes, /no timer/);
  assert.equal(calls.credit[0].actual_minutes, 5);
  const te = blocks.find(b => b.type === "time_entry");
  assert.equal(te.properties.durSec, 300);
});

test("✅ is idempotent — a retried done event does not double-credit", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "666.6", "666.9"));
  await post(handler, reaction("white_check_mark", "666.6", "1720000000.000000"));
  await post(handler, reaction("white_check_mark", "666.6", "1720000000.000000"));
  assert.equal(calls.credit.length, 1);
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 1);
});

test("reactions from other users are ignored", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "777.7", "777.9", "U_SOMEONE_ELSE"));
  assert.equal(blocks.length, 0);
});

test("✅ on a never-bookmarked message creates nothing", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("white_check_mark", "888.8", "1720000000.000000"));
  assert.equal(blocks.length, 0);
});

const removal = (name, ts, user = DRAKE) => ({
  type: "event_callback",
  event: { type: "reaction_removed", user, reaction: name, item: { type: "message", channel: "C1", ts }, event_ts: "999.9" },
});

// INVERTED IN E1. This used to assert that re-adding 🔖 minted a fresh task,
// which was the last resurrection path left after PR #253: findTaskByKey filtered
// `deleted_at IS NULL`, so a cancelled message's tombstone was invisible and the
// next 🔖 created a duplicate of work the user had explicitly dropped. The lookup
// now includes tombstones (mirroring findBriefBlock in routes/dcc.js) and a
// tombstoned hit means "the user cancelled this — do not re-create".
test("removing 🔖 before ⌛/✅ cancels the task, and re-adding 🔖 does NOT resurrect it", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "aaa.1", "aaa.9"));
  assert.equal(blocks[0].deleted, undefined);
  await post(handler, removal("bookmark", "aaa.1"));
  assert.equal(blocks[0].deleted, true);
  await post(handler, reaction("bookmark", "aaa.1", "aaa.95"));
  assert.equal(blocks.filter(b => b.type === "block").length, 1, "no second task minted");
  assert.equal(blocks.filter(b => b.type === "block" && !b.deleted).length, 0, "and the tombstone stays a tombstone");
});

test("removing 🔖 after ⌛ is ignored — an in-flight task is kept", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "bbb.1", "bbb.9"));
  await post(handler, reaction("hourglass", "bbb.1", "1720000000.000000"));
  await post(handler, removal("bookmark", "bbb.1"));
  assert.equal(blocks[0].deleted, undefined);
  assert.ok(blocks[0].properties.startedAt);
});

// ── E1: the reaction lifecycle is reversible ────────────────────────────────

// The keep-guard bug: clearStart DELETES startedAt, so the old
// `startedAt || completedAt` check passed and threw away real work.
test("🔖 → ⌛ → un-⌛ → un-🔖 keeps the task (everStarted is sticky)", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "ccc.1", "ccc.9"));
  await post(handler, reaction("hourglass", "ccc.1", "1720000000.000000"));
  await post(handler, removal("hourglass", "ccc.1"));
  assert.equal(blocks[0].properties.startedAt, undefined, "un-⌛ still clears the running timer");
  assert.equal(blocks[0].properties.everStarted, true, "but the fact it was started is sticky");
  await post(handler, removal("bookmark", "ccc.1"));
  assert.equal(blocks[0].deleted, undefined, "worked-on task survives un-🔖");
});

test("un-🔖 keeps a task that was checked off in the DCC UI (_done overlay)", async () => {
  const { handler, blocks, overlay } = makeHarness();
  await post(handler, reaction("bookmark", "ddd.1", "ddd.9"));
  overlay._done.ids.push(blocks[0].id);              // the browser check-off
  await post(handler, removal("bookmark", "ddd.1"));
  assert.equal(blocks[0].deleted, undefined);
});

test("un-✅ reopens the task, drops the timer row, and reverses the credit", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "eee.1", "eee.9"));
  await post(handler, reaction("hourglass", "eee.1", "1720000000.000000"));
  await post(handler, reaction("white_check_mark", "eee.1", "1720001200.000000"));
  const task = blocks[0];
  assert.equal(task.properties.done, true);
  assert.equal(task.properties.actualMinutes, 20);
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 1);

  await post(handler, removal("white_check_mark", "eee.1"));
  assert.equal(task.properties.status, "open");
  assert.equal(task.properties.done, undefined);
  assert.equal(task.properties.completed, undefined);
  assert.equal(task.properties.completedAt, undefined);
  assert.equal(task.properties.doneAt, undefined);
  assert.equal(task.properties.completedBy, undefined);
  assert.equal(task.properties.actualMinutes, undefined);
  assert.doesNotMatch(task.properties.notes, /Took ~/i, "the timer note is gone while Slack context remains");
  assert.match(task.properties.notes, /Bookmarked from Slack/);
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 0, "no orphaned Day Review segment");
  assert.deepEqual(calls.revoke, [`${task.date}:${task.id}`], "credit reversed on the same key ✅ used");
  assert.equal(calls.reactionsAdd.length, 1, "🔖 goes back on the message");
  // Assert the WHOLE outbound call. `name` alone would still pass if the token
  // became a bot token (invisible to the poller's hasmy: query) or if the
  // reaction landed on the wrong message.
  assert.equal(calls.reactionsAdd[0].url, "https://slack.com/api/reactions.add");
  assert.equal(calls.reactionsAdd[0].headers.Authorization, "Bearer xoxp-test", "user token, not a bot token");
  assert.deepEqual(calls.reactionsAdd[0].body, { channel: "C1", timestamp: "eee.1", name: "bookmark" });
  assert.ok(calls.broadcast.some(b => b.payload.action === "slack-undone"));
});

test("un-✅ then re-✅ re-times from the original ⌛ and re-credits", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "fff.1", "fff.9"));
  await post(handler, reaction("hourglass", "fff.1", "1720000000.000000"));
  await post(handler, reaction("white_check_mark", "fff.1", "1720001200.000000"));
  await post(handler, removal("white_check_mark", "fff.1"));
  await post(handler, reaction("white_check_mark", "fff.1", "1720001200.000000"));
  const p = blocks[0].properties;
  assert.equal(p.done, true);
  assert.equal(p.actualMinutes, 20, "measured from the original ⌛, not from zero");
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 1);
  assert.equal(calls.credit.length, 2, "the ledger row was deleted, so the re-completion is credited again");
});

// The 🔖 we re-add is added AS DRAKE (user token — a bot's reaction would not match
// the poller's `hasmy::bookmark:` query), so Slack echoes the event back at us.
test("the 🔖 re-added after un-✅ echoes back harmlessly — no duplicate, no loop", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "jjj.1", "jjj.9"));
  await post(handler, reaction("hourglass", "jjj.1", "1720000000.000000"));
  await post(handler, reaction("white_check_mark", "jjj.1", "1720001200.000000"));
  await post(handler, removal("white_check_mark", "jjj.1"));
  assert.equal(calls.reactionsAdd.length, 1);

  // Slack replays our own reactions.add as a reaction_added event.
  await post(handler, reaction("bookmark", "jjj.1", "jjj.99"));
  assert.equal(blocks.filter(b => b.type === "block").length, 1, "no second task");
  assert.equal(blocks[0].properties.status, "open", "still open — the echo changes nothing");
  assert.equal(calls.reactionsAdd.length, 1, "and it does not trigger another reactions.add");
});

// The row is only ONE of two completion stores. Leave the overlay set and the
// un-✅ silently re-applies itself: the UI keeps rendering the row checked, and
// reconcileTiming re-derives the timing that was just cleared.
test("un-✅ also prunes the task from the day's _done overlay", async () => {
  const { handler, blocks, dayRootRow } = makeHarness();
  await post(handler, reaction("bookmark", "kkk.1", "kkk.9"));
  const task = blocks[0];
  // Simulate the browser check-off landing in the overlay first, then a Slack ✅.
  dayRootRow.properties._done.ids.push(task.id);
  dayRootRow.properties._done.at[task.id] = "2026-07-28T18:00:00.000Z";
  await post(handler, reaction("white_check_mark", "kkk.1", "1720000000.000000"));

  await post(handler, removal("white_check_mark", "kkk.1"));
  assert.equal(task.properties.status, "open");
  assert.deepEqual(dayRootRow.properties._done.ids, [], "overlay id removed");
  assert.deepEqual(dayRootRow.properties._done.at, {}, "overlay timestamp removed");
});

// The overlay is keyed by local_id OR the row id depending on which surface wrote
// it. Only the row-id half was covered; a prune that forgot local_id would leave
// browser-created tasks stuck done.
test("un-✅ prunes an overlay entry keyed by local_id, not just the row id", async () => {
  const { handler, blocks, dayRootRow } = makeHarness();
  await post(handler, reaction("bookmark", "nnn.1", "nnn.9"));
  const task = blocks[0];
  task.properties.local_id = "ui-minted-1";
  dayRootRow.properties._done.ids.push("ui-minted-1");
  dayRootRow.properties._done.at["ui-minted-1"] = "2026-07-28T18:00:00.000Z";
  dayRootRow.properties._done.ids.push("someone-elses-task");   // must survive
  await post(handler, reaction("white_check_mark", "nnn.1", "1720000000.000000"));

  await post(handler, removal("white_check_mark", "nnn.1"));
  assert.deepEqual(dayRootRow.properties._done.ids, ["someone-elses-task"], "only our key is pruned");
  assert.deepEqual(dayRootRow.properties._done.at, {});
  assert.equal(task.properties.status, "open");
});

test("un-✅ leaves the task done when the overlay prune fails", async () => {
  const { handler, blocks, dayRootRow, failDayRootWrite } = makeHarness();
  await post(handler, reaction("bookmark", "ooo.1", "ooo.9"));
  const task = blocks[0];
  dayRootRow.properties._done.ids.push(task.id);
  await post(handler, reaction("white_check_mark", "ooo.1", "1720000000.000000"));

  failDayRootWrite(true);
  await post(handler, removal("white_check_mark", "ooo.1"));
  // Both stores stay done. A half-reversal would let the overlay silently
  // re-apply the completion while the credit stayed revoked, with no retry.
  assert.equal(task.properties.done, true, "row stays done so re-toggling ✅ retries");
  assert.ok(task.properties.completedAt);
  assert.equal(task.properties.actualMinutes, 5, "timing untouched");
  assert.deepEqual(dayRootRow.properties._done.ids, [task.id], "overlay still marks it done too");
});

test("un-✅ leaves the task done when the credit revoke fails", async () => {
  const { handler, blocks, calls } = makeHarness({
    slotStore: { revokeTaskCredit: async () => { throw new Error("ledger unavailable"); } },
  });
  await post(handler, reaction("bookmark", "lll.1", "lll.9"));
  await post(handler, reaction("white_check_mark", "lll.1", "1720000000.000000"));
  const task = blocks[0];
  await post(handler, removal("white_check_mark", "lll.1"));
  // Both stores stay "done", which is recoverable by re-toggling the reaction.
  // A half-reversal (row open, points still banked, ledger row still blocking the
  // re-award) would not be, and Slack never retries a reaction_removed.
  assert.equal(task.properties.done, true, "row stays done");
  assert.ok(task.properties.completedAt, "and stays completed");
  assert.equal(task.properties.actualMinutes, 5, "timing is untouched");
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 1, "segment survives");
  assert.equal(calls.reactionsAdd.length, 0, "no 🔖 re-add on a failed reversal");
});

// The gate used to be `DRAKE_UID && ev.user !== DRAKE_UID`, which processed EVERY
// workspace member's reactions when the var was missing. handleUndone now moves a
// real points balance and addSlackReaction writes to Slack as Drake, so an unset
// var would hand any member a react-as-Drake primitive. Fail closed instead.
test("reactions are ignored entirely when DRAKE_SLACK_USER_ID is unset (fail closed)", async () => {
  const { handler, blocks } = makeHarness({ drakeUid: "" });
  await post(handler, reaction("bookmark", "mmm.1", "mmm.9", "U_RANDOM_COWORKER"));
  await post(handler, reaction("bookmark", "mmm.2", "mmm.9", DRAKE));
  assert.equal(blocks.length, 0, "an unset gate processes nobody, not everybody");
});

test("un-✅ on a task that was never completed is a no-op", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "ggg.1", "ggg.9"));
  await post(handler, removal("white_check_mark", "ggg.1"));
  assert.equal(blocks[0].properties.status, "open");
  assert.equal(calls.revoke.length, 0);
  assert.equal(calls.reactionsAdd.length, 0);
});

test("un-✅ is idempotent — a retried removal does not double-revoke", async () => {
  const { handler, calls } = makeHarness();
  await post(handler, reaction("bookmark", "hhh.1", "hhh.9"));
  await post(handler, reaction("white_check_mark", "hhh.1", "1720000000.000000"));
  await post(handler, removal("white_check_mark", "hhh.1"));
  await post(handler, removal("white_check_mark", "hhh.1"));
  assert.equal(calls.revoke.length, 1);
});

test("⌛ and ✅ ignore a cancelled (tombstoned) task", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "iii.1", "iii.9"));
  await post(handler, removal("bookmark", "iii.1"));
  await post(handler, reaction("hourglass", "iii.1", "1720000000.000000"));
  await post(handler, reaction("white_check_mark", "iii.1", "1720001200.000000"));
  assert.equal(blocks[0].properties.startedAt, undefined);
  assert.equal(blocks[0].properties.done, undefined);
  assert.equal(calls.credit.length, 0);
});
