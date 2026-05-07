#!/usr/bin/env bash
#
# Gbox Platform — 3-Server LAN Bootstrap (Phase 0 B)
#
# Master deploy script. Runs from a control box (owner's Windows/git-bash OR
# server 1 itself) and SSHes into the 3 test Ubuntu servers to install,
# update, or health-check the full stack.
#
# Servers (from MEMORY.md, LOCKED):
#   1. 192.168.1.13 — DB (Postgres + Redis) + Admin web (god/store/accounts/checkout)
#   2. 192.168.1.30 — REST API (gbox-api)
#   3. 192.168.1.19 — Public storefront (Astro SSR)
#
# Usage:
#   bash scripts/bootstrap-3-servers.sh --init      # First-time install
#   bash scripts/bootstrap-3-servers.sh --update    # Pull + npm ci + pm2 reload
#   bash scripts/bootstrap-3-servers.sh --nginx     # Regenerate nginx on server 1
#   bash scripts/bootstrap-3-servers.sh --health    # Curl every endpoint
#   bash scripts/bootstrap-3-servers.sh --all       # init + nginx + health
#   bash scripts/bootstrap-3-servers.sh --dry-run --update   # Print, don't execute
#
# Credentials:
#   SSH credentials are loaded from ~/.gbox-deploy.env which the owner creates
#   ONCE on the control box. That file is NEVER committed. See the README in
#   scripts/deploy/README.md for the required variables.
#
# Safety:
#   - set -euo pipefail
#   - Trap on ERR to print which server failed
#   - --dry-run shows commands without executing
#
set -euo pipefail

# ----------------------------------------------------------------------------
# Colors
# ----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
  C_BOLD=$'\033[1m'
else
  C_RESET=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""; C_BOLD=""
fi

log()   { echo "${C_CYAN}[${1}]${C_RESET} ${2}"; }
ok()    { echo "${C_GREEN}[${1}] OK${C_RESET} ${2}"; }
warn()  { echo "${C_YELLOW}[${1}] WARN${C_RESET} ${2}"; }
fail()  { echo "${C_RED}[${1}] FAIL${C_RESET} ${2}" >&2; }
title() { echo; echo "${C_BOLD}${C_BLUE}==> ${1}${C_RESET}"; }

# ----------------------------------------------------------------------------
# Flags
# ----------------------------------------------------------------------------
MODE=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --init)    MODE="init";    shift ;;
    --update)  MODE="update";  shift ;;
    --nginx)   MODE="nginx";   shift ;;
    --health)  MODE="health";  shift ;;
    --all)     MODE="all";     shift ;;
    --dry-run) DRY_RUN=1;      shift ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      fail "bootstrap" "Unknown flag: $1"
      exit 2
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  fail "bootstrap" "No mode specified. Use --init, --update, --nginx, --health, or --all."
  exit 2
fi

# ----------------------------------------------------------------------------
# Load credentials from ~/.gbox-deploy.env
# ----------------------------------------------------------------------------
ENV_FILE="${GBOX_DEPLOY_ENV:-$HOME/.gbox-deploy.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  fail "bootstrap" "Missing credentials file: $ENV_FILE"
  cat >&2 <<EOF

Create it with:

  cat > ~/.gbox-deploy.env <<'ENV'
  # Gbox 3-server LAN deploy credentials — NEVER commit this file
  export GBOX_S1_HOST=192.168.1.13
  export GBOX_S1_USER=botesty
  export GBOX_S1_SUDO_PW='<server1 sudo password>'

  export GBOX_S2_HOST=192.168.1.30
  export GBOX_S2_USER=unbutu2
  export GBOX_S2_SUDO_PW='<server2 sudo password>'

  export GBOX_S3_HOST=192.168.1.19
  export GBOX_S3_USER=unbutu1
  export GBOX_S3_SUDO_PW='<server3 sudo password>'

  # Optional — override the repo path / branch
  export GBOX_REPO_URL=https://github.com/GBox-Company/gbox-platform.git
  export GBOX_REPO_DIR=~/gbox-platform
  export GBOX_BRANCH=master
  ENV

  chmod 600 ~/.gbox-deploy.env

EOF
  exit 2
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${GBOX_S1_HOST:?GBOX_S1_HOST missing}"
: "${GBOX_S1_USER:?GBOX_S1_USER missing}"
: "${GBOX_S2_HOST:?GBOX_S2_HOST missing}"
: "${GBOX_S2_USER:?GBOX_S2_USER missing}"
: "${GBOX_S3_HOST:?GBOX_S3_HOST missing}"
: "${GBOX_S3_USER:?GBOX_S3_USER missing}"

GBOX_REPO_URL="${GBOX_REPO_URL:-https://github.com/GBox-Company/gbox-platform.git}"
GBOX_REPO_DIR="${GBOX_REPO_DIR:-~/gbox-platform}"
GBOX_BRANCH="${GBOX_BRANCH:-master}"

# ----------------------------------------------------------------------------
# Server table
# ----------------------------------------------------------------------------
SERVERS=(
  "1|${GBOX_S1_HOST}|${GBOX_S1_USER}|db+admin"
  "2|${GBOX_S2_HOST}|${GBOX_S2_USER}|api"
  "3|${GBOX_S3_HOST}|${GBOX_S3_USER}|storefront"
)

CURRENT_SERVER=""
on_error() {
  local exit_code=$?
  if [[ -n "$CURRENT_SERVER" ]]; then
    fail "$CURRENT_SERVER" "Aborted with exit code $exit_code"
  else
    fail "bootstrap" "Aborted with exit code $exit_code"
  fi
  exit "$exit_code"
}
trap on_error ERR

# ----------------------------------------------------------------------------
# SSH helpers
# ----------------------------------------------------------------------------
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=30)

run_remote() {
  local host="$1" user="$2" tag="$3" cmd="$4"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "${C_YELLOW}[dry-run][${tag}]${C_RESET} ssh ${user}@${host} '${cmd}'"
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "${user}@${host}" "bash -lc '${cmd}'"
}

copy_remote() {
  local src="$1" host="$2" user="$3" dest="$4" tag="$5"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "${C_YELLOW}[dry-run][${tag}]${C_RESET} scp ${src} ${user}@${host}:${dest}"
    return 0
  fi
  scp "${SSH_OPTS[@]}" "$src" "${user}@${host}:${dest}"
}

# ----------------------------------------------------------------------------
# Per-server actions
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/deploy"

push_and_run() {
  local num="$1" host="$2" user="$3" local_script="$4" sudo_pw="${5:-}"
  local tag="SERVER $num"
  CURRENT_SERVER="$tag"

  if [[ ! -f "$local_script" ]]; then
    fail "$tag" "Missing local script: $local_script"
    return 1
  fi

  local remote_path="/tmp/gbox-deploy-$(basename "$local_script")"

  log "$tag" "Uploading $(basename "$local_script") to $host"
  copy_remote "$local_script" "$host" "$user" "$remote_path" "$tag"

  log "$tag" "Executing on $host"
  # We forward GBOX_SUDO_PW via env so the per-server `sudo_run` helper
  # can pipe it into `sudo -S`. The password sits on the remote shell's
  # command line for the brief window of `bash -lc '...'` — acceptable
  # for a LAN deploy, but if you need stricter handling move the servers
  # to passwordless sudo (NOPASSWD in /etc/sudoers.d/) and leave the
  # GBOX_S*_SUDO_PW vars empty.
  run_remote "$host" "$user" "$tag" "chmod +x $remote_path && GBOX_REPO_URL='$GBOX_REPO_URL' GBOX_REPO_DIR='$GBOX_REPO_DIR' GBOX_BRANCH='$GBOX_BRANCH' GBOX_SUDO_PW='$sudo_pw' $remote_path"

  ok "$tag" "$(basename "$local_script") finished"
}

do_init() {
  title "INIT — first-time setup on all 3 servers"
  push_and_run 1 "$GBOX_S1_HOST" "$GBOX_S1_USER" "$DEPLOY_DIR/server1-setup.sh" "${GBOX_S1_SUDO_PW:-}"
  push_and_run 2 "$GBOX_S2_HOST" "$GBOX_S2_USER" "$DEPLOY_DIR/server2-setup.sh" "${GBOX_S2_SUDO_PW:-}"
  push_and_run 3 "$GBOX_S3_HOST" "$GBOX_S3_USER" "$DEPLOY_DIR/server3-setup.sh" "${GBOX_S3_SUDO_PW:-}"
  CURRENT_SERVER=""
  ok "bootstrap" "Init complete on all 3 servers"
}

do_update() {
  title "UPDATE — git pull + npm ci + pm2 reload"
  push_and_run 1 "$GBOX_S1_HOST" "$GBOX_S1_USER" "$DEPLOY_DIR/server1-update.sh" "${GBOX_S1_SUDO_PW:-}"
  push_and_run 2 "$GBOX_S2_HOST" "$GBOX_S2_USER" "$DEPLOY_DIR/server2-update.sh" "${GBOX_S2_SUDO_PW:-}"
  push_and_run 3 "$GBOX_S3_HOST" "$GBOX_S3_USER" "$DEPLOY_DIR/server3-update.sh" "${GBOX_S3_SUDO_PW:-}"
  CURRENT_SERVER=""
  ok "bootstrap" "Update complete on all 3 servers"
}

do_nginx() {
  title "NGINX — regenerate config on server 1 and reload"
  local tag="SERVER 1"
  CURRENT_SERVER="$tag"

  local template="$DEPLOY_DIR/nginx-server1.conf.template"
  local apply="$DEPLOY_DIR/apply-nginx.sh"

  if [[ ! -f "$template" ]]; then
    fail "$tag" "Missing nginx template: $template"
    return 1
  fi
  if [[ ! -f "$apply" ]]; then
    fail "$tag" "Missing apply script: $apply"
    return 1
  fi

  log "$tag" "Uploading nginx template"
  copy_remote "$template" "$GBOX_S1_HOST" "$GBOX_S1_USER" "/tmp/gbox-nginx-new" "$tag"

  log "$tag" "Uploading apply-nginx.sh"
  copy_remote "$apply" "$GBOX_S1_HOST" "$GBOX_S1_USER" "/tmp/gbox-apply-nginx.sh" "$tag"

  log "$tag" "Running apply-nginx.sh (will sudo)"
  run_remote "$GBOX_S1_HOST" "$GBOX_S1_USER" "$tag" "chmod +x /tmp/gbox-apply-nginx.sh && GBOX_SUDO_PW='${GBOX_S1_SUDO_PW:-}' /tmp/gbox-apply-nginx.sh /tmp/gbox-nginx-new"

  CURRENT_SERVER=""
  ok "bootstrap" "Nginx reloaded on server 1"
}

do_health() {
  title "HEALTH — curling every endpoint"
  local health="$DEPLOY_DIR/health-check.sh"
  if [[ ! -f "$health" ]]; then
    fail "bootstrap" "Missing health-check script: $health"
    return 1
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "${C_YELLOW}[dry-run]${C_RESET} bash $health"
    return 0
  fi
  bash "$health"
}

# ----------------------------------------------------------------------------
# Dispatch
# ----------------------------------------------------------------------------
case "$MODE" in
  init)    do_init ;;
  update)  do_update ;;
  nginx)   do_nginx ;;
  health)  do_health ;;
  all)
    do_init
    do_nginx
    do_health
    ;;
  *)
    fail "bootstrap" "Unhandled mode: $MODE"
    exit 2
    ;;
esac

title "DONE"
echo "${C_GREEN}All requested steps completed successfully.${C_RESET}"
