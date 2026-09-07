// Pure conflict-resolution helpers for completion and reschedule intents.
// Browser writes may arrive late, twice, or out of order after reconnecting.
// Newest-per-task intent wins, making every mutation replay-safe and idempotent.

function validVersion(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normalizeDoneState(value) {
  const source = value && typeof value === "object" ? value : {};
  const ids = Array.isArray(source.ids) ? source.ids.filter(Boolean).map(String) : [];
  const at = source.at && typeof source.at === "object" ? { ...source.at } : {};
  const mutations = source.mutations && typeof source.mutations === "object" ? { ...source.mutations } : {};
  return { ids: [...new Set(ids)], at, mutations };
}

function applyCompletionChanges(value, changes) {
  const state = normalizeDoneState(value);
  const ids = new Set(state.ids);
  let applied = 0;

  for (const change of Array.isArray(changes) ? changes : []) {
    const id = change && change.id != null ? String(change.id) : "";
    const version = validVersion(change && change.version);
    if (!id || !version) continue;
    const previousVersion = validVersion(state.mutations[id]) || 0;
    if (version <= previousVersion) continue;

    state.mutations[id] = version;
    if (change.completed) {
      ids.add(id);
      state.at[id] = change.completedAt || new Date(version).toISOString();
    } else {
      ids.delete(id);
      delete state.at[id];
    }
    applied++;
  }

  state.ids = [...ids];
  return { state, applied };
}

function compareMutationVersion(current, incoming) {
  const currentVersion = validVersion(current) || 0;
  const incomingVersion = validVersion(incoming);
  if (!incomingVersion) return "invalid";
  if (incomingVersion < currentVersion) return "stale";
  if (incomingVersion === currentVersion) return "duplicate";
  return "new";
}

module.exports = { applyCompletionChanges, compareMutationVersion, normalizeDoneState, validVersion };
