/**
 * Contract test for scripts/smoke-clone-pro-v7-pr5-e2e.ts.
 *
 * Sprint 5 Task 5.4. We can't run the actual smoke from this sandbox
 * (it needs DATABASE_URL, ANTHROPIC_API_KEY, AWS creds, Playwright,
 * and access to bibliobloom.com). Instead, we statically verify that:
 *
 *   1. The file exists at the expected path
 *   2. It exits with 0 if DATABASE_URL is missing (so CI doesn't break)
 *   3. It checks for SMOKE_SHOP_ID and bails 2 if missing
 *   4. It writes a result JSON to tmp/e2e-result.json (or override)
 *   5. It assertions for the Sprint 5 acceptance:
 *      - products count
 *      - quality_score
 *      - active theme_files row
 *      - storefront / + /products/<handle> + /collections/<handle> 200
 *      - visual_verify_score >= 7
 *
 * The runbook documents the live-execution path on Server 2.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.resolve(__dirname, '..', 'smoke-clone-pro-v7-pr5-e2e.ts')

function readScript(): string {
  return fs.readFileSync(SCRIPT_PATH, 'utf8')
}

describe('scripts/smoke-clone-pro-v7-pr5-e2e.ts', () => {
  it('exists', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true)
  })

  it('exits 0 when DATABASE_URL is missing (CI safe)', () => {
    const src = readScript()
    expect(src).toMatch(/DATABASE_URL/)
    expect(src).toMatch(/process\.exit\(0\)/)
  })

  it('requires SMOKE_SHOP_ID env var (exits 2 when missing)', () => {
    const src = readScript()
    expect(src).toMatch(/SMOKE_SHOP_ID/)
    expect(src).toMatch(/process\.exit\(2\)/)
  })

  it('defaults source URL to bibliobloom.com', () => {
    const src = readScript()
    expect(src).toContain('bibliobloom.com')
  })

  it('defaults to 1100 products limit', () => {
    const src = readScript()
    expect(src).toMatch(/DEFAULT_PRODUCTS_LIMIT\s*=\s*1100/)
  })

  it('defaults min visual score to 7', () => {
    const src = readScript()
    expect(src).toMatch(/DEFAULT_MIN_VISUAL_SCORE\s*=\s*7/)
  })

  it('defaults storefront domain to best-store-v7-final.gbox.co', () => {
    const src = readScript()
    expect(src).toContain('best-store-v7-final.gbox.co')
  })

  it('writes result JSON to tmp/e2e-result.json by default', () => {
    const src = readScript()
    expect(src).toContain('tmp/e2e-result.json')
  })

  it('asserts products count >= productsLimit', () => {
    const src = readScript()
    expect(src).toMatch(/productsLanded.*<.*productsLimit|productsLanded.*<.*expected/)
  })

  it('asserts quality_score from clone_crawl_runs', () => {
    const src = readScript()
    expect(src).toContain('clone_crawl_runs')
    expect(src).toContain('quality_score')
  })

  it('asserts theme_files active row exists', () => {
    const src = readScript()
    expect(src).toContain('theme_files')
    expect(src).toMatch(/is_active.*true/)
  })

  it('asserts storefront / and /products/<handle> respond 200', () => {
    const src = readScript()
    // Loose match: must (a) call fetchStatus on /products/<handle> URL and
    // (b) flag a non-200 response. The function is split across lines so
    // we check that both pieces are present in the source body.
    expect(src).toMatch(/fetchStatus\b/)
    expect(src).toContain('/products/${handle}')
    expect(src).toMatch(/!==\s*200/)
  })

  it('asserts visual_verify_score from clone_run_metrics', () => {
    const src = readScript()
    expect(src).toContain('clone_run_metrics')
    expect(src).toContain('ai_vision_score')
  })

  it('uses runCloneProV7 + buildV7Deps from v7 package', () => {
    const src = readScript()
    expect(src).toContain('runCloneProV7')
    expect(src).toContain('buildV7Deps')
  })

  it('polls job status with timeout', () => {
    const src = readScript()
    expect(src).toMatch(/pollJobStatus/)
    expect(src).toMatch(/timeout|timedOut|timed out/i)
  })

  it('uses ESM import.meta-style fileURL helpers correctly', () => {
    const src = readScript()
    // Should import dotenv/config for DATABASE_URL pickup
    expect(src).toMatch(/import\s+['"]dotenv\/config['"]/)
  })
})
