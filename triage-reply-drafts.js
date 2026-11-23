"use strict";

// Opt-in attachment to an EXISTING private Triage task. No source collection,
// task creation, day-state replacement, native draft creation or sending.
const TaskModel = require("./public/js/task-model");
const TimeBlocks = require("./public/js/time-blocks");
const EXCLUDED_SLACK = new Set(["C0A2YDUD4N5", "C08KRSS69MH"]);
function fail(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }
function validate(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet) ||
      Object.keys(packet).some(key => !["id", "reply_drafts"].includes(key))) fail(400, "Reply drafts cannot be mixed with other intake fields");
  if (packet.id != null && (typeof packet.id !== "string" || !packet.id.trim() || packet.id.length > 500)) fail(400, "Invalid reply packet id");
  const drafts = packet.reply_drafts;
  if (!Array.isArray(drafts) || drafts.length < 1 || drafts.length > 10) fail(400, "Expected one to ten reply drafts");
  const seen = new Set();
  for (const draft of drafts) {
    const keys = ["task_id", "triage_id", "source_ref", "draft_preview"];
    if (!draft || typeof draft !== "object" || Array.isArray(draft) || Object.keys(draft).length !== keys.length ||
        keys.some(key => typeof draft[key] !== "string" || !draft[key].trim()) || Object.keys(draft).some(key => !keys.includes(key))) fail(400, "Invalid reply draft shape");
    if (draft.task_id.length > 200 || draft.triage_id.length > 500 || draft.source_ref.length > 500 ||
        draft.draft_preview.length > 1000 || Array.from(draft.draft_preview).some(char => { const code = char.charCodeAt(0); return (code < 32 && ![9, 10, 13].includes(code)) || code === 127; })) fail(400, "Invalid reply draft length or control characters");
    const slack = /^https:\/\/cleverrealestate\.slack\.com\/archives\/([CDG][A-Z0-9]+)\/p[0-9]{16}$/.exec(draft.source_ref);
    const gmail = /^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/[a-f0-9]+$/.test(draft.source_ref);
    if ((!slack && !gmail) || (slack && EXCLUDED_SLACK.has(slack[1]))) fail(400, "Unsupported or excluded reply source");
    const slackId = /^slack:(?:dm|mention):([CDG][A-Z0-9]+):(\d{10}\.\d{6})$/.exec(draft.triage_id);
    const gmailId = /^gmail:([a-f0-9]+):[a-f0-9]+$/.exec(draft.triage_id);
    if ((slackId && draft.source_ref !== `https://cleverrealestate.slack.com/archives/${slackId[1]}/p${slackId[2].replace(".", "")}`) ||
        (gmailId && draft.source_ref !== `https://mail.google.com/mail/u/0/#all/${gmailId[1]}`)) fail(400, "Reply source coordinates disagree");
    if (seen.has(draft.task_id)) fail(400, "Duplicate reply task");
    seen.add(draft.task_id);
  }
  return drafts;
}

module.exports = function createTriageReplyDraftStore({ pool }) {
  async function attach({ packet, userId, workspaceId, dryRun = false }) {
    const drafts = validate(packet);
    if (!Number.isInteger(userId) || userId < 1 || !workspaceId) fail(403, "Reply draft owner required");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT * FROM blocks WHERE id=ANY($1::text[]) AND workspace_id=$2 AND user_id=$3 ORDER BY id FOR UPDATE",
        [drafts.map(draft => draft.task_id), workspaceId, userId]);
      const changes = [];
      for (const draft of drafts) {
        const row = rows.find(value => value.id === draft.task_id);
        if (!row || row.deleted_at) fail(404, "Open private Triage task not found");
        const props = row.properties || {}, context = props.triageContext || {};
        if (row.type !== "block" || props.kind !== "task" || row.date != null || !props.triageBlock || props.publicVisibility !== "private" ||
            props.done || props.completedAt || ["done", "completed", "deleted", "cancelled"].includes(props.status)) fail(409, "Task is no longer open in private Triage");
        const groups = TimeBlocks.groupItineraryTree([{ ev: TaskModel.fromBlock(row), depth: 0 }], []);
        if (!groups.find(group => group.block.id === TimeBlocks.TRIAGE_BLOCK.id).nodes.length) fail(409, "Task is outside the Triage lane");
        const source = props.triageSourceRef || context.source_ref || context.source_url || context.link || props.source_id;
        if (props.triageId !== draft.triage_id || source !== draft.source_ref) fail(409, "Reply source does not match the task");
        const prior = [context, props].filter(value => value.draft_preview || value.draft_id || value.draft_link || value.draft_url);
        if (prior.length) {
          if (prior.some(value => value.draft_preview !== draft.draft_preview)) fail(409, "Existing draft preserved; review it before replacing");
          continue;
        }
        changes.push({ id: row.id, context: { ...context, id: props.triageId, source_ref: source,
          draft_preview: draft.draft_preview, draft_type: "internal", draft_status: "drafted" } });
      }
      for (const change of changes) {
        await client.query("UPDATE blocks SET properties=jsonb_set(properties,'{triageContext}',$1::jsonb),updated_at=NOW() WHERE id=$2 AND workspace_id=$3",
          [JSON.stringify(change.context), change.id, workspaceId]);
      }
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return { duplicate: changes.length === 0, taskIds: drafts.map(draft => draft.task_id), changedIds: changes.map(change => change.id) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  return { attach };
};
module.exports.validate = validate;
