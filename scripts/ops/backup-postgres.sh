#!/usr/bin/env bash
#
# Gbox Platform — Postgres Backup Script
#
# Phase 6.2. Streams a `pg_dump` of the platform database to a
# timestamped `.sql.gz` file in $BACKUP_DIR, optionally uploads to
# Cloudflare R2 via the `s3:` rclone remote, then prunes anything
# older than $BACKUP_RETAIN_DAYS.
#
# Usage:
#   ./scripts/ops/backup-postgres.sh                 # uses env vars
#   GBOX_DB=gbox_platform ./scripts/ops/backup-postgres.sh
#
# Crontab example (run from server 2 at 02:30 nightly, log to syslog):
#   30 2 * * * /opt/gbox/scripts/ops/backup-postgres.sh 2>&1 | logger -t gbox-backup
#
# Env vars (all have sane defaults):
#   PGHOST            — postgres host           (default: 127.0.0.1)
#   PGPORT            — postgres port           (default: 5432)
#   PGUSER            — postgres user           (default: gbox)
#   PGPASSWORD        — postgres password       (no default — read from .pgpass if unset)
#   GBOX_DB           — database name           (default: gbox_platform)
#   BACKUP_DIR        — local snapshot dir      (default: /var/backups/gbox)
#   BACKUP_RETAIN_DAYS — keep this many days locally (default: 14)
#   R2_REMOTE         — rclone remote name      (optional, e.g. "r2:gbox-backups")
#                        when set, the gz file is also pushed to R2.
#
# Exit codes:
#   0 — backup written + (if configured) uploaded
#   1 — pg_dump failed
#   2 — gzip failed
#   3 — R2 upload failed (file remains locally)

set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-gbox}"
GBOX_DB="${GBOX_DB:-gbox_platform}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/gbox}"
BACKUP_RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
R2_REMOTE="${R2_REMOTE:-}"

mkdir -p "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/gbox-${GBOX_DB}-${TS}.sql.gz"
LATEST_LINK="$BACKUP_DIR/gbox-${GBOX_DB}-latest.sql.gz"

echo "[backup] $(date -u '+%Y-%m-%dT%H:%M:%SZ') start db=${GBOX_DB} dest=${OUT}"

# pg_dump → gzip in one pipeline. PIPESTATUS lets us catch failure on
# either side without losing the original exit code. `--clean
# --if-exists` make the resulting file safe to restore on top of an
# existing database.
if ! pg_dump \
      --host="$PGHOST" \
      --port="$PGPORT" \
      --username="$PGUSER" \
      --dbname="$GBOX_DB" \
      --format=plain \
      --no-owner \
      --no-privileges \
      --clean \
      --if-exists \
    | gzip -9 > "$OUT"; then
  rc_dump="${PIPESTATUS[0]}"
  rc_gzip="${PIPESTATUS[1]}"
  echo "[backup] FAIL pg_dump=$rc_dump gzip=$rc_gzip"
  rm -f "$OUT"
  if [[ "$rc_dump" -ne 0 ]]; then exit 1; fi
  exit 2
fi

SIZE_BYTES="$(stat -c %s "$OUT" 2>/dev/null || stat -f %z "$OUT")"
echo "[backup] wrote ${OUT} (${SIZE_BYTES} bytes)"

# Refresh the "latest" symlink so restore scripts always know where
# the freshest snapshot lives without parsing filenames.
ln -sfn "$(basename "$OUT")" "$LATEST_LINK"

# ---------------------------------------------------------------------------
# Optional: upload to Cloudflare R2 via rclone
# ---------------------------------------------------------------------------

if [[ -n "$R2_REMOTE" ]]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "[backup] WARN rclone not installed — skipping R2 upload"
  else
    echo "[backup] uploading to ${R2_REMOTE}/$(basename "$OUT")"
    if ! rclone copy "$OUT" "$R2_REMOTE/" --s3-no-check-bucket; then
      echo "[backup] FAIL rclone upload"
      exit 3
    fi
    echo "[backup] uploaded ok"
  fi
fi

# ---------------------------------------------------------------------------
# Prune old local snapshots
# ---------------------------------------------------------------------------

# Use `find -mtime` so we never trip on filenames containing spaces or
# unicode. The `+N` flag means "older than N days" — i.e. last modified
# more than N*24h ago.
PRUNED=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "gbox-${GBOX_DB}-*.sql.gz" -mtime "+${BACKUP_RETAIN_DAYS}" -print -delete | wc -l)
if [[ "$PRUNED" -gt 0 ]]; then
  echo "[backup] pruned ${PRUNED} snapshots older than ${BACKUP_RETAIN_DAYS} days"
fi

echo "[backup] $(date -u '+%Y-%m-%dT%H:%M:%SZ') done"
exit 0
