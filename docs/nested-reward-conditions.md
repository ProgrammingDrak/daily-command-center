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
