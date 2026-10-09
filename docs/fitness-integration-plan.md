# DCC fitness integration plan

Status: local proposal and synthetic fixtures, 2026-10-08. No connector, OAuth flow, Android SDK dependency, new permission, health upload or production schema change is implemented here.

## Reconcile the task flow first

Audit base: upstream `main` at `b126acc` (PR #402). The shared checkout was still at `f845ad6`; it was preserved. All registered worktrees were inventoried, including the clean detached `workout-meal-release-qa` at `3d4c208`. Work continues separately on `fix/workout-meal-quick-add` in `.worktrees/workout-meal-quick-add`. Open PR #403 handles collaboration and Invite Links; it is outside this change.

Already resolved upstream:

- [PR #394](https://github.com/ProgrammingDrak/daily-command-center/pull/394): workout/meal registry entries, private owner-scoped activity storage, task-detail entry, Quick Add destinations, plans versus actuals, running pace, meal coverage, exports, recurrence and dashboards. Reuse that implementation.
- [PR #351](https://github.com/ProgrammingDrak/daily-command-center/pull/351): shared 15-minute duration steppers. The remaining reported 30-minute issue was a different path: Quick Add did not pass its duration to the activity creator.
- [PR #401](https://github.com/ProgrammingDrak/daily-command-center/pull/401): compact task detail tabs. [PR #400](https://github.com/ProgrammingDrak/daily-command-center/pull/400): task-action circle. Preserve both surfaces.

Remaining defects fixed locally:

1. Activity creation defaulted to 30 minutes even after selecting another duration in Quick Add. It now receives that duration. Cancellation and failed saves retain the original composer title, type and duration; only confirmed task creation clears the matching draft. The launcher releases its modal state before the activity dialog takes focus.
2. Conversion changed a visible type and toasted success before persistence. It now waits for the saved row, uses the canonical row ID, and distinguishes acknowledged, pending, rejected and normalized results. Existing private workout/meal types remain protected, matching the server's current policy. A separate ordinary Task is the supported alternative; this patch does not detach or erase a log.
3. Logging was present but hidden among dropdown choices and Utilities. Quick Add now exposes **Log workout** and **Log meal**. Its select is labelled **Task type or destination**, since Urgent/Schedule/Whenever are placement choices while Workout/Meal/Habit are record/task types. Existing dashboards and task details remain available.

A workout or meal is still an ordinary DCC task for dates, scheduling and completion, with a private structured activity record alongside it. Logging results does not check off the task. Scheduled minutes, task timer minutes, recorded run elapsed seconds and moving seconds are different facts.

## Provider-neutral boundary

Keep the existing activity record canonical. An adapter should produce a small review candidate, not copy a provider response into task JSON. The local contract in `docs/fitness-preview/model.js` demonstrates:

- Source provider, stable record ID, source revision, data origin, and start instant with an explicit offset.
- Reviewed results date, distance in meters, elapsed seconds and separately preserved moving seconds. Missing metrics remain null; zero is explicit. Elapsed pace uses only positive distance/elapsed pairs.
- Separate gates for source-read authorization, attachment approval and task selection.
- Exact duplicate rejection, changed-source review, and a separate cross-source duplicate confirmation. This is a conservative demonstration, not a complete cross-provider matching algorithm.
- An attachment envelope that reuses the existing `ActivityModel` actual-run shape and retains provenance separately. It leaves the plan, task duration, points and completion untouched.

The actual v1 activity validator intentionally has no run-provenance fields and drops unknown fields. **Do not send this envelope through today's activity PUT and claim provenance survived.** A future additive owner-scoped store must hold run IDs, connector/account namespace, source IDs/revisions, original units and source origin, import time/version, local date/offset, elapsed/moving semantics, and the approved metrics. Commit the source link and actual result atomically under the existing record revision lock. Enforce a unique owner/workspace/connection/source-record identity. Source revisions prompt explicit replace-or-keep decisions; retries cannot append duplicate actual runs.

Use the same task's owner authorization and privacy as existing activity routes. Keep detailed source payloads, routes, heart rate and tokens outside ordinary block JSON, day-state, public exports/feed and Mycelium sync. Imported actuals should not become inferred targets, calories, plan changes or automatic task completion. A task move must preserve the results date and provenance; plan reuse/recurrence copies plans with empty actuals and no source links.

## Connector routes, separately approved

| Route | Future minimal capability | Mapping and practical constraint |
|---|---|---|
| Strava | Own-athlete read access. Start with `activity:read`; private Only You activities require the broader `activity:read_all`, with a separate explanation and approval. No write scope. | Activity ID/revision/start date, `distance` in meters, `elapsed_time` and `moving_time`. Keep recording-device/source attribution when supplied. Show the exact run and target DCC task before attachment. |
| Android Health Connect | A native Android companion/bridge, selected foreground exercise-session and distance reads. | Preserve record IDs and `metadata.dataOrigin`, source application and timestamp offsets. A session's elapsed window does not prove moving time; leave it unknown unless an explicit supported source exists. Do not sum overlapping source records blindly. |
| Other fitness providers/manual adapters | Implement the same reviewed candidate shape. | Provider-specific authentication and source semantics remain in the adapter. No provider SDK is needed for the local task flow. |

Strava's scope definitions and API metrics are documented in [Authentication](https://developers.strava.com/docs/authentication/) and the [API reference](https://developers.strava.com/docs/reference/). The proposed read-only scope is a design decision; private activities need broader access only if the user chooses that feature.

Health Connect uses an Android SDK and per-data-type permissions; the current Express/browser DCC application cannot directly call it as a web OAuth provider. A native bridge is a separate project decision. Foreground-only reads avoid the additional background permission in the first slice. See [Get started](https://developer.android.com/health-and-fitness/health-connect/get-started), [Data types](https://developer.android.com/health-and-fitness/health-connect/data-types), [Read data](https://developer.android.com/health-and-fitness/health-connect/read-data), and [Permissions and data access](https://developer.android.com/health-and-fitness/health-connect/ui/permissions). These are source-backed platform constraints; the bridge architecture is our proposed approach.

## Consent and review flow

1. User explicitly selects a provider; explain the particular metrics and date range to read. Request only approved scopes/types. Authenticate the current DCC owner and validate OAuth state/PKCE where supported. Treat provider tokens and native permissions as grants, never as blanket DCC sharing consent.
2. Read a selected range only after live grant checks. Preview distance, elapsed, moving time, start/results date, source origin and missing values. Select an existing Workout task (or explicitly create one); suggest matches without attaching automatically.
3. User approves attaching the displayed metrics to DCC's private canonical record. For Health Connect this approval also explains that selected metrics will leave the device for DCC storage. Read permission alone does not approve that upload. Commit with expected activity revision and idempotency key.
4. On revocation/disconnection stop reads, discard pending candidates, invalidate access and remove tokens where applicable. Existing saved logs stay private and require an explicit retention/removal choice. Archival is reversible; permanent erasure requires a separately designed and authorized path because current activity storage does not implement it.

## Review now

Open `docs/fitness-preview/preview.html`. Seven URL-fragment scenarios cover a complete run, missing distance, exact duplicate, another-source duplicate, a changed record, a local-midnight boundary, and revoked consent. Invalid fragments fall back to the first scenario. Reset restores that fixture. The consent checkbox and attachment affect memory only; reload discards them. CSP denies network connections. This page is not loaded by `index.html` or `server.js`; its controls initialize only for a local file or localhost. A hosted copy displays a local-preview notice.

Verification commands from this worktree:

```sh
/opt/homebrew/opt/node@20/bin/node --test fitness-preview.test.js task-type-growth.test.js launcher-urgent-menu.test.js activity-model.test.js duration-stepper.test.js
DCC_PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite node --test --test-concurrency=4
PORT=8296 DCC_ACTIVITY_REVIEW=1 DCC_PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite node scripts/ui-review-server.mjs
DCC_CHROMIUM_PATH=/absolute/path/to/chromium DCC_QA_OUTPUT=/absolute/path/to/evidence node scripts/verify-activity-quick-add.mjs http://127.0.0.1:8296
```

The review backend is opt-in, synthetic, in-memory and separate from `server.js`. Choose an unused port; never use the shared local 8090 service or a production database for these checks.

Before a real integration: approve the provider/bridge and grants, review current provider policy/API availability, implement owner-scoped provenance and atomic deduplication, and validate consent/revocation with authorized test identities. Deployment and merge remain separately authorized. No credential or permission setup is a blocker to the completed manual task flow.

## Verified local outcome

- Full Node 20 suite with in-memory PostgreSQL: **2,900 passed, 0 failed, 6 skipped**. Skips are four separate opt-in PostgreSQL suites and two Mycelium-parser checks. Activity PostgreSQL persistence, private HTTP boundaries, recurrence and recovery ran successfully.
- Focused activity/type/duration/import-contract suite: **54 passed, 0 failed**.
- Full lint: **0 errors**, 69 existing warnings. Added/changed test scripts lint without errors or warnings. Browser JavaScript syntax and `git diff --check` passed.
- Existing activity browser walkthrough: eight checks passed, including desktop and 375px forms, unit/pace/nutrition dashboards, actual/plan separation, undo/archive, export, recurrence and owner isolation.
- New Quick Add browser walkthrough: 1440/390/320px logging, duration persistence, cancel/retry draft recovery, protected conversion, and a synthetic meal-save failure/retry passed; no browser JavaScript errors.
- Import preview browser walkthrough: all seven scenarios, invalid-fragment fallback, reload/reset, explicit consent, duplicate decisions, keyboard navigation and 1440/390/320px layout passed. Local-file review made no HTTP requests; a mocked hosted origin was refused the controls.

Evidence is retained in the delegated task workspace at `/Users/drakeshadwell/Documents/Codex/2026-10-08/task-20/`: `full-tests.log`, `focused-tests.log`, `lint.log`, and `activity-qa/`, `quick-add-qa/`, `fitness-preview-qa/` JSON results and screenshots. Reproduce the offline preview checks with `DCC_CHROMIUM_PATH` and `DCC_QA_OUTPUT` using `node scripts/verify-fitness-preview.mjs`.

No local implementation blocker remains. Actual connectors remain a future, separately authorized phase: provider grants, Android bridge selection, owner-scoped provenance persistence and provider-policy review are not implemented. This branch has no deployment or merge authority.
