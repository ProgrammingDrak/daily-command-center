# Local adversarial review — conversational integration

Reviewed candidate `22be6f2` against `aa859bd26540c528305a61023fef148c91264bc7`, then fixed and re-reviewed the local changes. Five independent lanes covered security, correctness, performance, tests and consistency; separate reviewers confirmed findings before fixes. All lanes completed. The complete feature exceeds 1,000 changed lines; splitting publication into reviewable increments is recommended and review depth has that size limitation.

## Resolved findings

- Public endpoints previously reached PostgreSQL without throttling. Bounded global/peer ingress now runs before body parsing, sessions and database work, with an authenticated account budget. Express case/trailing-slash route variants receive the same limits.
- Real Chrome form submissions exposed `Origin: null` under `Referrer-Policy: no-referrer`, causing valid consent/disconnect to fail. `same-origin` preserves same-origin POST origins and excludes external referrers. Exact-origin and session CSRF checks remain enforced. Browser cancellation, authorization and disconnect then succeeded in a synthetic harness.
- Correction now snapshots each touched task's existing session total using the canonical projection helper, preserving historical actuals without ledger rows (90 existing + 20 incoming = 110).
- Correction and completion cascades explicitly return every changed task ID; newly closed session rows also reach live invalidation and the first reconciliation read.
- Parent completion applies the same bounded closure to an active child, records its unknown tail, removes completed descendants from background activity, and preserves unknown actuals for untimed children. State filters externally completed/deleted background tasks.
- Routine foreground commands lock only the target/current foreground, while history has an owner/workspace/time index.
- Guided work acquires the account advisory lock before task rows and explicitly passes its existing transaction client. Actual PostgreSQL clients expose `connect()` too, so the previous capability heuristic incorrectly tried reconnecting one. Canonical completion and legacy reallocation acquire the same account lock before their row locks when enabled.
- Late continuation closes the bounded prior session and begins a fresh one at the explicit event time. Closure separates the effective ledger end from transition receipt/event ordering, so an eight-hour cutoff cannot leave a timer permanently unpausable.
- Enabled legacy completion/reconciliation does not manufacture focused effort from planned minutes or overwrite planning fields. Known corrections retire unknown-actual markers.
- Calendar snapshots reuse the materializer's canonical meeting identity helper, avoiding duplicate identities when both event_id and source_id are present.
- Generic stale property writes preserve server-owned check-in timestamps/counts as well as timer and actual fields.
- New database tests are included in `test:postgres` (the CI PostgreSQL job), and the background test no longer depends on which concurrent command wins.

## Verification

- Real PostgreSQL review tests cover the historical-actuals preservation, cascaded cutoff/background cleanup, changed-task reporting, stale external background state, canonical calendar identity, late continuation, first-read reconciliation, and guided transaction/lock-order paths.
- Existing OAuth/HTTP tests cover exact redirect and resource binding, S256, one-use codes, rotating refresh tokens and reuse revocation, expiry, scopes, owner isolation, forged identity headers, CSRF and disconnect. Existing store tests cover replay, stale revision, concurrent writers, interruption rollback and the synthetic 50-minute meeting/unknown correction.
- Synthetic Chrome QA used fresh fixture account 1: no connected clients → Cancel → still none → Allow → scope review → Disconnect. Fixture account 2 remained unconnected. The loopback harness maps its test origin to a fake HTTPS issuer and captures the fake callback locally; it performs no external registration, real consent or token exchange. This does not certify production Clerk onboarding.
- Security follow-up found no remaining blocking findings in the reviewed code. This is a code review and synthetic verification, not a third-party audit certification.

Final local evidence: full suite **3,155 passed, zero failed, 15 environment/database-dependent skips**; CI PostgreSQL command **61 passed, zero failed/skipped**; targeted timing/guided suite **64 passed, zero failed/skipped**; final changed-guard PostgreSQL suite **22 passed, zero failed/skipped**. ESLint found zero errors and 16 pre-existing server warnings. `git diff --check` passed. Logs and the synthetic disconnect screenshot are saved in the task workspace `conversation-evidence/` directory.

## Actual connection and release status

Official [OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth) supports predefined OAuth clients, PKCE S256 and public-client `none` authentication. This candidate uses that supported protocol option; it does not implement CIMD or DCR. The actual ChatGPT account's builder eligibility, exact callback and end-to-end connection are unverified. Because the server does not advertise authorization-response issuer identification, use the callback shown by the management page rather than guessing the stable callback.

No push, PR, deployment, production migration, real OAuth metadata registration, grant or token has been created by this work. The live QuickBuy fixture is untouched. The DB-risk guard applies (`db.js`, `pg-schema.js`, a gated migration and server-side SQL are changed); no acknowledgement tag or backup waiver was added.

Remaining release/setup gates are concrete: migration-risk review (backups are optional under the [DCC release policy](releases/database-backup-policy.md)); approval to publish/deploy with the feature disabled; owner-reviewed foreground-conflict audit and explicit approval for migration 010; shared ingress limits/trusted-proxy verification and retention policy; action-time approval for real OAuth client configuration and account consent; then an actual ChatGPT/dot tool-exposure, isolation, write/read-back and revocation canary. Until that succeeds the status remains **implemented locally, not connected**.
