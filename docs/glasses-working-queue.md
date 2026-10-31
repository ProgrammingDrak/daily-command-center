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
(including completed steps). Select toggles start/pause. Pausing keeps the view
open; DCC's canonical queue status becomes paused. Swipe right completes through
DCC's completion coordinator. Swipe left dismisses from the queue: an active
session is first paused and saved, then membership is removed. Dismissal never
completes or deletes the task. If pause is unconfirmed, removal is not attempted.
If removal fails, the paused task stays visible for retry. If another client starts
it between those operations, the server rejects removal instead of hiding a
running timer. A dismissed task can be selected again in All open tasks.

Back returns to the two rows and leaves timing untouched. Back and Forward use
browser history, including after reload. One destination entry is pushed for the
focused view, never for focus changes, timer toggles or polling. Existing collection
and task-library URL persistence now preserve the shared history state.

Guided tasks retain their required instruction preview and completion outcome
review through the existing shared dialog. Ordinary tasks do not get extra dialogs.
Pending updates, conflicts and failed subtask reads expose recovery only when needed.

## Input contract and hardware boundary

Official Meta documentation checked October 31, 2026:
[web app input overview](https://developers.meta.com/wearables/web-apps/) and the
public [Wearables Documentation MCP](https://mcp.developer.meta.com/wearables)
`search_webapps_docs` results for browser-managed navigation and Back navigation.
The runtime provides standard arrow/Enter events; native Back traverses browser
history. The requested middle-finger Back gesture remains the runtime's mapping:
this app does not recognize fingers or claim a new SDK event.

Left/right traverse each horizontal list. Within focused task selection, ArrowRight
completes and ArrowLeft dismisses. Enter/Space activate once; default activation and
held-key repetition are suppressed. Other directional input remains browser-owned
for scrolling and spatial focus; Tab stays available. Desktop Escape follows the
same history Back path. No sensor, Neural Band SDK, opt-in pinch-and-drag API, new
permission or custom gesture recognizer is added.

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
rows through `TaskModel.fromBlock` for display. No database migration or new task
mutation endpoint is introduced.

Building-block check:
- Matched: One projection, many surfaces; Guard your guards.
- Reuse: TaskModel projection, canonical task hierarchy, Working Queue coordinator.
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
add/dedup, one activation per selection, open/completed subtasks, timer toggles,
Back/Forward/reload, other-client foreground changes, offline input, receipt storage
failure, subtask-read retry, revision conflict, partial dismissal failure, re-add,
lost completion response/reload/retry, viewport layouts and itinerary fallback.
`glasses-queue-tree.test.js` covers authentication, owner/member separation, foreign
roots, deleted rows and canonical hierarchy links.

Five mutation checks exercise add-without-timing, navigation-without-timing, pause-before-dismiss, held-input suppression and tree ownership. The standard queue browser regression also passes.

Node 20.20.2: full serial suite **3,332 passed, 4 skipped, zero failures**. Lint
reports **zero errors and 71 warnings**. The repository has no separate build script;
Express serves its static JavaScript directly. The first concurrent full run exposed
an existing workout test that counts `information_schema.tables` across all active
schemas (12 versus 3). Serial validation in a separate empty database passed.

## Release boundary

Local branch `feat/glasses-simple-focus`, based on `bf1c8c6` (#445). Journal work
remains in its separate checkout. No remote push, PR, merge, deployment, device
installation or production task mutation was performed. Release requires the
applicable authorization, independent reviews and exact-SHA deployment checks.
