# Shared task participation — accepted occurrences and scheduled routines

A shared occurrence links ordinary, privately owned DCC tasks. The source owner explicitly invites an existing accepted friend; acceptance creates that person's own private dated task. The original task checkbox, completion revision/idempotency contract, offline outbox, history and rewards remain authoritative. Completing or reopening one participant's task never writes another participant's task. Cards show profile icons, accessible completion labels and a completed count; the badge remains visible on completed cards. Shared tasks is available in the header and mobile More menu.

For a saved workout, the invitation dialog previews an optional immutable instruction snapshot. It copies movement order, names, sides, authored visual/spoken cues, group structure and suggested pacing into a detached recipient Plan & Log. It excludes personal weights/reps, measured targets, actual results, notes, timing, baseline, provenance and private catalog references. The user can explicitly omit instructions; an empty workout clearly says it has no saved instructions. The owner must review the current snapshot hash before including it. Later edits never rewrite an accepted session. Guided Routines operates on the recipient's normal private record.

## Scope and privacy

The invitation explicitly chooses **this occurrence** or **this recurring routine**. Scheduled single-task routines can be accepted once. An explicit bounded sync reuses the existing recurrence materializer, stable occurrence identities, series locks and tombstones, then creates new private participant tasks and detached instruction records for that date. Completed earlier dates are never reset or overwritten. GET remains read-only. Generation covers today through fourteen days ahead; historical reads do not manufacture missed tasks. A routine's immutable reviewed instruction/title snapshot is reused, so later private plan edits are not automatically disclosed.

Leaving/removing a participant revokes the whole routine and its shared projections while retaining existing private tasks/logs. Friendship/block and workspace ownership are checked again for materialization and reads. Individually accepted occurrences cannot silently become series grants. Adding someone on a later series occurrence addresses the original routine invitation. Pausing, ending or deleting a definition stops new generation. Deleted dated source tasks reserve their occurrence IDs.

MVP limits: readiness-based repeats and multi-task template trees use occurrence invitations only. Replacing a series definition (including edits that create a following-series definition) requires a new explicit invitation; it is not auto-followed. Declined/removed series grants cannot be reopened; a new routine is required. Existing prepared private tasks remain after pause/revoke, and rescheduling/renaming is private to each task. There is no background catch-up for days when nobody opens the app. Dates use DCC's configured timezone and the existing rule timezone conversion, not each participant's separate local clock.

Participation gives no workspace, coach, public-link or general activity access. Session identity and workspace ownership are checked; only existing accepted friends can be invited. Pending invitees see the invitation and its deliberately included instructions, not peer completion. Accepted participants see names/avatars and completion status only. Blocked pairs, revoked membership, deleted occurrence source tasks and lost workspace ownership deny future reads (a series invitation remains manageable after its first source task is deleted). Membership removal retains the person's private task and workout history. Declined/removed invitations cannot be silently reactivated; use a new occurrence or routine.

The existing `social-store` relationship helpers accept a transaction client so the same friend/block checks run inside the atomic invitation/accept transaction. Canonical block/task writes in a workspace containing participation tasks require that participant's owner identity, including legacy WAL/batch paths; existing authenticated owner service identity is retained. No new role grants the ability to complete another person's task.

Private, no-store responses are filtered to the viewed date (plus pending invitations and routine management anchors). Workspace-scoped SSE carries only an empty invalidation, followed by an authorized read. A visible-page 15-second refresh, reconnect, date-change and online refresh recover missed/duplicate events. Peer indicators are cleared when a refresh fails; each person's ordinary task remains usable offline. Invitation/accept writes require a connection and retain visible retry/error controls. Duplicate accepts serialize on the occurrence and create no duplicate task/log. No external notification delivery or push registration is added.

## Relationship to PR #403

PR #403 (`feature/dcc-accountability-completion`, inspected at `b00c762`) links one accountable owner's task to helper/coach/manager collaboration, with comments/check-ins/evidence and friendship Invite Links. Its linked completion projects that one owner's canonical checkbox; collaborators do not receive their own task to complete.

This MVP is independent, not a dependency or replacement: the participants are all doers with separate owned tasks and private activity records. It reuses the same account, relationship, block/completion and SSE infrastructure. It creates no new friend-link system. The two PRs overlap in card/header, server/schema mount, mobile menu and relationship-helper files; reconcile those hunks and make the distinction between helping someone and doing a task together clear before shipping both. Neither branch should be merged automatically into the other.

## Storage and verification

Boot-time schema adds `shared_task_occurrences` and `shared_task_participants` plus optional instruction snapshot, series definition/parent and occurrence-key columns. No existing rows are migrated. Retain additive tables on rollback; participant-owned tasks and activity records remain useful independently. Do not drop tasks or logs when revoking access.

Run:

```sh
DCC_PGLITE_MODULE=/path/to/@electric-sql/pglite node --test --test-concurrency=4
npm run lint
PORT=8317 DCC_ACTIVITY_REVIEW=1 DCC_SHARED_TASK_REVIEW=1 DCC_PGLITE_MODULE=/path/to/@electric-sql/pglite node scripts/ui-review-server.mjs
DCC_QA_OUTPUT=/path/to/evidence node scripts/verify-shared-tasks.mjs http://127.0.0.1:8317
```

All records, friendships and sessions in these checks are fictional and in memory. Tests cover separate completion/reopening, exact retries, stale revisions, repeat-occurrence isolation, accepted-series generation, DST/date boundaries, pause/end/tombstones, snapshot sanitization and detached guidance, private logs, session/tenant/member isolation, block/revoke/delete, rollback, SSE targeting and client failure recovery. Browser QA uses separate temporary headless Chromium profiles, including an offline completion and mobile controls. It does not touch existing Chrome tabs.

Verification limits: PGlite serializes transactions and does not prove multi-process PostgreSQL races. Synthetic session injection does not verify real Clerk sign-in. Physical-device WebKit and production migration/canary checks remain release gates. No real invitations or notifications were sent.
