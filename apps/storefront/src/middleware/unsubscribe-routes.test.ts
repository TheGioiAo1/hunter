/**
 * Gbox Storefront — Public unsubscribe route tests (Phase 8 PR2e)
 *
 * Covers:
 *   • GET /unsubscribe/:token — valid shape renders confirm page,
 *     malformed shape renders invalid-link, no DB hit either way.
 *   • POST /unsubscribe/:token — fresh unsubscribe, already-unsubscribed,
 *     not-found, malformed token, handler throws → all map to the
 *     appropriate neutral HTML page (no 500).
 *   • Iron rule 5 no-leak: no response body or header contains
 *     "god", "god admin", "god_admin", "platform_settings",
 *     "abandoned_cart", or internal flow-step jargon.
 *   • Caching + indexing: every response sets Cache-Control: no-store
 *     and X-Robots-Tag: noindex, nofollow.
 *
 * Does not exercise the factory via a real HTTP socket — the handler
 * has no cookie / shop / locale dependencies, so an in-process call
 * through Express's router is sufficient and keeps the suite fast.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  buildUnsubscribeRoutes,
  type UnsubscribeEnrollment,
  type UnsubscribeRoutesDeps,
} from './unsubscribe-routes.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'ab'.repeat(16) // 32 hex chars
const VALID_TOKEN_2 = '0123456789abcdef0123456789abcdef'
const INVALID_SHORT = 'too-short'
const INVALID_NONHEX = 'g'.repeat(32) // same length, wrong alphabet

function enrollmentFixture(
  overrides: Partial<UnsubscribeEnrollment> = {},
): UnsubscribeEnrollment {
  return {
    id: 'enr_1',
    shop_id: 'shop_1',
    email: 'buyer@example.test',
    unsubscribed_at: new Date().toISOString(),
    ...overrides,
  }
}

// Matches any copy that would leak internals (iron rule 5).
const LEAKY_PATTERNS = [
  /god[\s_-]?admin/i,
  /\bgod\b/i,
  /platform[_\s-]?settings/i,
  /abandoned[_\s-]?cart/i,
  /smtp/i,
  /flow[_\s-]?definition/i,
  /\bcart_\d/i,
  /last_sent_step/i,
]

function assertNoLeak(text: string): void {
  for (const pat of LEAKY_PATTERNS) {
    expect(text, `leak: ${pat}`).not.toMatch(pat)
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let app: Express
let server: Server
let baseUrl: string
let unsubscribeByToken: ReturnType<typeof vi.fn>

beforeEach(async () => {
  unsubscribeByToken = vi.fn()
  const deps: UnsubscribeRoutesDeps = {
    unsubscribeByToken: (token: string) => unsubscribeByToken(token),
  }

  app = express()
  app.use((req, _res, next) => {
    // Minimal logger-compatible ctx stub so the route's `warn(...)` path
    // doesn't throw when we force the handler to error.
    ;(req as any).gboxCtx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    }
    next()
  })
  app.use(buildUnsubscribeRoutes(deps))

  await new Promise<void>((resolve) => {
    server = createServer(app)
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(() => {
  server.close()
})

import { afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// GET /unsubscribe/:token
// ---------------------------------------------------------------------------

describe('GET /unsubscribe/:token', () => {
  it('renders the confirm page for a valid-shape token without hitting the dep', async () => {
    const res = await fetch(`${baseUrl}/unsubscribe/${VALID_TOKEN}`, {
      method: 'GET',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<form')
    expect(html).toContain(`action="/unsubscribe/${VALID_TOKEN}"`)
    expect(html.toLowerCase()).toContain('unsubscribe')
    // Explicitly: GET must NEVER call the flip dep. Bot-preview safety.
    expect(unsubscribeByToken).not.toHaveBeenCalled()
    // Cache + robots headers
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(res.headers.get('content-type') ?? '').toContain('text/html')
    assertNoLeak(html)
  })

  it('renders invalid-link for a too-short token', async () => {
    const res = await fetch(`${baseUrl}/unsubscribe/${INVALID_SHORT}`, {
      method: 'GET',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('invalid')
    expect(html).not.toContain('<form')
    expect(unsubscribeByToken).not.toHaveBeenCalled()
    assertNoLeak(html)
  })

  it('renders invalid-link for a non-hex 32-char token', async () => {
    const res = await fetch(`${baseUrl}/unsubscribe/${INVALID_NONHEX}`, {
      method: 'GET',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('invalid')
    expect(unsubscribeByToken).not.toHaveBeenCalled()
    assertNoLeak(html)
  })
})

// ---------------------------------------------------------------------------
// POST /unsubscribe/:token — happy path
// ---------------------------------------------------------------------------

describe('POST /unsubscribe/:token — happy path', () => {
  it('flips the enrolment and renders the fresh-unsubscribe page', async () => {
    unsubscribeByToken.mockResolvedValueOnce({
      ok: true,
      enrollment: enrollmentFixture({
        unsubscribed_at: new Date().toISOString(), // fresh
      }),
    })

    const res = await fetch(`${baseUrl}/unsubscribe/${VALID_TOKEN}`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    // Heading copy is HTML-escaped (&#39; for the apostrophe), so we
    // match on the unescaped tail + the absence of the already-state.
    expect(html.toLowerCase()).toContain('been unsubscribed')
    expect(html.toLowerCase()).not.toContain('already unsubscribed')
    expect(unsubscribeByToken).toHaveBeenCalledWith(VALID_TOKEN)

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    assertNoLeak(html)
  })

  it('renders the already-unsubscribed page when unsubscribed_at is stale', async () => {
    // > 10s old stamp — the route infers this is an already-unsubscribed row.
    const staleIso = new Date(Date.now() - 60_000).toISOString()
    unsubscribeByToken.mockResolvedValueOnce({
      ok: true,
      enrollment: enrollmentFixture({ unsubscribed_at: staleIso }),
    })

    const res = await fetch(`${baseUrl}/unsubscribe/${VALID_TOKEN_2}`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('already unsubscribed')
    expect(unsubscribeByToken).toHaveBeenCalledWith(VALID_TOKEN_2)
    assertNoLeak(html)
  })

  it('treats a null unsubscribed_at as fresh (defensive)', async () => {
    unsubscribeByToken.mockResolvedValueOnce({
      ok: true,
      enrollment: enrollmentFixture({ unsubscribed_at: null }),
    })

    const res = await fetch(`${baseUrl}/unsubscribe/${VALID_TOKEN}`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('been unsubscribed')
    expect(html.toLowerCase()).not.toContain('already unsubscribed')
    assertNoLeak(html)
  })
})

// ---------------------------------------------------------------------------
// POST /unsubscribe/:token — failure modes
// ---------------------------------------------------------------------------

describe('POST /unsubscribe/:token — failure modes', () => {
  it('renders invalid-link when the dep returns { ok: false }', async () => {
    unsubscribeByToken.mockResolvedValueOnce({ ok: false })

    const res = await fetch(`${baseUrl}/unsubscribe/${VALID_TOKEN}`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('invalid')
    expect(html.toLowerCase()).not.toContain('been unsubscribed')
    assertNoLeak(html)
  })

  it('renders invalid-link for a too-short token without hitting the dep', async () => {
    const res = await fetch(`${baseUrl}/unsubscribe/${INVALID_SHORT}`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('invalid')
    expect(unsubscribeByToken).not.toHaveBeenCalled()
    assertNoLeak(html)
  })

  it('renders invalid-link for a non-hex 32-char token without hitting the dep', async () => {
    const res = await fetch(`${baseUrl}/unsubscribe/${INVALID_NONHEX}`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('invalid')
    expect(unsubscribeByToken).not.toHaveBeenCalled()
    assertNoLeak(html)
  })

  it('swallows a thrown dep and renders invalid-link (no 500 leak)', async () => {
    unsubscribeByToken.mockImplementationOnce(async () => {
      throw new Error('db connection died')
    })

    const res = await fetch(`${baseUrl}/unsubscribe/${VALID_TOKEN}`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('invalid')
    // Stack trace MUST NOT leak into the response.
    expect(html.toLowerCase()).not.toContain('db connection died')
    expect(html.toLowerCase()).not.toContain('error:')
    expect(html.toLowerCase()).not.toContain('trace')
    assertNoLeak(html)
  })
})

// ---------------------------------------------------------------------------
// Anti-enumeration & bot safety
// ---------------------------------------------------------------------------

describe('anti-enumeration', () => {
  it('returns the same UI for valid-not-found and malformed tokens', async () => {
    // Not found (dep returns false)
    unsubscribeByToken.mockResolvedValueOnce({ ok: false })
    const notFoundRes = await fetch(`${baseUrl}/unsubscribe/${VALID_TOKEN}`, {
      method: 'POST',
    })
    const notFoundHtml = await notFoundRes.text()

    // Malformed (short-circuits before dep)
    const malformedRes = await fetch(`${baseUrl}/unsubscribe/${INVALID_SHORT}`, {
      method: 'POST',
    })
    const malformedHtml = await malformedRes.text()

    expect(notFoundRes.status).toBe(malformedRes.status)
    // The two responses render the same body — an attacker can't tell
    // a valid-but-unknown token from a malformed one.
    expect(notFoundHtml).toBe(malformedHtml)
  })

  it('GET never calls the dep even with a well-formed token', async () => {
    // Fire 5 GETs with a well-formed token — the bot-preview safety rule
    // says the dep must stay idle on GET.
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/unsubscribe/${VALID_TOKEN}`, {
        method: 'GET',
      })
      expect(res.status).toBe(200)
    }
    expect(unsubscribeByToken).not.toHaveBeenCalled()
  })
})
