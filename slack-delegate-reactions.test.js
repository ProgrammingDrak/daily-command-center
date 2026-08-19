// Unit tests for the 👥 half of routes/slack-events.js: the completion mirror for
// Waiting items, and 🔖 ⇄ 👥 type conversion in both directions.
//
// Before this, a delegated item was a one-way capture. ✅ on a 👥-only message hit
// handleDone, which looked up the `slack-bookmark:` key, found nothing and logged;
// and closing the item in the DCC left the message wearing only 👥 because
// projectTaskToSlack returned early on any source that was not slack-bookmark.
//
// The harness captures reactions.remove as well as reactions.add — the removes are
// half the contract here (⌛ stripped off a Waiting item, the losing identity
// reaction taken off after a conversion) and were previously unobservable.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mount = require("./routes/slack-events.js");
const P = require("./lib/slack-provenance.js");

const SECRET = "test-signing-secret";
const DRAKE = "U_DRAKE";
const TODAY = "2026-07-28";

function makeHarness(opts = {}) {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.DRAKE_SLACK_USER_ID = DRAKE;
  process.env.DCC_SERVICE_USER_ID = "1";
  process.env.DCC_SERVICE_WORKSPACE_ID = "ws-1";
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  process.env.SLACK_DELEGATE_IMPORT_AFTER = "2026-01-01T00:00:00.000Z";
  process.env.SLACK_RECONCILE_ENABLED = "0";
  delete process.env.ANTHROPIC_API_KEY;
  if (opts.memoMs !== undefined) process.env.SLACK_PROJECTION_MEMO_MS = String(opts.memoMs);
  else delete process.env.SLACK_PROJECTION_MEMO_MS;

  const blocks = [];
  const calls = {
    credit: [], revoke: [], broadcast: [],
    add: [], remove: [],
    completeWaiting: [], reopenWaiting: [], convert: [],
  };
  let seq = 0;
  const dayRoot = { id: `day-root-ws-1-${TODAY}`, date: TODAY, type: "day_root", properties: { _done: { ids: [], at: {} } } };

  global.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    if (u.includes("reactions.add")) calls.add.push(body);
    if (u.includes("reactions.remove")) calls.remove.push(body);
    if (u.includes("reactions.get")) {
      return { ok: true, status: 200, json: async () => ({
        ok: true,
        message: { ts: new URL(u).searchParams.get("timestamp"), text: "Can you chase the signed contract?", user: "U_ALEX" },
      }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const ctx = {
    crypto,
    getTodayStr: () => TODAY,
    APP_TIME_ZONE: "America/New_York",
    broadcast: (ev, payload) => calls.broadcast.push({ ev, payload }),
    slotStore: {
      earnTaskCredit: async (_ws, _uid, body) => { calls.credit.push(body); return { awarded: true }; },
      revokeTaskCredit: async (_ws, _uid, key) => { calls.revoke.push(key); return { revoked: true }; },
    },
    blockDB: {
      getBlock: async (id) => (id === dayRoot.id ? dayRoot : blocks.find(b => b.id === id && !b.deleted_at) || null),
      getBlockIncludingDeleted: async (id) => (id === dayRoot.id ? dayRoot : blocks.find(b => b.id === id) || null),
      getTaskTimeEntries: async () => [],
      ensureDayRoot: async () => dayRoot.id,
      setTaskCompletion: async ({ taskRef, completed, completedAt, mutationId }) => {
        const b = blocks.find(x => x.id === taskRef);
        if (!b) throw new Error("not found " + taskRef);
        const props = { ...(b.properties || {}) };
        if (completed) Object.assign(props, { status: "done", done: true, completedAt, doneAt: completedAt });
        else { props.status = "open"; delete props.done; delete props.completedAt; delete props.doneAt; }
        b.properties = props;
        return { task: b, affectedTasks: [b], broadcastIds: [b.id], persistenceTarget: "task_row", duplicate: false, revision: mutationId };
      },
      createItineraryTask: async ({ date, properties }) => {
        const b = { id: `blk-${++seq}`, date, type: "block", properties, workspace_id: "ws-1", user_id: 1, deleted_at: null };
        blocks.push(b); return { id: b.id };
      },
      createBlock: async ({ id, type, date, properties }) => {
        const b = { id: id || `blk-${++seq}`, date: date || null, type, properties, workspace_id: "ws-1", user_id: 1, deleted_at: null };
        blocks.push(b); return { id: b.id };
      },
      updateBlock: async (id, { properties }) => {
        if (id === dayRoot.id) { dayRoot.properties = properties; return { id }; }
        const b = blocks.find(x => x.id === id);
        if (!b) throw new Error("not found " + id);
        b.properties = properties;
        return b;
      },
      deleteBlock: async (id) => {
        const b = blocks.find(x => x.id === id);
        if (b) b.deleted_at = "2026-07-28T00:00:00.000Z";
        return { id, deleted_at: b && b.deleted_at };
      },
      undeleteBlock: async (id) => {
        const b = blocks.find(x => x.id === id);
        if (!b) throw new Error("not found " + id);
        b.deleted_at = null;
        return b;
      },
    },
    pool: {
      connect: async () => ({ query: async () => ({ rows: [{ locked: true }] }), release() {} }),
      query: async (sql, params) => {
        if (sql.includes("idempotency_key")) {
          const twoKey = /IN \(\$1, \$2\)/.test(sql);
          const keys = twoKey ? [params[0], params[1]] : [params[0]];
          const ws = twoKey ? params[2] : params[1];
          const hits = blocks
            .filter(b => b.properties && keys.includes(b.properties.idempotency_key)
              && b.workspace_id === ws && b.type !== "time_entry")
            .sort((a, b) => (a.deleted_at ? 1 : 0) - (b.deleted_at ? 1 : 0));
          const shape = (h) => ({ id: h.id, type: h.type, date: h.date, properties: h.properties, deleted_at: h.deleted_at || null, workspace_id: h.workspace_id, user_id: h.user_id });
          return { rows: twoKey ? hits.map(shape) : (hits[0] ? [shape(hits[0])] : []) };
        }
        // mirrorDccCompletions — assert the widening rather than just tolerating it.
        if (sql.includes("updated_at > $2")) {
          assert.match(sql, /IN \('slack-bookmark', 'slack-delegate'\)/);
          assert.match(sql, /<> 'slack_reaction_tombstone'/);
          const rows = blocks.filter(b => {
            const p = b.properties || {};
            return ["slack-bookmark", "slack-delegate"].includes(p.source)
              && p.kind !== "slack_reaction_tombstone"
              && p.slack_channel && p.slack_ts;
          });
          return { rows: rows.map(b => ({ ...b, updated_at: new Date().toISOString() })) };
        }
        return { rows: [] };
      },
    },
    // The blocks.js side is exercised for real in waiting-slack-handoff.test.js;
    // here it is recorded, so these tests pin what slack-events ASKS FOR.
    completeWaitingItem: async (args) => { calls.completeWaiting.push(args); return { ok: true }; },
    reopenWaitingItem: async (args) => { calls.reopenWaiting.push(args); return { ok: true }; },
    convertSlackMessageKind: async (args) => {
      calls.convert.push(args);
      if (opts.convertFails) return { converted: false };
      const winner = { id: `won-${++seq}`, type: "block", date: args.toKind === "bookmark" ? TODAY : null,
        workspace_id: "ws-1", user_id: 1, deleted_at: null,
        properties: {
          ...P.adoptProvenance(args.row.properties, args.toKind),
          ...P.displayTextFor(args.row.properties, args.toKind),
          ...(args.toKind === "bookmark" ? args.taskDefaults : args.itemDefaults),
          slackKindChangedAt: new Date(args.atMs).toISOString(),
        } };
      delete winner.properties.date;
      // Mirror the real helper: retire and remove the loser BEFORE the winner exists.
      const loser = blocks.find(b => b.id === args.row.id);
      loser.properties = { ...P.retireSlackKey(loser.properties, winner.properties.slackKindChangedAt), slackKindChangedAt: winner.properties.slackKindChangedAt };
      loser.deleted_at = "2026-07-28T00:00:00.000Z";
      blocks.push(winner);
      return { converted: true, winner, loser };
    },
  };

  let handler;
  const app = { post: (path, fn) => { if (path === "/api/slack/events") handler = fn; } };
  const api = mount(app, ctx);
  return { handler, api, ctx, blocks, calls, dayRoot };
}

function sign(raw, ts) {
  return "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex");
}
async function post(handler, obj) {
  const raw = JSON.stringify(obj);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = { status() { return res; }, json() { return res; }, end() { return res; } };
  handler({ headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sign(raw, ts) }, rawBody: Buffer.from(raw, "utf8"), body: obj }, res);
  await new Promise(r => setTimeout(r, 90));
}
const added = (name, ts, evTs = "1720000000.000000") => ({
  type: "event_callback", team_id: "T1",
  event: { type: "reaction_added", user: DRAKE, reaction: name, item: { type: "message", channel: "C1", ts }, event_ts: evTs },
});
const removed = (name, ts, evTs = "1720000100.000000") => ({
  type: "event_callback", team_id: "T1",
  event: { type: "reaction_removed", user: DRAKE, reaction: name, item: { type: "message", channel: "C1", ts }, event_ts: evTs },
});

// A 👥 item exactly as handleDelegate mints one.
function seedWaiting(h, ts, extra = {}) {
  const row = {
    id: `wait-${ts}`, type: "block", date: null, workspace_id: "ws-1", user_id: 1, deleted_at: null,
    properties: {
      kind: "delegated_item", source: "slack-delegate",
      idempotency_key: P.slackKeyFor("delegate", "C1", ts),
      slack_channel: "C1", slack_ts: ts, slack_thread_ts: ts,
      source_id: `https://co.slack.com/archives/C1/p${ts.replace(".", "")}`,
      title: "", myTask: "Chase the signed contract",
      captureTitle: "Chase the signed contract",
      captureNotes: "Delegated from Slack",
      aiSummary: "Alex owes the signed contract.",
      waitingReason: "delegated", status: "open",
      checkInMode: "date", checkInDate: "2026-07-29", checkInDays: 1,
      ...extra,
    },
  };
  h.blocks.push(row);
  return row;
}
// A 🔖 task exactly as handleBookmark mints one.
function seedTask(h, ts, extra = {}) {
  const row = {
    id: `task-${ts}`, type: "block", date: TODAY, workspace_id: "ws-1", user_id: 1, deleted_at: null,
    properties: {
      kind: "task", source: "slack-bookmark",
      idempotency_key: P.slackKeyFor("bookmark", "C1", ts),
      slack_channel: "C1", slack_ts: ts, slack_thread_ts: ts,
      source_id: `https://co.slack.com/archives/C1/p${ts.replace(".", "")}`,
      title: "Chase the signed contract",
      captureTitle: "Chase the signed contract",
      captureNotes: "Bookmarked from Slack",
      aiSummary: "Alex owes the signed contract.",
      status: "open", estimatedMinutes: 5, start: "09:00", end: "09:05",
      ...extra,
    },
  };
  h.blocks.push(row);
  return row;
}

// ══ ✅ / un-✅ on a 👥 message ═══════════════════════════════════════════════

test("✅ on a 👥 message closes the Waiting item instead of falling on the floor", async () => {
  const h = makeHarness();
  const item = seedWaiting(h, "d.1");
  await post(h.handler, added("white_check_mark", "d.1", "1720001200.000000"));

  assert.equal(h.calls.completeWaiting.length, 1);
  assert.equal(h.calls.completeWaiting[0].item.id, item.id);
  assert.equal(h.calls.completeWaiting[0].completedBy, "slack");
  assert.equal(h.calls.completeWaiting[0].workspaceId, "ws-1");
  assert.equal(h.calls.completeWaiting[0].completedAt, new Date(1720001200000).toISOString());
});

// The DCC's own /complete route awards nothing for a Waiting item — credit only
// ever rides the linked task's own check-off — so ✅ must not be worth more than
// the button it mirrors. creditKeyFor is also `${task.date}:${task.id}` and a
// Waiting item is date-less, so crediting one would mint a "null:<id>" ledger key.
test("✅ on a 👥 message awards no points", async () => {
  const h = makeHarness();
  seedWaiting(h, "d.2");
  await post(h.handler, added("white_check_mark", "d.2", "1720001200.000000"));
  assert.equal(h.calls.credit.length, 0);
  assert.equal(h.calls.revoke.length, 0);
});

test("✅ on an already-closed 👥 item is idempotent (Slack retries)", async () => {
  const h = makeHarness();
  seedWaiting(h, "d.3", { status: "done", completedAt: "2026-07-28T10:00:00.000Z" });
  await post(h.handler, added("white_check_mark", "d.3", "1720001200.000000"));
  assert.equal(h.calls.completeWaiting.length, 0);
});

test("an 'unblocked' item counts as closed, so ✅ does not re-close it", async () => {
  // /unblock stamps status "unblocked" AND completedAt. waitingItems.isOpen()
  // treats both terminal states as closed and this path must agree with it.
  const h = makeHarness();
  seedWaiting(h, "d.4", { status: "unblocked", completedAt: "2026-07-28T10:00:00.000Z" });
  await post(h.handler, added("white_check_mark", "d.4", "1720001200.000000"));
  assert.equal(h.calls.completeWaiting.length, 0);
});

test("un-✅ on a closed 👥 item reopens it", async () => {
  const h = makeHarness();
  const item = seedWaiting(h, "d.5", { status: "done", completedAt: "2026-07-28T10:00:00.000Z" });
  await post(h.handler, removed("white_check_mark", "d.5", "1720001300.000000"));

  assert.equal(h.calls.reopenWaiting.length, 1);
  assert.equal(h.calls.reopenWaiting[0].item.id, item.id);
  assert.equal(h.calls.reopenWaiting[0].atMs, 1720001300000);
  assert.equal(h.calls.revoke.length, 0, "there was no credit to revoke");
});

test("un-✅ on an open 👥 item does nothing", async () => {
  const h = makeHarness();
  seedWaiting(h, "d.6");
  await post(h.handler, removed("white_check_mark", "d.6", "1720001300.000000"));
  assert.equal(h.calls.reopenWaiting.length, 0);
});

test("a bookmarked task still takes the task completion path, not the Waiting one", async () => {
  // The two-key resolver must not send a 🔖 task down the delegate branch.
  const h = makeHarness();
  seedTask(h, "b.1");
  await post(h.handler, added("white_check_mark", "b.1", "1720001200.000000"));
  assert.equal(h.calls.completeWaiting.length, 0);
  assert.equal(h.calls.credit.length, 1, "a task still earns its points");
  assert.equal(h.blocks.find(b => b.id === "task-b.1").properties.status, "done");
});

// ══ ⌛ on a 👥 message ════════════════════════════════════════════════════════

test("⌛ on a 👥 message starts no timer and takes the reaction back off", async () => {
  // A Waiting item is a thing you are waiting ON, not work you are doing. Leaving
  // ⌛ there would have the message claim work is in progress forever.
  const h = makeHarness();
  const item = seedWaiting(h, "d.7");
  await post(h.handler, added("hourglass", "d.7", "1720000500.000000"));

  assert.equal(item.properties.startedAt, undefined);
  assert.deepEqual(h.calls.remove.map(r => r.name), ["hourglass"]);
  assert.equal(h.calls.remove[0].timestamp, "d.7");
});

test("un-⌛ on a 👥 message is a no-op rather than a pause of nothing", async () => {
  const h = makeHarness();
  const item = seedWaiting(h, "d.8");
  await post(h.handler, removed("hourglass", "d.8", "1720000600.000000"));
  assert.equal(item.properties.startedAt, undefined);
  assert.equal(h.calls.broadcast.filter(b => b.payload.action === "slack-start-clear").length, 0);
});

// ══ the DCC → Slack projection ═══════════════════════════════════════════════

test("a closed Waiting item gets 👥 and ✅ on its message, and never ⌛", async () => {
  const h = makeHarness();
  const item = seedWaiting(h, "d.9", { status: "done", completedAt: "2026-07-28T10:00:00.000Z" });
  assert.equal(await h.ctx.syncSlackTaskReactions(item), true);

  assert.deepEqual(h.calls.add.map(a => a.name), ["busts_in_silhouette", "white_check_mark"]);
  // ⌛ is bookmark-only. Before the gate, every delegate projection fired a
  // reactions.remove that could only ever answer no_reaction.
  assert.ok(!h.calls.remove.some(r => r.name === "hourglass"), "⌛ is not a Waiting-item concept");
});

test("an open Waiting item wears 👥 and has ✅ taken off", async () => {
  const h = makeHarness();
  const item = seedWaiting(h, "d.10");
  await h.ctx.syncSlackTaskReactions(item);
  assert.deepEqual(h.calls.add.map(a => a.name), ["busts_in_silhouette"]);
  assert.deepEqual(h.calls.remove.map(r => r.name), ["white_check_mark"]);
});

test("a deleted Waiting item has 👥 and ✅ stripped", async () => {
  const h = makeHarness();
  const item = seedWaiting(h, "d.11");
  item.deleted_at = "2026-07-28T11:00:00.000Z";
  await h.ctx.syncSlackTaskReactions(item);
  assert.equal(h.calls.add.length, 0);
  assert.deepEqual(h.calls.remove.map(r => r.name).sort(), ["busts_in_silhouette", "white_check_mark"]);
});

// A tombstone is a hidden ordering artefact that carries the source AND the
// coordinates, so it used to project as an "open" row and re-add the very identity
// reaction the user had just removed.
test("a reaction tombstone is never projected back onto the message", async () => {
  const h = makeHarness();
  const tombstone = {
    id: "tomb-1", type: "block", date: null, workspace_id: "ws-1", user_id: 1, deleted_at: null,
    properties: {
      kind: "slack_reaction_tombstone", source: "slack-bookmark", status: "cancelled", hidden: true,
      idempotency_key: P.slackKeyFor("bookmark", "C1", "t.1"), slack_channel: "C1", slack_ts: "t.1",
    },
  };
  h.blocks.push(tombstone);
  assert.equal(await h.ctx.syncSlackTaskReactions(tombstone), false);
  assert.equal(h.calls.add.length, 0);
  assert.equal(h.calls.remove.length, 0);
});

test("an unchanged projection is not re-posted, and a changed one is", async () => {
  const h = makeHarness();
  const item = seedWaiting(h, "d.12");
  await h.ctx.syncSlackTaskReactions(item);
  const afterFirst = h.calls.add.length + h.calls.remove.length;
  assert.ok(afterFirst > 0);

  await h.ctx.syncSlackTaskReactions(item);
  assert.equal(h.calls.add.length + h.calls.remove.length, afterFirst,
    "a Waiting item's updated_at moves on every check-in bump; the memo is what stops the churn");

  item.properties = { ...item.properties, status: "done", completedAt: "2026-07-28T12:00:00.000Z" };
  await h.ctx.syncSlackTaskReactions(item);
  assert.ok(h.calls.add.some(a => a.name === "white_check_mark"), "a real state change still projects");
});

test("the memo can be switched off entirely", async () => {
  const h = makeHarness({ memoMs: 0 });
  const item = seedWaiting(h, "d.13");
  await h.ctx.syncSlackTaskReactions(item);
  const first = h.calls.add.length;
  await h.ctx.syncSlackTaskReactions(item);
  assert.equal(h.calls.add.length, first * 2, "with the memo off every pass re-posts");
});

test("the reconcile mirror now walks delegated items too", async () => {
  const h = makeHarness();
  seedWaiting(h, "d.14", { status: "done", completedAt: "2026-07-28T10:00:00.000Z" });
  const stats = await h.api.runReconciliation();
  assert.ok(stats.mirrored >= 1, "a closed Waiting item was previously excluded from the mirror by its source");
  assert.ok(h.calls.add.some(a => a.name === "white_check_mark" && a.timestamp === "d.14"));
});

// ══ 🔖 ⇄ 👥 conversion, driven from Slack ════════════════════════════════════

test("🔖 on a message the DCC holds as a Waiting item converts it in place", async () => {
  const h = makeHarness();
  const item = seedWaiting(h, "c.1");
  const before = h.blocks.length;
  await post(h.handler, added("bookmark", "c.1", "1720002000.000000"));

  assert.equal(h.calls.convert.length, 1);
  assert.equal(h.calls.convert[0].fromKind, "delegate");
  assert.equal(h.calls.convert[0].toKind, "bookmark");
  assert.equal(h.calls.convert[0].row.id, item.id);
  // One row in, one row out — not a blank duplicate beside the original.
  assert.equal(h.blocks.length, before + 1);
  const winner = h.blocks[h.blocks.length - 1];
  assert.equal(winner.properties.idempotency_key, "slack-bookmark:C1:c.1");
  assert.equal(winner.properties.title, "Chase the signed contract", "the text survives the swap");
  assert.equal(winner.properties.aiSummary, "Alex owes the signed contract.", "so does the Haiku work");
  // The losing key is retired, so no later reaction can resurrect the item.
  assert.ok(P.isRetiredKey(item.properties.idempotency_key));
  // And the old identity reaction comes off.
  assert.ok(h.calls.remove.some(r => r.name === "busts_in_silhouette" && r.timestamp === "c.1"));
  assert.ok(h.calls.add.some(a => a.name === "bookmark" && a.timestamp === "c.1"));
});

test("👥 on a message the DCC holds as a task converts it in place", async () => {
  const h = makeHarness();
  const task = seedTask(h, "c.2");
  await post(h.handler, added("busts_in_silhouette", "c.2", "1720002000.000000"));

  assert.equal(h.calls.convert.length, 1);
  assert.equal(h.calls.convert[0].fromKind, "bookmark");
  assert.equal(h.calls.convert[0].toKind, "delegate");
  const winner = h.blocks[h.blocks.length - 1];
  assert.equal(winner.properties.idempotency_key, "slack-delegate:C1:c.2");
  // A Waiting item keeps `title` for its blocker and puts the work in myTask.
  assert.equal(winner.properties.myTask, "Chase the signed contract");
  assert.equal(winner.properties.title, "");
  assert.ok(P.isRetiredKey(task.properties.idempotency_key));
  assert.ok(h.calls.remove.some(r => r.name === "bookmark"));
  assert.ok(h.calls.add.some(a => a.name === "busts_in_silhouette"));
});

test("the converted row carries the capture defaults of the kind it becomes", async () => {
  const h = makeHarness();
  seedWaiting(h, "c.3");
  await post(h.handler, added("bookmark", "c.3", "1720002000.000000"));
  const defaults = h.calls.convert[0].taskDefaults;
  assert.equal(defaults.date, TODAY);
  assert.equal(defaults.estimatedMinutes, 5, "the no-⌛ estimate handleBookmark uses");
  assert.equal(defaults.start, "09:00");
  assert.equal(defaults.end, "09:05");

  const h2 = makeHarness();
  seedTask(h2, "c.4");
  await post(h2.handler, added("busts_in_silhouette", "c.4", "1720002000.000000"));
  const item = h2.calls.convert[0].itemDefaults;
  assert.equal(item.checkInDate, "2026-07-29", "+1 day, as handleDelegate mints one");
  assert.equal(item.waitingReason, "delegated");
});

test("the identity reaction re-fired on its own kind is not a conversion", async () => {
  const h = makeHarness();
  seedWaiting(h, "c.5");
  await post(h.handler, added("busts_in_silhouette", "c.5", "1720002000.000000"));
  assert.equal(h.calls.convert.length, 0);
  assert.equal(h.blocks.length, 1, "no duplicate row for a repeat 👥");
});

test("a refused conversion falls through to the normal create path", async () => {
  // ctx.convertSlackMessageKind answering { converted: false } must not swallow
  // the event — otherwise a message with a half-captured row gets nothing at all.
  const h = makeHarness({ convertFails: true });
  seedWaiting(h, "c.6");
  await post(h.handler, added("bookmark", "c.6", "1720002000.000000"));
  assert.equal(h.calls.convert.length, 1);
  assert.ok(h.blocks.some(b => (b.properties || {}).idempotency_key === "slack-bookmark:C1:c.6"),
    "the bookmark still got a task");
});

// ══ self-echo containment ════════════════════════════════════════════════════
//
// Prod has no bot token: reactions go out on Drake's own xoxp token, so every
// reaction the server posts comes back as a genuine event FROM Drake. These are
// the two echoes a conversion produces.

test("the echo of our own un-👥 does not delete the row we just converted", async () => {
  const h = makeHarness();
  seedWaiting(h, "e.1");
  await post(h.handler, added("bookmark", "e.1", "1720002000.000000"));
  const winner = h.blocks[h.blocks.length - 1];
  const rowsBefore = h.blocks.length;

  // Slack echoes the reactions.remove the projection just made.
  await post(h.handler, removed("busts_in_silhouette", "e.1", "1720002001.000000"));

  assert.equal(h.blocks.length, rowsBefore, "no tombstone was written");
  assert.ok(!h.blocks.some(b => (b.properties || {}).kind === "slack_reaction_tombstone"));
  assert.equal(h.blocks.find(b => b.id === winner.id).deleted_at, null, "the converted row survives");
});

test("the echo of our own 🔖 does not mint a duplicate", async () => {
  const h = makeHarness();
  seedWaiting(h, "e.2");
  await post(h.handler, added("bookmark", "e.2", "1720002000.000000"));
  const rowsBefore = h.blocks.length;
  const convertsBefore = h.calls.convert.length;

  await post(h.handler, added("bookmark", "e.2", "1720002002.000000"));

  assert.equal(h.blocks.length, rowsBefore, "the live task is found and the handler returns");
  assert.equal(h.calls.convert.length, convertsBefore, "and it is not converted back");
});

test("the echo of our own un-🔖 does not tombstone a message the Waiting item owns", async () => {
  const h = makeHarness();
  seedTask(h, "e.3");
  await post(h.handler, added("busts_in_silhouette", "e.3", "1720002000.000000"));
  const rowsBefore = h.blocks.length;

  await post(h.handler, removed("bookmark", "e.3", "1720002001.000000"));

  assert.equal(h.blocks.length, rowsBefore);
  assert.ok(!h.blocks.some(b => (b.properties || {}).kind === "slack_reaction_tombstone"));
});

// A delegate tombstone is PERMANENT — handleDelegate returns on any existing row —
// so writing one for a converted message would block every future 👥 on it.
test("a 👥 removed on a message with no row at all still tombstones", async () => {
  const h = makeHarness();
  await post(h.handler, removed("busts_in_silhouette", "e.4", "1720002001.000000"));
  const tombstones = h.blocks.filter(b => (b.properties || {}).kind === "slack_reaction_tombstone");
  assert.equal(tombstones.length, 1, "the remove-before-add guard still works");
  assert.equal(tombstones[0].properties.idempotency_key, "slack-delegate:C1:e.4");
});

// ══ ordering ════════════════════════════════════════════════════════════════

test("a conversion event older than the last one is ignored", async () => {
  const h = makeHarness();
  seedWaiting(h, "o.1");
  await post(h.handler, added("bookmark", "o.1", "1720002000.000000"));
  assert.equal(h.calls.convert.length, 1);

  // A redelivered 👥 stamped BEFORE the conversion must not flip it back.
  await post(h.handler, added("busts_in_silhouette", "o.1", "1720001000.000000"));
  assert.equal(h.calls.convert.length, 1, "the older event was refused by slackKindChangedAt");
  assert.equal(h.blocks[h.blocks.length - 1].properties.idempotency_key, "slack-bookmark:C1:o.1");
});

test("a swap delivered add-first and a swap delivered remove-first land on the same kind", async () => {
  const addFirst = makeHarness();
  seedWaiting(addFirst, "o.2");
  await post(addFirst.handler, added("bookmark", "o.2", "1720002000.000000"));
  await post(addFirst.handler, removed("busts_in_silhouette", "o.2", "1720002001.000000"));

  const removeFirst = makeHarness();
  seedWaiting(removeFirst, "o.2");
  await post(removeFirst.handler, removed("busts_in_silhouette", "o.2", "1720002000.000000"));
  await post(removeFirst.handler, added("bookmark", "o.2", "1720002001.000000"));

  const live = (h) => h.blocks.filter(b => !b.deleted_at && (b.properties || {}).kind !== "slack_reaction_tombstone");
  for (const h of [addFirst, removeFirst]) {
    const rows = live(h);
    assert.equal(rows.length, 1, "exactly one live row owns the message");
    assert.equal(P.slackKindOf(rows[0].properties), "bookmark");
  }
});

// ══ the reconcile sweep must not fight the events ════════════════════════════

test("the catch-up sweep skips a message already live under the other kind", async () => {
  // Slack's search index lags a reaction by minutes, so the sweep can still see
  // the 🔖 of a message that is a Waiting item now. Creating there duplicates the
  // row; converting there ping-pongs the kind against what the events settled.
  const h = makeHarness();
  seedWaiting(h, "s.1");
  const result = await h.api.reconcileMatch("bookmark", { channel: "C1", ts: "s.1" });
  assert.deepEqual(result, { skipped: true });
  assert.equal(h.calls.convert.length, 0);
  assert.ok(!h.blocks.some(b => (b.properties || {}).idempotency_key === "slack-bookmark:C1:s.1"));
});
