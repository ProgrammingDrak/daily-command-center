# Instant-feel interactions building block

Every tap in DCC should change the screen right away, whatever the network,
the server or a Railway cold start is doing. This guide is the rule set and the
existing parts that already deliver it. Use it for any new card, list, sheet or
action, and check a change against it before shipping.

Recorded 2026-11-27, while designing the Rows + Tiles Working Queue card. The
owner singled out how quick the clickable prototype felt and asked that the
real app keep that feel.

## The rule

**A tap shows its result within about 100 ms, and it does not wait for the server.**
The server confirms later. If it refuses, the screen undoes the change exactly and
says why.

The prototype felt fast because it never waits: everything is in memory, there
is no network, and the list is short. The real app has a network, a database and
long lists. The rules below keep its feel close to the prototype's anyway.

## Three kinds of interaction

| Kind | Examples | What happens on tap |
| --- | --- | --- |
| **Display-only** | Expand/collapse a row into a tile, open a sheet (snooze, schedule, priority), show/hide details, switch tabs | Change the screen only. **Never** call the network. Keep this state in memory (or `localStorage` for remembered preferences). |
| **Change with a known result** | Complete, bring forward, pause/resume, send to background, return to Priority, snooze, dismiss a reminder, priority, move up/down/top, delete after confirming | Apply locally now, record the intent durably, send in the background, reconcile on reply. |
| **Needs the server's answer first** | Automatic placement that needs destination-day data, review-guarded moves, delete previews that count nested tasks | Show immediate feedback (pressed state, a "Checking…" line, a skeleton) within the same 100 ms, run independent reads in parallel, and apply as soon as the answer arrives. Keep this list short. Move items out of it whenever the result can be predicted. |

If you aren't sure which kind something is, it's probably the second.

## Building blocks that already exist (reuse them)

| Piece | Where | What it gives you |
| --- | --- | --- |
| Block-store write-ahead log | `public/js/block-store.js` (`WAL_KEY`, dead-letter key) | Intent is recorded **before** the request waits behind another one. Survives reload, retries with the same mutation id, and keeps the original completion time. |
| Per-row serialized writes | `public/js/state.js` ("ONE serialized read-modify-write per row") | Writes to the same task stay ordered; unrelated tasks don't wait on each other. |
| Queue completion outbox | `public/js/working-queue.js` (`enqueueCompletion`, `drainCompletions`) | Completing a queue task is already optimistic and durable. It is the model for every other queue action. Covered by `queue-completion-latency.test.js`. |
| Optimistic cross-date move | `public/js/schedule.js`, `block-store.js` | Locally queued preview, rollback that restores only the touched rows, and newer intent replaces older buffered intent. |
| Core-first boot | `public/js/boot.js` | Today's tasks render before supporting data arrives. |
| Latency evidence and profiler | `docs/performance/task-latency.md`, `scripts/profile-task-latency.mjs` | How to measure visual feedback against server acknowledgement on the synthetic review server. |

## Rules for changes (the second kind)

1. **Apply first.** Update the in-memory model and repaint before any `await`.
2. **Record intent durably.** Use the existing outbox/WAL so a reload or a dropped
   connection does not lose the tap.
3. **Queue instead of refusing.** A second tap while a save is running waits its
   turn. Never answer with "still being saved".
4. **Roll back narrowly.** On rejection, restore exactly the objects this action
   touched. Never revert newer, unrelated edits.
5. **Ignore stale replies.** A reply for an older intent must not repaint a newer
   choice (check the mutation generation or intent tag before applying).
6. **Tell the truth about sync.** Never show "All changes saved" while anything
   is pending. Show a quiet pending state and a toast with the reason on rejection.
7. **Offer Undo** on big changes (complete, delete, bring forward, snooze). Undo is
   itself a change and follows the same rules.

## Rendering rules

- **Repaint only what changed.** Replace the one card or row that changed rather
  than rebuilding the whole list. This matters at 60 tasks, not at 6.
- **Keep the person's place.** Preserve focus, scroll position, open tiles and open
  details across repaints.
- **Expand in place.** Turning a row into a tile swaps one node, with no reflow of
  the rest of the page.
- **Pressed state is immediate.** Use CSS `:active`, never a style set after work
  finishes.
- **Keep motion short.** Use 150 ms or less, and none under
  `prefers-reduced-motion`. Animation must never be what the person waits on.
- **Size hold gestures deliberately.** Holds (complete → notes, priority → picker,
  move → top) fire at about 550 ms. A tap must not wait for the hold timer to
  decide; it acts on release.

## Known gap: Working Queue actions (as of 2026-11-27)

In `public/js/working-queue.js` (`sendUnlocked`, ~line 267), every queue action
except completion awaits the server before the card changes. That includes bring
forward, background, pause, snooze, dismiss, return, priority, reorder and
delete. A second action during a save throws "A queue update is still being
saved." `render()` (~line 376) also rebuilds the whole queue root on every
change.

The Rows + Tiles card build should close this gap. Move these actions onto the
completion-outbox pattern and switch to per-card repaint, applying all the rules
above.

## How to prove it (the regression test)

Every new or changed interaction ships with a latency check run against the
synthetic review server (`scripts/ui-review-server.mjs`, loopback only, never user
data):

- Delay every mutation response by **2 s**.
- For each action, assert the visible change appears within **100 ms** of the tap.
- Assert that a refused reply rolls back only that action and shows a toast.
- Assert that rapid double taps both apply, in order, with no error.
- Assert that a reload while a change is pending keeps the change (outbox/WAL replay).
- Assert that a late reply for an older intent does not override a newer one.

A failing check blocks the change, the same as a failing unit test.

## Checklist for a new interaction

- [ ] Classified as display-only, known-result change, or needs-server-first.
- [ ] Display-only: no network call anywhere on the path.
- [ ] Known-result change: applies before any `await`, uses the outbox/WAL,
      queues rather than refuses, rolls back narrowly, offers Undo.
- [ ] Needs-server-first: immediate feedback, reads run in parallel, and a note
      explaining why it can't be predicted.
- [ ] Repaints only the affected node and keeps focus, scroll and open state.
- [ ] Latency check added with a 2 s server delay and a 100 ms budget.
- [ ] Physical-device check on the owner's iPad for anything touch- or
      hold-based. Emulated-iPad results are recorded separately and don't count
      as device validation.
