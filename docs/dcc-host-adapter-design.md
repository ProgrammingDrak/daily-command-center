# DCC host execution adapter: design and setup boundary

**Status: design only for host wiring. No automatic execution observer, lifecycle hook, process watcher, polling service or persistent installation is implemented.** The server contract and transport-neutral reporting helper are implemented and tested. The [integration runbook](dcc-integration-runbook.md#worker-evidence-contract) is authoritative for execution evidence and lane policy; this document specifies how a future host adapter would connect to it.

## Supported seam

`lib/delegated-work-adapter.js` exports `createReporter({callTool,journal,connectionId})` and `codingIdentity({source,repository,worktreeId,codingTaskId})`. The host supplies:

- An **already authorized** `callTool(name,args)` transport to `dcc_working_queue` and `dcc_delegate`. It must preserve structured MCP errors, not turn them into successful acknowledgements.
- An immutable, non-secret `connectionId` identifying the intended server, client/grant, DCC account and workspace. A different grant/account gets a separate journal namespace. Do not use a raw token as this ID.
- An exclusive durable journal implementing asynchronous `load(key)`, `save(key,value)`, `clear(key)`. Save completes durably before dispatch. Keep only the pending command and its fingerprint; apply local file/store permissions appropriate for private task summaries. The helper serializes one reporter instance, not multiple processes: the host must enforce one writer per connection/work identity.
- Stable work identifiers and a durable monotonic sequence counter per work identity. Preserve repository/worktree/task identity across restart; a title, path alone, new timestamp or new UUID per retry is not the identity.
- A supported host signal that can distinguish actual executing work from a chat that merely exists. The helper does not implement this observation or validate an operating-system process itself.

Do not infer a specific vendor hook API, install a global watcher, scrape conversations, inspect unrelated processes or copy a browser cookie. Select and verify a documented host capability before implementation. No particular Claude/Codex host API or installation route has yet been validated for this deployment.

## Observation and reporting lifecycle

1. On an explicitly authorized work handoff, resolve the existing canonical task and occurrence. Bind the stable work identity; use creation only when explicitly requested. A status question or artifact lookup is not a new handoff.
2. Obtain an actual host observation. For verified execution, supply `phase:working` and `execution:{state:running,observedAt,validUntil}` with an explicit interval no longer than 15 minutes. The observation cannot be after the report timestamp. If the host cannot support that assertion, use `unknown` or omit execution; do not invent a validity window to keep the card in Background.
3. On a real stop/pause, report `stopped` with `observedAt`, no `validUntil`, and an appropriate phase. On loss of observability, report `unknown` when possible. If disconnected, let the last observation expire; expiration does not claim the process stopped.
4. For requested human action, use `needs-review` or `blocked` with a concise nonempty `reviewActions` list. Waiting for review is not continued execution and does not authorize sending, deploying or approving anything. A completed iteration may have remaining goal scope; canonical completion uses the separate reconciliation flow.
5. Each meaningful milestone or newly observed execution-state update gets a higher sequence and a stable new source-event ID. Preserve the exact event, report timestamp, revision and payload on transport retry. Never renew an observation using a timer alone or repeatedly resend an old observation with a new validity window.
6. Call the helper; it reads the account revision, validates the command, durably saves the pending event and dispatches. It clears the event only after a successful acknowledgement. A caller needing placement confirmation then rereads the queue/task and checks identity and state.
7. On restart or lost response, load and resolve the pending exact event before sending a new report. Stop on revoked access, wrong account or permission/revision conflicts; do not silently raise revision, replace the pending message or create another task. Read current state to distinguish already-saved outcomes from conflicts.

This is an event-driven design. Any future polling or resident service, including its frequency and startup behavior, needs separate explicit approval; none is proposed as an installed default. Without new host observations the conservative fallback is Priority, even if the job may still exist.

## Exact setup and authority to establish before implementation/installation

| Item | Required decision or authority |
| --- | --- |
| Host and observation source | Name the particular application/runtime, documented API/hook, selected jobs it may inspect, and supported running/stopped/unknown semantics. No general filesystem/chat/process discovery. |
| Installation | Approve the hook location and lifecycle; if resident, approve startup persistence and removal path. No installation follows from DCC OAuth consent alone. |
| Transport | Deploy the reviewed DCC build; separately approve remote ingress and exact public-client/callback registration. Verify predefined public OAuth/PKCE compatibility before pairing. |
| Consent | Intended DCC owner/workspace; `dcc.read` + `dcc.delegate` for this reporting adapter. Queue/timer controls (`dcc.work`), reconciliation (`dcc.reconcile`) and time correction (`dcc.correct`) are separate and are not needed merely to observe/report work. |
| Data | Approve sending stable selected work identity, concise task/progress summary, phase, observation timestamps and review actions to DCC. Avoid raw transcripts, environment contents, filesystem listings and tokens. Read consent exposes the broader DCC task/context/history contract, not just this job. |
| Durable storage | Approve the exact private journal location/store, one-writer enforcement, retention, connection namespace and cleanup after disconnect. Do not log tokens; do not erase an uncertain pending event before reconciliation. |
| Test/canary | Use isolated fixtures first. A production canary needs a separately selected task and explicit mutation authorization; preserve foreground, effort and unrelated tasks. |
| Shutdown | Disable/remove the hook, report stopped only if actually observed, revoke the intended grant when requested and verify it cannot read. Disabling ingress alone is not revocation. |

## Acceptance required for the future adapter

The existing helper tests cover exact retry, interruption, errors and stable work identity; queue-policy tests cover evidence validation, expiration and placement. The future real-host adapter must additionally demonstrate actual start/stop/unknown observation, no false liveness from an idle chat, monotonic events after restart, isolation between accounts/grants, no token logging, exclusive journal ownership, lost-response recovery, revocation handling, and clean removal. Exercise stale reports, concurrent human edits and host disappearance. Verify no added timers, effort, schedule or duplicate task and no unapproved outbound action.

Until this host-specific work is implemented, tested and approved for installation, manual authorized reports and conservative queue classification are the supported behavior. This document does not claim automatic reporting is delivered.
