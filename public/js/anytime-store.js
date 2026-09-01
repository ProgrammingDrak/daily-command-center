// anytime-store.js — the Anytime model: work with no time inside it.
//
// An "anytime task" is a TARGET COUNT INSIDE A REPEATING WINDOW. "Drink 3
// bottles of water" is target 3 in a window of one day. "100 pushups every hour"
// is target 1 in a window of 60 minutes. Nothing about it names a minute, which
// is why none of the existing lanes fit: the backlog has no reset, a
// responsibility resets on a day cadence at the fastest and materializes a dated
// row, and a scheduled repeat turns every occurrence into a timed task you must
// do at that exact minute.
//
// TWO STORES, ON PURPOSE:
//   1. The DEFINITION is one dateless `type:"block"` row (kind "anytime_item").
//      It is the durable thing: title, target, window length, nudge cadence.
//   2. TODAY'S COUNTERS live on the day_root's properties under `_anytime`.
//      Day-scoped state belongs to the day, exactly like `_trivialFlags`. It
//      resets for free when the day rolls (a new day is a new root) and it is
//      server-side, so a second device sees the same counts.
//
// STREAKS ARE DERIVED, NEVER STORED. `history[date]` is RECOMPUTED from the day
// root on every check and every window close, so two devices closing the same
// window write the same numbers and a replay is a no-op. `streakFrom` then reads
// that rollup. Nothing accumulates that a bug could corrupt permanently.
//
// WINDOWS ALIGN TO THE USER'S DAY START, not UTC midnight, so "every hour"
// tracks the day Drake actually keeps. `periodMinutes` is forced to a DIVISOR of
// 1440: that guarantees the wrap-around window key (a window that began before
// day start) can never collide with another window's key on the same day.
//
// This module is pure below the `// ── browser only ──` line. Everything above
// takes an injected clock and plain objects, so anytime-model.test.js exercises
// the whole model with no DOM (the lib/recurrence.js discipline).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.DCC = root.DCC || {};
    root.DCC.Anytime = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const KIND = "anytime_item";
  const DAY_PERIOD = 1440;
  const HISTORY_DAYS = 30;
  const DAY_KEY = "day";
  const MS_PER_MIN = 60000;

  // Offered in the UI. Every one divides 1440 (see the header note on key
  // collisions); `normalizeDef` enforces the divisor rule for hand-written values.
  const PERIOD_CHOICES = [DAY_PERIOD, 720, 480, 360, 240, 180, 120, 90, 60, 30];

  // ── small helpers ──

  // Number(null) and Number("") are BOTH 0, not NaN, so a missing field would
  // sail past a bare Number.isFinite check and become a real zero. A
  // `periodMinutes: null` row then snapped to a ONE MINUTE window.
  function num(v, def) {
    if (v === null || v === undefined || v === "") return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
  function clampInt(v, lo, hi, def) {
    const n = Math.round(num(v, def));
    return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : def));
  }
  function hhmm(minutes) {
    const m = ((Math.round(minutes) % DAY_PERIOD) + DAY_PERIOD) % DAY_PERIOD;
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  }
  function toMinutes(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    const mins = Number(m[1]) * 60 + Number(m[2]);
    return mins >= 0 && mins < DAY_PERIOD ? mins : null;
  }
  // The largest divisor of 1440 that is <= the requested span, so a bogus 100
  // becomes 90 rather than silently colliding window keys.
  function snapPeriod(v) {
    const want = clampInt(v, 1, DAY_PERIOD, DAY_PERIOD);
    if (DAY_PERIOD % want === 0) return want;
    for (let n = want; n >= 1; n--) if (DAY_PERIOD % n === 0) return n;
    return DAY_PERIOD;
  }

  // ── definitions ──

  // A stored block (or a bare properties bag) into the shape every consumer
  // reads. Never throws: a half-written row degrades to a sane daily item.
  function normalizeDef(block) {
    const b = block || {};
    const p = b.properties || b || {};
    const period = snapPeriod(p.periodMinutes);
    const days = Array.isArray(p.activeDays)
      ? p.activeDays.map(d => clampInt(d, 0, 6, 0)).filter((d, i, a) => a.indexOf(d) === i).sort()
      : [];
    return {
      id: b.id || p.id || "",
      kind: KIND,
      title: String(p.title == null ? "" : p.title).trim(),
      icon: String(p.icon == null ? "" : p.icon).trim().slice(0, 4),
      unit: String(p.unit == null ? "" : p.unit).trim().slice(0, 24),
      target: clampInt(p.target, 1, 99, 1),
      periodMinutes: period,
      // null means "never nudge"; 0 and junk mean the same thing.
      nudgeEveryMin: p.nudgeEveryMin == null || num(p.nudgeEveryMin, 0) <= 0
        ? null : clampInt(p.nudgeEveryMin, 1, DAY_PERIOD, 60),
      activeFrom: toMinutes(p.activeFrom),
      activeUntil: toMinutes(p.activeUntil),
      activeDays: days,
      status: p.status === "archived" ? "archived" : "active",
      history: (p.history && typeof p.history === "object") ? p.history : {},
      sortOrder: num(b.sort_order, 0)
    };
  }

  function isDaily(def) { return def.periodMinutes >= DAY_PERIOD; }

  // ── windows ──

  // Minutes-since-midnight at which the window containing `minutesOfDay` began.
  // Math.floor handles the before-day-start case correctly (a 03:00 tick with a
  // 07:00 day start lands on a window that began the previous evening), and the
  // hhmm() wrap turns that into an honest same-shape key.
  function windowStartMinutes(def, minutesOfDay, dayStartMin) {
    const start = clampInt(dayStartMin, 0, DAY_PERIOD - 1, 0);
    if (isDaily(def)) return start;
    const span = def.periodMinutes;
    const offset = minutesOfDay - start;
    return start + Math.floor(offset / span) * span;
  }

  function windowKeyFor(def, minutesOfDay, dayStartMin) {
    if (isDaily(def)) return DAY_KEY;
    return hhmm(windowStartMinutes(def, minutesOfDay, dayStartMin));
  }

  // Wall-clock ms at which the current window began. A window whose start wraps
  // past `minutesOfDay` began yesterday, so it is pulled back a full day —
  // without that, `nudgeDue`'s max() anchor would sit in the FUTURE and suppress
  // every nudge for that window.
  function windowStartMs(def, ctx) {
    const startMin = windowStartMinutes(def, ctx.minutesOfDay, ctx.dayStartMin);
    let ms = ctx.midnightMs + startMin * MS_PER_MIN;
    // Only a SUB-DAY window can have begun yesterday. A daily window is today's
    // by definition, and letting its start sit in the future is correct: before
    // the day has started, nothing is owed yet.
    if (!isDaily(def) && startMin > ctx.minutesOfDay) ms -= DAY_PERIOD * MS_PER_MIN;
    return ms;
  }

  // The minute the current window hands over, for the "resets 3:00" label.
  function windowResetMinutes(def, minutesOfDay, dayStartMin) {
    if (isDaily(def)) return null;
    return windowStartMinutes(def, minutesOfDay, dayStartMin) + def.periodMinutes;
  }

  // ── active hours ──

  // Quiet hours and days off. An inactive window is never seeded, so it can
  // never be recorded as a miss — nobody owes the pet a 3am bottle of water.
  function isActiveAt(def, minutesOfDay, dowIndex) {
    if (def.status !== "active") return false;
    if (def.activeDays.length && def.activeDays.indexOf(dowIndex) === -1) return false;
    const from = def.activeFrom, until = def.activeUntil;
    if (from == null && until == null) return true;
    if (from != null && until == null) return minutesOfDay >= from;
    if (from == null && until != null) return minutesOfDay < until;
    // from > until is an overnight window (22:00 to 02:00).
    return from <= until
      ? (minutesOfDay >= from && minutesOfDay < until)
      : (minutesOfDay >= from || minutesOfDay < until);
  }

  // ── per-day entries ──

  function blankEntry() { return { w: {}, closed: [], lastNudgeAt: null, lastWindowKey: null }; }

  function readEntry(state, defId) {
    const raw = (state && state[defId]) || null;
    if (!raw) return blankEntry();
    return {
      w: (raw.w && typeof raw.w === "object") ? { ...raw.w } : {},
      closed: Array.isArray(raw.closed) ? raw.closed.slice() : [],
      lastNudgeAt: raw.lastNudgeAt || null,
      lastWindowKey: raw.lastWindowKey || null
    };
  }

  function countIn(entry, windowKey) {
    return Math.max(0, num(entry.w[windowKey], 0));
  }

  function progressFor(def, entry, windowKey) {
    const n = countIn(entry, windowKey);
    const target = def.target;
    return { n: n, target: target, done: n >= target, remaining: Math.max(0, target - n) };
  }

  // ── history rollup ──

  // Today's rollup, recomputed from scratch every time. `closed` counts the
  // windows that have finished; the window still running is deliberately absent,
  // so a day in progress never looks like a failure.
  //
  // A daily item is one window that stays open all day, so it reports itself as
  // closed immediately. That is safe because `streakFrom` only ever reads days
  // BEFORE today, and by then the number is final.
  function rollupForDay(def, entry) {
    if (isDaily(def)) {
      return { hit: countIn(entry, DAY_KEY) >= def.target ? 1 : 0, closed: 1 };
    }
    const closed = entry.closed.filter(k => Object.prototype.hasOwnProperty.call(entry.w, k));
    return {
      hit: closed.filter(k => countIn(entry, k) >= def.target).length,
      closed: closed.length
    };
  }

  function trimHistory(history) {
    const keys = Object.keys(history).sort();
    if (keys.length <= HISTORY_DAYS) return history;
    const out = {};
    keys.slice(keys.length - HISTORY_DAYS).forEach(k => { out[k] = history[k]; });
    return out;
  }

  // Close every window that is no longer the current one, then restate today's
  // rollup. Idempotent: a key already in `closed` is skipped, so a second device
  // (or a second tick) running this changes nothing.
  //
  // Returns NEW objects; callers decide whether anything is worth persisting by
  // reading `changed`.
  function closeStaleWindows(def, entry, currentWindowKey, todayStr) {
    const next = readEntry({ x: entry }, "x");
    const missed = [];
    let changed = false;

    Object.keys(next.w).forEach(k => {
      if (k === currentWindowKey) return;
      if (next.closed.indexOf(k) !== -1) return;
      next.closed.push(k);
      changed = true;
      if (countIn(next, k) < def.target) missed.push(k);
    });

    // A window handover resets the nudge clock: the new window has not been
    // nudged, and carrying the old stamp forward would delay its first nudge.
    if (next.lastWindowKey !== currentWindowKey) {
      next.lastWindowKey = currentWindowKey;
      next.lastNudgeAt = null;
      changed = true;
    }

    const rollup = rollupForDay(def, next);
    const prev = def.history[todayStr];
    const historyChanged = !prev || prev.hit !== rollup.hit || prev.closed !== rollup.closed;
    const history = historyChanged
      ? trimHistory({ ...def.history, [todayStr]: rollup })
      : def.history;

    return { entry: next, history: history, missed: missed, changed: changed || historyChanged };
  }

  // ── streaks ──

  // Consecutive fully-hit days BEFORE today, stopping at the first gap. Mirrors
  // schedule-tab.js `_habitStreakCount` so the two streak chips in the app mean
  // the same thing. Today is excluded because it is still in progress.
  function streakFrom(history, todayStr) {
    if (!history || !todayStr) return 0;
    let n = 0;
    let cursor = shiftDate(todayStr, -1);
    for (let guard = 0; guard < HISTORY_DAYS + 1; guard++) {
      const row = history[cursor];
      if (!row || !(row.closed > 0) || !(row.hit >= row.closed)) break;
      n++;
      cursor = shiftDate(cursor, -1);
    }
    return n;
  }

  // UTC-noon anchor, matching DCC.dates.addDays, so DST never eats a day.
  function shiftDate(dateStr, delta) {
    const d = new Date(String(dateStr) + "T12:00:00Z");
    if (Number.isNaN(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  // ── nudges ──

  // `ctx`: {nowMs, midnightMs, minutesOfDay, dayStartMin, dowIndex}
  function nudgeDue(def, entry, ctx) {
    if (!def.nudgeEveryMin) return false;
    if (!isActiveAt(def, ctx.minutesOfDay, ctx.dowIndex)) return false;
    const key = windowKeyFor(def, ctx.minutesOfDay, ctx.dayStartMin);
    if (countIn(entry, key) >= def.target) return false;
    // Anchor on the LATER of "this window opened" and "we last nudged". The
    // window floor is what stops a fresh window from nudging on its first tick;
    // the stamp is what stops the same window nudging every tick after that.
    const stamped = entry.lastNudgeAt ? Date.parse(entry.lastNudgeAt) : NaN;
    const anchor = Math.max(windowStartMs(def, ctx), Number.isFinite(stamped) ? stamped : 0);
    return ctx.nowMs - anchor >= def.nudgeEveryMin * MS_PER_MIN;
  }

  // Every definition owed a nudge right now, richest-first so a truncated bubble
  // names the most-behind items.
  function dueNudges(defs, state, ctx) {
    return (defs || [])
      .filter(d => d.status === "active" && d.title)
      .map(d => {
        const entry = readEntry(state, d.id);
        const key = windowKeyFor(d, ctx.minutesOfDay, ctx.dayStartMin);
        return { def: d, entry: entry, windowKey: key, progress: progressFor(d, entry, key) };
      })
      .filter(row => nudgeDue(row.def, row.entry, ctx))
      .sort((a, b) => b.progress.remaining - a.progress.remaining);
  }

  const api = {
    KIND: KIND,
    DAY_PERIOD: DAY_PERIOD,
    DAY_KEY: DAY_KEY,
    HISTORY_DAYS: HISTORY_DAYS,
    PERIOD_CHOICES: PERIOD_CHOICES,
    // pure
    normalizeDef: normalizeDef,
    isDaily: isDaily,
    snapPeriod: snapPeriod,
    hhmm: hhmm,
    toMinutes: toMinutes,
    windowStartMinutes: windowStartMinutes,
    windowKeyFor: windowKeyFor,
    windowStartMs: windowStartMs,
    windowResetMinutes: windowResetMinutes,
    isActiveAt: isActiveAt,
    blankEntry: blankEntry,
    readEntry: readEntry,
    countIn: countIn,
    progressFor: progressFor,
    rollupForDay: rollupForDay,
    closeStaleWindows: closeStaleWindows,
    streakFrom: streakFrom,
    shiftDate: shiftDate,
    nudgeDue: nudgeDue,
    dueNudges: dueNudges,
    trimHistory: trimHistory
  };

  // ── browser only ──────────────────────────────────────────────────────────
  // Everything past here touches blockStore / the day root. Node requires this
  // module for the pure half, so none of it may run at parse time.
  if (typeof window === "undefined") return api;

  const STATE_PROP = "_anytime";

  function bs() { return window.blockStore || null; }
  function todayStr() {
    return (window.DCC && window.DCC.dates && window.DCC.dates.todayKey())
      || new Date().toISOString().slice(0, 10);
  }
  // Guard every write the way pet-courier.js does: `_bsProp`/`_bsSaveProp`
  // address the day being VIEWED, so writing while Drake plans tomorrow would
  // stamp counters onto tomorrow's root and leave today's stale.
  function onTodayView() {
    return !(typeof window.viewMode !== "undefined" && window.viewMode && window.viewMode !== "today");
  }

  function readState() {
    const v = (typeof window._bsProp === "function") ? window._bsProp(STATE_PROP, null) : null;
    return (v && typeof v === "object") ? v : {};
  }
  function writeEntry(defId, entry) {
    if (!onTodayView()) return false;
    const state = readState();
    const next = { ...state, [defId]: entry };
    return (typeof window._bsSaveProp === "function") ? window._bsSaveProp(STATE_PROP, next) : false;
  }

  // Live definitions, newest sort order last. Dateless `type:"block"` rows live
  // in blockStore's GLOBAL cache, so these survive date navigation.
  function list(opts) {
    const store = bs();
    if (!store) return [];
    const includeArchived = !!(opts && opts.includeArchived);
    return (store.getByType("block") || [])
      .filter(b => !b.date && ((b.properties || {}).kind === KIND))
      .map(normalizeDef)
      .filter(d => d.title && (includeArchived || d.status === "active"))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  }

  function defProps(def) {
    return {
      kind: KIND,
      title: def.title,
      icon: def.icon || "",
      unit: def.unit || "",
      target: def.target,
      periodMinutes: def.periodMinutes,
      nudgeEveryMin: def.nudgeEveryMin,
      activeFrom: def.activeFrom == null ? null : hhmm(def.activeFrom),
      activeUntil: def.activeUntil == null ? null : hhmm(def.activeUntil),
      activeDays: def.activeDays,
      status: def.status,
      history: def.history || {}
    };
  }

  async function create(input) {
    const store = bs();
    if (!store) throw new Error("Offline: try again in a moment");
    const def = normalizeDef({ properties: input });
    if (!def.title) throw new Error("A title is required");
    return store.createBlock("block", defProps(def), { date: null });
  }

  // updateBlock REPLACES properties wholesale (state.js:1010 documents the data
  // loss that taught this), so every write reads the row first.
  async function update(id, patch) {
    const store = bs();
    if (!store) throw new Error("Offline: try again in a moment");
    const row = store.get(id);
    if (!row) throw new Error("That item is no longer here");
    const merged = normalizeDef({ id: id, properties: { ...(row.properties || {}), ...(patch || {}) } });
    if (!merged.title) throw new Error("A title is required");
    return store.updateBlock(id, { ...(row.properties || {}), ...defProps(merged) });
  }

  function archive(id) { return update(id, { status: "archived" }); }
  function remove(id) {
    const store = bs();
    return store ? store.deleteBlock(id) : Promise.resolve();
  }

  // The clock context every pure function takes. One place derives "now", so a
  // test can hand the same shape in.
  function context(at) {
    const now = at instanceof Date ? at : new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayStart = (window.DCC && typeof window.DCC.dayStartMinutes === "function")
      ? clampInt(window.DCC.dayStartMinutes(window.__state), 0, DAY_PERIOD - 1, 420) : 420;
    return {
      nowMs: now.getTime(),
      midnightMs: midnight.getTime(),
      minutesOfDay: now.getHours() * 60 + now.getMinutes(),
      dayStartMin: dayStart,
      dowIndex: now.getDay(),
      todayStr: todayStr()
    };
  }

  // Roll every definition's stale windows shut and persist what moved. Called by
  // the tick and by the dock on open, so a tab that slept through a handover
  // still records the miss.
  function settle(defs, ctx) {
    const state = readState();
    const out = [];
    (defs || []).forEach(def => {
      const key = windowKeyFor(def, ctx.minutesOfDay, ctx.dayStartMin);
      const entry = readEntry(state, def.id);
      // Seed the window so an active-but-untouched window is recordable as a
      // miss when it closes. Inactive windows stay unseeded and cost nothing.
      if (isActiveAt(def, ctx.minutesOfDay, ctx.dowIndex)
          && !Object.prototype.hasOwnProperty.call(entry.w, key)) {
        entry.w[key] = 0;
      }
      const res = closeStaleWindows(def, entry, key, ctx.todayStr);
      if (res.changed && onTodayView()) {
        writeEntry(def.id, res.entry);
        if (res.history !== def.history) {
          def.history = res.history;
          update(def.id, { history: res.history }).catch(() => {});
        }
      }
      out.push({ def: def, entry: res.entry, windowKey: key, missed: res.missed });
    });
    return out;
  }

  // One check. `delta` of -1 undoes it. Points and pet care ride the existing
  // task-credit fan-out with a synthetic id, the way triage.js already does for
  // rows that are not blocks (triage.js:1112).
  function check(def, delta, ctx) {
    ctx = ctx || context();
    if (!onTodayView()) return null;
    const key = windowKeyFor(def, ctx.minutesOfDay, ctx.dayStartMin);
    const entry = readEntry(readState(), def.id);
    const before = countIn(entry, key);
    const next = Math.max(0, Math.min(def.target, before + (delta < 0 ? -1 : 1)));
    if (next === before) return null;
    entry.w[key] = next;
    entry.lastWindowKey = key;
    writeEntry(def.id, entry);

    const rollup = rollupForDay(def, entry);
    const prev = def.history[ctx.todayStr];
    if (!prev || prev.hit !== rollup.hit || prev.closed !== rollup.closed) {
      def.history = trimHistory({ ...def.history, [ctx.todayStr]: rollup });
      update(def.id, { history: def.history }).catch(() => {});
    }

    if (next > before) awardCheck(def, key, next, ctx);
    return { entry: entry, windowKey: key, count: next };
  }

  // Idempotent on the source key, which carries the check ORDINAL: unchecking
  // and rechecking replays the same key instead of minting a second award.
  function awardCheck(def, windowKey, ordinal, ctx) {
    if (typeof window.awardSlotTaskCredit !== "function") return;
    const key = "anytime:" + def.id + ":" + windowKey + ":" + ordinal;
    try {
      window.awardSlotTaskCredit(
        { id: key, title: def.title || "Anytime task", type: "habit", tags: ["anytime"], durMin: 5 },
        { awardPoints: 1, sourceDate: ctx.todayStr, sourceKey: key, silent: true }
      );
    } catch (e) { /* credit is best-effort; the check itself already landed */ }
  }

  // Bank the nudge BEFORE it is delivered. This is pet-courier.js's rule and the
  // reason matters: the tick fires every minute, so a delivery that failed or
  // that Drake ignored must not re-summon the pet sixty seconds later.
  function stampNudge(defIds, iso) {
    if (!onTodayView() || !defIds || !defIds.length) return false;
    const state = readState();
    const next = { ...state };
    defIds.forEach(id => {
      const entry = readEntry(state, id);
      entry.lastNudgeAt = iso;
      next[id] = entry;
    });
    return (typeof window._bsSaveProp === "function") ? window._bsSaveProp(STATE_PROP, next) : false;
  }

  return Object.assign(api, {
    STATE_PROP: STATE_PROP,
    stampNudge: stampNudge,
    onTodayView: onTodayView,
    readState: readState,
    list: list,
    create: create,
    update: update,
    archive: archive,
    remove: remove,
    context: context,
    settle: settle,
    check: check
  });
});
