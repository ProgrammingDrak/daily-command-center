# Account-scoped conversational integration — local candidate

This candidate adds a remote MCP endpoint with per-account OAuth consent. It does **not** install a tool in an existing ChatGPT/dot conversation. It is disabled by default, has not been deployed, and has not created real OAuth credentials or grants.

## Architecture and behavior

- `routes/conversation.js`: stateless Streamable HTTP JSON-RPC at `/mcp/dcc`, OAuth discovery/authorization/token endpoints, account consent, connection management, and revocation. Mounted before DCC's legacy service-token gate; a shared admin token is never accepted here.
- `conversation-oauth.js`: pre-registered public OAuth clients, exact HTTPS redirect allowlist, authorization code + S256 PKCE, resource-bound access tokens, rotating refresh tokens with family revocation on reuse, one-hour access expiry and 30-day refresh expiry. Only token/code hashes are stored. DCC's existing login/session establishes the account. There is no new sign-in provider or caller-selected user header.
- `conversation-store.js`: owner/workspace-fenced lookup, account-wide advisory lock, source-event idempotency, optimistic activity revision, canonical completion and existing time-entry writes in one transaction. Committed results include the re-read state. Follow with `dcc_task`/`dcc_current_activity` to confirm the latest state across concurrent clients.
- Existing `startWork`, `pauseWork`, and `continueWork` callers join the coordinator when enabled, including browser and Slack/guided callers. A partial unique index enforces at most one active task per user even for writers outside that coordinator. Generic stale property updates cannot recreate timers or restore corrected metrics. Both the initiating browser cache and SSE recipients receive affected task IDs/rows.
- `at` is the explicit event instant supplied by the client, including seconds and timezone offset. `conversation_events.created_at` is receipt/commit-time provenance. Processing at 11:42 does not silently substitute for an explicit 11:39:44 start. A late event older than the current activity state is rejected and needs a correction; it cannot overwrite newer activity.
- Start pauses the former foreground task and starts the selected canonical task atomically. Task mentions/questions perform reads only. Starting a completed task is refused. No tools create tasks on a search miss. Search includes completed tasks and recurring definitions/instances and supports pagination.
- Background-start pauses that task's foreground effort and records processing separately. Background elapsed time earns no focused minutes. It can coexist with another foreground task.
- Done calls the canonical completion transaction and does not infer actuals from a planned duration. Untimed completion retains an explicit unknown-actual marker. Existing recurrence reconciliation still derives series state from completed instances.
- Silence after the existing 50-minute check-in allowance (or eight-hour session ceiling) is returned as an unknown interval in the audit event, not added to the task metric. It is not silently credited as focus. This is conservative timing, not passive activity detection.
- Correction partitions an existing closed time entry exactly into focused-task, existing-calendar-occurrence, and unknown intervals. It preserves total seconds for reallocation; an explicit `correctedWindow` can change mistaken start/end times while retaining the original interval in history. Known allocations that overlap other recorded or active activity are refused. It requires a reason, tombstones the source through the canonical block store, keeps its full prior record in the audit, and reprojects affected task metrics. ISO instants are split into local-day rows using the established timing helper. Planning fields are untouched.
- Day Review matches corrected meetings by event identity, not by a similar title; unknown time is displayed separately and excluded from known actual totals. Corrected-away work cannot reappear through legacy session fallback.

Tools: `dcc_search_tasks`, `dcc_calendar_events`, `dcc_current_activity`, `dcc_task`, `dcc_activity_history`, `dcc_work`, `dcc_complete_task`, `dcc_correct_time`.

Scopes: `dcc.read`, `dcc.work`, `dcc.correct`, `dcc.complete`. Consent spells out each requested permission. Tokens bind user, owned workspace, client, resource and scopes. Every call checks expiry, revocation and current ownership. New tables have RLS enabled and no browser/Supabase public data policies.

## Synthetic acceptance evidence

The test fixture uses synthetic task/session/event IDs and October 20, not the live October 27 QuickBuy record.

1. Start 09:53 EDT; pause 10:43 EDT: 3,000 seconds, 50 minutes.
2. Correct to 09:53–10:00 unknown, 10:00–10:30 existing Mike meeting identity, 10:30–10:43 unknown.
3. Result: 420 + 1,800 + 780 seconds, original entry retained in audit, no duplicate meeting task, original QuickBuy metric cleared, and Day Review counts 30 known minutes rather than 50.

Tests cover real PostgreSQL concurrent writers (one revision winner), rollback after a deliberately interrupted switch, transport replay, changed-payload replay refusal, foreign task/meeting isolation, DST and midnight intervals, long silence, the database uniqueness constraint, PKCE/code reuse, token expiry, refresh replay, insufficient scopes, HTTP consent CSRF, bearer identity versus forged headers, read-after-write, and disconnect.

## Release gates — not executed by this engineering task

1. Complete normal repository review, security review of the OAuth server, DB-risk checks and a verified production backup. Do not bypass release gates or auto-merge.
2. Deploy additive tables with the feature disabled. Inspect the production duplicate-foreground audit in `migrations/010_conversation_foreground.sql`. Resolve historical conflicts with their owner; do not choose a timer arbitrarily or infer elapsed effort. This task does not authorize changing the live QuickBuy fixture.
3. With explicit migration approval, dry-run and then apply **only** `010_conversation_foreground.sql`. It is marked `@gated`, so the ordinary migration runner skips it. The remote routes return 503 until the unique index exists. Audit and review come before read/behavior activation.
4. Official authentication docs support predefined OAuth clients and advertise public `none` token authentication. The implementation matches that documented protocol option. Verify the actual ChatGPT account/workspace exposes this builder option and supports a custom remote MCP plugin; documentation support is not an account-specific connection test. This MVP does not implement dynamic client registration or Client ID Metadata Documents. If the chosen installation flow requires those, implement and review that adapter before claiming it connects.
5. With action-time approval, register/configure the real OAuth client ID and exact callback URI(s). Configure `DCC_CONVERSATION_URL` as the canonical HTTPS origin and `DCC_CONVERSATION_CLIENTS` as a JSON object mapping approved IDs to `{ "name": "ChatGPT", "redirect_uris": ["<provider-confirmed HTTPS callback>"] }`. Copy the exact callback shown by the MCP management page: this server does not advertise issuer-response identification, so do not assume the stable callback; new ChatGPT connections may use `https://chatgpt.com/connector/oauth/{callback_id}`. These are public-client metadata, not an admin secret. Never copy the legacy PA token into ChatGPT.
6. Enable `DCC_CONVERSATION_ENABLED=true` only alongside the coordinator code and verified unique index. `DCC_CONVERSATION_REMOTE_ENABLED=false` is an emergency remote-off switch that leaves timing guards/coordinator active. Do not drop the index or disable the coordinator while old and new clients are writing.
7. In eligible ChatGPT accounts: Plugins → Add custom MCP server → the deployed `/mcp/dcc` URL with OAuth → create/install/enable the plugin → sign into DCC → review scopes → allow. Actual access grants require action-time user approval. A new DCC signup follows the same flow; signup alone does not install the ChatGPT plugin.
8. Verify in **this** chat that tools are exposed, read only the connected account, execute a user-approved synthetic task transition and read it back, then revoke and prove access fails. Until that canary succeeds, report “implemented, not connected.”

A GitHub-imported desktop plugin with only `mcp.json` is not the cloud-dot connection step. Wider distribution to arbitrary users may require workspace approval or public plugin submission.

Official platform references checked October 27, 2026:
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://developers.openai.com/plugins/deploy/submission
- https://learn.chatgpt.com/docs/dots/computers-and-apps

## MVP boundaries and follow-up

- Existing task operations only: no automatic task creation, reopening, recurrence materialization, or general-purpose account write tool. A recurring definition must resolve to its existing occurrence before starting. Guided outcomes still use their existing explicit completion flow.
- Calendar reads use the account's existing DCC snapshot and materialized meeting identities; they do not refresh Google Calendar. Missing/ambiguous meeting identities fail closed.
- Tokens are for workspace owners in this MVP; delegated/editor permissions are not inferred.
- One foreground task spans the account. A token scoped to one workspace refuses to mutate an active task in another workspace; pause that task through its own authorized connection first.
- The source-event ID should be namespaced with client/conversation/message identity. Exact retries use the same envelope. A revision conflict requires rereading state and resolving the user's intent, never blindly incrementing the expected revision.
- The audit is append-only through the application. Bounded per-process budgets now limit public ingress before session/body/database work (1,200 total and 180 per trusted-proxy IP per minute), plus 120 authenticated requests per account per minute. Configure shared ingress limits across replicas and verify the existing trusted-proxy topology before broad release. Production retention and public client registration/distribution also remain operations gates.
- Roll back remote access by disabling only the remote surface or revoking grants. Preserve time-entry/audit history and the foreground guard until a reviewed rollback plan handles mixed clients and corrected metrics.

Local verification uses the existing `test-support/activity-db` harness. `DCC_TEST_DATABASE_URL` must point to localhost; the harness creates and removes an isolated schema. `DCC_PGLITE_MODULE` can instead point to an installed PGlite package. No production environment files were copied into this checkout.

## Local verification result

- Full local suite: 3,154 passed, zero failures; 14 database/environment-dependent tests skipped in that run.
- Final relevant suite with a disposable real PostgreSQL cluster and loopback HTTP: 266 passed, zero failures, zero skipped.
- Critical-guard mutation checks: removing the activity revision check, the OAuth scope check, or unknown-time exclusion caused the corresponding tests to fail. Source restored after each check.
- ESLint: zero errors; 18 pre-existing warnings in the large existing route/server files. New modules/tests lint cleanly.
- Browser QA: fresh synthetic account, consent scopes/account identity, Cancel with no connection, Allow, connection review, Disconnect, and an isolated second synthetic account were exercised in Chrome. The harness used an in-memory database and fake callback with no token exchange. No real consent was granted. Production Clerk signup/login and actual ChatGPT connection remain canary steps.

Validation artifacts are in the task workspace's `conversation-evidence/` directory, outside the repository. An independent five-lane code review and separate verification pass have been completed; see `docs/conversational-integration-review.md`. No production or actual ChatGPT connection canary has been performed. This is not a third-party penetration-test certification.
