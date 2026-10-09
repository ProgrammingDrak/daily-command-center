# Private workout Plan & Log

Workout rows expose Plan & Log inline and from Workouts & meals. Quick Add exposes workout and meal logging; creation, reuse and Make repeat retain the selected duration. Conversion reports success only after the stored task type is acknowledged.

The planner separates planned targets, previous confirmed performance and actual results. Canonical catalog IDs are separate from session entry/target IDs; legacy names and IDs remain unchanged. Ordered single, superset and circuit groups support rounds, per-round targets and explicit measurement conventions. Log set confirms actuals; typing, saving plans, starting timers and skipping do not create results. Blank measurements remain unknown and explicit zero is valid. The plan baseline freezes on start or the first result.

Start, round finish, rest, pause, resume and partial/completed Stop persist timestamp events. Missing or uncertain timing remains unknown. Timer history has a separate bounded budget and reserves capacity for Stop; stopping does not complete the itinerary task. Templates hold plans only, with collection, variant and source provenance. Sessions detach from templates; edits and Save as new preserve original templates and history.

Saves require internet, owner authorization and optimistic revisions. Exact mutation retries recover uncertain acknowledgements. Failed saves retain Retry and Reload controls; validation retains modal inputs. Drafts remain page-only and reload discards them. Saved records and timing recover on reload. Shared catalog/template/history resources avoid repeated reads and refresh other open planners after confirmed writes.

## Storage and sharing

Workout v2 records remain in owner-private task_activity_records; plans, actuals, timing and provenance stay outside public blocks and operation payloads. New exercise/template routes inherit existing session/workspace-owner middleware and private response headers. Exports preserve records and CSV formula protection.

Schema changes only add private exercise/template tables, an owner index and nullable mutation acknowledgement columns. No bulk record migration occurs. Reading v1 upgrades a working copy; explicit save writes v2. Meals retain v1. The legacy 200-set limit and entry-scoped target IDs remain compatible.

Repeat sharing propagates to roots, nested children, readiness rows, moved overrides and following replacements. New Personal/Health definitions default Private until sharing is explicitly chosen. Existing definitions without sharing retain their legacy Public default. Activity-derived repeats are forced Private. Scheduling preserves explicit sharing through the serializer and persistence boundary. Saving Private does not resume a paused series or replace occurrence IDs.

Both configured commute series must stay paused until the deployed definition and generated-instance privacy are verified. Existing October 13/16 occurrence IDs, placements and workout history must be preserved. Calendar reconciliation and provider activation are separate work.

## Verification and release

Verification uses Node 20, isolated PGlite PostgreSQL semantics, actual controller handlers and synthetic browser fixtures on a dedicated port. Tests cover owner isolation, detached templates, null/zero values, immutable baselines and timing, stale revisions, exact retries, moves, exports, upgrade/Undo, archive/restore, timer capacity and private nested/future task persistence. Desktop and 375px/320px QA covers logging, validation/recovery, templates, timing and duration. PGlite serializes transactions; this does not prove live multi-process lock races.

Run npm test and npm run lint. Configure DCC_PGLITE_MODULE for isolated database tests, or DCC_TEST_DATABASE_URL for a disposable PostgreSQL database. Optional browser scripts use the opt-in DCC_ACTIVITY_REVIEW backend and fictional fixtures. Do not point them at production.

Release requires current-base CI, content-bound reviews, exact-candidate QA, a validated production backup, additive schema acknowledgement and exact deployed revision plus functional canary. Task-workspace evidence retains full logs, screenshots, reviews and any transient failures; the release report records the final result.

Before v2 writes, reverting code can leave unused additive schema in place. Undo restores the previous saved payload and schema reapplication preserves v1 data, as tested. After v2 writes, retain compatible readers and private tables; prefer a corrective release. Do not drop tables, bulk downgrade records or claim a production restore from local Undo tests. Keep commute repeats paused during any privacy rollback.

## Separate connector plan

See fitness-integration-plan.md and the fictional fitness-preview fixtures. Strava/Health Connect integration is deferred. No new OAuth grant, SDK permission, credential or health upload is enabled by this feature. Run metrics, source provenance, consent and deduplication need separate provider authorization.
