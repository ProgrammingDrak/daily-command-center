"use strict";

// Storage authority is passed as an internal symbol, never a serialized client field.
const CAPTURE = Symbol("verified sweep capture");
const DISMISS = Symbol("owner dismisses sweep triage");
const QUEUE = Symbol("owner moves sweep task to working queue");
const FIELD = "sweepTriage";
async function authenticate(authorization, verifyToken, env = process.env) {
  const token = String(authorization || "").match(/^Bearer (.+)$/)?.[1];
  if (!token || token === env.SECRET_DCC_TOKEN || token === env.SECRET_PA_TOKEN ||
      (token !== env.SECRET_SWEEP_SUITE_TOKEN && !await verifyToken(token, "sweep", {exact:true}))) {
    throw Object.assign(new Error("Dedicated Sweep service authentication required"), {statusCode:403});
  }
  const userId = Number(env.DCC_SERVICE_USER_ID || 0), workspaceId = env.DCC_SERVICE_WORKSPACE_ID;
  if (!Number.isInteger(userId) || userId < 1 || !workspaceId)
    throw Object.assign(new Error("Sweep task owner is not configured"), {statusCode:503});
  return {userId, workspaceId, source:"verified-sweep-capture"};
}

function state(props) {
  const value = props?.[FIELD];
  return value?.origin === "automated_sweep" ? value : null;
}
function terminal(props) {
  return !!(props?.done || props?.completed || props?.completedAt ||
    ["done", "completed", "deleted", "archived", "cancelled"].includes(props?.status));
}
function create(props, authority) {
  delete props[FIELD];
  if (authority) props[FIELD] = { origin:"automated_sweep", disposition:"pending", runId:authority.runId };
}
function reconcile(before, next, { date, parentId, reason } = {}) {
  const prior = state(before);
  if (!prior && !Object.hasOwn(next, FIELD)) return next;
  next = { ...next };
  if (!prior) { delete next[FIELD]; return next; }
  let disposition = prior.disposition;
  if (disposition === "pending") {
    if (reason === "dismissed") disposition = "dismissed";
    else if (terminal(before) || terminal(next)) disposition = "completed";
    else if (reason === "queued" || date || parentId || next.subtaskOf || next.wrapId ||
             next.stage || next.start || next.end || next.startedAt || next.delegatedItemId || next.dependencyWaitingItemId ||
             next.dependencyWaitingItemIds?.length || next.publicVisibility !== "private") disposition = "promoted";
  }
  next[FIELD] = { ...prior, disposition };
  return next;
}
module.exports = { CAPTURE, DISMISS, QUEUE, FIELD, state, terminal, create, reconcile, authenticate };
