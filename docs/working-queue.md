# Working Queue

Working Queue is the working surface; Itinerary remains the plan and actuals. Existing tasks and recurrence occurrences can be added to an ordered queue without changing their schedule, hierarchy, or completion. One task is foreground for the account. Switching brings the selected task forward and puts previous focus at the end of Background. Paused and blocked tasks retain context; an optional check-back makes a background task appear in Needs You.

Normal app entry opens Working Queue. Explicit tab links and navigation history are preserved; opening a view never starts a clock.

See [Priority Queue semantics](priority-queue.md) for never-started classification and explicit priority ordering.

## Bounded first version

- Foreground, Needs You, Priority Queue, Background/paused, and collapsed Completed sections.
- Add existing tasks, move up/down (also Alt+Arrow and drag), edit return context, bring forward, send background, pause, block/unblock, complete, and remove membership.
- Check-back options: none, 5/15/30 minutes, 2 hours, or 1–1440 custom minutes. Snooze re-arms for five minutes; dismissal clears the reminder and preserves the task.
- Guided tasks require the current prompt preview before start/resume, and a confirmed outcome before completion. Existing prerequisite and revision guards still apply. Required access observations can be recorded in the existing guided task detail flow; no integrations are automatically approved.
- Background elapsed time is informational. Only foreground sessions enter the effort ledger. After missed check-ins, effort stops at the existing 50-minute/eight-hour cutoff; the remainder is recorded as an unknown interval in the command audit.
- Manual reminders coexist with explicit delegated-work progress reports. Reported review/unblock actions appear in Needs You. No arbitrary external assistant readiness detection, transcript monitoring, installed hook, or closed-browser notifications are provided. See [delegated work reporting](delegated-work.md).

## One model for UI and GPT

`conversation-store.js` owns every transition under the account advisory lock and unique foreground index. Both `/api/working-queue` and the authenticated `/mcp/dcc` tools call that store. Ordinary task timers and guided actions also use the coordinator when enabled.

`dcc_working_queue` reads the same state as the page. `dcc_queue` adds/removes/reorders tasks, preserves context, starts/pauses/backgrounds/blocks work and snoozes/dismisses check-backs. `dcc_complete_task` retains its separate completion scope. Read `dcc_task` for a guided preview. Commands require explicit `sourceEventId`, `expectedRevision`, and ISO `at` including timezone. Reuse the exact envelope on transport retry; conflicts require a fresh decision. Reads and mentions never start timers.

The existing `work_rotations` row becomes version 2 queue metadata (`order`, keyed `items`: status, note, joined/changed timestamps, reminder generation/deadline/claim). It is scoped by user and workspace, while `conversation_state.revision` and foreground ownership are account-wide. Task rows and the session ledger remain authoritative. Old rotation and conversational background records are adopted additively. No task hierarchy, schedules, recurrence definitions, workouts, or recorded actuals are migrated. The retired rotation endpoint returns 410; no second foreground writer remains.

The former rotation navigation entry point `DCCWorkRotation.open(from,to)` opens the queue. Queue Details uses `DCCTaskWorkspace.preview` when present so reading details never starts focus, otherwise the existing task modal. The separate floating-workspace commit `485ff46` is not bundled: its `DCCWorkRotation.focus(task)` caller must be adapted to this coordinator before that feature is merged. Do not restore its old rotation writer alongside the queue.

## Failure handling

- A command is saved locally before sending. Reload/offline retry keeps its original event ID, timestamp, and revision; stale commands are surfaced for review rather than silently rebased.
- Server transaction, account lock, revision check, and event identity make simultaneous UI/MCP/tab commands atomic and retries idempotent. Background changes do not start a second clock.
- Expiry is an absolute persisted deadline. A visible page reconciles on wake/online and every 15 seconds. A server claim deduplicates pet presentation across tabs/reload; a fresh state read after claim rejects late callbacks after snooze/completion.
- Claim-before-display favors no duplicates. A browser crash after claim can lose the pet animation; the task remains in Needs You until return, snooze, or dismiss. Notification is never evidence of task completion.
- Completion/deletion/resume or a new completion revision invalidates an old reminder. Reopened tasks return paused, with no revived timer. Queue removal leaves the underlying task and its records intact.
- A maximum of 100 retained items bounds the first version; remove completed memberships to make room.

## Activation and release gates

This is implemented code, not proof that the user's ChatGPT account is connected. Follow `docs/conversational-integration.md` for the existing additive schema, duplicate foreground audit and gated `010_conversation_foreground.sql` unique index. `DCC_CONVERSATION_ENABLED=true` enables the common coordinator and queue. The MCP endpoint can remain off via `DCC_CONVERSATION_REMOTE_ENABLED=false` until approved pairing.

A verified current production backup remains required before the database release. The previous Railway CLI attempt was Unauthorized; no current backup is asserted. Do not treat a generic ship instruction or the workflow's `[migration-ok]` text as a backup. Applying the foreground index requires resolving any existing conflicting clocks with the user, not silently deleting or pausing them.

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

## PR435 release-specific decision

The owner explicitly waived the backup prerequisite for this release on 2026-10-28. This supersedes the earlier PR435 backup hold above without claiming a backup exists or changing the default policy. See [the scoped release decision](releases/working-queue-pr435.md); migration audit, exact-candidate checks, deployment coordination and OAuth approval boundaries remain in place.
