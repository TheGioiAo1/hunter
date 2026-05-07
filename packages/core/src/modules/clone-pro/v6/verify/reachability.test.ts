import { describe, it, expect, vi } from 'vitest'
import { scanReachability } from './reachability.js'

describe('reachability scan', () => {
  it('reports ok=N when all assets HEAD 200', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const r = await scanReachability({
      htmlBody: '<img src="https://cdn.gbox.co/a.jpg"><link href="https://cdn.gbox.co/b.css">',
      fetch: fakeFetch as any,
    })
    expect(r.totalAssets).toBe(2)
    expect(r.ok).toBe(2)
    expect(r.notFound).toBe(0)
  })

  it('reports notFound when 404 returned', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    const r = await scanReachability({
      htmlBody: '<img src="https://cdn.gbox.co/missing.jpg">',
      fetch: fakeFetch as any,
    })
    expect(r.notFound).toBe(1)
    expect(r.failures[0].status).toBe(404)
  })
})
