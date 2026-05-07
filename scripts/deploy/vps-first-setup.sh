#!/bin/bash
# =============================================================================
# Gbox Platform — VPS First-Time Setup
# Run once as root on a fresh Ubuntu 22.04 VPS
#
# Usage:
#   GITHUB_TOKEN=ghp_xxx bash vps-first-setup.sh
# =============================================================================

set -euo pipefail

REPO_URL="https://github.com/GBox-Company/gbox-platform.git"
DEPLOY_DIR="/root/gbox-platform"
BRANCH="master"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- Guard ---
[ "$(id -u)" -eq 0 ] || err "Must run as root"
[ -n "${GITHUB_TOKEN:-}" ] || err "Set GITHUB_TOKEN before running"

# --- 1. System packages ---
log "Installing system packages..."
apt-get update -qq
apt-get install -y curl git nginx

# --- 2. Docker ---
if ! command -v docker &>/dev/null; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
else
  log "Docker already installed: $(docker --version)"
fi

# --- 3. Clone repo ---
if [ -d "$DEPLOY_DIR/.git" ]; then
  log "Repo already cloned, pulling..."
  cd "$DEPLOY_DIR"
  git remote set-url origin "https://${GITHUB_TOKEN}@github.com/GBox-Company/gbox-platform.git"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  log "Cloning repo..."
  git clone "https://${GITHUB_TOKEN}@github.com/GBox-Company/gbox-platform.git" "$DEPLOY_DIR"
  cd "$DEPLOY_DIR"
  git checkout "$BRANCH"
fi

# Store token for future pulls
git remote set-url origin "https://${GITHUB_TOKEN}@github.com/GBox-Company/gbox-platform.git"

# --- 4. .env ---
# .env phải tồn tại trước (chứa REDIS_URL, *_URL, secrets)
# Nếu chưa có thì stop để user tự tạo — không tự sinh secrets vào git
if [ ! -f "$DEPLOY_DIR/.env" ]; then
  warn ".env không tồn tại tại $DEPLOY_DIR/.env"
  warn "Tạo .env với các biến tối thiểu:"
  warn "  NODE_ENV=production"
  warn "  AUTH_SECRET=\$(openssl rand -hex 32)"
  warn "  SESSION_COOKIE_DOMAIN=.gbox.co"
  warn "  REDIS_URL=redis://:<URL_ENCODED_PASSWORD>@<host>:6379"
  warn "  ACCOUNTS_BASE_URL=https://admin.gbox.co"
  warn "  API_BASE_URL=https://admin.gbox.co"
  warn "  PLATFORM_BASE_URL=https://admin.gbox.co"
  warn "  CHECKOUT_BASE_URL=https://admin.gbox.co"
  warn "  STOREFRONT_BASE_URL=https://admin.gbox.co"
  exit 1
fi

# --- 5. Log directory ---
mkdir -p /var/log/gbox

# --- 6. Build & start containers ---
log "Building Docker image..."
cd "$DEPLOY_DIR"
docker build -t gbox-platform:latest .

log "Starting all containers..."
docker compose up -d

# --- 7. Nginx config ---
log "Installing nginx config..."
cp "$DEPLOY_DIR/infra/nginx/gbox-platform.conf" /etc/nginx/sites-available/gbox-platform
ln -sf /etc/nginx/sites-available/gbox-platform /etc/nginx/sites-enabled/gbox-platform
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# --- 8. SSL ---
# admin.gbox.co dùng Cloudflare Flexible SSL → VPS chỉ serve HTTP
# Nếu muốn end-to-end TLS: chỉnh Cloudflare sang Full mode + cài origin cert thủ công

log "============================================================"
log "Setup complete!"
log "Services running:"
docker compose ps
log "============================================================"
