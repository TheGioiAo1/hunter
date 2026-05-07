#!/usr/bin/env bash
#
# Server 2 (192.168.1.30) — First-time setup
# Role: REST API (gbox-api on :4321), stateless, talks to server 1 Postgres
#
# Does NOT run migrations or seed data — that's server 1's job.
#
set -euo pipefail

REPO_URL="${GBOX_REPO_URL:-https://github.com/GBox-Company/gbox-platform.git}"
REPO_DIR="${GBOX_REPO_DIR:-$HOME/gbox-platform}"
BRANCH="${GBOX_BRANCH:-master}"
TAG="server2-setup"

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

# ----------------------------------------------------------------------------
# Prerequisites
# ----------------------------------------------------------------------------
log "Checking prerequisites..."
for bin in git node npm pm2; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    die "Missing prerequisite: $bin — install before running this script"
  fi
done

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "Node 20+ required, found $(node -v)"
fi
log "Prerequisites OK (node $(node -v), pm2 $(pm2 -v))"

# ----------------------------------------------------------------------------
# Clone or reuse repo
# ----------------------------------------------------------------------------
if [[ ! -d "$REPO_DIR/.git" ]]; then
  log "Cloning $REPO_URL → $REPO_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
else
  log "Repo already exists at $REPO_DIR — skipping clone"
fi

cd "$REPO_DIR"

# ----------------------------------------------------------------------------
# npm install + quirks
# ----------------------------------------------------------------------------
log "Running npm ci..."
npm ci

log "Fixing readable-stream quirk..."
rm -rf node_modules/readable-stream
npm install readable-stream --no-save

log "Fixing ownership on packages/core/src/modules..."
sudo_run chown -R "$USER":"$USER" "$REPO_DIR/packages/core/src/modules/" || true

# ----------------------------------------------------------------------------
# Ensure PM2 log dir + DATABASE_URL reminder
# ----------------------------------------------------------------------------
if [[ ! -d /var/log/gbox ]]; then
  log "Creating /var/log/gbox"
  sudo_run mkdir -p /var/log/gbox
  sudo_run chown "$USER":"$USER" /var/log/gbox
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  log "WARN: DATABASE_URL is not set in the env — gbox-api will use process env"
  log "      Make sure .env or systemd env provides: postgresql://gbox@192.168.1.13:5432/gbox_platform"
fi

# ----------------------------------------------------------------------------
# PM2 start (gbox-api only)
# ----------------------------------------------------------------------------
log "Starting gbox-api..."
pm2 start ecosystem.config.cjs --only gbox-api

log "Saving PM2 process list..."
pm2 save

log "Server 2 setup complete. Running processes:"
pm2 list
