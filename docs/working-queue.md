# Working Queue

Working Queue is the working surface; Itinerary remains the plan and actuals. Existing tasks and recurrence occurrences can be added to an ordered queue without changing their schedule, hierarchy, or completion. One task is foreground for the account. Switching brings the selected task forward and puts previous focus at the end of Background. Paused and blocked tasks retain context; an optional check-back makes a background task appear in Needs You.

Normal app entry opens Working Queue. Explicit tab links and navigation history are preserved; opening a view never starts a clock.

See [Priority Queue semantics](priority-queue.md) for never-started classification and explicit priority ordering.

## Bounded first version

- Foreground, Needs You, Priority Queue, Background/paused, and collapsed Completed sections.
- Add existing tasks, move up/down (also Alt+Arrow and drag), edit return context, bring forward, send background, pause, block/unblock, complete, and remove membership.
- Check-back options: none, 5/15/30 minutes, 2 hours, or 1–1440 custom minutes. Dismissal clears the reminder and preserves the task.
- Every Needs You item (due check-back, review request, or blocked report) offers Snooze with 5/15/30 minutes, 1/2/4/24 hours, or 1–1440 custom minutes. The dialog previews the time in the app timezone. A snoozed item shows "Snoozed until <time, zone>" in Background, labelled attention snoozed, not focused time; fresh running-worker evidence remains visible separately. Its review/blocked reason and details stay attached. Snooze again re-arms with a fresh generation; Dismiss snooze reveals the underlying reason in Needs You now. Return to Priority stays disabled, with the reason shown, while review is pending or the item is snoozed. Snooze never changes foreground, task timing, or worker state.
- Needs You also offers **Snooze all**. It previews the affected count and uses the same duration choices (default 30 minutes). One transaction snoozes the exact previewed set or rejects the whole batch if the queue changed. New attention items are never silently added. Empty queues and unresolved saves/conflicts disable the control; keyboard cancellation writes nothing. Transport retries retain the original command and deadline. Foreground, task status, worker reports and actuals are unchanged.
- Snooze expiry uses the same check-back reminder: the item returns to Needs You and the existing pet notification is claimed once. If the app is closed at expiry, it appears and alerts on the next active open; no closed-browser or push notification is sent.
- Guided tasks require the current prompt preview before start/resume, and a confirmed outcome before completion. Existing prerequisite and revision guards still apply. Required access observations can be recorded in the existing guided task detail flow; no integrations are automatically approved.
- Background elapsed time is informational. Only foreground sessions enter the effort ledger. After missed check-ins, effort stops at the existing 50-minute/eight-hour cutoff; the remainder is recorded as an unknown interval in the command audit.
- Manual reminders coexist with explicit delegated-work progress reports. Reported review/unblock actions appear in Needs You. No arbitrary external assistant readiness detection, transcript monitoring, installed hook, or closed-browser notifications are provided. See [delegated work reporting](delegated-work.md).

## One model for UI and GPT

`conversation-store.js` owns every transition under the account advisory lock and unique foreground index. Both `/api/working-queue` and the authenticated `/mcp/dcc` tools call that store. Ordinary task timers and guided actions also use the coordinator when enabled.

`dcc_working_queue` reads the same state as the page. `dcc_queue` adds/removes/reorders tasks, preserves context, starts/pauses/backgrounds/blocks work and snoozes/dismisses check-backs. `queue-snooze` accepts any Needs You item; send `generation` only when the item already has one. `dcc_complete_task` retains its separate completion scope. Read `dcc_task` for a guided preview. Commands require explicit `sourceEventId`, `expectedRevision`, and ISO `at` including timezone. Reuse the exact envelope on transport retry; conflicts require a fresh decision. Reads and mentions never start timers.

The existing `work_rotations` row becomes version 2 queue metadata (`order`, keyed `items`: status, note, joined/changed timestamps, reminder generation/deadline/claim). It is scoped by user and workspace, while `conversation_state.revision` and foreground ownership are account-wide. Task rows and the session ledger remain authoritative. Old rotation and conversational background records are adopted additively. No task hierarchy, schedules, recurrence definitions, workouts, or recorded actuals are migrated. The retired rotation endpoint returns 410; no second foreground writer remains.

The former rotation navigation entry point `DCCWorkRotation.open(from,to)` opens the queue. Queue Details uses `DCCTaskWorkspace.preview` when present so reading details never starts focus, otherwise the existing task modal. The separate floating-workspace commit `485ff46` is not bundled: its `DCCWorkRotation.focus(task)` caller must be adapted to this coordinator before that feature is merged. Do not restore its old rotation writer alongside the queue.

## Failure handling

- A command is saved locally before sending. Reload/offline retry keeps its original event ID, timestamp, and revision; stale commands are surfaced for review rather than silently rebased.
- Server transaction, account lock, revision check, and event identity make simultaneous UI/MCP/tab commands atomic and retries idempotent. Background changes do not start a second clock.
- Expiry uses a persisted deadline. The visible page updates clocks, lanes and due reminders on its 15-second local tick. Wake and reconnect also process pending writes and reminders. A server claim deduplicates delivery across tabs. A fresh read after claim suppresses late callbacks after snooze or completion.
- Claim-before-display favors no duplicates. A browser crash after claim can lose the pet animation; the task remains in Needs You until return, snooze, or dismiss. Notification is never evidence of task completion.
- Completion/deletion/resume or a new completion revision invalidates an old reminder. Reopened tasks return paused, with no revived timer. Queue removal leaves the underlying task and its records intact.
- A maximum of 100 retained items bounds the first version; remove completed memberships to make room.

## Browser reads

The browser coalesces existing workspace SSE hints for 150 ms. It also checks on initial load, view entry, visibility recovery and reconnect. A visible, online tab checks every 30 seconds if an event drops. The bound is one interval plus request latency under healthy responses. The app reloads on account or workspace changes. Open tabs reject responses and writes scoped to a previous account.

The browser opts in through `X-DCC-Queue-Scope` and sends its last `X-DCC-Queue-Version`. Unchanged reads return `{"unchanged":true}` before taking the foreground lock. Changed reads return `{state,version}`. Clients without the scope header use the existing snapshot contract. Responses use `Cache-Control: private, no-store`.

The owner-checked SQL fingerprint covers task rows, session markers, day roots, rotation metadata, legacy background rows, delegated reports and other-workspace foreground. It uses existing Postgres row versions and the command revision. The locked path compares fingerprints around projection reads. Concurrent edits suppress that response’s validator. Browser lane derivation handles time locally. Validators expire at reminder and worker lease boundaries so later reads also refresh the raw projection.

Browser writes and MCP commands send the existing workspace events after commit. Cross-workspace foreground writers also send a data-free account hint. The fingerprint covers direct writes and late commits that SSE can miss. The delta-sync cursor is prunable and omits queue-only tables. No schema change is required.

If the validator query fails, the endpoint returns the existing locked read. For operational rollback, set `DCC_QUEUE_CONDITIONAL_READS=0` to use that read for all browser checks. Revert the application change for a full rollback.

## Activation and release gates

This is implemented code, not proof that the user's ChatGPT account is connected. Follow `docs/conversational-integration.md` for the existing additive schema, duplicate foreground audit and gated `010_conversation_foreground.sql` unique index. `DCC_CONVERSATION_ENABLED=true` enables the common coordinator and queue. The MCP endpoint can remain off via `DCC_CONVERSATION_REMOTE_ENABLED=false` until approved pairing.

A fresh production backup is optional under the [DCC release policy](releases/database-backup-policy.md); no current backup is asserted. Database-risk acknowledgment does not claim a backup occurred. Applying the foreground index requires resolving any existing conflicting clocks with the user, not silently deleting or pausing them.

Production OAuth client registration, callback configuration, credentials/grants, and an actual ChatGPT connection require explicit action-time authorization. Synthetic OAuth tests establish protocol and scope behavior only. Once approved, verify the exact deployed SHA and use an expressly approved account task for a read/queue-write/read canary; do not alter live user records as release fixtures.

## Verification

Use a disposable localhost database only:

```
DCC_TEST_DATABASE_URL=... npm run test:postgres
DCC_TEST_DATABASE_URL=... node --test guided.test.js work-session-route.test.js
DCC_TEST_DATABASE_URL=... node scripts/verify-working-queue.mjs
npm test
npm run lint
```

The browser harness launches separate headless Chrome with a fresh profile. It checks cancellation, Escape, context, keyboard ordering, switch/effort/hierarchy, reload, expiry, multi-tab delivery, snooze, late responses, return/dismiss, lost-response recovery, offline cache, completion during delayed claim, Details, and mobile overflow. It never starts `server.js`, reads `.env`, or touches production.

### Refresh regression and release measurement

Run the browser fixture with `DCC_QUEUE_BENCHMARK=1 DCC_QUEUE_REQUIRE_IDLE_GUARD=1`. It observes two visible pages for five minutes after loading 91 synthetic queue items. It counts real queue GETs, snapshot builds, SQL statements and Postgres DataRow bytes. DataRow bytes exclude connection and protocol overhead outside those messages. It also checks edit and ordering propagation, dropped events, reconnect, reminders and account-switch races.

Local baseline at `890f1c6` and patched results used isolated Postgres and the same 91-item queue.

| Five idle minutes | Baseline | Patched |
| --- | ---: | ---: |
| Queue GETs | 40 | 20 |
| Full snapshots | 40 | 0 |
| SQL statements | 560 | 40 |
| Postgres DataRow bytes | 9,789,560 | 1,100 |
| HTTP body bytes | 11,074,000 | 360 |

The old timer failed the zero-snapshot guard. The patched browser received the remote edit in about 0.2 seconds. Separate two-window checks covered missed events, reconnect and reminder delivery.

After release approval, record the deployed SHA from Railway deployment metadata and match it to the reviewed merge SHA. Compare matched five-minute idle and active windows with the same queue sizes, tab counts and workload. Enable `DCC_QUEUE_READ_METRICS=1` for the approved window. Count `working_queue_snapshot_build` events for actual builds, including writes and other callers. Count `legacy`, `snapshot` and `fallback` GET results separately from `unchanged`. Use the corresponding Server-Timing headers to confirm HTTP outcomes. For any client still running pre-instrumentation code, inspect its revision before assigning a snapshot count.

Measure outgoing HTTP response bytes from Railway HTTP logs. Measure database traffic separately using Railway flows scoped to the Supabase pooler host and port, with direction and units recorded. Include application retries, writes and unrelated traffic when interpreting service-wide pooler totals. Use Postgres query statistics to isolate queue statements when available.

## PR435 release-specific decision

The owner explicitly waived the backup prerequisite for this release on 2026-10-28. This superseded the earlier PR435 backup hold without claiming a backup exists. The later [DCC release policy](releases/database-backup-policy.md) makes backups optional for future DCC releases. See [the scoped release decision](releases/working-queue-pr435.md); migration audit, exact-candidate checks, deployment coordination and OAuth approval boundaries remain in place.

## Completed time filter

Today is the initial selection on each page load; choices stay in memory only for
that view. Today means the calendar day in the queue's configured timezone (shown
beside the control), including daylight-saving transitions. Other ranges are rolling:
1 hour, 24 hours (1 day), 7 days (1 week), and 30 days (1 month). Boundaries include
both the cutoff and now. Last completed shows one newest timestamped occurrence;
canonical task ID breaks equal-time ties deterministically.

The complete retained queue snapshot is queried without LIMIT or pagination before
filtering. All time covers that entire retained membership across scheduled dates,
including older imported memberships; it is not the task-search result page or a
browser task cache. Removed memberships, deleted/archived tasks and reopened tasks
are excluded. Removing a card continues to remove it from this view.

Completion time comes from the canonical task completion fields or its authoritative
day-root completion overlay. Scheduled dates, updates, notes and session end times
are not substitutes. Completed tasks without a usable timestamp appear in All time
with “Completion time unavailable”; dated ranges explain how many are omitted.
Recurrence occurrences remain separate canonical tasks. Viewing/filtering writes no
queue state, completion, schedule, actuals or timers. Shared-link privacy is unchanged.
