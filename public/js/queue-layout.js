// Lane layout for queue grids: two independent columns, each sizing to its own
// content, collapsing to one column under 700px (see working-queue.css). Used by
// the owner Working Queue and the shared activity page; each passes its own lanes.
//
// arrange(root, layout, find): on a breakpoint change, move the existing lane
// nodes (no re-render) into `layout` ([[col 1 lanes], [col 2 lanes]]), then return
// focus to the control that moving a lane may have blurred. `find(name)` returns
// the lane element for a name. Returns true when anything moved.
(function(root, factory){
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DCCQueueLayout = api;
})(typeof window !== "undefined" ? window : globalThis, function(){
  "use strict";
  function arrange(root, layout, find){
    const cols = root && root.querySelectorAll(".wq-grid > .wq-col");
    if (!cols || cols.length !== layout.length) return false;
    const doc = root.ownerDocument, focused = doc.activeElement, inside = focused && root.contains(focused);
    let moved = false;
    layout.forEach((names, i) => names.forEach((name, j) => {
      const lane = find(name);
      if (lane && cols[i].children[j] !== lane) { cols[i].insertBefore(lane, cols[i].children[j] || null); moved = true; }
    }));
    if (moved && inside && doc.activeElement !== focused) focused.focus({ preventScroll: true });
    return moved;
  }
  return { arrange };
});
