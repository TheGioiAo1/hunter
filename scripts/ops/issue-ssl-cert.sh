#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Gbox Platform — Issue or renew an SSL cert for a single custom domain.
# Phase 6.4.
#
# Wraps `certbot --nginx` so the renewal cron + the god-admin "Issue
# now" button can both call the same code path. The TypeScript layer
# (packages/core/src/modules/ops/ssl-cert.ts) decides WHICH domains
# need work; this script does ONE domain at a time.
#
# Why bash + certbot instead of an in-process ACME client (e.g.
# acme-client npm package)?
#
#   1. The Node API + storefront processes already share an nginx
#      vhost on the production box, so a stand-alone certbot run
#      with --nginx hot-reloads nginx for us. No application restart
#      needed.
#   2. certbot's TOS / account / rate-limit handling is battle tested.
#      Reimplementing it would be the worst kind of yak shave.
#   3. We can read the result back from the filesystem
#      (/etc/letsencrypt/live/<domain>/cert.pem) and update Postgres
#      from a tiny Node script that imports the same `ssl-cert.ts`
#      types — no duplication.
#
# Usage:
#   sudo scripts/ops/issue-ssl-cert.sh shop.example.com [admin@example.com]
#
# Environment:
#   ACME_EMAIL          Override admin email (defaults to $2)
#   CERTBOT_BIN         Override certbot binary (default: certbot)
#   CERTBOT_STAGING=1   Use the Let's Encrypt staging endpoint
#                       (recommended for any new merchant the first
#                       time you wire them up — avoids burning rate
#                       limits while you fix DNS).
#
# Exit codes:
#   0  cert issued / renewed successfully
#   1  bad arguments
#   2  certbot binary missing
#   3  certbot run failed (rate limit, DNS not pointing here, …)
# -----------------------------------------------------------------------------

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-${ACME_EMAIL:-}}"

if [[ -z "$DOMAIN" ]]; then
  echo "usage: $0 <domain> [admin-email]" >&2
  exit 1
fi

if [[ -z "$EMAIL" ]]; then
  echo "ERROR: ACME email required (pass as 2nd arg or set ACME_EMAIL)" >&2
  exit 1
fi

CERTBOT_BIN="${CERTBOT_BIN:-certbot}"
if ! command -v "$CERTBOT_BIN" >/dev/null 2>&1; then
  echo "ERROR: $CERTBOT_BIN not found in PATH" >&2
  echo "Install with: sudo apt install certbot python3-certbot-nginx" >&2
  exit 2
fi

CERTBOT_FLAGS=(
  --nginx
  --non-interactive
  --agree-tos
  --email "$EMAIL"
  --domain "$DOMAIN"
  # Reuse the same key on renewal — keeps HPKP-style pin caches happy
  # for the rare merchant who pinned. New private key on first issue.
  --keep-until-expiring
  # Don't ask the merchant about EFF newsletter signup.
  --no-eff-email
)

if [[ "${CERTBOT_STAGING:-0}" == "1" ]]; then
  echo "→ Using Let's Encrypt STAGING (test cert, browsers will warn)"
  CERTBOT_FLAGS+=(--staging)
fi

echo "→ Requesting cert for $DOMAIN as $EMAIL"
if ! "$CERTBOT_BIN" "${CERTBOT_FLAGS[@]}"; then
  echo "ERROR: certbot failed for $DOMAIN" >&2
  exit 3
fi

CERT_PATH="/etc/letsencrypt/live/$DOMAIN/cert.pem"
if [[ -r "$CERT_PATH" ]]; then
  EXPIRES=$(openssl x509 -in "$CERT_PATH" -noout -enddate | cut -d= -f2)
  echo "✓ Cert issued/renewed for $DOMAIN — expires $EXPIRES"
else
  echo "WARN: certbot reported success but $CERT_PATH is unreadable" >&2
fi
