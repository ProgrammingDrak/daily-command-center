// Contract tests for the triage suppression ROUTES and for the ingest door that must
// NOT touch them.
//
// Split out from triage-suppressions.test.js (which covers the pure module) because
// these need the route harness. The shape is delete-contract.test.js's: mount
// routes/dcc.js on a bare express app with fake stores, then drive it over HTTP.
//
// The ingest-door test below is the one that earns its keep. An earlier cut of this
// feature ALSO filtered suppressions at `POST /api/ingest/day-state` before
// saveDccState, which destroys the raw item and leaves Undo with nothing to restore.
// The unit test that claimed to guard that regression could not actually fail: it
// asserted a property of `mergeOpenItems`, and the ingest handler never calls
// mergeOpenItems. This file guards the handler that was actually wrong.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const express = require("express");

const MINE = "ws-mine";

function mountSuppressions(seed = []) {
  const app = express();
  app.use(express.json());
  const blocks = seed.map((b) => ({ ...b }));
  const saved = [];
  const broadcasts = [];
  let nextId = blocks.length + 1;

  const ctx = {
    DAY_STATE_FILE: "/dev/null/day-state.json",
    DATA_DIR: "/dev/null",
    addMinutesHHMM: (hhmm) => hhmm,
    blockDB: {
      getBlocksByKind: async (kind, workspaceId) =>
        blocks.filter(
          (b) => !b.deleted_at && (b.properties || {}).kind === kind && b.workspace_id === workspaceId
        ),
      createBlock: async (b) => {
        const row = { id: "sup-" + nextId++, ...b };
        blocks.push(row);
        return row;
      },
      // Soft delete, exactly as db.js does it: the row survives with a deleted_at, and
      // the kind read filters it out. A hard splice here would hide a reader that
      // forgot the deleted_at predicate.
      deleteBlock: async (id) => {
        const row = blocks.find((b) => b.id === id);
        if (row) row.deleted_at = "2026-08-06T00:00:00.000Z";
      },
      getBlock: async (id) => blocks.find((b) => b.id === id) || null,
      updateBlock: async (id, patch) => {
        const row = blocks.find((b) => b.id === id);
        if (row && patch.properties) row.properties = patch.properties;
        return row;
      },
      getDccState: async () => null,
      saveDccState: async (date, state) => { saved.push({ date, state }); },
      getBlocksByDateIncludingDeleted: async () => [],
      findByIdempotencyKey: async () => null,
      createItineraryTask: async (b) => b,
    },
    broadcast: (evt, payload) => { broadcasts.push({ evt, payload }); },
    buildSkeletonState: (d) => ({ date: d }),
    getDayFilePath: (d) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Error(`invalid day date: ${d}`);
      return `/dev/null/${d}.json`;
    },
    getTodayStr: () => "2026-08-06",
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")),
    meetingIdentity: (m) => m && m.id,
    meetingMaterializer: { materializeMeetings: async () => ({ created: 0, updated: 0, cancelled: 0, blockIds: [] }) },
    previousDateStr: (d) => d,
    readJSON: (_p, fallback) => (fallback === null ? null : (fallback || {})),
    readDayStateMirror: () => null,
    readTriageSuppressionsForWorkspace: async (workspaceId) =>
      require("./triage-suppressions").suppressionsFromBlocks(
        blocks.filter((b) => !b.deleted_at && (b.properties || {}).kind === "triage_suppression" && b.workspace_id === workspaceId)
      ),
    resolveOwnerLenient: () => ({ userId: 1, workspaceId: MINE }),
    resolveOwnerStrict: async () => ({ userId: 1, workspaceId: MINE }),
    slotStore: { earnTaskCredit: async () => ({ awarded: false }) },
    writeJSON: () => {},
  };
  require("./routes/dcc.js")(app, ctx);
  return { app, blocks, saved, broadcasts };
}

async function callDcc(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await resp.json(); } catch { /* empty body */ }
    return { status: resp.status, json };
  } finally { server.close(); }
}

const sup = (id, props) => ({ id, workspace_id: MINE, properties: { kind: "triage_suppression", ...props } });

// ── the ingest door ──────────────────────────────────────────────────────────

test("the ingest door STORES the raw triage section, suppressed items and all", async () => {
  // Filtering here is the mistake this feature already made once. It looks right (it is
  // the door the sweep republishes through) and it destroys the item: DELETE the
  // suppression afterwards and there is nothing left to restore, because the stored
  // state no longer contains it. Suppression is a READ-time overlay for this reason.
  const { app, saved } = mountSuppressions([sup("s1", { triage_id: "gmail:abc", reason: "deleted" })]);
  const { status, json } = await callDcc(app, "POST", "/api/ingest/day-state", {
    date: "2026-07-30",
    triage: { open_items: [{ id: "gmail:abc", type: "email" }, { id: "slack:1", type: "slack" }] },
  });
  assert.equal(status, 200);
  assert.equal(saved.length, 1);
  assert.deepEqual(
    saved[0].state.triage.open_items.map((i) => i.id),
    ["gmail:abc", "slack:1"],
    "storage stays raw; filtering here would leave Undo nothing to restore"
  );
  assert.deepEqual(json.suppressed_resolutions.map((r) => r.id), ["gmail:abc"], "publisher can reconcile the exact hidden id");
});

test("ingest reconciliation admits a newer Gmail turn after a legacy cutoff", async () => {
  const { app } = mountSuppressions([sup("s1", { triage_id: "gmail:thread-1", reason: "done", at: "2026-08-06T14:00:00Z" })]);
  const { json } = await callDcc(app, "POST", "/api/ingest/day-state", {
    date: "2026-08-06",
    triage: { open_items: [
      { id: "gmail:thread-1:old", type: "email", conversation_id: "thread-1", received_at: "2026-08-06T13:00:00Z" },
      { id: "gmail:thread-1:new", type: "email", conversation_id: "thread-1", received_at: "2026-08-06T15:00:00Z" },
    ] },
  });
  assert.deepEqual(json.suppressed_resolutions.map((r) => r.id), ["gmail:thread-1:old"]);
});

test("a scheduled suppression hides the card but is not reported as a source resolution", async () => {
  const { app } = mountSuppressions([sup("s1", { triage_id: "slack:dm:D1:1", reason: "scheduled", at: "2026-08-06T14:00:00Z" })]);
  const { json } = await callDcc(app, "POST", "/api/ingest/day-state", {
    date: "2026-08-06",
    triage: { open_items: [{ id: "slack:dm:D1:1", type: "slack" }] },
  });
  assert.deepEqual(json.suppressed_resolutions, [], "scheduling is placement, not source completion");
});

test("ingest imports source-side replied items into the durable ledger", async () => {
  const { app, blocks } = mountSuppressions();
  const { json } = await callDcc(app, "POST", "/api/ingest/day-state", {
    date: "2026-08-06",
    triage: {
      open_items: [],
      resolved_items: [{
        id: "gmail:thread-1:message-1",
        type: "email",
        title: "Answered",
        conversation_id: "thread-1",
        received_at: "2026-08-06T12:00:00Z",
        resolved_at: "2026-08-06T13:00:00Z",
        resolved_reason: "replied",
      }],
    },
  });
  assert.equal(json.imported_resolutions, 1);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].properties.triage_id, "gmail:thread-1:message-1");
  assert.equal(blocks[0].properties.reason, "done");
  assert.equal(blocks[0].properties.received_at, "2026-08-06T12:00:00Z");
});

test("a source reply upgrades an existing scheduled link to done", async () => {
  const { app, blocks } = mountSuppressions([sup("s1", {
    triage_id: "slack:dm:D1:1",
    reason: "scheduled",
    at: "2026-08-06T12:00:00Z",
  })]);
  const { json } = await callDcc(app, "POST", "/api/ingest/day-state", {
    date: "2026-08-06",
    triage: {
      open_items: [],
      resolved_items: [{
        id: "slack:dm:D1:1",
        type: "slack",
        title: "Answered",
        resolved_at: "2026-08-06T13:00:00Z",
        resolved_reason: "replied",
      }],
    },
  });
  assert.equal(json.imported_resolutions, 1);
  assert.equal(blocks[0].properties.reason, "done");
  assert.equal(blocks[0].properties.note, "Replied at source");
  assert.equal(blocks.length, 1);
});

test("no suppression call happens before the state is written", async () => {
  // The behavioural test above passes for the wrong reason if someone applies the
  // overlay to a COPY. This reads the handler source and asserts the call is not there
  // at all, with comments stripped first so the long explanatory note in that handler
  // (which names both functions) cannot satisfy the regex on its own.
  const src = fs.readFileSync(require.resolve("./routes/dcc.js"), "utf8");
  const start = src.indexOf('app.post("/api/ingest/day-state"');
  assert.ok(start > -1, "the ingest handler moved; fix this guard");
  const handler = src.slice(start, src.indexOf("saveDccState", start));
  const code = handler
    .split("\n")
    .map((l) => (l.trim().startsWith("//") ? "" : l))
    .join("\n");
  assert.equal(
    /applyTriageSuppressions|readTriageSuppressionsForWorkspace/.test(code),
    false,
    "suppressions must not be applied before the day state is stored"
  );
});

// ── the routes ───────────────────────────────────────────────────────────────

test("handling the same item twice leaves exactly one row", async () => {
  // Undo deletes by triage id. A second row would survive it and the item would stay
  // invisible with no way back, so idempotency here is what makes Undo total.
  const { app, blocks } = mountSuppressions();
  const a = await callDcc(app, "POST", "/api/triage/suppressions", { triage_id: "gmail:abc", key: "email|gmail:abc", title: "T" });
  const b = await callDcc(app, "POST", "/api/triage/suppressions", { triage_id: "gmail:abc", key: "email|gmail:abc", title: "T" });
  assert.equal(a.json.created, true);
  assert.equal(b.json.created, false);
  assert.equal(blocks.filter((x) => !x.deleted_at).length, 1);
});

test("Done upgrades an existing scheduled link instead of creating a second row", async () => {
  const { app, blocks } = mountSuppressions();
  const scheduled = await callDcc(app, "POST", "/api/triage/suppressions", {
    triage_id: "gmail:t:m",
    key: "email|gmail:t:m",
    title: "Reply",
    reason: "scheduled",
    task_id: "task-1",
    scheduled_for: "2026-08-07",
  });
  const done = await callDcc(app, "POST", "/api/triage/suppressions", {
    triage_id: "gmail:t:m",
    key: "email|gmail:t:m",
    title: "Reply",
    reason: "done",
  });
  assert.equal(scheduled.json.suppression.reason, "scheduled");
  assert.equal(done.json.updated, true);
  assert.equal(done.json.suppression.reason, "done");
  assert.equal(blocks.filter((x) => !x.deleted_at).length, 1);
});

test("DELETE deactivates EVERY match, so a pre-idempotency duplicate cannot survive Undo", async () => {
  const { app, blocks } = mountSuppressions([
    sup("s1", { triage_id: "gmail:abc", reason: "done" }),
    sup("s2", { triage_id: "gmail:abc", reason: "done" }),
  ]);
  const { json } = await callDcc(app, "DELETE", "/api/triage/suppressions/gmail:abc");
  assert.equal(json.removed, 2);
  assert.equal(blocks.filter((x) => x.properties.active !== false).length, 0);
  assert.equal(blocks[0].properties.active, false);
  assert.match(blocks[0].properties.reopenedAt, /^2026-/);
});

test("DELETE deactivates a composite-key match too", async () => {
  const { app, blocks } = mountSuppressions([sup("s1", { triage_id: "", key: "email|gmail:abc", reason: "done" })]);
  const { json } = await callDcc(app, "DELETE", "/api/triage/suppressions/" + encodeURIComponent("email|gmail:abc"));
  assert.equal(json.removed, 1);
  assert.equal(blocks.filter((x) => x.properties.active !== false).length, 0);
});

test("Undo restores the bounded snapshot into day state before reopening", async () => {
  const { app, blocks, saved } = mountSuppressions([sup("s1", {
    triage_id: "gmail:t:m",
    reason: "done",
    itemSnapshot: { id: "gmail:t:m", title: "Restore me", received_at: "2026-08-05T12:00:00Z" },
  })]);
  const { json } = await callDcc(app, "DELETE", "/api/triage/suppressions/gmail:t:m?date=2026-08-06");
  assert.equal(json.restored_item.id, "gmail:t:m");
  assert.equal(json.restored_item._dcc_reopened, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state.triage.open_items[0].title, "Restore me");
  assert.equal(blocks[0].properties.active, false);
});

test("a body with neither triage_id nor key is refused rather than stored as a no-op", async () => {
  const { app, blocks } = mountSuppressions();
  const { status } = await callDcc(app, "POST", "/api/triage/suppressions", { title: "orphan" });
  assert.equal(status, 400);
  assert.equal(blocks.length, 0);
});

test("stored title and note are coerced and clamped", async () => {
  // These rows are durable and ride along on day reads, and express.json accepts 5mb.
  const { app, blocks } = mountSuppressions();
  await callDcc(app, "POST", "/api/triage/suppressions", {
    triage_id: "gmail:abc",
    title: "T".repeat(500),
    note: "N".repeat(4000),
  });
  const props = blocks[0].properties;
  assert.equal(props.itemTitle.length, 220);
  assert.equal(props.note.length, 1000);
  assert.equal(typeof props.itemTitle, "string");
});

test("the route stores bounded restore metadata and source timestamps", async () => {
  const { app, blocks } = mountSuppressions();
  const { json } = await callDcc(app, "POST", "/api/triage/suppressions", {
    triage_id: "gmail:thread-1:message-1",
    conversation_id: "thread-1",
    received_at: "2026-08-06T13:00:00Z",
    item: { id: "gmail:thread-1:message-1", title: "Subject", arbitrary: "drop me" },
  });
  assert.equal(blocks[0].properties.conversation_id, "thread-1");
  assert.equal(blocks[0].properties.received_at, "2026-08-06T13:00:00Z");
  assert.deepEqual(blocks[0].properties.itemSnapshot, {
    id: "gmail:thread-1:message-1",
    title: "Subject",
    conversation_id: "thread-1",
  });
  assert.equal(json.suppression.active, true);
});

test("a non-string title is coerced, not persisted as nested JSON", async () => {
  const { app, blocks } = mountSuppressions();
  await callDcc(app, "POST", "/api/triage/suppressions", { triage_id: "gmail:abc", title: { evil: 1 } });
  assert.equal(typeof blocks[0].properties.itemTitle, "string");
});

test("suppressions are workspace-scoped on read and on delete", async () => {
  // getBlocksByKind drops its workspace predicate entirely when workspaceId is falsy,
  // so a route that lost the scoping would read and DELETE another tenant's rows.
  const { app, blocks } = mountSuppressions([
    sup("mine", { triage_id: "gmail:abc", reason: "done" }),
    { id: "theirs", workspace_id: "ws-other", properties: { kind: "triage_suppression", triage_id: "gmail:abc", reason: "done" } },
  ]);
  const { json } = await callDcc(app, "DELETE", "/api/triage/suppressions/gmail:abc");
  assert.equal(json.removed, 1, "only this workspace's row");
  assert.equal(blocks.find((b) => b.id === "theirs").deleted_at, undefined);
});

test("there is no GET route duplicating what the day response already carries", async () => {
  // The client reads suppressions off __state.triage.suppressed_items. A second endpoint
  // serving the same data is one more thing that has to agree with the overlay.
  const { app } = mountSuppressions([sup("s1", { triage_id: "gmail:abc", reason: "done" })]);
  const { status } = await callDcc(app, "GET", "/api/triage/suppressions");
  assert.equal(status, 404);
});
