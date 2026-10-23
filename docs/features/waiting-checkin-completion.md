# Completing work from a check-in

The itinerary check-in checkbox and the Loose Ends Waiting checkbox open the same
“Finish check-in” dialog. Native radios offer **Check-in done — still waiting**
(the default) and **Complete task**. Desktop uses the existing modal, mobile uses
its sheet, with the shared focus trap, Escape/cancel and focus return. The selected
task title stays visible. Next date and optional note belong only to check-in-only;
choosing completion hides and disables them without losing an unsaved draft.

## Persistence and semantics

- Check-in-only retains the existing captured cycle/history-count contract. It
  advances follow-up, records the zero-minute check-in log, and leaves work open.
- Complete task calls the existing Waiting completion action and canonical
  `setTaskCompletion`, including its subtree, timing, completion revision,
  recurrence hooks, participant notifications and reward eligibility. It adds no
  check-in-history entry or separate client-side triage reward.
- Only the linked occurrence is completed; future occurrences and other
  participants' private task rows are untouched. Standalone Waiting work closes
  its own record without inventing a task row.
- The explicit choice can resolve a task dependency even while its prerequisite
  is open: the user is declaring their work finished. The prerequisite is not
  completed. Existing callers without the explicit flag keep the prior ready-only
  guard. The explicit action requires the Waiting version captured on opening.
- Ownership remains workspace-scoped. Missing/deleted linked work and stale edits
  return a conflict rather than silently closing the Waiting record. The linked
  task and Waiting record commit together using the existing companion CAS. CAS
  now compares PostgreSQL Date values at millisecond precision. Standalone
  Waiting completion locks and rereads its row before writing.
- In-flight controls prevent duplicate submissions. A retry keeps its captured
  timestamp/version. Once Waiting is done, replay repairs only that completion's
  interrupted timing and outstanding reminders; it cannot re-complete reopened
  work. Shared notification revisions and canonical completion remain unchanged.
- Reminder cleanup retains the existing post-commit canonical cascade. A partial
  failure returns `cleanupPending`, honestly shows “Task completed” with **Retry
  cleanup**, and locks the outcome choice. After reload, a remaining itinerary
  reminder offers cleanup only. A check-in with no active cadence offers actual
  completion only. Reopening a task does not resurrect finished check-ins.
- This existing cross-row action requires a connection. An error keeps the dialog
  and draft for a manual retry; it does not optimistically mark work done or queue
  an unconfirmed offline completion. Reload discards unsent drafts and reads the
  canonical persisted state.

## Verification

Use Node 20. `npm test`, `npm run test:postgres`, and `npm run lint` apply. The new
`waiting-completion-postgres.test.js` uses only a disposable localhost schema or
explicit in-memory PGlite. It covers concurrent/repeated completion, stale edits,
missing work, workspace isolation, dependencies, recurrence, per-person completion,
notification deduplication, millisecond CAS, and interrupted cleanup.

For real browser coverage (synthetic data only):

```sh
PORT=8344 DCC_WAITING_REVIEW=1 DCC_PGLITE_MODULE=@electric-sql/pglite node scripts/ui-review-server.mjs
node scripts/verify-waiting-task-completion.mjs http://127.0.0.1:8344
node scripts/verify-waiting-checkin.mjs
```

The first script refuses non-local/live servers and covers both actual surfaces,
1280/390/320 px, keyboard, touch emulation, cancel/focus, retries, repeated submits,
reload, lost acknowledgements and interrupted cleanup recovery. No production
server, provider integration or physical mobile device is exercised. This repository
has no separate build or type-check script.
