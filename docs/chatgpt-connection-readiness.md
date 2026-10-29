# ChatGPT connection readiness

Code deployment, public protocol ingress, account consent, and host lifecycle reporting are separate steps. A healthy DCC page alone proves none of the latter three. New DCC signup does not automatically install a ChatGPT plugin.

## What exists

The account-scoped OAuth/MCP implementation and Working Queue coordinator are deployed in the app. `dcc_delegate` can link or explicitly create a canonical task and report meaningful progress once an authorized host calls it. The transport-neutral adapter in `lib/delegated-work-adapter.js` preserves exact pending events in a connection-scoped durable journal. It does not install an assistant hook, watch worktrees, or acquire credentials. See [delegated work reporting](delegated-work.md).

Remote access can remain disabled independently of the local queue coordinator. Disabled machine endpoints return HTTP 503 with `conversation_remote_disabled`; they must not masquerade as a login HTML page. While the entire remote surface is off, its connection-management page is unavailable too. Turning the surface off is not the same as revoking stored grants.

## Read-only ingress check

Run `node scripts/check-conversation-readiness.js https://your-dcc-origin.example` against the approved canonical origin. It sends no credentials, refuses redirects, checks health, resource/authorization metadata and the unauthenticated MCP challenge, and exits nonzero when setup is required. `ingress_ready` only means those protocol checks passed. Account connection and lifecycle-hook fields deliberately remain `not_verified`.

## Operator setup, requiring specific approval

1. Verify the current foreground uniqueness guard and coordinator release checks described in [the integration guide](conversational-integration.md). Do not modify historical task data to enable access. Backups are optional under the DCC release policy; other release gates remain.
2. Obtain approval for remote ingress configuration. Set the canonical HTTPS origin and enable the remote surface only after its migration/readiness checks pass. Do not copy a legacy PA/admin token into ChatGPT. An empty client allowlist can expose discovery without authorizing a client; it does not establish a connection.
3. In the eligible ChatGPT account/workspace, use Plugins → Add custom MCP server, the canonical `/mcp/dcc` URL, and OAuth. Verify that the UI supports a predefined public OAuth client (`none` token authentication). This implementation has no dynamic registration or Client ID Metadata Document support. If this account's flow requires either, stop pairing and implement/review that support first.
4. Before saving real server/client configuration, obtain approval for the exact public client identifier and provider-displayed HTTPS callback. Register only that exact callback; do not guess it or allow a wildcard. Configure the same public client identifier in ChatGPT. No shared client secret is needed by this public-client implementation.

## Per-account connection

Install and enable the resulting plugin. Start Connect, sign into the intended DCC account, and check the account/workspace and every requested permission on the consent page. The MVP supports workspace owners. Every new account follows this same consent flow; it does not reuse another account's grant. Account eligibility and workspace administrator approval may constrain installation.

Begin with read access. Background handoff reporting requires `dcc.delegate` as well as `dcc.read` for lookup and confirmation. Ask for only those scopes if the selected ChatGPT flow permits it; stop for review if the actual consent asks for additional permissions. Focus switching (`dcc.work`), corrections (`dcc.correct`), and completion (`dcc.complete`) are separately approved capabilities. Existing grants do not silently gain new scopes.

Approve the displayed account consent only after reviewing it. Confirm the tools actually appear in the intended chat. Merely creating the plugin or receiving a successful OAuth redirect is insufficient evidence.

## Safe real canary, separately approved

1. Read current activity and Working Queue, then find/read the existing canonical task chosen for the canary. Record its ID, current revision, and the existing foreground. No writes yet.
2. With explicit canary approval, register one stable delegated work identity against that existing task. Omit `createIfMissing`, title and parent changes. Use a source-event ID stable for this instruction, the read revision and an explicit timezone-bearing event instant. Preserve the exact envelope before dispatch.
3. Read back the task/queue. Verify exactly one binding and appropriate background/review state, with no changed foreground timer, plan, actuals or unrelated tasks. Retry the exact saved envelope to verify replay without duplicate task or activity creation. Never substitute a new event ID after an uncertain outcome.
4. Report `needs-review` using an increased sequence and a new event ID when the deliverable needs human action. Read back again. Do not report completed or call task completion merely because implementation work paused.
5. Test cross-account isolation only with a separately approved disposable account/fixture. Test focus switching, corrections and completion only on an explicitly approved synthetic fixture with no real foreground, not on the user's current task or historical records.
6. Disconnect through DCC's Conversational connections page while remote routes are available, verify the grant is shown disconnected, and verify the former connection cannot read. Do not retain or log raw tokens. Reconnect only with fresh consent.

Until an approved host hook exists, the parent assistant must explicitly call `dcc_delegate` after authorized handoffs and meaningful milestones. Questions, mentions, retrieval, and hypothetical work do not register tasks. A host hook would need its own connection-bound journal, stable work identity, and restart/retry handling; this runbook does not claim one is installed.

## Platform references

Official documentation checked October 29, 2026: [OAuth authentication](https://developers.openai.com/plugins/build/auth), [custom MCP servers](https://developers.openai.com/api/docs/guides/custom-mcp-server). Documentation support for predefined clients does not prove availability in a particular account. A desktop-only GitHub-imported MCP manifest is not sufficient to connect a cloud dot.
