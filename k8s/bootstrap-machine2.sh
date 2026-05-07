#!/usr/bin/env bash
# Bootstrap Machine 2 cluster: namespace + external services + DB credentials secret + smoke tests.
#
# PRE-REQUISITES (chạy trên Machine 1 trước, copy 2 password ra):
#   GBOX_MONGO_PASS=$(microk8s kubectl get secret -n gbox-db mongo-secrets \
#     -o jsonpath='{.data.GBOX_MONGO_USER_PASSWORD}' | base64 -d)
#   GBOX_REDIS_PASS=$(microk8s kubectl get secret -n gbox-db redis-secrets \
#     -o jsonpath='{.data.REDIS_PASSWORD}' | base64 -d)
#   echo "MONGO=$GBOX_MONGO_PASS"
#   echo "REDIS=$GBOX_REDIS_PASS"
#
# RUN ON MACHINE 2:
#   export GBOX_MONGO_PASS='<paste-mongo-password>'
#   export GBOX_REDIS_PASS='<paste-redis-password>'
#   cd /srv/hunter/k8s   # nơi clone repo
#   chmod +x bootstrap-machine2.sh
#   ./bootstrap-machine2.sh
#
# Idempotent: chạy lại để rotate credential. KHÔNG commit password vào git.

set -euo pipefail

if [[ -z "${GBOX_MONGO_PASS:-}" || -z "${GBOX_REDIS_PASS:-}" ]]; then
  echo "ERROR: export GBOX_MONGO_PASS and GBOX_REDIS_PASS first." >&2
  echo "See header comment for how to fetch from Machine 1." >&2
  exit 1
fi

KUBECTL="${KUBECTL:-microk8s kubectl}"
NS="gbox-fe"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> [1/5] Apply namespace"
$KUBECTL apply -f "$SCRIPT_DIR/00-namespace.yaml"

echo "==> [2/5] Apply external services (mongodb / redis → Machine 1)"
$KUBECTL apply -f "$SCRIPT_DIR/01-external-services.yaml"

echo "==> [3/5] Build secret gbox-db-credentials"
# Render 13 Mongo URI + 1 Redis URI thành Secret literal (avoid file on disk).
gen_uri() {
  local db="$1"
  echo "mongodb://gbox:${GBOX_MONGO_PASS}@mongodb:27017/${db}?authSource=${db}"
}

$KUBECTL -n "$NS" delete secret gbox-db-credentials --ignore-not-found
$KUBECTL -n "$NS" create secret generic gbox-db-credentials \
  --from-literal=MONGO_USERS="$(gen_uri Gbox-Users)" \
  --from-literal=MONGO_SHOPS="$(gen_uri Gbox-Shops)" \
  --from-literal=MONGO_PRODUCTS="$(gen_uri Gbox-Products)" \
  --from-literal=MONGO_ORDERS="$(gen_uri Gbox-Orders)" \
  --from-literal=MONGO_CUSTOMERS="$(gen_uri Gbox-Customers)" \
  --from-literal=MONGO_EMAILS="$(gen_uri Gbox-Emails)" \
  --from-literal=MONGO_PAGES="$(gen_uri Gbox-Pages)" \
  --from-literal=MONGO_PAYMENTS="$(gen_uri Gbox-Payments)" \
  --from-literal=MONGO_SHIPPINGS="$(gen_uri Gbox-Shippings)" \
  --from-literal=MONGO_LAYOUTS="$(gen_uri Gbox-Layouts)" \
  --from-literal=MONGO_APPS="$(gen_uri Gbox-Apps)" \
  --from-literal=MONGO_WEBHOOKS="$(gen_uri Gbox-Webhooks)" \
  --from-literal=MONGO_LOCATIONS="$(gen_uri Gbox-Locations)" \
  --from-literal=REDIS_URL="redis://default:${GBOX_REDIS_PASS}@redis:6379/0"

echo "==> [4/5] Run smoke tests (mongo + redis)"
$KUBECTL -n "$NS" delete job smoke-mongo smoke-redis --ignore-not-found
$KUBECTL apply -f "$SCRIPT_DIR/03-smoke-test-mongo.yaml"
$KUBECTL apply -f "$SCRIPT_DIR/04-smoke-test-redis.yaml"

echo "==> Waiting for smoke jobs to complete (60s timeout)..."
$KUBECTL -n "$NS" wait --for=condition=complete job/smoke-mongo --timeout=60s || true
$KUBECTL -n "$NS" wait --for=condition=complete job/smoke-redis --timeout=60s || true

echo "==> [5/5] Smoke test logs"
echo "----- smoke-mongo -----"
$KUBECTL -n "$NS" logs job/smoke-mongo || echo "(no logs yet)"
echo "----- smoke-redis -----"
$KUBECTL -n "$NS" logs job/smoke-redis || echo "(no logs yet)"

echo
echo "✅ Done. Resources:"
$KUBECTL -n "$NS" get all
echo
echo "Next: refactor FE Postgres → Mongo, then deploy app Deployments mounting these secrets."
