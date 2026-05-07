/**
 * Gbox Storefront — Account routes tests (Stage 3C.2)
 *
 * Thin HTTP skin over the core `customer-auth` module. These are the
 * endpoints the storefront's customer-facing forms post to:
 *
 *   POST /account/login             — request a magic link + OTP
 *   GET  /account/login/verify      — click-through from the email
 *   POST /account/otp               — paste-the-code fallback flow
 *   POST /account/logout            — revoke + clear cookie
 *
 * We inject stubbed `issueLoginCode` / `verifyMagicLink` /
 * `verifyOtpCode` / `revokeSession` so these tests never touch
 * Postgres. The core module already has exhaustive unit tests for
 * the token + session logic — here we only care that the HTTP skin:
 *
 *   • resolves the shop before calling core,
 *   • writes the right cookie shape on success,
 *   • clears the cookie on logout,
 *   • returns the right status code + body shape depending on
 *     Accept header (JSON vs browser form submit),
 *   • NEVER reveals whether an email exists (POST /login is always
 *     200 even on invalid/unknown emails — prevents account
 *     enumeration),
 *   • rejects requests with no resolved shop,
 *   • surfaces `CustomerAuthError` as a user-visible message.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRequestContextMiddleware } from './request-context.js'
import { buildResolveShopMiddleware } from './resolve-shop.js'
import { buildCookieMiddleware } from './cookies.js'
import { buildAccountRoutes } from './account-routes.js'
import { CustomerAuthError } from '@gbox/core/modules/customer-auth/index.js'
import type { ResolvedShop } from './resolve-shop.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEMO_SHOP: ResolvedShop = {
  id: 'shop_demo',
  slug: 'demo',
  name: 'Demo Shop',
  currency: 'USD',
  defaultLocale: 'en',
  status: 'active',
}

// ---------------------------------------------------------------------------
// Server lifecycle — shared express app, fresh stubs per test
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let issueLoginCode: ReturnType<typeof vi.fn>
let verifyMagicLink: ReturnType<typeof vi.fn>
let verifyOtpCode: ReturnType<typeof vi.fn>
let revokeSession: ReturnType<typeof vi.fn>
let onMagicLinkIssued: ReturnType<typeof vi.fn>

beforeAll(async () => {
  const app = express()
  app.use(buildRequestContextMiddleware({ serviceName: 'gbox-storefront' }))
  app.use(
    buildResolveShopMiddleware({
      lookup: async (host) =>
        host === 'demo.gbox.test' ? DEMO_SHOP : null,
      trustForwardedHost: true,
    }),
  )
  app.use(buildCookieMiddleware({}))
  app.use((req, res, next) =>
    buildAccountRoutes({
      issueLoginCode,
      verifyMagicLink,
      verifyOtpCode,
      revokeSession,
      onMagicLinkIssued,
      secureCookie: false,
    })(req, res, next),
  )

  server = createServer(app)
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  )
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

beforeEach(() => {
  issueLoginCode = vi.fn(async (_shop: string, _email: string, _ip?: string) => ({
    magicLinkToken: 'magic.link.token',
    otpCode: '123456',
    expiresAt: new Date(Date.now() + 900_000),
  }))
  verifyMagicLink = vi.fn(
    async (_shop: string, _email: string, _token: string, _ctx: any) => ({
      customer_id: 'cus_alice',
      shop_id: DEMO_SHOP.id,
      sessionToken: 'session.token.value',
      sessionExpiresAt: new Date(Date.now() + 2_592_000_000),
      newCustomer: false,
    }),
  )
  verifyOtpCode = vi.fn(
    async (_shop: string, _email: string, _code: string, _ctx: any) => ({
      customer_id: 'cus_alice',
      shop_id: DEMO_SHOP.id,
      sessionToken: 'session.token.value',
      sessionExpiresAt: new Date(Date.now() + 2_592_000_000),
      newCustomer: true,
    }),
  )
  revokeSession = vi.fn(async (_token: string) => undefined)
  onMagicLinkIssued = vi.fn(async (_input: any) => undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function post(
  path: string,
  body: unknown,
  init: RequestInit = {},
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('x-forwarded-host', 'demo.gbox.test')
  headers.set('content-type', 'application/json')
  if (cookie) headers.set('cookie', cookie)
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
  })
}

async function get(
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('x-forwarded-host', 'demo.gbox.test')
  if (cookie) headers.set('cookie', cookie)
  return fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers,
    redirect: 'manual',
  })
}

function extractCookie(res: Response, name: string): string | null {
  const raw = res.headers.get('set-cookie')
  if (!raw) return null
  const re = new RegExp(`(?:^|,\\s*)${name}=([^;,\\s]+)`)
  const m = raw.match(re)
  return m ? m[1]! : null
}

// ---------------------------------------------------------------------------
// POST /account/login — issue magic link
// ---------------------------------------------------------------------------

describe('POST /account/login', () => {
  it('200s and invokes issueLoginCode with the resolved shop + email', async () => {
    const res = await post('/account/login', { email: 'alice@example.com' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(issueLoginCode).toHaveBeenCalledTimes(1)
    const [shopId, email] = issueLoginCode.mock.calls[0]!
    expect(shopId).toBe(DEMO_SHOP.id)
    expect(email).toBe('alice@example.com')
  })

  it('surfaces the plaintext token to the onMagicLinkIssued hook (dev delivery)', async () => {
    await post('/account/login', { email: 'alice@example.com' })
    expect(onMagicLinkIssued).toHaveBeenCalledTimes(1)
    const input = onMagicLinkIssued.mock.calls[0]![0]
    expect(input.shopId).toBe(DEMO_SHOP.id)
    expect(input.email).toBe('alice@example.com')
    expect(input.magicLinkToken).toBe('magic.link.token')
    expect(input.otpCode).toBe('123456')
    expect(input.expiresAt).toBeInstanceOf(Date)
  })

  it('still returns 200 when issueLoginCode throws (prevents email enumeration)', async () => {
    issueLoginCode.mockRejectedValueOnce(
      new CustomerAuthError('invalid_email', 'Invalid email address'),
    )
    const res = await post('/account/login', { email: 'not-an-email' })
    // Deliberately 200 — the storefront must NOT leak whether an
    // address is valid or exists. The core error was logged but
    // the HTTP response is indistinguishable from success.
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('422s when the request body has no email field at all', async () => {
    const res = await post('/account/login', {})
    expect(res.status).toBe(422)
    expect(issueLoginCode).not.toHaveBeenCalled()
  })

  it('supports form-urlencoded bodies for <form method="post">', async () => {
    const res = await fetch(`${baseUrl}/account/login`, {
      method: 'POST',
      headers: {
        'x-forwarded-host': 'demo.gbox.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'email=alice@example.com',
      redirect: 'manual',
    })
    // Browser form post without JSON accept header gets a 303 back
    // to /account/login?sent=1 so the template can show "check your
    // inbox" on GET.
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/account/login?sent=1')
    expect(issueLoginCode).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// GET /account/login/verify — magic link click-through
// ---------------------------------------------------------------------------

describe('GET /account/login/verify', () => {
  it('calls verifyMagicLink with email+token from the query string', async () => {
    const res = await get(
      '/account/login/verify?email=alice@example.com&token=magic.link.token',
    )
    expect(verifyMagicLink).toHaveBeenCalledTimes(1)
    const [shopId, email, token] = verifyMagicLink.mock.calls[0]!
    expect(shopId).toBe(DEMO_SHOP.id)
    expect(email).toBe('alice@example.com')
    expect(token).toBe('magic.link.token')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/account')
  })

  it('writes the gbox_customer_session cookie from the session token', async () => {
    const res = await get(
      '/account/login/verify?email=alice@example.com&token=magic.link.token',
    )
    const sessionCookie = extractCookie(res, 'gbox_customer_session')
    expect(sessionCookie).toBe('session.token.value')
  })

  it('redirects to ?error when the token is invalid', async () => {
    verifyMagicLink.mockRejectedValueOnce(
      new CustomerAuthError(
        'code_not_found',
        'Code expired or never issued. Please request a new one.',
      ),
    )
    const res = await get(
      '/account/login/verify?email=alice@example.com&token=bogus',
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('/account/login?error=')
    // No cookie should be set on failure.
    expect(extractCookie(res, 'gbox_customer_session')).toBeNull()
  })

  it('422s when email or token is missing from the query string', async () => {
    const res = await get('/account/login/verify?email=alice@example.com')
    expect(res.status).toBe(422)
    expect(verifyMagicLink).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /account/otp — paste-the-code flow
// ---------------------------------------------------------------------------

describe('POST /account/otp', () => {
  it('sets cookie + returns JSON on success', async () => {
    const res = await post('/account/otp', {
      email: 'alice@example.com',
      code: '123456',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      customer_id: string
      new_customer: boolean
    }
    expect(body.ok).toBe(true)
    expect(body.customer_id).toBe('cus_alice')
    expect(body.new_customer).toBe(true)
    expect(extractCookie(res, 'gbox_customer_session')).toBe(
      'session.token.value',
    )
  })

  it('returns 400 with the core error message when the OTP is wrong', async () => {
    verifyOtpCode.mockRejectedValueOnce(
      new CustomerAuthError('invalid_code', 'Incorrect code'),
    )
    const res = await post('/account/otp', {
      email: 'alice@example.com',
      code: '000000',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; message: string }
    expect(body.ok).toBe(false)
    expect(body.message).toContain('Incorrect code')
    expect(extractCookie(res, 'gbox_customer_session')).toBeNull()
  })

  it('returns 429 when core throws too_many_attempts', async () => {
    verifyOtpCode.mockRejectedValueOnce(
      new CustomerAuthError(
        'too_many_attempts',
        'Too many failed attempts.',
        429,
      ),
    )
    const res = await post('/account/otp', {
      email: 'alice@example.com',
      code: '000000',
    })
    expect(res.status).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// POST /account/logout
// ---------------------------------------------------------------------------

describe('POST /account/logout', () => {
  it('revokes the session and clears the cookie (JSON client)', async () => {
    const res = await post(
      '/account/logout',
      {},
      {},
      'gbox_customer_session=live.session.token',
    )
    expect(revokeSession).toHaveBeenCalledWith('live.session.token')
    // JSON content-type implies JSON response.
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    // Cookie should be reset to empty with Max-Age=0.
    const raw = res.headers.get('set-cookie') ?? ''
    expect(raw).toMatch(/gbox_customer_session=;/)
    expect(raw.toLowerCase()).toContain('max-age=0')
  })

  it('303s to / on a browser form submit', async () => {
    const res = await fetch(`${baseUrl}/account/logout`, {
      method: 'POST',
      headers: {
        'x-forwarded-host': 'demo.gbox.test',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'gbox_customer_session=live.session.token',
      },
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    expect(revokeSession).toHaveBeenCalledWith('live.session.token')
  })

  it('still clears the cookie even when no session cookie was sent', async () => {
    const res = await fetch(`${baseUrl}/account/logout`, {
      method: 'POST',
      headers: {
        'x-forwarded-host': 'demo.gbox.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(revokeSession).not.toHaveBeenCalled()
    // Even with no cookie in, we still emit the clearing Set-Cookie
    // so any zombie cookie the browser has (e.g. from another tab)
    // gets wiped.
    const raw = res.headers.get('set-cookie') ?? ''
    expect(raw).toMatch(/gbox_customer_session=;/)
  })
})

// ---------------------------------------------------------------------------
// Negatives that apply to every route
// ---------------------------------------------------------------------------

describe('account routes — no resolved shop', () => {
  it('returns 404 when the host does not map to a shop', async () => {
    const res = await fetch(`${baseUrl}/account/login`, {
      method: 'POST',
      headers: {
        'x-forwarded-host': 'nobody.gbox.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
      redirect: 'manual',
    })
    // The resolve-shop middleware returns 404 before we get here.
    expect([404, 400]).toContain(res.status)
    expect(issueLoginCode).not.toHaveBeenCalled()
  })
})
