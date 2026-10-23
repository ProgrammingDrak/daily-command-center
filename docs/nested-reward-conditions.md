# Nested shared-task reward conditions

## Design and release boundary

Branch `codex/nested-reward-conditions` starts at PR418 head `b09dfc8942d5b63da1e7106811d20878c6d0eff1`, verified open on GitHub on 2026-10-22. PR419 was separately open at `e92ed6c5002448c8b989491a4770c2559e3dfe0a`. No existing checkout was changed. The local repository is an independent clone with its auxiliary checkout inside `.worktrees/`. No merge, push, deployment, production migration, credential operation or announcement was performed.

PR418 is a dependency for composer state/focus behavior. PR419 is not a dependency. The release coordinator owns integration and the security hold.

## Product contract

- Existing single-task offers (no `condition`) retain their existing approval/slot behavior. A task's collapsed **Offer reward** form now includes an optional **Group tasks (ALL / ANY)** editor.
- A group uses ALL/AND or ANY/OR. Children may be tasks or further groups, with mixed operators. A task may appear only once across the entire tree; aliases are canonicalized before checking duplicates.
- Every group must have at least one child. Invalid operators, unavailable/private tasks, duplicate aliases, cycles, reused nodes and oversized trees are rejected server-side. The iterative algebra accepts up to 256 total nodes, allowing 255 nested groups around one leaf. There is no separate shallow depth limit. IDs are bounded to 200 characters and titles are canonical server snapshots, not client assertions.
- Every leaf is bound to the offer's selected shared day and canonical task/block identity. This means a recurring task refers to that occurrence, never its whole recurrence definition. A task moved off the selected day, removed, made private, or no longer shared counts as unmet. An unmet child can still be bypassed by a satisfied ANY sibling. A revoked share pauses eligibility.
- Owner approval saves agreement to the submitted condition; it does not put conditional offers in slot rotation. Conditions are immutable after submission. Edit groups in the draft; dismiss and submit a new offer to renegotiate terms.
- Eligibility uses current completion, including the existing canonical-row and legacy day-overlay rules. Reopening before evaluation makes the leaf unmet. Completion/private/delete changes to canonical rows serialize with the earning transaction via shared row locks. Legacy nonmaterialized schedule enrichment is read immediately before the transaction. The existing view's current-visibility rules remain the source of truth.
- Resolve on owner reward-queue and shared-offer reads, including the refresh after approval. This is durable reconciliation, not a completion-event-only hook. Work completed and reopened entirely between reads does not earn a reward. No background scheduler is added.
- Once earned, the reward is retained even if tasks reopen or disappear. There is one queue item per offer, regardless of how many ANY branches complete. Earning, won ledger event, queue insertion and earned marker commit together. Existing owner-only queue transitions prevent repeated redemption. Two separate offers are deliberately two rewards.
- Offer POSTs accept a stable request key. The unique share/actor/key index and request fingerprint deduplicate concurrent requests and accepted-but-lost responses, while rejecting changed terms under the same key. Anonymous keys use a stable guest scope (session IDs may rotate before a guest has a cookie). New random keys represent distinct offers.
- Reward drafts and retry identity persist in sessionStorage under share/day/viewer scope. They survive reload in the same tab. Submission is online-only and never auto-sends an unsent offer. Failed sends retain the draft. In-flight controls remain disabled across live rerenders; late responses from a prior viewer cannot erase a new viewer's draft.
- Public previews replace currently unavailable task titles with “Unavailable task”. Internal actor/request metadata is not included in public share payloads.

## Storage

The existing `todo_sponsorships.offer_settings` JSONB carries `condition`, request identity/fingerprint and earned metadata. No existing rows are backfilled and no existing reward is converted. One additive partial unique expression index supports request identity. It is declared alongside the existing idempotent share-table initialization. The existing `reward_events` unique index is the award arbiter. `socialStore.enqueueReward` now optionally participates in the caller's transaction while retaining its standalone behavior.

## Validation at first implementation commit

- PASS: `npm test` — 3,112 passed, 12 skipped, 0 failed (Node 24.13.1 installed on host; package declares Node 20–22).
- PASS: isolated PostgreSQL 16 test database on localhost:58371, `conditional-reward-postgres.test.js` and `sponsorship-postgres.test.js` — 15 passed, 0 skipped. Synthetic schema only, removed after each test. Verified authorization, canonicalization, duplicate submits, rollback after queue insert, undo/missing tasks, read errors, concurrent reconciliation, repeated redemption and pagination past 100 unmet offers.
- PASS: `reward-conditions.test.js` — exhaustive four-leaf truth table, invalid input, alias duplicates, cycles and 256-node boundary.
- PASS: `scripts/verify-nested-rewards.mjs` — five browser groups, synthetic API: mixed nested edits, disclosure/refresh, reload, 1440px/390px layouts, lost-response retry, in-flight controls, empty-group rejection. Screenshots in `test-results/nested-rewards/`.
- PASS: existing `scripts/verify-shared-todo-composers.mjs` — all seven groups.
- PASS: runtime syntax checks and `git diff --check`.
- Initial sandbox-only suite had localhost socket EPERM failures; rerun with socket permission passed. Two existing source-slice fixtures were updated to supply the newly referenced optional execution context; their original assertions remain intact.
- Build/type checks: repository has no build or typecheck script (plain JavaScript served directly). Production boot/migrations/canary were not run.

Subsequent commits add the separately requested shared-task reaction and header/suggestion UI changes; final combined validation is recorded separately.

## Shared UI and suggestion behavior

- Reactions render for open and completed tasks. Desktop controls reveal on card hover or keyboard focus; touch/coarse-pointer devices have a visible React disclosure. Counts and existing data remain unchanged. Repeated sends are gated while pending. Anonymous actor identity is now persisted in the existing session so repeated reactions refer to the same actor with `saveUninitialized:false`.
- Task-type pills are inclusive multi-select filters, initially all selected, with Show all/Remove all. Open and Done are independent status pills. With rewards is optional. Calendar selection, ordering and export remain in a secondary disclosure.
- Suggest a Task opens the existing DCC overlay controller. It reuses main task-entry duration choices and the existing time-wheel input. Suggestions remain owner-reviewed triage proposals; they never schedule a task automatically. Duration and optional suggested time/date/timezone are persisted; the time also appears in the proposal summary for existing review UI.
- The modal restores focus on close, traps keyboard focus, keeps unsent drafts through cancel/reload in the same tab, and disables repeated submission while pending. Server errors retain the draft and exact request identity. A reusable time picker previously remained inert after reopening its parent modal; its inert state and nested keyboard/focus behavior are fixed here.
- A new additive `todo_task_suggestion_requests` receipt table atomically deduplicates modern suggestion requests with the triage append. A per-share transaction lock handles concurrent retries across midnight. The append locks the current day row and preserves private/scheduled state and ownership. Daily limits and active-share checks are enforced. Legacy clients without request keys retain their existing route behavior.
- Reward task checklists populate lazily on disclosure; the UI enforces the same 256-node resource budget as the server.

## Multi-person completion integration

Read-only inspection of local commit `6945838f0ce34bf62b45d138a30de977886e0e44` confirmed that participants retain separate owned task rows and independent completion. This branch does not copy or modify that implementation. Reward leaves continue to mean the shared task owner's dated completion state. Participant counts, avatars and All done are separate presentation; private participant tasks must not become selectable public reward leaves. The release coordinator should reconcile overlapping `index.html`, `social-store.js` and shared-task routes/UI, then run the combined candidate checks. PR418 remains the base dependency; PR419 and multi-person completion are not prerequisites for this branch. Both PRs were rechecked open at their original heads during final validation.

## Final combined validation

- PASS: `npm test` — 3,113 passed, 13 skipped, zero failed. Skips are environment-dependent; database-backed feature tests were run separately with PostgreSQL enabled.
- PASS: `npm run test:postgres` on PostgreSQL 16 — 48 passed, zero skipped/failed; the three focused feature suites account for 16 checks. Includes suggestion concurrency, identical retry across midnight, duration/time persistence, active-share denial and failure rollback, plus nested reward authorization, aliases, earning/ledger rollback, pagination, concurrent earning and repeated redemption.
- PASS: lint — zero errors, 69 existing warnings. All changed JavaScript runtime syntax checks and whitespace checks pass.
- PASS: nested reward browser suite (5 groups), reactions (2 groups), suggestions/filter/modal (4 groups), and existing shared composer regression suite (7 groups), using synthetic APIs and fresh local Chrome profiles. Desktop/mobile screenshots are in `test-results/nested-rewards/`, `test-results/shared-reactions/` and `test-results/shared-suggestions/`. The suggestion test selects 2:30 PM through the actual shared wheel, tests nested Escape/reopening, cancellation/focus restoration, error/reload retry and repeated submission.
- PASS: deliberately inverting ALL/ANY evaluation causes the truth-table suite to fail; restoring the evaluator passes. Browser verification likewise caught the reusable picker inert-state defect before its fix.
- Earlier combined-suite failures were source-slice test fixtures missing the new timezone and animation-frame globals. Fixtures were corrected without removing their assertions; the final full suite passes.
- NOT RUN: standalone build/typecheck, because this plain-JavaScript repository defines neither script. Production boot, production migrations, remote CI and combined-release verification were not run. Initial checks used Node 24.13.1; supported Node 20.20.2 recovery checks are recorded below. The new database suites are included in `test:postgres` for CI.
- Release hold remains with the coordinator. No merge, deployment, credential changes, production database writes or Slack announcement occurred.

## Recovery and integration handoff — 2026-10-23

The Mac disconnected before the final composer rerun/commit on October 22. On reconnect, the original two commits and all uncommitted changes were intact. A tracked binary patch and a separate archive of the five untracked source/test files were saved in `/tmp/dcc-nested-recovery-20261023.patch` and `/tmp/dcc-nested-untracked-20261023.tar.gz` before continuing; nothing was discarded or recreated.

Fresh checks used supported Node 20.20.2:

- Full suite: 3,113 passed, 13 skipped, zero failed. The first Node 20 run had one `fetch failed` in the unchanged `tasks-open-route.test.js` localhost harness; that file passed all 12 tests in isolation and the complete rerun passed without code changes.
- All PostgreSQL suites: 48 passed, zero skipped/failed, against synthetic PostgreSQL 16 on localhost:58371.
- All 18 browser groups passed: existing composers (7), nested rewards (5), reactions (2), suggestions/pills/modal (4). The interrupted composer check is now resolved against the correct localhost:8328 preview.
- Lint: zero errors, 69 baseline warnings. Changed JavaScript syntax and whitespace checks passed.
- No standalone build/typecheck scripts exist. Production boot/migrations, release integration and remote CI remain not run.

The parent reports combined readiness candidate `d06559f90333df4f2d0ea85a0a0c24fc2bdf6b72`, containing PRs 403/410/411/418/419/420 and a priority/scheduling race fix. That object is not in this independent clone; it was not modified or represented as locally tested.

Safe integration procedure:

1. Preserve the cloud candidate and its existing checks. Fetch the supplied local bundle into a new review branch/ref; do not replace files wholesale or reset the candidate.
2. In a fresh integration checkout of the candidate, cherry-pick only the three feature commits after `b09dfc8942d5b63da1e7106811d20878c6d0eff1`, in order. Do not reapply PR418 ancestors already present there.
3. Reconcile overlapping shared-task routes/UI, `social-store.js`, `db.js`, `index.html`, and common overlay/time-picker code. Preserve the candidate's priority/scheduling race fix and multi-person completion/notification changes. Reward eligibility remains the owner's dated task completion, separate from participant counts.
4. Rerun the combined candidate's full suite, PostgreSQL tests, these four browser scripts, scheduling/priority and participant/notification regressions, lint, then exact-candidate CI. Inspect conflict resolutions and review the additive suggestion receipt table and reward request index before any release.
5. Keep the Railway security hold and production verification gates with the release coordinator. This branch is local only; no push, merge or deploy was authorized in the recovery request.
