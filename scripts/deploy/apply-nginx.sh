#!/usr/bin/env bash
#
# Apply Gbox nginx config on server 1.
# Usage: sudo ./apply-nginx.sh <path-to-rendered-template>
#
# Rules (from MEMORY.md quirk #6):
#   - NEVER leave backup files in /etc/nginx/sites-enabled/ — they cause
#     "duplicate upstream" errors on reload. Backups go to /tmp.
#   - Always run `nginx -t` BEFORE reloading. Abort on test failure.
#
set -euo pipefail

SRC="${1:-/tmp/gbox-nginx-new}"
DEST="/etc/nginx/sites-enabled/gbox"
TAG="apply-nginx"

log() { echo "[${TAG}] $*"; }
die() { echo "[${TAG}] ERROR: $*" >&2; exit 1; }

# sudo helper — uses GBOX_SUDO_PW from bootstrap env if set, else plain sudo.
# Bootstrap forwards this from ~/.gbox-deploy.env via `GBOX_SUDO_PW=...` on
# the remote exec. If empty (passwordless sudo or manual interactive run),
# we fall through to plain sudo.
sudo_run() {
  if [[ -n "${GBOX_SUDO_PW:-}" ]]; then
    echo "$GBOX_SUDO_PW" | sudo -S -p '' "$@"
  else
    sudo "$@"
  fi
}

if [[ ! -f "$SRC" ]]; then
  die "Source template not found: $SRC"
fi

# Backup existing config OUTSIDE /etc/nginx/sites-enabled/
if [[ -f "$DEST" ]]; then
  BACKUP="/tmp/gbox-nginx-backup-$(date +%s)"
  log "Backing up current config → $BACKUP"
  sudo_run cp "$DEST" "$BACKUP"
fi

# Also sweep any stray backup files from sites-enabled (hard-earned lesson)
for bak in /etc/nginx/sites-enabled/gbox.bak /etc/nginx/sites-enabled/gbox.old /etc/nginx/sites-enabled/gbox~; do
  if [[ -f "$bak" ]]; then
    log "Removing stray backup in sites-enabled: $bak"
    sudo_run mv "$bak" "/tmp/$(basename "$bak")-$(date +%s)"
  fi
done

log "Installing new config → $DEST"
sudo_run install -m 0644 "$SRC" "$DEST"

log "Running nginx -t..."
if ! sudo_run nginx -t; then
  die "nginx -t failed — NOT reloading. Fix the template and re-run."
fi

log "Reloading nginx..."
sudo_run systemctl reload nginx

log "Nginx reloaded successfully."
