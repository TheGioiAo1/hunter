/**
 * Clone Pro v7 — Stage 11 (auto-publish) tests.
 *
 * Sprint 5 Task 5.3. The v7 Stage 11 wraps v6's `runStage11` with two
 * additional side-effects on successful publish:
 *
 *   1. Flip `shop_settings(shop_id, key='theme_loader_version')` to 'v2'.
 *      Tells the storefront DbLoader to read from theme_files instead
 *      of theme_assets.
 *   2. Invoke the theme deploy callback (extracts theme.zip on Server 3
 *      via `scripts/deploy-theme-v7.sh`).
 *
 * Both side-effects only fire when:
 *   - v6 publish actually succeeded (published=true)
 *   - themeZipS3Key is provided (Stage 15 may have failed; we still
 *     publish products + collections even if the theme generation didn't
 *     converge)
 *
 * If deploy callback or settings flip fails, we surface the error as a
 * warning but DON'T un-publish — the catalog is live, the theme can be
 * re-deployed manually.
 */

import { describe, it, expect, vi } from 'vitest'
import { runStage11V7 } from './stage11-auto-publish.js'

function makeDeps(overrides: any = {}) {
  return {
    runV6Publish: vi.fn().mockResolvedValue({ published: true }),
    flipThemeLoaderVersion: vi.fn().mockResolvedValue(undefined),
    deployTheme: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('runStage11V7 — happy path', () => {
  it('returns published=true when v6 publish succeeds', async () => {
    const deps = makeDeps()
    const r = await runStage11V7({
      jobId: 'job-1',
      shopId: 'shop-1',
      gradeLetter: 'B',
      themeZipS3Key: 'themes/shop-1/v3.zip',
      ...deps,
    })
    expect(r.published).toBe(true)
    expect(r.themeDeployed).toBe(true)
    expect(r.themeLoaderFlipped).toBe(true)
    expect(deps.runV6Publish).toHaveBeenCalledWith({
      jobId: 'job-1',
      shopId: 'shop-1',
      gradeLetter: 'B',
    })
  })

  it('flips theme_loader_version to v2 in shop_settings on success', async () => {
    const deps = makeDeps()
    await runStage11V7({
      jobId: 'job-1',
      shopId: 'shop-99',
      gradeLetter: 'A',
      themeZipS3Key: 'themes/shop-99/v1.zip',
      ...deps,
    })
    expect(deps.flipThemeLoaderVersion).toHaveBeenCalledWith({
      shopId: 'shop-99',
      version: 'v2',
    })
  })

  it('invokes deployTheme with shop + s3 key on success', async () => {
    const deps = makeDeps()
    await runStage11V7({
      jobId: 'job-7',
      shopId: 'shop-7',
      gradeLetter: 'B',
      themeZipS3Key: 'themes/shop-7/bundle.zip',
      ...deps,
    })
    expect(deps.deployTheme).toHaveBeenCalledWith({
      shopId: 'shop-7',
      themeZipS3Key: 'themes/shop-7/bundle.zip',
    })
  })
})

describe('runStage11V7 — skipped publish (v6 returns published=false)', () => {
  it('does NOT flip loader version when v6 publish was skipped (grade F)', async () => {
    const deps = makeDeps({
      runV6Publish: vi.fn().mockResolvedValue({ published: false, reason: 'grade_F' }),
    })
    const r = await runStage11V7({
      jobId: 'job-1',
      shopId: 'shop-1',
      gradeLetter: 'F',
      themeZipS3Key: 'themes/shop-1/v1.zip',
      ...deps,
    })
    expect(r.published).toBe(false)
    expect(r.reason).toBe('grade_F')
    expect(r.themeDeployed).toBe(false)
    expect(r.themeLoaderFlipped).toBe(false)
    expect(deps.flipThemeLoaderVersion).not.toHaveBeenCalled()
    expect(deps.deployTheme).not.toHaveBeenCalled()
  })

  it('does NOT trigger deploy when no themeZipS3Key was provided (Stage 15 failed)', async () => {
    const deps = makeDeps()
    const r = await runStage11V7({
      jobId: 'job-1',
      shopId: 'shop-1',
      gradeLetter: 'B',
      themeZipS3Key: null,
      ...deps,
    })
    expect(r.published).toBe(true)
    expect(r.themeDeployed).toBe(false)
    expect(r.themeLoaderFlipped).toBe(false)
    expect(deps.deployTheme).not.toHaveBeenCalled()
    expect(deps.flipThemeLoaderVersion).not.toHaveBeenCalled()
  })
})

describe('runStage11V7 — error containment', () => {
  it('surfaces deploy failure as warning but keeps published=true (catalog live)', async () => {
    const deps = makeDeps({
      deployTheme: vi.fn().mockRejectedValue(new Error('s3 access denied')),
    })
    const r = await runStage11V7({
      jobId: 'job-1',
      shopId: 'shop-1',
      gradeLetter: 'B',
      themeZipS3Key: 'themes/shop-1/v1.zip',
      ...deps,
    })
    expect(r.published).toBe(true)
    expect(r.themeDeployed).toBe(false)
    expect(r.warnings.length).toBeGreaterThan(0)
    // Iron Rule 5: warning must NOT leak the raw error string
    expect(r.warnings.join(' ')).not.toContain('s3 access denied')
  })

  it('surfaces flipThemeLoaderVersion failure as warning but keeps published=true', async () => {
    const deps = makeDeps({
      flipThemeLoaderVersion: vi.fn().mockRejectedValue(new Error('db timeout')),
    })
    const r = await runStage11V7({
      jobId: 'job-1',
      shopId: 'shop-1',
      gradeLetter: 'B',
      themeZipS3Key: 'themes/shop-1/v1.zip',
      ...deps,
    })
    expect(r.published).toBe(true)
    expect(r.themeLoaderFlipped).toBe(false)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings.join(' ')).not.toContain('db timeout')
  })

  it('still triggers flip even if deploy fails (idempotent retry safe)', async () => {
    const deps = makeDeps({
      deployTheme: vi.fn().mockRejectedValue(new Error('boom')),
    })
    await runStage11V7({
      jobId: 'job-1',
      shopId: 'shop-1',
      gradeLetter: 'B',
      themeZipS3Key: 'themes/shop-1/v1.zip',
      ...deps,
    })
    expect(deps.flipThemeLoaderVersion).toHaveBeenCalled()
  })
})
