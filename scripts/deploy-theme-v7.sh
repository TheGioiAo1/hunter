#!/usr/bin/env bash
# =============================================================================
# Gbox Platform — Clone Pro v7 Theme Deploy
# =============================================================================
#
# Usage:
#   bash scripts/deploy-theme-v7.sh <shop_id> <theme_zip_s3_key>
#
# Example:
#   bash scripts/deploy-theme-v7.sh 7c3d... themes/7c3d.../bundle-v3.zip
#
# Pulls a Stage 15 (Clone Pro v7 generator) theme.zip from S3, extracts
# it to /var/www/themes/<shop_id>/ on Server 3, and triggers a pm2
# reload of the storefront process so the new bundle goes live.
#
# This script is invoked from Stage 11 v7 publish. The orchestrator
# computes (shop_id, theme_zip_s3_key) from the Stage 15 result and
# shells out via SSH or local exec depending on env.
#
# Environment overrides (all optional):
#   S3_BUCKET     — defaults to gbox-clone-storage
#   THEMES_ROOT   — defaults to /var/www/themes
#   THEME_USER    — defaults to unbutu1 (Server 3 service user)
#   PM2_PROCESS   — defaults to gbox-storefront
#
# Iron Rule 5: never echoes seller-facing detail. Failures surface as
# non-zero exit; the orchestrator scrubs the diagnostic via safeMessage
# before any seller-facing channel.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Args + validation
# ---------------------------------------------------------------------------

if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Usage: $0 <shop_id> <theme_zip_s3_key>" >&2
  echo "  shop_id            UUID of the target shop" >&2
  echo "  theme_zip_s3_key   S3 key inside \$S3_BUCKET (no s3:// prefix)" >&2
  exit 64  # EX_USAGE
fi

SHOP_ID="${1}"
THEME_ZIP_S3_KEY="${2}"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

S3_BUCKET="${S3_BUCKET:-gbox-clone-storage}"
THEMES_ROOT="${THEMES_ROOT:-/var/www/themes}"
THEME_USER="${THEME_USER:-unbutu1}"
PM2_PROCESS="${PM2_PROCESS:-gbox-storefront}"

DEST="${THEMES_ROOT}/${SHOP_ID}"
TMP_ZIP="/tmp/theme-${SHOP_ID}.zip"

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

command -v aws    >/dev/null 2>&1 || { echo "[deploy-theme-v7] aws CLI not found" >&2; exit 1; }
command -v unzip  >/dev/null 2>&1 || { echo "[deploy-theme-v7] unzip not found"   >&2; exit 1; }
command -v pm2    >/dev/null 2>&1 || { echo "[deploy-theme-v7] pm2 not found"     >&2; exit 1; }

# ---------------------------------------------------------------------------
# Download theme.zip from S3
# ---------------------------------------------------------------------------

echo "[deploy-theme-v7] downloading s3://${S3_BUCKET}/${THEME_ZIP_S3_KEY}"
aws s3 cp "s3://${S3_BUCKET}/${THEME_ZIP_S3_KEY}" "${TMP_ZIP}"

# ---------------------------------------------------------------------------
# Rotate previous theme to .bak then extract
# ---------------------------------------------------------------------------

# Drop any stale backup so we don't collect cruft over time.
rm -rf "${DEST}.bak"

if [ -d "${DEST}" ]; then
  mv "${DEST}" "${DEST}.bak"
fi

mkdir -p "${DEST}"
unzip -q "${TMP_ZIP}" -d "${DEST}"

# ---------------------------------------------------------------------------
# Permissions + reload
# ---------------------------------------------------------------------------

chown -R "${THEME_USER}:${THEME_USER}" "${DEST}"

pm2 reload "${PM2_PROCESS}"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

rm -f "${TMP_ZIP}"

echo "[deploy-theme-v7] Deployed theme to ${DEST}"
