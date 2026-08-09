# Completion persistence investigation and implementation plan

## Evidence and root cause

1. Completion is projected into the UI from `properties.status` / `done` in
   `public/js/persistence.js`, then written by `_persistDone` in
   `public/js/schedule.js` through `enqueueRowPropsWrite`.
2. That queue only serializes writers which elect to use it. Many normal client
   edits and background reconcilers call `blockStore.updateBlock` or
   `db.updateBlock` directly.
3. `db.updateBlock` replaces the entire `properties` object. A direct writer
   that read an older `status:"open"` object can therefore land after a valid
   completion and replace the completion fields. On the next reload, the row
   correctly projects as open. This is a durable lost update, not merely a stale
   cache rendering problem.
4. The preceding fixes addressed narrower manifestations:
   - C5 moved completion off the day-root `_done` overlay and serialized the
     known client completion writer.
   - #291 guarded client snapshot and SSE races.
   - #293 added a rendered-task row-id fallback for a temporary cache gap.
   None protects a completed row at the database write boundary from an
   independent stale full-properties replacement.

## Implementation

1. Make completion a protected state transition in `db.updateBlock`. Lock the
   row in a transaction before deriving the replacement properties, preserve
   the locked row's completion boundary for ordinary writes in either direction,
   and require explicit complete/reopen intent to cross that boundary.
2. Pass intent, a stable mutation id, and the client's base completion revision
   through the block PATCH API and client write-ahead log. Reject stale
   cross-device transitions at the locked database row; refresh and retry a live
   user action once after applying the exact property delta captured for that
   transition onto the latest unrelated properties, while dead-lettering a stale
   background replay. Require
   the base revision at the browser HTTP boundary so pre-deploy base-less WAL
   entries cannot bypass the check. Serialize
   live and replayed writes per row across tabs, coalesce superseded full-row
   updates, and carry the pending transition plus its date, parent, and sort
   metadata into a newer ordinary edit so lost acknowledgements cannot reverse
   user intent or strand a completed task outside the completed-day query.
   When the shared row queue fetched a cache miss, pass that authoritative row to
   BlockStore as client-only base metadata so the CAS revision and exact delta are
   derived from the same snapshot used by the completion merge.
3. Make `_persistDone` send `completionIntent:"complete"` or `"reopen"`.
4. Thread the same intent through Slack, side-project, action-item, and calendar
   completion paths. Timing reconciliation must retain the authoritative row
   returned by the guarded database write.
5. Stamp each actual transition with a server-generated completion revision and
   mutation id. Preserve both for same-state retries so an acknowledged retry
   cannot invalidate its own reconciliation. Reconciliation side effects
   re-lock the task and require that exact revision, preventing a delayed
   recurrence update from overtaking a reopen or a newer completion.
6. Add regression tests for reload persistence, dateless cache-miss promotion,
   concurrent reconciliation, explicit reopening, lost acknowledgements,
   cross-tab WAL replay, and recurrence ABA ordering.
