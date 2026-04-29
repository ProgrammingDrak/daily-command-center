/**
 * evaluation/settings-store.js
 *
 * One evaluation-settings record per workspace. Stored as a regular `block`
 * with properties.kind = "evaluation_settings", mirroring the delegated_items
 * pattern so we don't touch the DB schema or VALID_TYPES.
 *
 * The store deep-merges user settings on top of DEFAULT_SETTINGS so partial
 * updates work and new fields added later get sensible defaults retroactively.
 */

const pool = require("../pg-pool");
const blockDB = require("../db");
const { DEFAULT_SETTINGS } = require("./defaults");

const KIND = "evaluation_settings";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Recursive merge for nested settings (multipliers, padding, rates).
// Arrays and primitives in `override` replace whatever's in `base`.
function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

async function findSettingsBlock(workspaceId) {
  const { rows } = await pool.query(
    `SELECT * FROM blocks
     WHERE type = 'block'
       AND properties->>'kind' = $1
       AND workspace_id = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [KIND, workspaceId]
  );
  if (!rows[0]) return null;
  const props =
    typeof rows[0].properties === "string"
      ? JSON.parse(rows[0].properties)
      : rows[0].properties;
  return { id: rows[0].id, properties: props || {} };
}

/**
 * Returns merged settings (defaults ⊕ user overrides). Never returns null.
 * If the user has never written settings, this is just DEFAULT_SETTINGS.
 */
async function getSettings(workspaceId) {
  const block = await findSettingsBlock(workspaceId);
  if (!block) return { ...DEFAULT_SETTINGS, _source: "defaults" };
  // Drop the kind discriminator before merging — it's storage metadata, not config.
  const { kind, ...userOverrides } = block.properties;
  return { ...deepMerge(DEFAULT_SETTINGS, userOverrides), _source: "user", _block_id: block.id };
}

/**
 * Updates settings via deep merge with what's already stored. Creates the
 * settings block on first write. Returns the merged-with-defaults result.
 */
async function updateSettings(workspaceId, userId, patch) {
  if (!isPlainObject(patch)) {
    throw new Error("Settings patch must be an object");
  }
  // Strip protected fields the client cannot set
  const { kind: _kind, _source, _block_id, ...clean } = patch;

  const existing = await findSettingsBlock(workspaceId);
  if (!existing) {
    await blockDB.createBlock({
      type: "block",
      parent_id: null,
      date: null,
      properties: { kind: KIND, ...clean },
      sort_order: 0,
      user_id: userId || null,
      workspace_id: workspaceId,
    });
  } else {
    const { kind: existingKind, ...existingProps } = existing.properties;
    const merged = deepMerge(existingProps, clean);
    await blockDB.updateBlock(existing.id, {
      properties: { kind: KIND, ...merged },
    });
  }
  return getSettings(workspaceId);
}

/**
 * Resets settings to defaults by deleting the user's overrides block.
 * Idempotent — silently no-ops if there's nothing to delete.
 */
async function resetSettings(workspaceId) {
  const existing = await findSettingsBlock(workspaceId);
  if (existing) await blockDB.deleteBlock(existing.id);
  return getSettings(workspaceId);
}

module.exports = { getSettings, updateSettings, resetSettings, KIND };
