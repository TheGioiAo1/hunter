# Launch Chrome with CDP enabled on port 9222 + throwaway user-data-dir (Windows).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File launch-chrome.ps1 `
#     [-Port 9222] [-DataDir "<path>"] [-Ephemeral] [-Extra "<args>"]
#
# Flags:
#   -Port N        CDP port (default 9222)
#   -DataDir P     User data dir (default: persistent %LOCALAPPDATA%\claudex-chrome-debug)
#   -Ephemeral     Use C:\tmp\chrome-debug instead (fresh per session)
#   -Extra "..."   Append extra Chrome args (space-separated)

param(
    [int]$Port = 9222,
    [string]$DataDir = "",
    [switch]$Ephemeral,
    [string]$Extra = ""
)

$ErrorActionPreference = "Stop"

# ----- Default data dir -----
# Persistent by default: avoids re-triggering First Run wizard on every session.
if (-not $DataDir) {
    if ($Ephemeral) {
        $DataDir = "C:\tmp\chrome-debug"
    } else {
        $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { "C:\Users\Public" }
        $DataDir = Join-Path $base "claudex-chrome-debug"
    }
}

function Test-CdpAlive {
    param([int]$P)
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$P/json/version" -UseBasicParsing -TimeoutSec 2
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

# Already running?
if (Test-CdpAlive -P $Port) {
    Write-Host "Chrome is already running on port $Port"
    Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -UseBasicParsing | Select-Object -ExpandProperty Content
    exit 0
}

# Locate chrome.exe — try common paths in order
$candidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
)

$chromeBin = $null
foreach ($p in $candidates) {
    if (Test-Path $p) { $chromeBin = $p; break }
}

if (-not $chromeBin) {
    # Last resort: PATH lookup
    $where = (Get-Command chrome.exe -ErrorAction SilentlyContinue)
    if ($where) { $chromeBin = $where.Source }
}

if (-not $chromeBin) {
    Write-Error "Chrome not found. Install Google Chrome first."
    exit 2
}

# Ensure data-dir exists + pre-seed "First Run" marker so Chrome skips wizard.
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
$firstRunMarker = Join-Path $DataDir "First Run"
if (-not (Test-Path $firstRunMarker)) {
    New-Item -ItemType File -Path $firstRunMarker -Force | Out-Null
}

# ----- Chrome args grouped by concern -----
$chromeArgs = @(
    # ---- CDP core ----
    "--remote-debugging-port=$Port",
    "--user-data-dir=$DataDir",

    # ---- Fix: anti-throttling when window loses focus or is occluded ----
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-ipc-flooding-protection",

    # ---- Fix: skip welcome / profile picker / crash bubbles / Google prompts ----
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-client-side-phishing-detection",
    "--password-store=basic",
    "--use-mock-keychain",

    # ---- Fix: reduce automation fingerprints ----
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",

    # ---- Combined --disable-features list ----
    # CalculateNativeWinOcclusion : stops render when window hidden (fix #1, Windows main culprit)
    # ChromeWhatsNewUI            : skip "What's new" page after updates (fix #2)
    # OptimizationHints           : no background network pings (fix #2)
    # Translate                   : no translate popup bar (fix #2)
    # MediaRouter                 : no Cast / media router discovery (fix #2)
    # AutomationControlled        : belt-and-suspenders (fix #3)
    "--disable-features=CalculateNativeWinOcclusion,ChromeWhatsNewUI,OptimizationHints,Translate,MediaRouter,AutomationControlled"
)

# Append user-provided extras
if ($Extra) {
    $extraArr = $Extra.Split(" ") | Where-Object { $_ -ne "" }
    $chromeArgs += $extraArr
}

Write-Host "Launching: $chromeBin"
Write-Host "  data-dir: $DataDir  (ephemeral=$($Ephemeral.IsPresent))"
Write-Host "  port:     $Port"
Write-Host "  args:     $($chromeArgs.Count) flags"

Start-Process -FilePath $chromeBin -ArgumentList $chromeArgs

# Wait for CDP up to 10s
for ($i = 0; $i -lt 20; $i++) {
    if (Test-CdpAlive -P $Port) {
        Write-Host "Chrome CDP ready on port $Port"
        Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -UseBasicParsing | Select-Object -ExpandProperty Content
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

Write-Error "Chrome launched but CDP never responded on port $Port"
exit 3
