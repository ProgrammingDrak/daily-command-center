// Own-task effort only. Shared by the completion preview and session writer.
(function (root) {
  'use strict';
  function minutes(seconds) { return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null; }
  function history(properties, sessions) {
    const seconds = (sessions || []).reduce((sum, row) => sum + Math.max(0, Number(row.properties?.durSec) || 0), 0);
    const saved = properties.actualMinutes == null ? null : Number(properties.actualMinutes);
    // Preserve measured/manual history that predates the ledger, as reallocation does.
    // Reconciler estimates are replaceable, not additional measured effort.
    const carryMinutes = properties.actualMinutesFrom === 'reconcile' ? 0 : Math.max(0, (saved || 0) - (minutes(seconds) || 0));
    return { seconds, carryMinutes, savedMinutes: Number.isFinite(saved) ? saved : null, estimated: properties.actualMinutesFrom === 'reconcile' };
  }
  function project(view, nowMs) {
    const h = view.history, start = view.startedMs;
    const active = Number.isFinite(start);
    const elapsedSeconds = active ? Math.max(0, Math.round((nowMs - start) / 1000)) : 0;
    const creditMs = active ? Math.max(0, Math.min(nowMs, view.creditUntilMs) - start) : 0;
    const creditSeconds = creditMs > 0 ? Math.max(1, Math.round(creditMs / 1000)) : 0;
    const projectedMinutes = active && creditSeconds > 0 ? (minutes(h.seconds + creditSeconds) || 0) + h.carryMinutes : h.savedMinutes;
    return { active, elapsedSeconds, creditSeconds, projectedMinutes, capped: active && nowMs > view.creditUntilMs };
  }
  const api = { minutes, history, project };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DCCWorkCompletion = api;
})(typeof window !== 'undefined' ? window : globalThis);
