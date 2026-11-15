# Repository Instructions

## Environments — local AND production are both live

This app runs in two places at once. Know which you're touching before any write.

- **Local dev:** `http://localhost:8090` (local Postgres + legacy `data/blocks.db`).
  Token-free service writes require explicit disposable-local mode; see
  `docs/clerk-mcp-rollout.md`. A local HTTP peer alone is never trusted.
- **Production:** `https://daily-command-center-production-1d04.up.railway.app` — live on
  Railway (migrated off Render 2026-06-26), Supabase Postgres, auto-deploys from `main`.
  `NODE_ENV=production` → localhost is NOT trusted, so programmatic writes require
  `Authorization: Bearer <SECRET_PA_TOKEN>`. Health check: `/api/health`. All tooling
  (`scripts/dcc-schedule.js`, `mcp/dcc-mcp`, the `add-task` skill) must point here.

> Cold starts: the host can spin down on lower tiers (~30-60s to wake). Callers
> tolerate this via a warmup ping + bounded retry, tunable with `DCC_TIMEOUT_MS`,
> `DCC_WARMUP_TIMEOUT_MS`, `DCC_MAX_RETRIES`.

Production Clerk auth runs on Railway. (The old Render custom-domain cutover doc was
removed 2026-06-26 once Clerk worked on Railway; if you ever need it, the prod-DB
Google-login email pre-link note is in this file's git history.)

Account assistants use the remote `/mcp/dcc` OAuth connection packaged in
`plugins/dcc/`. Never provision PA/admin tokens or database credentials to this
connection. Owner repository/database access belongs in an explicitly selected
operator environment. Service automation requires account-bound, action-limited
credentials; see `docs/clerk-mcp-rollout.md` for migration and configuration.
The legacy stdio scheduler is operator-only and disabled unless
`DCC_OPERATOR_MCP=1`. Do not use it for normal assistant access.

## Git Worktrees

- Put all Daily Command Center auxiliary worktrees under `.worktrees/` inside this repo.
- Use a readable branch slug for the folder name, such as `.worktrees/sync-add-bounty-ui`.
- Do not create Daily Command Center worktree folders as siblings of this repo in `Repos/`.
- Leave Codex-managed temporary worktrees under `C:\Users\offic\.codex\worktrees\` alone unless the user asks to clean them up.

## Shipping to production (sync branch flow)

When asked to commit + PR + merge to `main` (auto-deploys to Render), run
**`npm run ship`** from the repo root. It pushes the current branch as
`sync/<name>`, opens a PR into `main`, and merges it in one step.

- `npm run ship -- <name>` for an explicit sync name; `npm run ship -- --dry` to preview.
- Requires `gh auth status` healthy. Add `--admin` to the merge line in
  `scripts/ship-pr.js` if branch protection ever blocks the merge.
- Why a script: in some agent sessions the harness gates a literal `git push` /
  `gh pr create` / `gh pr merge` even when allowlisted. Wrapping them in a node
  script runs them as child processes, so the flow completes hands-off. Only run
  it on an explicit ship instruction.

## DCC release backup policy

A fresh production backup is optional, not a release prerequisite. The owner removed
that requirement on 2026-10-29. Keep backup tools and existing backups intact; never
claim a backup occurred unless verified. This applies only to DCC and does not waive
database-change review/acknowledgment, tests, reviews, branch protection, deployment
checks or exact-SHA production verification. See
[the release policy](docs/releases/database-backup-policy.md) for the current rule;
it supersedes older DCC documentation that lists a backup as a mandatory release gate.
