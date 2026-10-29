# Shared activity queue

The existing `/todo/:token` page shows Foreground, Needs You, Priority Queue,
Background & paused, and Completed. Priority Queue means never-started work.
Canonical queue status controls the lane and public completion label.

## Access boundary

The feed is the intersection of the existing public day-task projection and
canonical Working Queue membership. A queue item never grants sharing access.
Private/redacted/guided tasks, backlog, other dates, nonqueued tasks, owner notes,
and delegated reports are excluded. Hidden priority rows cannot be inferred from
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

`npm test`, `npm run test:postgres`, `scripts/verify-shared-queue.cjs`,
`scripts/verify-work-completion.mjs`, and `scripts/verify-working-queue.mjs` cover
projection/privacy, owner/viewer/anonymous modes, revoked links, task hiding,
existing social mutations, account-switch races, completion cutoff/rounding,
legacy history, estimated history, stale revisions, duplicate submissions,
lost responses, accessible disclosures and 375px/desktop layouts.
The new browser scripts use disposable PostgreSQL schemas and synthetic data.
