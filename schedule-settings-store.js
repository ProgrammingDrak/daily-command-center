/**
 * schedule-settings-store.js
 *
 * One schedule-settings record per workspace. Stored as a regular `block` with
 * properties.kind = "schedule_settings", mirroring evaluation/settings-store.js
 * so we don't touch pg-schema.js or db.js VALID_TYPES.
 *
 * Holds ONE thing today: `dayStart`, the user's start of day. It is the floor
 * every auto-placement path clamps against (see public/js/day-context.js
 * dayStartMinutes for the contract and why the value is capped at noon).
 *
 * Workspace-scoped, not user-scoped, because that is the scope the schedulers
 * actually hold: getScheduleBlocks, loadDaySlottingContext and buildDayResponse
 * are all keyed by workspace_id, service-token automations carry a workspaceId
 * with no userId, and buildDayResponse is reached anonymously by the public
 * share as buildDayResponse(date, null, workspace_id). Each user has exactly one
 * workspace (ws-<userId>), so workspace-scoped IS per-user here.
 *
 * Format and policy live in ONE place, day-context.js normalizeDayStart, so the
 * store, the route and the slot engines cannot disagree about what is legal.
 *
 * Known hole, inherited from evaluation/settings-store.js: nothing prevents two
 * concurrent first-writes creating two rows. The reader takes the oldest, so the
 * later write would be silently lost. resetScheduleSettings also soft-deletes,
 * so reset -> re-set accumulates tombstones. Both are acceptable at one
 * settings row per workspace edited by one person from one dialog.
 */

const blockDB = require("./db");
const { normalizeDayStart, DAY_START_DEFAULT } = require("./public/js/day-context");

const KIND = "schedule_settings";

// getBlocksByKind (db.js) already runs exactly this query and parses properties.
// Reusing it keeps one spelling of the kind lookup and, unlike a raw pool.query,
// leaves the store injectable for tests.
async function findSettingsBlock(workspaceId, deps) {
  const db = (deps && deps.blockDB) || blockDB;
  if (!db || typeof db.getBlocksByKind !== "function") return null;
  const rows = await db.getBlocksByKind(KIND, workspaceId);
  return rows && rows[0] ? rows[0] : null;
}

/**
 * Returns merged settings (defaults + user override). Never returns null and
 * never throws on a malformed stored value — an unreadable dayStart reads as
 * the default, because a broken settings row must not brick auto-placement.
 */
async function getScheduleSettings(workspaceId, deps) {
  const block = await findSettingsBlock(workspaceId, deps);
  const stored = block && block.properties ? normalizeDayStart(block.properties.dayStart) : null;
  return {
    dayStart: stored || DAY_START_DEFAULT,
    _source: stored ? "user" : "defaults",
    _block_id: block ? block.id : null,
  };
}

/** Minutes-from-midnight form, for the server-side slot engine. */
async function getDayStartMinutes(workspaceId, deps) {
  const { dayStart } = await getScheduleSettings(workspaceId, deps);
  const [h, m] = dayStart.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Writes dayStart. Creates the settings block on first write. Throws on an
 * illegal value so the route can answer 400 rather than persisting garbage.
 */
async function updateScheduleSettings(workspaceId, userId, patch, deps) {
  const db = (deps && deps.blockDB) || blockDB;
  const next = normalizeDayStart(patch && patch.dayStart);
  if (!next) {
    throw new Error('Invalid dayStart (want "HH:MM", 00:00 through 12:00)');
  }
  const existing = await findSettingsBlock(workspaceId, deps);
  if (!existing) {
    await db.createBlock({
      type: "block",
      parent_id: null,
      date: null,
      properties: { kind: KIND, dayStart: next },
      sort_order: 0,
      user_id: userId || null,
      workspace_id: workspaceId,
    });
  } else {
    await db.updateBlock(existing.id, {
      properties: { ...(existing.properties || {}), kind: KIND, dayStart: next },
    });
  }
  return getScheduleSettings(workspaceId, deps);
}

/** Resets to the default by deleting the override block. Idempotent. */
async function resetScheduleSettings(workspaceId, deps) {
  const db = (deps && deps.blockDB) || blockDB;
  const existing = await findSettingsBlock(workspaceId, deps);
  if (existing) await db.deleteBlock(existing.id);
  return getScheduleSettings(workspaceId, deps);
}

module.exports = {
  getScheduleSettings,
  getDayStartMinutes,
  updateScheduleSettings,
  resetScheduleSettings,
  KIND,
};
