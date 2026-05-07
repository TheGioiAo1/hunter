#!/usr/bin/env bash
set -euo pipefail
KUBECTL="microk8s kubectl"
ROOT=/srv/hunter

# CRLF guard
find $ROOT/k8s -type f -name "*.yaml" -exec sed -i 's/\r$//' {} \;

[ -f $ROOT/k8s/02-db-secrets.yaml ] || { echo "ERROR: chưa có 02-db-secrets.yaml — copy từ template + fill"; exit 1; }
[ -f $ROOT/k8s/05-apps-config.yaml ] || { echo "ERROR: chạy gen-k8s-fe.sh trước"; exit 1; }

$KUBECTL apply -f $ROOT/k8s/00-namespace.yaml
$KUBECTL apply -f $ROOT/k8s/01-external-services.yaml
$KUBECTL apply -f $ROOT/k8s/02-db-secrets.yaml
$KUBECTL apply -f $ROOT/k8s/05-apps-config.yaml
for f in $ROOT/k8s/10-apps/*.yaml; do echo "  -> $(basename $f)"; $KUBECTL apply -f $f; done
$KUBECTL apply -f $ROOT/k8s/20-ingress.yaml

echo "==> Wait pods (timeout 180s)..."
$KUBECTL -n gbox-fe wait --for=condition=ready pod -l app --timeout=180s || true
$KUBECTL -n gbox-fe get pods,svc,ingress
