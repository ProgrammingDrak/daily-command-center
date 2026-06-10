# Bootstrap — run the DCC on any machine, fast and safely

Goal: a new machine goes from nothing to a running Daily Command Center in **one
step**, without any secret ever living in git.

## The model

- **Code** travels in git (this repo / your `portable-programming` workspace).
- **Secrets** travel separately, off-git, in a place you control: a password
  manager entry, a synced secure note, or pulled from the Render dashboard. They
  land on each machine as a single `.env` file at the repo root. `.env` is
  gitignored — it must never be committed.
- **Shared state** lives in Postgres. Point a machine's `DATABASE_URL` at the
  shared Supabase prod DB and that machine instantly has your data *and* your
  server-side Google Calendar token — no per-machine re-auth.

## One-step setup on a fresh machine

```bash
# 1. Get the code (already present if you carry portable-programming):
git clone git@github.com:ProgrammingDrak/daily-command-center.git
cd daily-command-center

# 2. Drop your carried secrets into place:
cp /path/to/your/secret-store/dcc.env .env

# 3. One command → running:
bash scripts/bootstrap.sh
```

`scripts/bootstrap.sh` verifies `.env` exists and has the required keys, runs
`npm ci`, applies the schema (`pg-schema.js`, idempotent), and starts the server
on `PORT` (default 8090). Use `bash scripts/bootstrap.sh --no-start` to prep
without launching.

## What goes in `.env`

Required: `DATABASE_URL`, `SEED_USERNAME`, `SEED_PASSWORD`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`.
Optional: `PORT`, `DCC_TIME_ZONE`, `GOOGLE_REDIRECT_URI`, `APP_URL`, and
`SECRET_PA_TOKEN` (only needed for assistant/remote task scheduling). See
`.env.example` for the full list and shapes.

### Two `DATABASE_URL` choices

- **Shared (recommended for "instant on any machine"):** point at the Supabase
  pooled connection string. Every machine shares the same data and the
  server-side Google token, so the calendar works immediately with no re-auth.
- **Isolated local:** point at a local Postgres. The DB starts empty and you
  re-run the Google "Connect" flow once on that machine.

## Assistant task scheduling is independent

Letting Claude schedule tasks into the DCC needs only the **prod URL** plus
`SECRET_PA_TOKEN` — it does not depend on this bootstrap or on Google auth:

```
POST https://daily-command-center.onrender.com/api/dcc/quick-task
Authorization: Bearer <SECRET_PA_TOKEN>
Content-Type: application/json
{ "title": "...", "date": "YYYY-MM-DD", "start": "HH:MM",
  "durationMinutes": 30, "priority": "medium" }
```

## Security note

Never bake secrets into the repo, this file, or `bootstrap.sh`. The only secret
artifact on a machine is `.env`, which is gitignored. The legacy `data/blocks.db`
must stay untracked (it previously held live secrets) — see `SECURITY-ROTATION.md`.
