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

  const blocks = [];            // {id, date, properties, type}
  const calls = { credit: [], revoke: [], broadcast: [], reactionsAdd: [] };
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
  let fetchImpl = async (url, init) => ({ status: 200, json: async () => ({ ok: true }) });
  global.fetch = async (url, init) => {
    calls.reactionsAdd.push({ url, headers: init.headers, body: JSON.parse(init.body) });
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
  mount(app, ctx);
  return { handler, blocks, calls, overlay, dayRootRow, setFetch, failDayRootWrite };
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

test("🔖 creates a 5-min title_pending task keyed by channel:ts", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "222.2", "222.9"));
  assert.equal(blocks.length, 1);
  const p = blocks[0].properties;
  assert.equal(p.idempotency_key, "slack-bookmark:C1:222.2");
  assert.equal(p.estimatedMinutes, 5);
  assert.equal(p.title_pending, true);
  assert.equal(p.source, "slack-bookmark");
  assert.equal(p.status, "open");
  // source_id must be an http(s) URL so the DCC row renders the "Slack ↗" pill
  assert.match(p.source_id, /^https:\/\/.*slack\.com\/archives\//);
});

test("🔖 is idempotent — a duplicate bookmark event makes no second task", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "333.3", "333.9"));
  await post(handler, reaction("bookmark", "333.3", "334.0"));
  assert.equal(blocks.length, 1);
});

test("⏳ then ✅ records exact elapsed, points, and a time_entry", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "444.4", "444.9"));
  await post(handler, reaction("hourglass_flowing_sand", "444.4", "1720000000.000000"));
  const started = blocks[0].properties.startedAt;
  assert.ok(started, "startedAt stamped by ⏳");
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

test("🔖 → ✅ with no ⏳ defaults to 5 minutes", async () => {
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
test("removing 🔖 before ⏳/✅ cancels the task, and re-adding 🔖 does NOT resurrect it", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "aaa.1", "aaa.9"));
  assert.equal(blocks[0].deleted, undefined);
  await post(handler, removal("bookmark", "aaa.1"));
  assert.equal(blocks[0].deleted, true);
  await post(handler, reaction("bookmark", "aaa.1", "aaa.95"));
  assert.equal(blocks.filter(b => b.type === "block").length, 1, "no second task minted");
  assert.equal(blocks.filter(b => b.type === "block" && !b.deleted).length, 0, "and the tombstone stays a tombstone");
});

test("removing 🔖 after ⏳ is ignored — an in-flight task is kept", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "bbb.1", "bbb.9"));
  await post(handler, reaction("hourglass_flowing_sand", "bbb.1", "1720000000.000000"));
  await post(handler, removal("bookmark", "bbb.1"));
  assert.equal(blocks[0].deleted, undefined);
  assert.ok(blocks[0].properties.startedAt);
});

// ── E1: the reaction lifecycle is reversible ────────────────────────────────

// The keep-guard bug: clearStart DELETES startedAt, so the old
// `startedAt || completedAt` check passed and threw away real work.
test("🔖 → ⏳ → un-⏳ → un-🔖 keeps the task (everStarted is sticky)", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "ccc.1", "ccc.9"));
  await post(handler, reaction("hourglass_flowing_sand", "ccc.1", "1720000000.000000"));
  await post(handler, removal("hourglass_flowing_sand", "ccc.1"));
  assert.equal(blocks[0].properties.startedAt, undefined, "un-⏳ still clears the running timer");
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
  await post(handler, reaction("hourglass_flowing_sand", "eee.1", "1720000000.000000"));
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
  assert.equal(task.properties.notes, undefined, "the ⏱ note is gone");
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

test("un-✅ then re-✅ re-times from the original ⏳ and re-credits", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "fff.1", "fff.9"));
  await post(handler, reaction("hourglass_flowing_sand", "fff.1", "1720000000.000000"));
  await post(handler, reaction("white_check_mark", "fff.1", "1720001200.000000"));
  await post(handler, removal("white_check_mark", "fff.1"));
  await post(handler, reaction("white_check_mark", "fff.1", "1720001200.000000"));
  const p = blocks[0].properties;
  assert.equal(p.done, true);
  assert.equal(p.actualMinutes, 20, "measured from the original ⏳, not from zero");
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 1);
  assert.equal(calls.credit.length, 2, "the ledger row was deleted, so the re-completion is credited again");
});

// The 🔖 we re-add is added AS DRAKE (user token — a bot's reaction would not match
// the poller's `hasmy::bookmark:` query), so Slack echoes the event back at us.
test("the 🔖 re-added after un-✅ echoes back harmlessly — no duplicate, no loop", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "jjj.1", "jjj.9"));
  await post(handler, reaction("hourglass_flowing_sand", "jjj.1", "1720000000.000000"));
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

test("⏳ and ✅ ignore a cancelled (tombstoned) task", async () => {
  const { handler, blocks, calls } = makeHarness();
  await post(handler, reaction("bookmark", "iii.1", "iii.9"));
  await post(handler, removal("bookmark", "iii.1"));
  await post(handler, reaction("hourglass_flowing_sand", "iii.1", "1720000000.000000"));
  await post(handler, reaction("white_check_mark", "iii.1", "1720001200.000000"));
  assert.equal(blocks[0].properties.startedAt, undefined);
  assert.equal(blocks[0].properties.done, undefined);
  assert.equal(calls.credit.length, 0);
});
