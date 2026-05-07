#!/bin/bash
# ============================================
# Gbox Platform — PostgreSQL Performance Tuning
#
# Optimized for: 8GB RAM server, SSD storage, 100K RPS target
#
# Usage: sudo bash scripts/setup-postgresql-tuning.sh
# ============================================

set -e

# Detect PostgreSQL version
PG_VERSION=$(pg_config --version 2>/dev/null | grep -oP '\d+' | head -1)
PG_CONF="/etc/postgresql/${PG_VERSION}/main/postgresql.conf"

if [ ! -f "$PG_CONF" ]; then
  echo "❌ PostgreSQL config not found at $PG_CONF"
  echo "   Trying alternative paths..."
  PG_CONF=$(find /etc/postgresql -name postgresql.conf 2>/dev/null | head -1)
  if [ -z "$PG_CONF" ]; then
    echo "❌ Cannot find postgresql.conf. Please set PG_CONF manually."
    exit 1
  fi
fi

echo "📦 Tuning PostgreSQL: $PG_CONF"

# Detect available RAM
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
echo "   System RAM: ${TOTAL_RAM_MB}MB"

# Calculate optimal values
SHARED_BUFFERS=$((TOTAL_RAM_MB / 4))  # 25% of RAM
EFFECTIVE_CACHE=$((TOTAL_RAM_MB * 3 / 4))  # 75% of RAM
WORK_MEM=16  # MB - per-operation sort memory
MAINT_WORK_MEM=$((TOTAL_RAM_MB / 16))  # ~6% for vacuum/index

# Backup original config
sudo cp "$PG_CONF" "${PG_CONF}.backup.$(date +%Y%m%d)"

# Apply tuning
sudo tee -a "$PG_CONF" > /dev/null << EOF

# ============================================
# Gbox Platform Performance Tuning
# Applied: $(date)
# Server RAM: ${TOTAL_RAM_MB}MB
# ============================================

# --- Memory ---
# shared_buffers: Main PostgreSQL cache. 25% of RAM is the sweet spot.
# Too low = frequent disk reads. Too high = wastes memory for OS cache.
shared_buffers = ${SHARED_BUFFERS}MB

# effective_cache_size: Hint to query planner about total available cache
# (shared_buffers + OS file cache). 75% of RAM.
effective_cache_size = ${EFFECTIVE_CACHE}MB

# work_mem: Memory per sort/hash operation. Higher = fewer disk sorts.
# Careful: each query can use multiple sort operations.
# 16MB × 50 concurrent sorts = 800MB peak.
work_mem = ${WORK_MEM}MB

# maintenance_work_mem: Memory for VACUUM, CREATE INDEX, etc.
# Higher = faster maintenance operations.
maintenance_work_mem = ${MAINT_WORK_MEM}MB

# --- WAL & Checkpoint ---
# wal_buffers: WAL write buffer. 64MB handles high write throughput.
wal_buffers = 64MB

# checkpoint_completion_target: Spread checkpoint writes over 90% of interval.
# Prevents I/O spikes during checkpoints.
checkpoint_completion_target = 0.9

# max_wal_size: Maximum WAL size before forced checkpoint.
# Larger = less frequent checkpoints = smoother I/O.
max_wal_size = 2GB

# --- Connections ---
# max_connections: PgBouncer handles pooling, so PostgreSQL needs fewer.
# 200 real connections is plenty when PgBouncer multiplexes.
max_connections = 200

# --- Query Planner (SSD Optimized) ---
# random_page_cost: SSD random reads are nearly as fast as sequential.
# Default 4.0 (HDD). Set 1.1 for SSD to encourage index scans.
random_page_cost = 1.1

# effective_io_concurrency: Number of concurrent disk I/O operations.
# SSD can handle 200+ concurrent reads (HDD: 2-4).
effective_io_concurrency = 200

# --- Parallel Query ---
# max_parallel_workers_per_gather: Workers per parallel query node.
# Speeds up large sequential scans and aggregations.
max_parallel_workers_per_gather = 4

# max_parallel_workers: Total parallel workers across all queries.
max_parallel_workers = 8

# max_parallel_maintenance_workers: Workers for CREATE INDEX, VACUUM.
max_parallel_maintenance_workers = 4

# --- Logging ---
# Log queries slower than 500ms for debugging.
log_min_duration_statement = 500

# Log checkpoint activity.
log_checkpoints = on

# Log connection activity (disabled for performance).
log_connections = off
log_disconnections = off

# --- Autovacuum Tuning ---
# More aggressive autovacuum for high-write tables (orders, sessions).
autovacuum_max_workers = 4
autovacuum_naptime = 30s
autovacuum_vacuum_threshold = 50
autovacuum_analyze_threshold = 50
autovacuum_vacuum_scale_factor = 0.05
autovacuum_analyze_scale_factor = 0.05
EOF

echo ""
echo "✅ PostgreSQL tuned for ${TOTAL_RAM_MB}MB RAM server"
echo ""
echo "📋 Applied settings:"
echo "   shared_buffers:     ${SHARED_BUFFERS}MB (25% RAM)"
echo "   effective_cache:    ${EFFECTIVE_CACHE}MB (75% RAM)"
echo "   work_mem:           ${WORK_MEM}MB"
echo "   max_connections:    200"
echo "   random_page_cost:   1.1 (SSD)"
echo "   parallel_workers:   8"
echo ""
echo "🔄 Restart PostgreSQL to apply:"
echo "   sudo systemctl restart postgresql"
echo ""
echo "📊 Verify settings:"
echo "   psql -U gbox -d gbox_platform -c \"SHOW shared_buffers;\""
echo "   psql -U gbox -d gbox_platform -c \"SHOW effective_cache_size;\""
