# Daily Command Center Social Features Plan

**Status**: Draft implementation plan  
**Created**: 2026-06-04  
**Last updated**: 2026-06-04 (revised after adversarial review: allowlist-gated sponsorships + Reward Review tab, opt-in feed publishing from the complete modal, existing/new schema reconciliation, relational tables + integrity guarantees, honor-system rewards with a Discard action)  
**Primary goal**: Turn Daily Command Center into a multi-user social task app where tasks, rewards, sponsors, and feeds all derive from real task activity.

## Product Direction

Daily Command Center's social layer should stay task-centered. The app should not become a generic social feed. Social objects exist because a user planned a task, completed a task, earned points, won a reward, redeemed a reward, or received a sponsor offer.

The eventual product is multi-user:

- Each user owns their own tasks, rewards, feed settings, sponsors, and slot machine.
- Users can follow or friend each other and view the feeds they are allowed to see.
- Sponsors can attach rewards to tasks or add rewards into another user's slot machine, subject to the recipient's auto-approve allowlist (anyone not allowlisted is held for review).
- The task owner keeps removal control over sponsor activity after it activates.

## Engineering Principles

These matter as much as the product rules. The social layer should make the codebase cleaner and more reusable, not bolt a second system alongside the first.

- **Reuse before rebuild.** The app already has the bones of this: a multi-user backbone (`users`, `workspaces`, `workspace_members`), a points economy (`slot_accounts`, `slot_point_ledger`), a reward catalog (`slot_rewards`), a sponsorship table (`todo_sponsorships`), reactions (`todo_task_reactions`), and share primitives (`page_shares`, `todo_shares`). The social model is mostly a generalization of these. Extend and rename existing tables; do not stand up duplicates that drift.
- **One reward model, many sources.** Slot wins, sponsor rewards, self rewards, self-care, and bounties all flow through the same reward definition / queue / event tables. No source gets its own bespoke lifecycle.
- **Relational tables for anything with integrity requirements.** Rewards, reward events, sponsorships, and the points economy live in first-class relational tables with constraints and foreign keys, not in the generic `blocks` JSON store. The block store stays for free-form task and day content only.
- **Modular and portable.** Each domain (economy, rewards, sponsorship, allowlist, feed) is a self-contained server module with a small documented interface (plain functions in, typed rows out) and no UI assumptions, so it can be lifted into another app. The HTTP layer is a thin adapter over those modules.
- **Write side owns invariants; read side is cached.** All state changes go through module functions that own idempotency, ledger writes, and counter caches. Views read cached counters and projections; they never recompute by scanning.

## Locked Product Rules

### Sponsor Activation

Sponsor offers are gated by the recipient's auto-approve allowlist. They do not activate immediately by default.

Each user maintains a per-owner **auto-approve allowlist** of specific sponsors they trust. The allowlist is explicit: being a friend or follower does not by itself grant auto-approval; the owner adds individual users.

- A sponsor **on the recipient's allowlist** activates immediately:
  - A task sponsor immediately marks the task as sponsored and attaches the promised reward.
  - A slot sponsor immediately adds the sponsored reward into the user's slot rotation.
- A sponsor **not on the allowlist** (guests, non-friends, or any user the owner has not explicitly added) creates a **pending** sponsorship that has no effect until the owner approves it:
  - Pending offers do not attach rewards, do not mark a task sponsored, and do not enter the slot rotation.
  - The owner approves or rejects each pending offer from the **Reward Review** tab inside the reward queue (see Reward Queue).
  - Approval activates the sponsorship; rejection discards it. Both write an audit event.
- After any sponsorship activates (auto-approved or owner-approved), the task owner retains removal/dismiss control.
- Removals revoke the active sponsor effect and leave an audit event.

Sponsorships are honor-system. There is no payment rail and no fulfillment enforcement: `value_cents` is informational display only, and a "completed" reward means the owner marked it done, not that anything was collected. Because a sponsor can back out or ghost, the owner can always **discard** an earned reward from the queue (see Reward Queue). The system tracks and audits the promise; it does not guarantee it.

Allowlist rules:

- Guests (no account) can never be auto-approved; their offers are always pending.
- Allowlist entries can be scoped to task sponsorships, slot sponsorships, or both.
- Removing someone from the allowlist does not revoke already-activated sponsorships; it only changes future behavior.
- A pending offer that is never reviewed stays pending (and may expire); it never silently activates.

### Slot Sponsorship Odds

Sponsored slot rewards use `chance_shares`.

Odds are nested, not a single flat wheel, and this ordering is intentional:

1. The owner controls the jackpot probability.
2. The dice then select a payment-source / tier bucket (self, sponsored, self-care). These bucket-entry probabilities are set by the owner and are fixed regardless of how many rewards sit in each bucket.
3. `chance_shares` are the wheel slices **within** a single bucket.

- More shares means the reward is more likely **within its own payment-source and tier bucket** only.
- Adding, funding, or removing a sponsored reward redistributes the sponsored slice only. It never changes the odds of landing on a self reward, a self-care reward, or the jackpot. There is no cross-bucket dilution by design; implementers must not collapse this into a flat wheel.
- The UI should show chance shares and approximate bucket odds.
- Friendly rarity presets can be added later, but presets should map to chance-share defaults.

Example display:

```text
5 chance shares in Sponsored / Rare (~3.2% of that bucket)
```

### Feed Publishing

Publishing is opt-in per completion. Nothing publishes automatically. Point value is not a publishing signal, because point value does not track sensitivity (a high-point task can be the most confidential one).

Publish logic:

1. Default for every completion is hidden.
2. If the task is private, it can never be published (the publish control is disabled).
3. A completion publishes only when the user explicitly chooses to publish it.
4. A published completion can be hidden again at any time.

The publish decision is made at completion time, in the standard ("non-lightning") complete modal, and can also be revisited later by clicking the completed task. See Phase 5.

Suggested fields:

- `publish_state`: `hidden`, `published`, `manually_hidden`
- `publish_source`: `user_published`, `default_hidden`, `private_task`

### Private Tasks

Private tasks can never be published to any feed when completed, regardless of point value. The publish control in the complete modal is disabled for private tasks.

Private task completions may still count toward personal stats, reward earning, and daily review, but their feed post stays hidden with `publish_source = private_task`.

### Reward Queue

All earned rewards enter one unified reward queue, regardless of source.

Reward sources include:

- Self-created rewards
- Sponsor task rewards
- Sponsor slot rewards
- Slot-machine wins
- Self-care rewards
- Bounties tied to completed tasks
- Manual/self-awarded rewards

Reward queue item states:

- `queued`: earned and waiting
- `claimed`: user chose to use it
- `redeemed`: user used or collected it
- `completed`: fulfillment is fully done
- `dismissed`: user discarded it (rejected, or a sponsor backed out / ghosted)
- `expired`: no longer valid

**Discard action.** Every reward in the queue has a Discard button that moves it to `dismissed` and writes a `dismissed` audit event. This is how the owner clears out a reward whose sponsor backed out or ghosted, or that they simply do not want. Discarding never counts as redeemed and does not delete history; the won event stays in the ledger. Any queue item in a non-terminal state (`queued`, `claimed`) can be discarded.

Reward definitions and reward instances are separate:

- Reward definition: "Dinner from Alex"
- Reward queue item: "Dinner from Alex won from spin 123 on 2026-06-04"

### Reward Tracking

Track both when rewards were won and when they were redeemed.

Each queue item should include:

- `won_at`
- `won_date`
- `redeemed_at`
- `redeemed_date`
- `source_type`: `slot_spin`, `task_completion`, `sponsor_task`, `manual_self_reward`, `self_care`
- `source_id`
- `reward_definition_id`
- `status`

Daily views should be able to show:

- Tasks completed that day
- Rewards won that day
- Rewards redeemed that day

Won date is immutable. Do not infer it from queue position or status.

### Reward Counts

Track won and redeemed counts separately.

Source of truth should be reward events:

- `won` increments when a reward enters the queue.
- `redeemed` increments when the user redeems the reward.
- `completed` can be separate if fulfillment has an additional done step.
- `dismissed` does not count as redeemed.

Reward definitions may cache:

- `times_won`
- `times_redeemed`
- `last_won_at`
- `last_redeemed_at`

Useful derived stats:

- Redemption rate
- Average time from won to redeemed
- Unredeemed queue count
- Sponsor rewards won vs self rewards won
- Stale rewards won but not redeemed after a user-configured window

## Proposed Data Model

### Reconciliation with the Existing Schema

The new model is largely a generalization of tables that already exist. Map first, then migrate additively. Do not introduce a second parallel set.

| Existing table | Role today | Action | Target in new model |
|---|---|---|---|
| `users`, `workspaces`, `workspace_members` | Multi-user backbone | Reuse as-is | `users`; a workspace is a user's owned space |
| `slot_rewards` | Reward catalog; already has `chance_shares`, `payment_source`, `tier_id`, `value_cents`, `last_won_at` | Generalize + extend | `reward_definitions` (add `owner_user_id`/`created_by_user_id`, `times_won`, `times_redeemed`, `last_redeemed_at`, `uses_remaining`, `expires_at`, `public_visibility`) |
| `slot_point_ledger` | Append-only points ledger with `UNIQUE(workspace_id, source_type, source_key)` | Reuse pattern + extend | `reward_events` (same append-only, unique-source-key idempotency shape) |
| `slot_spins` | Spin records with `reward_snapshot`, `status` (awarded/confirmed), `confirmed_at` | Feed into queue | A spin writes a `reward_events` `won` row and a `reward_queue_items` row (`source_type = slot_spin`) |
| `slot_accounts` | Per-user point/bank balance + settings | Reuse as-is | The economy account (drop any auto-publish setting; publishing is opt-in) |
| `todo_sponsorships` | Task sponsorships; already has `status` default `pending`, `value_cents`, `sponsor_user_id`, `kind` | Generalize + extend | `sponsorships` (add `target_type` task/slot, `target_id`, `reward_definition_id`, `review_state`, `chance_shares`, approval fields) |
| `todo_task_reactions` | Emoji reactions keyed by actor | Reuse + retarget | Feed post reactions (Phase 6) |
| `page_shares`, `todo_shares` | Share tokens + `access_level` + settings | Reuse | Feed / visibility share primitive |
| `blocks` | Generic JSON block store (tasks, day content) | Keep, scope down | Free-form task and day content only; social objects move into relational tables |

Notes:

- `todo_sponsorships.status` already defaults to `pending`, and `slot_point_ledger` already enforces idempotency via a unique source key. The allowlist gate and the event ledger extend patterns that already exist rather than inventing new ones.
- Migration is additive: add columns and new tables, backfill from `slot_rewards` / `slot_spins` / `todo_sponsorships`, switch reads to the new path, and only then retire anything. No destructive drops until the new path is verified.

### Users and Relationships

Core entities:

- `users`
- `user_profiles`
- `friendships` or `follows`
- `sponsor_permissions`
- `sponsor_allowlist`

Permissions should answer:

- Who can view this user's feed?
- Who can sponsor tasks?
- Who can add slot rewards?
- Who can comment/react?
- Which users are blocked?
- Which sponsors are auto-approved (on the allowlist) vs held for review?

### Sponsor Allowlist

The allowlist is the source of truth for auto-approval. It concretizes `sponsor_permissions`: an entry means "activate this sponsor's offers immediately without review."

Suggested fields:

- `allowlist_id`
- `owner_user_id`
- `allowed_user_id`
- `scope`: `task`, `slot`, `both`
- `created_at`
- `created_by_user_id`
- `note`

Resolution rule: an incoming sponsorship auto-approves only if a matching, non-expired allowlist entry exists for `(owner_user_id, sponsor_user_id, target scope)` and the sponsor is not blocked. Otherwise the sponsorship is created as `pending` and surfaced in the Reward Review tab. Guests have no `allowed_user_id` and therefore can never match.

### Tasks

Tasks remain the root social object.

Social-facing task fields:

- `owner_user_id`
- `workspace_id`
- `title`
- `detail`
- `status`
- `points_awarded`
- `public_visibility`: `public`, `friends`, `private`
- `completed_at`
- `completed_date`

### Sponsorships

Sponsorships attach to a task or slot machine. They activate immediately only when the sponsor is on the owner's allowlist; otherwise they are created `pending` and held for review.

Suggested fields:

- `sponsorship_id`
- `owner_user_id`
- `sponsor_user_id`
- `target_type`: `task`, `slot_machine`
- `target_id`
- `reward_definition_id`
- `status`: `pending`, `active`, `rejected`, `removed`, `fulfilled`, `canceled`, `expired`
- `review_state`: `auto_approved`, `pending`, `approved`, `rejected`
- `requested_at`
- `reviewed_by_user_id`
- `reviewed_at`
- `activated_at`
- `removed_at`
- `note`
- `value_cents`
- `chance_shares`

A `pending` sponsorship has no active effect: it attaches no reward, marks no task sponsored, and adds nothing to the slot rotation until it transitions to `active` (via `auto_approved` or owner `approved`).

### Reward Definitions

Reward definitions describe what can be won.

Suggested fields:

- `reward_definition_id`
- `owner_user_id`
- `created_by_user_id`
- `title`
- `kind`: `self`, `sponsor`, `self_care`, `slot`, `bounty`
- `payment_source`: `self`, `sponsored`, `free`
- `chance_shares`
- `tier_id`
- `public_visibility`
- `expires_at`
- `uses_remaining`
- `times_won`
- `times_redeemed`
- `last_won_at`
- `last_redeemed_at`

### Reward Queue Items

Reward queue items are specific earned instances.

Suggested fields:

- `reward_queue_id`
- `owner_user_id`
- `reward_definition_id`
- `title_snapshot`
- `source_type`
- `source_id`
- `won_at`
- `won_date`
- `status`
- `claimed_at`
- `redeemed_at`
- `redeemed_date`
- `completed_at`
- `sponsor_user_id`
- `value_snapshot`
- `chance_shares_snapshot`
- `tier_snapshot`

### Reward Events

Reward events are the audit ledger.

Suggested fields:

- `reward_event_id`
- `reward_queue_id`
- `reward_definition_id`
- `owner_user_id`
- `actor_user_id`
- `event_type`: `won`, `queued`, `claimed`, `redeemed`, `completed`, `dismissed`, `expired`, `sponsor_removed`
- `event_at`
- `event_date`
- `metadata`

### Feed Posts

Feed posts derive from task completions.

Suggested fields:

- `post_id`
- `owner_user_id`
- `task_id`
- `completion_id`
- `points_awarded`
- `estimated_minutes` (snapshot: time the task was expected to take)
- `actual_minutes` (snapshot: time it actually took)
- `publish_state`
- `publish_source`
- `caption`
- `media_attachments`
- `created_at`
- `published_at`
- `hidden_at`

## Integrity Guarantees

Anything that moves points, rewards, or money-like value must be exactly-once and auditable. These are requirements, not nice-to-haves.

### Idempotency

- Every state-changing operation carries an idempotency key. Reuse the established `slot_point_ledger` pattern: `UNIQUE(workspace_id, source_type, source_key)`.
- `reward_events` enforces a unique `(owner_user_id, event_type, source_type, source_id)` so a retried slot spin, a double-tapped redeem, or a replayed request cannot double-write.
- The HTTP layer threads a client-supplied request id through to the service so a retried request resolves to the same event instead of creating a new one.

### Transactions

- A reward win is one transaction: insert the `reward_events` `won` row, insert the `reward_queue_items` row, and adjust the `slot_accounts` balance together, or roll back together.
- A redeem is one transaction: write the `redeemed` event, set `redeemed_at`, and bump cached counters atomically.
- A sponsor approve/activate is one transaction: flip `sponsorship.status` to `active`, attach the reward or add the slot entry, and write the audit event together.

### Immutability and source of truth

- `won_at` is immutable once set, never inferred from queue position or status.
- `reward_events` is append-only. Corrections are new events (for example `sponsor_removed`), never edits or deletes.
- Cached counters (`times_won`, `times_redeemed`, balances) are derivable from the ledger and must be rebuildable by replaying it. The ledger is the source of truth; caches are an optimization.

### Concurrency

- A spin reads balance and odds with the `slot_accounts` row locked inside the transaction, so concurrent spins cannot oversell points.
- Sponsor activate versus owner remove on the same offer resolves by status guard: activation proceeds only from `pending`/`approved`, removal only from `active`. The losing writer no-ops.

### Testability

- Each guarantee has a test: replay a spin twice and get one reward; rebuild counters from the ledger and match the caches; concurrent spins cannot overspend; an approve-and-remove race leaves a consistent state.

## Implementation Phases

### Phase 1: Multi-User Social Contract

Define the durable contracts before expanding UI.

Deliverables:

- Social/reward schema migration plan (see Reconciliation with the Existing Schema): additive columns plus new relational tables, backfilled from `slot_*` and `todo_sponsorships`
- Per-domain module boundaries defined (economy, rewards, sponsorship, allowlist, feed), each a self-contained service with a documented interface
- User/profile/feed settings contract
- Sponsor allowlist + auto-approval contract (allowlisted = immediate, everyone else = pending)
- Sponsorship approval/activation/removal contract
- Reward queue contract
- Feed publish-state contract (opt-in publishing, no threshold auto-publish)

Acceptance criteria:

- Every social object traces back to a user and task/reward event.
- Private task behavior is explicit and testable.
- Allowlist resolution is explicit and testable: an allowlisted sponsor auto-approves; every other sponsor (including guests) is created `pending` with no active effect.
- Sponsor approval, activation, and owner removal states are unambiguous.

### Phase 2: Reward Queue Core

Build the unified reward queue before adding more sponsor flows.

Deliverables:

- Reward queue and reward-event ledger as first-class relational tables (not the generic block store), generalized from `slot_rewards` / `slot_spins` / `slot_point_ledger`
- Reward event ledger with idempotency keys and the transaction boundaries defined in Integrity Guarantees
- Queue UI for queued, claimed, redeemed, completed, dismissed, and expired rewards, including a Discard button on each item (sets `dismissed`, writes an audit event) for clearing ghosted or unwanted rewards
- **Reward Review tab** within the reward queue UI: a small tab listing `pending` sponsorships awaiting the owner's decision, each with the offer details (sponsor, target task/slot, reward, value, chance shares, note) and Approve / Reject actions
- Allowlist management surfaced from the Reward Review tab (add/remove auto-approved sponsors, with scope), including a one-click "always auto-approve this sponsor" on an individual offer
- Daily view sections for rewards won and rewards redeemed
- Cached won/redeemed counters on reward definitions

Acceptance criteria:

- Slot wins create reward queue items.
- Manual/self rewards can create queue items.
- Redeeming a reward records `redeemed_at` without changing `won_at`.
- Reward cards show won count and redeemed count separately.
- Discarding a reward sets `dismissed`, writes an audit event, does not count as redeemed, and preserves the won event in the ledger.
- Replaying a slot win or a redeem does not double-credit (the idempotency key holds).
- Pending sponsorships from non-allowlisted sponsors appear in the Reward Review tab and have no active effect until approved.
- Approving a pending offer activates it (attaches the reward / adds it to the slot rotation); rejecting it discards it. Both write an audit event.
- Adding a sponsor to the allowlist from a pending offer auto-approves that offer and future offers in scope.

### Phase 3: Sponsor Task Rewards

Make friend sponsorship of tasks a complete loop.

Deliverables:

- Sponsor form for task rewards
- Allowlist-gated activation on submit: immediate if the sponsor is allowlisted, otherwise `pending` and routed to the Reward Review tab
- Owner approve/reject from Reward Review (reuses the Phase 2 tab)
- Owner removal/dismiss control
- Sponsored task visual state (and a "pending sponsorship" state for offers awaiting review)
- Completion creates a reward queue item (only for active sponsorships)
- Sponsor request, approval, rejection, and removal each write an audit event

Acceptance criteria:

- An allowlisted sponsor can attach "dinner if you finish this" and the task owner sees it active immediately.
- A non-allowlisted sponsor's offer appears as `pending` in Reward Review and attaches nothing until the owner approves it.
- Completing a task with an active sponsorship queues the reward; completing one with only a pending offer does not.
- Removing the sponsor revokes the active effect without deleting history.

### Phase 4: Sponsor Slot Rewards

Let sponsors add funded rewards directly into another user's slot machine.

Deliverables:

- Slot sponsorship form using chance shares
- Existing reward sponsorship path
- New reward sponsorship path
- Public/private reward visibility
- Uses and expiry support
- Owner removal control

Acceptance criteria:

- An allowlisted sponsor can add a new reward to the owner's slot machine immediately; a non-allowlisted sponsor's slot offer stays `pending` and does not enter the rotation until approved.
- A sponsor can fund an existing reward (subject to the same allowlist gate).
- Chance shares are visible and editable where appropriate.
- A slot win creates a reward queue item with source `slot_spin`.

### Phase 5: Completion Posts

Create post objects from completed tasks, published only by explicit user choice.

Deliverables:

- Completion-to-post creation path (post created hidden by default)
- A "Push to social feed" control in the standard ("non-lightning") complete modal, letting the user decide at completion time whether to publish
- A completion-detail review shown in that modal and when clicking a completed task: points earned, estimated time, actual time taken (and the estimate-vs-actual delta)
- Manual publish/hide controls available later by clicking the completed task
- Private-task publish suppression (control disabled for private tasks)
- Caption support
- Media attachment contract

Acceptance criteria:

- Completing a task never publishes a post unless the user explicitly chooses to push it to the feed.
- The complete modal shows points, estimated time, and actual time so the user can decide with full context.
- Completing a private task offers no publish option (control disabled).
- A user can publish a completed task later by clicking it, and can hide a post they previously published.
- The lightning/quick-complete path completes the task without publishing and without prompting.

### Phase 6: Social Feeds

Expose feeds once publishing rules are reliable.

Deliverables:

- Personal feed
- Friends feed
- Sponsored-task feed
- Reactions/comments on posts
- Sponsor call-to-action on eligible task posts

Acceptance criteria:

- Feed visibility respects owner settings.
- Private tasks and manually hidden posts are absent.
- Feed cards connect back to task completion and reward context.

### Phase 7: Trust, Privacy, and Cross-User QA

Harden the multi-user boundary.

Deliverables:

- Cross-account privacy tests
- Sponsor abuse controls
- Media upload limits
- Removal and blocked-user behavior
- Audit views for sponsorship and reward events
- Architect review

Acceptance criteria:

- Account A cannot see Account B private tasks, hidden posts, or private rewards.
- Sponsor actions cannot mutate another user's data outside approved sponsor routes.
- Removed sponsorships stop affecting points/rewards while preserving history.

## Immediate Next Step

Start implementation with Phase 1 and Phase 2. The reward queue should land before expanding sponsor UI because sponsor rewards, self rewards, slot wins, and self-care rewards all need the same lifecycle.
