import { describe, it, expect, vi } from 'vitest'
import { downloadAssetsToS3 } from './stage6-asset-download.js'

describe('Stage 6 — asset download', () => {
  it('downloads, hashes, uploads, persists row per asset', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new TextEncoder().encode('xxxx').buffer,
    }))
    const fakeS3 = { putObjectIfAbsent: vi.fn().mockResolvedValue({ uploaded: true, skipped: false }) }
    const fakeDb = {
      insertInto: () => ({
        values: () => ({ onConflict: (_cb: any) => ({ execute: async () => {} }) }),
      }),
    }
    const fakeCap = { check: vi.fn().mockResolvedValue({ ok: true }) }

    const r = await downloadAssetsToS3({
      assets: [{ sourceUrl: 'https://x.com/a.jpg', contentType: 'image', bucket: 'generic-image', referencedFrom: ['q1'] }],
      shopId: 'shop-1', jobId: 'job-1', sellerUuid: 'seller-1',
      bucket: 'gbox-clone-storage', cdnHost: 'cdn.gbox.co',
      fetch: fakeFetch as any, s3Put: fakeS3.putObjectIfAbsent, db: fakeDb as any, cap: fakeCap as any,
      concurrency: 5,
    })
    expect(r.downloaded).toBe(1)
    expect(r.skipped).toBe(0)
    expect(fakeS3.putObjectIfAbsent).toHaveBeenCalledOnce()
  })

  it('respects 5% failure threshold (continues if under)', async () => {
    let callCount = 0
    const fakeFetch = vi.fn(async () => {
      callCount++
      if (callCount === 1) return { ok: false, status: 500 }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => new TextEncoder().encode('x').buffer }
    })
    const fakeS3 = { putObjectIfAbsent: vi.fn().mockResolvedValue({ uploaded: true, skipped: false }) }
    const fakeDb = { insertInto: () => ({ values: () => ({ onConflict: (_cb: any) => ({ execute: async () => {} }) }) }) }
    const fakeCap = { check: vi.fn().mockResolvedValue({ ok: true }) }
    const assets = Array.from({ length: 30 }, (_, i) => ({ sourceUrl: `https://x.com/${i}.jpg`, contentType: 'image' as const, bucket: 'generic-image' as const, referencedFrom: ['q'] }))
    const r = await downloadAssetsToS3({
      assets, shopId: 'shop-1', jobId: 'job-1', sellerUuid: 'seller-1',
      bucket: 'gbox-clone-storage', cdnHost: 'cdn.gbox.co',
      fetch: fakeFetch as any, s3Put: fakeS3.putObjectIfAbsent, db: fakeDb as any, cap: fakeCap as any,
      concurrency: 5,
    })
    expect(r.failed).toBe(1)
    expect(r.aborted).toBe(false)
  })
})
