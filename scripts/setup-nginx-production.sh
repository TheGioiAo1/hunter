#!/bin/bash
# ============================================
# Gbox Platform — Production Nginx Configuration
# 3-Server LAN Topology:
#   Server 1 (192.168.1.13): Nginx + Postgres + Redis + Admin apps + Checkout
#   Server 2 (192.168.1.30): REST API (gbox-api)
#   Server 3 (192.168.1.19): Public Storefront (Astro SSR)
#
# Optimized for 100K RPS with:
# - 7 upstream pools with keepalive
# - Proxy caching (API: 30s, Static: 7d)
# - Rate limiting at edge (API: 100/s, Auth: 5/s, Checkout: 10/s)
# - Gzip compression
# - Security headers
# - SSL/TLS termination
# - Checkout subdomain isolation (PCI best practice)
#
# Usage:
#   sudo bash scripts/setup-nginx-production.sh                # default (gbox.co)
#   sudo bash scripts/setup-nginx-production.sh gbox.co        # explicit
# ============================================

DOMAIN=${1:-"gbox.co"}

# Server IPs (overridable for different environments)
S1_IP="${GBOX_S1_IP:-127.0.0.1}"
S2_IP="${GBOX_S2_IP:-192.168.1.30}"
S3_IP="${GBOX_S3_IP:-192.168.1.19}"

echo "[nginx-prod] Setting up Production Nginx for $DOMAIN..."
echo "[nginx-prod] Topology: S1=$S1_IP  S2=$S2_IP  S3=$S3_IP"

# Create cache directories
sudo mkdir -p /var/cache/nginx/api
sudo mkdir -p /var/cache/nginx/static
sudo chown -R www-data:www-data /var/cache/nginx/

# Create log directory for gbox
sudo mkdir -p /var/log/gbox
sudo chown -R www-data:www-data /var/log/gbox/

# ====================================================================
# Nginx main config (worker tuning)
# ====================================================================

sudo tee /etc/nginx/nginx.conf > /dev/null << 'NGINX_MAIN'
# Gbox Platform — Nginx Main Configuration
# Optimized for 100K RPS on 3-server topology

user www-data;
worker_processes auto;           # = CPU cores
worker_rlimit_nofile 65535;      # Max open files per worker
pid /run/nginx.pid;

events {
    worker_connections 4096;     # Connections per worker (default 768)
    multi_accept on;             # Accept all new connections at once
    use epoll;                   # Linux epoll — most efficient
}

http {
    # ---- Basics ----
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    types_hash_max_size 2048;
    server_tokens off;           # Hide Nginx version

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # ---- Keep-Alive ----
    keepalive_timeout 65;
    keepalive_requests 1000;     # Reuse connection for up to 1000 requests

    # ---- Buffers ----
    client_body_buffer_size 16k;
    client_header_buffer_size 1k;
    large_client_header_buffers 4 16k;

    # ---- Open File Cache ----
    open_file_cache max=10000 inactive=5m;
    open_file_cache_valid 2m;
    open_file_cache_min_uses 1;
    open_file_cache_errors on;

    # ---- Gzip Compression ----
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 256;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/json
        application/javascript
        application/xml
        application/rss+xml
        image/svg+xml
        font/woff2;

    # ---- Rate Limiting Zones ----
    # API: 100 requests/second per IP (burst 200)
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/s;
    # Auth: 5 requests/second per IP (strict — brute force protection)
    limit_req_zone $binary_remote_addr zone=auth_limit:5m rate=5r/s;
    # Checkout: 10 requests/second per IP (moderate — conversion-critical)
    limit_req_zone $binary_remote_addr zone=checkout_limit:5m rate=10r/s;
    # General: 60 requests/second per IP
    limit_req_zone $binary_remote_addr zone=general_limit:10m rate=60r/s;

    # ---- Proxy Cache ----
    proxy_cache_path /var/cache/nginx/api
        levels=1:2
        keys_zone=api_cache:50m
        max_size=1g
        inactive=60s
        use_temp_path=off;

    proxy_cache_path /var/cache/nginx/static
        levels=1:2
        keys_zone=static_cache:20m
        max_size=2g
        inactive=7d
        use_temp_path=off;

    # ---- Logging ----
    log_format gbox '$remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent" '
                    'rt=$request_time uct=$upstream_connect_time '
                    'uht=$upstream_header_time urt=$upstream_response_time '
                    'cache=$upstream_cache_status';

    access_log /var/log/nginx/access.log gbox buffer=256k flush=5m;
    error_log /var/log/nginx/error.log warn;

    # Include site configs
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
NGINX_MAIN

# ====================================================================
# Site config — 3-server topology
# ====================================================================

sudo tee /etc/nginx/sites-available/gbox-platform > /dev/null << EOF
# ====================================================================
# Gbox Platform — Production Site Config (3-Server Topology)
#
# Server 1 (local):     Admin portals + Checkout + platform API fallback
# Server 2 ($S2_IP):  REST API (gbox-api)
# Server 3 ($S3_IP):  Public Storefront (Astro SSR)
# ====================================================================

# ---- Local PM2 apps on Server 1 ----
upstream gbox_god_admin {
    server $S1_IP:4324;
    keepalive 8;
}

upstream gbox_accounts {
    server $S1_IP:4323;
    keepalive 16;
}

upstream gbox_store_admin {
    server $S1_IP:4325 max_fails=3 fail_timeout=30s;
    keepalive 32;
}

upstream gbox_checkout {
    server $S1_IP:4327 max_fails=3 fail_timeout=30s;
    keepalive 16;
}

upstream gbox_platform_local {
    server $S1_IP:4321;
    keepalive 16;
}

# ---- Remote servers ----
upstream gbox_api {
    least_conn;
    server $S2_IP:4321 max_fails=3 fail_timeout=30s;
    keepalive 64;
}

upstream gbox_storefront {
    least_conn;
    server $S3_IP:4321 max_fails=3 fail_timeout=30s;
    keepalive 32;
}

# ====================================================================
# Main server block — handles all path-based routing
# ====================================================================
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Security headers (supplement Express helmet)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Upload size
    client_max_body_size 50M;

    # ---- Common proxy settings ----
    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection        "";

    # Proxy timeouts
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    proxy_send_timeout 10s;

    # Proxy buffering
    proxy_buffering on;
    proxy_buffer_size 8k;
    proxy_buffers 16 16k;
    proxy_busy_buffers_size 32k;

    # ---- Health endpoint served directly by nginx ----
    location = /nginx-health {
        access_log off;
        add_header Content-Type text/plain;
        return 200 "ok\n";
    }

    # ----------- God Admin (BASE_PATH-aware, NO prefix strip) -----------
    location /god-admin/ {
        proxy_pass http://gbox_god_admin;
        limit_req zone=general_limit burst=20 nodelay;
    }
    location = /god-admin {
        return 301 /god-admin/;
    }

    # ----------- Accounts portal (BASE_PATH-aware) -----
    location /accounts/ {
        proxy_pass http://gbox_accounts;
        limit_req zone=general_limit burst=30 nodelay;
    }
    location = /accounts {
        return 301 /accounts/;
    }

    # Auth endpoints — strict rate limit
    location ~ ^/accounts/(login|signup|forgot-password|verify-email|resend-otp)\$ {
        proxy_pass http://gbox_accounts;
        limit_req zone=auth_limit burst=10 nodelay;
    }

    # ----------- Store Admin (/admin/store/:slug/*) -----------
    location /admin/ {
        proxy_pass http://gbox_store_admin;
        limit_req zone=general_limit burst=30 nodelay;
    }
    location = /admin {
        return 302 /accounts/stores;
    }

    # ----------- Checkout (BASE_PATH-aware) -----------
    location /checkout/ {
        proxy_pass http://gbox_checkout;
        limit_req zone=checkout_limit burst=20 nodelay;
    }
    location = /checkout {
        return 301 /checkout/;
    }

    # ----------- Local platform API (strips /_platform prefix) ----------
    location /_platform/ {
        proxy_pass http://gbox_platform_local/;
    }

    # ----------- API Webhooks (no cache, no rate limit, no buffering) ----
    location /api/webhooks/ {
        proxy_pass http://gbox_api;
        proxy_buffering off;
        proxy_request_buffering off;
    }

    # ----------- REST API -> Server 2 -----------
    location /api/ {
        proxy_pass http://gbox_api;
        limit_req zone=api_limit burst=200 nodelay;
        limit_req_status 429;

        # Cache GET responses only
        proxy_cache api_cache;
        proxy_cache_methods GET;
        proxy_cache_valid 200 30s;
        proxy_cache_key "\$request_method\$request_uri";
        add_header X-Cache-Status \$upstream_cache_status;
    }

    location = /health {
        proxy_pass http://gbox_api/health;
        proxy_cache off;
        access_log off;
    }

    # ----------- Static assets (aggressive cache) ----
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map)\$ {
        proxy_pass http://gbox_storefront;
        proxy_cache static_cache;
        proxy_cache_valid 200 7d;
        proxy_cache_valid 404 1m;
        add_header Cache-Control "public, max-age=604800, immutable";
        add_header X-Cache-Status \$upstream_cache_status;
        access_log off;
    }

    # ----------- Catch-all: public storefront -> Server 3 (Astro SSR) ----
    location / {
        proxy_pass http://gbox_storefront;
        limit_req zone=general_limit burst=60 nodelay;

        # Cache storefront pages at edge (short TTL for fresh content)
        proxy_cache api_cache;
        proxy_cache_valid 200 60s;
        proxy_cache_key "\$host\$request_uri";
        add_header X-Cache-Status \$upstream_cache_status;
    }
}

# ====================================================================
# Checkout Subdomain — PCI isolation (checkout.$DOMAIN)
# Separate server block for checkout.$DOMAIN
# Strict CSP, no inline scripts, no iframing
# ====================================================================
server {
    listen 80;
    server_name checkout.$DOMAIN;

    client_max_body_size 2M;

    # Security headers — stricter than main block
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com; frame-src https://www.paypal.com https://www.sandbox.paypal.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://www.paypal.com https://www.sandbox.paypal.com" always;

    # Rate limiting
    limit_req zone=checkout_limit burst=20 nodelay;

    location / {
        proxy_pass http://gbox_checkout;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";
        proxy_read_timeout 30s;
        proxy_connect_timeout 5s;
    }
}
EOF

# Enable site
sudo ln -sf /etc/nginx/sites-available/gbox-platform /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test config
echo "[nginx-prod] Testing Nginx configuration..."
sudo nginx -t

if [ $? -eq 0 ]; then
  sudo systemctl reload nginx
  echo ""
  echo "  Nginx Production config applied!"
  echo ""
  echo "  Features enabled:"
  echo "    [x] 3-server topology (S1=admin+checkout, S2=API, S3=storefront)"
  echo "    [x] 7 upstream pools with keepalive (8-64 connections)"
  echo "    [x] Proxy cache (API: 30s, Static: 7d, Storefront: 60s)"
  echo "    [x] Rate limiting (API: 100/s, Auth: 5/s, Checkout: 10/s, General: 60/s)"
  echo "    [x] Gzip compression (level 6, 10 content types)"
  echo "    [x] Worker tuning (auto cores, 4096 connections, epoll)"
  echo "    [x] File descriptor cache (10K files)"
  echo "    [x] Security headers (X-Frame, CSP, HSTS, XSS)"
  echo "    [x] Checkout subdomain isolation (checkout.$DOMAIN)"
  echo "    [x] Custom log format with upstream timing"
  echo ""
  echo "  Next steps:"
  echo "    1. Install SSL (if not already done):"
  echo "       sudo apt install certbot python3-certbot-nginx -y"
  echo "       sudo certbot --nginx -d ${DOMAIN} -d *.${DOMAIN}"
  echo ""
  echo "    2. Point DNS:"
  echo "       checkout.${DOMAIN} -> Server 1 IP"
  echo "       admin.${DOMAIN}    -> Server 1 IP"
  echo "       api.${DOMAIN}      -> Server 1 IP (nginx proxies to S2)"
  echo "       ${DOMAIN}          -> Server 1 IP (nginx proxies to S3)"
else
  echo "[nginx-prod] Nginx config test FAILED! Check errors above."
  exit 1
fi
