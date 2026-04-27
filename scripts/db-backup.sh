#!/usr/bin/env bash
# Timestamped pg_dump backup of the production database.
#
# Usage:
#   DATABASE_URL=... ./scripts/db-backup.sh                # backups/backup-2026-04-27-1530.sql.gz
#   DATABASE_URL=... ./scripts/db-backup.sh pre-migration  # backups/backup-pre-migration-2026-04-27-1530.sql.gz
#
# Restore:
#   gunzip -c backups/<file>.sql.gz | psql "$DATABASE_URL"

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  cat >&2 <<'EOF'
ERROR: DATABASE_URL is not set.

For Railway production backups, grab the URL from the Postgres plugin:
  railway variables --service Postgres | grep DATABASE_URL
Then:
  export DATABASE_URL='<paste>'
  ./scripts/db-backup.sh
EOF
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found. Install postgresql-client (apt: postgresql-client, brew: libpq)." >&2
  exit 1
fi

LABEL="${1:-}"
TS="$(date +%F-%H%M)"
DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
mkdir -p "$DIR"

if [ -n "$LABEL" ]; then
  OUT="$DIR/backup-${LABEL}-${TS}.sql.gz"
else
  OUT="$DIR/backup-${TS}.sql.gz"
fi

# Mask credentials when echoing the URL.
SAFE_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:]+):[^@]+@#\1:***@#')"
echo "Dumping $SAFE_URL"
echo "  -> $OUT"

pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$OUT"

SIZE="$(du -h "$OUT" | awk '{print $1}')"
echo ""
echo "Done: $OUT ($SIZE)"
echo ""
echo "Restore:"
echo "  gunzip -c '$OUT' | psql \"\$DATABASE_URL\""
