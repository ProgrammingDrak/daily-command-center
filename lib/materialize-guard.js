"use strict";

// The no-resurrection contract, in one place.
//
// Every path that mints a task row from an external or derived item — a calendar
// sweep, an agent retry, a Day-in-Review write, a preset task group — has to answer
// the same question first: does this thing already exist? #253 made deletion durable
// and then answered that question in three separate inlined copies, each with its own
// lookup and its own idea of what a soft-deleted hit means. This module is the single
// copy those collapse into.
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
  //   date + sourceId|match — the per-day scan the materializers already do
  //
  // Both delegate to primitives that exist; this writes no new SQL.
  async function findForDedupe(workspaceId, opts = {}) {
    const { idempotencyKey = null, sourceId = null, date = null, match = null } = opts;

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

    if (!date) return null;
    const predicate = typeof match === "function"
      ? match
      : (sourceId != null
        ? (row) => String((row.properties || {}).source_id || "") === String(sourceId)
        : null);
    if (!predicate) return null;

    const rows = await blockDB.getBlocksByDateIncludingDeleted(date, workspaceId);
    const hits = rows.filter(predicate);
    if (!hits.length) return null;
    // A live row wins over a tombstone, matching findByIdempotencyKey's own
    // `ORDER BY (deleted_at IS NULL) DESC`, so a caller holding both reports
    // "duplicate" rather than the more drastic "deleted".
    return hits.find((row) => !row.deleted_at) || hits[0];
  }

  return { assertNotResurrecting, dedupeStatus, findForDedupe };
}

module.exports = createMaterializeGuard;
module.exports.createMaterializeGuard = createMaterializeGuard;
module.exports.assertNotResurrecting = assertNotResurrecting;
module.exports.dedupeStatus = dedupeStatus;
