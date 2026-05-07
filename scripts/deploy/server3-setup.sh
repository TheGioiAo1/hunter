#!/usr/bin/env bash
#
# Server 3 (192.168.1.19) — First-time setup
# Role: Public storefront (Astro SSR via storefront-server.ts on :4321)
#
# Stateless. Talks to server 1 Postgres via DATABASE_URL.
# NOTE: the ecosystem config names this PM2 app "gbox-storefront" and its
# PORT env is 4326 in-repo, but on server 3 we bind it to :4321 on the LAN
# because nginx on server 1 routes storefront traffic to 192.168.1.19:4321.
# Override happens through the systemd/pm2 env on this server (DATABASE_URL
# + PORT=4321), not by editing ecosystem.config.cjs here.
#
set -euo pipefail

REPO_URL="${GBOX_REPO_URL:-https://github.com/GBox-Company/gbox-platform.git}"
REPO_DIR="${GBOX_REPO_DIR:-$HOME/gbox-platform}"
BRANCH="${GBOX_BRANCH:-master}"
TAG="server3-setup"

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
# Ensure PM2 log dir
# ----------------------------------------------------------------------------
if [[ ! -d /var/log/gbox ]]; then
  log "Creating /var/log/gbox"
  sudo_run mkdir -p /var/log/gbox
  sudo_run chown "$USER":"$USER" /var/log/gbox
fi

# ----------------------------------------------------------------------------
# PM2 start (gbox-storefront only)
# ----------------------------------------------------------------------------
log "Starting gbox-storefront..."
PORT=4321 pm2 start ecosystem.config.cjs --only gbox-storefront --update-env

log "Saving PM2 process list..."
pm2 save

log "Server 3 setup complete. Running processes:"
pm2 list
