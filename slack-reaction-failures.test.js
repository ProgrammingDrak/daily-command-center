// Reaction-write failure handling in routes/slack-events.js.
//
// Prod was retrying permanently-dead writes forever. From `railway logs`, 20 of 46
// lines in one window were reactions.remove failures — 12 channel_not_found, 6
// message_not_found, 2 ratelimited. Only `no_reaction` was terminal, so each of
// the 12 deleted Slack rows re-attempted three removals every five-minute
// reconcile pass, indefinitely, and eventually hit Slack's rate limiter.
//
// These assert on OBSERVABLE behaviour — whether a Slack HTTP call is attempted at
// all — rather than on internal maps, because "stop asking" is the whole feature
// and a state assertion would pass even if the call still went out.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mount = require("./routes/slack-events.js");

const TODAY = "2026-08-20";

function makeHarness(opts = {}) {
  process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
  process.env.DRAKE_SLACK_USER_ID = "U_DRAKE";
  process.env.DCC_SERVICE_USER_ID = "1";
  process.env.DCC_SERVICE_WORKSPACE_ID = "ws-1";
  process.env.SLACK_USER_TOKEN = opts.noToken ? "" : "xoxp-test";
  process.env.SLACK_DELEGATE_IMPORT_AFTER = "2026-01-01T00:00:00.000Z";
  process.env.SLACK_RECONCILE_ENABLED = "0";
  if (opts.deadTtlMs) process.env.SLACK_DEAD_MESSAGE_TTL_MS = String(opts.deadTtlMs);
  else delete process.env.SLACK_DEAD_MESSAGE_TTL_MS;
  if (opts.backoffMs) process.env.SLACK_RATE_LIMIT_BACKOFF_MS = String(opts.backoffMs);
  else delete process.env.SLACK_RATE_LIMIT_BACKOFF_MS;
  delete process.env.ANTHROPIC_API_KEY;

  const blocks = [];
  const writes = [];              // every reactions.add / reactions.remove ATTEMPT
  const logs = [];
  let failWith = null;            // { code, retryAfter, only } | null

  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("reactions.add") || u.includes("reactions.remove")) {
      const parsed = new URL(u.split("?")[0] + "?" + (u.split("?")[1] || ""));
      const verb = u.includes("reactions.add") ? "add" : "remove";
      writes.push({ method: verb, url: u });
      if (failWith && (!failWith.only || failWith.only === verb)) {
        return {
          ok: false, status: failWith.code === "ratelimited" ? 429 : 200,
          headers: { get: (h) => (h.toLowerCase() === "retry-after" && failWith.retryAfter ? String(failWith.retryAfter) : null) },
          json: async () => ({ ok: false, error: failWith.code }),
        };
      }
      void parsed;
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  };

  const realLog = console.log, realWarn = console.warn, realError = console.error;
  console.log = (...a) => logs.push(["log", a.join(" ")]);
  console.warn = (...a) => logs.push(["warn", a.join(" ")]);
  console.error = (...a) => logs.push(["error", a.join(" ")]);
  const restoreConsole = () => { console.log = realLog; console.warn = realWarn; console.error = realError; };

  const dayRoot = { id: `day-root-ws-1-${TODAY}`, date: TODAY, type: "day_root", properties: { _done: { ids: [], at: {} } } };
  const ctx = {
    crypto,
    getTodayStr: () => TODAY,
    APP_TIME_ZONE: "America/New_York",
    broadcast: () => {},
    slotStore: { earnTaskCredit: async () => ({ awarded: true }), revokeTaskCredit: async () => ({ revoked: true }) },
    blockDB: {
      getBlock: async (id) => (id === dayRoot.id ? dayRoot : blocks.find(b => b.id === id && !b.deleted_at) || null),
      getBlockIncludingDeleted: async (id) => (id === dayRoot.id ? dayRoot : blocks.find(b => b.id === id) || null),
      getTaskTimeEntries: async () => [],
      ensureDayRoot: async () => dayRoot.id,
      updateBlock: async (id, { properties }) => {
        const b = blocks.find(x => x.id === id); if (b) b.properties = properties; return b || { id };
      },
      deleteBlock: async (id) => ({ id }),
      createBlock: async ({ properties }) => { const b = { id: "new", properties }; blocks.push(b); return b; },
      createItineraryTask: async ({ date, properties }) => { const b = { id: "new", date, properties }; blocks.push(b); return b; },
    },
    pool: {
      connect: async () => ({ query: async () => ({ rows: [{ locked: true }] }), release() {} }),
      query: async () => ({ rows: [] }),
    },
  };

  const app = { post: () => {} };
  const api = mount(app, ctx);
  return {
    api, ctx, blocks, writes, logs, restoreConsole,
    setFailure: (code, opts = {}) => { failWith = code ? { code, retryAfter: opts.retryAfter, only: opts.only } : null; },
  };
}

// A bookmarked task, live and open — projectTaskToSlack's ordinary case.
function task(h, ts, extra = {}) {
  const row = {
    id: `task-${ts}`, type: "block", date: TODAY, workspace_id: "ws-1", user_id: 1, deleted_at: null,
    properties: {
      kind: "task", source: "slack-bookmark", idempotency_key: `slack-bookmark:C1:${ts}`,
      slack_channel: "C1", slack_ts: ts, title: "Chase it", status: "open", ...extra,
    },
  };
  h.blocks.push(row);
  return row;
}

test("a channel_not_found stops every later reaction write for that message", async (t) => {
  const h = makeHarness();
  t.after(h.restoreConsole);
  const row = task(h, "dead.1");

  h.setFailure("channel_not_found");
  await h.ctx.syncSlackTaskReactions(row);
  const firstPass = h.writes.length;
  assert.ok(firstPass > 0, "the first pass genuinely tries");

  // The reconcile loop runs this every five minutes. Before the fix, every pass
  // re-attempted all three removals forever.
  h.setFailure(null);
  await h.ctx.syncSlackTaskReactions(row);
  await h.ctx.syncSlackTaskReactions(row);
  assert.equal(h.writes.length, firstPass, "no further attempts, even once Slack would answer");
});

test("message_not_found is terminal too", async (t) => {
  const h = makeHarness();
  t.after(h.restoreConsole);
  const row = task(h, "dead.2");
  h.setFailure("message_not_found");
  await h.ctx.syncSlackTaskReactions(row);
  const after = h.writes.length;
  h.setFailure(null);
  await h.ctx.syncSlackTaskReactions(row);
  assert.equal(h.writes.length, after);
});

test("the whole permanent set matches the poller's, so the two cannot drift", async (t) => {
  for (const code of ["message_not_found", "channel_not_found", "is_archived", "not_in_channel", "no_item_specified"]) {
    const h = makeHarness();
    t.after(h.restoreConsole);
    const row = task(h, "set." + code);
    h.setFailure(code);
    await h.ctx.syncSlackTaskReactions(row);
    const after = h.writes.length;
    h.setFailure(null);
    await h.ctx.syncSlackTaskReactions(row);
    assert.equal(h.writes.length, after, `${code} must be terminal`);
  }
});

test("a dead marker is per MESSAGE, not per emoji or per row", async (t) => {
  const h = makeHarness();
  t.after(h.restoreConsole);
  const dead = task(h, "dead.3");
  const alive = task(h, "alive.3");

  h.setFailure("channel_not_found");
  await h.ctx.syncSlackTaskReactions(dead);
  const afterDead = h.writes.length;

  h.setFailure(null);
  await h.ctx.syncSlackTaskReactions(alive);
  assert.ok(h.writes.length > afterDead, "a different message is unaffected");

  const beforeRetry = h.writes.length;
  await h.ctx.syncSlackTaskReactions(dead);
  assert.equal(h.writes.length, beforeRetry, "and the dead one stays dead");
});

test("the unreachable message is logged once, not once per emoji per pass", async (t) => {
  const h = makeHarness();
  t.after(h.restoreConsole);
  const row = task(h, "dead.4");
  h.setFailure("channel_not_found");
  await h.ctx.syncSlackTaskReactions(row);
  await h.ctx.syncSlackTaskReactions(row);
  const unreachable = h.logs.filter(([, m]) => m.includes("is unreachable"));
  assert.equal(unreachable.length, 1, "one line per message, ever");
  // And none of the old per-emoji error spam.
  assert.equal(h.logs.filter(([lvl, m]) => lvl === "error" && m.includes("reactions.")).length, 0);
});

test("ratelimited pauses writes across the workspace, not just that message", async (t) => {
  const h = makeHarness({ backoffMs: 30_000 });
  t.after(h.restoreConsole);
  const first = task(h, "rl.1");
  const second = task(h, "rl.2");

  h.setFailure("ratelimited");
  await h.ctx.syncSlackTaskReactions(first);
  const afterLimit = h.writes.length;

  h.setFailure(null);
  await h.ctx.syncSlackTaskReactions(second);
  assert.equal(h.writes.length, afterLimit,
    "walking the rest of the backlog into the same wall is what caused the limit");
  assert.ok(h.logs.some(([lvl, m]) => lvl === "warn" && m.includes("rate-limited by Slack")));
});

test("the rate-limit pause expires and writes resume", async (t) => {
  const h = makeHarness({ backoffMs: 1 });
  t.after(h.restoreConsole);
  const row = task(h, "rl.3");
  h.setFailure("ratelimited");
  await h.ctx.syncSlackTaskReactions(row);
  const afterLimit = h.writes.length;

  h.setFailure(null);
  await new Promise(r => setTimeout(r, 15));
  await h.ctx.syncSlackTaskReactions(row);
  assert.ok(h.writes.length > afterLimit, "a pause, not a permanent stop");
});

test("ratelimited does NOT mark the message dead", async (t) => {
  // The message is fine; we were simply going too fast. Marking it dead would
  // silently drop a reaction that only needed a moment.
  const h = makeHarness({ backoffMs: 40 });
  t.after(h.restoreConsole);
  const row = task(h, "rl.4");
  const other = task(h, "rl.4b");
  h.setFailure("ratelimited");
  await h.ctx.syncSlackTaskReactions(row);
  const afterLimit = h.writes.length;

  // It must be a PAUSE (so a second message is held back too) and not a death
  // (so both recover once the window passes). Asserting only the recovery would
  // pass even if ratelimited were treated as an ordinary retryable error.
  h.setFailure(null);
  await h.ctx.syncSlackTaskReactions(other);
  assert.equal(h.writes.length, afterLimit, "the pause is workspace-wide while it lasts");

  await new Promise(r => setTimeout(r, 70));
  await h.ctx.syncSlackTaskReactions(row);
  assert.ok(h.writes.length > afterLimit, "and the original message was never marked dead");
  assert.ok(!h.logs.some(([, m]) => m.includes("is unreachable")));
});

test("Slack's own Retry-After wins over the fallback backoff", async (t) => {
  const h = makeHarness({ backoffMs: 1 });
  t.after(h.restoreConsole);
  const row = task(h, "rl.5");
  h.setFailure("ratelimited", { retryAfter: 60 });   // 60s from Slack vs a 1ms fallback
  await h.ctx.syncSlackTaskReactions(row);
  const afterLimit = h.writes.length;

  h.setFailure(null);
  await new Promise(r => setTimeout(r, 20));
  await h.ctx.syncSlackTaskReactions(row);
  assert.equal(h.writes.length, afterLimit, "still paused, because Slack said 60s");
  assert.ok(h.logs.some(([, m]) => m.includes("pausing reaction writes for 60s")));
});

test("a retryable error is retried rather than swallowed", async (t) => {
  // missing_scope before a reinstall is the motivating case: transient config, not
  // a dead message. Treating it as terminal would strand the reaction silently.
  const h = makeHarness();
  t.after(h.restoreConsole);
  const row = task(h, "retry.1");
  h.setFailure("missing_scope");
  await h.ctx.syncSlackTaskReactions(row);
  const after = h.writes.length;
  h.setFailure(null);
  await h.ctx.syncSlackTaskReactions(row);
  assert.ok(h.writes.length > after, "it tries again next pass");
  assert.ok(h.logs.some(([lvl, m]) => lvl === "error" && m.includes("missing_scope")));
});

test("the dead marker expires so a genuine recovery heals itself", async (t) => {
  // A private channel the token is later invited to reads exactly like a
  // permanently-gone one from here, so the marker cannot be forever.
  const h = makeHarness({ deadTtlMs: 40 });
  t.after(h.restoreConsole);
  const row = task(h, "ttl.1");
  h.setFailure("channel_not_found");
  await h.ctx.syncSlackTaskReactions(row);
  const after = h.writes.length;

  h.setFailure(null);
  await h.ctx.syncSlackTaskReactions(row);
  assert.equal(h.writes.length, after, "inside the TTL it stays quiet");

  // Past it, the marker has to lapse — otherwise a rejoined private channel can
  // never get its reactions back. Asserting only the quiet half would pass with
  // no expiry at all.
  await new Promise(r => setTimeout(r, 70));
  await h.ctx.syncSlackTaskReactions(row);
  assert.ok(h.writes.length > after, "past the TTL it tries again");
});

test("already_reacted and no_reaction still count as success", async (t) => {
  // Each writer forgives only its OWN "already in the desired state" answer:
  // reactions.add gets already_reacted, reactions.remove gets no_reaction. The
  // other direction would be a genuine surprise and should still be logged.
  for (const [code, only] of [["already_reacted", "add"], ["no_reaction", "remove"]]) {
    const h = makeHarness();
    t.after(h.restoreConsole);
    const row = task(h, "ok." + code);
    h.setFailure(code, { only });
    await h.ctx.syncSlackTaskReactions(row);
    assert.ok(!h.logs.some(([, m]) => m.includes("is unreachable")), `${code} is not a death`);
    assert.equal(h.logs.filter(([lvl]) => lvl === "error").length, 0, `${code} is not an error`);
  }
});

test("with no token configured nothing is attempted at all", async (t) => {
  const h = makeHarness({ noToken: true });
  t.after(h.restoreConsole);
  const row = task(h, "notok.1");
  await h.ctx.syncSlackTaskReactions(row);
  assert.equal(h.writes.length, 0);
  assert.ok(h.logs.some(([lvl, m]) => lvl === "warn" && m.includes("no Slack token")));
  // And it must SKIP rather than fall through: slackApi would throw slack_no_token
  // before reaching fetch, so the write count alone cannot tell the two apart —
  // the absence of an error log is what proves we never tried.
  assert.equal(h.logs.filter(([lvl]) => lvl === "error").length, 0);
  assert.ok(!h.logs.some(([, m]) => m.includes("no Slack token is configured")));
});
