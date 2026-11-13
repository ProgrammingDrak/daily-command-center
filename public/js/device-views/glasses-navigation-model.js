// DCC glasses task-navigation model. Reads canonical rendered task rows; does not own task state.
// This module is intentionally side-effect free until mounted by the glasses adapter.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DCCGlassesNavigation = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const COLLECTIONS = Object.freeze([
    'All Tasks', 'Working Queue', 'Itinerary', 'Loose Ends',
    'Unscheduled', 'Whenever', 'Someday', 'Waiting'
  ]);
  const LANES = Object.freeze(['Foreground', 'Needs You', 'Background', 'Priority Queue']);
  const LEVELS = Object.freeze(['jump', 'select', 'task', 'details', 'more']);
  function taskHierarchy(items, taskModel, { preserveOrder = false } = {}) {
    const byId = new Map(), byAlias = new Map();
    const tasks = items.filter(item => item?.kind === 'task');
    const aliasKey = (item, id) => JSON.stringify([item.row?.date || item.ev?.__unf?.sourceDate || null, id]);
    for (const item of tasks) {
      byId.set(item.actionId, item);
      const alias = item.ev?.id;
      if (!alias) continue;
      const key = aliasKey(item, alias);
      if (!byAlias.has(key)) byAlias.set(key, item);
      else if (byAlias.get(key) !== item) byAlias.set(key, null);
    }
    // The tree uses stable action IDs internally. Keep the original event and
    // action descriptor for navigation, selection and writes.
    const events = tasks.map(item => {
      const rel = taskModel.relOf(item.ev);
      const ref = taskModel.parentIdOf(item.ev) || item.row?.parent_id;
      const parent = byId.get(ref) || byAlias.get(aliasKey(item, ref));
      return { id: item.actionId, start: item.ev?.start,
        wrapId: rel === 'ride-along' ? parent?.actionId : null,
        subtaskOf: rel !== 'ride-along' ? parent?.actionId : null };
    });
    const tree = taskModel.selectTree(events, { isCollapsed: () => false });
    const formatted = new Map(tree.map(({ ev, depth, rel }) => [
      ev.id, { ...byId.get(ev.id), depth, relation: depth ? rel : null }
    ]));
    if (preserveOrder) return items.map(item => formatted.get(item?.actionId) || item);
    return [...formatted.values(), ...items.filter(item => item && item.kind !== 'task')];
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function viewport(length, selected, size = 11) {
    const start = clamp(selected - Math.floor(size / 2), 0, Math.max(0, length - size));
    return { start, end: Math.min(length, start + size), selectedSlot: selected - start };
  }
  function create(initial = {}) {
    let collection = clamp(Number(initial.collection) || 0, 0, COLLECTIONS.length - 1);
    let level = clamp(Number(initial.level) || 0, 0, LEVELS.length - 1);
    let moreIndex = 0;
    const positions = COLLECTIONS.map(() => 0);
    const ids = COLLECTIONS.map(() => null);
    let lists = COLLECTIONS.map(() => []);
    function setLists(next) {
      const previous = ids[collection];
      lists = COLLECTIONS.map((_, index) => {
        const rows = next[index] || [];
        const seen = new Set();
        return rows.filter(item => {
          if (!item || !item.id || seen.has(item.id)) return false;
          seen.add(item.id); return true;
        });
      });
      positions.forEach((position, index) => {
        const found = lists[index].findIndex(item => item.id === ids[index]);
        positions[index] = found >= 0 ? found : clamp(position, 0, Math.max(0, lists[index].length - 1));
        ids[index] = lists[index][positions[index]]?.id || null;
      });
      if (level >= 2 && previous !== ids[collection]) level = 1;
      return snapshot();
    }
    function select(index) {
      positions[collection] = clamp(index, 0, Math.max(0, lists[collection].length - 1));
      ids[collection] = lists[collection][positions[collection]]?.id || null;
    }
    function input(action) {
      if (action === 'home') { collection = 0; level = 0; return snapshot(); }
      if (action === 'back') { level = level >= 3 ? 2 : Math.max(0, level - 1); return snapshot(); }
      if (action === 'select-view') { level = 1; return snapshot(); }
      if (action === 'more' && level === 2) { level = 4; moreIndex = 0; return snapshot(); }
      if (action === 'hold-fore' && level === 2) { level = 3; return snapshot(); }
      if (action === 'tap-fore' && level < 2 && lists[collection].length) { level++; return snapshot(); }
      if (level === 4 && (action === 'up' || action === 'down')) { moreIndex = clamp(moreIndex + (action === 'up' ? -1 : 1), 0, 3); return snapshot(); }
      if (level === 0 && (action === 'left' || action === 'right')) {
        collection = clamp(collection + (action === 'left' ? 1 : -1), 0, COLLECTIONS.length - 1);
      } else if (level < 2 && (action === 'up' || action === 'down')) {
        select(positions[collection] + (action === 'up' ? -1 : 1) * (level === 0 ? 5 : 1));
      }
      // Task actions are deliberately delegated to the canonical DCC coordinator.
      return snapshot();
    }
    function snapshot() {
      const rows = lists[collection], index = positions[collection];
      return Object.freeze({
        moreIndex, collection, collectionName: COLLECTIONS[collection], level: LEVELS[level],
        index, count: rows.length, selected: rows[index] || null,
        window: viewport(rows.length, index),
        range: viewport(rows.length, index, 5),
        rows: rows.slice(viewport(rows.length, index).start, viewport(rows.length, index).end)
      });
    }
    return Object.freeze({ input, setLists, snapshot });
  }
  // One recognizer for keyboard, pointer and simulator inputs. Native browser
  // Back/Forward is intentionally not a gesture here. Cancel never emits a tap.
  function createInput(emit, timers = {}) {
    const later = timers.setTimeout || setTimeout, cancel = timers.clearTimeout || clearTimeout;
    let pressed = null, holdTimer = null, middleTimer = null;
    function stopPress() { if (holdTimer != null) cancel(holdTimer); holdTimer = null; pressed = null; }
    function middleTap() {
      if (middleTimer != null) { cancel(middleTimer); middleTimer = null; emit('double-middle'); }
      else middleTimer = later(() => { middleTimer = null; emit('tap-middle'); }, 320);
    }
    function down(finger) {
      if (pressed || !['fore', 'middle'].includes(finger)) return;
      pressed = { finger, held: false };
      holdTimer = later(() => {
        if (!pressed) return;
        pressed.held = true;
        if (finger === 'fore') emit('hold-fore');
      }, 550);
    }
    function up(finger) {
      if (!pressed || pressed.finger !== finger) return;
      const held = pressed.held; stopPress();
      if (!held) { if (finger === 'middle') middleTap(); else emit('tap-fore'); }
    }
    function reset() { stopPress(); if (middleTimer != null) cancel(middleTimer); middleTimer = null; }
    return Object.freeze({ down, up, cancel: stopPress, reset });
  }
  return Object.freeze({ COLLECTIONS, LANES, LEVELS, viewport, taskHierarchy, create, createInput });
});
