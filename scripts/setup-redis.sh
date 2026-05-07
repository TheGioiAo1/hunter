#!/bin/bash
# ============================================
# Gbox Platform — Redis Setup
#
# Redis is used for:
# - Session caching (100x faster than DB lookup)
# - Rate limiting (shared across all processes)
# - Checkout session persistence (survives restarts)
# - API response caching (reduces DB load 80%)
# - CSRF token storage
# - OTP tracking
#
# Usage: sudo bash scripts/setup-redis.sh
# ============================================

set -e

echo "📦 Installing Redis..."
sudo apt-get update -qq
sudo apt-get install -y redis-server

echo "⚙️  Configuring Redis for Gbox Platform..."

# Backup original config
sudo cp /etc/redis/redis.conf /etc/redis/redis.conf.backup

# Apply production config
sudo tee /etc/redis/redis.conf > /dev/null << 'EOF'
# Gbox Platform — Redis Configuration
# Optimized for caching + session storage

# Network
bind 127.0.0.1
port 6379
protected-mode yes
tcp-backlog 511
tcp-keepalive 300
timeout 0

# Memory
maxmemory 512mb
maxmemory-policy allkeys-lru

# Persistence (RDB snapshots)
save 900 1
save 300 10
save 60 1000
stop-writes-on-bgsave-error yes
rdbcompression yes
rdbchecksum yes
dbfilename dump.rdb
dir /var/lib/redis

# AOF persistence (more durable)
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb

# Logging
loglevel notice
logfile /var/log/redis/redis-server.log

# Slow log
slowlog-log-slower-than 10000
slowlog-max-len 128

# Disable dangerous commands in production
rename-command FLUSHDB ""
rename-command FLUSHALL ""
rename-command DEBUG ""
EOF

# Enable and start
sudo systemctl enable redis-server
sudo systemctl restart redis-server

# Verify
sleep 1
REDIS_PING=$(redis-cli ping 2>/dev/null)
if [ "$REDIS_PING" = "PONG" ]; then
  echo ""
  echo "✅ Redis installed and running!"
  echo ""
  echo "📋 Configuration:"
  echo "   Address:    127.0.0.1:6379"
  echo "   Max Memory: 512MB"
  echo "   Policy:     allkeys-lru (evict least recently used)"
  echo "   Persistence: RDB + AOF"
  echo ""
  echo "🔧 Add to .env:"
  echo "   REDIS_URL=redis://localhost:6379"
  echo ""
  echo "📊 Monitor Redis:"
  echo "   redis-cli info memory"
  echo "   redis-cli info stats"
  echo "   redis-cli monitor"
else
  echo "❌ Redis failed to start! Check: sudo systemctl status redis-server"
  exit 1
fi
