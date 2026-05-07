/**
 * Gbox Storefront — Email tracking routes tests (Phase 14 PR4)
 *
 * Covers the two endpoints:
 *
 *   GET /email/track/open/:token.gif
 *   GET /email/track/click/:token?u=<base64url>
 *
 * Both routes are anti-enumeration by design — tests that intentionally
 * break the input assert that the recipient STILL gets a valid
 * response (pixel / 302), not a 4xx error. The recorder deps are
 * mocked so we can verify they're called with the right arguments
 * without spinning up a DB.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { buildEmailTrackingRoutes } from './email-tracking-routes.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'a'.repeat(32)

let server: Server
let baseUrl: string
let recordOpen: ReturnType<typeof vi.fn>
let recordClick: ReturnType<typeof vi.fn>

beforeAll(async () => {
  recordOpen = vi.fn(async () => undefined)
  recordClick = vi.fn(async () => ({ target: null }))

  const app = express()
  app.use(
    buildEmailTrackingRoutes({
      recordOpen: (t, m) => recordOpen(t, m),
      recordClick: (t, e, m) => recordClick(t, e, m),
    }),
  )

  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  recordOpen.mockClear()
  recordClick.mockClear()
  recordClick.mockResolvedValue({ target: null })
})

// ---------------------------------------------------------------------------
// §1 Open pixel route
// ---------------------------------------------------------------------------

describe('GET /email/track/open/:token.gif', () => {
  it('returns a 200 GIF for a valid-shape token', async () => {
    const res = await fetch(
      `${baseUrl}/email/track/open/${VALID_TOKEN}.gif`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/gif')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.length).toBe(43)
    expect(buf.subarray(0, 6).toString('ascii')).toBe('GIF89a')
  })

  it('sets no-store + X-Content-Type-Options headers', async () => {
    const res = await fetch(
      `${baseUrl}/email/track/open/${VALID_TOKEN}.gif`,
    )
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('calls recordOpen with the token + meta', async () => {
    await fetch(`${baseUrl}/email/track/open/${VALID_TOKEN}.gif`, {
      headers: { 'user-agent': 'TestClient/1.0' },
    })
    // Give the fire-and-forget recorder time to settle.
    await new Promise((r) => setTimeout(r, 50))
    expect(recordOpen).toHaveBeenCalledTimes(1)
    const [token, meta] = recordOpen.mock.calls[0]
    expect(token).toBe(VALID_TOKEN)
    expect(meta.userAgent).toBe('TestClient/1.0')
    expect(typeof meta.ip === 'string' || meta.ip == null).toBe(true)
  })

  it('returns the GIF even for an invalid-shape token (anti-enumeration)', async () => {
    const res = await fetch(`${baseUrl}/email/track/open/not-a-token.gif`)
    // Express routes `/:token.gif` matches anything ending in .gif, so
    // this hits our handler; the handler skips the recorder but still
    // sends the pixel.
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/gif')
    await new Promise((r) => setTimeout(r, 20))
    // Recorder must NOT have been called for a garbage token.
    expect(recordOpen).not.toHaveBeenCalled()
  })

  it('swallows recorder failures — pixel still goes out', async () => {
    recordOpen.mockRejectedValueOnce(new Error('db down'))
    const res = await fetch(
      `${baseUrl}/email/track/open/${VALID_TOKEN}.gif`,
    )
    expect(res.status).toBe(200)
    // Give the background promise chain a tick to settle.
    await new Promise((r) => setTimeout(r, 20))
  })
})

// ---------------------------------------------------------------------------
// §2 Click redirect route
// ---------------------------------------------------------------------------

describe('GET /email/track/click/:token', () => {
  it('302s to the decoded target when recorder returns one', async () => {
    recordClick.mockResolvedValueOnce({ target: 'https://shop.com/products/hat' })
    const res = await fetch(
      `${baseUrl}/email/track/click/${VALID_TOKEN}?u=aHR0cHM6Ly9zaG9wLmNvbS8`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://shop.com/products/hat')
  })

  it('302s to / when target is null (invalid / malicious URL)', async () => {
    recordClick.mockResolvedValueOnce({ target: null })
    const res = await fetch(
      `${baseUrl}/email/track/click/${VALID_TOKEN}?u=aHR0cHM6Ly9zaG9wLmNvbS8`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('302s to / when token shape is invalid (does not call recorder)', async () => {
    const res = await fetch(
      `${baseUrl}/email/track/click/not-valid?u=aHR0cHM6Ly9zaG9wLmNvbS8`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(recordClick).not.toHaveBeenCalled()
  })

  it('302s to / when ?u= is missing', async () => {
    const res = await fetch(
      `${baseUrl}/email/track/click/${VALID_TOKEN}`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(recordClick).not.toHaveBeenCalled()
  })

  it('302s to / when recorder throws', async () => {
    recordClick.mockRejectedValueOnce(new Error('db down'))
    const res = await fetch(
      `${baseUrl}/email/track/click/${VALID_TOKEN}?u=aHR0cHM6Ly9zaG9wLmNvbS8`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('sets no-store cache headers on the redirect', async () => {
    recordClick.mockResolvedValueOnce({ target: 'https://x.com/' })
    const res = await fetch(
      `${baseUrl}/email/track/click/${VALID_TOKEN}?u=aHR0cHM6Ly94LmNvbS8`,
      { redirect: 'manual' },
    )
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('no-store')
  })

  it('passes the encoded URL through to the recorder verbatim', async () => {
    recordClick.mockResolvedValueOnce({ target: 'https://shop.com/p' })
    await fetch(
      `${baseUrl}/email/track/click/${VALID_TOKEN}?u=aHR0cHM6Ly9zaG9wLmNvbS9w`,
      { redirect: 'manual' },
    )
    expect(recordClick).toHaveBeenCalledTimes(1)
    const [token, encoded] = recordClick.mock.calls[0]
    expect(token).toBe(VALID_TOKEN)
    expect(encoded).toBe('aHR0cHM6Ly9zaG9wLmNvbS9w')
  })
})
