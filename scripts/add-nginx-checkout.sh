#!/usr/bin/env bash
# Step 2.8b — add a nginx server block for checkout.gbox.co on server 1
#
# This script is idempotent. It:
#   1. Adds an upstream `gbox_checkout` pointing to server 1 port 4327.
#   2. Adds a separate `server { server_name checkout.gbox.co; }` block
#      that proxies everything to the upstream.
#   3. Tests the new config with `nginx -t` and reloads on success.
#
# Host-header routing strategy: in the LAN test env we don't have real
# checkout.gbox.co DNS. Clients exercise the new server block with
#
#   curl -H "Host: checkout.gbox.co" http://192.168.1.13/...
#
# In production we flip the same block to listen on 443 with the
# existing wildcard *.gbox.co cert (which already matches
# checkout.gbox.co). See the "Step 2.8c — Production TLS" comment
# block near the bottom of this file for the exact lines to change.
#
# Run as:  bash scripts/add-nginx-checkout-server2.sh
set -euo pipefail

SUDO_PW='1'  # test env only
NGINX_CONF=/etc/nginx/sites-enabled/gbox
BACKUP=~/gbox-nginx-backup-$(date +%s).conf
MARKER='upstream gbox_checkout'

if echo "$SUDO_PW" | sudo -S grep -q "$MARKER" "$NGINX_CONF" 2>/dev/null; then
  echo "[nginx] checkout block already present — nothing to do"
  exit 0
fi

echo "[nginx] backing up current config to $BACKUP"
echo "$SUDO_PW" | sudo -S cp "$NGINX_CONF" "$BACKUP"

TMP=/tmp/gbox-nginx-new.conf
echo "$SUDO_PW" | sudo -S cp "$NGINX_CONF" "$TMP"
sudo chown "$USER":"$USER" "$TMP"

# 1. Add new upstream block directly after the existing `gbox_storefront`
#    upstream so all upstreams stay grouped at the top of the file.
python3 - <<'PY' "$TMP"
import sys, re
path = sys.argv[1]
with open(path, 'r') as fh:
    src = fh.read()

upstream = """upstream gbox_checkout {
    server 127.0.0.1:4327;
    keepalive 32;
}
"""

if 'upstream gbox_checkout' not in src:
    src = re.sub(
        r'(upstream gbox_storefront \{[^}]*\}\n)',
        r'\1' + upstream,
        src,
        count=1,
    )

# 2. Append a dedicated server block for checkout.gbox.co at the end.
checkout_block = """

# ======================================================
# Gbox Checkout (Decision #2 — PCI subdomain split)
# server_name checkout.gbox.co → server 1 port 4327
# Buyer-only payment subdomain. Strict CSP / no inline scripts / no
# iframing. Keep this block ABOVE any TLS listener that adds the
# wildcard *.gbox.co cert — it must have its own server_name match.
# ======================================================
server {
    listen 80;
    server_name checkout.gbox.co;

    client_max_body_size 2M;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;

    # Keep the strict security headers the app already emits; do NOT
    # override them in nginx. The only thing we add is forwarded-proto
    # so the app knows to set Secure cookies behind the TLS terminator.

    location / {
        proxy_pass http://gbox_checkout;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 30s;
        proxy_connect_timeout 5s;
    }
}
"""

if 'server_name checkout.gbox.co' not in src:
    src = src.rstrip() + '\n' + checkout_block + '\n'

with open(path, 'w') as fh:
    fh.write(src)
print("[nginx] config rewritten")
PY

# ============================================================================
# Step 2.8c — Production TLS (deferred; LAN test env cannot exercise this)
# ============================================================================
# The block above listens on :80 so we can test it with
#   curl -H 'Host: checkout.gbox.co' http://192.168.1.13/...
# inside the LAN. Before we flip checkout.gbox.co to public DNS, do this on
# the production nginx box:
#
#   1. Make sure the wildcard cert at /etc/letsencrypt/live/gbox.co/fullchain.pem
#      already covers *.gbox.co (it does — checkout.gbox.co matches the
#      existing wildcard, no re-issue needed). If we ever move to a cert
#      without the wildcard, re-issue via:
#
#        sudo certbot certonly --nginx \
#          -d gbox.co -d www.gbox.co -d api.gbox.co \
#          -d accounts.gbox.co -d admin.gbox.co -d checkout.gbox.co
#
#   2. Replace the `listen 80;` line in the checkout server block with:
#
#        listen 443 ssl http2;
#        ssl_certificate     /etc/letsencrypt/live/gbox.co/fullchain.pem;
#        ssl_certificate_key /etc/letsencrypt/live/gbox.co/privkey.pem;
#        ssl_protocols       TLSv1.2 TLSv1.3;
#        ssl_ciphers         HIGH:!aNULL:!MD5;
#        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
#
#   3. Add a second tiny :80 block that 301-redirects to https on the same host:
#
#        server {
#            listen 80;
#            server_name checkout.gbox.co;
#            return 301 https://$host$request_uri;
#        }
#
#   4. Point checkout.gbox.co A/AAAA records at the prod nginx IP and run
#      `sudo nginx -t && sudo systemctl reload nginx`.
#
# We intentionally DO NOT do any of this inside the script because
# (a) the test env has no public DNS for checkout.gbox.co and
# (b) touching TLS on a prod box should be a human-reviewed change.
# ============================================================================

echo "[nginx] testing new config..."
echo "$SUDO_PW" | sudo -S cp "$TMP" "$NGINX_CONF"
if echo "$SUDO_PW" | sudo -S nginx -t 2>&1; then
  echo "[nginx] test passed — reloading"
  echo "$SUDO_PW" | sudo -S systemctl reload nginx
  echo "[nginx] reloaded OK"
else
  echo "[nginx] TEST FAILED — restoring backup"
  echo "$SUDO_PW" | sudo -S cp "$BACKUP" "$NGINX_CONF"
  exit 1
fi
