// A Day in Review packet is published into its review day's row AND, for one day, into
// the next day's, so yesterday's review is reachable from today's screen. The next
// night's run overwrites the borrowed row — and a tab left open across that boundary
// then posts yesterday's item ids at a row that now holds a different packet. That is
// the 400 ("Decision target does not belong to this Day in Review packet") a user hits
// on a button they can still see, with no way forward but abandoning the packet.
//
// Contract here: the route settles a decision on the packet that OWNS the id, probing
// recent rows when the posted day does not, and a probe never mints a row.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";
const TODAY = "2026-08-17";
const OWNER_DAY = "2026-08-16";

function packet(reviewDate, ids) {
  return {
    date: reviewDate,
    glymphatic_brief: {
      decisions: {},
      current: {
        pages: [{
          id: "day-review",
          review_date: reviewDate,
          items: ids.map(id => ({ id, followups: [{ id: "f-" + id }] }))
        }]
      }
    }
  };
}

function mountDcc(rows) {
  const store = structuredClone(rows);
  const created = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });
  const ctx = {
    DAY_STATE_FILE: "/dev/null/day.json",
    DATA_DIR: "/dev/null",
    addMinutesHHMM: (t) => t,
    blockDB: {
      // The shape db.js saveDccBriefDecision presents to the route: it validates the
      // target against the packet stored for `date`, and `opts.probe` asks without
      // creating. Anything else the route calls on a decision request is unused.
      saveDccBriefDecision: async (date, input, _userId, _workspaceId, emptyState, opts = {}) => {
        let state = store[date];
        if (!state) {
          if (opts.probe) throw mismatch(date, null);
          created.push(date);
          state = store[date] = structuredClone(emptyState || { date });
        }
        const brief = state.glymphatic_brief || (state.glymphatic_brief = {});
        const page = ((brief.current || {}).pages || []).find(p => p.id === "day-review") || {};
        const items = page.items || [];
        const owns = items.some(i => i.id === input.taskId) ||
          items.some(i => (i.followups || []).some(f => f.id === input.taskId));
        if (!owns) throw mismatch(date, page.review_date || null);
        (brief.decisions || (brief.decisions = {}))[input.taskId] = { action: input.action };
        return { state, changed: true };
      },
      saveDccState: async () => {},
    },
    broadcast: () => {},
    buildSkeletonState: (d) => ({ date: d }),
    dccIntelligence: {},
    getDayFilePath: (d) => `/dev/null/${d}.json`,
    getTodayStr: () => TODAY,
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")),
    meetingAutomation: {},
    meetingIdentity: (m) => m && m.id,
    meetingMaterializer: { materializeMeetings: async () => ({}) },
    meetingSignals: {},
    previousDateStr: (d) => {
      const day = new Date(d + "T12:00:00Z");
      day.setUTCDate(day.getUTCDate() - 1);
      return day.toISOString().slice(0, 10);
    },
    readDayStateMirror: () => null,
    readJSON: (_p, fallback) => (fallback === null ? null : (fallback || {})),
    readTriageSuppressionsForWorkspace: async () => [],
    resolveOwnerLenient: () => ({ userId: 1, workspaceId: MINE }),
    resolveOwnerStrict: async () => ({ userId: 1, workspaceId: MINE }),
    slotStore: {},
    writeJSON: () => {},
  };
  require("./routes/dcc.js")(app, ctx);
  return { app, store, created };
}

function mismatch(date, reviewDate) {
  const error = new Error(`Decision target does not belong to the Day in Review packet stored for ${date}`);
  error.status = 400;
  error.code = "packet_mismatch";
  error.packetDate = date;
  error.reviewDate = reviewDate;
  return error;
}

async function call(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await resp.json(); } catch { /* empty body */ }
    return { status: resp.status, json };
  } finally { server.close(); }
}

test("a stale card settles on the packet that owns it, not the row it was posted at", async () => {
  const { app, store } = mountDcc({
    [TODAY]: packet(TODAY, ["dr-today"]),
    [OWNER_DAY]: packet(OWNER_DAY, ["dr-yesterday"]),
  });

  const { status, json } = await call(app, "POST", "/api/dcc/brief/decision",
    { date: TODAY, task_id: "dr-yesterday", action: "dismiss" });

  assert.equal(status, 200);
  assert.equal(json.date, OWNER_DAY, "settled where the packet lives");
  assert.equal(json.requested_date, TODAY, "and says where it was posted");
  assert.equal(store[OWNER_DAY].glymphatic_brief.decisions["dr-yesterday"].action, "dismiss");
  assert.equal(store[TODAY].glymphatic_brief.decisions["dr-yesterday"], undefined);
});

test("a follow-up id resolves the same way", async () => {
  const { app, store } = mountDcc({
    [TODAY]: packet(TODAY, ["dr-today"]),
    [OWNER_DAY]: packet(OWNER_DAY, ["dr-yesterday"]),
  });
  const { status, json } = await call(app, "POST", "/api/dcc/brief/decision",
    { date: TODAY, task_id: "f-dr-yesterday", action: "dismiss" });
  assert.equal(status, 200);
  assert.equal(json.date, OWNER_DAY);
  assert.equal(store[OWNER_DAY].glymphatic_brief.decisions["f-dr-yesterday"].action, "dismiss");
});

test("probing recent days never mints a row for a day that has none", async () => {
  const { app, created, store } = mountDcc({ [TODAY]: packet(TODAY, ["dr-today"]) });

  const { status, json } = await call(app, "POST", "/api/dcc/brief/decision",
    { date: TODAY, task_id: "dr-from-a-packet-that-is-gone", action: "dismiss" });

  assert.equal(status, 400, "nothing owns it, so the honest answer is still a refusal");
  assert.match(json.error, /Day in Review packet stored for 2026-08-17/);
  assert.deepEqual(created, [], "no empty day rows left behind by the walk");
  assert.deepEqual(Object.keys(store), [TODAY]);
});

test("the walk stops at a week and does not reach further back", async () => {
  const OLD = "2026-08-08";   // 9 days before TODAY
  const { app } = mountDcc({
    [TODAY]: packet(TODAY, ["dr-today"]),
    [OLD]: packet(OLD, ["dr-ancient"]),
  });
  const { status } = await call(app, "POST", "/api/dcc/brief/decision",
    { date: TODAY, task_id: "dr-ancient", action: "dismiss" });
  assert.equal(status, 400);
});

test("a decision posted at its own packet still takes the direct path", async () => {
  const { app, store } = mountDcc({ [TODAY]: packet(TODAY, ["dr-today"]) });
  const { status, json } = await call(app, "POST", "/api/dcc/brief/decision",
    { date: TODAY, task_id: "dr-today", action: "approve" });
  assert.equal(status, 200);
  assert.equal(json.date, TODAY);
  assert.equal(json.requested_date, undefined, "no redirect to report");
  assert.equal(store[TODAY].glymphatic_brief.decisions["dr-today"].action, "approve");
});
