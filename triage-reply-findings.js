"use strict";

// New reviewed source -> the standard durable Triage materializer + saved draft,
// in one transaction. No full day-state writer or outward source adapter.
const TaskModel = require("./public/js/task-model");
const triage = require("./triage-suppressions");
const createMaterializer = require("./triage-task-store");
const createDraftStore = require("./triage-reply-drafts");
function fail(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }
function validate(packet, now = Date.now()) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet) ||
      Object.keys(packet).some(key => !["id", "reply_findings"].includes(key))) fail(400, "Reply findings cannot be mixed with other intake fields");
  if (packet.id != null && (typeof packet.id !== "string" || !packet.id.trim() || packet.id.length > 500)) fail(400, "Invalid finding packet id");
  if (!Array.isArray(packet.reply_findings) || packet.reply_findings.length < 1 || packet.reply_findings.length > 10) fail(400, "Expected one to ten reviewed findings");
  const seen = new Set(), refs = new Set();
  return packet.reply_findings.map(finding => {
    const keys = ["source_id", "source_ref", "title", "reason", "draft_preview", "thread_id", "received_at", "reviewed_at", "sensitivity"];
    if (!finding || Array.isArray(finding) || typeof finding !== "object" || Object.keys(finding).length !== keys.length ||
        Object.keys(finding).some(key => !keys.includes(key)) || keys.some(key => typeof finding[key] !== "string" || !finding[key].trim()) ||
        finding.sensitivity !== "ordinary_business") fail(400, "Minimized ordinary-business finding required");
    const slack = /^slack:(dm|mention):([CDG][A-Z0-9]+):(\d{10}\.\d{6})$/.exec(finding.source_id);
    if (!slack && !/^gmail:[a-f0-9]+:[a-f0-9]+$/.test(finding.source_id)) fail(400, "Exact Gmail or Slack source identity required");
    if ((slack && (!/^\d{10}\.\d{6}$/.test(finding.thread_id) || Number(finding.thread_id) > Number(slack[3]))) ||
        (!slack && finding.thread_id !== finding.source_id.split(":")[1])) fail(400, "Verified source thread identity required");
    createDraftStore.validate({ reply_drafts: [{ task_id: "source-preflight", triage_id: finding.source_id,
      source_ref: finding.source_ref, draft_preview: finding.draft_preview }] });
    const reviewed = Date.parse(finding.reviewed_at), received = Date.parse(finding.received_at);
    const qualified = value => /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
    if (!qualified(finding.reviewed_at) || !qualified(finding.received_at) || !Number.isFinite(reviewed) || !Number.isFinite(received) ||
        now - reviewed < 0 || now - reviewed > 3600000 || received > now + 60000) fail(400, "Fresh qualified review and source timestamps required");
    if (finding.title.length > 200 || finding.reason.length > 1000) fail(400, "Minimized title and rationale required");
    if (seen.has(finding.source_id) || refs.has(finding.source_ref)) fail(400, "Duplicate finding source or conversation");
    seen.add(finding.source_id); refs.add(finding.source_ref);
    return { id: finding.source_id, type: slack ? "slack" : "email", title: finding.title, summary: finding.reason,
      source_ref: finding.source_ref, link: finding.source_ref, received_at: finding.received_at,
      reviewed_at: finding.reviewed_at, thread_id: finding.thread_id, draft_preview: finding.draft_preview, draft_type: "internal", draft_status: "drafted",
      ...(slack ? { channel_id: slack[2], message_ts: slack[3] } : {}) };
  });
}
module.exports = function createReplyFindingStore({ pool, blockDB }) {
  async function capture({ packet, userId, workspaceId, dryRun = false }) {
    const items = validate(packet);
    if (!Number.isInteger(userId) || userId < 1 || !workspaceId) fail(403, "Finding owner required");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const sourceId of items.map(item => item.id).sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`triage-reviewed:${workspaceId}:${sourceId}`]);
      }
      const ids = items.map(item => item.id), keys = items.map(triage.triageItemKey);
      const threads = items.filter(item => item.type === "email").map(item => item.thread_id);
      const suppressionRows = await client.query(`SELECT * FROM blocks WHERE workspace_id=$1 AND deleted_at IS NULL
        AND properties->>'kind'='triage_suppression' AND (properties->>'triage_id'=ANY($2::text[])
          OR properties->>'key'=ANY($3::text[]) OR properties->>'conversation_id'=ANY($4::text[])
          OR properties->>'triage_id'=ANY($5::text[]))
        ORDER BY id LIMIT 101 FOR SHARE`, [workspaceId, ids, keys, threads, threads.map(thread => `gmail:${thread}`)]);
      if (suppressionRows.rows.length > 100) fail(409, "Source suppression history needs review");
      const suppressions = triage.suppressionIndex(triage.suppressionsFromBlocks(suppressionRows.rows));
      const known = new Map();
      for (const item of items) {
        const matches = await blockDB.getProposalSourceMatches(workspaceId, [item.id, item.source_ref], client);
        if (matches.length > 1) fail(409, "Source already has multiple task references; review before creating");
        const existing = matches[0];
        if (existing && existing.user_id !== userId) fail(404, "Source task unavailable");
        const suppression = triage.matchingSuppression(item, suppressions);
        if (suppression && !(suppression.reason === "scheduled" && existing && suppression.task_id === existing.id)) fail(409, "Source was already handled");
        known.set(item.id, existing);
      }
      const changed = new Set();
      const txDB = {
        ...blockDB,
        findByIdempotencyKey: (ws, key) => blockDB.findByIdempotencyKey(ws, key, client),
        findTaskByTriageSource: (ws, id, key) => blockDB.findTaskByTriageSource(ws, id, key, client),
        createItineraryTask: async options => {
          const row = await blockDB.createItineraryTask({ ...options, client });
          if (!row._resolvedExisting) changed.add(row.id);
          return row;
        },
        updateBlock: async (id, update) => { const row = await blockDB.updateBlock(id, update, client); changed.add(id); return row; },
      };
      // linkTriage is deliberately inert: this atomic path creates the durable task
      // directly, not a raw day-state row to suppress. No Slack sync callback.
      const materializer = createMaterializer({ blockDB: txDB, linkTriage: async () => {} });
      const tasks = [];
      for (const item of items) {
        let task = known.get(item.id);
        if (!task) {
          const projection = TaskModel.fromTriageItem(item);
          [task] = await materializer.materialize({ userId, workspaceId, items: [{
            ...projection, duration: projection.durMin, triageId: item.id, triageKey: triage.triageItemKey(item),
            triageType: item.type, triageTitle: item.title, triageSourceRef: item.source_ref,
            triageReceivedAt: item.received_at, triageConversationId: item.thread_id,
            triageContext: item,
          }], responsibilityIds: [] });
        }
        tasks.push(task);
      }
      const attached = await createDraftStore({ pool }).attachInTransaction({ userId, workspaceId, client,
        packet: { reply_drafts: tasks.map((task, index) => ({ task_id: task.id, triage_id: items[index].id,
          source_ref: items[index].source_ref, draft_preview: items[index].draft_preview })) } });
      attached.changedIds.forEach(id => changed.add(id));
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return { duplicate: changed.size === 0, taskIds: tasks.map(task => task.id), changedIds: [...changed], sourceIds: ids };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  return { capture };
};
module.exports.validate = validate;
