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
// (barColor/cardClass/rollupMode). Existing types (meeting, break, ooo…) are
// described here for documentation and future consumers, but their historical
// call sites (isMeeting() etc.) remain the live enforcement in v1.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TaskTypes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULTS = {
    label: "Task",
    tagCls: "tag-task",
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
    focus:  { label: "Focus",  tagCls: "tag-focus" },

    // Container whose points roll up from its children. Earns nothing of its
    // own; auto-completes when the last child completes and banks bonusPct of
    // the children's total as a points_override through the normal ledger.
    shell: {
      label: "Shell",
      tagCls: "tag-shell",
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

    // NOTE: oneone is deliberately NOT non-earning — it has never been in
    // NON_EARNING_TYPES; changing that would change live scoring.
    meeting: { label: "Meeting", tagCls: "tag-meeting", earnsOwnPoints: false, movable: false, fixedTime: true },
    oneone:  { label: "1:1",     tagCls: "tag-oneone",  movable: false, fixedTime: true },
    break:   { label: "Break",   tagCls: "tag-break",   earnsOwnPoints: false, fixedTime: true },
    ooo:     { label: "OOO",     tagCls: "tag-ooo",     earnsOwnPoints: false, hardZero: true, movable: false, fixedTime: true },
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

  return { TYPES: TYPES, DEFAULTS: DEFAULTS, get: get, rule: rule, isRollup: isRollup, nonEarningTypes: nonEarningTypes, hardZeroTypes: hardZeroTypes };
});
