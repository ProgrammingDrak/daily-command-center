# Chat integrations

Open **Settings → Connections**. ChatGPT, Slack, Google Calendar and AI triage
share one in-app dialog using DCC’s dark theme and shared keyboard/focus behavior.
The former `/connections/conversation` URL redirects to the ChatGPT panel in DCC.
Slack reactions, Calendar OAuth and the local AI-triage workflow remain active
features; their setup flows are preserved rather than deleted. Onboarding keeps
its direct Slack/triage entry points.

The compact list and per-connection details follow the patterns documented by
[Notion](https://www.notion.com/help/connect-mcp-servers-to-your-notion-agent) and
[Claude](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities).
Technical MCP setup details are collapsed until needed. OAuth consent remains a
separate, DCC-branded authorization screen because it is part of the client’s
sign-in flow. The UI cannot install a ChatGPT connector or bypass workspace policy.

`GET /api/me/chat-connections` supplies owner-only, private/no-store connection
state and a CSRF token. Mutations retain server-side identity, owner, CSRF and
scope checks. Optional expected account/workspace values reject stale forms;
they never select the acting identity. No database migration is required.

## Access

Each category has Off, Read only and Full control. New connection preferences
start with Tasks and scheduling read-only and every other category off.
Select all is an explicit choice. Preferences are not grants: OAuth consent
grants only the selected subset of the client-requested scopes.

| Category | Read | Full control adds |
| --- | --- | --- |
| Tasks and scheduling | `dcc.tasks.read` | `dcc.tasks.write` |
| Repeat tasks | `dcc.repeats.read` | `dcc.repeats.write` |
| Working Queue and delegation | `dcc.queue.read` | `dcc.queue.write` |
| Time records | `dcc.time.read` | `dcc.time.write` |
| Projects and organization | `dcc.organization.read` | `dcc.organization.write` |
| Task files | `dcc.files.read` | `dcc.files.write` |

The shared catalog is `lib/chat-permissions.js`. Full control includes read
access in the selection UI. Server handlers independently check write authority.
Task edits that change project/category membership also require organization
write access; recurring task edits and cleanup also require repeat write access.
An import requires both organization and task write access. Private attachments
have their own grants rather than inheriting generic task access.

Legacy scopes, including the existing Wishlist scopes, retain their exact
authority. Legacy all-data readers are not exposed to a new category-only grant.
Existing grants are never expanded. Reductions use a locked subset check against
the actual grant and take effect on its next call, including existing tokens.
Additional access requires another OAuth authorization. Disconnect revokes the
grant and its access/refresh tokens. Separate grants remain separately listed;
disconnect obsolete connections explicitly.

## Connect and verify

Use the deployed `/mcp/dcc` URL with OAuth in ChatGPT, and request the scope string
shown under Manual connection details. Reuse the existing operator registration described in
`docs/chatgpt-connection-readiness.md`: exact HTTPS callback allowlisting, public
client authentication `none`, PKCE S256, resource-bound tokens and owner consent.
Never put a PA/admin token into ChatGPT. The page guides setup but cannot automate
host installation, account eligibility, or registration of an unknown callback.

Authorize the intended account/workspace, then refresh/reconnect the integration
in ChatGPT so its tool catalog reflects the grant. Ask the chat to check its DCC
connection (`dcc_connection_status`). A successful tool call stamps the grant’s
last verification time. Authorized and Verified are separate states; sign-in,
preferences and discovery alone do not count as a verified chat connection.

## Task controls and cleanup

New tools cover tasks, repeats, organization/imports, files, time records, and
bulk cleanup. Queue, delegation and time-correction tools accept their new
category scopes as alternatives to their existing legacy scopes. New readers
omit unrelated queue snapshots and time data. Mutations return compact receipts.

For deletion, prepare a cleanup with exact IDs or `allRepeats:true`, inspect its
manifest, then run its persistent job until terminal. A clear user instruction
already authorizes this sequence; do not add another approval just because the
operation has multiple steps. Ask if the intended records are ambiguous.

Cleanup retires all selected definitions under the same workspace/series locks
used by recurrence materialization before removing occurrences. It handles
scheduled and as-needed repeats, recurring workouts, and unlinked descendants.
The job processes 25 occurrences per call, preserves completed history and time
records, and reports stale/active/dependency conflicts instead of overwriting
them. Status is paginated and has no private before-images. Undo restores removed
records in bounded chunks with version checks, definitions last. Cleanup does
not stop external workers or erase recorded effort.

Search, Task Library/glasses and cleanup use the shared effective-completion
resolver, including historical `day_root._done` overlays. Generic completion is
still subject to canonical activity-specific outcome rules.

## Schema and rollout

Startup adds `conversation_grants.last_verified_at`, `conversation_preferences`,
`chat_operations`, and `chat_cleanup_jobs`. The tables use owner/workspace keys,
RLS and revoked public/client-role SQL access. Operation receipts and cleanup
before-images are private recovery/audit data. No existing task is migrated or
deleted at startup. Deploy with normal DB-risk review and acknowledgment; do not
use live personal tasks as release fixtures. Existing remote/coordinator gates
and registered-client configuration remain unchanged.

Schema rollback can leave the additive tables/column in place. Reverting code
does not restore deleted tasks or revoke existing grants automatically: undo
cleanup before rollback if required, and disconnect grants explicitly.

External messages, provider calendar edits, permanent history deletion, database
administration and deployment control remain outside these permissions.

## Validation

`chat-integrations.test.js` exercises real PostgreSQL via the isolated activity
fixture; `chat-integrations-http.test.js` verifies login, selected consent, scoped
discovery, revocation and immediate reductions. Set `DCC_PGLITE_MODULE` to an
installed PGlite package or use the existing localhost-only test DB configuration.

`DCC_PGLITE_MODULE=/path/to/@electric-sql/pglite node scripts/verify-chat-integrations.cjs`
checks the synthetic page with Chromium: choices, persistence, remote-disabled
setup, desktop/mobile, zoom, reduced motion and browser errors. Screenshots go
to `/tmp/dcc-chat-integrations-{desktop,mobile}.png`. This never reads production.
