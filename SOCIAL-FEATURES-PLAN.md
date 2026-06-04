# Daily Command Center Social Features Plan

**Status**: Draft implementation plan  
**Created**: 2026-06-04  
**Primary goal**: Turn Daily Command Center into a multi-user social task app where tasks, rewards, sponsors, and feeds all derive from real task activity.

## Product Direction

Daily Command Center's social layer should stay task-centered. The app should not become a generic social feed. Social objects exist because a user planned a task, completed a task, earned points, won a reward, redeemed a reward, or received a sponsor offer.

The eventual product is multi-user:

- Each user owns their own tasks, rewards, feed settings, sponsors, and slot machine.
- Users can follow or friend each other and view the feeds they are allowed to see.
- Sponsors can attach rewards to tasks or add rewards into another user's slot machine.
- The task owner keeps removal control over sponsor activity after it activates.

## Locked Product Rules

### Sponsor Activation

Sponsor offers activate immediately.

- A task sponsor immediately marks the task as sponsored and attaches the promised reward.
- A slot sponsor immediately adds the sponsored reward into the user's slot rotation.
- The task owner can remove or dismiss unwanted sponsorships after activation.
- Removals should revoke the active sponsor effect and leave an audit event.

### Slot Sponsorship Odds

Sponsored slot rewards use `chance_shares`.

- More shares means the reward is more likely within its payment-source and tier bucket.
- The UI should show chance shares and approximate bucket odds.
- Friendly rarity presets can be added later, but presets should map to chance-share defaults.

Example display:

```text
5 chance shares in Sponsored / Rare (~3.2% of that bucket)
```

### Feed Publishing

Users set their own auto-publish point threshold.

Publish logic:

1. If the task is private, do not publish.
2. If the user manually hid the completion, do not publish.
3. If the user manually published the completion, publish.
4. If task points are greater than or equal to the user's threshold, auto-publish.
5. Otherwise keep the completion hidden.

Suggested fields:

- `auto_publish_threshold_points`
- `publish_state`: `hidden`, `auto_published`, `manual_published`, `manually_hidden`
- `publish_source`: `threshold`, `user_override`, `default_hidden`, `private_task`

### Private Tasks

Private tasks never auto-publish to any feed when completed, regardless of point value.

Private task completions may still count toward personal stats, reward earning, and daily review, but their feed post should default to hidden with `publish_source = private_task`.

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
- `dismissed`: user rejected it
- `expired`: no longer valid

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

### Users and Relationships

Core entities:

- `users`
- `user_profiles`
- `friendships` or `follows`
- `sponsor_permissions`

Permissions should answer:

- Who can view this user's feed?
- Who can sponsor tasks?
- Who can add slot rewards?
- Who can comment/react?
- Which users are blocked?

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

Sponsorships attach to a task or slot machine and activate immediately.

Suggested fields:

- `sponsorship_id`
- `owner_user_id`
- `sponsor_user_id`
- `target_type`: `task`, `slot_machine`
- `target_id`
- `reward_definition_id`
- `status`: `active`, `removed`, `fulfilled`, `canceled`
- `activated_at`
- `removed_at`
- `note`
- `value_cents`
- `chance_shares`

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
- `publish_state`
- `publish_source`
- `caption`
- `media_attachments`
- `created_at`
- `published_at`
- `hidden_at`

## Implementation Phases

### Phase 1: Multi-User Social Contract

Define the durable contracts before expanding UI.

Deliverables:

- Social/reward schema migration plan
- User/profile/feed settings contract
- Sponsorship activation/removal contract
- Reward queue contract
- Feed publish-state contract

Acceptance criteria:

- Every social object traces back to a user and task/reward event.
- Private task behavior is explicit and testable.
- Sponsor activation and owner removal states are unambiguous.

### Phase 2: Reward Queue Core

Build the unified reward queue before adding more sponsor flows.

Deliverables:

- Reward queue table or equivalent block-store model
- Reward event ledger
- Queue UI for queued, claimed, redeemed, completed, dismissed, and expired rewards
- Daily view sections for rewards won and rewards redeemed
- Cached won/redeemed counters on reward definitions

Acceptance criteria:

- Slot wins create reward queue items.
- Manual/self rewards can create queue items.
- Redeeming a reward records `redeemed_at` without changing `won_at`.
- Reward cards show won count and redeemed count separately.

### Phase 3: Sponsor Task Rewards

Make friend sponsorship of tasks a complete loop.

Deliverables:

- Sponsor form for task rewards
- Immediate activation on submit
- Owner removal/dismiss control
- Sponsored task visual state
- Completion creates a reward queue item
- Sponsor removal writes an audit event

Acceptance criteria:

- A sponsor can attach "dinner if you finish this" to a task.
- The task owner sees it immediately.
- Completing the task queues the reward.
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

- A sponsor can add a new reward to the owner's slot machine.
- A sponsor can fund an existing reward.
- Chance shares are visible and editable where appropriate.
- A slot win creates a reward queue item with source `slot_spin`.

### Phase 5: Completion Posts

Create post objects from completed tasks.

Deliverables:

- Completion-to-post creation path
- Publish threshold setting
- Manual publish/hide controls
- Private-task publish suppression
- Caption support
- Media attachment contract

Acceptance criteria:

- Completing a public task above threshold auto-publishes a post.
- Completing a private task never auto-publishes.
- User can manually publish a lower-point task.
- User can hide a post that auto-published.

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
