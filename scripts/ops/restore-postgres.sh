#!/usr/bin/env bash
#
# Gbox Platform — Postgres Restore Script
#
# Phase 6.2. Companion to `backup-postgres.sh`. Restores a single
# `.sql.gz` snapshot into the platform database. By default it loads
# the `latest` symlink, but any path can be passed on argv.
#
# This script REQUIRES `--yes` to actually run because it will drop
# existing tables on top of the running database. Without the flag it
# prints what it would do and exits 0.
#
# Usage:
#   ./scripts/ops/restore-postgres.sh                              # dry-run, latest
#   ./scripts/ops/restore-postgres.sh --yes                        # restore latest
#   ./scripts/ops/restore-postgres.sh --yes path/to/dump.sql.gz    # restore specific
#
# Env vars:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, GBOX_DB, BACKUP_DIR — same as backup
#
# Exit codes:
#   0 — restore succeeded (or dry-run finished)
#   1 — file not found
#   2 — psql failed mid-restore
#   3 — required `--yes` flag missing for a destructive run

set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-gbox}"
GBOX_DB="${GBOX_DB:-gbox_platform}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/gbox}"

YES=false
SOURCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)
      YES=true
      shift
      ;;
    -h|--help)
      sed -n '1,25p' "$0"
      exit 0
      ;;
    *)
      SOURCE="$1"
      shift
      ;;
  esac
done

# Resolve the source file: explicit arg → BACKUP_DIR/<name> → latest symlink
if [[ -z "$SOURCE" ]]; then
  SOURCE="$BACKUP_DIR/gbox-${GBOX_DB}-latest.sql.gz"
fi
if [[ ! -e "$SOURCE" ]] && [[ -e "$BACKUP_DIR/$SOURCE" ]]; then
  SOURCE="$BACKUP_DIR/$SOURCE"
fi

if [[ ! -e "$SOURCE" ]]; then
  echo "[restore] FAIL source not found: $SOURCE" >&2
  exit 1
fi

# Resolve symlink to a real path so the user sees what they'd actually load.
REAL_SOURCE="$(readlink -f "$SOURCE" 2>/dev/null || echo "$SOURCE")"
SIZE_BYTES="$(stat -c %s "$REAL_SOURCE" 2>/dev/null || stat -f %z "$REAL_SOURCE")"

echo "[restore] target db   : ${GBOX_DB} @ ${PGHOST}:${PGPORT}"
echo "[restore] source file : ${REAL_SOURCE}"
echo "[restore] file size   : ${SIZE_BYTES} bytes"

if [[ "$YES" != "true" ]]; then
  echo
  echo "[restore] DRY RUN — pass --yes to actually load the snapshot."
  echo "[restore] command that would run:"
  echo "  gunzip -c '${REAL_SOURCE}' | psql --host=${PGHOST} --port=${PGPORT} --username=${PGUSER} --dbname=${GBOX_DB} --single-transaction --set ON_ERROR_STOP=1"
  exit 0
fi

echo "[restore] $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting restore"

# `--single-transaction` + `ON_ERROR_STOP=1` → either every statement
# applies or none of them do. Without this a half-loaded snapshot
# would leave the platform in an inconsistent state.
if ! gunzip -c "$REAL_SOURCE" \
    | psql \
        --host="$PGHOST" \
        --port="$PGPORT" \
        --username="$PGUSER" \
        --dbname="$GBOX_DB" \
        --single-transaction \
        --set ON_ERROR_STOP=1 \
        --quiet; then
  echo "[restore] FAIL psql exited non-zero" >&2
  exit 2
fi

echo "[restore] $(date -u '+%Y-%m-%dT%H:%M:%SZ') restore done"
exit 0
