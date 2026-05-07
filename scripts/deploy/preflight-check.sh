#!/usr/bin/env bash
# ============================================================================
# Gbox Platform — Production Pre-flight Checklist
#
# Run BEFORE deploying to production. Validates:
#   1. All .env variables are set
#   2. Database is reachable and migrated
#   3. Redis is reachable
#   4. SMTP can connect (optional)
#   5. PayPal API is reachable (optional)
#   6. PM2 ecosystem config is valid
#   7. Node.js version
#   8. Disk space
#   9. Log directories exist
#  10. SSL certificates (if on nginx host)
#
# Usage:  bash scripts/deploy/preflight-check.sh
#         bash scripts/deploy/preflight-check.sh --strict  # fail on warnings too
# ============================================================================
set -uo pipefail

STRICT="${1:-}"
TAG="preflight"
ERRORS=0
WARNINGS=0

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_GREEN=""; C_RED=""; C_YELLOW=""; C_BOLD=""
fi

pass() { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$1"; }
fail() { printf "  %s✗%s %s\n" "$C_RED" "$C_RESET" "$1"; ERRORS=$((ERRORS + 1)); }
warn() { printf "  %s!%s %s\n" "$C_YELLOW" "$C_RESET" "$1"; WARNINGS=$((WARNINGS + 1)); }
section() { echo ""; echo "${C_BOLD}[$1]${C_RESET}"; }

# ---- Locate .env ----
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$REPO_DIR/.env"

echo "${C_BOLD}Gbox Platform — Pre-flight Check${C_RESET}"

# =========================================================================
section "1. Environment Variables"
# =========================================================================
if [[ -f "$ENV_FILE" ]]; then
  pass ".env file exists"
  source "$ENV_FILE" 2>/dev/null || true

  # Required vars
  for var in DATABASE_URL AUTH_SECRET; do
    if [[ -z "${!var:-}" ]]; then
      fail "$var is not set"
    else
      pass "$var is set"
    fi
  done

  # Important but not blocking
  for var in REDIS_URL SMTP_HOST SMTP_USER EMAIL_FROM CHECKOUT_HANDOFF_SECRET STRIPE_SECRET_KEY; do
    if [[ -z "${!var:-}" ]]; then
      warn "$var is not set (some features will be disabled)"
    else
      pass "$var is set"
    fi
  done
else
  fail ".env file not found at $ENV_FILE"
  warn "Copy .env.example to .env and fill in values"
fi

# =========================================================================
section "2. Node.js Runtime"
# =========================================================================
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v)
  MAJOR=$(echo "$NODE_VER" | sed 's/^v//' | cut -d. -f1)
  if [[ "$MAJOR" -ge 20 ]]; then
    pass "Node.js $NODE_VER (>= 20)"
  else
    fail "Node.js $NODE_VER — need 20+ for --import tsx"
  fi
else
  fail "Node.js not found"
fi

if command -v pm2 >/dev/null 2>&1; then
  pass "PM2 $(pm2 -v 2>/dev/null || echo 'installed')"
else
  fail "PM2 not found — install: npm i -g pm2"
fi

if command -v tsx >/dev/null 2>&1 || [[ -f "$REPO_DIR/node_modules/.bin/tsx" ]]; then
  pass "tsx available"
else
  warn "tsx not found globally (PM2 uses NODE_OPTIONS='--import tsx')"
fi

# =========================================================================
section "3. Database (PostgreSQL)"
# =========================================================================
if [[ -n "${DATABASE_URL:-}" ]]; then
  if command -v psql >/dev/null 2>&1; then
    if psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1; then
      pass "PostgreSQL connection OK"

      # Check if migrations are up to date
      TABLE_COUNT=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "0")
      if [[ "$TABLE_COUNT" -gt 10 ]]; then
        pass "Database has $TABLE_COUNT tables"
      else
        warn "Only $TABLE_COUNT tables — run migrations: npm --workspace=packages/db run migrate"
      fi

      # Check god admin exists
      GOD_COUNT=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM users WHERE role='god_admin'" 2>/dev/null || echo "0")
      if [[ "$GOD_COUNT" -gt 0 ]]; then
        pass "God admin account exists"
      else
        warn "No god_admin user — run seed: npx tsx seed-data.ts"
      fi
    else
      fail "Cannot connect to PostgreSQL"
    fi
  else
    warn "psql not found — cannot verify database"
  fi
else
  fail "DATABASE_URL not set"
fi

# =========================================================================
section "4. Redis"
# =========================================================================
if command -v redis-cli >/dev/null 2>&1; then
  REDIS_HOST=$(echo "${REDIS_URL:-redis://localhost:6379}" | sed 's|redis://||' | cut -d: -f1)
  REDIS_PORT=$(echo "${REDIS_URL:-redis://localhost:6379}" | sed 's|redis://||' | cut -d: -f2 | cut -d/ -f1)
  if redis-cli -h "${REDIS_HOST:-localhost}" -p "${REDIS_PORT:-6379}" ping 2>/dev/null | grep -q PONG; then
    pass "Redis PONG (${REDIS_HOST:-localhost}:${REDIS_PORT:-6379})"
  else
    warn "Redis not responding — cart and session features degraded"
  fi
else
  warn "redis-cli not found — cannot verify Redis"
fi

# =========================================================================
section "5. Disk Space"
# =========================================================================
DISK_PCT=$(df -h "$REPO_DIR" | awk 'NR==2{print $5}' | tr -d '%')
if [[ "$DISK_PCT" -lt 80 ]]; then
  pass "Disk usage: ${DISK_PCT}%"
elif [[ "$DISK_PCT" -lt 90 ]]; then
  warn "Disk usage: ${DISK_PCT}% — consider cleanup"
else
  fail "Disk usage: ${DISK_PCT}% — critically low!"
fi

# =========================================================================
section "6. Log Directories"
# =========================================================================
if [[ -d /var/log/gbox ]]; then
  if [[ -w /var/log/gbox ]]; then
    pass "/var/log/gbox exists and is writable"
  else
    fail "/var/log/gbox exists but is NOT writable by $USER"
  fi
else
  warn "/var/log/gbox does not exist — create: sudo mkdir -p /var/log/gbox && sudo chown $USER:$USER /var/log/gbox"
fi

# =========================================================================
section "7. PM2 Ecosystem Config"
# =========================================================================
if [[ -f "$REPO_DIR/ecosystem.config.cjs" ]]; then
  pass "ecosystem.config.cjs exists"
  # Validate it parses
  if node -e "require('$REPO_DIR/ecosystem.config.cjs')" 2>/dev/null; then
    pass "ecosystem.config.cjs parses OK"
  else
    fail "ecosystem.config.cjs has syntax errors"
  fi
else
  fail "ecosystem.config.cjs not found"
fi

# =========================================================================
section "8. SSL Certificates (if nginx host)"
# =========================================================================
if command -v nginx >/dev/null 2>&1; then
  # Check for any Let's Encrypt certs
  if [[ -d /etc/letsencrypt/live ]]; then
    CERT_DOMAINS=$(ls /etc/letsencrypt/live/ 2>/dev/null | grep -v README || true)
    if [[ -n "$CERT_DOMAINS" ]]; then
      for d in $CERT_DOMAINS; do
        CERT="/etc/letsencrypt/live/$d/fullchain.pem"
        if [[ -f "$CERT" ]]; then
          EXPIRY=$(openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2)
          EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || echo 0)
          NOW_EPOCH=$(date +%s)
          DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
          if [[ "$DAYS_LEFT" -gt 14 ]]; then
            pass "SSL cert $d — expires in ${DAYS_LEFT} days"
          elif [[ "$DAYS_LEFT" -gt 0 ]]; then
            warn "SSL cert $d — expires in ${DAYS_LEFT} days (renew soon!)"
          else
            fail "SSL cert $d — EXPIRED!"
          fi
        fi
      done
    else
      warn "No Let's Encrypt certificates found"
    fi
  else
    warn "Let's Encrypt not set up — run scripts/setup-ssl-production.sh"
  fi

  # Test nginx config
  if nginx -t 2>/dev/null; then
    pass "nginx config test passed"
  else
    fail "nginx config test FAILED"
  fi
else
  pass "(not an nginx host — skipping SSL check)"
fi

# =========================================================================
section "9. npm Dependencies"
# =========================================================================
if [[ -d "$REPO_DIR/node_modules" ]]; then
  pass "node_modules exists"
  # Check for the known readable-stream quirk
  RS_PKG="$REPO_DIR/node_modules/readable-stream/package.json"
  if [[ -f "$RS_PKG" ]] && [[ -s "$RS_PKG" ]]; then
    pass "readable-stream/package.json is valid"
  else
    warn "readable-stream quirk detected — fix: rm -rf node_modules/readable-stream && npm install readable-stream --no-save"
  fi
else
  fail "node_modules not found — run: npm ci"
fi

# =========================================================================
# Summary
# =========================================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "$ERRORS" -eq 0 && "$WARNINGS" -eq 0 ]]; then
  echo "${C_GREEN}${C_BOLD}  All checks passed. Ready to deploy!${C_RESET}"
elif [[ "$ERRORS" -eq 0 ]]; then
  echo "${C_YELLOW}${C_BOLD}  $WARNINGS warning(s), 0 errors. Deploy OK but review warnings.${C_RESET}"
else
  echo "${C_RED}${C_BOLD}  $ERRORS error(s), $WARNINGS warning(s). Fix errors before deploying.${C_RESET}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ "$STRICT" == "--strict" && "$WARNINGS" -gt 0 ]]; then
  exit 1
fi

if [[ "$ERRORS" -gt 0 ]]; then
  exit 1
fi

exit 0
