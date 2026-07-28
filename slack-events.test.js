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
function makeHarness() {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.DRAKE_SLACK_USER_ID = DRAKE;
  process.env.DCC_SERVICE_USER_ID = "1";
  process.env.DCC_SERVICE_WORKSPACE_ID = "ws-1";

  const blocks = [];            // {id, date, properties, type}
  const calls = { credit: [], broadcast: [] };
  let seq = 0;

  const ctx = {
    crypto,
    getTodayStr: () => "2026-07-28",
    APP_TIME_ZONE: "America/New_York",
    broadcast: (ev, payload) => calls.broadcast.push({ ev, payload }),
    slotStore: { earnTaskCredit: async (_ws, _uid, body) => { calls.credit.push(body); return { awarded: true }; } },
    blockDB: {
      createItineraryTask: async ({ date, properties }) => {
        const b = { id: `blk-${++seq}`, date, type: "block", properties };
        blocks.push(b); return { id: b.id };
      },
      createBlock: async ({ id, type, date, properties }) => {
        const b = { id: id || `blk-${++seq}`, date, type, properties };
        blocks.push(b); return { id: b.id };
      },
      updateBlock: async (id, { properties }) => {
        const b = blocks.find(x => x.id === id);
        if (!b) throw new Error("not found " + id);
        b.properties = properties; return { id };
      },
      deleteBlock: async (id) => {
        const b = blocks.find(x => x.id === id);
        if (b) b.deleted = true; return { id };
      },
      ensureDayRoot: async (date) => `day-root-${date}`,
    },
    pool: {
      query: async (sql, params) => {
        if (sql.includes("idempotency_key")) {
          const hit = blocks.find(b => b.properties && b.properties.idempotency_key === params[0] && b.type !== "time_entry" && !b.deleted);
          return { rows: hit ? [{ id: hit.id, date: hit.date, properties: hit.properties }] : [] };
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
  return { handler, blocks, calls };
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

test("removing 🔖 before ⏳/✅ cancels (soft-deletes) the task", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "aaa.1", "aaa.9"));
  assert.equal(blocks[0].deleted, undefined);
  await post(handler, removal("bookmark", "aaa.1"));
  assert.equal(blocks[0].deleted, true);
  // re-adding makes a fresh task (the old one is soft-deleted / unfindable)
  await post(handler, reaction("bookmark", "aaa.1", "aaa.95"));
  assert.equal(blocks.filter(b => !b.deleted).length, 1);
});

test("removing 🔖 after ⏳ is ignored — an in-flight task is kept", async () => {
  const { handler, blocks } = makeHarness();
  await post(handler, reaction("bookmark", "bbb.1", "bbb.9"));
  await post(handler, reaction("hourglass_flowing_sand", "bbb.1", "1720000000.000000"));
  await post(handler, removal("bookmark", "bbb.1"));
  assert.equal(blocks[0].deleted, undefined);
  assert.ok(blocks[0].properties.startedAt);
});
