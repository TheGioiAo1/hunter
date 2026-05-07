#!/usr/bin/env bash
# Step 2.8 — append apps/checkout env vars to ~/gbox-platform/.env
# Idempotent: only appends if CHECKOUT_PORT not already present.
set -euo pipefail
cd ~/gbox-platform
if grep -q '^CHECKOUT_PORT=' .env; then
  echo "[setup] CHECKOUT_PORT already set — skipping append"
else
  cat >> .env <<'ENV'

# apps/checkout (Decision #2 Step 2.8)
CHECKOUT_PORT=4327
CHECKOUT_BASE_URL=https://checkout.gbox.co
PLATFORM_API_BASE_URL=http://127.0.0.1:4321
CUSTOMER_COOKIE_DOMAIN=.gbox.co
ENV
  echo "[setup] appended checkout env block"
fi
echo "---current checkout env---"
grep -E '^(CHECKOUT_|PLATFORM_API_BASE_URL|CUSTOMER_COOKIE_DOMAIN)=' .env || echo NONE
