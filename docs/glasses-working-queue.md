# Tasks and active queue on glasses

`/glasses` and `/glasses.html` open the full app at `/?device=glasses`.
Explicit legacy `task=` links retain their existing compact task page; explicit
`tab=schedule` links retain the itinerary adapter.

The glasses home has two horizontal rows:

- **All open tasks:** the complete paginated owner task search, including tasks
  outside the working queue. Select adds one queue membership. It does not start
  a timer or change the underlying task's schedule. Tasks already queued say
  “In queue”; repeated selection cannot duplicate them. Completed tasks and
  recurring definitions follow the existing queue picker convention and are not
  offered as open work; no records are deleted.
- **Active queue:** select a card to bring it forward and open its focused view.
  This uses DCC's existing `start` command, which starts its timer and moves any
  prior foreground work to the background. Selecting an already-running task
  opens it without restarting its timer.

The focused view shows the task, confirmed timer state, saved time and subtasks
(including completed steps). **Select opens task details and editable notes in one
step.** It does not start, pause or resume timing. Swipe right completes through
DCC's completion coordinator. Swipe left dismisses from the queue: an active
session is first paused and saved, then membership is removed. Dismissal never
completes or deletes the task. If pause is unconfirmed, removal is not attempted.
If removal fails, the paused task stays visible for retry. If another client starts
it between those operations, the server rejects removal instead of hiding a
running timer. A dismissed task can be selected again in All open tasks.

Back from notes returns to the same focused task, restoring selection and viewport
scroll. The next Back returns to the two rows. These steps leave timing untouched.
Back and Forward use browser history, including after reload. Destination entries
are pushed for the focused task and notes, never for edits, focus changes or polling. Existing collection
and task-library URL persistence now preserve the shared history state.

Guided tasks retain their required instruction preview and completion outcome
review through the existing shared dialog. A transient history entry makes native
Back dismiss this review first, including during a pending save; a second Back
returns to the task list. Canceled review entries are skipped on Forward and
reload. A save already sent still reconciles through the canonical receipt.
Blank or oversized outcomes are rejected before freezing a completion retry.
Ordinary tasks do not get extra dialogs.
Pending updates, conflicts and failed subtask reads expose recovery only when needed.

## Fast notes entry and reliable saves

The notes destination reuses the existing `createBlockEditor` and canonical note
shape. Edits autosave after 500 ms; Back flushes the pending edit immediately and
returns without an extra save-confirm click. Save failures leave a visible status
on both the notes view and foreground task, with retry on the notes view. A draft
is stored under its account, workspace, tab and canonical task ID. Reopening or
reloading resumes it. Other tabs offer explicit recovery of matching retained
drafts; unrelated accounts/tasks are excluded. If local storage also fails, the
text stays in memory and the UI asks the user to keep this tab open; unload warns.

A narrow owner-only GET/PUT `/api/working-queue/tasks/:id/notes` uses content
revisions and row locks. It preserves either the existing legacy note-block ID or
the task's `_taskNotes`, and never rewrites timing/history fields. Both task and
legacy note IDs are broadcast after a save. Ambiguous date-local task IDs do not
borrow another task's legacy note. An identical retry after a lost acknowledgement
is safe. Conflicts show the saved note and retain the draft, with explicit choices
to use the saved note or replace it with the draft. New edits during a save remain
dirty until their own acknowledgement; obsolete reads cannot replace a reopened
editor or a later save. Legacy checkbox state survives canonical HTML migration. Existing image sources
remain in the saved model; unsupported image display uses a retained-image
placeholder, so unrelated text edits cannot erase attachments.

While notes are open, the foreground view is inert and editing gestures cannot
complete or dismiss a task. The editor is destroyed and its observers/listeners
are disconnected on exit. Returning to a background task's notes does not resume
it. Queue selection still starts work; completion ends it, dismissal pauses/saves
before removal, and desktop DCC retains its existing explicit timer controls.

## Input contract and hardware boundary

Official Meta documentation checked October 31, 2026:
[web app input overview](https://developers.meta.com/wearables/web-apps/) and the
public [Wearables Documentation MCP](https://mcp.developer.meta.com/wearables)
`search_webapps_docs` results for browser-managed navigation and Back navigation.
The runtime provides standard arrow/Enter events; native Back traverses browser
history when a previous destination exists. The official
[Ray-Ban Meta Display FAQ](https://www.ray-ban.com/usa/c/frequently-asked-questions-meta-ray-ban-display)
documents a **single middle-finger tap against the thumb as Back** (double tap
is wake/sleep). Thus the expected chain is middle tap → native Back → browser
history → task list, or dismissal of an open review first. This mapping is
documented, not physically verified. The native shell can show its menu at the
app boundary, and the app does not recognize fingers or invent an SDK event.
The platform history budget is five entries; only task destinations and
notes destinations and transient reviews push entries. User settings can invert swipe direction, which
also requires on-device verification.

Left/right traverse each horizontal list. Within focused task selection, ArrowRight
completes and ArrowLeft dismisses. Enter/Space activate once; default activation and
held-key repetition are suppressed. Other directional input remains browser-owned
for scrolling and spatial focus; Tab stays available. Desktop Escape follows the
same history Back path. No sensor, Neural Band SDK, opt-in pinch-and-drag API, new
permission or custom gesture recognizer is added.

Official Meta text-input documentation also lists `contenteditable` as a supported
system-composer field. This editor reads committed `input`/`change` values, without
requiring per-character key events or adding custom voice/keyboard SDKs. **If the
system composer is open, native Back dismisses it before traversing page history**;
then Back leaves notes, followed by Back to the task list. Composer availability
and behavior must be checked on the paired hardware.

All current UI evidence is desktop Chromium using synthetic records and keyboard
input, at 320×600, 375×812, 600×600, 1440×1000 and 200% zoom. Actual Meta glasses,
Neural Band gestures, additive optics, native spatial navigation and on-device
login are **not physically tested**.

## Implementation and persistence

`public/js/device-views/glasses-queue.js` owns presentation and navigation only.
`working-queue.js` continues to own canonical commands, account/workspace-scoped
retry receipts, revisions and cross-client refresh. Offline gestures are refused.
An uncertain sent command retains its original receipt for existing automatic or
manual retry. It cannot be replaced by another gesture. Completion is shown as
confirmed only after server reconciliation.

A read-only `/api/working-queue/tasks/:id/tree` endpoint uses the same owner check
and canonical `getSubtree` traversal (local IDs, canonical IDs and parent links).
It includes completed child tasks, excludes deleted/foreign records, and passes
rows through `TaskModel.fromBlocksTree` for canonical projection and parent-first
display. Subtree reads refresh with accepted queue snapshots even when ordinary
child edits do not change the queue revision. Open-task search filters completed
records before pagination; the default search still includes history. The source
list refreshes at most once per minute while visible and active, without scanning
completion history on every queue revision. Notes add only the narrow authenticated
endpoint described above; no database migration is introduced.

Building-block check:
- Matched: One projection, many surfaces; Guard your guards.
- Reuse: TaskModel projection, canonical task hierarchy, Working Queue coordinator, existing block editor and task-owned/legacy note storage.
- Invariants: one foreground, no duplicate memberships, receipts before writes,
  revision-safe commands, account ownership, navigation without work-clock writes.
- Local choices: two horizontal rows, focused view, left-dismiss/right-complete.
- Missing mechanic implemented: glasses presentation and gesture-to-command adapter.
- Proposed catalog additions: none.

## Verification

Use a **disposable local** PostgreSQL database. Neither localhost:8090 nor
production is a QA fixture.

```sh
PORT=18459 DCC_WORKING_QUEUE_REVIEW=1 DCC_TEST_DATABASE_URL=<disposable-local-postgres> node scripts/ui-review-server.mjs
DCC_GLASSES_REVIEW_URL=http://127.0.0.1:18459 node scripts/verify-glasses-working-queue.mjs
DCC_TEST_DATABASE_URL=<separate-empty-local-postgres> node --test --test-concurrency=1
npm run lint
```

The browser verifier refuses non-loopback endpoints and requires `reviewOnly` health.
It seeds only fictional tasks in a unique schema. The suite covers pagination,
add/dedup, one activation per selection, open/completed subtasks, notes selection without timer changes,
Back/Forward/reload, other-client foreground changes, offline input, receipt storage
failure, subtask-read retry, revision conflict, partial dismissal failure, re-add,
lost completion response/reload/retry, viewport layouts, itinerary fallback, nested
parent grouping, same-revision child edits, hidden/inactive polling suppression,
and real guided-task previews, Native Back, Forward-after-cancel, required outcomes
and same-receipt failure retry. The verifier waits for the retry acknowledgement,
not merely a task list that may already be visible. Notes checks cover autosave,
failed-save Back/reload, explicit conflicts, stale reads across reopen and task
switches, newer input during an older save, local-storage failure and unload
protection, separate-tab recovery, account/task isolation, legacy checkbox fidelity,
and exact focus/scroll restoration.
`glasses-queue-tree.test.js` covers authentication, owner/member separation, foreign
roots, deleted rows and canonical hierarchy links. `glasses-open-search.test.js`
checks open-only filtering before pagination; `task-model-block-tree.test.js` checks
nesting, canonical/local/parent links, date-scoped alias ambiguity and input purity.
`glasses-task-notes.test.js` covers owner boundaries, conflict races, replay,
empty notes, payload limits, legacy identity/broadcasts, ambiguous aliases and
unchanged timer state. The PostgreSQL CI subset includes all three database tests; CI also runs the full
app glasses browser verifier against its disposable review server.

Five mutation checks exercise add-without-timing, navigation-without-timing, pause-before-dismiss, held-input suppression and tree ownership. The standard queue browser regression also passes.

Node 20.20.2: full serial suite **3,336 passed, 4 skipped, zero failures**. Lint
reports **zero errors and 71 warnings**. The glasses browser verifier passes **23 groups**, and the shared queue
browser regression passes **31 checks**. These are local results, not a claim that
GitHub CI has run for this branch. The repository has no separate build script;
Express serves its static JavaScript directly. The first concurrent full run exposed
an existing workout test that counts `information_schema.tables` across all active
schemas (12 versus 3). Serial validation in a separate empty database passed.

## Release boundary

Local branch `feat/glasses-simple-focus`, based on `bf1c8c6` (#445). Journal work
remains in its separate checkout. No remote push, PR, merge, deployment, device
installation or production task mutation was performed. Release requires the
applicable authorization and exact-SHA deployment checks. Five independent
pre-review lanes (security, performance, correctness, tests, consistency), with
second-pass verification of findings, are complete; all confirmed issues were
fixed and rereviewed. No remaining code blockers were reported.

The repository requires an **explicit ship instruction** (`AGENTS.md`, shipping
section); the current feature/review request does not authorize pushing, opening
a PR, merging or deploying. The workflow deploys main to Railway (the AGENTS
heading still references the former Render target). No migration or destructive
SQL is introduced, so the workflow database-risk acknowledgement is not required
by this diff. A fresh backup is optional under the current repository policy.

Before claiming device readiness, validate single middle tap, guided-review Back,
Select repetition, swipe direction/inversion, spatial focus, additive-display
legibility and login on the paired Meta Ray-Ban Display and Neural Band. No
device install permission has been established. The user separately authorized
screenshot delivery in this private chat; the two Library screenshot identities
are updated through the supported replacement workflow when available. Logs stay
local. This screenshot permission does not authorize shipping.
