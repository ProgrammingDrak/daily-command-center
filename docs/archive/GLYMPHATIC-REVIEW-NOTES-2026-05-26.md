# Glymphatic Review Notes - 2026-05-26

## Daily Command Center Slot Machine Work

### What Was Done

- Rebuilt Slots into a staged reward system:
  - First spin now resolves `MISS / BANK / JACKPOT`.
  - `BANK` is Bank Builder and happens outside jackpot resolution.
  - `JACKPOT` continues into tier/source resolution and exact reward selection.
- Reorganized rewards source-first:
  - `Self`
  - `Sponsored`
  - `Free`
  - Each source is broken into user-managed tiers.
- Added tier management:
  - Add tiers.
  - Rename tiers.
  - Reorder tiers.
  - Activate/deactivate tiers.
  - Delete tiers.
- Added reward metadata:
  - `payment_source`
  - `tier_id`
  - `chance_shares`
  - `active`
  - sponsor/value metadata preserved.
- Added/backfilled database fields in Postgres schema and migration.
- Added configurable odds:
  - `jackpot_hit_rate`
  - `bank_builder_hit_rate`
  - source weights
  - tier weights
  - reward chance shares inside each bucket.
- Added empty-bucket behavior:
  - If jackpot resolves to an empty source+tier bucket, award a reroll credit.
- Simplified slot labels:
  - Removed flavor labels like straw/stick/brick/house/tools/care/pledge/pick from the slot cards.
  - Slot surface now uses the basic vocabulary: `MISS`, `BANK`, `JACKPOT`.
- Fixed Bank Builder behavior:
  - Bank Builder no longer depends on jackpot.
  - Bank animation no longer fires unless `bank_delta_cents` was actually awarded.
  - Miss screens cannot create fake bank payouts.
- Slowed down and clarified jackpot animation:
  - Jackpot hit pauses on a big `JACKPOT` moment.
  - Two dice appear:
    - one decides tier
    - one decides paid-by source (`Self / Sponsored / Free`)
  - A reward wheel appears using possible rewards from the resolved bucket.
  - Final reward reveal happens after the wheel locks.

### PRs Merged

- PR #76: Three-spin jackpot pool reset.
- PR #77: Fix slot bank payout animation gating.
- PR #78: Simplify slot machine labels.
- PR #79: Move Bank Builder into first spin outcome.
- PR #80: Slow jackpot reveal with dice and reward wheel.

### Verification Completed

- `node --check slot-store.js`
- `node --check public/js/slots.js`
- `node --test`
- Final test count after backend changes: `51/51` passing.

Browser QA was blocked because local DCC redirected to sign-in, so authenticated spin testing still needs human/browser verification.

## Product Decisions Captured

- Bank Builder is not a jackpot reward. It is a first-stage outcome and should be almost as common as misses.
- Dollar value does not decide tier. The user assigns tiers manually.
- Jackpot flow should be emotionally legible:
  - Hit jackpot.
  - Roll tier and payment source.
  - Spin visible reward wheel for exact reward.
- Slot labels should stay basic for now. Flavor can come later after the logic feels right.

## What Still Needs To Be Done

- Human QA an authenticated spin session:
  - Miss result.
  - Bank Builder result.
  - Jackpot result.
  - Empty bucket reroll credit.
  - Reward wheel with multiple bucket rewards.
  - Reward wheel with one bucket reward.
- Confirm Bank Builder money is added to the reserve in real app state.
- Tune default probabilities after using it:
  - Current intended rough default shape is jackpot 20%, bank builder 36%, miss 44%.
  - Validate whether Bank Builder feels "almost as common as misses" in practice.
- Review the jackpot reward wheel UX:
  - Does it show enough reward names?
  - Are long reward names readable?
  - Does the selected reward feel clearly selected?
- Decide whether `bank_builder_hit_rate` should be described as:
  - percent of non-jackpot spins, or
  - absolute first-stage chance.
- Consider adding an odds explainer in settings:
  - Jackpot first.
  - If no jackpot, Bank Builder rolls.
  - Otherwise miss.
- Add browser/e2e coverage once auth test setup is available.
- Revisit sound balance:
  - Jackpot hit.
  - Dice lock.
  - Wheel spin.
  - Reward reveal.
  - Bank Builder.
  - Miss.

## Review Lessons / Routing Candidates

- Product lesson: visual reward systems need state transitions to be explicit. Users should be able to tell what stage they are in without reading code or interpreting ambiguous animations.
- Product lesson: "bank" and "jackpot" are distinct reward concepts and should not share probability or animation logic.
- Engineering lesson: animation snapshots should not be treated as awarded state. Persisted outcome fields like `bank_delta_cents` need to remain the source of truth.
- Engineering lesson: probability settings need copy that names the denominator. "45%" is ambiguous unless it says whether it is absolute or conditional on no jackpot.
- DCC improvement candidate: add authenticated local QA support or a test login path so UI-heavy features can be verified end-to-end by agents.
- DCC improvement candidate: add a small slot debug panel in development mode showing the resolved stage snapshot, selected bucket, and payout deltas after each spin.

## Open Risks

- The reward wheel is frontend-only verified by code checks, not authenticated browser play.
- Long reward titles may crowd the wheel labels.
- The current Bank Builder default may need tuning after real use.
- Empty bucket reroll credit behavior needs human UX validation.
- Existing users may have unusual reward metadata from earlier versions; backfills are in place, but production data should be watched after deployment.
