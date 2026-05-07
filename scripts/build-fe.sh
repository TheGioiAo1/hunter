#!/usr/bin/env bash
set -euo pipefail
TAG="${TAG:-dev}"
IMAGE="ghcr.io/thegioiao1/hunter:${TAG}"
cd /srv/hunter
[ -f .dockerignore ] || { echo "ERROR: .dockerignore missing"; exit 1; }
echo "==> Build $IMAGE"
nerdctl build -t "$IMAGE" .
echo "==> Push $IMAGE"
nerdctl push "$IMAGE"
echo "OK $IMAGE"
