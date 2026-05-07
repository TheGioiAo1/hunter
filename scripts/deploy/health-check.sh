#!/usr/bin/env bash
#
# Gbox Platform — Comprehensive Health Check
# Run from the control box (or any machine with LAN access to 192.168.1.0/24).
# Exits 0 if all checks pass, 1 if any failed.
#
# Usage:
#   bash scripts/deploy/health-check.sh           # full check
#   bash scripts/deploy/health-check.sh --quick    # nginx + API only
#
set -uo pipefail

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
else
  C_RESET=""; C_GREEN=""; C_RED=""; C_YELLOW=""; C_BOLD=""; C_DIM=""
fi

S1="${GBOX_S1_HOST:-192.168.1.13}"
S2="${GBOX_S2_HOST:-192.168.1.30}"
S3="${GBOX_S3_HOST:-192.168.1.19}"

FAILED=0
TOTAL=0
QUICK="${1:-}"

check() {
  local label="$1" url="$2" expected="$3"
  TOTAL=$((TOTAL + 1))
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "$expected" ]]; then
    printf "  %s✓%s %-55s %s%s%s\n" "$C_GREEN" "$C_RESET" "$label" "$C_DIM" "$code" "$C_RESET"
  else
    printf "  %s✗%s %-55s %s (expected %s)\n" "$C_RED" "$C_RESET" "$label" "$code" "$expected"
    FAILED=$((FAILED + 1))
  fi
}

check_tcp() {
  local label="$1" host="$2" port="$3"
  TOTAL=$((TOTAL + 1))
  if timeout 3 bash -c "echo >/dev/tcp/$host/$port" 2>/dev/null; then
    printf "  %s✓%s %-55s %sport %s%s\n" "$C_GREEN" "$C_RESET" "$label" "$C_DIM" "$port" "$C_RESET"
  else
    printf "  %s✗%s %-55s %sport %s unreachable%s\n" "$C_RED" "$C_RESET" "$label" "$C_RED" "$port" "$C_RESET"
    FAILED=$((FAILED + 1))
  fi
}

echo "${C_BOLD}Gbox Platform — Health Check${C_RESET}"
echo "${C_DIM}Timestamp: $(date '+%Y-%m-%d %H:%M:%S %Z')${C_RESET}"
echo

# =========================================================================
# Server 1 — Nginx entry point + Admin apps + Checkout
# =========================================================================
echo "${C_BOLD}[Server 1 — nginx entry point @ $S1]${C_RESET}"
check "nginx health"                "http://$S1/nginx-health"          "200"
check "/god-admin/login"            "http://$S1/god-admin/login"       "200"
check "/accounts/login"             "http://$S1/accounts/login"        "200"
check "/admin (→ /accounts/stores)" "http://$S1/admin"                 "302"
check "/checkout/"                  "http://$S1/checkout/"             "200"
check "/api/2026-04/shop.json"      "http://$S1/api/2026-04/shop.json" "200"
check "/health (→ server 2)"        "http://$S1/health"                "200"
check "/ (catch-all → storefront)"  "http://$S1/"                      "200"

if [[ "$QUICK" != "--quick" ]]; then
  echo
  echo "${C_BOLD}[Server 1 — direct PM2 ports]${C_RESET}"
  check_tcp "gbox-api (local)"        "$S1" "4321"
  check_tcp "gbox-accounts"           "$S1" "4323"
  check_tcp "gbox-god-admin"          "$S1" "4324"
  check_tcp "gbox-store-admin"        "$S1" "4325"
  check_tcp "gbox-checkout"           "$S1" "4327"

  echo
  echo "${C_BOLD}[Server 1 — infrastructure services]${C_RESET}"
  check_tcp "PostgreSQL"              "$S1" "5432"
  check_tcp "Redis"                   "$S1" "6379"
fi

# =========================================================================
# Server 2 — REST API
# =========================================================================
echo
echo "${C_BOLD}[Server 2 — REST API @ $S2]${C_RESET}"
check "gbox-api /health"            "http://$S2:4321/health"           "200"

if [[ "$QUICK" != "--quick" ]]; then
  check_tcp "gbox-api (direct)"       "$S2" "4321"
fi

# =========================================================================
# Server 3 — Public Storefront
# =========================================================================
echo
echo "${C_BOLD}[Server 3 — storefront @ $S3]${C_RESET}"
check "gbox-storefront /health"     "http://$S3:4321/health"           "200"
check "gbox-storefront /"           "http://$S3:4321/"                 "200"

if [[ "$QUICK" != "--quick" ]]; then
  check_tcp "gbox-storefront (direct)" "$S3" "4321"
fi

# =========================================================================
# Checkout subdomain (via Host header — works even without real DNS)
# =========================================================================
if [[ "$QUICK" != "--quick" ]]; then
  echo
  echo "${C_BOLD}[Checkout subdomain — via Host header]${C_RESET}"
  TOTAL=$((TOTAL + 1))
  CHECKOUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    -H "Host: checkout.gbox.co" "http://$S1/" 2>/dev/null || echo "000")
  if [[ "$CHECKOUT_CODE" == "200" || "$CHECKOUT_CODE" == "302" ]]; then
    printf "  %s✓%s %-55s %s%s%s\n" "$C_GREEN" "$C_RESET" "checkout subdomain (Host header)" "$C_DIM" "$CHECKOUT_CODE" "$C_RESET"
  else
    printf "  %s✗%s %-55s %s (expected 200/302)\n" "$C_RED" "$C_RESET" "checkout subdomain (Host header)" "$CHECKOUT_CODE"
    FAILED=$((FAILED + 1))
  fi
fi

# =========================================================================
# Summary
# =========================================================================
echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "${C_GREEN}${C_BOLD}All $TOTAL checks passed.${C_RESET}"
  exit 0
else
  PASSED=$((TOTAL - FAILED))
  echo "${C_RED}${C_BOLD}$FAILED / $TOTAL checks failed (${PASSED} passed).${C_RESET}"
  echo "${C_YELLOW}Hint: run 'pm2 logs' on the failing server, or re-run bootstrap with --update.${C_RESET}"
  exit 1
fi
