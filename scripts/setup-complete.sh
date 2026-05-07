#!/bin/bash
# ============================================
# Gbox Platform — Complete VPS Setup
# ONE SCRIPT to rule them all
# Usage: bash scripts/setup-complete.sh yourdomain.com
# ============================================

set -e

DOMAIN=${1:-"gbox.co"}

echo "================================================"
echo "  GBOX PLATFORM v4 — Complete Setup"
echo "  Domain: $DOMAIN"
echo "================================================"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ .env file not found!"
  echo "📝 Create it from .env.example first:"
  echo "   cp .env.example .env"
  echo "   nano .env  # fill in DATABASE_URL, AUTH_SECRET, etc."
  exit 1
fi

# Load env vars
export $(grep -v '^#' .env | xargs)

# Step 1: Install deps
echo "📦 Step 1/6: Installing dependencies..."
npm install

# Step 2: Run migrations
echo "🗄️ Step 2/6: Running database migrations..."
cd packages/db && npx tsx src/migrations/run.ts && cd ../..

# Step 3: Build
echo "🔨 Step 3/6: Building project..."
npm run build

# Step 4: Start with PM2
echo "⚙️ Step 4/6: Starting with PM2..."
pm2 delete gbox-platform 2>/dev/null || true
pm2 start dist/server/entry.mjs \
  --name gbox-platform \
  --max-memory-restart 512M \
  -i max
pm2 save

# Step 5: Setup Nginx
echo "🌐 Step 5/6: Configuring Nginx..."
sudo bash scripts/setup-nginx.sh $DOMAIN

# Step 6: SSL Certificate
echo "🔒 Step 6/6: Installing SSL..."
sudo apt install certbot python3-certbot-nginx -y 2>/dev/null || true
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN 2>/dev/null || echo "⚠️ SSL setup skipped (run manually: sudo certbot --nginx -d $DOMAIN)"

echo ""
echo "================================================"
echo "  ✅ GBOX PLATFORM DEPLOYED SUCCESSFULLY!"
echo "================================================"
echo ""
echo "  🌐 Storefront: https://$DOMAIN"
echo "  👨‍💼 Admin:      https://$DOMAIN/_emdash/admin"
echo "  📡 API:        https://$DOMAIN/api/2026-04/shop.json"
echo "  📊 PM2:        pm2 status / pm2 logs gbox-platform"
echo ""
echo "  First time? Visit https://$DOMAIN/_emdash/admin"
echo "  to create your admin account."
echo ""
