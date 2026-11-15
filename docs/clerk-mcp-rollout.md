# Clerk MCP cutover and access boundaries

## What this change does

DCC's existing Clerk login remains the login provider. The new Clerk MCP adapter
uses the same application's OAuth provider for assistant consent and token renewal.
DCC still owns account mapping, workspace selection, action permissions, local
revocation, approval manifests and auditing. OAuth credentials never confer
repository, deployment, service-token administration or database-administration
access. The remote-only plugin is in `plugins/dcc/` and contains no executable hooks.

Routine writes rely on the host's action approval setting. In ChatGPT choose
**Allow read actions** to ask before changes. DCC cannot read, set, or attest that
setting. A sourceEventId is an idempotency/correlation key, not proof of human
consent. This qualifies the earlier audit's per-action authorization finding.

Bulk cleanup (including single-record requests routed through that API), import
commits and historical time corrections stage a review. Only the signed-in DCC
browser can approve the exact stored payload. The ten-minute manifest includes
current account record versions and the exact cleanup selection. Reviews are
conservative: any owned-record change makes the review stale. Cleanup batches run
inside the one browser-owned transaction; MCP cannot approve or substitute a
payload. Account record snapshots are capped at 10,000 and cleanup at 5,000.
There is no new background scheduler or worker hook.

## Changes to operator credentials

New service tokens require an owning user, owned workspace, exact allowed HTTP
method/path pairs, and a TTL of at most 30 days (default 30). The admin token API
binds them to the signed-in administrator's current workspace. A request cannot
replace that identity using x-user-id/x-workspace-id. Unbound existing tokens are
not accepted by the new verifier; inventory and replace them before deploying.
Database schema changes do not delete or automatically revoke stored tokens.

Environment PA/DCC/Sweep tokens are disabled unless
`DCC_ALLOW_LEGACY_SERVICE_TOKENS=true`. During an explicitly configured transition
they require BOTH `DCC_SERVICE_USER_ID` and `DCC_SERVICE_WORKSPACE_ID`; account 1 is
never assumed. Remove this flag after services have migrated. That flag is an
operator compatibility path, not account MCP authorization. The old stdio MCP
scheduler is operator-only and additionally requires `DCC_OPERATOR_MCP=1`; normal
assistant setup must use the remote OAuth plugin.

Token-free localhost service access requires all of: non-production NODE_ENV,
DCC_LOCAL_AUTH=1, DCC_LOCAL_DISPOSABLE_DATABASE=1, a loopback database host, and a
database name beginning dcc_test_, dcc_dev_ or dcc_review_. A loopback HTTP peer
alone never authorizes writes against a remote/production database. Owner database
access remains deliberate operator access using separately supplied credentials.

## Required Clerk setup (review before production)

Use the existing production application; do not create replacement user accounts.
Use a separate development instance for all protocol/canary tests first.

1. Configure the canonical HTTPS `/mcp/dcc` resource in Clerk. Enable audience
   claims, S256 PKCE, CIMD, visible consent, opaque OAuth tokens and refresh support.
   Keep refresh audience backfill off; missing/wrong resource must fail.
2. Add DCC custom scopes from `lib/chat-permissions.js`. Default to
   dcc.tasks.read + dcc.tasks.write. The client also requests offline_access for
   renewal; this is provider lifecycle access, not a DCC data category.
3. Explicitly admit ChatGPT's verified CIMD identity; keep admission of unknown
   clients and unused DCR disabled for this ChatGPT-first release. Never infer a
   callback/client ID from a previous draft. Clerk resolves exact callback URIs
   from the admitted metadata document. Verify the current host's actual identity.
4. Verify that token introspection returns object, client_id, subject, scopes,
   resource audience, expiration, revocation and token creation time. The adapter
   rejects non-OAuth credentials and JWTs. It calls the Clerk Backend API with the
   existing server-only Clerk secret, using the documented 2026-08-20 API version.
5. Exercise rotation/reuse, refresh concurrency, new consent, revocation of every
   observed grant family, and old credentials after reconnection. These are release
   gates; synthetic provider tests do not certify the live Clerk instance.

Opaque tokens are verified on each request. The host retains refresh tokens; DCC
never receives them. DCC encrypts observed access-token handles only to revoke the
associated provider grant later. After confirmed provider revocation it erases the
ciphertext while retaining the non-reversible token fingerprint tombstone. Token
handles and raw prompts are excluded from the action log. The revocation encryption
key is mandatory; no plaintext fallback exists.

## Configuration diff

Prepare these values in the target environment without displaying secret values:

| Variable | Value/purpose |
| --- | --- |
| DCC_CONVERSATION_AUTH_PROVIDER | `clerk` at cutover; `legacy` only during the prepared transition |
| DCC_CONVERSATION_ENABLED | `true`; existing foreground uniqueness guard stays enabled |
| DCC_CONVERSATION_REMOTE_ENABLED | `true` to serve remote OAuth/MCP |
| DCC_CONVERSATION_URL | Existing approved canonical DCC HTTPS origin |
| CLERK_MCP_ISSUER | Exact HTTPS issuer from the existing Clerk application's discovery |
| CLERK_SECRET_KEY | Existing production application's server-only secret |
| DCC_MCP_CLIENT_IDS | JSON array of explicitly admitted ChatGPT client IDs |
| DCC_MCP_TOKEN_ENCRYPTION_KEY | Dedicated 32-byte secret, hex/base64; retain for pending revocation |
| DCC_CHATGPT_INSTALL_URL | Actual HTTPS `chatgpt.com/plugins/...` installation link after private registration/review |
| DCC_ALLOW_LEGACY_SERVICE_TOKENS | Omit/false after service migration; true only for the reviewed transition |

The default provider remains `legacy` until this explicit cutover, preserving a
controlled migration rather than changing issuers on an unconfigured deployment.
With Clerk selected, DCC's legacy authorize/token endpoints return 410 and cannot
issue or refresh old grants. No existing grant is translated into broader access.
Stored historical grants and events remain intact.

Migrate `012_mcp_access_boundary.sql` (additive tables/columns only). Schema bootstrap
also creates the same structures for fresh/test databases. Review database risk
and the repository's existing CI acknowledgment requirement. No backup is claimed.

## Connection lifecycle

- First OAuth access maps Clerk subject to exactly one existing users.external_id.
  MCP never links by email or creates users. New users sign into DCC first.
- A sole owned workspace binds automatically. Multiple owned workspaces require
  browser selection in Connections. Membership is checked for every operation.
- Permission reduction is a local cap checked on subsequent requests and mutation
  transactions. For expansion, the browser records the selected pending scopes;
  they activate only on a newer provider token containing those scopes. The host
  must complete its authorization flow. Existing token scopes never expand alone.
- Disconnect writes the local tombstone before attempting provider revocation.
  A provider outage leaves DCC blocked with revocation_pending=true. Retry from
  Connections. Browser reconnect is refused until provider revocation succeeds.
- Reconnect requires explicit browser action and a token newer than that action;
  all observed old grant families have already been revoked. Verify this behavior
  against Clerk before enabling production. Old fingerprint tombstones remain.
- One logical connection exists per issuer + subject + OAuth client in this
  release. Refresh and reconnect keep the profile ID stable for the same workspace.
  Rebinding to another owned workspace requires confirmed disconnect first.
- Provider failures are retryable 503 responses. There is no PA token, session,
  account-1, or anonymous fallback. Disabling remote ingress is not a claim that
  provider grants were revoked; disconnect while management is available first.

## Interfaces

Existing `/mcp/dcc` and account-management paths remain. Protected resource metadata
names Clerk as issuer. DCC's authorization metadata endpoint mirrors validated
Clerk metadata for compatibility. `scripts/check-conversation-readiness.js` accepts
CLERK_MCP_ISSUER to validate that external issuer explicitly.

New tools: dcc_profile (standard opaque profile identity), dcc_approval_status,
and operation-specific aliases such as dcc_tasks_list/dcc_tasks_create. Mixed
legacy tool names remain guarded compatibility wrappers. Reads and writes have
separate annotations; mutation aliases need write scope at discovery/execution.
Insufficient-scope responses include host authorization challenges.

New browser interfaces: GET /api/me/chat-workspaces;
POST /connections/conversation/workspace, /bind, /upgrade, /reconnect;
GET/POST /connections/conversation/approvals/:id;
GET /api/me/chat-actions. All mutations require the signed-in account, current
workspace ownership, same-origin request and CSRF protection. No MCP tool can
approve reviews, change security settings or administer credentials.

Connection UI distinguishes stored/verified access, pending additional access,
reconnect required, disconnected and provider unavailability. It recognizes
existing grants, refreshes on return and polls for at most one minute only while
the setup panel is open. Missing install URLs are shown honestly as setup pending;
there is no invented installation link or callback.

## Deployment sequence and rollback

1. Review the code, additive migration, service-token inventory and configuration
   diff. Replace service credentials and update their callers before enabling the
   stricter server; use the explicit compatibility flag only if needed.
2. Run Node 22 unit/HTTP tests and responsive browser checks on disposable data.
3. Configure the development Clerk instance; register the private ChatGPT plugin
   and run the real two-account, consent, refresh, approval and disconnect canaries.
4. Apply reviewed production configuration and migration; reconnect existing MCP
   accounts once. Verify deployed SHA and read-only protocol readiness. Perform
   writes only on explicitly selected synthetic canary records.
5. Publish the verified private installation link in DCC; public directory
   submission is separate. Monitor authorization failures, revocation_pending,
   renewal failures and connection-state mismatches. Never log bearer credentials.
6. Roll back by disabling remote ingress, preserving all tombstones, audit and
   approval data. Do not restore old issuers/tokens or broaden service access as
   an automatic rollback. Browser/admin app operation remains separate.

No production credentials/configuration, Clerk application settings, live account
records or directory registration were changed by the local implementation work.
