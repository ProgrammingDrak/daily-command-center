# Background task sitreps through native MCP Events

Status: implemented behind a default-off gate; no production configuration,
credentials, real subscription, or ChatGPT wake-up has been performed by this change.

The [official MCP Events integration](https://developers.openai.com/plugins/build/mcp-events)
provides native webhook subscriptions for Work cloud chats and dots. A host-supplied
verified callback identifies the subscribing conversation. DCC does not inject a user
message, accept a guessed chat ID, use another messaging service, or poll ChatGPT.

## Behavior

`dcc.check_back_due` watches one exact canonical task ID in the authenticated
account's Working Queue. Subscribe from the conversation that should review that
task. It can be subscribed while foreground, but only a live manual background
check-back deadline produces an event. The fixed `prompt` field is `Sitrep?`.
Other payload fields are task ID, generation and due time; titles, private notes,
worker reports, credentials and arbitrary instructions are not transmitted.

The host automation should use this user-approved instruction:

> When this task's check-back is due, read its current DCC task and queue entry.
> Ignore the event if the task is completed, deleted, removed, foreground, or its
> deadline/generation has changed. Investigate the correlated work using available
> evidence. Reply in this subscribed conversation with “Sitrep?” and a concise
> progress review: verified accomplishments, remaining work, blockers, and next
> action. Distinguish stale or missing evidence from progress. Do not mark the task
> complete, change its timer, or expand access just because the timer expired.

This instruction belongs in the host's automation, not in untrusted event data.
An event is a review request, never evidence of execution or completion. A `2xx`
receipt means the host accepted the event, not that investigation finished.

## Reuse and delivery guarantees

- `/mcp/dcc` advertises `events` only when enabled, and implements `events/list`,
  `events/subscribe` and `events/unsubscribe`. It retains Streamable HTTP.
- Separate `dcc.events` and `dcc.read` consent is required. Existing grants gain
  no access. Subscription identities include grant, account, workspace, task and
  callback; only the host chooses the destination conversation through its callback.
- Private tables use RLS with public/anon/authenticated grants revoked. Signing
  keys are encrypted with AES-256-GCM under a separate server key, never logged.
- HTTPS port 443, public-address checks for every connection, DNS pinning, no
  redirects, bounded DNS/transfer time and response sizes protect callback delivery.
  Signed, single-use challenge verification precedes application data. Refresh
  re-verifies at least hourly or on secret change; rotation signs with both secrets
  for five minutes. Subscription lifetime defaults to one day, capped at seven
  days, including requests for indefinite lifetime. There are at most 100 stored
  subscriptions per account. Unsubscribe deletes its callback, secrets and deliveries.
- A server deadline scan runs every 15 seconds (20 subscriptions per batch),
  independent of browser visibility. This is local timer dispatch; the host
  receives native events and does not poll DCC. A continuously running DCC server
  is required for timely dispatch. A suspended server catches up on current due
  deadlines while the subscription remains valid; expired subscriptions do not
  replay historical deadlines on reactivation.
- Generation/deadline-derived event IDs survive retries and restarts. Account
  locks and durable acknowledgements serialize replicas. Transient network, 408,
  429 and 5xx failures retry at most eight times, starting at 15 seconds with
  exponential backoff capped at one hour. Other errors are terminal; 410 also
  disables the subscription. Transport ambiguity can produce duplicate deliveries
  with the same ID; exactly-once host execution is not claimed.
- Every attempt reuses the canonical queue projection and checks current access,
  task and reminder state. Rescheduling, snoozing, dismissal, queue removal,
  completion, deletion, foreground resume, ownership loss and grant revocation
  suppress stale deliveries. The browser pet's `notifiedAt` is independent.
  Bounded network delivery holds the account lock and grant share lock, so a
  concurrent queue change or revocation can wait up to DNS/transfer timeout.
  An already accepted/in-flight event cannot be recalled: the host must re-read
  the task/generation before acting. No task state, foreground clock, actuals,
  completion status or browser notification claim is changed by event dispatch.

## Activation: precise pending actions

1. Review this code/security boundary and additive schema; deploy using normal
   release checks with `DCC_EVENTS_ENABLED` absent/false. Do not use live tasks as
   fixtures. Existing conversational integration prerequisites still apply.
2. Obtain action-time approval before generating/storing a new 32-byte base64
   `DCC_EVENTS_ENCRYPTION_KEY` on Railway and enabling `DCC_EVENTS_ENABLED=true`.
   Preserve the key across restarts. Key replacement requires an explicit migration
   or removal/reconsent of subscriptions; it cannot decrypt existing rows.
3. Obtain approval to grant `dcc.read dcc.events` on the existing account connection
   (additional write scopes are separate). Rescan the MCP plugin and verify the
   event appears in its event catalog. If not exposed by this account/host, stop;
   do not substitute a timer/polling automation or an unrelated event source.
4. In the intended Griffula conversation, create the native subscription filtered
   to the approved canonical task. The host supplies the real callback URL and
   signing secret. Confirm approval for persistent storage/activation at this point.
   Do not fabricate a callback, use the PA token, or manually send a fake user message.
5. With an expressly approved synthetic account/task, prove discovery, subscription
   verification, due event receipt, assistant evidence review in the right chat,
   duplicate handling, rescheduling/cancellation, expiry/refresh and disconnect.
   Only this actual end-to-end test establishes activation. Current automation
   sources in the parent session do not yet list DCC, so this step is pending.

Rollback: set `DCC_EVENTS_ENABLED=false` and restart to stop advertisement and
dispatch. Preserve the main conversation coordinator. Revoke event grants or
unsubscribe to remove individual subscriptions. No production configuration or
grant is changed by the tests.

## Local verification

`mcp-events.test.js` covers real isolated PostgreSQL lifecycle transitions and
transport/security rules; `mcp-events-http.test.js` covers authenticated native MCP
methods and the default-off gate. Use a disposable localhost
`DCC_TEST_DATABASE_URL` with the existing isolated-schema harness. Synthetic keys
and callback doubles are test fixtures; no live callback is contacted. Run the
suite serially when enabling every PostgreSQL test: an existing workout planner
test counts identically named tables across all concurrently created schemas.

No UI changes or browser QA are needed for this server-side protocol addition.
Host subscription discovery, real callback delivery, and an actual Griffula reply
remain untested until the approved activation canary.
