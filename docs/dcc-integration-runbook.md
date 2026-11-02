# DCC direct integration: completion and progress reconciliation

**Status: implemented in an isolated checkout; not released or connected by this task.** This document is the maintained operational contract for chat completion and task reviews. The repository skill at [`.agents/skills/dcc-integration/SKILL.md`](../.agents/skills/dcc-integration/SKILL.md) routes here. It does not install tools into ChatGPT or grant access.

## Verified findings, 2026-11-02

- This checkout starts from deployed main `bf1c8c617301a611fa6de8da47cdd38d2dacf9e7` (#445). The read-only production health check returned that exact revision and HTTP 200.
- Canonical production origin: `https://daily-command-center-production-1d04.up.railway.app`. The repository's existing `scripts/check-conversation-readiness.js` returned HTTP 503 `remote_disabled` for protected-resource discovery, authorization-server discovery and `/mcp/dcc`. Remote MCP availability is therefore **blocked by configuration**, not proven by page health or a browser login. No configuration was changed.
- The first check inside this task's network sandbox returned no HTTP status. A permitted network retry reached the origin and produced the explicit 503 result above. Treat DNS/socket restrictions in a particular execution environment separately from remote service configuration.
- Another tracking session previously reported hostname resolution failure through the supported session client and a browser redirect to Sign In. Those are historical, environment-specific findings, not evidence of a global outage.
- A separately verified authenticated cloud browser rendered the synced Working Queue. Its session was distinct from the local browser and any remote OAuth grant; no account/session identifiers or live task inventory are published here.
- No DCC connector tools were exposed to this implementation chat. This task performed **no real task mutations**. The designated cloud-browser worker owns real queue reconciliation; do not duplicate its writes.
- Implementation used an isolated feature checkout. Other live feature checkouts were not edited. Release and connection authorization remain separate.

## One supported architecture

The current direct integration is the account-scoped remote MCP server in [`routes/conversation.js`](../routes/conversation.js), with OAuth in [`conversation-oauth.js`](../conversation-oauth.js) and the account coordinator in [`conversation-store.js`](../conversation-store.js). It supersedes using the old scheduler-only `mcp/dcc-mcp/server.js` as a general task integration.

The older brain `dcc_task_ops.py` and `dcc_client.py` use a separate password/session profile. The old completion helper PATCHes a full property bag and does not implement the atomic iteration protocol. Do not use that helper to approximate this feature with two independent writes. No endpoint or credential is invented by this runbook.

Reconciliation reuses `conversation_events` for source-event idempotency and audit, `conversation_state` for account revision, canonical `setTaskCompletion` for status, canonical reversible `deleteBlock`/`undeleteBlock` for Drop/Undo, and the existing block store for successors. It adds no database tables or migration. The canonical writer's internal `includeDescendants:false` option permits a narrowly scoped completion without rewriting already completed children; existing callers retain their cascading default.

## Connection and minimum permissions

Read [connection readiness](chatgpt-connection-readiness.md) and [the original integration guide](conversational-integration.md) before an operator changes ingress or pairs an account. Configuration names, never secret values:

| Configuration | Meaning |
|---|---|
| `DCC_CONVERSATION_ENABLED` | Enables the coordinator/remote implementation; existing foreground migration readiness is still required. |
| `DCC_CONVERSATION_REMOTE_ENABLED` | Remote surface switch; `false` leaves it unavailable even if a browser is signed in. |
| `DCC_CONVERSATION_URL` | Approved canonical HTTPS origin. |
| `DCC_CONVERSATION_CLIENTS` | Approved public client IDs, names and exact HTTPS callback allowlist. |
| `DCC_TIME_ZONE` / `APP_TIME_ZONE` | Account application's calendar timezone; default America/New_York. On 2026-11-02 this is UTC−05. |

Use the existing account login and per-account OAuth consent with S256 PKCE. New accounts need their own grants. Never place `SECRET_PA_TOKEN`, `DCC_PA_TOKEN`, a password profile or an admin token into the remote MCP configuration. This implementation retains predefined public clients; it does not add dynamic registration.

| Operation | Minimum granted scopes |
|---|---|
| Search/read tasks, review candidates, receipt readback | `dcc.read` |
| Explicit full completion | `dcc.complete`; also request `dcc.read` for identity and verification |
| Review choices, progress/next-iteration creation, reversible drop and undo | **new opt-in `dcc.reconcile`**; also `dcc.read` |
| Queue commands (including `queue-return`), pause or switch foreground | Existing `dcc.work`, only for the explicit requested action |
| Delegation lifecycle / time corrections | Existing `dcc.delegate` / `dcc.correct`, only if separately needed |

Existing grants do not silently gain `dcc.reconcile`. Its consent text explicitly describes successor creation and reversible dropping. Introducing the scope in code is not consent or live configuration. Enabling ingress, registering callbacks, deployment and actual per-account authorization remain release steps requiring their own authorization.

Read-only ingress command (no credentials or task writes):

```sh
node scripts/check-conversation-readiness.js https://daily-command-center-production-1d04.up.railway.app
```

Expected successful pairing sequence: approved ingress configuration → metadata and 401 challenge pass → supported client/account pairing → displayed consent approval → tools actually appear in the intended chat → approved synthetic canary and readback. A browser's “Synced” indicator verifies that browser's app saves, not MCP authorization.

## Tool and browser contracts

| Tool | Contract |
|---|---|
| `dcc_search_tasks({query, offset?})` | Paginate existing tasks, completed records and recurring definitions/instances; never create on a miss. |
| `dcc_task({taskId})` | Read canonical row, sessions, account `revision` and `reconciliationVersion`. |
| `dcc_complete_task({...})` | Explicit full completion with `taskId`, `sourceEventId`, `expectedRevision`, `expectedTaskVersion`, `at`, and concise `outcome`; optional explicitly known `completedAt`. Uses the safe reconciliation transaction. |
| `dcc_completion_review({date?})` | Up to five deterministic unfinished candidates, local date/timezone, canonical IDs, task versions and available choices. No writes or scheduling. |
| `dcc_reconcile_task({...})` | `taskId`, source-event envelope and nested `reconciliation`, described below. |
| `dcc_reconciliation_receipt({sourceEventId})` | Read the stored event and reverify all affected records, including dropped rows and both iteration records. |
| `dcc_activity_history({})` | Last 100 explicit events; useful for locating the event to undo. |

Existing tools (`dcc_current_activity`, `dcc_work`, queue/delegation tools and time correction) retain their purposes. New completion calls must first read the task version and include the outcome; old incomplete argument envelopes fail closed.

The authenticated browser uses the same store through the existing Working Queue session/owner gate:

- `GET /api/working-queue/completion-review?date=YYYY-MM-DD`
- `GET /api/working-queue/task/:id`
- `POST /api/working-queue`, with `action:"reconcile"` and the same command envelope.

The “Did these happen?” launchers live in the existing Glymphatic Brief and Day Review. The remote server's instructions also route the existing morning/evening reviews to `dcc_completion_review`. **No automation or notification schedule was created.**

## Identity and choosing the exact scope

Search and inspect the actual canonical task, date, parent and recurring-definition ID. Similar titles require a narrow choice (“Tuesday's call or the recurring weekly call?”), not confidence-based guessing. The mutation requires a canonical row ID, not a title or series ID. Searching never creates a missing task.

Do not close a parent with unfinished scope. The transaction checks the current hierarchy under its lock. Complete the concrete subtask, or use progress rollover on a leaf. Full parent completion is permitted only after its task descendants are already done and leaves their historical records unchanged. Parent status is not inferred from a child completion.

Calendar events, breaks, guided routines, workouts and meals keep their existing outcome flows. A recurring definition cannot be dropped/completed here. A full occurrence completion uses the existing recurrence reconciler; Drop tombstones only that leaf occurrence. Progress on a recurring occurrence records a completed child iteration plus a next-action child while keeping the occurrence/definition open, so it does not falsely reset cadence. Progress on a prerequisite/blocked goal follows the same child-iteration pattern, preserving the Waiting dependency; dropping a linked dependency task requires its existing dependency flow. Undo refuses a recurring completion when another open occurrence exists.

Active foreground timers must be explicitly paused through the existing timing flow first; fresh running background execution must have an honest stopped/unknown report or expire before reconciliation. DCC bookkeeping does not stop external workers. Reconciliation never derives effort from elapsed time. Its `at` is the source report/decision instant with timezone. Omit `completedAt` unless the user knows it: compatibility completion timestamps record the report, with `completionTimeKnown:false` and separate `completionReportedAt`, not a claim about the exact finish time. Notes, recorded time entries, actual effort, recurrence fields and unrelated properties are preserved.

## Explicit chat completion

“I called the card companies” is a completion report when it clearly matches that task's scope. Read/search, resolve identity and send once, with a source event namespaced by conversation/message and task (e.g. `chat:thread-42:message-18:task-7`). Do not create a fresh event ID after a timeout.

Synthetic example, with placeholders replaced from a fresh read; never run against an arbitrary real task:

```json
{
  "taskId": "fixture-call",
  "sourceEventId": "fixture:chat-1:message-1:call",
  "expectedRevision": 3,
  "expectedTaskVersion": "<dcc_task.reconciliationVersion>",
  "at": "2026-11-02T07:15:00-05:00",
  "outcome": "Called the card companies and confirmed the requested changes."
}
```

Send through `dcc_complete_task`. Follow with `dcc_reconciliation_receipt` or inspect its verified result. Do not describe merely reported or queued work as saved.

## Meaningful progress → next iteration (“plus one”)

An entire phase does **not** need to be complete. Meaningful progress is enough when the user intends to close this work iteration and continue the goal. Summarize accomplishments and remaining work concisely. Do not automatically fragment every tiny update. If the remaining work is unclear, ask a short choice before rollover.

Call `dcc_reconcile_task`:

```json
{
  "taskId": "fixture-delete-investigation",
  "sourceEventId": "fixture:chat-1:message-2:delete",
  "expectedRevision": 4,
  "at": "2026-11-02T07:20:00-05:00",
  "reconciliation": {
    "choice": "step_done",
    "expectedTaskVersion": "<fresh task version>",
    "completedTitle": "Investigate the delete failure",
    "outcome": "Reproduced the failure and narrowed it to deletion order.",
    "nextStep": {
      "title": "Fix the identified deletion order",
      "summary": "Update the deletion sequence and run the regression checks."
    }
  }
}
```

The original goal/title is retained in `originalGoal` and `goalId`; the closed iteration gets its concise accomplishment in `completionOutcome`, and the successor gets `remainingWork`, `previousStepId` and iteration lineage. The closed row points to `nextStepId`. `goalComplete:false` and `broaderGoalComplete:false` distinguish an iteration from the overall objective. Parent/project relationships are retained; the successor receives no invented actuals or inherited timer. A standalone next step starts unscheduled. Children stay in their parent's date/pool. Existing notes are not replaced. New records inherit explicit visibility, defaulting to private when unspecified; the accomplishment/remaining summaries are exposed through the shared task projection. Old offline property saves cannot erase the reconciliation-owned lineage or outcome metadata.

To reuse a known existing next-action task, send `nextStep:{taskId,expectedTaskVersion,summary}` instead of a new title. It must be unfinished, preserve the same parent and not already belong to another iteration. This prevents duplicate successor creation. Exact replay always returns the same successor. A completed origin cannot be rolled over again with a fresh message ID without an explicit correction.

Both records and the source event commit in **one transaction**. Injected failure after successor creation or after completion rolls everything back. After a lost response, replay the exact envelope or read its receipt; never perform separate completion/create fallback writes.

## Review choices and undo

- **Done:** collect the concise outcome and complete only that scope.
- **Still working:** record the review date, leave the task open, and suppress it only for that day's review. It can reappear tomorrow.
- **Drop it:** preview the exact task/occurrence and reversible consequence, then tombstone that leaf. It does not complete or cancel the recurring series or discard actual-time history.
- **Progress made → next iteration:** collect accomplishment, iteration title, next task title and remaining summary; use the transaction above.
- **Undo:** use a new source event with `reconciliation:{choice:"undo",expectedTaskVersion,undoEventId:"<original-sourceEventId>"}` and a current account revision. The original receipt supplies the dropped/completed row's version. Later edits, changed successors or a changed hierarchy cause a conflict rather than overwriting newer work. Newly created successors are reversibly tombstoned; an existing linked successor is preserved and unlinked. Historical effort is never undone.

The browser stores a pending exact envelope in account/workspace-scoped session storage before sending. Closing/reloading preserves a pending decision and requires an explicit Retry; it never automatically submits unanswered choices. Storage failure prevents dispatch. A lost response retains the envelope. A definite 400/403/404/409 is shown and requires review; it does not loop. Undo is sequenced after verification of the pending operation.

## Persistence states and recovery

| State | Meaning and next action |
|---|---|
| Reported completion | The user said work happened; DCC has not been changed yet. |
| `pending_write` / Saving | Command preserved, transaction/readback not verified. No success claim. |
| `verified_saved` | Committed event and every affected record reread and matched. For rollover, both records verified. |
| `save_uncertain` | A postcommit read failed. Keep exact envelope; retry/read receipt. Do not create another operation. |
| `stale_conflict` | The old save exists but current rows differ, such as after Undo. Show the current state; do not repeat the old intent as a new command. |
| HTTP/RPC 409 | Account revision, task version, hierarchy or scope changed. Reread and resolve intent; never silently increment the revision. |
| `not_found` receipt | No committed source event found at that read; a request can still be in flight. Exact retry remains the safe path. |
| 401/403 | Missing/expired session, missing scope or wrong account/ownership. Stop the dependent write and report the exact access blocker. |
| 503 `remote_disabled` | Remote configuration is disabled; a browser login does not fix it. Continue independent local work. |
| DNS/network error | Diagnose the supported origin from the affected host, distinguishing name resolution, sandbox egress and HTTP response. Do not guess another host or bypass denied access. |

The account advisory lock and task/hierarchy locks serialize mutations. `expectedRevision` catches other coordinator events; the full task fingerprint catches edits by other routes. Duplicate source IDs with changed payloads are refused. Minimal property changes use the freshly locked row, preserving unrelated data. Read-only grants expose reviews/receipts; write-only grants receive only a minimal acknowledgement and save status, not private task snapshots.

## Supported fallback and boundaries

An already-authenticated DCC browser may perform the user's authorized task action through the existing UI, with visible saved/readback evidence and a single designated writer. It does not enable MCP or grant additional scopes. Do not extract cookies/tokens, create credentials, broaden callback allowlists, use a legacy admin token, or route around a denied action. The session CLI is a separate supported path for the operations its actual contract implements; it is not an atomic progress-rollover fallback.

If connection or permission is missing, keep implementation/tests and draft documentation moving, report the precise blocked step, and leave real tasks unchanged. “Built locally” and “saved in DCC” are separate outcomes.

## Operational lessons from separately verified browser reconciliation

Live task identities and personal outcomes are retained outside this public repository. This static guide is not live DCC state and authorizes no additional task writes. The implementation tests use synthetic fixtures only.

- Queue identifiers and backing Library row IDs can differ. Open the task and verify the mapping; use the canonical `dcc_task.task.id` for direct writes.
- Context and Notes are separate fields. Preserve both when adding a concise iteration summary.
- Library search can reset Completed to All open. Verify the active filter before treating an empty search as evidence that a task is absent.
- A UI timeout can follow a successful mutation. Reread task and successor before retrying; preserve the exact direct-integration envelope and receipt.
- Browser sessions are host-specific and do not imply a remote OAuth grant. Use one designated writer for live reconciliation.

## Validation and release

The isolated tests use synthetic accounts/tasks and a disposable localhost PostgreSQL schema. No production environment file was copied. The synthetic browser harness uses the real session route, shared modal and review module.

```sh
DCC_TEST_DATABASE_URL=postgres://<local-user>@127.0.0.1:<isolated-port>/postgres \
  node --test task-reconciliation.test.js task-reconciliation-http.test.js
# Optional Mac browser acceptance (installed Chrome, synthetic server only):
DCC_BROWSER_TESTS=1 DCC_TEST_DATABASE_URL=<isolated-localhost-url> \
  node --test task-reconciliation-ui.test.js
```

Verified targeted run: **73 tests passed, zero failed/skipped**, including the new PostgreSQL, real MCP/HTTP and Chrome scenarios plus existing completion, task projection and conversation regression tests. Coverage includes duplicate/changed replay, correction/Undo, ambiguous titles, partial children, recurring instances, existing successor, concurrent edits, rollback after either write, uncertain readback, OAuth scope separation and interrupted browser decisions.

Full final sequential repository run, including the queue-policy extension, on supported **Node 20.20.2**: **3,351 passed, zero failed, four environment-dependent skips** (two shared Mycelium/parser gates and two separately gated PostgreSQL integration fixtures). The machine default Node 24.13.1 also passed the earlier full run (3,346 passed before the final dependency test); release evidence uses the supported Node 20 run. The parallel run exposed an unrelated workout-schema test that queries table names without a schema predicate; its count included concurrent isolated schemas. That test passed alone, and the sequential full suite passed. Backend and new browser-module ESLint checks and skill validation passed.

Final dedicated reconciliation run after the last dependency and visibility safeguards: **16 passed, zero failed/skipped**, including Chrome.

Six mutation checks removed the task-version, readback-state, partial-scope, recurring-cycle, offline-lineage and scope-separation guards in turn. Each was detected by its acceptance test; every source file was restored from the local commit. Repository lint: zero errors (71 existing warnings); the new browser module also passes its explicit browser-global lint check.

Remaining release steps: review code and the new consent scope; approve a draft PR/push if desired; approve deployment through normal gates; separately enable remote ingress and approve the intended account's minimum scopes; verify tools in the actual chat; run only an explicitly approved synthetic canary. No PR was opened, no production deployment/configuration changed, and no real completion/rollover was saved by this implementation task.

## Working Queue policy and safe lane transitions (implemented locally)

These rules apply to the existing queue and morning/evening review entry points. They introduce no recurring notification schedule or worker polling service.

| Queue | Meaning and evidence |
| --- | --- |
| Foreground | The one task the person is actively doing. The account coordinator switches tasks atomically and the database enforces one foreground clock per user. |
| Needs You | An explicit worker review/unblock request, an explicitly marked blocker, or a due check-back timer set on work. It is not an arbitrary backlog. Resolve the request or check-back before returning to Priority. |
| Priority Queue | Inactive unfinished work, including previously started, paused, stopped and unverified work. High → Medium → Low, preserving relative order within each priority. Prior effort remains recorded. |
| Background | A Claude/job/process with fresh, explicit evidence that it is executing. An open chat, task status, elapsed timer or historical report is insufficient. |

Each main lane has a native disclosure info tip usable by keyboard and touch. Open tips and keyboard focus survive normal redraw. Cached rendering independently expires worker evidence so offline data does not keep describing a stale worker as running. No read path rewrites task status, queue membership, order, Context, Notes, recurrence or effort just to classify a lane.

### Worker evidence contract

`dcc_delegate` retains its existing stable `delegation.work` identity and increasing `sequence`. Its optional `delegation.execution` is an observation supplied by the worker's host, not an inference from an open task:

```json
{
  "state": "running",
  "observedAt": "2026-11-02T12:00:00Z",
  "validUntil": "2026-11-02T12:10:00Z"
}
```

A running observation requires phase `working`, cannot be later than its report, and expires within at most 15 minutes of observation. A host that cannot establish that interval must omit execution evidence or report `unknown`; a stopped worker reports `stopped` with `observedAt` and no `validUntil`. The same exact transport retry keeps the envelope, sourceEventId and sequence. A newly observed execution state uses a new sourceEventId and increased sequence. Reports do not manufacture focused time, start external processes, create schedules, or grant permission for external actions. Multiple current worker identities can coexist; any valid running observation establishes execution while an explicit review request still takes display precedence in Needs You.

Existing worker integrations that send only phase `working` will appear in Priority until they supply this evidence. Updating worker adapters to observe execution is a rollout requirement, not permission to install monitoring or expand access. The 15-minute bound is a conservative display lease, not a claim that the job stopped at expiry. UI copy calls manual `background-start` **Set aside / check back** because it only updates DCC bookkeeping and optional reminders. `background-stop` similarly does not terminate an external process.

### Return to Priority

Production revision `bf1c8c6` has no supported Background → Priority lane command. Its **Priority** dialog changes `taskPriority` only. `background-stop` projects paused work into “Background & paused,” and remove/re-add retains activity evidence, so neither establishes the requested inactive lane. Do not advise a production reviewer to remove and recreate tasks to obtain this transition.

This branch adds `queue-return` to the existing queue API and `dcc_queue` tool. Read the current queue revision; send the normal envelope with `action:"queue-return"` and the canonical `taskId`. Exact replay uses the same sourceEventId and timestamp. The command preserves identity, backing task properties, order, Context, history, actual effort and future manual check-backs; it does not remove/re-add or recreate the task. It refuses foreground tasks, fresh running workers, pending human-review requests and already-due check-backs. It never stops a remote worker or silently resolves a review. A stopped/unknown/expired worker already displays in Priority; this explicit action records the user's placement choice. Reconciliation completion also refuses fresh running execution even if historical queue bookkeeping says queued.

Review policy: first verify current execution and foreground identity. Keep genuinely running work in Background; surface explicit human actions in Needs You; retain idle unfinished work in Priority. Then offer Done, Still working, Drop it, or Progress made → next iteration. **Still working** means the goal remains open; it is not proof that a background process is running. Meaningful progress can close an iteration with concise accomplished/remaining summaries while preserving the overall goal. Never bulk reclassify production records from this implementation task.

The tests `queue-policy.test.js` and `queue-policy-ui.test.js` cover expiry, unknown/stopped evidence, validation, safe return, duplicate requests, retained task/history/order/reminders, foreground exclusivity, explicit attention and accessible mobile/keyboard tips. Existing priority, rotation, delegation and coordinator regression tests now assert that historical work alone is inactive.

Final queue extension verification: full suite **3,351 passed / 0 failed / 4 skipped**; focused queue/browser/database tests **4 passed / 0 failed / 0 skipped**, including actual Return to Priority button submission, stale-revision rejection and active-worker completion refusal. Repository lint has 0 errors and 71 existing warnings; explicit browser-file lint has 0 errors and 3 pre-existing catch-variable warnings. Repository skill validation passed. Synthetic screenshots are retained beside the isolated checkout as `queue-policy-review.png` and `reconciliation-review.png`. Production remains unchanged.

Release preparation aligns the older delegation/readiness guides with this contract and discloses queue membership, metadata, reminders and timer controls in `dcc.work` consent. See [host execution adapter design](dcc-host-adapter-design.md) for the unimplemented runtime wiring and exact setup/authority requirements.
