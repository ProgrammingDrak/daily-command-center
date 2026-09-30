"use strict";
// Native source identity is date-independent; handled rows include tombstones.
function sourceIds(item) {
  return [...new Set([item && item.id, item && item.source_item_id, item && item.source_id,
    item && item.source_ref].filter(value => typeof value === "string" && value.trim()))];
}
function sourceKeys(ids) {
  const keys = new Set(ids);
  for (const id of ids) {
    const match = /^slack:(?:dm|mention):([CDG][A-Z0-9]+):(\d{10}\.\d{1,6})$/.exec(id);
    if (match) keys.add(`slack-bookmark:${match[1]}:${match[2]}`);
  }
  return [...keys];
}
function keepExisting(existing, incoming, suppressed = []) {
  const blocked = new Set(suppressed);
  const kept = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    if (!item || !item.id || sourceIds(item).some(id => blocked.has(id))) continue;
    const key = item.source_item_id || item.id;
    if (!kept.has(key)) kept.set(key, item);
  }
  return [...kept.values()];
}
module.exports = { sourceIds, sourceKeys, keepExisting };
