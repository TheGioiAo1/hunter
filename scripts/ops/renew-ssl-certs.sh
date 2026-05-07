#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Gbox Platform — Cron driver for SSL certificate renewal.
# Phase 6.4.
#
# Runs daily (recommended cron: `30 3 * * *`). Two-stage flow:
#
#   1. Fast path: `certbot renew` handles every cert in
#      /etc/letsencrypt/live/* that's within Let's Encrypt's own
#      renewal window. This catches the 99% case with one binary call
#      and lets certbot's deduplication / hooks do their thing.
#
#   2. Application reconciliation: a tiny Node helper reads
#      `shop_domains` from Postgres, compares each row to the on-disk
#      cert, and updates `ssl_issued_at` / `ssl_expires_at` /
#      `ssl_last_error`. This is what the god-admin "SSL fleet
#      status" card reads. We keep the helper in TypeScript so it
#      shares types with `packages/core/src/modules/ops/ssl-cert.ts`.
#
# The cron lives in scripts/ops because it's wired up via `crontab -e`
# on the production box, not via our PM2 ecosystem.
#
# Environment:
#   GBOX_REPO_DIR     Repo path (defaults to script's parent dir)
#   CERTBOT_BIN       certbot binary (default: certbot)
#   CERTBOT_FORCE     1 → run renew with --force-renewal (debug only)
#   SLACK_WEBHOOK_URL Optional alert sink for failures
#
# Exit codes:
#   0  all done (or partial — failures are logged + alerted, not fatal)
#   2  certbot binary missing
# -----------------------------------------------------------------------------

set -uo pipefail

CERTBOT_BIN="${CERTBOT_BIN:-certbot}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GBOX_REPO_DIR="${GBOX_REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

alert() {
  local msg="$1"
  log "ALERT: $msg"
  if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
    curl -s -X POST -H 'Content-type: application/json' \
      --data "$(printf '{"text": "[gbox-ssl-renew] %s"}' "$msg")" \
      "$SLACK_WEBHOOK_URL" >/dev/null || true
  fi
}

if ! command -v "$CERTBOT_BIN" >/dev/null 2>&1; then
  alert "certbot binary not found"
  exit 2
fi

# ---- Stage 1: certbot renew ------------------------------------------------
log "Stage 1: certbot renew"
RENEW_FLAGS=(renew --non-interactive)
if [[ "${CERTBOT_FORCE:-0}" == "1" ]]; then
  log "  (forcing renewal)"
  RENEW_FLAGS+=(--force-renewal)
fi

if ! "$CERTBOT_BIN" "${RENEW_FLAGS[@]}"; then
  # Don't bail — partial failures are normal (a single domain whose
  # DNS got removed shouldn't block the rest of the fleet). The
  # reconciler in stage 2 will pick up the failure detail per-row.
  alert "certbot renew exited non-zero — see /var/log/letsencrypt"
fi

# ---- Stage 2: reconcile shop_domains rows ----------------------------------
log "Stage 2: reconcile shop_domains.ssl_*"
RECONCILER="$GBOX_REPO_DIR/scripts/ops/reconcile-ssl-state.ts"

if [[ -f "$RECONCILER" ]]; then
  if ! (cd "$GBOX_REPO_DIR" && pnpm tsx "$RECONCILER"); then
    alert "ssl-state reconciler exited non-zero"
  fi
else
  log "  (skipping — reconciler $RECONCILER not present yet)"
fi

log "done."
