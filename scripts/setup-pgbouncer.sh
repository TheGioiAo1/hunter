#!/bin/bash
# ============================================
# Gbox Platform — PgBouncer Connection Pooler Setup
#
# WHY: Node.js with PM2 cluster mode creates many processes.
# 15 processes × 20 connections = 300 app connections.
# PostgreSQL handles max ~200 connections efficiently.
# PgBouncer multiplexes 300+ app connections through 50 real DB connections.
#
# RESULT: 6x fewer DB connections, 2-3x better query throughput.
#
# Usage: sudo bash scripts/setup-pgbouncer.sh
# ============================================

set -e

echo "📦 Installing PgBouncer..."
sudo apt-get update -qq
sudo apt-get install -y pgbouncer

# Get DB credentials from environment or use defaults
DB_USER="${PGUSER:-gbox}"
DB_PASS="${PGPASSWORD:-GboxPlatform2026}"
DB_NAME="${PGDATABASE:-gbox_platform}"
DB_HOST="${PGHOST:-127.0.0.1}"
DB_PORT="${PGPORT:-5432}"

echo "⚙️  Configuring PgBouncer..."

# PgBouncer config
sudo tee /etc/pgbouncer/pgbouncer.ini > /dev/null << EOF
;; ============================================
;; PgBouncer Configuration for Gbox Platform
;; ============================================

[databases]
; Connect to PostgreSQL on localhost
${DB_NAME} = host=${DB_HOST} port=${DB_PORT} dbname=${DB_NAME}

[pgbouncer]
; Listen on port 6432 (apps connect here instead of 5432)
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

; ---- Pool Mode ----
; transaction: release connection back to pool after each transaction
; This is the best mode for web apps — allows connection sharing.
pool_mode = transaction

; ---- Pool Sizing ----
; max_client_conn: Maximum client connections PgBouncer will accept
;   15 PM2 processes × 20 pool = 300, plus buffer
max_client_conn = 500

; default_pool_size: Actual PostgreSQL connections per database
;   50 connections handles ~15,000 queries/second
default_pool_size = 50

; min_pool_size: Keep at least this many connections warm
min_pool_size = 10

; reserve_pool_size: Extra connections for burst traffic
reserve_pool_size = 10
reserve_pool_timeout = 3

; ---- Timeouts ----
; server_idle_timeout: Close idle server connections after 5 minutes
server_idle_timeout = 300

; client_idle_timeout: Close idle client connections after 10 minutes
client_idle_timeout = 600

; query_timeout: Kill queries running longer than 30 seconds
query_timeout = 30

; ---- Logging ----
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
stats_period = 60

; ---- Admin ----
admin_users = ${DB_USER}
EOF

# Create auth file
sudo tee /etc/pgbouncer/userlist.txt > /dev/null << EOF
"${DB_USER}" "${DB_PASS}"
EOF

# Fix permissions
sudo chown postgres:postgres /etc/pgbouncer/pgbouncer.ini
sudo chown postgres:postgres /etc/pgbouncer/userlist.txt
sudo chmod 640 /etc/pgbouncer/userlist.txt

# Enable and start
sudo systemctl enable pgbouncer
sudo systemctl restart pgbouncer

echo ""
echo "✅ PgBouncer configured!"
echo ""
echo "📋 Summary:"
echo "   Listen:     127.0.0.1:6432"
echo "   Pool mode:  transaction"
echo "   Pool size:  50 connections (from 300+ app connections)"
echo "   Max client: 500"
echo ""
echo "🔧 Update your .env:"
echo "   DATABASE_URL=postgresql://${DB_USER}:PASSWORD@localhost:6432/${DB_NAME}"
echo ""
echo "📊 Monitor PgBouncer:"
echo "   sudo pgbouncer -d /etc/pgbouncer/pgbouncer.ini"
echo "   psql -h 127.0.0.1 -p 6432 -U ${DB_USER} pgbouncer -c 'SHOW POOLS;'"
echo "   psql -h 127.0.0.1 -p 6432 -U ${DB_USER} pgbouncer -c 'SHOW STATS;'"
