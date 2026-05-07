import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectPlatform } from './platform-detect.js'

describe('detectPlatform', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns "shopify" when /products.json returns valid JSON with products array', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: [{ id: 1, handle: 'x' }] }),
    })
    const p = await detectPlatform('https://shop.example.com', { fetch: fetchMock as any })
    expect(p).toBe('shopify')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://shop.example.com/products.json?limit=1',
      expect.any(Object),
    )
  })

  it('returns "generic" when /products.json 404s', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    expect(await detectPlatform('https://example.com', { fetch: fetchMock as any })).toBe('generic')
  })

  it('returns "generic" when /products.json returns HTML (not JSON)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new Error('invalid json') },
    })
    expect(await detectPlatform('https://example.com', { fetch: fetchMock as any })).toBe('generic')
  })

  it('returns "generic" when products.json body has no products field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ foo: 'bar' }) })
    expect(await detectPlatform('https://example.com', { fetch: fetchMock as any })).toBe('generic')
  })

  it('returns "unknown" when fetch itself throws (network error)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await detectPlatform('https://example.com', { fetch: fetchMock as any })).toBe('unknown')
  })
})
