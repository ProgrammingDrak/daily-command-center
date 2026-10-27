// Shared unattended-work cutoff for the dock and atomic task switches.
(function (root) {
  "use strict";
  function checkInState(task, nowMs) {
    nowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    var startedMs = Date.parse((task && task.startedAt) || "");
    if (!Number.isFinite(startedMs)) return { active: false, due: false, shouldAutoPause: false };
    var acknowledgedMs = Date.parse((task && task.workCheckInAt) || "");
    var anchorMs = Number.isFinite(acknowledgedMs) && acknowledgedMs >= startedMs && acknowledgedMs <= nowMs
      ? acknowledgedMs : startedMs;
    var cadenceMs = 25 * 60_000;
    var hardStopAtMs = startedMs + (8 * 60) * 60_000;
    var missed = Math.max(0, Math.floor((nowMs - anchorMs) / cadenceMs));
    var autoPauseAtMs = Math.min(anchorMs + 2 * cadenceMs, hardStopAtMs);
    var shouldAutoPause = nowMs >= autoPauseAtMs;
    return {
      active: true, due: missed >= 1 && !shouldAutoPause,
      missed: Math.min(missed, 2), anchorMs: anchorMs,
      nextCheckInAtMs: anchorMs + cadenceMs, autoPauseAtMs: autoPauseAtMs,
      hardStopAtMs: hardStopAtMs, shouldAutoPause: shouldAutoPause,
    };
  }
  var api = { checkInState: checkInState, CHECK_IN_MINUTES: 25, MISSED_CHECK_IN_LIMIT: 2, MAX_SESSION_MINUTES: 8 * 60 };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DCCWorkCheckInPolicy = api;
})(typeof window !== "undefined" ? window : globalThis);
