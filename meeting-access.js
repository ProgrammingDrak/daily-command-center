"use strict";

function belongsToWorkspace(block, workspaceId) {
  return Boolean(block && workspaceId && String(block.workspace_id) === String(workspaceId));
}

function remainingAccessSeconds(expiresAt, now = Date.now(), maximum = 600) {
  const expires = Date.parse(String(expiresAt || ""));
  if (!Number.isFinite(expires) || expires <= now) return 0;
  return Math.max(1, Math.min(maximum, Math.floor((expires - now) / 1000)));
}

module.exports = { belongsToWorkspace, remainingAccessSeconds };
