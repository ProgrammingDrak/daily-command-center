# Task priority and itinerary views

## Design

Priority is an explicit task attribute: Low, Medium, or High. Missing or unknown
values read as Medium. Task details use a compact labelled native select; a small
flag on task cards opens the same choices. Medium stays quiet, while Low and High
include a word and arrow so their meaning does not depend on color.

The existing view navigation now offers:

- **Itinerary:** the existing chronological schedule and time-block presentation.
  Open unscheduled and triage tasks remain in their header drawers.
- **List:** High, Medium, Low sections in that order. The same day partition and
  visibility rules supply tasks, including open unscheduled/triage tasks inline.
  Waiting, side-project, deleted, and other day exclusions remain unchanged.
  Completed subtasks retain their existing home in their parent's details.

List is a stable partition of the existing ordered tasks. It does not sort the
source array or write schedule/manual-order data. Each child uses its own priority,
independently of parent collapse state, with a compact parent label. Timeless
subtasks keep their subtask controls. Drag reorder is available in Itinerary;
List disables it because moving across priority groups would otherwise be ambiguous.

Changing priority regroups List after the save or offline queue acceptance. It
never changes timing, completion, actuals, points, or underlying manual ordering.
The selected view uses the existing `dcc-itinerary-view` local preference and is
restored on reload. New/invalid preferences default to Itinerary; an existing
`list` preference now opens the priority List. Existing archive navigation still
starts on Actual. Calendar and Actual remain available.

## Persistence and compatibility

`properties.taskPriority` stores the new choice in the existing JSON properties
bag; no schema migration is needed. The retired `properties.priority` field is
preserved but never interpreted as the new attribute. Legacy High, urgent, or
old stage flags therefore cannot unexpectedly promote a task. No stored values
are deleted or rewritten in bulk.

Task projections and serializers normalize the new value. Task creation, project
and responsibility templates, recurrence materialization, group materialization,
and child/template copies carry the new field. Old imports and templates without
it read as Medium; JSON rows containing it retain it. The task-library editor
exposes the same choice. Saved library-view filter compatibility remains unchanged;
the retired priority filter is not revived.

Priority edits use the existing serialized row-properties writer and write-ahead
log. Only the priority property is merged into fresh row state. The UI reports
Saved, Queued, or a rejected save and restores the durable value after rejection.
Priority metadata stays client-side. Coalesced ordinary changes retain their
retry behavior, and successful acknowledgements advance the rollback baseline.
When an older queued completion shares an entry with priority, the completion is
acknowledged first, then a durable priority follow-up merges into the returned
server properties. Reload migration preserves this combined entry until both
changes have been acknowledged.

## Validation

- `npm test` runs the full Node regression suite.
- `npm run lint` checks the repository.
- `node --test task-priority.test.js block-store-wal.test.js shell-materialize.test.js`
  covers defaults, legacy isolation, stable grouping, visibility exclusions,
  serializer reloads, real template copies, offline replay, rejection rollback,
  quota errors, coalesced writes, and completion/priority sequencing.
- Start the synthetic-only review server with
  `PORT=8108 DCC_REVIEW_TASK_DETAILS=1 node scripts/ui-review-server.mjs`, then run
  `CHROME_PATH="/path/to/chrome" node scripts/verify-task-priority.cjs`.
  It refuses a server without `reviewOnly`, resets only disposable fixture tasks,
  and uses fresh headless profiles at 1440px and 375px. Screenshots go to `/tmp`,
  or `DCC_PRIORITY_SCREENSHOTS`. No real tasks or existing browser tabs are used.

This replacement and the shared-composer change follow the repository release
workflow. The earlier old-priority removal release remains a separate queue entry;
its exact-commit production verification must complete before the next integration.
