# Unscheduled checklist creation and pending-edit recovery

An unscheduled task has `blocks.date = NULL`. A checklist child must use the
same pool/date as its canonical parent; the viewed day is not its placement.
A task can be wanted today without having been assigned a date in the Library.
Queue display identity may differ from the backing Library task identity.

## Reproduced defect and fix

The Unscheduled/carryover projection preserves an undated parent's date as
`null` in `taskAnchorById`. `addSubtask` previously used a truthy fallback:
`options.date || anchor.date || viewedDate`. For an ordinary undated Library
task this replaced `null` with the viewed day. The server correctly rejected
the mismatched child, and BlockStore retained its original create in the WAL.
Repeated sync of the same invalid payload cannot fix its placement.

The day view also folds undated Library rows into `scheduled[]` with `_dateless`.
The shared anchor now retains that null placement, and new children keep the
dateless/untimed projection so they do not enter day totals.

The fix preserves an existing anchor's explicit null date. Dated carryover and
the explicit placement of a newly scheduled future parent retain their existing
behavior. No parent date, history, notes, effort or server validation is changed.
Existing pending edits are not automatically rewritten by this fix.

## Supported recovery in the existing signed-in browser

1. Keep the affected tab and its pending edit. Do not recreate the child, clear
   browser storage, discard the WAL, or move the parent to make the error stop.
2. Open **Save status**. **Export pending changes** can preserve a local copy;
   it can contain private task data and should not be published.
3. For the affected child, choose **Review subtask repair**. This is a read-only
   preview. Verify the displayed parent and placement; for a canonical undated
   parent the destination must be **Unscheduled**. A queue title alone is not
   sufficient identity evidence.
4. If the preview matches the intended parent and scope, choose **Repair this
   pending subtask**. The existing session-only endpoint preserves the original
   child ID and payload, binds to the previewed parent revision, and creates the
   child in that parent's current pool. It never moves the parent.
5. Verify the successful save and pending count, then read the child and parent
   back through the application. Do not treat a timeout as a failed write:
   repeat the preview for the same retained edit before any retry.

The repair refuses ambiguous/missing parents, a changed parent revision, changed
pending content, conflicting existing rows and tombstones. If the control is
absent or the preview conflicts, retain/export the edit and report the exact
error; do not substitute deletion/recreation or raw storage edits.

Source: `public/js/shell.js` Save status controls; `block-store.js`
`previewPendingSubtask`/`repairPendingSubtask`; session-only
`POST /api/blocks/pending-create-repair`; `lib/pending-create-repair.js`.

## Isolated verification

`unscheduled-subtask.test.js` reproduces the null-date regression and exercises
the actual browser anchor, checklist creator, BlockStore and PostgreSQL, through
both the carryover projection and the day view’s dateless projection. It
checks saved placement, unchanged parent content/history, no pending WAL,
idempotent retry, and the shipped preview/apply recovery for an older invalid
create. The database case requires a localhost `DCC_TEST_DATABASE_URL` and is
included in `npm run test:postgres`. No live tasks are used as fixtures.
