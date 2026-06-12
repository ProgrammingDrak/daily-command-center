// ======== SHARED URGENCY HELPER ========
// Canonical time-decay/urgency math shared by repeat responsibilities and
// blocked ("waiting on") items. A value creeps up linearly from 0 toward 100
// over a cadence window measured since an anchor timestamp, and crosses
// green -> blue -> yellow -> red thresholds as it climbs.
//
// Keep this the single source of the formula (per "same function = same code").
// responsibilities.js and delegated.js both consume window.urgency so their
// scores/colors/meters stay identical for the same elapsed/cadence.
(function(){
  // Days elapsed / cadence, plus a clamped 0-100 progress and days remaining.
  // cadenceDays: interval in days. anchorIso: ISO timestamp the window started
  // (last completion / last check-in, falling back to creation). now: optional
  // Date or epoch-ms override for testing.
  function timing(cadenceDays, anchorIso, now){
    const cadence = Math.max(1, Number(cadenceDays || 7));
    const start = anchorIso ? new Date(anchorIso) : new Date();
    const nowMs = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
    const elapsed = isNaN(start.getTime()) ? 0 : Math.max(0, (nowMs - start.getTime()) / 86400000);
    const remaining = Math.ceil(cadence - elapsed);
    const progress = Math.max(0, Math.min(100, Math.round((elapsed / cadence) * 100)));
    return { cadence, elapsed, remaining, progress };
  }

  // The 0-100 urgency score (clamped). Same value as timing().progress; exposed
  // separately so callers reading "score" read intent, not a meter width.
  function score(cadenceDays, anchorIso, now){
    return timing(cadenceDays, anchorIso, now).progress;
  }

  // Map a 0-100 score to a color class. Thresholds match the original
  // responsibilities scoreClass exactly (35 / 70 / 85).
  function scoreClass(value){
    const s = Number(value) || 0;
    if (s >= 85) return "red";
    if (s >= 70) return "yellow";
    if (s >= 35) return "blue";
    return "green";
  }

  window.urgency = { timing, score, scoreClass };
})();
