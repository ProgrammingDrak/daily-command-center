const crypto = require("crypto");
const { DEFAULT_EVALUATION_SETTINGS } = require("./defaults");

const SETTINGS_KIND = "evaluation_settings";

async function findSettingsBlock(blockDB, workspaceId) {
  const blocks = await blockDB.getBlocksByTypes(["block"], workspaceId);
  return blocks.find(block => block.properties && block.properties.kind === SETTINGS_KIND) || null;
}

async function getSettings(blockDB, workspaceId) {
  const block = await findSettingsBlock(blockDB, workspaceId);
  if (!block) return { ...DEFAULT_EVALUATION_SETTINGS };
  return {
    ...DEFAULT_EVALUATION_SETTINGS,
    ...(block.properties.settings || {}),
  };
}

async function saveSettings(blockDB, workspaceId, userId, settings) {
  const block = await findSettingsBlock(blockDB, workspaceId);
  const properties = {
    kind: SETTINGS_KIND,
    settings: {
      ...DEFAULT_EVALUATION_SETTINGS,
      ...(settings || {}),
    },
  };
  if (block) {
    return blockDB.updateBlock(block.id, { properties });
  }
  return blockDB.createBlock({
    id: crypto.randomUUID(),
    type: "block",
    properties,
    sort_order: Date.now(),
    user_id: userId || null,
    workspace_id: workspaceId || null,
  });
}

async function deleteSettings(blockDB, workspaceId) {
  const block = await findSettingsBlock(blockDB, workspaceId);
  if (!block) return { ok: true, deleted: false };
  await blockDB.deleteBlock(block.id);
  return { ok: true, deleted: true };
}

module.exports = {
  getSettings,
  saveSettings,
  deleteSettings,
};
