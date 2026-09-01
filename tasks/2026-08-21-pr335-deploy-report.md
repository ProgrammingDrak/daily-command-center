# Deploy report: PR #335

- **PR**: [#335 Give a freshly created block back its workspace, so a meeting follow-up schedules on the first click](https://github.com/ProgrammingDrak/daily-command-center/pull/335)
- **Repo**: ProgrammingDrak/daily-command-center
- **Merge SHA**: `c1efde565109d23bbdd769b8440317c74b8dfe50`
- **Merged at**: 2026-08-21T11:44:53Z
- **Merge path**: direct squash (`gh pr merge --squash`), subject tagged `[db-ok]`
- **Brain slug**: none. Ran the deploy + feature-report fallback.

## Timings

| Stage | Result |
|---|---|
| Queue wait | ~105 min blocked behind clever-real-estate/Offers-AMP feat/quiet-freeze, which self-parked on unavailable required human approval |
| Merge | immediate. `--delete-branch` errored because another worktree holds `main`; the merge itself succeeded and the remote branch was deleted separately |
| Deploy (Railway auto-deploy) | prod moved from `2a61b46` to `c1efde5` inside ~60s |
| Deploy guardrails workflow | completed / success on `c1efde5` |
| Canary | single pass, no issues |

## Canary evidence

- `GET /api/health` -> 200, `status: ok`, `database: ok`,
  `revision: c1efde565109d23bbdd769b8440317c74b8dfe50` (exact merge SHA), `uptime: 44s`
  confirming a fresh restart, `sseClients: 1` confirming a real client attached.
- `GET /` -> 302 to `/login`. Correct auth gate, not an error shell.
- `GET /public/js/catch-up.js` -> 200, 56215 bytes, contains the schedule call path.
  The app is serving.

**Not checked, stated plainly:** the prod UI click-through was NOT performed. The app
sits behind Google SSO, and exercising the fix on prod would mean seeding a test
meeting proposal into Drake's real data. The behavioral proof came from the local run
against a real Postgres instead, where the 409 was reproduced pre-fix and the same
call succeeded post-fix, with browser-captured before and after of the actual Loose
Ends click.

**One manual check worth doing** next time a real meeting recap produces follow-ups:
open Loose Ends and click Today on a fresh one. It should schedule on the first click
with no red toast.

## Verification carried in from the gate

- Full suite: 2149 pass, 0 fail, 3 skipped.
- Deep QA against real Postgres, 14/14 pass, covering all three writer return paths
  (fresh insert, ON CONFLICT re-read, idempotency winner) plus `updateBlock` and
  `rescheduleBlocks`.
- Local five-lane review (security, performance, correctness, tests, consistency)
  plus a verification pass. 8 candidates, 4 confirmed and fixed, 4 dismissed.
- No reviewer was requestable: `clever-prawdbot` is not a collaborator on this
  personal repo, so the local review was the only bot-grade review.

## Verdict

**DEPLOYED AND VERIFIED** at the service level, with the prod UI click-through
explicitly not performed for the reason above.
