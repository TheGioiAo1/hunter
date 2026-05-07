#!/usr/bin/env bash
# ============================================================================
# Gbox Platform — Production Status Dashboard
#
# Quick view of all services, resources, and metrics.
# Run on Server 1 (the nginx/control box).
#
# Usage:  bash scripts/deploy/status.sh
# ============================================================================
set -uo pipefail

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_GREEN=""; C_RED=""; C_YELLOW=""; C_BOLD=""; C_DIM=""; C_CYAN=""
fi

section() { echo ""; echo "${C_BOLD}${C_CYAN}=== $1 ===${C_RESET}"; }

echo "${C_BOLD}Gbox Platform — Status Dashboard${C_RESET}"
echo "${C_DIM}$(date '+%Y-%m-%d %H:%M:%S %Z')${C_RESET}"

# ---- PM2 Processes ----
section "PM2 Processes"
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    if(!d.length){console.log('  No processes running');process.exit();}
    const pad=(s,n)=>String(s).padEnd(n);
    console.log('  '+pad('Name',22)+pad('Status',12)+pad('CPU',8)+pad('Mem',10)+pad('Uptime',15)+'Restarts');
    console.log('  '+'-'.repeat(75));
    d.forEach(p=>{
      const s=p.pm2_env;
      const mem=Math.round((s.axm_monitor?.['Heap Size']?.value||p.monit?.memory||0)/1024/1024);
      const cpu=p.monit?.cpu||0;
      const up=s.pm_uptime?Math.round((Date.now()-s.pm_uptime)/60000)+'m':'?';
      const st=s.status==='online'?'\x1b[32m'+s.status+'\x1b[0m':'\x1b[31m'+s.status+'\x1b[0m';
      console.log('  '+pad(p.name,22)+pad(st,21)+pad(cpu+'%',8)+pad(mem+'MB',10)+pad(up,15)+s.restart_time);
    });
  " 2>/dev/null || pm2 list
else
  echo "  PM2 not installed"
fi

# ---- System Resources ----
section "System Resources"
echo "  CPU:    $(grep 'cpu ' /proc/stat 2>/dev/null | awk '{usage=($2+$4)*100/($2+$4+$5); printf "%.1f%%", usage}' || echo 'N/A')"
echo "  Memory: $(free -m 2>/dev/null | awk 'NR==2{printf "%dMB / %dMB (%.1f%%)", $3, $2, $3*100/$2}' || echo 'N/A')"
echo "  Disk:   $(df -h / 2>/dev/null | awk 'NR==2{printf "%s / %s (%s)", $3, $2, $5}' || echo 'N/A')"
echo "  Load:   $(cat /proc/loadavg 2>/dev/null | awk '{printf "%s %s %s", $1, $2, $3}' || echo 'N/A')"

# ---- Database ----
section "PostgreSQL"
DB_URL="${DATABASE_URL:-postgresql://gbox@localhost:5432/gbox_platform}"
if command -v psql >/dev/null 2>&1; then
  CONN_COUNT=$(psql "$DB_URL" -tAc "SELECT COUNT(*) FROM pg_stat_activity WHERE datname='gbox_platform'" 2>/dev/null || echo "?")
  DB_SIZE=$(psql "$DB_URL" -tAc "SELECT pg_size_pretty(pg_database_size('gbox_platform'))" 2>/dev/null || echo "?")
  SHOP_COUNT=$(psql "$DB_URL" -tAc "SELECT COUNT(*) FROM shops" 2>/dev/null || echo "?")
  ORDER_COUNT=$(psql "$DB_URL" -tAc "SELECT COUNT(*) FROM orders" 2>/dev/null || echo "?")
  echo "  Connections: $CONN_COUNT active"
  echo "  DB Size:     $DB_SIZE"
  echo "  Shops:       $SHOP_COUNT"
  echo "  Orders:      $ORDER_COUNT"
else
  echo "  psql not available"
fi

# ---- Redis ----
section "Redis"
if command -v redis-cli >/dev/null 2>&1; then
  REDIS_INFO=$(redis-cli info memory 2>/dev/null || echo "")
  REDIS_MEM=$(echo "$REDIS_INFO" | grep "used_memory_human:" | cut -d: -f2 | tr -d '[:space:]' || echo "?")
  REDIS_KEYS=$(redis-cli dbsize 2>/dev/null | awk '{print $2}' || echo "?")
  echo "  Memory:  $REDIS_MEM"
  echo "  Keys:    $REDIS_KEYS"
else
  echo "  redis-cli not available"
fi

# ---- Nginx ----
section "Nginx"
if command -v nginx >/dev/null 2>&1; then
  if systemctl is-active --quiet nginx 2>/dev/null; then
    echo "  Status: ${C_GREEN}running${C_RESET}"
  else
    echo "  Status: ${C_RED}stopped${C_RESET}"
  fi
  NGINX_CONNS=$(ss -s 2>/dev/null | grep "TCP:" | head -1 || echo "")
  echo "  TCP:    $NGINX_CONNS"
else
  echo "  (not an nginx host)"
fi

# ---- Recent Errors ----
section "Recent Errors (last 10 min)"
LOG_DIR="/var/log/gbox"
if [[ -d "$LOG_DIR" ]]; then
  ERRORS=0
  for f in "$LOG_DIR"/*-error.log; do
    if [[ -f "$f" ]]; then
      RECENT=$(find "$f" -mmin -10 -size +0c 2>/dev/null)
      if [[ -n "$RECENT" ]]; then
        COUNT=$(tail -50 "$f" | grep -c "ERROR\|error\|Error" 2>/dev/null || echo 0)
        if [[ "$COUNT" -gt 0 ]]; then
          echo "  ${C_RED}$(basename "$f"):${C_RESET} $COUNT error(s)"
          ERRORS=$((ERRORS + COUNT))
        fi
      fi
    fi
  done
  if [[ "$ERRORS" -eq 0 ]]; then
    echo "  ${C_GREEN}No recent errors${C_RESET}"
  fi
else
  echo "  Log directory not found"
fi

echo ""
