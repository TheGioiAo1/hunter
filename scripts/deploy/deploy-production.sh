#!/usr/bin/env bash
# =============================================================================
# Gbox Platform — Production Deployment Script
# =============================================================================
#
# Usage:
#   bash scripts/deploy/deploy-production.sh [--init|--update|--status|--health]
#
# Flags:
#   --init     First-time setup (clone, npm ci, PM2 start, nginx)
#   --update   Incremental update (pull, npm ci, PM2 reload)
#   --status   Show PM2 + system status
#   --health   Run health checks on all endpoints
#   --all      Run update + health
#   --dry-run  Print commands without executing
#
# Server fleet (defaults = LAN test fleet; override via env for any
# target — staging, beta prod, regional POP, customer bring-your-own-cloud):
#
#   GBOX_SERVER1_HOST / GBOX_SERVER1_USER  (role: DB + Admin + Nginx + API + Checkout)
#   GBOX_SERVER2_HOST / GBOX_SERVER2_USER  (role: REST API, load-balanced)
#   GBOX_SERVER3_HOST / GBOX_SERVER3_USER  (role: Storefront SSR)
#   GBOX_REPO_URL                          (Git remote to clone/pull)
#   GBOX_BRANCH                            (branch to deploy, default master)
#   GBOX_DEPLOY_DIR                        (remote path, default ~/gbox-platform)
#
# Defaults point at Thai's LAN test fleet (192.168.1.13/30/19). Never
# hard-code a new fleet here — set the vars in ~/.gbox-deploy.env before
# running, or pass inline:
#   GBOX_SERVER1_HOST=10.0.0.5 GBOX_SERVER1_USER=ubuntu bash ./deploy-production.sh --update
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config (all overridable via env)
# ---------------------------------------------------------------------------

REPO_URL="${GBOX_REPO_URL:-https://github.com/GBox-Company/gbox-platform.git}"
BRANCH="${GBOX_BRANCH:-master}"
DEPLOY_DIR="${GBOX_DEPLOY_DIR:-~/gbox-platform}"

SERVER1_HOST="${GBOX_SERVER1_HOST:-192.168.1.13}"
SERVER1_USER="${GBOX_SERVER1_USER:-botesty}"

SERVER2_HOST="${GBOX_SERVER2_HOST:-192.168.1.30}"
SERVER2_USER="${GBOX_SERVER2_USER:-unbutu2}"

SERVER3_HOST="${GBOX_SERVER3_HOST:-192.168.1.19}"
SERVER3_USER="${GBOX_SERVER3_USER:-unbutu1}"

DRY_RUN=false
ACTION=""

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------

for arg in "$@"; do
  case "$arg" in
    --init)    ACTION="init" ;;
    --update)  ACTION="update" ;;
    --status)  ACTION="status" ;;
    --health)  ACTION="health" ;;
    --all)     ACTION="all" ;;
    --dry-run) DRY_RUN=true ;;
    *)         echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

if [ -z "$ACTION" ]; then
  echo "Usage: $0 [--init|--update|--status|--health|--all] [--dry-run]"
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }

run_remote() {
  local host="$1" user="$2" cmd="$3"
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] ssh $user@$host: $cmd"
  else
    ssh -o StrictHostKeyChecking=no "$user@$host" "$cmd"
  fi
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

preflight() {
  log "Running pre-flight checks..."

  # Check SSH connectivity
  for pair in "$SERVER1_USER@$SERVER1_HOST" "$SERVER2_USER@$SERVER2_HOST" "$SERVER3_USER@$SERVER3_HOST"; do
    if [ "$DRY_RUN" = false ]; then
      if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$pair" "echo ok" >/dev/null 2>&1; then
        log "  SSH to $pair: OK"
      else
        err "  SSH to $pair: FAILED"
        exit 1
      fi
    else
      echo "[DRY-RUN] ssh $pair echo ok"
    fi
  done

  log "Pre-flight complete"
}

# ---------------------------------------------------------------------------
# Init (first-time)
# ---------------------------------------------------------------------------

init_server() {
  local host="$1" user="$2" name="$3" services="$4"

  log "Initializing $name ($host)..."

  run_remote "$host" "$user" "
    set -e
    # Install Node 20 if missing
    if ! command -v node &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
    node --version

    # Install PM2 globally
    if ! command -v pm2 &>/dev/null; then
      sudo npm install -g pm2
    fi

    # Clone repo
    if [ ! -d '$DEPLOY_DIR' ]; then
      git clone '$REPO_URL' '$DEPLOY_DIR'
    fi
    cd \"\$HOME/gbox-platform\"
    git checkout '$BRANCH'
    git pull origin '$BRANCH'

    # Install deps
    npm ci --production=false

    # Fix readable-stream bug (known quirk)
    READABLE_STREAM_PKG='node_modules/readable-stream/package.json'
    if [ -f \"\$READABLE_STREAM_PKG\" ] && [ ! -s \"\$READABLE_STREAM_PKG\" ]; then
      echo '{\"name\":\"readable-stream\",\"version\":\"4.7.0\",\"main\":\"lib/ours/index.js\"}' > \"\$READABLE_STREAM_PKG\"
    fi

    # Copy .env if not exists
    if [ ! -f .env ]; then
      cp .env.example .env
      echo '>>> IMPORTANT: Edit .env with production values! <<<'
    fi

    # Start services with PM2
    pm2 start ecosystem.config.cjs --only '$services'
    pm2 save

    echo '$name initialized successfully'
  "
}

do_init() {
  preflight

  log "=== INITIALIZING ALL SERVERS ==="

  init_server "$SERVER1_HOST" "$SERVER1_USER" "Server 1 (Main)" \
    "gbox-api,gbox-accounts,gbox-god-admin,gbox-store-admin,gbox-checkout"

  init_server "$SERVER2_HOST" "$SERVER2_USER" "Server 2 (API)" \
    "gbox-api"

  init_server "$SERVER3_HOST" "$SERVER3_USER" "Server 3 (Storefront)" \
    "gbox-storefront"

  # Setup nginx on server 1
  log "Configuring Nginx on Server 1..."
  run_remote "$SERVER1_HOST" "$SERVER1_USER" "
    cd \"\$HOME/gbox-platform\"
    sudo cp scripts/deploy/nginx-server1.conf.template /etc/nginx/sites-available/gbox-platform
    sudo ln -sf /etc/nginx/sites-available/gbox-platform /etc/nginx/sites-enabled/gbox-platform
    sudo nginx -t && sudo systemctl reload nginx
    echo 'Nginx configured and reloaded'
  "

  log "=== INIT COMPLETE ==="
}

# ---------------------------------------------------------------------------
# Update (incremental)
# ---------------------------------------------------------------------------

update_server() {
  local host="$1" user="$2" name="$3" services="$4"

  log "Updating $name ($host)..."

  run_remote "$host" "$user" "
    set -e
    cd \"\$HOME/gbox-platform\"

    # Pull latest
    git fetch origin '$BRANCH'
    git reset --hard 'origin/$BRANCH'

    # Reinstall deps
    npm ci --production=false

    # Fix readable-stream
    READABLE_STREAM_PKG='node_modules/readable-stream/package.json'
    if [ -f \"\$READABLE_STREAM_PKG\" ] && [ ! -s \"\$READABLE_STREAM_PKG\" ]; then
      echo '{\"name\":\"readable-stream\",\"version\":\"4.7.0\",\"main\":\"lib/ours/index.js\"}' > \"\$READABLE_STREAM_PKG\"
    fi

    # Reload PM2 (zero-downtime for fork mode)
    pm2 reload '$services' --update-env
    pm2 save

    echo '$name updated successfully'
  "
}

do_update() {
  log "=== UPDATING ALL SERVERS ==="

  update_server "$SERVER1_HOST" "$SERVER1_USER" "Server 1 (Main)" \
    "gbox-api gbox-accounts gbox-god-admin gbox-store-admin gbox-checkout"

  update_server "$SERVER2_HOST" "$SERVER2_USER" "Server 2 (API)" \
    "gbox-api"

  update_server "$SERVER3_HOST" "$SERVER3_USER" "Server 3 (Storefront)" \
    "gbox-storefront"

  log "=== UPDATE COMPLETE ==="
}

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

do_status() {
  log "=== SERVER STATUS ==="

  for info in "Server1|$SERVER1_HOST|$SERVER1_USER" "Server2|$SERVER2_HOST|$SERVER2_USER" "Server3|$SERVER3_HOST|$SERVER3_USER"; do
    IFS='|' read -r name host user <<< "$info"
    log "--- $name ($user@$host) ---"
    run_remote "$host" "$user" "
      echo '=== PM2 Status ==='
      pm2 list 2>/dev/null || echo 'PM2 not running'
      echo ''
      echo '=== Memory ==='
      free -h | head -2
      echo ''
      echo '=== Disk ==='
      df -h / | tail -1
    " 2>/dev/null || true
  done
}

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

do_health() {
  log "=== HEALTH CHECKS ==="

  local endpoints=(
    "http://$SERVER1_HOST:4321/health|API Health"
    "http://$SERVER1_HOST:4323/health|Accounts Health"
    "http://$SERVER1_HOST:4324/health|God Admin Health"
    "http://$SERVER1_HOST:4325/health|Store Admin Health"
    "http://$SERVER1_HOST:4327/health|Checkout Health"
    "http://$SERVER2_HOST:4321/health|API-2 Health"
    "http://$SERVER3_HOST:4326/health|Storefront Health"
  )

  local pass=0 fail=0

  for entry in "${endpoints[@]}"; do
    IFS='|' read -r url label <<< "$entry"
    if [ "$DRY_RUN" = true ]; then
      echo "[DRY-RUN] curl -sf $url"
      continue
    fi

    status=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 "$url" 2>/dev/null || echo "000")
    if [ "$status" = "200" ]; then
      log "  $label: ${GREEN}OK${NC} ($status)"
      ((pass++))
    else
      err "  $label: FAIL ($status)"
      ((fail++))
    fi
  done

  echo ""
  log "Results: $pass passed, $fail failed"
  [ "$fail" -eq 0 ] || exit 1
}

# ---------------------------------------------------------------------------
# Execute
# ---------------------------------------------------------------------------

case "$ACTION" in
  init)   do_init ;;
  update) do_update ;;
  status) do_status ;;
  health) do_health ;;
  all)    do_update; do_health ;;
esac

log "Done!"
