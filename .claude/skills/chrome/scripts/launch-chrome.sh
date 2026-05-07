#!/usr/bin/env bash
# Launch Chrome with CDP enabled on port 9222 + throwaway user-data-dir.
# Works on macOS, Linux, and Windows git-bash / MSYS / Cygwin.
#
# Usage: bash launch-chrome.sh [--port N] [--data-dir PATH] [--ephemeral] [--extra "<args>"]
#
# Flags:
#   --port N       CDP port (default 9222)
#   --data-dir P   User data dir (default: persistent path per OS)
#   --ephemeral    Use /tmp/chrome-debug (cleared between sessions)
#   --extra "..."  Append extra Chrome args (space-separated, quoted)

set -euo pipefail

PORT=9222
DATA_DIR=""
EPHEMERAL=0
EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --ephemeral) EPHEMERAL=1; shift ;;
    --extra) EXTRA_ARGS="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

UNAME="$(uname -s)"

# ----- Default data dir per OS -----
# Persistent by default so we don't re-trigger First Run wizard every session.
# --ephemeral flips to /tmp for isolated one-off sessions.
if [[ -z "$DATA_DIR" ]]; then
  if [[ "$EPHEMERAL" -eq 1 ]]; then
    case "$UNAME" in
      MINGW*|MSYS*|CYGWIN*) DATA_DIR="C:\\tmp\\chrome-debug" ;;
      *) DATA_DIR="/tmp/chrome-debug" ;;
    esac
  else
    case "$UNAME" in
      Darwin) DATA_DIR="${HOME}/Library/Caches/claudex-chrome-debug" ;;
      Linux)  DATA_DIR="${HOME}/.cache/claudex-chrome-debug" ;;
      MINGW*|MSYS*|CYGWIN*) DATA_DIR="${LOCALAPPDATA:-C:/Users/Public}/claudex-chrome-debug" ;;
      *) DATA_DIR="${HOME}/.claudex-chrome-debug" ;;
    esac
  fi
fi

# Check if Chrome is already listening on the port
if curl -sf "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome is already running on port ${PORT}"
  curl -s "http://localhost:${PORT}/json/version"
  exit 0
fi

find_chrome() {
  case "$UNAME" in
    Darwin)
      if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
        echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        return
      fi
      ;;
    Linux)
      for bin in google-chrome google-chrome-stable chromium chromium-browser /snap/bin/chromium; do
        if command -v "$bin" >/dev/null 2>&1; then echo "$bin"; return; fi
      done
      ;;
    MINGW*|MSYS*|CYGWIN*)
      for p in \
        "/c/Program Files/Google/Chrome/Application/chrome.exe" \
        "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
        "${LOCALAPPDATA:-}/Google/Chrome/Application/chrome.exe"; do
        if [[ -x "$p" ]]; then echo "$p"; return; fi
      done
      ;;
  esac
  return 1
}

CHROME_BIN="$(find_chrome || true)"
if [[ -z "$CHROME_BIN" ]]; then
  echo "ERROR: Chrome not found. Install Google Chrome or Chromium first." >&2
  exit 2
fi

# Ensure data-dir exists + pre-seed "First Run" marker so Chrome skips the
# first-run wizard (defense-in-depth alongside --no-first-run).
mkdir -p "$DATA_DIR" 2>/dev/null || true
if [[ ! -f "${DATA_DIR}/First Run" ]]; then
  : > "${DATA_DIR}/First Run" 2>/dev/null || true
fi

# ----- Chrome args grouped by concern -----
# Keep readable; we echo them before launch so debugging is easy.
declare -a CHROME_ARGS=(
  # ---- CDP core ----
  "--remote-debugging-port=${PORT}"
  "--user-data-dir=${DATA_DIR}"

  # ---- Fix: anti-throttling when window loses focus or is occluded ----
  "--disable-background-timer-throttling"
  "--disable-backgrounding-occluded-windows"
  "--disable-renderer-backgrounding"
  "--disable-ipc-flooding-protection"

  # ---- Fix: skip welcome / profile picker / crash bubbles / Google prompts ----
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-session-crashed-bubble"
  "--hide-crash-restore-bubble"
  "--disable-sync"
  "--disable-default-apps"
  "--disable-client-side-phishing-detection"
  "--password-store=basic"
  "--use-mock-keychain"

  # ---- Fix: reduce automation fingerprints ----
  # --disable-blink-features removes the navigator.webdriver property.
  # --disable-infobars removes "Chrome is being controlled..." bar if it slips in.
  "--disable-blink-features=AutomationControlled"
  "--disable-infobars"

  # ---- Combined --disable-features list ----
  # CalculateNativeWinOcclusion : Windows-only, stops rendering when window hidden (fix #1)
  # ChromeWhatsNewUI            : skip "What's new" page after updates          (fix #2)
  # OptimizationHints           : no background network pings                   (fix #2)
  # Translate                   : no translate popup bar                        (fix #2)
  # MediaRouter                 : no Cast / media router discovery              (fix #2)
  # AutomationControlled        : belt-and-suspenders with --disable-blink-features above
  "--disable-features=CalculateNativeWinOcclusion,ChromeWhatsNewUI,OptimizationHints,Translate,MediaRouter,AutomationControlled"
)

# Append user-provided extras (split on whitespace, respecting quotes is not
# done here — use the helper carefully for complex cases).
if [[ -n "$EXTRA_ARGS" ]]; then
  # shellcheck disable=SC2206
  EXTRA_ARR=($EXTRA_ARGS)
  CHROME_ARGS+=("${EXTRA_ARR[@]}")
fi

echo "Launching: $CHROME_BIN"
echo "  data-dir: $DATA_DIR  (ephemeral=$EPHEMERAL)"
echo "  port:     $PORT"
echo "  args:     ${#CHROME_ARGS[@]} flags"

case "$UNAME" in
  Darwin)
    # `open -na` can't take a long arg list directly; use the binary path instead.
    "$CHROME_BIN" "${CHROME_ARGS[@]}" >/dev/null 2>&1 &
    disown || true
    ;;
  Linux)
    "$CHROME_BIN" "${CHROME_ARGS[@]}" >/dev/null 2>&1 &
    disown || true
    ;;
  MINGW*|MSYS*|CYGWIN*)
    "$CHROME_BIN" "${CHROME_ARGS[@]}" &
    disown || true
    ;;
esac

# Wait for CDP to come up (up to 10s)
for i in $(seq 1 20); do
  if curl -sf "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
    echo "Chrome CDP ready on port ${PORT}"
    curl -s "http://localhost:${PORT}/json/version"
    exit 0
  fi
  sleep 0.5
done

echo "ERROR: Chrome launched but CDP never responded on port ${PORT}" >&2
exit 3
