"use strict";

const crypto = require("node:crypto");
const { createMaterializeGuard } = require("./lib/materialize-guard");
const { taskCommonProps } = require("./public/js/task-serialize");

// Triage is a grouping of ordinary, durable tasks. Date-free rows remain visible
// until the standard task mover or completion path assigns them a day.
module.exports = function createTriageTaskStore({ blockDB, respStore, linkTriage }) {
  const guard = createMaterializeGuard({ blockDB });
  async function materialize({ items, responsibilityIds, userId, workspaceId, tz }) {
    const blocks = [];
    for (const item of items || []) {
      if (!item || !item.triageId || !String(item.title || "").trim()) continue;
      const identity = String(item.triageKey || item.triageId);
      const key = "triage-task:" + crypto.createHash("sha256").update(identity).digest("hex");
      let block = await guard.findForDedupe(workspaceId, { idempotencyKey: key });
      if (!block && blockDB.findTaskByTriageSource) block = await blockDB.findTaskByTriageSource(workspaceId, item.triageId, item.triageKey);
      if (!block) {
        block = await blockDB.createItineraryTask({
          date: null, userId, workspaceId, ensureRoot: false,
          properties: {
            ...taskCommonProps(item), kind: "task", type: "task",
            local_id: key, idempotency_key: key, source: "triage",
            triageBlock: true, publicVisibility: "private", status: "open",
            duration: Math.min(1440, Math.max(5, Number(item.duration) || 5)),
            start: null, end: null,
          },
        });
      }
      // Retry the link after partial failures, but never reopen a completed or
      // deleted task simply because an older source packet still offers it.
      if (!block.deleted_at && block.properties.status !== "done") await linkTriage(block, "scheduled");
      blocks.push(block);
    }
    for (const id of responsibilityIds || []) {
      blocks.push(...await respStore.materializeTriageResponsibility({ id, userId, workspaceId, tz }));
    }
    return blocks;
  }
  return { materialize };
};
