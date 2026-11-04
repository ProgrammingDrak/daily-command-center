# Shared activity queue

The existing `/todo/:token` page shows what the owner is doing now, what is
running in the background, and what is planned, laid out like Working Queue.

## Viewer lanes (activity v2)

`lib/public-working-queue.js` `projectPublicActivity` places each shared task in
exactly one lane:

| Lane | Rule |
|---|---|
| Now | Queue foreground task |
| Running in background | Live worker lease (`DCCQueuePolicy.execution` = running, at most 15 min) |
| Up next | Priority order; paused, blocked, snoozed and Needs You items also land here |
| Later today | Shared timed tasks on this day not in the queue; past meetings/breaks/OOO drop off |
| Done today | Completed queue tasks and done shared-day tasks |

Needs You and snoozes are the owner's inbox, so viewers never see them. Hidden
focus (private, another date or workspace) looks exactly like no focus. Cards
carry an explicit field allowlist (`PUBLIC_TASK_FIELDS`) plus `activity`
(`lane`, `order`, minute-rounded `startedAt`/`confirmedAt`/`completedAt`,
`priority`). Notes, worker source/id, report text, review actions, reminders,
generations and actuals never leave the projection. A `queue.lane` field is kept
for pages loaded before this release, without a `needs-you` value.

`DCC_SHARE_ACTIVITY_V2=false` restores the PR #444 payload (`view:"working-queue"`).

## Live updates

- Owner writes ping `/api/public/todo-share/:token/events` (`lib/public-sse.js`).
  Pings coalesce per workspace (750 ms trailing), carry an `id`, and the stream
  sends `retry: 3000` plus a heartbeat comment every 25 s. Caps stay 100 total and
  20 per workspace.
- The page re-reads on every ping, on `connected` (so each reconnect catches up),
  on returning to the tab, on `online`, and at `nextChangeAt` (the earliest
  visible worker lease expiry). A visible tab also polls every 30 s.
- A read during a read waits for a fresh read. A 404 clears the page and shows
  "This shared link is no longer active". Other failures keep the last content,
  show Offline with the last update time, and retry with backoff to 60 s.
- The status pill reads Live, Live (checking every 30s), Reconnecting, Offline,
  or Link no longer active.

## Access boundary

The feed is the existing public day-task projection, ordered and labelled by
canonical Working Queue state. A queue item never grants sharing access.
Private/redacted/guided tasks, backlog, other dates, untimed nonqueued tasks,
subtasks, owner notes and delegated reports are excluded. Timed nonqueued tasks
appear in Later today; the same viewers could already export them. Hidden priority rows cannot be inferred from
rank gaps. Existing recipients, tokens and task visibility are unchanged.
The existing share model has active/revoked state, without link expiry.

Reactions, comments, bounty requests and reward offers use existing routes and
capabilities. Offers remain pending until owner approval. Viewing this page never
writes timers or actuals. Owner controls remain on the owner queue. Filtering and
polling preserve drafts; viewer identity transitions invalidate earlier responses,
including returning to the same account.

## Owner context and completion

Cards show a short context sentence and next review action, with full text behind
Details. Stored notes and report history are preserved. Open task still opens the
existing task workspace.

Completion previews read only the canonical task's own session ledger under the
account coordinator lock. They show saved history, timer elapsed, and an estimated
total after completion. Credit stops at the existing missed-check-in/hard-stop
cutoff. Ledger seconds are summed before rounding; legacy saved minutes outside
the ledger are carried forward, while reconciler estimates are replaced by real
measurements. Parent, child and other recurrence effort is not mixed into the
preview. The existing atomic done command closes the timer and completes the task.
A lost response retains its event ID, timestamp and revision for a safe retry;
only an acknowledgment confirms the final total. A stale revision requires a new
preview. Opening or cancelling the dialog writes no task data.

## Existing unmerged work

PR421 and its PR422 stack remain separate and unmerged. This change adapts the
composer draft/pending lifecycle but does not adopt the stack's expanded reward
model, permissions, scheduling, or execute/suggest task actions. Future integration
must preserve this public allowlist and queue lanes when attaching unified actions.
No unrelated commits from either PR are merged here.

## Verification

`npm test` (including `public-sse.test.js`), `npm run test:postgres`, `scripts/verify-shared-queue.cjs` (now also live pings, worker lease, revoke-while-open),
`scripts/verify-work-completion.mjs`, and `scripts/verify-working-queue.mjs` cover
projection/privacy, owner/viewer/anonymous modes, revoked links, task hiding,
existing social mutations, account-switch races, completion cutoff/rounding,
legacy history, estimated history, stale revisions, duplicate submissions,
lost responses, accessible disclosures and 375px/desktop layouts.
The new browser scripts use disposable PostgreSQL schemas and synthetic data.
