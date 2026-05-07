#!/usr/bin/env bash
#
# Manual deploy to the 3-server test environment.
#
# Until deploy.yml is fully fixed (paths + systemd→PM2 + secrets), this
# script is the canonical way to ship master HEAD to the live boxes.
# Run it from your laptop — it SSHes to all 3 servers in sequence.
#
# Pre-reqs:
#   - SSH key auth set up to all 3 hosts (botesty / unbutu2 / unbutu1)
#   - The repo must already exist at $REPO_PATH on each server
#   - PM2 installed + the relevant ecosystem files committed
#
# Usage:
#   ./scripts/deploy-manual.sh         # deploy master HEAD to all 3 boxes
#   ./scripts/deploy-manual.sh --admin # only redeploy server 1 (admin)
#   ./scripts/deploy-manual.sh --api   # only redeploy server 2 (api)
#   ./scripts/deploy-manual.sh --sf    # only redeploy server 3 (storefront)
#
# 2026-04-26 deploy goal:
#   After this runs, the seller dashboard sidebar should show
#   "Theme editor" and NOT show "Clone Pro". Verify by opening
#   http://192.168.1.13/admin/store/<slug> in a browser.

set -euo pipefail

REPO_PATH="${REPO_PATH:-/home/\$USER/gbox-platform}"

ALL=true
ADMIN=false
API=false
SF=false
case "${1:-}" in
  --admin) ALL=false; ADMIN=true ;;
  --api)   ALL=false; API=true ;;
  --sf)    ALL=false; SF=true ;;
  '') ;;
  *) echo "Unknown flag: $1"; exit 1 ;;
esac

echo "===> Pulling master on all hosts that need it"

deploy_admin() {
  echo
  echo "==================================================================="
  echo " Server 1 — 192.168.1.13 (botesty) — store-admin :4325"
  echo "==================================================================="
  ssh botesty@192.168.1.13 bash -se <<'REMOTE'
    set -euo pipefail
    cd ~/gbox-platform
    git fetch origin master
    git reset --hard origin/master
    npm ci --legacy-peer-deps
    npm run build --workspace @gbox/db || true
    npm run build --workspace @gbox/core || true
    # Restart the seller-facing apps so the sidebar reload picks up
    # the Theme editor entry + the Clone-Pro scrub.
    pm2 reload gbox-store-admin --update-env || pm2 start ecosystem/store-admin.config.cjs
    pm2 reload gbox-accounts    --update-env || pm2 start ecosystem/accounts.config.cjs
    pm2 reload gbox-god-admin   --update-env || pm2 start ecosystem/god-admin.config.cjs
    pm2 save
    pm2 list | head -20
REMOTE
}

deploy_api() {
  echo
  echo "==================================================================="
  echo " Server 2 — 192.168.1.30 (unbutu2) — REST API :4321"
  echo "==================================================================="
  ssh unbutu2@192.168.1.30 bash -se <<'REMOTE'
    set -euo pipefail
    cd ~/gbox-platform
    git fetch origin master
    git reset --hard origin/master
    npm ci --legacy-peer-deps
    npm run build --workspace @gbox/db || true
    npm run build --workspace @gbox/core || true
    pm2 reload gbox-api --update-env
    pm2 save
    pm2 list | head -10
REMOTE
}

deploy_sf() {
  echo
  echo "==================================================================="
  echo " Server 3 — 192.168.1.19 (unbutu1) — storefront :4321"
  echo "==================================================================="
  ssh unbutu1@192.168.1.19 bash -se <<'REMOTE'
    set -euo pipefail
    cd ~/gbox-platform
    git fetch origin master
    git reset --hard origin/master
    npm ci --legacy-peer-deps
    npm run build --workspace @gbox/db || true
    npm run build --workspace @gbox/core || true
    pm2 reload gbox-storefront --update-env
    pm2 save
    pm2 list | head -10
REMOTE
}

if $ALL || $ADMIN; then deploy_admin; fi
if $ALL || $API;   then deploy_api;   fi
if $ALL || $SF;    then deploy_sf;    fi

echo
echo "===> Deploy complete."
echo "Verify in browser:"
echo "  Seller dashboard sidebar:  http://192.168.1.13/admin/store/<slug>"
echo "    Online Store > Theme editor   ← should appear"
echo "    Online Store > Clone Pro      ← should NOT appear"
echo "  Theme editor entry-point:  http://192.168.1.13/admin/store/<slug>/online-store/theme-editor"
echo "    → 302 to /themes/<main-id>/customize"
