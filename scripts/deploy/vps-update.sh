#!/bin/bash
# =============================================================================
# Gbox Platform — VPS Update (chạy mỗi lần deploy code mới)
#
# Usage:
#   bash /root/gbox-platform/scripts/deploy/vps-update.sh
# =============================================================================

set -euo pipefail

DEPLOY_DIR="/root/gbox-platform"
BRANCH="master"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

cd "$DEPLOY_DIR"

# --- 1. Pull latest code ---
log "Pulling latest code from origin/$BRANCH..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# --- 2. Sync nginx config (host nginx, not in docker) ---
# Nếu skip step này, các update trong infra/nginx/gbox-platform.conf không
# bao giờ apply (SSE buffering, path routing, ...). Nginx -t fail → set -e
# exit, không build docker để tránh deploy nửa vời.
NGINX_SRC="$DEPLOY_DIR/infra/nginx/gbox-platform.conf"
NGINX_DST="/etc/nginx/sites-available/gbox-platform"
if [ -f "$NGINX_SRC" ]; then
  log "Syncing nginx config..."
  cp "$NGINX_SRC" "$NGINX_DST"
  nginx -t
  systemctl reload nginx
  log "  nginx reloaded"
else
  warn "nginx config not found at $NGINX_SRC — skip"
fi

# --- 3. Build image ---
log "Building Docker image..."
docker build -t gbox-platform:latest .

# --- 4. Restart containers ---
log "Restarting containers..."
docker compose up -d --force-recreate

# --- 5. Health check ---
log "Waiting for services to start (10s)..."
sleep 10

declare -A SERVICES=(
  ["4321"]="API"
  ["4323"]="Accounts"
  ["4324"]="God Admin"
  ["4325"]="Store Admin"
  ["4326"]="Storefront"
  ["4327"]="Checkout"
  ["4328"]="Supporter"
)

PASS=0; FAIL=0
for PORT in "${!SERVICES[@]}"; do
  NAME="${SERVICES[$PORT]}"
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 \
    "http://localhost:$PORT/health" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    log "  $NAME (port $PORT): OK"
    ((PASS++))
  else
    warn "  $NAME (port $PORT): $STATUS"
    ((FAIL++))
  fi
done

echo ""
log "Result: $PASS OK, $FAIL failed"
[ "$FAIL" -gt 0 ] && warn "Check logs: docker compose logs --tail=50 <service-name>"

log "Deploy complete! $(date '+%Y-%m-%d %H:%M:%S')"
