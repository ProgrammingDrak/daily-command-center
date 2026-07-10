// Tests for the precomputed meeting-artifact path:
//   - meeting-automation.applyArtifacts / mergeRecapIntoNotes (the storage layer)
//   - POST /api/dcc/meeting-artifacts (block resolution by identity + title, 404/400)
//
// applyArtifacts hard-requires ./db and ./pg-pool, so we inject in-memory fakes
// into require.cache BEFORE requiring meeting-automation (node --test isolates
// each file in its own process, so the stubbed cache never leaks). The endpoint
// is a ctx-factory (routes/dcc.js), so it mounts on a bare express app with fakes.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const meetingIdentity = require("./meeting-identity.js");

// ── in-memory block store shared by the automation fake ───────────────────────
function makeStore(seed) {
  let seq = 0;
  const store = (seed || []).slice();
  return {
    store,
    async getBlock(id) { return store.find((b) => b.id === id && !b.deleted_at) || null; },
    async getChildren(parentId, ws) {
      return store.filter((b) => b.parent_id === parentId && !b.deleted_at && (!ws || b.workspace_id === ws));
    },
    async getBlocksByDate(date, ws) {
      return store.filter((b) => b.date === date && !b.deleted_at && (!ws || b.workspace_id === ws));
    },
    async createBlock({ id, type, parent_id, date, properties, sort_order, user_id, workspace_id }) {
      const b = { id: id || "blk-" + (++seq), type, parent_id: parent_id || null, date, properties, sort_order, user_id, workspace_id, deleted_at: null };
      store.push(b);
      return b;
    },
    async updateBlock(id, { properties, sort_order, parent_id, date }) {
      const b = store.find((x) => x.id === id);
      if (!b) throw new Error("not found " + id);
      if (b.deleted_at) throw new Error("Block is deleted");
      if (properties !== undefined) b.properties = properties;
      if (sort_order !== undefined) b.sort_order = sort_order;
      if (parent_id !== undefined) b.parent_id = parent_id;
      if (date !== undefined) b.date = date;
      return b;
    },
  };
}

// Inject fakes for the modules meeting-automation requires at load time.
const mem = makeStore();
function stub(modPath, exports) {
  const p = require.resolve(modPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
}
stub("./db", mem); // makeStore returns the blockDB-like object directly
stub("./pg-pool", { query: async () => ({ rows: [] }) });
stub("./gcal-auth", { getAuthClient: async () => null, DEFAULT_ACCOUNT_KEY: "default" });
const automation = require("./meeting-automation.js");

function seedMeeting(id, extra) {
  mem.store.push({
    id, type: "block", parent_id: null, date: "2026-07-09",
    properties: Object.assign({ title: id, type: "meeting", source: "calendar", source_id: id, status: "done" }, extra),
    workspace_id: "ws-1", user_id: 1, deleted_at: null,
  });
}
const childrenOf = (id, kind) => mem.store.filter((b) => b.parent_id === id && (b.properties || {}).kind === kind);

test("applyArtifacts stores summary/transcript + owner-tagged proposed actions and mirrors recap to notes", async () => {
  seedMeeting("m1");
  const res = await automation.applyArtifacts("m1", {
    workspaceId: "ws-1", userId: 1,
    summary: { markdown: "### Recap\nGood chat about Q3." },
    transcript: { text: "Drake: hi. Ben: hi back." },
    proposedActions: [
      { text: "Send the recap to Ben", owner: "drake" },
      { text: "Ops to update the runbook", owner: "others" },
    ],
  });
  assert.deepEqual(res.applied, { prep: false, summary: true, transcript: true, proposedActions: 2, recapToNotes: true });
  assert.equal(childrenOf("m1", "meeting_summary").length, 1);
  assert.equal(childrenOf("m1", "meeting_transcript").length, 1);
  const actions = childrenOf("m1", "proposed_action_item");
  assert.equal(actions.length, 2);
  assert.equal(actions.every((a) => a.properties.status === "proposed" && a.properties.done === false), true);
  assert.deepEqual(actions.map((a) => a.properties.owner).sort(), ["drake", "other"]);
  // Feature 1: recap written onto the closed meeting's own notes.
  const m1 = await mem.getBlock("m1");
  assert.match(m1.properties.notes, /Good chat about Q3\./);
  assert.match(m1.properties.notes, /_Meeting recap \(auto\):_/);
});

test("re-post is idempotent: dedupes proposed actions, upserts summary in place, leaves notes stable", async () => {
  seedMeeting("m2");
  const first = await automation.applyArtifacts("m2", {
    workspaceId: "ws-1", userId: 1,
    summary: { markdown: "First recap." },
    proposedActions: [{ text: "Follow up with finance", owner: "drake" }],
  });
  assert.equal(first.applied.proposedActions, 1);
  const notesAfterFirst = (await mem.getBlock("m2")).properties.notes;

  const second = await automation.applyArtifacts("m2", {
    workspaceId: "ws-1", userId: 1,
    summary: { markdown: "First recap." }, // same recap
    proposedActions: [
      { text: "Follow up with finance", owner: "drake" }, // dup -> skipped
      { text: "Book the follow-up", owner: "drake" },      // new
    ],
  });
  assert.equal(second.applied.proposedActions, 1); // only the new one
  assert.equal(childrenOf("m2", "proposed_action_item").length, 2);
  assert.equal(childrenOf("m2", "meeting_summary").length, 1); // upserted, not duplicated
  assert.equal((await mem.getBlock("m2")).properties.notes, notesAfterFirst); // recap region stable
});

test("recap merge preserves the user's own notes above the auto section", async () => {
  seedMeeting("m3", { notes: "My own private note" });
  await automation.applyArtifacts("m3", { workspaceId: "ws-1", userId: 1, summary: { markdown: "Auto recap body" } });
  const notes = (await mem.getBlock("m3")).properties.notes;
  assert.match(notes, /^My own private note/);
  assert.match(notes, /Auto recap body$/);
});

test("recapToNotes:false stores the summary child but does not touch notes", async () => {
  seedMeeting("m4", { notes: "untouched" });
  const res = await automation.applyArtifacts("m4", { workspaceId: "ws-1", userId: 1, summary: { markdown: "x" }, recapToNotes: false });
  assert.equal(res.applied.summary, true);
  assert.equal(res.applied.recapToNotes, false);
  assert.equal((await mem.getBlock("m4")).properties.notes, "untouched");
});

test("applyArtifacts ignores client html, escapes markdown, and drops unsafe source urls", async () => {
  seedMeeting("m5");
  await automation.applyArtifacts("m5", {
    workspaceId: "ws-1", userId: 1,
    summary: {
      markdown: "Recap with <img src=x onerror=alert(1)> tag",
      html: "<img src=x onerror=alert(1)>", // client-supplied html must be ignored
      sources: [
        { type: "evil", url: "javascript:alert(1)" },
        { type: "ok", url: "https://example.com/doc" },
      ],
    },
  });
  const s = childrenOf("m5", "meeting_summary")[0].properties;
  assert.equal(/<img/.test(s.html), false, "raw client <img> must not survive");
  assert.equal(s.html.includes("&lt;img"), true, "markdown angle brackets are escaped");
  const evil = s.sources.find((x) => x.type === "evil");
  const ok = s.sources.find((x) => x.type === "ok");
  assert.equal("url" in evil, false, "javascript: url dropped");
  assert.equal(ok.url, "https://example.com/doc", "http(s) url kept");
});

test("mergeRecapIntoNotes: empty base, preserve user notes, idempotent replace", () => {
  const { mergeRecapIntoNotes } = automation;
  assert.equal(mergeRecapIntoNotes("", "Body"), "_Meeting recap (auto):_\n\nBody");
  const once = mergeRecapIntoNotes("User note", "Body v1");
  assert.match(once, /^User note/);
  assert.match(once, /Body v1$/);
  // Re-merging a new recap replaces only the auto region; user note survives once.
  const twice = mergeRecapIntoNotes(once, "Body v2");
  assert.match(twice, /^User note/);
  assert.match(twice, /Body v2$/);
  assert.equal((twice.match(/User note/g) || []).length, 1);
  assert.equal(twice.includes("Body v1"), false);
});

// ── endpoint: block resolution + status codes ────────────────────────────────
function mountApp(seedBlocks, applyRecorder) {
  const app = express();
  app.use(express.json());
  const store = makeStore(seedBlocks);
  const ctx = {
    blockDB: store, meetingIdentity,
    broadcast: () => {},
    isValidDate: (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
    getTodayStr: () => "2026-07-09",
    resolveOwnerStrict: async () => ({ userId: 1, workspaceId: "ws-1" }),
    meetingAutomation: {
      applyArtifacts: async (blockId, opts) => { applyRecorder.push({ blockId, opts }); return { applied: { summary: true }, proposedActions: [] }; },
    },
  };
  require("./routes/dcc.js")(app, ctx);
  return app;
}
async function post(app, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/dcc/meeting-artifacts`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: resp.status, json: await resp.json() };
  } finally { server.close(); }
}
const mtgBlock = (id, sid, title, date) => ({ id, type: "block", parent_id: null, date, properties: { title, type: "meeting", source: "calendar", source_id: sid }, workspace_id: "ws-1", user_id: 1, deleted_at: null });

test("endpoint resolves the meeting block by identity and calls applyArtifacts", async () => {
  const rec = [];
  const app = mountApp([mtgBlock("blk-a", "evt-123", "Sync with Ben", "2026-07-09")], rec);
  const { status, json } = await post(app, { meeting: { event_id: "evt-123", date: "2026-07-09" }, summary: { markdown: "hi" } });
  assert.equal(status, 200);
  assert.equal(json.meetingBlockId, "blk-a");
  assert.equal(rec.length, 1);
  assert.equal(rec[0].blockId, "blk-a");
});

test("endpoint falls back to same-day title match when no identity is given", async () => {
  const rec = [];
  const app = mountApp([mtgBlock("blk-b", "evt-9", "Weekly 1:1", "2026-07-09")], rec);
  const { status, json } = await post(app, { meeting: { title: "weekly 1:1", date: "2026-07-09" }, prep: { markdown: "p" } });
  assert.equal(status, 200);
  assert.equal(json.meetingBlockId, "blk-b");
});

test("endpoint 404s when no meeting block matches", async () => {
  const rec = [];
  const app = mountApp([mtgBlock("blk-c", "evt-1", "Standup", "2026-07-09")], rec);
  const { status } = await post(app, { meeting: { event_id: "nope", title: "nothing", date: "2026-07-09" } });
  assert.equal(status, 404);
  assert.equal(rec.length, 0);
});

test("endpoint 400s when the payload carries no meeting identity or title", async () => {
  const rec = [];
  const app = mountApp([], rec);
  const { status } = await post(app, { meeting: {}, summary: { markdown: "x" } });
  assert.equal(status, 400);
});

test("endpoint maps snake_case proposed_actions + recap_to_notes into applyArtifacts opts", async () => {
  const rec = [];
  const app = mountApp([mtgBlock("blk-d", "evt-7", "Sync", "2026-07-09")], rec);
  const { status } = await post(app, {
    meeting: { event_id: "evt-7", date: "2026-07-09" },
    proposed_actions: [{ text: "do the thing", owner: "drake" }],
    recap_to_notes: false,
  });
  assert.equal(status, 200);
  assert.equal(rec[0].opts.proposedActions.length, 1);
  assert.equal(rec[0].opts.recapToNotes, false);
});

test("resolver spans the +/-1 day window and ignores non-meeting same-title blocks", async () => {
  const rec = [];
  const seed = [
    mtgBlock("blk-real", "evt-x", "Planning", "2026-07-10"), // materialized on the neighbouring day
    { id: "blk-task", type: "block", parent_id: null, date: "2026-07-09", properties: { title: "Planning", type: "task" }, workspace_id: "ws-1", user_id: 1, deleted_at: null },
  ];
  const app = mountApp(seed, rec);
  const { status, json } = await post(app, { meeting: { title: "Planning", date: "2026-07-09" }, prep: { markdown: "p" } });
  assert.equal(status, 200);
  assert.equal(json.meetingBlockId, "blk-real"); // matched the meeting on date+1, not the same-title task
});
