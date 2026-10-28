# Move tasks into configured time blocks

## Plan and integration

1. Inspect both supplied screenshots and the shared Move task picker.
2. Use a new isolated `feat/move-task-time-blocks` worktree from production/main
   `aa859bd26540c528305a61023fef148c91264bc7`.
3. Replace move presets with current workspace block names/start times, and append
   through the existing transactional rescheduler with a fresh capacity check.
4. Verify pure rules, real PostgreSQL routes, browser lifecycle and reload;
   obtain independent review, then publish a draft pending release gates.

PR #435 (`fd3d9f3`) and floating-workspace compatibility (`0e2a943`) remain untouched.
This change needs neither branch. Its tracked patch applies cleanly to both
candidates. They can integrate separately; rebase and rerun candidate checks if
main advances before this change is released. No unrelated branch was merged.

## Behavior

- Move task shows the selected day's active, valid configured blocks as a list
  of names and start times. Duplicate names/start times retain distinct block IDs.
- Configuration is read from authenticated workspace rows; no defaults are seeded.
  Empty, disabled, invalid and inactive blocks do not become invented suggestions.
- A selection appends after existing task work intersecting that block. Fixed
  calendar meetings, breaks, and out-of-office windows remain occupied; the new
  task skips a conflict only when its full duration still fits within the block.
- Today starts no earlier than the next quarter hour in the app timezone. Past
  days, invalid/unknown/nonpositive estimates, unsafe nested timing, running or
  completed work, DST-ambiguous windows and overflow fail explicitly. There is
  no automatic overflow, estimate truncation, displacement, or next-day fallback.
  The current timed-move representation requires an end before midnight; an
  exact-midnight landing is refused. Other blocks and manual entry remain available.
- Re-selecting a block where the task already fits leaves its position unchanged.
  Repeated requests use a saved receipt; lost-response recovery returns the whole
  moved subtree and origin marker. Later changed timing invalidates that receipt.
- Commit rechecks config, source membership/completion, occupancy and clock time.
  Short transaction table locks cover both blocks and day-state inserts, including
  writers that do not use this placement API. Lock waits are bounded at three
  seconds. This deliberately trades brief cross-workspace write serialization for
  strict fit protection; reads remain available.
- Failed block saves stay in the dialog with an inline explanation and are never
  replayed from the offline WAL. No success is reported before the saved timed row
  is returned. Actual logs, task IDs and occurrence identifiers are preserved.
- Manual entry and Earliest free remain. Same-day manual timing now uses the
  durable mover too, fixing the local-pin-only success that left tasks Unscheduled.

## Validation

- Both user PNGs were materialized locally and inspected before UI changes.
- `npm test`: 3,173 tests, 3,160 passed, 13 environment-gated skips, zero failures.
  One earlier run had a transient HTTP fetch failure in triage-suppression tests;
  its 26-test isolated rerun and the subsequent full run passed.
- `npm run lint`: zero errors, 71 existing warning-class findings.
- Focused placement/carryover tests with disposable PostgreSQL: 36 passed.
  Includes concurrent selection, stale config/occupancy, account isolation,
  subtree replay, completion overlays, recurrence identity and durable timing.
- `npm run test:postgres` against disposable localhost PostgreSQL: 39 passed.
- `scripts/verify-time-block-placement.mjs`: eight browser checks passed in Chrome
  at 390px, with no page exceptions. Includes double click, edited title, reload,
  cancel/back/reopen, changed/repeated/disabled/empty configs, manual entry,
  overflow and failed saves. Uses production routes and an isolated test schema.
- Independent read-only review: no remaining blocking findings; reviewer separately
  passed 30 focused tests. Its HTTP checks could not bind a port in its sandbox.
- Shared `smoke-ci.mjs` assertions run with installed Chrome: two failures. Both
  reproduce on an unchanged archive of `aa859bd`: planned purchase categorization
  and the synthetic review server returning HTML for app-config.js. This is not
  claimed as a passing full-app smoke gate.

## Release state

Draft only. Production health was verified healthy and still serving `aa859bd`.
The previously Unauthorized production-backup check was not retried and is not
waived. Fresh explicit approval of this PR and successful required release gates
are still needed. No approval, merge or production deployment was attempted.
