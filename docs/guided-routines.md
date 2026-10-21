# Guided routines — movement cards and prompted workouts

Workouts remain their own domain alongside repeat responsibilities. The **Guided routines · workouts** launcher sits beside repeat responsibilities; **Movement library** and **Workout templates** also live in Workouts & meals. No company-metrics workflow, social feed, sharing grant, or repeat-task rewrite is included.

## Three inspectable homes

- **Movement cards** contain reusable visual instructions and separate spoken-cue text. The library shows identity, revision, available last-edit time, and which saved workout templates reference the identity. Built-ins are read-only and can be copied. Custom edits use owner-scoped optimistic revisions. This is current provenance, not a fabricated audit-history ledger.
- **Workout templates** compose ordered occurrences in existing single/superset/circuit groups. Browse the ordered cards, sides, planned goals, snapshot revisions, source provenance, and template revision before editing or creating a detached session. Blank compositions and an original Gentle Reset example create no task or session until explicitly requested.
- **Sessions** keep their detached plan, frozen baseline, navigation position, confirmed results, and existing manually recorded timing separate. Beginning guidance freezes the plan. Later library or template edits cannot rewrite a started session. A future sharing design should use an owned completed activity, with a separate explicit privacy projection; this change adds no sharing controls.

## Editing and guidance contract

A catalog movement ID identifies a reusable definition. Every inserted or duplicated occurrence and every target gets a distinct ID. Side is occurrence metadata; for seated side bend RIGHT and LEFT mean the direction of the bend. Drag handles, arrow keys on focused handles, and 44px move buttons use the same model mover. Cross-group moves require matching round counts and spare destination capacity; incomplete supersets/circuits remain visibly draft and cannot save/start until valid. New groups explicitly start at one round, not an implicit three.

The common goals stay visible. Other goals, conventions, cue authoring, and actual results are secondary. Suggested windows include transitions and are separate from planned measured holds (`sets[].seconds`) and actual session measurements. A card's **Refresh from movement library** explicitly adopts the current definition/name while retaining its occurrence ID, side, and goals. It does not propagate to siblings.

Prompted guidance shows the current card, side, visual instructions, distinct authored cue, and optional natural-breath association. Back/Next wait for explicit actions; Exit saves a paused position and Resume returns to it. Finish marks guidance finished at the final card. Navigation never creates reps, holds, actual result dates, set completions, or timing events. Existing manual session timing/logging remains separate. Saves retain expectedRevision/mutationId retry semantics and stale-tab refusal. Drafts are page-only; acknowledged saves recover after reload.

`prompted-sequence.js` contains a pure domain-neutral transition function over a step count and `{status, stepIndex}`. The workout adapter resolves ordered group/round/occurrence steps and persistence. Another repeatable domain can reuse the navigator without importing exercise measurements. No non-workout domain is built here.

## Gentle Reset

The bundled example contains original written cards, not copied video or book prose: comfortable seat, right then left seated bend, tabletop, distinct Cow and Cat cards in a shared natural-breath group, supported child's rest with a seated alternative, transition to rest, final rest, and unhurried exit. Suggested windows are 60/60/60/30/90 shared/60/30/120/30 seconds (nine minutes). No forced breath/cycle count or completed hold is seeded. The example is a reusable code fixture; it does not create production user records.

General source references reviewed for movement vocabulary:

- https://yogawithadriene.com/free-yoga-videos/foundations-of-yoga/
- https://yogawithkassandra-members.com/wp-content/uploads/2020/06/1231088.pdf

## UI references and DCC fit

The existing DCC task treatment supplies the palette, raised surfaces, compact header, clear grips, and expanded secondary controls. Reference research informed the hierarchy rather than copying layouts or adding integrations:

- Strava's active recording flow prioritizes activity controls, then a distinct finish/save/details stage: https://support.strava.com/en-us/articles/15402137-how-do-i-record-an-activity-on-strava . Here, current movement and explicit navigation lead; guidance completion is not a claim that a workout was performed.
- Strong explicitly separates templates from performed workouts: https://help.strongapp.io/article/105-about-templates . Templates here have no actual results or completion timestamps.
- Hevy documents reusable routines, exercise reorder/remove, and supersets: https://www.hevyapp.com/features/track-workouts/ . DCC retains its ordered groups and labels planned goals separately from previous performance and actuals.

## Deferred engine work

Voice commands are **not connected**. Authenticated voice integration, audio recording/playback, automatic countdowns/progression, and speech synthesis are out of scope. Spoken text and optional inhale/exhale association are stored content only. Suggested windows are not running timers. A future engine needs explicit speech-complete and wait states, pause/resume/skip/exit handling, adjustable spacious pacing, and speech speed separate from hold/transition durations. Slow speech or ellipses must never substitute for actual wait intervals.

## Storage, migration, and rollback

The existing additive schema path adds nullable movement JSONB, revision default 1, and nullable updated_at to the owner-private exercise catalog. Existing last-edit times remain unknown until a real edit. Plan metadata and optional guidance are explicitly validated/serialized; old v1/v2 records are not bulk rewritten, and legacy IDs are preserved. Auth remains session/workspace-owner-only; scheduling bearer identity cannot read or write these records.

No schema was applied to production. Apply the normal additive schema before serving the new catalog queries when a later release is authorized. A rollback to older writers can strip additive JSON metadata; retain these compatible readers/writers once movement-card or guidance records have been saved. Prefer a corrective release and keep the additive columns. Do not drop private tables or downgrade existing sessions.

## Verification

- `node --test --test-concurrency=4`, with a disposable PGlite runtime, covers model/controller and real PostgreSQL/API contracts.
- `npm run lint` is the repository check. This plain JavaScript application has no separate typecheck or build script; browser load verifies the shipped scripts together.
- `scripts/verify-movement-cards.mjs` exercises actual library/template/card/runner UI, native drag, keyboard focus, 375/320px layouts, persistence/reload and cancellation on the opt-in synthetic review server.
- `scripts/verify-activity-ui.mjs` continues checking legacy logging, manual timing, meals, export and privacy using the new collapsed results layout.

All browser/API test records are fictional and exist only in disposable local memory. PGlite's serialized transactions do not prove multi-process PostgreSQL races. Browser checks cover Chromium at mobile sizes, not physical-device WebKit touch dragging; mobile tap reordering is the supported fallback.
