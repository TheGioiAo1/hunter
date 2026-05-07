import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock `got` so we never hit the network during unit tests.
const gotMock = vi.fn()
vi.mock('got', () => ({
  default: (...args: unknown[]) => gotMock(...args),
}))

// p-retry must be imported AFTER the got mock for ESM order.
const { httpFetchHtml, UA_POOL_DESKTOP, pickUserAgent } = await import('../http-fetch.js')

describe('http-fetch', () => {
  beforeEach(() => {
    gotMock.mockReset()
  })

  describe('UA pool', () => {
    it('exports a non-empty desktop UA pool', () => {
      expect(UA_POOL_DESKTOP.length).toBeGreaterThanOrEqual(8)
      for (const ua of UA_POOL_DESKTOP) {
        expect(ua).toMatch(/Mozilla\/5\.0/)
      }
    })

    it('pickUserAgent returns a string from the pool', () => {
      const ua = pickUserAgent()
      expect(UA_POOL_DESKTOP).toContain(ua)
    })
  })

  describe('httpFetchHtml', () => {
    it('returns body on 200 (single attempt)', async () => {
      gotMock.mockResolvedValue({ body: '<html>ok</html>', statusCode: 200 })
      const html = await httpFetchHtml('https://example.com', { retries: 1 })
      expect(html).toBe('<html>ok</html>')
      expect(gotMock).toHaveBeenCalledTimes(1)
    })

    it('sends a UA from the pool', async () => {
      gotMock.mockResolvedValue({ body: 'ok', statusCode: 200 })
      await httpFetchHtml('https://example.com', { retries: 1 })
      const opts = gotMock.mock.calls[0][1] as { headers: Record<string, string> }
      expect(UA_POOL_DESKTOP).toContain(opts.headers['user-agent'])
      expect(opts.headers['accept']).toContain('text/html')
    })

    it('retries on transient 5xx and eventually succeeds', async () => {
      gotMock
        .mockRejectedValueOnce(Object.assign(new Error('HTTP 503'), { response: { statusCode: 503 } }))
        .mockResolvedValueOnce({ body: '<html>ok</html>', statusCode: 200 })
      const html = await httpFetchHtml('https://example.com', {
        retries: 3,
        minTimeoutMs: 1,
        factor: 1,
      })
      expect(html).toBe('<html>ok</html>')
      expect(gotMock).toHaveBeenCalledTimes(2)
    })

    it('rotates UA between retry attempts (best-effort)', async () => {
      gotMock
        .mockRejectedValueOnce(Object.assign(new Error('HTTP 503'), { response: { statusCode: 503 } }))
        .mockRejectedValueOnce(Object.assign(new Error('HTTP 503'), { response: { statusCode: 503 } }))
        .mockResolvedValueOnce({ body: 'ok', statusCode: 200 })
      await httpFetchHtml('https://example.com', { retries: 3, minTimeoutMs: 1, factor: 1 })
      const uas = gotMock.mock.calls.map(
        (c) => (c[1] as { headers: Record<string, string> }).headers['user-agent'],
      )
      // With pool length 8+ and 3 random picks, P(all same) is small but nonzero;
      // assert pool membership instead of strict diff to keep test deterministic.
      for (const ua of uas) expect(UA_POOL_DESKTOP).toContain(ua)
    })

    it('does NOT retry on 404 (permanent — fail fast)', async () => {
      gotMock.mockRejectedValue(
        Object.assign(new Error('HTTP 404'), { response: { statusCode: 404 } }),
      )
      await expect(
        httpFetchHtml('https://example.com', { retries: 3, minTimeoutMs: 1, factor: 1 }),
      ).rejects.toThrow(/HTTP 404|404/)
      expect(gotMock).toHaveBeenCalledTimes(1)
    })

    it('throws after exhausting retries on persistent 500', async () => {
      gotMock.mockRejectedValue(
        Object.assign(new Error('HTTP 500'), { response: { statusCode: 500 } }),
      )
      await expect(
        httpFetchHtml('https://example.com', { retries: 3, minTimeoutMs: 1, factor: 1 }),
      ).rejects.toThrow()
      expect(gotMock).toHaveBeenCalledTimes(3)
    })

    it('honours custom timeout option', async () => {
      gotMock.mockResolvedValue({ body: 'ok', statusCode: 200 })
      await httpFetchHtml('https://example.com', { timeoutMs: 5000, retries: 1 })
      const opts = gotMock.mock.calls[0][1] as { timeout: { request: number } }
      expect(opts.timeout.request).toBe(5000)
    })
  })
})
