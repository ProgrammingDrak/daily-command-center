# Private workout Plan & Log: implementation and release readiness

## Scope and current state

Local implementation is complete on `feat/workout-plan-log`, in `.worktrees/workout-plan-log`. It builds on the preserved Quick Add/conversion commit `c3f7ddae7d1161aedda307689f5a3bc4d3cb7954`. The initial audit identified existing workout/meal support in merged PR #394 and 15-minute snapping in #351; neither was rebuilt as a competing task flow. Separate collaboration work and the shared checkout were preserved.

Release status: **LOCAL VERIFIED; PUBLICATION / DEPLOYMENT HELD**. The DCC release queue remains frozen. No push, PR, merge, deploy, new provider grant, SDK permission, credential change or health upload occurred. This document is evidence for the local candidate, not an integration-candidate or production sign-off. Before eventual release, recheck upstream and other queued changes, obtain the existing release gate, run required CI against the actual integration candidate, and verify the deployed revision.

## Usable task flow

- The itinerary exposes an expandable **Plan & Log** button on workout rows. The same planner opens from Workouts & meals. The obsolete workout editor is removed; meal editing retains its existing behavior.
- Catalog identities are distinct from exercise-entry IDs. Bench Press, Dumbbell Curls and Overhead Barbell Press have canonical IDs; deliberate custom creation is owner scoped. Legacy names and entry/target IDs are preserved without automatic catalog mapping.
- Ordered single, superset and circuit groups hold rounds and per-round targets. Planned targets, previous confirmed performance and actual-entry drafts appear separately. Units and load/repetition conventions are explicit.
- **Log set** confirms measured actuals; typing, saving plans, starting, timing and skipping never invent results. Blank actuals do not count. Extra sets, partial sessions and explicit zero measurements are supported. The plan baseline freezes on start or first result.
- Start, round finish, rest, next round, pause, resume and partial/completed Stop persist timestamp events. Round intervals include transitions and pause time. Missing boundaries and uncertain clocks remain unknown; round ordering still applies. Stopping does not complete the itinerary task.
- Templates contain plans only, with collection/variant and source provenance. Starting a session creates a detached plan. Session edits and **Save as new template** preserve the source and historical snapshots.
- Saves enforce owner authorization, optimistic revisions and exact mutation retries. A failed/uncertain save leaves Retry and Reload enabled. Validation errors retain modal inputs. Task moves refresh the first results date while preserving existing results dates, drafts and revision checks. Repeated taps are locked during saves.
- Drafts are memory only. The UI explicitly requires internet for saving and explains that reloading loses drafts. No durable offline outbox is claimed. Saved records and timing recover on reload.
- Workout and meal creation, plan reuse and Make repeat preserve supplied/saved duration. Logging and task completion remain independent.

## Persistence and privacy

`WorkoutModel` v2 remains inside the existing private `task_activity_records` boundary. Plans, actuals, timing, baseline and provenance do not enter public block properties or operation payloads. Exercise/template routes use the existing session-and-workspace owner middleware and private response headers. Custom catalog references, templates and source sessions are checked within the owner boundary. JSON exports preserve complete records; CSV adds canonical/round/status/timestamp/template/timing fields with the existing formula protection.

Schema changes are additive: owner-private exercise/template tables, owner indexes and two last-mutation acknowledgement columns. Existing v1 records receive no bulk migration. Reading upgrades only a UI working copy; an explicit save stores v2. Target IDs remain unique within an exercise entry, matching the valid v1 contract, and the model supports the v1 maximum of 200 planned sets. Meal records retain schema v1.

Ordinary repeat definitions now expose sharing. New personal/health definitions default private; legacy definitions without explicit sharing preserve their previous public default. Private definitions propagate privacy to roots, children, readiness rows, flat/tree materialization, moved overrides and following replacements. Restricting sharing does not resume a paused series or change occurrence identity/placement. Workout-derived repeats are always private. An existing legacy repeat must be explicitly saved Private before relying on private future occurrences.

The actual configured Strength Training records and repeat IDs were not changed by implementation or QA. Both commute repeats remain paused. The privacy patch must be deployed and verified before their separately authorized configuration/resumption is considered. Old imported Calendar meeting reconciliation remains outside this feature.

## Verification evidence

Final local verification uses Node 20 and a disposable PGlite PostgreSQL runtime, not the shared local or production database:

| Check | Result |
| --- | --- |
| Complete repository suite | 2,995 passed, 0 failed, 6 environment-dependent skips; 3,001 tests total |
| Workout model | 32 passed |
| Private workout PostgreSQL/HTTP contracts | 17 passed |
| Actual planner controller/event-handler regressions | 13 passed |
| Repeat privacy inheritance regressions | 25 passed |
| Full repository ESLint | 0 errors; 69 existing warnings |
| New workout browser modules, explicit browser globals | 0 errors, 0 warnings |
| New browser regression script | Syntax and focused lint passed; standalone script not executed in this session |
| Browser QA through CUA | Desktop plus 375px/320px workout checks passed; 375px meal closeout passed; no browser JS errors |
| Five-lane pre-review | Correctness, security, consistency, performance and test-quality verification clear after fixes |

Meaningful tests cover owner/workspace isolation, detached templates, catalog identity and repeated entries, null versus zero values, load/unit conventions, plan-only recurrence, immutable baselines/timing prefixes, exact retry acknowledgement, multitab conflicts, task moves, archive/restore, deleted-history retention, exports, legacy upgrades, missing timing and cross-group extra sets. PGlite serializes transactions: these results do not establish a live multi-process PostgreSQL lock-race test. The six unrelated skips require a separately configured live test database or Mycelium parser.

The change exceeds 1,000 lines including added regression files. Review used five concern lanes and independent second-pass verification rather than claiming exhaustive whole-repository review. Fixed findings include disabled recovery buttons, dialogs closing on validation failure, stale moved-task result dates, unordered missing-boundary rounds, valid legacy incompatibility, unrelated-group extra-round selection, repeated history fetches and repeat privacy inheritance failures.

Browser observations: searchable two-round superset; blank logs rejected; explicit actual log persisted; invalid fractional extra reps and negative run time retained for correction; persisted reload recovered actuals/timing; rest/pause/partial Stop worked; template detachment and previous performance stayed separate; selected 60-minute duration and private repeat default remained. Mobile columns stack, the inline planner spans the row, controls meet 44px height and measured planner/dialog widths show no horizontal overflow at 375px and 320px. Meal validation retained drafts, corrected explicit zero persisted with unknown nutrients blank, planned calories remained unchanged, Undo restored the prior record, and archive/restore worked at 375px.

Evidence is saved in the Codex task output directory: `workout-closeout-tests.log`, `workout-lint-final.log`, `workout-browser-lint.log`, `workout-ui-focused-final.log`, `workout-backend-focused.log`, `workout-privacy-checkpoint.log`, `workout-desktop-verified.png`, `workout-mobile-verified.png`, `workout-meal-closeout-verified.png`, and `workout-readiness.json`. Earlier failing intermediate logs are superseded by final results. During reconnect verification, one unrelated `delete-contract.test.js` assertion received an empty HTTP body; its isolated 37-test suite and the subsequent complete suite passed without changes to that file. The cause of that transient response was not established; the failing log remains available in `workout-full-tests-final.log` alongside `workout-unrelated-delete-recheck.log`. The disposable preview used dedicated port 8197 with synthetic in-memory fixtures and was stopped after QA; its browser tab was closed.

## Rollback boundaries and demonstrated recovery

1. **Before any v2 writes:** reverting the feature code is safe for the existing v1 payload contract; additive unused tables/columns can remain. Do not drop tables or rewrite activity records as a routine rollback.
2. **Per-record migration recovery:** independently tested with real PostgreSQL semantics: create a canonical v1 workout with original freeform names/IDs, null/zero values, actual sets/runs and original results date; upgrade; save at the expected revision; Undo; reload; assert exact equality with the original v1 payload. Undo retains only the previous saved edit, not an arbitrary revision history.
3. **Schema reapplication:** the test reruns the additive schema twice after inserting a v1 record, then asserts the payload is unchanged and all private tables exist.
4. **After new v2 writes:** keep v2-compatible readers/validators and the private tables. Prefer a corrective release or a compatibility-preserving rollback. A blanket return to the old v1-only editor is not a verified safe rollback for new v2 sessions. Export affected records before repair; production backup/restore evidence and any migration repair require the release process and appropriate authority.
5. **Operational privacy:** keep both commute repeats paused throughout any rollback. Verify persisted definition sharing and newly generated roots/children on the deployed candidate before resuming them. A local test pass does not prove production future-repeat privacy.

No production backup, restore, data repair or deployed rollback was attempted. Those remain release-gate evidence, separate from the demonstrated local per-record recovery.

## Deferred provider integration

The existing `fitness-integration-plan.md` and synthetic `fitness-preview/preview.html` remain the separate connector plan. This implementation does not expand or activate Strava/Health Connect. Run task metrics, source provenance, consent and deduplication require a separately authorized provider integration; the preview envelope must not be treated as an existing authorized health upload API.
