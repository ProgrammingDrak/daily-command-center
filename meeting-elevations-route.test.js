const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

function appWith(automation, broadcasts) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = "ws-1";
    req.session = { userId: 1 };
    next();
  });
  require("./routes/meeting.js")(app, {
    meetingAutomation: automation,
    broadcast: (type, data, workspaceId) => broadcasts.push({ type, data, workspaceId }),
    getTodayStr: () => "2026-08-13",
    isValidDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")),
  });
  return app;
}

async function request(app, path, options) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally { server.close(); }
}

test("GET proposed actions returns the cross-meeting elevation read model", async () => {
  const seen = [];
  const app = appWith({
    listProposedActions: async opts => { seen.push(opts); return [{ id: "p1", meetingId: "m1", title: "Send brief" }]; },
  }, []);
  const result = await request(app, "/api/meetings/actions/proposed?limit=12");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items, [{ id: "p1", meetingId: "m1", title: "Send brief" }]);
  assert.deepEqual(seen, [{ workspaceId: "ws-1", limit: "12" }]);
});

test("meeting review routes remain workspace-scoped and broadcast completion", async () => {
  const seen = [], broadcasts = [];
  const app = appWith({
    listMeetingReviews: async opts => {
      seen.push(["list", opts]);
      return [{ id: "m1", status: "ready" }];
    },
    finishMeetingReview: async (id, opts) => {
      seen.push(["finish", id, opts]);
      return { ok: true, meetingId: id };
    },
    updateProposedAction: async (id, actionId, opts) => {
      seen.push(["edit", id, actionId, opts]);
      return { proposedActions: [] };
    },
  }, broadcasts);
  const list = await request(app, "/api/meetings/reviews");
  assert.deepEqual(list.body.items, [{ id: "m1", status: "ready" }]);
  const edit = await request(app, "/api/meetings/m1/actions/p1", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Edited" }),
  });
  assert.equal(edit.status, 200);
  const finish = await request(app, "/api/meetings/m1/review/finish", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(finish.status, 200);
  assert.deepEqual(seen, [
    ["list", { workspaceId: "ws-1", today: "2026-08-13" }],
    ["edit", "m1", "p1", { workspaceId: "ws-1", text: "Edited" }],
    ["finish", "m1", { workspaceId: "ws-1" }],
  ]);
  assert.deepEqual(broadcasts.map(row => row.data.action),
    ["meeting-action-edited", "meeting-review-finished"]);
});

test("POST dismiss validates through the meeting service and broadcasts the removal", async () => {
  const seen = [], broadcasts = [];
  const app = appWith({
    dismissProposedAction: async (meetingId, actionId, opts) => {
      seen.push({ meetingId, actionId, opts });
      return { proposedActions: [] };
    },
  }, broadcasts);
  const result = await request(app, "/api/meetings/m1/actions/p1/dismiss", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(seen, [{ meetingId: "m1", actionId: "p1", opts: { workspaceId: "ws-1" } }]);
  assert.equal(broadcasts[0].data.action, "meeting-action-dismissed");
});

test("POST schedule uses the retry-safe proposal service and broadcasts the placed task", async () => {
  const seen = [], broadcasts = [];
  const app = appWith({
    placeProposedAction: async (meetingId, actionId, opts) => {
      seen.push({ meetingId, actionId, opts });
      return { ok: true, actionBlockId: "task-1", date: opts.date };
    },
  }, broadcasts);
  const result = await request(app, "/api/meetings/m1/actions/p1/schedule", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: "2026-08-14" }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(seen, [{ meetingId: "m1", actionId: "p1", opts: {
    workspaceId: "ws-1", userId: 1, date: "2026-08-14", start: undefined,
  } }]);
  assert.deepEqual(broadcasts[0].data.blockIds, ["m1", "task-1"]);
});
