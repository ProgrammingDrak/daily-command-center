# Slack reconciliation egress

The worker batches capture lookups and filters linked Waiting rows by message. Projection receipts prevent historical reactions from replaying after catch-up or restart. The receipt migration is explicitly gated. Before installation, the route continues using the original cursor with the optimized lookups.

## Local verification

Use a disposable Postgres database and Node 20 or 22. Integration tests create and remove isolated schemas. Slack requests are intercepted inside the fixture.

```sh
export DCC_TEST_DATABASE_URL=postgresql://postgres@localhost:55439/dcc_slack_reconcile_test
node --test slack-events.test.js slack-multi-actor.test.js slack-reaction-failures.test.js
node --test slack*.test.js
DCC_SLACK_DIAGNOSTIC_BASELINE=1 node --test --test-name-pattern='real Postgres lookup' slack-events.test.js
```

The diagnostic control loads the route from `890f1c64c594cfb2b34aeeca9c5ae1ff09690b0c` and adds metrics hooks. Each column shows one quiet sweep after warmup. All three measured sweeps had the same counts.

| Metric | Diagnostic | Candidate |
| --- | ---: | ---: |
| Unique search keys | 240 | 242 |
| Lookup queries | 240 | 3 |
| Lookup rows | 240 | 242 |
| Estimated lookup result bytes | 676,210 | 27,345 |
| Sweep database queries | 289 | 14 |
| Sweep database rows | 305 | 245 |
| Estimated sweep result bytes | 801,089 | 27,528 |
| Projections | 21 | 0 |
| Mocked Slack reaction writes | 63 | 0 |

The candidate examined two extra historical keys, including a missed capture and a tombstone. Lookup bytes fell 96.0%. Estimates sum each returned row’s UTF-8 JSON size. Set `SLACK_RECONCILE_METRICS=1` on a local server to emit aggregate metrics. Wire traffic includes protocol overhead and comes from Railway flow logs. Supabase usage comes from the billing dashboard.

### QA checklist

- Run the tests above against the disposable database. Check the three measured candidate sweeps for zero reaction writes.
- Check the fixture for one recovered capture and a preserved tombstone. Verify the other workspace’s exact key stays independent.
- Check that a mid-page 429 pauses projection before candidate reads, including after restart.
- Check that a timeout leaves the failed row retryable while a later row settles.
- Check that equal timestamps use the ID tie-breaker and late commits still project.

## Recovery cost

The five-minute default sweep remains. For actors with Slack search access, each reaction kind reads up to ten newest-first pages. One additional dated history page per kind advances each sweep. A saturated date range subdivides until it fits Slack’s page cap. A saturated single day remains bounded by Slack’s 100-page cap. The in-memory history position restarts after a process restart. Slack search coverage depends on token access, search indexing, and Slack result limits.

The mirror processes up to 20 due candidates per actor per sweep. New revisions take priority over earlier failures. A quiet actor performs a cooldown check and a revision scan. The fixture’s quiet candidate scan took about 5.6 ms with warm buffers. Legacy aliases and permalinks can broaden invalidation when their inputs change. Receipt comparisons use exact Postgres timestamp and row versions. A crash after Slack accepts a write but before the receipt commits can repeat that idempotent write. Unreachable messages remain eligible after the existing 24-hour retry window. Catch-up can write reactions for historical rows once.

## Approved rollout and rollback

1. Review `migrations/011_slack_projection_receipts.sql` independently. Apply it through the named migration runner before deploying the candidate. For the disposable fixture, use `DATABASE_URL="$DCC_TEST_DATABASE_URL" node scripts/migrate.js --only 011_slack_projection_receipts.sql` after running `pg-schema.js` against that database.
2. Verify the candidate commit at [DCC production health](https://daily-command-center-production-1d04.up.railway.app/api/health). Wait for initial catch-up. Use an approved Slack actor and message to check bookmark capture, delegation, completion, and reopening.
3. Compare equal quiet UTC windows across at least three five-minute sweeps. In [Railway’s DCC production service](https://railway.com/dashboard), use Observability Network Flow Logs or `railway logs --network`. Select the DCC service and production environment. Filter to TCP flows from the Supabase pooler and total bytes received by DCC. In [Supabase organization Usage](https://supabase.com/dashboard/org/_/usage), select the DCC project and compare Shared Pooler Egress at the dashboard’s available resolution. Attribute measurements only at the scope each service reports.
4. If rollback is needed, redeploy the verified previous SHA and confirm it at `/api/health`. The receipt table can remain. After every instance is on the previous SHA, an approved operator can run `migrations/rollback/011_slack_projection_receipts.sql`. This removes receipts and cooldowns. A later rollout will catch up again.
