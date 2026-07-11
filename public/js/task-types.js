// TASK_TYPES — declarative per-type behavior registry, shared FE/BE.
// Browser: loaded before every other app script (window.TaskTypes).
// Node: require()d by slot-scoring.js / slot-store.js so the backend and the
// frontend derive the SAME non-earning set instead of duplicating literals.
//
// A type entry describes rules, not code: renderers, drag, completion, and
// scoring consult it via get()/rule(). Unknown types resolve to the `task`
// defaults, matching the legacy cfg() fallback in data.js.
//
// v1 consumers: slot-scoring.js + points.js (nonEarningTypes), schedule.js
// (rollup/auto-complete/manual-complete rules), drag.js (dragMovesSubtree,
// childEdge), tabs.js (childEdge), itinerary-card.js + schedule-tab.js
// (barColor/cardClass/rollupMode).
//
// v2 (Phase 9): the registry is now the LIVE enforcement, not just documentation.
// isFixed()/pointEligible() collapse the copy-pasted `isMeeting(ev)||ooo||break`
// predicate that used to live inline at ~a dozen call sites, and cfg() (data.js)
// reads label/tagCls/color from here. Adding a task type is one entry below.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TaskTypes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULTS = {
    label: "Task",
    tagCls: "tag-task",
    color: "#a78bfa",        // tag/type chip color (source for cfg() in data.js)
    barColor: null,          // null -> legacy TC color path (data.js)
    cardClass: null,         // extra .card / .it-list-item modifier class
    earnsOwnPoints: true,    // false -> non-earning (a positive point_multiplier can still rescue it)
    hardZero: false,         // true -> NEVER earns duration points, no tag/multiplier can rescue it
    rollupMode: null,        // "children" -> points display = sum of children
    bonusPct: 0,             // completion bonus as a fraction of children's points
    autoCompleteWhenChildrenDone: false,
    blockManualCompleteWithOpenChildren: false,
    childEdge: "any",        // "wrap" -> children always attach as ride-alongs
    dragMovesSubtree: false, // dragging the parent carries nested children
    movable: true,
    fixedTime: false,
  };

  const TYPES = {
    task:   { label: "Task",   tagCls: "tag-task" },
    triage: { label: "Triage", tagCls: "tag-triage" },
    focus:  { label: "Focus",  tagCls: "tag-focus", color: "#22d3ee" },

    // Container whose points roll up from its children. Earns nothing of its
    // own; auto-completes when the last child completes and banks bonusPct of
    // the children's total as a points_override through the normal ledger.
    shell: {
      label: "Shell",
      tagCls: "tag-shell",
      color: "#e2e8f0",
      barColor: "#e2e8f0",
      cardClass: "card-shell",
      earnsOwnPoints: false,
      hardZero: true,
      rollupMode: "children",
      bonusPct: 0.10,
      autoCompleteWhenChildrenDone: true,
      blockManualCompleteWithOpenChildren: true,
      childEdge: "wrap",
      dragMovesSubtree: true,
    },

    // Wrap = shell's container/drag behavior, MINUS the rollup economics. A wrap
    // earns its OWN duration points (a long focus block is real work), its
    // ride-along children earn independently, and it never auto-completes — you
    // check it off yourself. Shares shell's wrap childEdge + dragMovesSubtree so
    // children attach as ride-alongs and travel with the parent on drag. Unlike a
    // shell (hardZero, non-earning), the day surfaces a wrap as work. Spec: the
    // dcc-wraps-feature memory.
    wrap: {
      label: "Wrap",
      tagCls: "tag-wrap",
      color: "#818cf8",
      cardClass: "card-wrap",
      childEdge: "wrap",
      dragMovesSubtree: true,
      // earnsOwnPoints:true, no hardZero, no rollup, no auto-complete (defaults).
    },

    // Recurring self-care/discipline task. Earns points and moves like a normal
    // task; no rollup. The row shows a streak chip counting consecutive prior
    // days a same-titled habit was completed (display-only, computed from range
    // state — no schema change).
    habit: { label: "Habit", tagCls: "tag-habit", color: "#34d399" },

    // Calendar-backed blocks. fixedTime keeps them out of the reflow cascade
    // (they hold their slot when tasks around them move); movable:true lets the
    // user still drag/re-time them by hand. NOTE: oneone is deliberately NOT
    // non-earning — it has never been in NON_EARNING_TYPES; changing that would
    // change live scoring.
    meeting: { label: "Meeting", tagCls: "tag-meeting", color: "#f97316", barColor: "#f97316", earnsOwnPoints: false, movable: true, fixedTime: true },
    oneone:  { label: "1:1",     tagCls: "tag-oneone",  color: "#f59e0b", barColor: "#f59e0b", movable: true, fixedTime: true },
    break:   { label: "Break",   tagCls: "tag-break",   color: "#22c55e", earnsOwnPoints: false, movable: false, fixedTime: true },
    ooo:     { label: "OOO",     tagCls: "tag-ooo",     color: "#64748b", earnsOwnPoints: false, hardZero: true, movable: false, fixedTime: true },
  };

  function normType(evOrType) {
    if (evOrType == null) return "";
    const t = typeof evOrType === "string" ? evOrType : (evOrType.type || evOrType.kind || "");
    return String(t).trim().toLowerCase();
  }
  function get(evOrType) {
    const entry = TYPES[normType(evOrType)];
    return entry ? Object.assign({}, DEFAULTS, entry) : Object.assign({}, DEFAULTS);
  }
  function rule(evOrType, key) {
    return get(evOrType)[key];
  }
  function isRollup(evOrType) {
    return !!get(evOrType).rollupMode;
  }
  // The combined predicate that used to be copy-pasted inline everywhere as
  // `isMeeting(ev)||ev.type==="ooo"||ev.type==="break"`. A fixed-time block holds
  // its slot during reflow and isn't a normal reschedulable task row. Null-safe:
  // an empty/unknown type is not fixed.
  function isFixed(evOrType) {
    return get(evOrType).fixedTime === true;
  }
  // Inverse of isFixed: a normal task row (task/triage/focus/shell/wrap/habit…).
  // "point-eligible" is the historical name for this set — the row that shows a
  // points chip and participates in the reflow cascade. (Shell is in this set
  // even though its own duration doesn't score; its rollup does.)
  function pointEligible(evOrType) {
    return !isFixed(evOrType);
  }
  function nonEarningTypes() {
    return Object.keys(TYPES).filter(function (k) {
      return Object.assign({}, DEFAULTS, TYPES[k]).earnsOwnPoints === false;
    });
  }
  // The unconditional tier: no tag tier or point_multiplier can make these earn.
  function hardZeroTypes() {
    return Object.keys(TYPES).filter(function (k) {
      return Object.assign({}, DEFAULTS, TYPES[k]).hardZero === true;
    });
  }

  return { TYPES: TYPES, DEFAULTS: DEFAULTS, get: get, rule: rule, isRollup: isRollup, isFixed: isFixed, pointEligible: pointEligible, nonEarningTypes: nonEarningTypes, hardZeroTypes: hardZeroTypes };
});
