#!/usr/bin/env bash
#
# Server 1 (192.168.1.13) — First-time setup
# Role: Postgres + Redis + Nginx entry point + admin web PM2 apps
#
# Idempotent: re-running will skip clone, re-fix readable-stream, re-run
# migrations (migrations themselves are idempotent), and skip reseed if
# shops already exist.
#
set -euo pipefail

REPO_URL="${GBOX_REPO_URL:-https://github.com/GBox-Company/gbox-platform.git}"
REPO_DIR="${GBOX_REPO_DIR:-$HOME/gbox-platform}"
BRANCH="${GBOX_BRANCH:-master}"
TAG="server1-setup"

log() { echo "[${TAG}] $*"; }
die() { echo "[${TAG}] ERROR: $*" >&2; exit 1; }

# ----------------------------------------------------------------------------
# sudo helper — supports both passwordless sudo AND password-sudo servers.
# If GBOX_SUDO_PW is forwarded from bootstrap-3-servers.sh we pipe it via
# `sudo -S` (prompt suppressed with -p ''), otherwise fall back to plain
# sudo so the script still works on machines with NOPASSWD entries or when
# run interactively. The password never lands on sudo's argv — it goes via
# stdin, so it can't be read from /proc/<pid>/cmdline.
# ----------------------------------------------------------------------------
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
for bin in git node npm pm2 nginx psql redis-cli; do
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
# Clone or use existing repo
# ----------------------------------------------------------------------------
if [[ ! -d "$REPO_DIR/.git" ]]; then
  log "Cloning $REPO_URL → $REPO_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
else
  log "Repo already exists at $REPO_DIR — skipping clone"
fi

cd "$REPO_DIR"

# ----------------------------------------------------------------------------
# npm install
# ----------------------------------------------------------------------------
log "Running npm ci..."
npm ci

# Quirk #1: readable-stream/package.json goes to 0 bytes after install
log "Fixing readable-stream quirk..."
rm -rf node_modules/readable-stream
npm install readable-stream --no-save

# Quirk #2: root-owned files in packages/core/src/modules
log "Fixing ownership on packages/core/src/modules..."
sudo_run chown -R "$USER":"$USER" "$REPO_DIR/packages/core/src/modules/" || true

# ----------------------------------------------------------------------------
# DB migrations
# ----------------------------------------------------------------------------
log "Running database migrations..."
npm --workspace=packages/db run migrate

# ----------------------------------------------------------------------------
# Seed mock data (idempotent)
# ----------------------------------------------------------------------------
log "Checking seed state..."
SHOP_COUNT=$(psql "${DATABASE_URL:-postgresql://gbox@localhost:5432/gbox_platform}" \
  -tAc "SELECT COUNT(*) FROM shops" 2>/dev/null || echo "0")

if [[ "$SHOP_COUNT" -gt 0 ]]; then
  log "Shops already seeded (count=$SHOP_COUNT) — skipping seed"
else
  log "Seeding mock data via seed-data.ts..."
  ./node_modules/.bin/tsx seed-data.ts
fi

# ----------------------------------------------------------------------------
# Ensure PM2 log dir
# ----------------------------------------------------------------------------
if [[ ! -d /var/log/gbox ]]; then
  log "Creating /var/log/gbox"
  sudo_run mkdir -p /var/log/gbox
  sudo_run chown "$USER":"$USER" /var/log/gbox
fi

# ----------------------------------------------------------------------------
# PM2 start
# ----------------------------------------------------------------------------
log "Starting PM2 apps (admin stack + local gbox-api)..."
pm2 start ecosystem.config.cjs --only gbox-api,gbox-accounts,gbox-god-admin,gbox-store-admin,gbox-checkout

log "Saving PM2 process list..."
pm2 save

log "Server 1 setup complete. Running processes:"
pm2 list
