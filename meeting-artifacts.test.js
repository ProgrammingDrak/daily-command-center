// Tests for the precomputed meeting-artifact path:
//   - meeting-automation.applyArtifacts (the storage layer)
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
    async getBlocksByDateRange(start, end, ws) {
      return store.filter((b) => b.date >= start && b.date <= end && !b.deleted_at && (!ws || b.workspace_id === ws));
    },
    async getBlocksByKind(kind, ws) {
      return store.filter((b) => (b.properties || {}).kind === kind && !b.deleted_at && (!ws || b.workspace_id === ws));
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
    async deleteBlock(id) {
      const b = store.find((x) => x.id === id);
      if (!b) throw new Error("not found " + id);
      b.deleted_at = new Date().toISOString();
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

test("applyArtifacts stores summary/transcript + owner-tagged proposed actions, lights the recap chip, and keeps recap OUT of notes", async () => {
  seedMeeting("m1");
  const res = await automation.applyArtifacts("m1", {
    workspaceId: "ws-1", userId: 1,
    summary: { markdown: "### Recap\nGood chat about Q3." },
    transcript: { text: "Drake: hi. Ben: hi back." },
    proposedActions: [
      { text: "Send the recap to Ben", owner: "drake", citation: { startOffset: 754.2, quote: "I'll send the recap." } },
      { text: "Ops to update the runbook", owner: "others" },
    ],
  });
  assert.deepEqual(res.applied, { prep: false, summary: true, transcript: true, proposedActions: 2, recapToNotes: false, recapReady: true, dashboardRef: false });
  assert.equal(childrenOf("m1", "meeting_summary").length, 1);
  assert.equal(childrenOf("m1", "meeting_transcript").length, 1);
  const actions = childrenOf("m1", "proposed_action_item");
  assert.equal(actions.length, 2);
  assert.equal(actions.every((a) => a.properties.status === "proposed" && a.properties.done === false), true);
  assert.deepEqual(actions.map((a) => a.properties.owner).sort(), ["drake", "other"]);
  assert.equal(actions.every((a) => a.properties.origin === "automated"), true);
  const cited = actions.find((a) => a.properties.owner === "drake").properties;
  assert.deepEqual(cited.citation, { startOffset: 754.2, quote: "I'll send the recap." });
  assert.equal(cited.start, undefined, "a transcript offset must never occupy the task timing field");
  assert.equal(cited.quote, undefined, "citation evidence stays in one namespace");
  const m1 = await mem.getBlock("m1");
  // The recap now lives ONLY in the meeting_summary artifact (surfaced in the Recap
  // tab), never mirrored into the meeting's notes box.
  assert.match(childrenOf("m1", "meeting_summary")[0].properties.html, /Good chat about Q3\./);
  assert.equal(m1.properties.notes, undefined);
  // ...and the meeting's own recap chip is lit so it's findable after it's marked done.
  assert.equal(m1.properties.recap_status, "ready");
});

test("re-post is idempotent: dedupes proposed actions, upserts summary in place, leaves notes stable", async () => {
  seedMeeting("m2");
  const first = await automation.applyArtifacts("m2", {
    workspaceId: "ws-1", userId: 1,
    summary: { markdown: "First recap." },
    proposedActions: [{ text: "Follow up with finance", owner: "drake" }],
  });
  assert.equal(first.applied.proposedActions, 1);

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
  assert.equal((await mem.getBlock("m2")).properties.notes, undefined); // recap is never written to notes
});

test("an explicit signal is stored with provenance and upgrades an automated duplicate in place", async () => {
  seedMeeting("msignal");
  await automation.applyArtifacts("msignal", {
    workspaceId: "ws-1", userId: 1,
    proposedActions: [{ text: "Send the launch brief", owner: "drake", origin: "automated" }],
  });
  const result = await automation.applyArtifacts("msignal", {
    workspaceId: "ws-1", userId: 1,
    proposedActions: [{
      text: "Send the launch brief.", owner: "drake", origin: "signaled",
      signal: {
        source: "google_chat", phrase: "action item", at: "2026-08-14T13:05:00Z", excerpt: "Action item: Send the launch brief",
        context: [{ at: "2026-08-14T13:04:30Z", speaker: "participant", excerpt: "Please send the launch brief." }],
      },
    }],
  });
  const actions = childrenOf("msignal", "proposed_action_item");
  assert.equal(actions.length, 1);
  assert.equal(result.applied.proposedActions, 0);
  assert.equal(actions[0].properties.origin, "signaled");
  assert.deepEqual(actions[0].properties.signal, {
    source: "google_chat", phrase: "action item", at: "2026-08-14T13:05:00Z",
    excerpt: "Action item: Send the launch brief",
    context: [{ at: "2026-08-14T13:04:30Z", speaker: "participant", excerpt: "Please send the launch brief." }],
  });
});

test("a duplicate action gains later transcript citation fields without losing provenance", async () => {
  seedMeeting("mcitation");
  await automation.applyArtifacts("mcitation", {
    workspaceId: "ws-1", userId: 1,
    proposedActions: [{ text: "Send the launch brief", owner: "drake", origin: "signaled",
      signal: { source: "google_chat", phrase: "action item", excerpt: "Action item: send it" } }],
  });
  const legacy = childrenOf("mcitation", "proposed_action_item")[0];
  legacy.properties.start = 45;
  legacy.properties.quote = "Legacy transcript quote";
  delete legacy.properties.citation;
  await automation.applyArtifacts("mcitation", {
    workspaceId: "ws-1", userId: 1,
    proposedActions: [{ text: "Send the launch brief.", owner: "drake", start: 91.5, quote: "I'll send it." }],
  });
  const action = childrenOf("mcitation", "proposed_action_item")[0].properties;
  assert.equal(action.origin, "signaled");
  assert.deepEqual(action.citation, { startOffset: 91.5, quote: "I'll send it." });
  assert.equal(action.start, undefined);
  assert.equal(action.quote, undefined);
});

test("missing, blank, negative, and non-finite timestamps never become zero-second citations", async () => {
  seedMeeting("m-no-fake-citations", { title: "No fake citations", dashboard_ref: "no-fakes" });
  await automation.applyArtifacts("m-no-fake-citations", {
    workspaceId: "ws-1", userId: 1,
    proposedActions: [
      { text: "Action without timestamp", start: null },
      { text: "Action with blank timestamp", start: "" },
      { text: "Action with negative timestamp", start: -1 },
      { text: "Action with infinite timestamp", start: Infinity },
    ],
  });
  const proposals = childrenOf("m-no-fake-citations", "proposed_action_item");
  assert.equal(proposals.length, 4);
  assert.equal(proposals.every(action => action.properties.citation.startOffset === null), true);
  assert.equal(proposals.every(action => action.properties.start === undefined), true);
  const projected = (await automation.listProposedActions({ workspaceId: "ws-1" }))
    .filter(action => action.meetingId === "m-no-fake-citations");
  assert.equal(projected.every(action => action.citation.startOffset === null), true);

  const approved = await automation.approveActions("m-no-fake-citations", {
    workspaceId: "ws-1", userId: 1,
  });
  assert.equal(approved.approvedBlocks.every(action => action.properties.meetingSource.citation.startOffset === null), true);
});

test("later citation enrichment follows an action through approval and placement", async () => {
  seedMeeting("m-citation-sync", { title: "Citation sync", dashboard_ref: "initial-review" });
  await automation.applyArtifacts("m-citation-sync", {
    workspaceId: "ws-1", userId: 1,
    proposedActions: [{ text: "Send the launch brief", owner: "drake" }],
  });
  const approved = await automation.approveActions("m-citation-sync", { workspaceId: "ws-1", userId: 1 });
  const taskId = approved.approvedBlocks[0].id;
  const proposal = childrenOf("m-citation-sync", "proposed_action_item")[0];
  proposal.properties.start = 45;
  proposal.properties.quote = "Legacy proposal quote";
  delete proposal.properties.citation;
  const legacyTask = await mem.getBlock(taskId);
  legacyTask.properties.meetingSource.start = 45;
  legacyTask.properties.meetingSource.quote = "Legacy task quote";
  delete legacyTask.properties.meetingSource.citation;

  await automation.applyArtifacts("m-citation-sync", {
    workspaceId: "ws-1", userId: 1, dashboardRef: "updated-review",
    proposedActions: [{
      text: "Send the launch brief.", owner: "drake", start: 91.5, quote: "I'll send it.", origin: "signaled",
      signal: { source: "transcript", phrase: "action item", excerpt: "Action item: send the launch brief" },
    }],
  });
  let task = await mem.getBlock(taskId);
  assert.equal(proposal.properties.start, undefined);
  assert.equal(proposal.properties.quote, undefined);
  assert.deepEqual(proposal.properties.citation, { startOffset: 91.5, quote: "I'll send it." });
  assert.deepEqual(task.properties.meetingSource, {
    meetingBlockId: "m-citation-sync", dashboardRef: "updated-review",
    citation: { startOffset: 91.5, quote: "I'll send it." },
  });
  assert.equal(task.properties.meetingAutomation.origin, "signaled");

  await automation.placeApprovedAction("m-citation-sync", taskId, {
    workspaceId: "ws-1", userId: 1, date: "2026-07-20", start: "14:00",
  });
  await automation.applyArtifacts("m-citation-sync", {
    workspaceId: "ws-1", userId: 1,
    proposedActions: [{ text: "Send the launch brief", start: 120, quote: "The final quote." }],
  });
  task = await mem.getBlock(taskId);
  assert.equal(task.parent_id, null);
  assert.equal(task.date, "2026-07-20");
  assert.equal(task.properties.kind, "task");
  assert.equal(task.properties.start, "14:00");
  assert.deepEqual(task.properties.meetingSource.citation, { startOffset: 120, quote: "The final quote." });
  assert.equal(task.properties.meetingSource.start, undefined);
  assert.equal(task.properties.meetingSource.quote, undefined);
});

test("Recap citation links read the citation namespace with a legacy fallback", () => {
  const source = require("node:fs").readFileSync(require.resolve("./public/js/meeting-automation.js"), "utf8");
  const body = source.slice(source.indexOf("function recapActionsHtml"), source.indexOf("async function scheduleRecapAction"));
  assert.match(body, /const citation=a\.citation&&typeof a\.citation==="object"\?a\.citation:\{\}/);
  assert.match(body, /const offset=citation\.startOffset!==undefined\?citation\.startOffset:a\.start/);
  assert.match(body, /const quote=citation\.quote!==undefined\?citation\.quote:a\.quote/);
  assert.match(body, /dashboard\?t='\+encodeURIComponent\(offset\)/);
});

test("applyArtifacts attaches the playable review, hot retention metadata, and safe cold source", async () => {
  seedMeeting("m-retention");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (14 * 24 * 60 * 60 * 1000)).toISOString();
  const bundle = await automation.applyArtifacts("m-retention", {
    workspaceId: "ws-1", userId: 1,
    dashboardRef: "2026-07-09-retention",
    recordingArtifact: {
      status: "hot", holding_days: 14, created_at: createdAt,
      hot_audio: {
        provider: "r2", bucket: "warm", key: "meetings/hot/ws-1/retention/audio.m4a", expires_at: expiresAt,
      },
    },
    recordingSource: { provider: "google_drive", url: "https://drive.google.com/open?id=x" },
  });
  assert.equal(bundle.meeting.dashboardRef, "2026-07-09-retention");
  assert.equal(bundle.meeting.recordingArtifact.holding_days, 14);
  assert.equal(bundle.meeting.recordingSource.url, "https://drive.google.com/open?id=x");
});

test("recording artifact ingestion enforces workspace, bucket, and 14-day retention boundaries", async () => {
  seedMeeting("m-retention-boundary");
  const createdAt = new Date().toISOString();
  const base = {
    status: "hot", created_at: createdAt,
    hot_audio: { provider: "r2", bucket: "warm", key: "meetings/hot/ws-1/review/audio.m4a" },
  };
  await assert.rejects(
    () => automation.applyArtifacts("m-retention-boundary", {
      workspaceId: "ws-1", userId: 1,
      recordingArtifact: { ...base, hot_audio: { ...base.hot_audio, key: "meetings/hot/ws-2/review/audio.m4a", expires_at: new Date(Date.now() + 60_000).toISOString() } },
    }),
    /outside this workspace or bucket/,
  );
  await assert.rejects(
    () => automation.applyArtifacts("m-retention-boundary", {
      workspaceId: "ws-1", userId: 1,
      recordingArtifact: { ...base, hot_audio: { ...base.hot_audio, expires_at: new Date(Date.now() + (15 * 24 * 60 * 60 * 1000)).toISOString() } },
    }),
    /expiry within 14 days/,
  );
});

test("a recap leaves the user's own notes untouched (recap lives only in the summary artifact)", async () => {
  seedMeeting("m3", { notes: "My own private note" });
  await automation.applyArtifacts("m3", { workspaceId: "ws-1", userId: 1, summary: { markdown: "Auto recap body" } });
  assert.equal((await mem.getBlock("m3")).properties.notes, "My own private note"); // untouched
  assert.match(childrenOf("m3", "meeting_summary")[0].properties.html, /Auto recap body/); // recap stored as artifact
});

test("re-posting a recap is quiet: recapReady flips true only on first landing", async () => {
  seedMeeting("m3b");
  const first = await automation.applyArtifacts("m3b", { workspaceId: "ws-1", userId: 1, summary: { markdown: "Recap once" } });
  assert.equal(first.applied.recapReady, true);   // first landing lights the chip + toasts
  assert.equal((await mem.getBlock("m3b")).properties.recap_status, "ready");
  const second = await automation.applyArtifacts("m3b", { workspaceId: "ws-1", userId: 1, summary: { markdown: "Recap again" } });
  assert.equal(second.applied.recapReady, false);  // already ready -> no re-toast
});

test("recapToNotes:false stores the summary child but does not touch notes", async () => {
  seedMeeting("m4", { notes: "untouched" });
  const res = await automation.applyArtifacts("m4", { workspaceId: "ws-1", userId: 1, summary: { markdown: "x" }, recapToNotes: false });
  assert.equal(res.applied.summary, true);
  assert.equal(res.applied.recapToNotes, false);
  assert.equal((await mem.getBlock("m4")).properties.notes, "untouched");
});

// ── Auto-prep flip + action placement (Phase 10) ──────────────────────────────

test("applyArtifacts with a prep flips the meeting block's own prep_status to ready", async () => {
  seedMeeting("mp", { prep_status: "pending" });
  const res = await automation.applyArtifacts("mp", {
    workspaceId: "ws-1", userId: 1,
    prep: { markdown: "### Prep\nDo the reading." },
  });
  assert.equal(res.applied.prep, true);
  assert.equal((await mem.getBlock("mp")).properties.prep_status, "ready");
});

test("generatePrep (fallback template) also flips prep_status to ready", async () => {
  seedMeeting("mg", { prep_status: "pending", start: "10:00", end: "10:30" });
  await automation.generatePrep("mg", { workspaceId: "ws-1", userId: 1 });
  assert.equal((await mem.getBlock("mg")).properties.prep_status, "ready");
});

test("placeApprovedAction promotes an approved action to a standalone day task", async () => {
  seedMeeting("mplace");
  mem.store.push({ id: "prop1", type: "block", parent_id: "mplace", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "Email the deck", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const approved = await automation.approveActions("mplace", { workspaceId: "ws-1", userId: 1 });
  const actionId = approved.approvedBlocks[0].id;
  assert.equal((await mem.getBlock(actionId)).parent_id, "mplace"); // starts under the meeting

  const placed = await automation.placeApprovedAction("mplace", actionId, { workspaceId: "ws-1", userId: 1, date: "2026-07-15" });
  assert.equal(placed.ok, true);
  const b = await mem.getBlock(actionId);
  assert.equal(b.parent_id, null);         // detached from the meeting
  assert.equal(b.date, "2026-07-15");      // moved to the picked day
  assert.equal(b.properties.kind, "task"); // now folds as a standalone task
});

test("placeApprovedAction rejects a bad date and an action that isn't the meeting's", async () => {
  seedMeeting("mA"); seedMeeting("mB");
  mem.store.push({ id: "stray", type: "block", parent_id: "mB", date: "2026-07-09",
    properties: { kind: "task", text: "not mine" }, workspace_id: "ws-1", user_id: 1, deleted_at: null });
  await assert.rejects(
    () => automation.placeApprovedAction("mA", "stray", { workspaceId: "ws-1", userId: 1, date: "2026-07-15" }),
    /does not belong/);
  mem.store.push({ id: "p2", type: "block", parent_id: "mA", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "x", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const ap = await automation.approveActions("mA", { workspaceId: "ws-1", userId: 1 });
  await assert.rejects(
    () => automation.placeApprovedAction("mA", ap.approvedBlocks[0].id, { workspaceId: "ws-1", userId: 1, date: "nope" }),
    /Invalid date/);
});

test("placeApprovedAction pins a valid start and drops an invalid one", async () => {
  seedMeeting("mstart");
  mem.store.push({ id: "ps1", type: "block", parent_id: "mstart", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "Prep the deck", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const ap1 = await automation.approveActions("mstart", { workspaceId: "ws-1", userId: 1 });
  const aid1 = ap1.approvedBlocks[0].id;
  await automation.placeApprovedAction("mstart", aid1, { workspaceId: "ws-1", userId: 1, date: "2026-07-15", start: "09:30" });
  const b1 = await mem.getBlock(aid1);
  assert.equal(b1.properties.start, "09:30");
  assert.equal(b1.properties._pinnedStart, "09:30");

  mem.store.push({ id: "ps2", type: "block", parent_id: "mstart", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "Other", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const ap2 = await automation.approveActions("mstart", { workspaceId: "ws-1", userId: 1 });
  const aid2 = ap2.approvedBlocks[0].id;
  await automation.placeApprovedAction("mstart", aid2, { workspaceId: "ws-1", userId: 1, date: "2026-07-16", start: "25:00" });
  const b2 = await mem.getBlock(aid2);
  assert.equal(b2.properties.start, undefined); // junk time dropped
  assert.equal(b2.date, "2026-07-16");          // date still applied
});

test("placeApprovedAction stamps the originating proposal placed + placedDate (durable Scheduled ✓)", async () => {
  seedMeeting("mstamp");
  mem.store.push({ id: "pstamp", type: "block", parent_id: "mstamp", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "Ship the recap tab", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const ap = await automation.approveActions("mstamp", { workspaceId: "ws-1", userId: 1 });
  const aid = ap.approvedBlocks[0].id;
  await automation.placeApprovedAction("mstamp", aid, { workspaceId: "ws-1", userId: 1, date: "2026-07-20", start: "14:00" });
  const proposal = await mem.getBlock("pstamp");
  assert.equal(proposal.properties.status, "placed");   // Recap tab reads this as "Scheduled ✓"
  assert.equal(proposal.properties.placedDate, "2026-07-20");
  assert.equal(proposal.properties.placedStart, "14:00");
});

test("placeApprovedAction cannot stamp a foreign proposal through forged provenance", async () => {
  seedMeeting("mforged");
  mem.store.push(
    { id: "foreign-proposal", type: "block", parent_id: "foreign-meeting", date: "2026-07-09",
      properties: { kind: "proposed_action_item", text: "Private", status: "approved", approvedBlockId: "foreign-child" },
      workspace_id: "ws-OTHER", user_id: 2, deleted_at: null },
    { id: "forged-action", type: "block", parent_id: "mforged", date: "2026-07-09",
      properties: { kind: "task", title: "Local action",
        meetingAutomation: { meetingBlockId: "mforged", proposedActionId: "foreign-proposal" } },
      workspace_id: "ws-1", user_id: 1, deleted_at: null }
  );
  await automation.placeApprovedAction("mforged", "forged-action", {
    workspaceId: "ws-1", userId: 1, date: "2026-07-20", start: "15:00",
  });
  const foreign = await mem.getBlock("foreign-proposal");
  assert.equal(foreign.properties.status, "approved");
  assert.equal(foreign.properties.placedDate, undefined);
});

test("listProposedActions projects only open meeting proposals with meeting context", async () => {
  seedMeeting("mlist", { title: "Weekly planning", start: "10:00", end: "10:30", dashboard_ref: "weekly-planning" });
  mem.store.push(
    { id: "plist", type: "block", parent_id: "mlist", date: "2026-07-09", created_at: "2026-07-09T11:00:00Z",
      properties: { kind: "proposed_action_item", text: "Send the brief", owner: "drake", priority: "High", status: "proposed", start: 91.5, quote: "I'll send it." }, workspace_id: "ws-1", user_id: 1, deleted_at: null },
    { id: "placed-list", type: "block", parent_id: "mlist", date: "2026-07-09",
      properties: { kind: "proposed_action_item", text: "Already placed", status: "placed" }, workspace_id: "ws-1", user_id: 1, deleted_at: null }
  );
  const rows = await automation.listProposedActions({ workspaceId: "ws-1" });
  const row = rows.find(item => item.id === "plist");
  assert.deepEqual(row, {
    id: "plist", meetingId: "mlist", meetingTitle: "Weekly planning", meetingDate: "2026-07-09",
    meetingStart: "10:00", meetingEnd: "10:30", title: "Send the brief", owner: "drake",
    priority: "High", origin: "automated", signal: null,
    citation: { startOffset: 91.5, quote: "I'll send it." }, dashboardRef: "weekly-planning",
    approvedBlockId: null, createdAt: "2026-07-09T11:00:00Z",
  });
  assert.equal(rows.some(item => item.id === "placed-list"), false);
});

test("dismissProposedAction removes a proposal from the elevation read model", async () => {
  seedMeeting("mdismiss", { title: "Review" });
  mem.store.push({ id: "pdismiss", type: "block", parent_id: "mdismiss", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "No longer needed", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  await automation.dismissProposedAction("mdismiss", "pdismiss", { workspaceId: "ws-1" });
  assert.equal((await mem.getBlock("pdismiss")).properties.status, "dismissed");
  assert.equal((await automation.listProposedActions({ workspaceId: "ws-1" })).some(item => item.id === "pdismiss"), false);
});

test("placeProposedAction retries from an already-approved child without duplicating it", async () => {
  seedMeeting("mretry", { title: "Retry review" });
  mem.store.push({ id: "pretry", type: "block", parent_id: "mretry", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "Retry the placement", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const approved = await automation.approveActions("mretry", { workspaceId: "ws-1", userId: 1, actionIds: ["pretry"] });
  const approvedId = approved.approvedBlocks[0].id;
  const before = childrenOf("mretry").length;
  const result = await automation.placeProposedAction("mretry", "pretry", {
    workspaceId: "ws-1", userId: 1, date: "2026-07-21",
  });
  assert.equal(result.actionBlockId, approvedId);
  assert.equal(childrenOf("mretry").length, before - 1, "placement detaches the existing approved child");
  assert.equal((await mem.getBlock("pretry")).properties.status, "placed");
});

test("approved but unplaced actions remain visible and can be dismissed cleanly", async () => {
  seedMeeting("mapproved", { title: "Approved review" });
  mem.store.push({ id: "papproved", type: "block", parent_id: "mapproved", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "Remove me", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const approved = await automation.approveActions("mapproved", { workspaceId: "ws-1", userId: 1, actionIds: ["papproved"] });
  assert.equal((await automation.listProposedActions({ workspaceId: "ws-1" })).some(item => item.id === "papproved"), true);
  await automation.dismissProposedAction("mapproved", "papproved", { workspaceId: "ws-1" });
  assert.equal((await mem.getBlock("papproved")).properties.status, "dismissed");
  assert.equal(await mem.getBlock(approved.approvedBlocks[0].id), null);
});

test("completed approved actions leave the Loose Ends read model", async () => {
  seedMeeting("mcomplete", { title: "Completed review" });
  mem.store.push({ id: "pcomplete", type: "block", parent_id: "mcomplete", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "Already handled", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const approved = await automation.approveActions("mcomplete", { workspaceId: "ws-1", userId: 1, actionIds: ["pcomplete"] });
  const action = approved.approvedBlocks[0];
  const visible = (await automation.listProposedActions({ workspaceId: "ws-1" })).find(item => item.id === "pcomplete");
  assert.equal(visible.approvedBlockId, action.id, "approved id is exposed so a failed completion can retry");
  await mem.updateBlock(action.id, { properties: { ...action.properties, status: "done", done: true, completedAt: "2026-08-14T10:00:00Z" } });
  assert.equal((await automation.listProposedActions({ workspaceId: "ws-1" })).some(item => item.id === "pcomplete"), false);
});

test("a deleted approved action is hidden as stale and recreated on retry", async () => {
  seedMeeting("mdeleted", { title: "Deleted action review" });
  mem.store.push({ id: "pdeleted", type: "block", parent_id: "mdeleted", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "Recreate me", status: "proposed" },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const first = await automation.approveActions("mdeleted", { workspaceId: "ws-1", userId: 1, actionIds: ["pdeleted"] });
  const staleId = first.approvedBlocks[0].id;
  await mem.deleteBlock(staleId);

  const visible = (await automation.listProposedActions({ workspaceId: "ws-1" })).find(item => item.id === "pdeleted");
  assert.equal(visible.approvedBlockId, null, "a deleted child is never offered to the client for completion");

  const retried = await automation.approveActions("mdeleted", { workspaceId: "ws-1", userId: 1, actionIds: ["pdeleted"] });
  const replacement = retried.approvedBlocks[0];
  assert.notEqual(replacement.id, staleId);
  assert.equal(replacement.deleted_at, null);
  assert.equal((await mem.getBlock("pdeleted")).properties.approvedBlockId, replacement.id);
});

test("a cross-workspace approvedBlockId is neither exposed nor reused", async () => {
  seedMeeting("mforeign", { title: "Workspace boundary review" });
  mem.store.push(
    { id: "pforeign", type: "block", parent_id: "mforeign", date: "2026-07-09",
      properties: { kind: "proposed_action_item", text: "Keep workspaces separate", status: "approved", approvedBlockId: "foreign-action" },
      workspace_id: "ws-1", user_id: 1, deleted_at: null },
    { id: "foreign-action", type: "block", parent_id: "mforeign", date: "2026-07-09",
      properties: { kind: "task", title: "Private task", status: "done", done: true,
        meetingAutomation: { meetingBlockId: "mforeign", proposedActionId: "pforeign" } },
      workspace_id: "ws-OTHER", user_id: 2, deleted_at: null }
  );

  const visible = (await automation.listProposedActions({ workspaceId: "ws-1" })).find(item => item.id === "pforeign");
  assert.ok(visible, "foreign completion state must not hide the local proposal");
  assert.equal(visible.approvedBlockId, null, "foreign ids must not cross the read-model boundary");

  const repaired = await automation.approveActions("mforeign", { workspaceId: "ws-1", userId: 1, actionIds: ["pforeign"] });
  assert.equal(repaired.approvedBlocks[0].workspace_id, "ws-1");
  assert.notEqual(repaired.approvedBlocks[0].id, "foreign-action");
});

test("dismiss and schedule never mutate a foreign approvedBlockId", async () => {
  seedMeeting("mboundary", { title: "Boundary mutation review" });
  const foreign = { id: "foreign-mutation", type: "block", parent_id: "mboundary", date: "2026-07-09",
    properties: { kind: "task", title: "Do not touch",
      meetingAutomation: { meetingBlockId: "mboundary", proposedActionId: "pdismiss-foreign" } },
    workspace_id: "ws-OTHER", user_id: 2, deleted_at: null };
  mem.store.push(
    { id: "pdismiss-foreign", type: "block", parent_id: "mboundary", date: "2026-07-09",
      properties: { kind: "proposed_action_item", text: "Dismiss safely", status: "approved", approvedBlockId: foreign.id },
      workspace_id: "ws-1", user_id: 1, deleted_at: null },
    foreign
  );
  await automation.dismissProposedAction("mboundary", "pdismiss-foreign", { workspaceId: "ws-1" });
  assert.equal(foreign.deleted_at, null, "dismiss must leave another workspace's action untouched");

  mem.store.push({ id: "pschedule-foreign", type: "block", parent_id: "mboundary", date: "2026-07-09",
    properties: { kind: "proposed_action_item", text: "Schedule safely", status: "approved", approvedBlockId: foreign.id },
    workspace_id: "ws-1", user_id: 1, deleted_at: null });
  const placed = await automation.placeProposedAction("mboundary", "pschedule-foreign", {
    workspaceId: "ws-1", userId: 1, date: "2026-07-18",
  });
  assert.notEqual(placed.actionBlockId, foreign.id);
  assert.equal(foreign.parent_id, "mboundary");
  assert.equal(foreign.date, "2026-07-09");
});

test("placeApprovedAction 404s on a missing action and a cross-workspace action", async () => {
  seedMeeting("m404");
  await assert.rejects(
    () => automation.placeApprovedAction("m404", "does-not-exist", { workspaceId: "ws-1", userId: 1, date: "2026-07-15" }),
    /not found/i);
  mem.store.push({ id: "xws", type: "block", parent_id: "m404", date: "2026-07-09",
    properties: { kind: "task", text: "x" }, workspace_id: "ws-OTHER", user_id: 1, deleted_at: null });
  await assert.rejects(
    () => automation.placeApprovedAction("m404", "xws", { workspaceId: "ws-1", userId: 1, date: "2026-07-15" }),
    /not found/i);
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

// ── endpoint: block resolution + status codes ────────────────────────────────
function mountApp(seedBlocks, applyRecorder, extra = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workspaceId = extra.workspaceId || "ws-1"; next(); });
  const store = makeStore(seedBlocks);
  const ctx = {
    blockDB: store, meetingIdentity,
    broadcast: extra.broadcastRecorder ? (type, data, ws) => extra.broadcastRecorder.push({ type, data, ws }) : () => {},
    isValidDate: (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
    getTodayStr: () => "2026-07-09",
    resolveOwnerStrict: async () => ({ userId: 1, workspaceId: "ws-1" }),
    meetingAutomation: {
      applyArtifacts: async (blockId, opts) => { applyRecorder.push({ blockId, opts }); return { applied: extra.applied || { summary: true }, proposedActions: [] }; },
    },
    meetingSignals: extra.meetingSignals,
  };
  require("./routes/dcc.js")(app, ctx);
  return app;
}
async function postPath(app, path, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: resp.status, json: await resp.json() };
  } finally { server.close(); }
}
async function getPath(app, path) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: resp.status, json: await resp.json() };
  } finally { server.close(); }
}
const post = (app, body) => postPath(app, "/api/dcc/meeting-artifacts", body);

test("meeting-signals endpoint passes the service owner and explicit prefixes to the read-only bridge", async () => {
  const calls = [];
  const app = mountApp([], [], { meetingSignals: {
    readSignals: async input => { calls.push(input); return { signals: [{ id: "s1" }], diagnostics: [] }; },
  } });
  const meeting = { start: "2026-08-14T13:00:00Z", end: "2026-08-14T13:30:00Z", account_key: "work" };
  const { status, json } = await postPath(app, "/api/dcc/meeting-signals", { meeting, explicit_prefixes: ["action item"] });
  assert.equal(status, 200);
  assert.deepEqual(json.signals, [{ id: "s1" }]);
  assert.deepEqual(calls, [{ userId: 1, meeting, prefixes: ["action item"] }]);
});

test("meeting-signals endpoint requires a bounded meeting window", async () => {
  const app = mountApp([], [], { meetingSignals: { readSignals: async () => ({ signals: [] }) } });
  const { status } = await postPath(app, "/api/dcc/meeting-signals", { meeting: { start: "2026-08-14T13:00:00Z" } });
  assert.equal(status, 400);
});

test("meeting retention candidates expose only scoped lifecycle metadata", async () => {
  const rows = [
    { id: "meeting-1", type: "block", date: "2026-08-14", workspace_id: "ws-1", properties: {
      type: "meeting", title: "Planning", end: "14:30", notes: "private notes", recap_status: "ready",
      dashboard_ref: "planning", recording_artifact: { status: "hot", arbitrary: "secret", hot_audio: {
        provider: "r2", bucket: "warm", key: "meetings/hot/ws-1/planning/audio.m4a",
        expires_at: "2026-08-20T00:00:00Z", arbitrary: "secret",
      } },
    } },
    { id: "other-workspace", type: "block", date: "2026-08-14", workspace_id: "ws-2", properties: { type: "meeting" } },
    { id: "task-1", type: "block", date: "2026-08-14", workspace_id: "ws-1", properties: { type: "task" } },
  ];
  const app = mountApp(rows, []);
  const { status, json } = await getPath(app, "/api/dcc/meeting-retention-candidates?start=2026-08-01&end=2026-08-14");
  assert.equal(status, 200);
  assert.equal(json.length, 1);
  assert.equal(json[0].id, "meeting-1");
  assert.equal(json[0].properties.notes, undefined);
  assert.equal(json[0].properties.end, "14:30");
  assert.equal(json[0].properties.recording_artifact.arbitrary, undefined);
  assert.equal(json[0].properties.recording_artifact.hot_audio.arbitrary, undefined);
});

test("meeting retention candidates reject unbounded ranges", async () => {
  const app = mountApp([], []);
  const { status } = await getPath(app, "/api/dcc/meeting-retention-candidates?start=2024-01-01&end=2026-08-14");
  assert.equal(status, 400);
});

test("meeting retention candidates reject impossible calendar dates", async () => {
  const app = mountApp([], []);
  const { status } = await getPath(app, "/api/dcc/meeting-retention-candidates?start=2026-02-31&end=2026-03-01");
  assert.equal(status, 400);
});

test("meeting retention candidates omit completed lifecycle rows", async () => {
  const rows = [{
    id: "done", type: "block", date: "2026-08-14", workspace_id: "ws-1",
    properties: { type: "meeting", recap_status: "ready", dashboard_ref: "done",
      recording_artifact: { status: "compacted", cleanup_pending: false } },
  }];
  const app = mountApp(rows, []);
  const { status, json } = await getPath(app, "/api/dcc/meeting-retention-candidates?start=2026-08-01&end=2026-08-14");
  assert.equal(status, 200);
  assert.deepEqual(json, []);
});
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
    dashboard_ref: "sync-review",
    recording_artifact: { status: "hot", holding_days: 14 },
    recording_source: { provider: "google_drive", url: "https://drive.google.com/open?id=x" },
  });
  assert.equal(status, 200);
  assert.equal(rec[0].opts.proposedActions.length, 1);
  assert.equal(rec[0].opts.recapToNotes, false);
  assert.equal(rec[0].opts.dashboardRef, "sync-review");
  assert.equal(rec[0].opts.recordingArtifact.holding_days, 14);
  assert.equal(rec[0].opts.recordingSource.provider, "google_drive");
});

test("endpoint broadcasts recapArrived + meetingTitle only when a recap first lands", async () => {
  const rec = [], bcast = [];
  const app = mountApp([mtgBlock("blk-r", "evt-r", "Sync with Ben", "2026-07-09")], rec,
    { broadcastRecorder: bcast, applied: { summary: true, recapReady: true } });
  const { status } = await post(app, { meeting: { event_id: "evt-r", date: "2026-07-09" }, summary: { markdown: "hi" } });
  assert.equal(status, 200);
  const msg = bcast.find((b) => b.type === "blocks-changed");
  assert.ok(msg, "a blocks-changed broadcast fired");
  assert.equal(msg.data.recapArrived, true);            // first landing -> client toasts once
  assert.equal(msg.data.meetingTitle, "Sync with Ben");

  const rec2 = [], bcast2 = [];
  const app2 = mountApp([mtgBlock("blk-r2", "evt-r2", "Sync again", "2026-07-09")], rec2,
    { broadcastRecorder: bcast2, applied: { summary: true, recapReady: false } });
  await post(app2, { meeting: { event_id: "evt-r2", date: "2026-07-09" }, summary: { markdown: "hi" } });
  assert.equal(bcast2.find((b) => b.type === "blocks-changed").data.recapArrived, false); // idempotent re-post stays quiet
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

// ── In-place editable prep/summary: preserve-on-regenerate + updateArtifactContent ──

function seedArtifact(meetingId, kind, props) {
  mem.store.push({
    id: kind + "-" + meetingId, type: "block", parent_id: meetingId, date: "2026-07-09",
    properties: Object.assign({ kind, meetingBlockId: meetingId }, props),
    workspace_id: "ws-1", user_id: 1, deleted_at: null,
  });
}

test("generatePrep preserves a hand-edited prep under exactly one User Notes section (no double-wrap across the h4->h3 round-trip)", async () => {
  seedMeeting("mpres", { prep_status: "ready", start: "10:00", end: "10:30" });
  // A prior manual edit: userEdited flag set, rich html, no User Notes marker yet.
  seedArtifact("mpres", "meeting_prep", { title: "Prep: mpres", status: "draft", userEdited: true,
    html: "<p>Keep my <strong>note</strong></p>", markdown: "Keep my note", blocks: [{ id: "b", type: "paragraph", content: "Keep my note" }] });

  await automation.generatePrep("mpres", { workspaceId: "ws-1", userId: 1 });
  const p1 = childrenOf("mpres", "meeting_prep")[0].properties;
  assert.equal(childrenOf("mpres", "meeting_prep").length, 1, "upserts in place, no duplicate prep");
  assert.match(p1.html, /Meeting Prep/, "fresh template regenerated");
  assert.match(p1.html, /Keep my <strong>note<\/strong>/, "prior rich edit preserved verbatim");
  assert.equal((p1.html.match(/User Notes/gi) || []).length, 1, "exactly one User Notes section");
  assert.ok(p1.html.indexOf("Meeting Prep") < p1.html.indexOf("User Notes"), "fresh template sits above User Notes, not nested inside it");
  assert.equal(p1.userEdited, false, "userEdited reset after regenerate");
  assert.equal(p1.blocks, null, "blocks cleared so the client re-seeds from html/markdown");

  // Simulate the user editing again: the block editor round-trips the injected
  // <h4> heading as <h3>. A literal-marker match would double-wrap here.
  const child = mem.store.find((b) => b.parent_id === "mpres" && b.properties.kind === "meeting_prep");
  child.properties.userEdited = true;
  child.properties.html = p1.html.replace(/<h4>/g, "<h3>").replace(/<\/h4>/g, "</h3>");

  await automation.generatePrep("mpres", { workspaceId: "ws-1", userId: 1 });
  const p2 = childrenOf("mpres", "meeting_prep")[0].properties;
  assert.equal((p2.html.match(/User Notes/gi) || []).length, 1, "still exactly one User Notes after a second regenerate (h3 tolerated)");
  assert.match(p2.html, /Keep my <strong>note<\/strong>/, "edit still preserved on the second regenerate");
});

test("updateArtifactContent rejects an unsupported kind", async () => {
  seedMeeting("mkind");
  await assert.rejects(
    () => automation.updateArtifactContent("mkind", "meeting_transcript", { html: "x" }, { workspaceId: "ws-1", userId: 1 }),
    (e) => e.statusCode === 400 && /Unsupported artifact kind/.test(e.message));
});

test("updateArtifactContent lazily creates a prep on first edit and lights the itinerary chip", async () => {
  seedMeeting("mlazy", { prep_status: "pending" });
  assert.equal(childrenOf("mlazy", "meeting_prep").length, 0);
  await automation.updateArtifactContent("mlazy", "meeting_prep",
    { html: "<p>hand written</p>", blocks: [{ id: "b1", type: "paragraph", content: "hand written" }], markdown: "hand written" },
    { workspaceId: "ws-1", userId: 1 });
  const kids = childrenOf("mlazy", "meeting_prep");
  assert.equal(kids.length, 1, "artifact created");
  assert.equal(kids[0].properties.userEdited, true);
  assert.equal(kids[0].properties.blocks.length, 1, "editor blocks stored verbatim");
  assert.equal((await mem.getBlock("mlazy")).properties.prep_status, "ready", "first prep create flips the chip pending->ready");
});

test("updateArtifactContent merges over existing props (kind/sources/title survive a content-only edit)", async () => {
  seedMeeting("mmerge");
  seedArtifact("mmerge", "meeting_summary", { title: "Summary: mmerge", status: "ready",
    sources: [{ type: "gmail", url: "https://mail.example/x" }], html: "<p>old</p>", markdown: "old", userEdited: false });
  await automation.updateArtifactContent("mmerge", "meeting_summary",
    { html: "<p>new body</p>", blocks: [{ id: "s1", type: "paragraph", content: "new body" }], markdown: "new body" },
    { workspaceId: "ws-1", userId: 1 });
  const s = childrenOf("mmerge", "meeting_summary")[0].properties;
  assert.equal(childrenOf("mmerge", "meeting_summary").length, 1, "upserts in place");
  assert.match(s.html, /new body/, "content updated");
  assert.equal(s.userEdited, true, "userEdited flipped true");
  assert.equal(s.kind, "meeting_summary", "kind discriminator preserved");
  assert.equal(s.title, "Summary: mmerge", "title preserved");
  assert.deepEqual(s.sources, [{ type: "gmail", url: "https://mail.example/x" }], "sources preserved (not clobbered)");
});
