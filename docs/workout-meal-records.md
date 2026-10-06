# Workout and meal records

Implemented on `feature/workout-meal-records`, based on `5c8629a` (#392). This feature has not been published or deployed. All development records and screenshots use disposable synthetic fixtures; no production health records were written.

## Using it

- Open **Workouts & meals** (under **More** on mobile), or choose Workout/Meal in Quick add. Existing task details can also start a private activity record.
- Plan exercises and sets, then log any number of actual sets against each planned set. For example, 10 reps at 50 lb planned can have separate actual rows for 5 at 50 lb and 50 at 25 lb. Unplanned actual sets and runs are supported.
- Runs store distance with m/km/mi and elapsed seconds. Strength entries store reps and lb/kg. Dashboard units can change without rewriting the entered units.
- Meals have separate planned and consumed foods, portions, calories, protein, carbs and fat. Nutrients refer to the whole entered portion. Enter a source and mark known/estimated; leave missing nutrients blank. No nutrients or actual results are inferred from a plan.
- Saving results does not complete the ordinary DCC task. Task completion, scheduling, points and recurrence retain normal task semantics.
- **Reuse plan** creates a new task with no actuals. **Make repeat** snapshots the saved plan into DCC's existing repeat system. Scheduled, readiness and manually scheduled repeats copy that plan, with empty actuals. A following-series split copies the series snapshot even if the original source task was archived.
- Remove individual rows with immediate undo; undo the last saved edit; archive/restore entire records. Ordinary task deletion retains its activity history through routine tombstone cleanup. Removed-task history stays visible in Records, and normal task recovery restores the task.

## Storage and Mycelium

DCC is the canonical store. `task_activity_records` is linked to `blocks.id`, scoped by workspace and owner, and contains versioned JSON for the plan, actuals, results date, optimistic revision, previous-edit snapshot and archive state. Startup `pg-schema.js` creates the table and index idempotently.

Ordinary task JSON holds type/privacy and optional source-plan IDs only. Detailed logs are absent from block operations, ordinary day-state, and vault synchronization. Moving a task does not change its results date. The explicit results date lets a moved task remain scheduled on one day while its logged workout or meal belongs to another.

Mycelium remains suitable for narrative notes and reflections. A later integration can store local references from a note to a DCC task ID (and a note slug on the DCC side), resolving structured data through the owner-authorized DCC API. This implementation does not add those links, duplicate canonical records, or send health records to Mycelium or a nutrition service.

## Dashboards and exports

The dashboard follows DCC's selected day and shared date picker, with Today/7 days/30 days/custom ranges (maximum 366 days). Today uses the boot-loaded DCC day, including when its local date differs from UTC.

- Workout completion is completed/scheduled workout tasks. Consistency counts days with actual records, independently of task completion.
- Exercise trends show sets, reps, maximum load and weight-times-reps volume for the same normalized exercise name. Volume includes only complete weight/reps pairs and shows coverage. There is no combined strength score.
- Running shows planned/actual distance and time, plus pace from summed time divided by summed distance for complete positive pairs. It does not average pace averages.
- Daily meals show planned and consumed totals for each nutrient, each with known/total food coverage and estimated counts. Missing is displayed as a dash, distinct from an explicitly entered zero. Totals describe logged food, not assumed full-day intake.
- Owner-only JSON exports preserve the complete record. CSV preserves individual sets/foods/runs, links, units, source/state and blank unknown values; formula-like text is escaped.

## Privacy and recovery

Every activity route requires an authenticated session and workspace ownership. Workspace viewers, other owners, header-only identities and service bearer tokens cannot access this API. Responses use `Cache-Control: private, no-store`. Records are also scoped in store queries, including reuse and exports. Workout/meal task types are forced private on create, edit and reschedule; generic stale writes cannot detach the type. Feed publishing treats these types as private.

Writes use row locks and expected revisions; concurrent stale edits return 409. Record changes keep one previous snapshot. Unsaved editor drafts live only in page memory and disappear on reload. Archiving excludes records from dashboard totals without destroying them. Routine task purging retains recorded tasks and their parent chain. Permanent health-record erasure is not implemented; archival is the reversible removal path.

The application remains online-first. There is no nutrition lookup, automatic estimation, medical advice, target setting or production data seeding. Exercise names are manually entered; differently named exercises remain separate. Repeat plans are snapshots; editing the original task does not silently change an existing series plan.

## Verification

- Node 22.23.3 full suite: **2,792 passed, 0 failed, 4 unrelated integration tests skipped** (2,796 total, including the activity PostgreSQL suite). Two skips require a separate PostgreSQL service and two require a local Mycelium parser checkout.
- PostgreSQL behavior was exercised using an isolated PGlite PostgreSQL engine with the full production schema and real stores/routes: owner scoping, stale revisions, concurrent submissions, archive/restore/undo, recurring plan snapshots, following-series edits, move preservation, task deletion/recovery and cleanup retention.
- Lint: **0 errors**, 67 existing warnings. This Express/vanilla-JS repository has no build script.
- Chromium desktop and 375px mobile: multiple actual sets saved against one plan; unit conversion and pace; partial meals; no horizontal page/dialog overflow; shared date picker and empty range; persisted undo; archive/restore; CSV download; plan reuse; Make repeat; unauthenticated/viewer/cross-owner denial. No browser JavaScript errors.

### Reproduce without production access

Install `@electric-sql/pglite` outside the repository (or use a dedicated localhost PostgreSQL database). Set `DCC_PGLITE_MODULE` to its absolute module directory and run `node --test --test-concurrency=4`. Alternatively set `DCC_TEST_DATABASE_URL`; the helper rejects non-local hosts and creates/removes an isolated test schema.

For browser QA, set `DCC_ACTIVITY_REVIEW=1`, `DCC_PGLITE_MODULE`, and `PORT=8199`, then run `node scripts/ui-review-server.mjs`. This opt-in backend uses production routes with synthetic fixtures and an in-memory database; it is never mounted by `server.js`. Set `DCC_CHROMIUM_PATH` to an installed Chromium executable and optionally `DCC_QA_OUTPUT`, then run `node scripts/verify-activity-ui.mjs http://127.0.0.1:8199`. Restart the review server before each run to reset its fixture database. The script refuses a non-local server or one that does not declare synthetic, in-memory storage.

### Rollout

Production approval is still required. Normal schema startup is additive; include `task_activity_records` in database backups. Deploy the server/schema and client assets together. Retain the table and its data if reverting the UI. No credentials or external service setup are needed for manual logging.
