#!/usr/bin/env bash
# refresh-local-db.sh — replace the LOCAL Postgres database with a fresh copy of
# a remote snapshot. macOS/Linux port of refresh-local-db.ps1 (same flow, same
# local-only safety guard). Drake's primary machine is darwin.
#
# Usage:
#   npm run db:refresh-local            # via the platform dispatcher
#   bash scripts/refresh-local-db.sh    # direct
#
# Resolves URLs from flags, then env, then .env.local / .env:
#   remote:  --remote-url | DCC_REMOTE_DATABASE_URL | REMOTE_DATABASE_URL
#   local:   --local-url  | DATABASE_URL
#
# Flags:
#   --remote-url URL     remote (source) database
#   --local-url URL      local (target) database — MUST be localhost
#   --backup-dir DIR     where dumps land (default: backups/db)
#   --schema NAME        restore only this schema (repeatable; default: public)
#   --skip-local-backup  don't back up the local db before dropping it
#   --skip-schema        don't run pg-schema.js afterward
#   --yes                skip the "type REFRESH" confirmation
#
# Restore a saved dump manually:
#   pg_restore --no-owner --no-acl --dbname="$DATABASE_URL" backups/db/remote-<ts>.dump

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

REMOTE_URL=""
LOCAL_URL=""
BACKUP_DIR="backups/db"
SCHEMAS=()
SKIP_LOCAL_BACKUP=""
SKIP_SCHEMA=""
ASSUME_YES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --remote-url) REMOTE_URL="$2"; shift 2;;
    --local-url) LOCAL_URL="$2"; shift 2;;
    --backup-dir) BACKUP_DIR="$2"; shift 2;;
    --schema) SCHEMAS+=("$2"); shift 2;;
    --skip-local-backup) SKIP_LOCAL_BACKUP=1; shift;;
    --skip-schema) SKIP_SCHEMA=1; shift;;
    --yes|-y) ASSUME_YES=1; shift;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unknown argument: $1" >&2; exit 2;;
  esac
done
[ ${#SCHEMAS[@]} -eq 0 ] && SCHEMAS=("public")

# ── Load .env.local then .env WITHOUT overriding already-set env vars ──
load_env() {
  local file="$1"
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"   # ltrim
    case "$line" in ""|\#*) continue;; esac
    case "$line" in *=*) ;; *) continue;; esac
    local key="${line%%=*}"; local val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"       # rtrim key
    val="${val#"${val%%[![:space:]]*}"}"       # ltrim val
    # strip matched surrounding quotes
    case "$val" in
      \"*\") val="${val%\"}"; val="${val#\"}";;
      \'*\') val="${val%\'}"; val="${val#\'}";;
    esac
    if [ -z "${!key:-}" ]; then export "$key=$val"; fi
  done < "$file"
}
load_env "$REPO_ROOT/.env.local"
load_env "$REPO_ROOT/.env"

[ -z "$REMOTE_URL" ] && REMOTE_URL="${DCC_REMOTE_DATABASE_URL:-}"
[ -z "$REMOTE_URL" ] && REMOTE_URL="${REMOTE_DATABASE_URL:-}"
[ -z "$LOCAL_URL" ] && LOCAL_URL="${DATABASE_URL:-}"

if [ -z "$REMOTE_URL" ]; then
  echo "ERROR: Missing remote database URL. Set DCC_REMOTE_DATABASE_URL in .env.local or pass --remote-url." >&2
  exit 1
fi
if [ -z "$LOCAL_URL" ]; then
  echo "ERROR: Missing local DATABASE_URL. Set it in .env or pass --local-url." >&2
  exit 1
fi
if [ "$REMOTE_URL" = "$LOCAL_URL" ]; then
  echo "ERROR: Remote and local database URLs are identical. Refusing to continue." >&2
  exit 1
fi

# ── URL parsing via node (reliable; node is always present in this project) ──
url_field() { node -e 'const u=new URL(process.argv[1]);const f=process.argv[2];if(f==="db")console.log(decodeURIComponent(u.pathname.replace(/^\//,"")));else if(f==="maint"){u.pathname="/postgres";console.log(u.toString())}else console.log(u[f])' "$1" "$2"; }
redact() { printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]+@#\1:***@#'; }

LOCAL_DB_NAME="$(url_field "$LOCAL_URL" db)"
LOCAL_HOST="$(url_field "$LOCAL_URL" hostname)"
MAINT_URL="$(url_field "$LOCAL_URL" maint)"

if [ -z "$LOCAL_DB_NAME" ]; then
  echo "ERROR: local DATABASE_URL must include a database name." >&2
  exit 1
fi
# A URL with an empty host, or one that smuggles the real host via a `?host=`
# param, would pass a naive hostname check while libpq connects elsewhere — so
# reject both and clear the PGHOST/PGHOSTADDR env overrides before the
# destructive DROP/CREATE. This keeps the guard as strict as refresh-local-db.ps1.
case "$LOCAL_URL" in
  *[?\&]host=*) echo "ERROR: 'host=' query param is not allowed in the local URL (it would bypass the local-only guard)." >&2; exit 1;;
esac
unset PGHOST PGHOSTADDR
case "$LOCAL_HOST" in
  localhost|127.0.0.1|::1) ;;
  *) echo "ERROR: Refusing to overwrite non-local database target: $(redact "$LOCAL_URL")" >&2; exit 1;;
esac

for bin in pg_dump pg_restore psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not found. Install postgresql client tools (brew install libpq, then add to PATH)." >&2; exit 1; }
done

TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
REMOTE_DUMP="$BACKUP_DIR/remote-$TS.dump"
LOCAL_BACKUP="$BACKUP_DIR/local-before-refresh-$TS.dump"

echo "Remote: $(redact "$REMOTE_URL")"
echo "Local:  $(redact "$LOCAL_URL")"
echo ""
echo "This will REPLACE local database '$LOCAL_DB_NAME'."
if [ -z "$ASSUME_YES" ]; then
  printf "Type REFRESH to continue: "
  read -r answer
  if [ "$answer" != "REFRESH" ]; then echo "Cancelled."; exit 1; fi
fi

echo "==> Dump remote database"
pg_dump --format=custom --no-owner --no-acl --file="$REMOTE_DUMP" "$REMOTE_URL"

if [ -z "$SKIP_LOCAL_BACKUP" ]; then
  echo "==> Back up current local database"
  if ! pg_dump --format=custom --no-owner --no-acl --file="$LOCAL_BACKUP" "$LOCAL_URL"; then
    echo "WARNING: Local backup failed (the local database may not exist yet). Continuing." >&2
    LOCAL_BACKUP=""
  fi
fi

echo "==> Recreate local database"
DB_LITERAL="${LOCAL_DB_NAME//\'/\'\'}"   # escape single quotes for the SQL string
psql "$MAINT_URL" -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_LITERAL' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"$LOCAL_DB_NAME\";" \
  -c "CREATE DATABASE \"$LOCAL_DB_NAME\";"

echo "==> Restore remote dump into local database"
RESTORE_ARGS=(--no-owner --no-acl --dbname="$LOCAL_URL")
for schema in "${SCHEMAS[@]}"; do [ -n "$schema" ] && RESTORE_ARGS+=(--schema="$schema"); done
pg_restore "${RESTORE_ARGS[@]}" "$REMOTE_DUMP"

if [ -z "$SKIP_SCHEMA" ]; then
  echo "==> Apply local schema updates"
  # Pin pg-schema.js to the db we just refreshed, not the ambient DATABASE_URL.
  DATABASE_URL="$LOCAL_URL" node pg-schema.js
fi

echo ""
echo "Local database refresh complete."
echo "Remote dump: $REMOTE_DUMP"
[ -n "$LOCAL_BACKUP" ] && echo "Local backup: $LOCAL_BACKUP"
