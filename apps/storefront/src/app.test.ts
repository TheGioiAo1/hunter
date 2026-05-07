/**
 * Gbox Storefront — App Factory Tests (Stage 3A.1)
 *
 * These are the bootstrap smoke tests for the storefront Express app.
 * They intentionally avoid any database or theme engine wiring — every
 * later stage adds its own middleware tests and integration tests that
 * pull in the real pieces.
 *
 * At this stage the app must:
 *   1. Return a working Express instance from `buildApp()`.
 *   2. Respond to `GET /_health` with 200 + a JSON status envelope.
 *   3. Return a 404 for any unmapped path (default Express behaviour
 *      is fine for now — 3A.9 swaps this for a template-rendered 404).
 *
 * Tests run the app through Node's built-in http server on an ephemeral
 * port and hit it with native `fetch`, so no supertest dependency is
 * required (keeps dev deps lean and mirrors how other packages test
 * HTTP handlers).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// The storefront's helmet config reads NODE_ENV at module load to decide
// whether to emit HSTS + upgrade-insecure-requests (both are off in dev
// to stop dev boxes served over http:// from locking browsers out — see
// packages/core/src/modules/security/headers.ts). These tests lock in
// the *production* contract (HSTS present), so pin NODE_ENV before the
// app module is imported.
process.env.NODE_ENV = 'production'
const { buildApp } = await import('./app.js')

let server: Server
let baseUrl: string

beforeAll(async () => {
  const app = buildApp()
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

describe('buildApp (Stage 3A.1 scaffold)', () => {
  it('returns an Express-compatible request handler (callable as (req, res))', () => {
    const app = buildApp()
    // Express apps are functions with `(req, res, next?) => void`
    expect(typeof app).toBe('function')
    // Express exposes `app.use` on the returned object
    expect(typeof (app as unknown as { use: unknown }).use).toBe('function')
  })

  it('responds 200 with a JSON health envelope on GET /_health', async () => {
    const res = await fetch(`${baseUrl}/_health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      service: string
      timestamp: string
    }
    expect(body.status).toBe('ok')
    expect(body.service).toBe('gbox-storefront')
    expect(typeof body.timestamp).toBe('string')
    // The timestamp should parse as a valid date within the last minute
    const t = Date.parse(body.timestamp)
    expect(Number.isNaN(t)).toBe(false)
    expect(Math.abs(Date.now() - t)).toBeLessThan(60_000)
  })

  it('returns the application/json content type for the health check', async () => {
    const res = await fetch(`${baseUrl}/_health`)
    const ctype = res.headers.get('content-type') ?? ''
    expect(ctype.toLowerCase()).toContain('application/json')
  })

  it('returns 404 for an unmapped path (default Express handler for now)', async () => {
    const res = await fetch(`${baseUrl}/this-route-does-not-exist`)
    expect(res.status).toBe(404)
    // 3A.9 will replace this with a template-rendered 404; Stage 3A.1
    // only asserts that the status code is right so later stages can
    // lock in richer behaviour.
  })

  // -----------------------------------------------------------------
  // Stage 3A.2 — request-context wiring, observed through live HTTP
  // -----------------------------------------------------------------

  it('stamps a fresh X-Request-ID header on /_health (Stage 3A.2)', async () => {
    const res = await fetch(`${baseUrl}/_health`)
    const reqId = res.headers.get('x-request-id')
    expect(reqId).toBeTruthy()
    expect(reqId!.length).toBeGreaterThan(0)
  })

  it('reuses a valid upstream X-Request-ID when the proxy sends one (Stage 3A.2)', async () => {
    const res = await fetch(`${baseUrl}/_health`, {
      headers: { 'x-request-id': 'upstream-abc-1234' },
    })
    expect(res.headers.get('x-request-id')).toBe('upstream-abc-1234')
  })

  it('generates a new X-Request-ID when the upstream header is malformed (Stage 3A.2)', async () => {
    const res = await fetch(`${baseUrl}/_health`, {
      headers: { 'x-request-id': 'bad header with spaces' },
    })
    const reqId = res.headers.get('x-request-id')
    expect(reqId).toBeTruthy()
    expect(reqId).not.toBe('bad header with spaces')
  })

  it('stamps X-Request-ID even on 404 responses (Stage 3A.2)', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist-nope`)
    expect(res.status).toBe(404)
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  // -----------------------------------------------------------------
  // Stage 3A.3 — storefront security headers visible over HTTP
  // -----------------------------------------------------------------

  it('sets Content-Security-Policy on every response (Stage 3A.3)', async () => {
    const res = await fetch(`${baseUrl}/_health`)
    const csp = res.headers.get('content-security-policy')
    expect(csp).toBeTruthy()
    expect(csp!).toContain("default-src 'self'")
    expect(csp!).toContain("object-src 'none'")
  })

  it('sets Strict-Transport-Security (Stage 3A.3)', async () => {
    const res = await fetch(`${baseUrl}/_health`)
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/)
  })

  it('sets X-Content-Type-Options nosniff (Stage 3A.3)', async () => {
    const res = await fetch(`${baseUrl}/_health`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('sets Referrer-Policy (Stage 3A.3)', async () => {
    const res = await fetch(`${baseUrl}/_health`)
    expect(res.headers.get('referrer-policy')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Phase 6.1 — Injectable health handler
// ---------------------------------------------------------------------------
//
// Production binds `healthHandler` to `healthCheck(db)` from
// `@gbox/core/modules/monitoring/metrics` so the probe pings Postgres
// + Redis. Tests need to be sure the override is honoured AND that the
// default zero-dep handler still kicks in when the option is omitted.

describe('buildApp /_health override (Phase 6.1)', () => {
  let overrideServer: Server
  let overrideBaseUrl: string

  beforeAll(async () => {
    const app = buildApp({
      healthHandler: (_req, res) => {
        res.status(200).json({
          status: 'healthy',
          checks: { database: 'ok', redis: 'ok' },
          custom: 'phase-6-canary',
        })
      },
    })
    overrideServer = createServer(app)
    await new Promise<void>((resolve) =>
      overrideServer.listen(0, '127.0.0.1', resolve),
    )
    const addr = overrideServer.address() as AddressInfo
    overrideBaseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      overrideServer.close((err) => (err ? reject(err) : resolve())),
    )
  })

  it('uses the injected health handler when one is supplied', async () => {
    const res = await fetch(`${overrideBaseUrl}/_health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      checks: { database: string; redis: string }
      custom: string
    }
    expect(body.status).toBe('healthy')
    expect(body.checks.database).toBe('ok')
    expect(body.checks.redis).toBe('ok')
    expect(body.custom).toBe('phase-6-canary')
  })

  it('still applies security headers to the overridden /_health', async () => {
    const res = await fetch(`${overrideBaseUrl}/_health`)
    expect(res.headers.get('content-security-policy')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Phase 3D close-the-loop — Edge cache headers propagate over real HTTP
// ---------------------------------------------------------------------------
//
// These tests stand up a fresh Express instance with `edgeCache: {}` set
// and hit it with native fetch to prove that:
//
//   1. The middleware stamps Cache-Control + CDN-Cache-Control + Vary on
//      a public HTML request (via the storefront_html_swr preset).
//   2. /_health is excluded — the monitor endpoint must NOT get a
//      Cache-Control header, so nothing downstream can cache a stale
//      "ok" response.
//   3. A mutation route (/cart.js POST with no cart-router installed
//      still flows through edge-cache before the 404) gets no_store.
//   4. An asset path gets the immutable 1-year preset even though we
//      don't mount a real asset middleware — the preset chain runs BEFORE
//      assets so this is the pure path→preset contract.
//
// Keeping this in app.test.ts (instead of a new file) means the existing
// buildApp setup runs once and the edge-cache tests share the beforeAll
// cost — they're measuring headers, not behaviour, so there's no risk
// of cross-contamination with the stage-3A scaffold tests above.

describe('buildApp edge-cache headers (Phase 3D close-the-loop)', () => {
  let edgeServer: Server
  let edgeBaseUrl: string

  beforeAll(async () => {
    const app = buildApp({ edgeCache: {} })
    edgeServer = createServer(app)
    await new Promise<void>((resolve) =>
      edgeServer.listen(0, '127.0.0.1', resolve),
    )
    const addr = edgeServer.address() as AddressInfo
    edgeBaseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      edgeServer.close((err) => (err ? reject(err) : resolve())),
    )
  })

  it('stamps storefront_html_swr on a public HTML 404 fallthrough', async () => {
    // No storefront handler is mounted in this app, so the request
    // 404s — but the edge-cache middleware runs BEFORE the 404, so
    // the response still carries the public HTML preset. We use the
    // 404 path on purpose because it proves the policy applies to
    // error responses, not just successful renders.
    const res = await fetch(`${edgeBaseUrl}/products/tee-black`)
    expect(res.status).toBe(404)
    const cacheControl = res.headers.get('cache-control') ?? ''
    expect(cacheControl).toContain('must-revalidate')
    expect(res.headers.get('cdn-cache-control') ?? '').toContain('max-age=60')
    expect(res.headers.get('vary') ?? '').toContain('Accept-Language')
  })

  it('does NOT stamp Cache-Control on /_health (monitor exclusion)', async () => {
    const res = await fetch(`${edgeBaseUrl}/_health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBeNull()
    expect(res.headers.get('cdn-cache-control')).toBeNull()
  })

  it('stamps no_store on a POST mutation path', async () => {
    const res = await fetch(`${edgeBaseUrl}/products/tee-black`, {
      method: 'POST',
    })
    // 404 because no POST handler is mounted, but the header still
    // flowed through edge-cache.
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('cdn-cache-control')).toBe('no-store')
  })

  it('stamps theme_asset_immutable on /assets/* paths', async () => {
    const res = await fetch(`${edgeBaseUrl}/assets/theme.css`)
    const cacheControl = res.headers.get('cache-control') ?? ''
    expect(cacheControl).toContain('max-age=31536000')
    expect(cacheControl).toContain('immutable')
  })

  it('stamps personalised_private on /cart.js', async () => {
    const res = await fetch(`${edgeBaseUrl}/cart.js`)
    expect(res.headers.get('cache-control') ?? '').toContain('private')
    expect(res.headers.get('cdn-cache-control')).toBe('no-store')
  })
})

// ---------------------------------------------------------------------------
// Phase 3D close-the-loop — Edge cache middleware is opt-in
// ---------------------------------------------------------------------------
//
// The existing stage-3A scaffold tests above call `buildApp()` with no
// options. This test locks in the contract that such a bare app still
// returns responses WITHOUT Cache-Control — so unit tests that predate
// Phase 3D never start seeing surprise headers.

describe('buildApp edge-cache opt-in (Phase 3D close-the-loop)', () => {
  it('leaves Cache-Control unset when edgeCache option is omitted', async () => {
    const app = buildApp()
    const bareServer = createServer(app)
    await new Promise<void>((resolve) =>
      bareServer.listen(0, '127.0.0.1', resolve),
    )
    try {
      const addr = bareServer.address() as AddressInfo
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/products/tee-black`,
      )
      expect(res.headers.get('cache-control')).toBeNull()
      expect(res.headers.get('cdn-cache-control')).toBeNull()
    } finally {
      await new Promise<void>((resolve, reject) =>
        bareServer.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 0 close-the-loop — sanitize middleware wired end-to-end
// ---------------------------------------------------------------------------
//
// The storefront mounts `sanitizeResponseMiddleware()` unconditionally
// right after security headers so every `res.json(...)` call is
// scrubbed of password_hash / tokens / secrets before it leaves the
// process. These tests inject a leaky health handler that tries to
// return sensitive fields and assert the wire payload is clean — the
// only way to prove the middleware is actually on the chain.
//
// The storefront itself (today) doesn't emit any user JSON through
// `/_health`, but the override is the cleanest injection seam for
// the factory and the behaviour is the same as any future route
// that calls `res.json({ user })`.

describe('buildApp sanitize middleware (Phase 0 close-the-loop)', () => {
  let leakServer: Server
  let leakBaseUrl: string

  beforeAll(async () => {
    const app = buildApp({
      healthHandler: (_req, res) => {
        // Pretend this is a real handler that forgot to project
        // sensitive columns out of its select list. The middleware
        // should catch the mistake on the way out.
        res.status(200).json({
          status: 'ok',
          user: {
            id: 'usr_1',
            email: 'alice@example.com',
            password_hash: '$2b$12$leaked-hash-value',
            session_token: 'leaked-session-token',
          },
          api_key: 'sk_live_leaked',
        })
      },
    })
    leakServer = createServer(app)
    await new Promise<void>((resolve) =>
      leakServer.listen(0, '127.0.0.1', resolve),
    )
    const addr = leakServer.address() as AddressInfo
    leakBaseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      leakServer.close((err) => (err ? reject(err) : resolve())),
    )
  })

  it('strips password_hash / session_token / api_key from the wire payload', async () => {
    const res = await fetch(`${leakBaseUrl}/_health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    // Safe fields survive.
    expect(body.status).toBe('ok')
    expect(body.user.id).toBe('usr_1')
    expect(body.user.email).toBe('alice@example.com')
    // Sensitive fields scrubbed.
    expect(body.user).not.toHaveProperty('password_hash')
    expect(body.user).not.toHaveProperty('session_token')
    expect(body).not.toHaveProperty('api_key')
  })
})
