#!/bin/bash
# ============================================
# Gbox Platform — VPS Deployment Script
# Run this ON THE VPS after cloning the repo
# ============================================

set -e

echo "🚀 Gbox Platform Deployment Starting..."

# Check required env vars
if [ -z "$DATABASE_URL" ]; then
  echo "❌ ERROR: DATABASE_URL not set. Run: export DATABASE_URL=postgresql://gbox:password@localhost:5432/gbox_platform"
  exit 1
fi

# 1. Install dependencies
echo "📦 Installing dependencies..."
npm install

# 2. Run database migrations
echo "🗄️ Running database migrations..."
cd packages/db
npx tsx src/migrations/run.ts
cd ../..

# 3. Build the project
echo "🔨 Building Gbox Platform..."
npm run build

# 4. Setup PM2 ecosystem
echo "⚙️ Setting up PM2..."
pm2 delete gbox-platform 2>/dev/null || true
pm2 start dist/server/entry.mjs --name gbox-platform \
  --env production \
  --max-memory-restart 512M \
  --log-date-format "YYYY-MM-DD HH:mm:ss" \
  -i max

# 5. Save PM2 config for auto-restart
pm2 save
pm2 startup systemd -u $(whoami) --hp $(eval echo ~$(whoami)) 2>/dev/null || true

echo ""
echo "✅ Gbox Platform deployed successfully!"
echo "🌐 Running on http://localhost:4321"
echo "📊 PM2 status: pm2 status"
echo "📝 Logs: pm2 logs gbox-platform"
