#!/usr/bin/env bash
#
# Server 1 (192.168.1.13) — Incremental update
# git reset --hard → npm ci → fix quirks → run migrations → pm2 reload
#
set -euo pipefail

REPO_DIR="${GBOX_REPO_DIR:-$HOME/gbox-platform}"
BRANCH="${GBOX_BRANCH:-master}"
TAG="server1-update"

log() { echo "[${TAG}] $*"; }
die() { echo "[${TAG}] ERROR: $*" >&2; exit 1; }

# sudo helper — uses GBOX_SUDO_PW from bootstrap env if set, else plain sudo.
sudo_run() {
  if [[ -n "${GBOX_SUDO_PW:-}" ]]; then
    echo "$GBOX_SUDO_PW" | sudo -S -p '' "$@"
  else
    sudo "$@"
  fi
}

if [[ ! -d "$REPO_DIR/.git" ]]; then
  die "Repo not found at $REPO_DIR — run server1-setup.sh first"
fi

cd "$REPO_DIR"

log "Fetching origin..."
git fetch origin "$BRANCH"

log "Hard-resetting to origin/$BRANCH (owner prefers clean deploys, no stash)"
git reset --hard "origin/$BRANCH"

log "Running npm ci..."
npm ci

# Quirk #1
log "Fixing readable-stream quirk..."
rm -rf node_modules/readable-stream
npm install readable-stream --no-save

# Quirk #2
log "Fixing ownership on packages/core/src/modules..."
sudo_run chown -R "$USER":"$USER" "$REPO_DIR/packages/core/src/modules/" || true

# Pending migrations (safe to run repeatedly)
log "Running database migrations..."
npm --workspace=packages/db run migrate

# Zero-downtime PM2 reload
log "Reloading PM2 (zero-downtime)..."
pm2 reload ecosystem.config.cjs --only gbox-api,gbox-accounts,gbox-god-admin,gbox-store-admin,gbox-checkout

log "Server 1 update complete. Running processes:"
pm2 list
