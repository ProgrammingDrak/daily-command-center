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
  const LEVELS = Object.freeze(['jump', 'select', 'task', 'details']);
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function viewport(length, selected, size = 11) {
    const start = clamp(selected - Math.floor(size / 2), 0, Math.max(0, length - size));
    return { start, end: Math.min(length, start + size), selectedSlot: selected - start };
  }
  function create(initial = {}) {
    let collection = clamp(Number(initial.collection) || 0, 0, COLLECTIONS.length - 1);
    let level = clamp(Number(initial.level) || 0, 0, LEVELS.length - 1);
    const positions = COLLECTIONS.map(() => 0);
    const ids = COLLECTIONS.map(() => null);
    let lists = COLLECTIONS.map(() => []);
    function setLists(next) {
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
      return snapshot();
    }
    function select(index) {
      positions[collection] = clamp(index, 0, Math.max(0, lists[collection].length - 1));
      ids[collection] = lists[collection][positions[collection]]?.id || null;
    }
    function input(action) {
      if (action === 'home') { collection = 0; level = 0; select(0); return snapshot(); }
      if (action === 'back') { level = Math.max(0, level - 1); return snapshot(); }
      if (action === 'hold-fore' && level === 2) { level = 3; return snapshot(); }
      if (action === 'tap-fore' && level < 2 && lists[collection].length) { level++; return snapshot(); }
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
        collection, collectionName: COLLECTIONS[collection], level: LEVELS[level],
        index, count: rows.length, selected: rows[index] || null,
        window: viewport(rows.length, index),
        rows: rows.slice(viewport(rows.length, index).start, viewport(rows.length, index).end)
      });
    }
    return Object.freeze({ input, setLists, snapshot });
  }
  return Object.freeze({ COLLECTIONS, LANES, LEVELS, viewport, create });
});
