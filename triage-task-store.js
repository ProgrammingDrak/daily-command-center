"use strict";

const { normalizeTriageItem } = require("./public/js/slack-titles");
const crypto = require("node:crypto");
const { createMaterializeGuard } = require("./lib/materialize-guard");
const { taskCommonProps } = require("./public/js/task-serialize");

function slackCapture(item) {
  const context = item.triageContext || {};
  if (context.type !== "slack") return null;
  // Current Sweep packets have explicit coordinates. Older packets only have
  // the source ID and permalink, and still need the same bookmark identity.
  const idMatch = /:([CDG][A-Z0-9]+):(\d{10,}\.\d{1,6})$/.exec(String(context.id || item.triageId || ""));
  const linkMatch = /^https:\/\/[^/]+\.slack\.com\/archives\/([CDG][A-Z0-9]+)\/p(\d{11,16})(?:[?#]|$)/.exec(
    String(context.source_ref || item.triageSourceRef || ""));
  const channel = String(context.channel_id || (idMatch && idMatch[1]) || (linkMatch && linkMatch[1]) || "");
  const linkTs = linkMatch && `${linkMatch[2].slice(0, 10)}.${linkMatch[2].slice(10)}`;
  const ts = String(context.message_ts || (idMatch && idMatch[2]) || linkTs || "");
  if (!/^[CDG][A-Z0-9]+$/.test(channel) || !/^\d{10,}\.\d{1,6}$/.test(ts)) return null;
  const threadTs = String(context.thread_id || ts);
  return { channel, ts, threadTs: /^\d{10,}\.\d{1,6}$/.test(threadTs) ? threadTs : ts };
}

// Triage is a grouping of ordinary, durable tasks. Date-free rows remain visible
// until the standard task mover or completion path assigns them a day.
module.exports = function createTriageTaskStore({ blockDB, respStore, linkTriage }) {
  const guard = createMaterializeGuard({ blockDB });
  async function materialize({ items, responsibilityIds, userId, workspaceId, tz, onSlackTask }) {
    const blocks = [];
    for (const rawItem of items || []) {
      const item = normalizeTriageItem(rawItem);
      if (!item || !item.triageId || !String(item.title || "").trim()) continue;
      const identity = String(item.triageKey || item.triageId);
      const key = "triage-task:" + crypto.createHash("sha256").update(identity).digest("hex");
      const slack = slackCapture(item);
      const captureKey = slack ? `slack-bookmark:${slack.channel}:${slack.ts}` : key;
      let block = await guard.findForDedupe(workspaceId, { idempotencyKey: captureKey });
      if (!block && slack) block = await guard.findForDedupe(workspaceId, { idempotencyKey: key });
      if (!block && blockDB.findTaskByTriageSource) block = await blockDB.findTaskByTriageSource(workspaceId, item.triageId, item.triageKey);
      let syncSlackTask = false;
      if (!block) {
        block = await blockDB.createItineraryTask({
          date: null, userId, workspaceId, ensureRoot: false,
          properties: {
            ...taskCommonProps(item), kind: "task", type: "task",
            local_id: key, idempotency_key: captureKey,
            source: slack ? "slack-bookmark" : "triage",
            ...(slack ? { slack_channel: slack.channel, slack_ts: slack.ts, slack_thread_ts: slack.threadTs } : {}),
            triageBlock: true, publicVisibility: "private", status: "open",
            duration: Math.min(1440, Math.max(5, Number(item.duration) || 5)),
            start: null, end: null,
          },
        });
        syncSlackTask = !!slack;
      }
      if (slack && !block.deleted_at) {
        // A manual bookmark may already own this message. Attach its Triage link
        // instead of creating another task, while preserving the person's edits.
        // Older Triage tasks also gain the canonical reaction identity on replay.
        const props = block.properties || {};
        const next = {
          ...props,
          source: "slack-bookmark",
          idempotency_key: captureKey,
          slack_channel: slack.channel,
          slack_ts: slack.ts,
          slack_thread_ts: slack.threadTs,
          triageId: props.triageId || item.triageId,
          triageKey: props.triageKey || item.triageKey,
          triageType: props.triageType || "slack",
          triageSourceRef: props.triageSourceRef || item.triageSourceRef || "",
          triageContext: props.triageContext || item.triageContext,
        };
        if (JSON.stringify(next) !== JSON.stringify(props)) {
          block = await blockDB.updateBlock(block.id, { properties: next });
          syncSlackTask = true;
        }
      }
      // Retry the link after partial failures, but never reopen a completed or
      // deleted task simply because an older source packet still offers it.
      if (!block.deleted_at && block.properties.status !== "done") await linkTriage(block, "scheduled");
      if (syncSlackTask && !block.deleted_at && typeof onSlackTask === "function") await onSlackTask(block);
      blocks.push(block);
    }
    for (const id of responsibilityIds || []) {
      blocks.push(...await respStore.materializeTriageResponsibility({ id, userId, workspaceId, tz }));
    }
    return blocks;
  }
  return { materialize };
};
module.exports.slackCapture = slackCapture;
