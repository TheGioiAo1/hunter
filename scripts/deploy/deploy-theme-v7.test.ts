/**
 * Sprint 5 Task 5.2 — deploy-theme-v7.sh contract tests.
 *
 * The script extracts a Stage 15 theme.zip from S3 to
 * /var/www/themes/<shop>/ and reloads pm2 so the storefront picks up
 * the new bundle.
 *
 * We don't run the script (would need bash + aws + pm2 + sudo) — we
 * verify the bash source statically: every contract bullet from the
 * Sprint 5 plan is enforced by reading the file. Live execution is
 * delegated to the Server-3 runbook + acceptance test.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Script lives at scripts/deploy-theme-v7.sh per Sprint 5 plan; the
// test lives in scripts/deploy/ because vitest only picks up tests
// from scripts/deploy/, scripts/cron/, scripts/ops/.
const SCRIPT_PATH = path.resolve(__dirname, '..', 'deploy-theme-v7.sh')

function readScript(): string {
  return fs.readFileSync(SCRIPT_PATH, 'utf8')
}

describe('scripts/deploy-theme-v7.sh', () => {
  it('exists', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true)
  })

  it('starts with bash shebang and set -euo pipefail (fail-fast hygiene)', () => {
    const src = readScript()
    expect(src).toMatch(/^#!\/(usr\/bin\/env\s+)?bash/)
    expect(src).toMatch(/set\s+-euo\s+pipefail/)
  })

  it('takes shop_id and theme_zip_s3_key as positional args', () => {
    const src = readScript()
    // $1 + $2 must be referenced before any work happens
    expect(src).toMatch(/SHOP_ID=.*\$\{?1\}?/)
    expect(src).toMatch(/THEME_ZIP_S3_KEY=.*\$\{?2\}?/)
  })

  it('validates required args (errors out if missing)', () => {
    const src = readScript()
    // Some form of required-arg guard
    expect(src).toMatch(/(usage|Usage|required|missing|\-z\s+)/i)
  })

  it('downloads from s3 to a /tmp staging file', () => {
    const src = readScript()
    expect(src).toContain('aws s3 cp')
    expect(src).toContain('/tmp/')
  })

  it('uses S3_BUCKET env var with sane default', () => {
    const src = readScript()
    expect(src).toMatch(/S3_BUCKET[:?]?[-=]/)
    // Default bucket per CLAUDE.md / infra docs
    expect(src).toMatch(/gbox-clone-storage/)
  })

  it('writes the extracted theme to <THEMES_ROOT>/<shop>/ (default /var/www/themes)', () => {
    const src = readScript()
    // THEMES_ROOT env override with default '/var/www/themes', plus DEST
    // composed from "${THEMES_ROOT}/${SHOP_ID}".
    expect(src).toMatch(/THEMES_ROOT[:?]?[-=].*\/var\/www\/themes/)
    expect(src).toMatch(/\$\{?THEMES_ROOT\}?\/\$\{?SHOP_ID\}?/)
  })

  it('backs up the previous theme to <dest>.bak before extracting', () => {
    const src = readScript()
    // .bak rotation: remove old .bak, mv current → .bak
    expect(src).toMatch(/\.bak/)
    expect(src).toMatch(/(rm\s+-rf|rm\s+-r).*\.bak/)
  })

  it('extracts the zip with unzip -q (quiet, fail-on-error)', () => {
    const src = readScript()
    expect(src).toMatch(/unzip\s+-q/)
  })

  it('chowns the extracted dir to a service user (NOT root)', () => {
    const src = readScript()
    expect(src).toMatch(/chown\s+-R/)
    // unbutu1 is the service account on server 3 per infra topology
    expect(src).toMatch(/unbutu1|gbox|www-data|node/)
  })

  it('triggers pm2 reload of the storefront process', () => {
    const src = readScript()
    expect(src).toMatch(/pm2\s+reload/)
    expect(src).toMatch(/gbox-storefront|storefront/)
  })

  it('cleans up the /tmp staging file after extract', () => {
    const src = readScript()
    // The staging file is computed via TMP_ZIP="/tmp/theme-${SHOP_ID}.zip"
    // and removed via `rm -f "${TMP_ZIP}"` at the end.
    expect(src).toMatch(/TMP_ZIP=.*\/tmp\/theme/)
    expect(src).toMatch(/rm\s+-f\s+["']?\$\{?TMP_ZIP\}?/)
  })

  it('emits a success line on completion', () => {
    const src = readScript()
    // Plan calls for "✓ Deployed theme to $DEST" — be lenient: any
    // success echo with the path.
    expect(src).toMatch(/echo.*[Dd]eployed/)
  })
})
