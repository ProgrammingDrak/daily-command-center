# Glasses task navigation

The canonical `/glasses` and `/glasses.html` bookmarks still redirect to
`/?device=glasses`. The replacement is the signed-in full application's existing
`public/js/device-views/glasses.js` adapter and stylesheet. The standalone
prototype has been removed.

## Interface

Jump and Select show up to eleven open task rows, keeping a full viewport near
boundaries. Jump moves five tasks and marks a five-row blue range. Select moves
one task and animates to green. Collection order is All Tasks, Working Queue,
Itinerary, Loose Ends, Unscheduled, Whenever, Someday, Waiting. Each collection
retains its own selected identity through refresh. Working Queue uses its
canonical Foreground, Needs You, Background, Priority Queue projections; section
labels do not consume a task slot.

Task View centers the title and metadata in a green rounded outline. Up brings a
task forward. For an existing Foreground task, Up uses the existing 30-minute
Background snooze, explicitly labelled on screen, without inventing a running
worker. Right removes only a Priority Queue entry, never the task. Down opens
More, navigable with Up/Down and a forefinger tap. Left or forefinger tap completes
an ordinary task. Forefinger hold opens the deliberately unfinished Details view.

Completion immediately leaves Task View but does not claim success until the
canonical coordinator acknowledges the write. The five-second Undo indicator
starts at acknowledgement. Double middle tap during that window invokes a
server-side account-scoped reversal of that exact completion. It does not
restore a client-only row or restart a timer. A new revision or edited task
refuses unsafe undo. Pending, offline, rejected and expired operations remain
honest. Navigation works while mutation requests are pending.

Waiting check-ins, source triage and guided tasks have required owner-specific
outcome semantics. Their generic completion is refused clearly, and More opens
the existing outcome flow. Those flows do not claim the new generic undo receipt.

## Input and device qualification

Arrow keys are the established browser directional input. Enter is forefinger
(tap or 550ms hold); Escape is middle (320ms double-tap discrimination). Pointer
controls use the same recognizer. Cancelled or lost pointers never emit a tap.
Native Backspace and Alt/Meta browser history shortcuts are not intercepted.
`dcc:glasses-gesture` can deliver an already recognized action to the same adapter;
this is an integration seam, not a claim of a working Meta SDK bridge.

`?device=glasses&glassesSimulator=1` enables optional development controls.
They are in the real adapter, not another app. The target layout is 600×600,
with narrow-screen, 200% zoom and reduced-motion checks.

**Physical Meta Ray-Ban Display qualification is still required.** Desktop
Chromium tests cannot verify the glasses runtime's mapping of finger identities,
double taps, holds, native Back, display optics or device authentication. No
physical device was connected for this implementation. Software deployment must
be reported separately from that hardware qualification.

## Software verification

Use the existing local-only fixture servers and disposable PostgreSQL. Never
point the mutation suites at production or a personal database.

- `node --test glasses-navigation-model.test.js glasses-owner-projections.test.js queue-completion-undo.test.js`
- `node scripts/verify-glasses-device-view.mjs`
- `node scripts/verify-glasses-working-queue.mjs`
- `node scripts/verify-working-queue.mjs`
- Full Node suite and repository lint, using supported Node 20 or 22.

The new server operation reuses the coordinator's revision, idempotency receipt,
account binding and transactional completion writer. No schema migration, new
authentication mechanism, credentials or hardware permissions are introduced.
