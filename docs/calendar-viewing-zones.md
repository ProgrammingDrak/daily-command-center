# Calendar viewing-zone preview

The calendar defaults to the configured DCC scheduling zone. The zone control can
follow the browser or use a manually selected IANA zone, with an optional home
clock. Preferences live in this browser profile. If device detection fails, the
view falls back to the scheduling zone. Focus and visibility changes recheck the
device zone. The preview uses a week agenda and leaves the editable scheduling
grid available through **Use scheduling zone** with **Show home time** cleared.

## Storage and compatibility audit

- The server resolves its scheduling zone from DCC_TIME_ZONE, then APP_TIME_ZONE,
  then America/New_York. The calendar previously hardcoded New York.
- Blocks use a PostgreSQL DATE and JSON properties for start, end and duration.
  All-day spans use an inclusive start and exclusive end. The meeting materializer
  retains provider start and end instants alongside the app-zone date and clock values.
- The agenda interprets legacy timed blocks using the configured scheduling zone.
  This matches the current calendar convention, but does not establish the original
  zone or fixed-versus-floating intent for every historical item. A DST gap or
  repeated hour is listed for review instead of assigned an instant.
- The agenda requests a viewing-zone range and groups projected starts by local day.
  The existing API contract and scheduling, activity and completion writers are
  untouched. The preview has no event editing or actuals layer.

## Offline preflight

Run this against a JSON array of exported block rows with ISO date strings and a
verified legacy scheduling zone:

    node scripts/audit-schedule-zones.js blocks.json America/New_York

The report counts legacy timed, date-only, and unresolved records and includes
the IDs and original clock values of rows with a DST or parsing issue. It is
read-only and repeatable. Before any future backfill, reconcile available calendar
source instants and verify the scheduling-zone history for each dataset. Keep
unverified and conflicting rows for review.

For an offline snapshot, supply a JSON array of individually reviewed block IDs
and redirect stdout to a **new** file:

    node scripts/audit-schedule-zones.js blocks.json America/New_York apply approved-ids.json > converted.json
    node scripts/audit-schedule-zones.js converted.json America/New_York rollback > reverted.json

Apply only adds metadata to approved rows with a unique interpretation and no
existing instant metadata. Rollback removes only metadata tagged by this tool.
Both operations are idempotent and preserve the rest of each row. These commands
operate on exported JSON and have no database connection.

## Local PostgreSQL preflight, apply, and rollback

Use a local copy of the database. Set DCC_LOCAL_MIGRATION_URL to an explicit
loopback PostgreSQL connection URL for that copy. The script ignores
DATABASE_URL and does not load deployment credentials.

    node scripts/migrate-schedule-zones.js WORKSPACE_ID America/New_York audit
    node scripts/migrate-schedule-zones.js WORKSPACE_ID America/New_York apply approved-ids.json
    node scripts/migrate-schedule-zones.js WORKSPACE_ID America/New_York rollback

Audit uses a read-only transaction. Apply locks the approved active rows in
one workspace and adds only the scheduleInstant property. Rollback locks
active rows in that workspace tagged reviewed-legacy-v1 and removes only that
property. A failed write rolls back the entire transaction. Dates, notes,
durations, completion evidence and update timestamps are preserved. Reload
the calendar preview after applying or rolling back.

Review IDs on the local copy immediately before applying. The approval file
contains IDs, not row versions. The tool rechecks the current rows under lock
for an unambiguous legacy time and skips rows that already have instant
metadata. A tagged row that is soft-deleted after migration can be rolled
back after restoring the row.

## Opt-in server filtering

The week preview calls /api/blocks/range with viewingZone, start, and end.
The server reads an expanded range in the current workspace and filters timed
starts with half-open local-day bounds. All-day and date-only blocks are
filtered by civil date. Unresolved legacy rows retain their scheduling date
and can appear in the review list. The response keeps the original rows and
does not populate the editing cache. The API without viewingZone retains its
original behavior. This endpoint does not project actuals or recurring rules.


## Delivery status

This branch delivers a read-only week preview, provider instant capture, opt-in
range filtering and local migration tooling. General appointment editing and
per-event scheduling zones, floating routines, recurrence, Today and selected-day
views, the itinerary list, actuals and history, reminders, and the other
integrations remain outside this delivery.

The transaction tests use a simulated database client. Run the workflow on a
disposable PostgreSQL copy and verify the browser controls before rollout.
