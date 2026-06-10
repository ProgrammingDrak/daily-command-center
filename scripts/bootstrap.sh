#!/usr/bin/env bash
# bootstrap.sh — get the Daily Command Center running on a fresh machine in one step.
#
# Secrets are NEVER committed. They live in a .env you carry off-git (password
# manager, secure note, or pulled from the Render dashboard). This script just
# verifies the .env is present and complete, installs deps, applies the schema,
# and starts the server.
#
# Usage:
#   cp /path/to/your/secret-store/dcc.env .env   # drop your carried secrets in
#   bash scripts/bootstrap.sh                     # one step → running
#
# Options:
#   --no-start   prep only (install + schema), don't launch the server.
set -euo pipefail
cd "$(dirname "$0")/.."

NO_START=0
[[ "${1:-}" == "--no-start" ]] && NO_START=1

# 1) .env must exist (secrets come from off-git, never from the repo).
if [[ ! -f .env ]]; then
  echo "✗ No .env found." >&2
  echo "  Copy your carried secrets file into place first, e.g.:" >&2
  echo "    cp /path/to/secret-store/dcc.env .env" >&2
  echo "  See .env.example for the required keys." >&2
  exit 1
fi

# 2) Required keys must be present and non-empty.
REQUIRED=(DATABASE_URL SEED_USERNAME SEED_PASSWORD GOOGLE_CLIENT_ID \
          GOOGLE_CLIENT_SECRET CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY)
# SECRET_PA_TOKEN is only needed if you want assistant/remote task scheduling.
OPTIONAL=(SECRET_PA_TOKEN PORT DCC_TIME_ZONE GOOGLE_REDIRECT_URI APP_URL)
missing=()
for k in "${REQUIRED[@]}"; do
  v="$(grep -E "^${k}=" .env | head -1 | cut -d= -f2-)"
  [[ -z "${v// }" ]] && missing+=("$k")
done
if (( ${#missing[@]} )); then
  echo "✗ .env is missing required keys: ${missing[*]}" >&2
  exit 1
fi
for k in "${OPTIONAL[@]}"; do
  grep -qE "^${k}=" .env || echo "• note: optional key ${k} not set" >&2
done
echo "✓ .env present with all required keys"

# 3) Install deps (clean, reproducible).
echo "→ npm ci"
npm ci

# 4) Apply DB schema (idempotent; works against local Postgres or Supabase).
echo "→ applying schema (node pg-schema.js)"
node pg-schema.js

if (( NO_START )); then
  echo "✓ Bootstrap complete (prep only). Start with: npm start"
  exit 0
fi

# 5) Run.
echo "→ npm start"
exec npm start
