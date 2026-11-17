# DCC access boundary audit — November 15, 2026

Reviewed repository: ProgrammingDrak/daily-command-center, commit `c254bd3b8041271d737b9c08dbf6a6dae30e06ad`.

## Requested boundary

The owner retains separately authorized repository and database administration. A normal assistant uses only its DCC account OAuth connection, can affect only that account, and can perform only user-authorized changes. Development work must not implicitly register activity, start workers, or acquire production administration rights.

## Findings

### High: ordinary MCP writes have no independent proof of user authorization

`routes/conversation.js:482–641` verifies OAuth identity and tool scopes, then dispatches writes. `chat-control-store.js:139–160,192–195` requires a caller-supplied sourceEventId and write scope, but no user-approved action bound to the exact request. `conversation-store.js:463–480` similarly validates and records the caller's command. Tool descriptions instruct the model to act only on explicit user instructions; those instructions are not an independent server-side consent check.

Consequently, granting write access authorizes the credential holder to issue subsequent writes within those scopes. Idempotency, revisions and audit records protect consistency and support investigation; they do not establish that the human authorized a specific change. Bulk cleanup's prepare/commit sequence also remains callable by the same assistant.

Recommended enforcement: stage proposed mutations without modifying task data; require an authenticated user approval or a trustworthy host approval attestation bound to account, grant, canonical operation payload/hash, expiration and single-use nonce. Execute only that approved payload transactionally, with revocation and current scope/version checks. Explicit user instructions may be captured by a trusted host approval mechanism without requiring a redundant confirmation, but assistant-supplied text/IDs alone are insufficient proof. No such trusted approval mechanism was verified here.

### High: legacy service credentials bypass per-account OAuth consent

`server.js:176–192,226–255` accepts static environment or database-backed service tokens on legacy routes. `token-store.js` stores service scopes (`dcc`, `sweep`, `all`) without a user/workspace/grant binding. `attachSweepServiceAuth` derives its target from x-user-id/x-workspace-id, with defaults to account 1. `middleware/resolve-owner.js:26–64` also supports header/environment identity selection. This is an intentional privileged service surface, not proof of an unauthenticated exploit, and it is separate from remote OAuth MCP.

However, `mcp/dcc-mcp/server.js:19,99–106` is itself a legacy MCP assistant using DCC_PA_TOKEN/SECRET_PA_TOKEN to write through quick-task. Therefore the repository currently contains an MCP setup that does not provide the account OAuth boundary the owner wants. Disconnecting a conversation grant cannot revoke this independent service credential.

Recommended enforcement: designate this server as operator-only and remove it from ordinary assistant setup. Bind non-admin service tokens to explicit service identities and allowed accounts/workspaces/actions. Reject caller-selected identity headers for those credentials. Retain owner/admin tooling as a separately authenticated capability; do not remove owner access. Inventory deployed integrations before rotating or disabling existing credentials.

### Medium: localhost trust depends on NODE_ENV, not database/environment identity

`server.js:175,229–247` permits several service actions from localhost whenever NODE_ENV is not production. The database pool independently uses DATABASE_URL (`pg-pool.js:46–54`). A development process pointed at a production database can therefore combine local trust with live production writes. Repository instructions explicitly describe local and production as live environments.

Recommended enforcement: require an explicit development mode plus a verified disposable/local database for token-free operations. Fail closed when a development process targets production. Owner production database access should use deliberate, separately provided operator credentials.

### Medium: the connection wizard can conceal existing working authorization

`public/js/chat-integrations.js:138–145` snapshots existing grant IDs and only treats a different/new grant with the selected scopes as a successful check. A valid existing connector can continue working while this wizard says no new authorization has occurred. The wizard does not automatically refresh when returning from ChatGPT. This is a concrete code explanation consistent with the screenshot; it does not establish which build or grant the screenshot used.

Additionally, the hub labels any non-revoked grant Connected, regardless of remote readiness or token validity (`public/js/chat-integrations.js:31,44–49`). These are different concepts: stored grant, remote enabled, successful recent use, and the permissions requested for a new connection.

Recommended behavior: show existing authorization and its permissions during setup, distinguish it from pending additional access, refresh on return, and make Check connection report existing verified access separately from new authorization. Never label new permissions authorized because an older grant works.

## Protections verified in the reviewed source

- Remote `/mcp/dcc` is mounted before the legacy service gate and verifies only opaque OAuth access tokens. There is no observed fallback from that endpoint to a PA token or browser session.
- OAuth identity comes from the stored grant and current owner membership, not MCP request account fields. Reviewed conversation queries bind both user and workspace. Category tools also permit user_id NULL rows within the authorized workspace; that shared-record policy should be made explicit if strict user-only ownership is required.
- Exact registered HTTPS callbacks, S256 PKCE, hashed tokens, one-time codes, refresh rotation/reuse detection, resource binding and grant revocation are implemented.
- Tool listing and execution check scopes; existing grants do not silently gain scopes. Permission reductions take effect through current grant reads.
- Delegated reporting and queue bookkeeping examined here do not themselves launch external workers. This is not an inventory of every scheduler or separately hosted automation.

## Validation and limits

The connected GitHub API reported owner admin/pull/push permissions. Source was cloned locally. No production credential was retrieved and no production database or application write was performed. Live database ownership/role permissions, deployed SHA, active service credentials, OAuth grants and external automations remain unverified.

Ran conversation.test.js, conversation-http.test.js, chat-integrations.test.js and chat-integrations-http.test.js against isolated in-memory PostgreSQL (PGlite): **17 tests passed, zero failed, zero skipped**. Tests cover consent, scopes, OAuth isolation, revocation, refresh reuse, persistence, rollback and permissioned edits. Initial sandboxed HTTP tests failed; rerun with local sockets enabled passed. Runtime was Node 24.22.1, outside the repository's declared Node >=20 <23; repeat release checks on supported Node before shipping.

This is a focused source audit, not a certification of every API/store or of deployed database policies. No access-control fix, deployment, credential rotation or production configuration change is included. Next implementation should start with disposable two-account HTTP tests for denied cross-account reads/writes, denied writes without action authorization, exact approval replay/payload mismatch, service-token identity binding, and accurate existing-versus-pending connection UI.
