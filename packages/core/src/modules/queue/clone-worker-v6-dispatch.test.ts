/**
 * Phase 21 PR1 — clone-worker.ts: v6 dispatch contract
 *
 * Asserts at source level that:
 *   1. The worker imports runCloneProV6 + buildV6Deps from v6/index.
 *   2. The CLONE_PRO_VERSION === 'v6' branch exists and routes to the
 *      v6 orchestrator with jobId / shopId / sourceUrl from the BullMQ
 *      payload.
 *   3. The v6 branch appears BEFORE the v5 branch (ordering invariant —
 *      v6 must be checked first so setting the flag to 'v6' is
 *      unambiguous).
 *
 * This mirrors the style of the existing Phase 7.1 tests in
 * clone-worker.test.ts — read the source, regex-match the key invariants.
 * Integration tests run on server 2 (Redis/BullMQ not available here).
 */

import { describe, it, expect, afterEach } from 'vitest'

async function readWorkerSource(): Promise<string> {
  const fs = await import('node:fs/promises')
  return fs.readFile(new URL('./clone-worker.ts', import.meta.url), 'utf8')
}

describe('Phase 21 PR1 — clone-worker.ts: v6 dispatch', () => {
  afterEach(() => {
    // Reset env in case a test mutated it.
    delete process.env.CLONE_PRO_VERSION
  })

  it('imports runCloneProV6 and buildV6Deps from the v6 index barrel', async () => {
    const src = await readWorkerSource()
    expect(src).toMatch(
      /import\s*\{\s*runCloneProV6\s*,\s*buildV6Deps\s*\}\s*from\s*['"]\.\.\/clone-pro\/v6\/index\.js['"]/,
    )
  })

  it('has a CLONE_PRO_VERSION === "v6" branch', async () => {
    const src = await readWorkerSource()
    expect(src).toMatch(/process\.env\.CLONE_PRO_VERSION\s*===\s*['"]v6['"]/)
  })

  it('v6 branch calls runCloneProV6 with jobId from cloneJobId, shopId, and sourceUrl', async () => {
    const src = await readWorkerSource()
    // The orchestrator call must pass all three identity fields.
    expect(src).toMatch(/await\s+runCloneProV6\s*\(/)
    expect(src).toMatch(/jobId\s*:\s*data\.cloneJobId/)
    expect(src).toMatch(/shopId\s*:\s*data\.shopId/)
    expect(src).toMatch(/sourceUrl\s*:\s*data\.sourceUrl/)
  })

  it('v6 branch calls buildV6Deps with the db instance', async () => {
    const src = await readWorkerSource()
    expect(src).toMatch(/buildV6Deps\s*\(\s*db\s*\)/)
  })

  it('v6 branch appears before v5 branch (ordering invariant)', async () => {
    const src = await readWorkerSource()
    const v6Pos = src.indexOf("CLONE_PRO_VERSION === 'v6'")
    const v5Pos = src.indexOf("CLONE_PRO_VERSION === 'v5'")
    expect(v6Pos).toBeGreaterThan(-1)
    expect(v5Pos).toBeGreaterThan(-1)
    expect(v6Pos).toBeLessThan(v5Pos)
  })
})
