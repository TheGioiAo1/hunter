import { describe, it, expect, vi } from 'vitest'
import { routeCheck } from './route-check.js'

describe('routeCheck', () => {
  it('HEADs every URL and reports pass rate', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
    const res = await routeCheck(
      ['https://preview/abc', 'https://preview/def', 'https://preview/ghi'],
      { fetch: fetchMock as any },
    )
    expect(res.passCount).toBe(2)
    expect(res.total).toBe(3)
    expect(res.passRate).toBeCloseTo(2 / 3)
    expect(res.failures).toHaveLength(1)
    expect(res.failures[0].url).toBe('https://preview/ghi')
  })

  it('counts fetch error as failure (network timeout etc)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('timeout'))
    const res = await routeCheck(['https://x.com/a'], { fetch: fetchMock as any })
    expect(res.passCount).toBe(0)
    expect(res.failures[0].reason).toMatch(/timeout/)
  })
})
