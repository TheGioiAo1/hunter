import { describe, it, expect } from 'vitest'
import { buildV5Deps } from './build-deps.js'

// buildV5Deps is the real-deps factory that the worker calls when
// `CLONE_PRO_VERSION=v5` is set. The factory itself has no async side
// effects — it just wires concrete implementations to the abstract
// `PipelineDeps` interface. These tests assert:
//   1. Every field required by `PipelineDeps` is present + callable.
//   2. `mountPreview` emits a deterministic subdomain derived from
//      the first 8 chars of the jobId, so retries reuse the row.
//   3. Custom `previewHost` override flows through (dev flag).
//
// Deep-exercising the real fetch/db paths belongs to the live-DB smoke
// + real-web E2E smoke — we keep unit tests fast.

describe('buildV5Deps', () => {
  it('returns a fully-populated PipelineDeps bundle', () => {
    const deps = buildV5Deps({} as any)
    expect(deps.scrapers.detectPlatform).toBeTypeOf('function')
    expect(deps.scrapers.fetchHomepage).toBeTypeOf('function')
    expect(deps.scrapers.scrapeProducts).toBeTypeOf('function')
    expect(deps.scrapers.scrapeCollections).toBeTypeOf('function')
    expect(deps.scrapers.scrapePages).toBeTypeOf('function')
    expect(deps.scrapers.parseMenu).toBeTypeOf('function')
    expect(deps.scrapers.extractTokens).toBeTypeOf('function')
    expect(deps.persisters.persistAll).toBeTypeOf('function')
    expect(deps.persisters.mountPreview).toBeTypeOf('function')
    expect(deps.verify.routeCheck).toBeTypeOf('function')
  })

  it('mountPreview writes a cloned_previews row with deterministic subdomain', async () => {
    let captured: any = null
    const fakeDb: any = {
      insertInto: (_t: string) => ({
        values: (v: any) => ({
          onConflict: (_cb: any) => ({
            execute: async () => {
              captured = v
            },
          }),
        }),
      }),
    }
    const deps = buildV5Deps(fakeDb)
    const url = await deps.persisters.mountPreview('abcdef12-3456-7890-abcd-ef1234567890')
    // Deterministic: subdomain = 'clone-' + first 8 chars of jobId.
    expect(captured.subdomain).toBe('clone-abcdef12')
    expect(url).toBe('https://clone-abcdef12.clone-preview.gbox.local')
    // 7-day TTL from now. We don't assert exact ms but the delta must
    // be positive + within 7.5 days (buffer for wall-clock drift during
    // the test run).
    const delta = (captured.expires_at as Date).getTime() - Date.now()
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeLessThan(7.5 * 24 * 60 * 60 * 1000)
  })

  it('honours previewHost override for local dev', async () => {
    let capturedUrl: string | null = null
    const fakeDb: any = {
      insertInto: (_t: string) => ({
        values: (_v: any) => ({
          onConflict: (_cb: any) => ({ execute: async () => {} }),
        }),
      }),
    }
    const deps = buildV5Deps(fakeDb, { previewHost: 'preview.thaibeotit.com' })
    capturedUrl = await deps.persisters.mountPreview('deadbeef-cafe-babe-1234-567890abcdef')
    expect(capturedUrl).toBe('https://clone-deadbeef.preview.thaibeotit.com')
  })
})
