// POST /api/dcc/brief/log-done was the ONE completion writer in the codebase with
// no Slack projection.
//
// Every mutation path in routes/blocks.js fans out through its syncSlack wrapper
// (ten call sites), so checking a Slack-captured task off from the itinerary, the
// details modal, a batch or the Waiting card all land ✅ on the message. Checking
// the same task off from the morning brief silently did not — which reads as "the
// mirror is broken", not "that one button skips it".
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";
const TODAY = "2026-07-30";

function mountDcc({ rows = [], syncThrows = false } = {}) {
  const app = express();
  app.use(express.json());
  const synced = [];
  const credits = [];
  let n = 0;

  const ctx = {
    DAY_STATE_FILE: "/dev/null/day-state.json",
    DATA_DIR: "/dev/null",
    addMinutesHHMM: (hhmm, mins) => {
      const [h, m] = hhmm.split(":").map(Number);
      const t = h * 60 + m + mins;
      return String(Math.floor(t / 60) % 24).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
    },
    blockDB: {
      findByIdempotencyKey: async (workspaceId, key) => {
        const hits = rows.filter(r => (r.properties || {}).idempotency_key === key && r.workspace_id === workspaceId);
        return hits.find(r => !r.deleted_at) || hits[0] || null;
      },
      getBlocksByDateIncludingDeleted: async () => rows,
      createItineraryTask: async (b) => { n += 1; return { id: `created-${n}`, ...b }; },
      saveDccState: async () => {},
    },
    broadcast: () => {},
    buildSkeletonState: (d) => ({ date: d }),
    getDayFilePath: (d) => `/dev/null/${d}.json`,
    getTodayStr: () => TODAY,
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")),
    meetingIdentity: (m) => m && m.id,
    meetingMaterializer: { materializeMeetings: async () => ({ created: 0, updated: 0, cancelled: 0, blockIds: [] }) },
    previousDateStr: (d) => d,
    readJSON: (_p, fallback) => (fallback === null ? null : (fallback || {})),
    resolveOwnerLenient: () => ({ userId: 1, workspaceId: MINE }),
    resolveOwnerStrict: async () => ({ userId: 1, workspaceId: MINE }),
    slotStore: { earnTaskCredit: async (_ws, _u, payload) => { credits.push(payload); return { awarded: true }; } },
    writeJSON: () => {},
    syncSlackTaskReactions: async (blockOrId) => {
      if (syncThrows) throw new Error("Slack is down");
      synced.push(blockOrId);
      return true;
    },
  };
  require("./routes/dcc.js")(app, ctx);
  return { app, synced, credits };
}

async function call(app, path, body) {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    await new Promise(r => server.close(r));
  }
}

test("logging a task done from the brief projects its reactions to Slack", async () => {
  const { app, synced } = mountDcc();
  const { status, json } = await call(app, "/api/dcc/brief/log-done", { title: "Chase the contract", date: TODAY, minutes: 5 });
  assert.equal(status, 200);
  assert.deepEqual(synced, [json.block.id], "the id the endpoint actually completed");
});

// The duplicate branch is precisely where the reaction is most likely to be
// missing: a repeat is what a caller sends after an ack it never saw, which is the
// same failure that would have dropped the first projection. The projector is
// idempotent — Slack answers already_reacted, which addSlackReaction treats as
// success — so running it again costs nothing and can only repair.
test("a repeat log-done still projects, because that is when the reaction may be missing", async () => {
  const rows = [{
    id: "existing-1", date: TODAY, deleted_at: null, workspace_id: MINE,
    properties: { title: "Chase the contract", idempotency_key: "day-review:2026-07-30:x" },
  }];
  const { app, synced } = mountDcc({ rows });
  const { json } = await call(app, "/api/dcc/brief/log-done", {
    title: "Chase the contract", date: TODAY, idempotency_key: "day-review:2026-07-30:x",
  });
  assert.equal(json.status, "skipped_duplicate");
  assert.deepEqual(synced, ["existing-1"]);
});

// A tombstoned match returns BEFORE the credit, and must return before the
// projection too: re-adding 🔖 and ✅ to a message whose task the user deleted
// would resurrect the row visually on the only surface that still shows it.
test("a tombstoned match projects nothing, matching the early return that skips the credit", async () => {
  const rows = [{
    id: "dead-1", date: TODAY, deleted_at: "2026-07-29T10:00:00Z", workspace_id: MINE,
    properties: { title: "Chase the contract", idempotency_key: "day-review:2026-07-30:dead" },
  }];
  const { app, synced, credits } = mountDcc({ rows });
  const { json } = await call(app, "/api/dcc/brief/log-done", {
    title: "Chase the contract", date: TODAY, idempotency_key: "day-review:2026-07-30:dead",
  });
  assert.equal(json.ok, true);
  assert.equal(credits.length, 0);
  assert.deepEqual(synced, []);
});

test("a Slack failure does not fail the completion", async () => {
  // Same contract as routes/blocks.js's syncSlack wrapper: the DCC write is
  // authoritative and Slack is a mirror, so a mirror outage must not lose the
  // check-off. The reconcile loop repairs the reaction later.
  const { app } = mountDcc({ syncThrows: true });
  const { status, json } = await call(app, "/api/dcc/brief/log-done", { title: "Chase the contract", date: TODAY });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});
