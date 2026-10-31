// Journal task pages: which task does a page belong to, and which server row may
// it be sent to?
//
// Replaces "the first block carrying this journalId". That rule would have sent a
// page to the wrong task, or shown one task's page in another, whenever two
// blocks carried the same journalId (a copy before the server re-mints its id, a
// concurrent create, a legacy duplicate).
//
// A task is known by several ids: its local id before the server acknowledges it
// and its server id after. `expand` follows block-store rows to join those
// aliases; it never joins two different rows that merely share a journalId.
//
// resolve(blocks, journalId, taskKeys) ->
//   { state: "ok", taskId, keys }   exactly this task carries journalId: send to taskId
//   { state: "pending", keys }      the task's row is not in the block store yet
//   { state: "ambiguous", keys }    another task also carries journalId: refuse
//   { state: "mismatch", keys, actualJournalId }  this task carries a different id: refuse
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JournalTaskBinding = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  function idsOf(block) { return [block.id, block.properties && block.properties.local_id].filter(Boolean); }
  function journalOf(block) { return block.properties ? block.properties.journalId || null : null; }

  function expand(blocks, taskKeys) {
    const keys = new Set((taskKeys || []).filter(Boolean));
    let grew = true;
    while (grew) {
      grew = false;
      for (const b of blocks) {
        const ids = idsOf(b);
        if (ids.some(k => keys.has(k)) && ids.some(k => !keys.has(k))) { ids.forEach(k => keys.add(k)); grew = true; }
      }
    }
    return Array.from(keys);
  }

  function resolve(blocks, journalId, taskKeys) {
    const rows = (blocks || []).filter(b => b && b.id);
    const keys = expand(rows, taskKeys);
    const mine = rows.filter(b => idsOf(b).some(k => keys.includes(k)));
    const carrying = Array.from(new Set(mine.filter(b => journalOf(b) === journalId).map(b => b.id)));
    // ownTaskId: this task's own server row, so a caller can ask the server who
    // owns the id. It is NEVER a send target while the state is ambiguous.
    const ownTaskId = carrying.length === 1 ? carrying[0] : null;
    const others = rows.filter(b => !mine.includes(b) && journalOf(b) === journalId);
    if (others.length) return { state: "ambiguous", keys, ownTaskId };
    const different = mine.find(b => journalOf(b) && journalOf(b) !== journalId);
    if (different) return { state: "mismatch", keys, actualJournalId: journalOf(different) };
    if (carrying.length > 1) return { state: "ambiguous", keys, ownTaskId: null };
    if (carrying.length === 1) return { state: "ok", taskId: carrying[0], keys };
    return { state: "pending", keys };
  }

  return { expand, resolve, idsOf };
});
