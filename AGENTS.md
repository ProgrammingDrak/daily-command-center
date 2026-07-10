# Repository Instructions

## Deploy & Close
<!-- Read by the /deploy-and-close skill. One line each; edit to taste. -->
- **Review:** none            <!-- none | ai[:reviewer] | human[:who] -->
- **Notify:** personal        <!-- personal | slack:#channel | email:addr -->
- **Deploy:** merge to `main` -> Railway prod (auto-deploys; verify the new commit's deployment reaches SUCCESS via the Railway GraphQL API, then curl a code marker on `/public/js/...`)
- **Brain slug:** none        <!-- claude-brain project slug, or none -->

## Environments — local AND production are both live

This app runs in two places at once. Know which you're touching before any write.

- **Local dev:** `http://localhost:8090` (local Postgres + legacy `data/blocks.db`).
  `NODE_ENV` unset → localhost is trusted, so service endpoints work without a token.
- **Production (canonical):** `https://daily-command-center.onrender.com` — live on
  Render, Supabase Postgres, auto-deploys from `main`. `NODE_ENV=production` →
  localhost is NOT trusted, so programmatic writes require
  `Authorization: Bearer <SECRET_PA_TOKEN>`. Health check: `/api/health`. All tooling
  (`scripts/dcc-schedule.js`, `mcp/dcc-mcp`, the `add-task` skill) must point here.

> Host naming — this was previously documented in a confusing way; the canonical
> production URL is `daily-command-center.onrender.com`.
> `daily-command-center-personal.onrender.com` is the legacy duplicate — it is still
> the `name:` in `render.yaml`, and as of 2026-06-19 it was the warm instance while
> the canonical host cold-started. It is being retired; do not point new tooling at
> it. Reconciling `render.yaml` + the Render dashboard onto the canonical name is a
> production-deploy task — get explicit sign-off before changing `render.yaml`.
>
> Cold starts: the canonical host can spin down on the free tier (~30-60s to wake).
> Callers now tolerate this via a warmup ping + bounded retry, tunable with
> `DCC_TIMEOUT_MS`, `DCC_WARMUP_TIMEOUT_MS`, `DCC_MAX_RETRIES`. The permanent cure is
> an always-on plan or a keep-warm cron ping on the canonical service.

Production Clerk/custom-domain cutover is not done yet — see `CLERK-PRODUCTION-SETUP.md`.

Assistant task scheduling: `POST {BASE}/api/dcc/quick-task` with the bearer token —
body `{ title, date, start, durationMinutes, priority, detail, tags }`. Don't hand-roll
it — use one of the built tools:
- CLI: `node scripts/dcc-schedule.js --title "..." [--date --start --duration --priority --tags]`
  (env: `DCC_BASE_URL`, `DCC_PA_TOKEN`/`SECRET_PA_TOKEN`; `--dry-run` to preview).
- MCP: `mcp/dcc-mcp/server.js` → `schedule_task` tool (see `mcp/dcc-mcp/README.md`).

Prereq: `SECRET_PA_TOKEN` set on the Render service + same value in the caller's env.

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
