#!/usr/bin/env bash
#
# Server 2 (192.168.1.30) — Incremental update
# git reset --hard → npm ci → fix quirks → pm2 reload (no migrations)
#
set -euo pipefail

REPO_DIR="${GBOX_REPO_DIR:-$HOME/gbox-platform}"
BRANCH="${GBOX_BRANCH:-master}"
TAG="server2-update"

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
  die "Repo not found at $REPO_DIR — run server2-setup.sh first"
fi

cd "$REPO_DIR"

log "Fetching origin..."
git fetch origin "$BRANCH"

log "Hard-resetting to origin/$BRANCH"
git reset --hard "origin/$BRANCH"

log "Running npm ci..."
npm ci

log "Fixing readable-stream quirk..."
rm -rf node_modules/readable-stream
npm install readable-stream --no-save

log "Fixing ownership on packages/core/src/modules..."
sudo_run chown -R "$USER":"$USER" "$REPO_DIR/packages/core/src/modules/" || true

log "Reloading gbox-api (zero-downtime)..."
pm2 reload ecosystem.config.cjs --only gbox-api

log "Server 2 update complete. Running processes:"
pm2 list
