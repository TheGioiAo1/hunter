#!/usr/bin/env bash
# Gbox Platform — Scaling Target Runner (Phase 3E + 3F)
#
# Chains the three legacy k6 scripts + the new target-scale.js
# harness against a single environment, printing a unified PASS /
# FAIL summary at the end. Designed to be the one command a
# release engineer runs before flipping production to a new build.
#
# Phase 3F extends the runner with a `TIER` env var so the same
# pipeline exercises the 100K, 1M or 10M orders/month design targets
# without editing the script. Default tier is `100k` for backwards
# compatibility with the Phase 3E contract.
#
#   TIER=1m ./scripts/load/run-100k-target.sh peak http://192.168.1.13:4326 demo.gbox.co
#
# Arguments:
#   $1  profile name (smoke | baseline | peak | flash | sustain)
#       defaults to `smoke` so running with no args is always safe.
#   $2  BASE_URL                — storefront origin. Default localhost.
#   $3  SHOP_HOST               — tenant routing host. Default demo.gbox.co.
#
# Tier env var:
#   TIER — 100k (default) | 1m | 10m
#          Fed to target-scale.js as -e TIER=... The legacy
#          storefront-browse / checkout-flow / assets-cdn scripts
#          are NOT tier-aware; they always run their own canonical
#          scenario (mapped below).
#
# Env overrides (same as every other script in this dir):
#   PRODUCT_HANDLES    — comma-separated product slugs
#   COLLECTION_HANDLES — comma-separated collection slugs
#   VARIANT_IDS        — comma-separated variant ids for cart-add
#
# Exit code is 0 only if every k6 invocation passed its thresholds.
# Any threshold breach → non-zero → safe to wire into a deploy gate.

set -o pipefail

PROFILE="${1:-smoke}"
BASE_URL="${2:-${BASE_URL:-http://localhost:4326}}"
SHOP_HOST="${3:-${SHOP_HOST:-demo.gbox.co}}"
TIER="${TIER:-100k}"

case "$TIER" in
  100k|t100k) TIER=100k ;;
  1m|t1m)     TIER=1m   ;;
  10m|t10m)   TIER=10m  ;;
  *)
    echo "Unknown TIER=$TIER. Valid: 100k, 1m, 10m"
    exit 2
    ;;
esac

# The existing scripts use SCENARIO, target-100k.js uses PROFILE.
# Map the profile name to the closest matching scenario name in the
# older scripts so all four runs line up under one human-facing knob.
case "$PROFILE" in
  smoke)    SCENARIO=smoke   ;;
  baseline) SCENARIO=average ;;
  peak)     SCENARIO=peak    ;;
  flash)    SCENARIO=spike   ;;
  sustain)  SCENARIO=soak    ;;
  *)
    echo "Unknown profile: $PROFILE"
    echo "Valid profiles: smoke baseline peak flash sustain"
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v k6 >/dev/null 2>&1; then
  echo "ERROR: k6 is not installed. See scripts/load/README.md for install steps."
  exit 3
fi

echo "================================================================="
echo "Gbox scaling load harness"
echo "================================================================="
echo "tier        : $TIER orders/month"
echo "profile     : $PROFILE"
echo "scenario    : $SCENARIO (browse / checkout / cdn legacy scripts)"
echo "base url    : $BASE_URL"
echo "shop host   : $SHOP_HOST"
echo "products    : ${PRODUCT_HANDLES:-sample-product}"
echo "collections : ${COLLECTION_HANDLES:-all}"
echo "variants    : ${VARIANT_IDS:-v1}"
echo "================================================================="

if [ "$TIER" = "10m" ] && [ "$PROFILE" = "flash" ]; then
  echo
  echo "*** WARNING: TIER=10m PROFILE=flash expects ~100,000 concurrent ***"
  echo "*** browse VUs. A single k6 process CANNOT generate that load.  ***"
  echo "*** Use a distributed k6 runner (k6 Operator / cluster) instead.***"
  echo
fi

FAIL=0
PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()

run_step() {
  local name="$1"
  local cmd="$2"
  echo
  echo "---- $name ----"
  if eval "$cmd"; then
    RESULTS+=("PASS  $name")
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    RESULTS+=("FAIL  $name")
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAIL=1
  fi
}

# Shared env that the legacy scripts read
ENV_ARGS=(
  -e "BASE_URL=$BASE_URL"
  -e "SHOP_HOST=$SHOP_HOST"
)
[ -n "${PRODUCT_HANDLES:-}" ]    && ENV_ARGS+=(-e "PRODUCT_HANDLES=$PRODUCT_HANDLES")
[ -n "${COLLECTION_HANDLES:-}" ] && ENV_ARGS+=(-e "COLLECTION_HANDLES=$COLLECTION_HANDLES")
[ -n "${VARIANT_IDS:-}" ]        && ENV_ARGS+=(-e "VARIANT_IDS=$VARIANT_IDS")

# Serialise so every run has the full machine to itself — perf
# numbers from parallel runs would mask each other.

run_step "storefront-browse ($SCENARIO)" \
  "k6 run -e SCENARIO=$SCENARIO ${ENV_ARGS[*]} '$SCRIPT_DIR/storefront-browse.js'"

run_step "checkout-flow ($SCENARIO)" \
  "k6 run -e SCENARIO=$SCENARIO ${ENV_ARGS[*]} '$SCRIPT_DIR/checkout-flow.js'"

run_step "assets-cdn ($SCENARIO)" \
  "k6 run -e SCENARIO=$SCENARIO ${ENV_ARGS[*]} '$SCRIPT_DIR/assets-cdn.js'"

run_step "target-scale ($TIER / $PROFILE)" \
  "k6 run -e TIER=$TIER -e PROFILE=$PROFILE ${ENV_ARGS[*]} '$SCRIPT_DIR/target-scale.js'"

echo
echo "================================================================="
echo "SUMMARY"
echo "================================================================="
for line in "${RESULTS[@]}"; do
  echo "  $line"
done
echo "-----------------------------------------------------------------"
echo "  pass: $PASS_COUNT   fail: $FAIL_COUNT"
echo "================================================================="

exit $FAIL
