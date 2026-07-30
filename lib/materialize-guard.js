"use strict";

// The no-resurrection contract: the RULE in one place, and the single-row lookup that
// applies it.
//
// Every path that mints a task row from an external or derived item — a calendar
// sweep, an agent retry, a Day-in-Review write, a preset task group — has to answer
// the same question first: does this thing already exist? #253 made deletion durable
// and then answered it in several inlined copies, each with its own idea of what a
// soft-deleted hit means.
//
// THE RULE: A SOFT-DELETED MATCH IS STILL A MATCH. A tombstone means the user
// deliberately removed the item, so a later retry or sweep must SKIP it, not mint a
// lookalike replacement. Filtering `deleted_at IS NULL` out of a dedupe lookup IS the
// resurrection bug — that omission is why `db.findByIdempotencyKey` and
// `db.getBlocksByDateIncludingDeleted` exist at all.
//
// The reference implementation lifted here is meeting-materializer.js, which has had
// this right since #253: it looks a meeting up by source_id INCLUDING tombstones and
// refuses to re-create one the user deleted.
//
// SCOPE, honestly: what is consolidated here is the RULE (assertNotResurrecting,
// dedupeStatus) and the single-row key lookup. Three BULK variants remain hand-rolled,
// because each indexes a whole day's rows once and answers many candidates from it —
// a shape this single-row API would turn into one day-load per candidate:
//   - meeting-materializer.js `bySourceId`
//   - responsibility-store.js `deletedResponsibilityIds` (loadDaySlottingContext)
//   - responsibility-store.js `tombstonedNames` (the apply-forward creates)
// All three call assertNotResurrecting's rule in spirit; unifying their LOOKUP wants a
// bulk `indexForDedupe(rows, keyOf)` helper, which is a Track D file change and is not
// this phase. Do not read "one guard" as "grep is unnecessary".

// The predicate itself. Returns the hit alongside the verdict so a caller can report
// which row it skipped without a second lookup.
function assertNotResurrecting(existing) {
  return { skip: !!(existing && existing.deleted_at), existing: existing || null };
}

// The status string the routes already return, derived once so "deleted" and
// "duplicate" cannot drift apart between endpoints. null means "no match, go create".
function dedupeStatus(existing) {
  if (!existing) return null;
  return existing.deleted_at ? "skipped_deleted" : "skipped_duplicate";
}

function createMaterializeGuard({ blockDB } = {}) {
  if (!blockDB) throw new Error("materialize-guard requires blockDB");

  // Find the row a would-be create would duplicate, TOMBSTONES INCLUDED.
  //
  // Two ways in, matching the two identity schemes already in the codebase:
  //   idempotencyKey — the caller-supplied key (quick-task, the brief endpoints)
  //   date|rows + match — the per-day scan the materializers already do
  //
  // Both delegate to primitives that exist; this writes no new SQL.
  //
  // `rows` lets a caller that ALREADY holds the day's rows hand them in instead of
  // paying for a second load. That matters more than it looks: every index on `blocks`
  // is partial on `deleted_at IS NULL`, so the tombstone-inclusive day load cannot use
  // one and sequential-scans the whole table (measured: 15ms / 455 buffers at 3.1k
  // rows, and the table only grows because deletion is soft). Any caller doing its own
  // day load should pass rows; any caller tempted to call this in a per-item loop
  // should pass rows instead of looping the query.
  async function findForDedupe(workspaceId, opts = {}) {
    const { idempotencyKey = null, date = null, match = null, rows = null } = opts;

    if (idempotencyKey) {
      // DELIBERATELY DATE-BLIND, which is a widening of the routes/dcc.js lookup this
      // replaced (that one carried `WHERE date = $1`). A key is an identity claim, not
      // a per-day one: under the old scope, deleting a keyed task and letting the same
      // agent retry on a LATER day recreated it, which is the exact bug the no-resurrect
      // contract exists to stop. Measured before making the change: 30 keys in the prod
      // restore span more than one date, every one of them a `slack-bookmark:` key whose
      // writer (routes/slack-events.js) was already date-blind and whose poller carries
      // its own cross-day gate. The other key vocabularies in use — `day-review:<date>:`,
      // `day-review-followup:<date>:`, `resp:<id>:<date>`, `resp-shell:<id>:<date>` —
      // all embed the date, so they cannot collide across days. A3's UNIQUE index over
      // live idempotency keys enforces this same global-identity reading.
      const hit = await blockDB.findByIdempotencyKey(workspaceId, idempotencyKey);
      if (hit) return hit;
    }

    // No predicate means no identity to match on, and a silent "no duplicate exists" is
    // the failure mode this module exists to prevent — so return before querying rather
    // than after matching nothing.
    if (typeof match !== "function") return null;
    if (!date && !rows) return null;

    const candidates = rows || await blockDB.getBlocksByDateIncludingDeleted(date, workspaceId);
    const hits = candidates.filter(match);
    if (!hits.length) return null;
    // A live row wins over a tombstone, matching findByIdempotencyKey's own
    // `ORDER BY (deleted_at IS NULL) DESC`, so a caller holding both reports
    // "duplicate" rather than the more drastic "deleted".
    return hits.find((row) => !row.deleted_at) || hits[0];
  }

  // Only the persistence-touching function comes off the factory. The two pure helpers
  // are module-level exports so they unit-test with no DB and so a caller that just
  // needs the RULE does not have to drag a blockDB into scope — the layering
  // lib/task-timing.js and responsibility-store.js both state in their headers. Exposing
  // them both ways would give the same function two reach paths, and this phase already
  // had one call site of each before it was tidied.
  return { findForDedupe };
}

module.exports = createMaterializeGuard;
module.exports.createMaterializeGuard = createMaterializeGuard;
module.exports.assertNotResurrecting = assertNotResurrecting;
module.exports.dedupeStatus = dedupeStatus;
