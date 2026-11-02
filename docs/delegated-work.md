# Delegated work reporting

An explicit request to an assistant to carry out work is a delegated-work handoff: coding, an email draft, research, or a small job. A question, status check, hypothetical discussion, or retrieval of an existing artifact is not a new handoff. Resume the existing identity instead of making a new task.

## What is automatic

Once an authorized host calls `dcc_delegate`, the server atomically links/creates the canonical task, adds queue membership when appropriate, stores its current activity report, and projects human review needs into Working Queue. Background placement requires a fresh, bounded host observation of execution. Phase `working` alone, an open chat, historical effort or a prior start is insufficient; inactive or unverified work appears in Priority. Replays and resumes reuse that binding. The UI and MCP read the same coordinator state.

No system-wide worktree watcher or assistant hook is installed. No arbitrary Claude/GPT chat status is detected. Until a supported hook is approved and connected, the parent assistant calls this tool after an explicit handoff and at meaningful milestones or newly observed execution-state changes. This standing workflow belongs in the parent's normal workflow instructions, not an authentication bypass or an assertion that a hook already exists.

## Identity and linking

`work.source` and `work.id` are immutable logical-work identifiers within the authenticated account/workspace. Use a stable request/task/draft identity, not the title, token stream, current time or a new ID on each retry. A revised draft retains its original work ID. Worktree resumes retain the original worktree ID even if its filesystem location changes.

For coding, `codingIdentity({source,repository,worktreeId,codingTaskId})` in `lib/delegated-work-adapter.js` derives a stable ID. Use the host's managed worktree ID and thread/task ID; no filesystem watching or global discovery is performed. For email drafts/research, use an existing source draft/request identity.

Read `dcc_search_tasks` and select the existing canonical `taskId` when one represents the request. The server always checks its existing identity binding before creation. `createIfMissing:true` plus a title explicitly permits a new unscheduled private task if none exists; an exact matching title asks the caller to select a canonical task instead of guessing or duplicating it. `parentTaskId` is optional only for new explicitly nested work. Existing tasks are never silently reparented. Deleted bindings require restoration; completed tasks require explicit reopening before new work. Multiple work identities can attach to one umbrella task (maximum20) without creating duplicate children.

## Parent call sequence

1. After the explicit handoff, read `dcc_working_queue` for its revision and search/link the canonical task.
2. Call `dcc_delegate` with the envelope below. Save the exact command before dispatch; an uncertain transport outcome retries that same envelope, including event ID, timestamp and revision.
3. Report meaningful progress (a milestone, blocker, review-ready deliverable or confirmed request completion) or a newly observed execution state. Increase `sequence` per work identity; use a stable unique source event ID per report. Sequence/timestamp conflicts require reconciliation, never blind overwrite.
4. When the deliverable still needs review, sending, approval or deployment, report `needs-review` or `blocked` and list the remaining human actions. Needs You is attention state, not permission to perform those actions.
5. After the user confirms the selected scope is complete, use the separately authorized completion/reconciliation tool. Meaningful progress can close an iteration and link a successor without claiming the overall goal is complete; see [completion and iteration reconciliation](dcc-integration-runbook.md). Guided activities retain their dedicated outcome flows. Only after the bound canonical task is verified complete may `delegated-update` report `completed`. Reporting `completed` alone cannot check off an open task or send an email.

Example registration, after selecting the real canonical task:

```json
{
  "action": "delegated-register",
  "sourceEventId": "stable-request-event-id",
  "expectedRevision": 12,
  "at": "2026-10-27T18:00:00Z",
  "taskId": "selected-canonical-task-id",
  "delegation": {
    "work": {"source":"codex","id":"stable-draft-request-id","kind":"email-draft"},
    "sequence": 1,
    "phase": "working",
    "note": "Drafting the requested reply using the confirmed figures.",
    "reviewActions": [],
    "intent": "explicit-work-handoff"
  }
}
```

This example intentionally omits execution evidence and therefore appears in Priority, not Background. To assert current execution, provide an explicit `execution` observation following the [maintained evidence contract](dcc-integration-runbook.md#worker-evidence-contract); do not manufacture a running state from phase `working`.

A later update uses `action:delegated-update`, the same `work`, increasing sequence, a new stable event ID/current revision, and for example `phase:needs-review`, `note:Draft revised; ready for your review`, `reviewActions:[Review the wording, Send when approved]`. Omit registration-only intent/title/create/parent fields. Notes are capped at1000 characters, with up to5 review actions of240 characters. Source `at` and server `receivedAt` are separate.

The transport-neutral `createReporter({callTool,journal,connectionId})` adapter calls the same two MCP tools. `callTool` must use an already approved account/workspace connection. Its durable journal implements async `load(key)`, `save(key,value)`, and `clear(key)`, stores only the pending event, and is exclusive to that immutable connection. Provide one writer per journal/work identity; this adapter serializes its own calls but does not coordinate separate processes. Preserve its journal on agent restart. A new milestone cannot replace a pending unknown outcome. Account/permission/revision failures require reconciliation of the retained event; no silent permission or revision retry occurs.

## Canonical model and safeguards

The private `delegated_work` table binds `(user_id,workspace_id,work_key)` to a task and its current report. It is server-only with RLS and no public grants. Reports do not enter public/shareable task properties and generic task edits cannot erase them. The existing coordinator supplies owner checks, account serialization, revision/event idempotency and atomic rollback. No parallel foreground state or new task type is introduced.

A new registration adds membership when it creates a new binding outside the queue. Lane placement is a read-only projection: fresh running execution goes to Background; stopped, expired or unknown execution goes to Priority; explicit review/unblock actions go to Needs You. The observation expires after its explicit validity window (at most 15 minutes), without modifying task history or stopping the worker. Later reports preserve human pause/focus and removal. `working`, `paused`, `blocked`, `needs-review`, and `completed` describe delegated progress independently of the human task clock. An actively focused task retains its Foreground position while displaying its review actions; background work awaiting action appears in Needs You. Registration and updates never start/pause a human timer, add effort, alter actuals, or infer that work continued while offline.

Review flags are independent of manual timed check-backs. Timer pet claims require an actual deadline/generation and cannot consume a lifecycle review flag. Lifecycle reports currently update the view; they do not promise a pet animation or closed-browser notification.

## Activation and release

`dcc_delegate` requires the existing `dcc.delegate` OAuth scope. Existing read/work grants gain no creation privilege. New client setup, grants or hook installation still require action-time approval. No credentials are created by this implementation. Session-authenticated `/api/working-queue` accepts the same two actions through the same coordinator.

The existing private report table is reused by the completion/queue-policy extension; that extension adds no tables. Existing queue/task data is untouched until an authorized lifecycle call. The foreground-index audit, OAuth setup and exact-SHA deployment gates remain in force. Backups are optional under the [DCC release policy](releases/database-backup-policy.md). The current PR does not establish a live GPT connection.

Working Queue is the normal app-entry default. Explicit `?tab=` links, tab navigation history and browser back/forward take precedence. Navigation selects a view only and never creates a task or starts a clock. Existing compact glasses task URLs and onboarding navigation remain separate.

## Host adapter setup remains separate

The transport helper is implemented; actual host observation and lifecycle hooks are not. The [host-adapter design and authority checklist](dcc-host-adapter-design.md) describes the supported boundary, required setup, failure handling and remaining acceptance checks. It does not install a hook or grant access.
