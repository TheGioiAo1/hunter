/**
 * Gbox Storefront — Asset Middleware tests (Stage 3A.7)
 *
 * The asset middleware sits between the locale negotiator and the
 * main storefront handler. Its job: serve theme assets (CSS, JS,
 * SVG, fonts) under `/assets/*` by pulling them from the active
 * theme's TemplateLoader.
 *
 * Rules:
 *
 *   • Only handles GET / HEAD requests under `/assets/`.
 *   • Every other path is a pass-through — it calls `next()` without
 *     touching the response.
 *   • Logical path is `assets/<rest>` — the `assets/` prefix comes
 *     from the ThemeDir convention in loader.ts.
 *   • Path traversal (`..`, `.`) is rejected before hitting the
 *     loader — defence in depth even though loaders normalize too.
 *   • Content-Type is derived from the file extension. Unknown
 *     extensions fall back to `application/octet-stream`.
 *   • Cache-Control is immutable because theme versions are
 *     content-addressed: a theme edit creates a new theme row, so
 *     the URL never "changes meaning" for the same theme.
 *   • ETag is computed from the loader's `updatedAt` when present.
 *     `If-None-Match` triggers a 304.
 *   • Missing asset → 404 plain text. Loader throws → next(err).
 *
 * The loader is resolved per-request via `options.getLoader(req)`
 * because each shop has its own theme version and the resolver
 * middleware sets up the per-request context. A test can pass a
 * simple in-memory loader.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildAssetMiddleware } from './assets.js'
import type { TemplateLoader, LoadResult } from '@gbox/core/modules/themes/engine/loader.js'

// ---------------------------------------------------------------------------
// In-memory loader fake
// ---------------------------------------------------------------------------

function mkLoader(
  files: Record<string, string | { source: string; updatedAt?: string }>,
): TemplateLoader {
  const normalized: Record<string, LoadResult> = {}
  for (const [k, v] of Object.entries(files)) {
    normalized[k] = typeof v === 'string' ? { source: v } : v
  }
  return {
    name: 'memory:assets-test',
    async load(path) {
      return normalized[path]?.source ?? null
    },
    async loadWithMeta(path) {
      return normalized[path] ?? null
    },
    async exists(path) {
      return path in normalized
    },
    async list() {
      return Object.keys(normalized)
    },
  }
}

// ---------------------------------------------------------------------------
// Fake req / res builders
// ---------------------------------------------------------------------------

interface FakeReq {
  method: string
  url: string
  path: string
  headers: Record<string, string | undefined>
}

function mkReq(
  url: string,
  method = 'GET',
  headers: Record<string, string | undefined> = {},
): FakeReq {
  return {
    method,
    url,
    path: url.split('?')[0],
    headers,
  }
}

interface FakeRes {
  statusCode: number
  headers: Record<string, string>
  body: string | Buffer | null
  ended: boolean
  status(code: number): FakeRes
  set(name: string, value: string): FakeRes
  type(t: string): FakeRes
  send(body: string | Buffer): FakeRes
  end(body?: string | Buffer): FakeRes
  getHeader(name: string): string | undefined
}

function mkRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    status(code) {
      this.statusCode = code
      return this
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value
      return this
    },
    type(t) {
      this.headers['content-type'] = t
      return this
    },
    send(body) {
      this.body = body
      this.ended = true
      return this
    },
    end(body) {
      if (body !== undefined) this.body = body
      this.ended = true
      return this
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()]
    },
  }
  return res
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('asset middleware — routing', () => {
  it('passes through non-asset routes without touching the response', async () => {
    const loader = mkLoader({})
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/products/shirt')
    const res = mkRes()
    const next = vi.fn()
    await mw(req as never, res as never, next)
    expect(next).toHaveBeenCalledWith()
    expect(res.ended).toBe(false)
  })

  it('passes through non-GET/HEAD requests under /assets (POST etc)', async () => {
    const loader = mkLoader({ 'assets/theme.css': 'body{}' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.css', 'POST')
    const res = mkRes()
    const next = vi.fn()
    await mw(req as never, res as never, next)
    expect(next).toHaveBeenCalledWith()
    expect(res.ended).toBe(false)
  })

  it('handles HEAD requests (status + headers, empty body)', async () => {
    const loader = mkLoader({ 'assets/theme.css': 'body { color: red }' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.css', 'HEAD')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
    // HEAD returns empty body
    expect(res.body).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Content serving + content type
// ---------------------------------------------------------------------------

describe('asset middleware — serving', () => {
  it('serves a CSS asset with the correct content-type', async () => {
    const loader = mkLoader({ 'assets/theme.css': 'body { color: red }' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.css')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(res.body).toBe('body { color: red }')
  })

  it('serves a JS asset', async () => {
    const loader = mkLoader({ 'assets/theme.js': 'console.log(1)' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.js')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe(
      'application/javascript; charset=utf-8',
    )
  })

  it('serves an SVG asset', async () => {
    const loader = mkLoader({
      'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/logo.svg')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8')
  })

  it('serves a JSON asset', async () => {
    const loader = mkLoader({ 'assets/data.json': '{"a":1}' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/data.json')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
  })

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const loader = mkLoader({ 'assets/mystery.xyz': 'whatever' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/mystery.xyz')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
  })

  it('serves nested asset paths (e.g. assets/fonts/foo.woff)', async () => {
    const loader = mkLoader({ 'assets/fonts/foo.woff2': 'BINARY' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/fonts/foo.woff2')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('font/woff2')
  })
})

// ---------------------------------------------------------------------------
// Caching: Cache-Control + ETag + 304
// ---------------------------------------------------------------------------

describe('asset middleware — caching', () => {
  it('sets Cache-Control: public, max-age=31536000, immutable', async () => {
    const loader = mkLoader({ 'assets/theme.css': 'body{}' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.css')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )
  })

  it('sets an ETag header derived from updatedAt when available', async () => {
    const loader = mkLoader({
      'assets/theme.css': {
        source: 'body{}',
        updatedAt: '2026-04-09T10:00:00.000Z',
      },
    })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.css')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.headers['etag']).toBeDefined()
    expect(res.headers['etag']).toMatch(/^"[a-zA-Z0-9+/=_-]+"$/)
  })

  it('returns 304 when If-None-Match matches the current ETag', async () => {
    const loader = mkLoader({
      'assets/theme.css': {
        source: 'body{}',
        updatedAt: '2026-04-09T10:00:00.000Z',
      },
    })
    const mw = buildAssetMiddleware({ getLoader: () => loader })

    // First request: get the ETag
    const res1 = mkRes()
    await mw(mkReq('/assets/theme.css') as never, res1 as never, vi.fn())
    const etag = res1.headers['etag']
    expect(etag).toBeDefined()

    // Second request: send it back as If-None-Match
    const res2 = mkRes()
    await mw(
      mkReq('/assets/theme.css', 'GET', { 'if-none-match': etag }) as never,
      res2 as never,
      vi.fn(),
    )
    expect(res2.statusCode).toBe(304)
    expect(res2.body).toBe('')
  })

  it('serves fresh content when If-None-Match does not match', async () => {
    const loader = mkLoader({
      'assets/theme.css': {
        source: 'body{}',
        updatedAt: '2026-04-09T10:00:00.000Z',
      },
    })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.css', 'GET', {
      'if-none-match': '"stale-etag"',
    })
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('body{}')
  })
})

// ---------------------------------------------------------------------------
// CDN headers (Phase 8.3)
// ---------------------------------------------------------------------------
//
// Assets are served behind Cloudflare in production. The middleware
// emits a small handful of headers that let the edge cache + revalidate
// independently of the browser cache, sniff-protect MIME types, and
// allow cross-origin font loading.

describe('asset middleware — CDN headers', () => {
  it('sets CDN-Cache-Control to the same long-lived directive as Cache-Control', async () => {
    const loader = mkLoader({ 'assets/theme.css': 'body{}' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.css')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.headers['cdn-cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )
  })

  it('sets X-Content-Type-Options: nosniff to defeat MIME sniffing', async () => {
    const loader = mkLoader({ 'assets/theme.js': 'console.log(1)' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.js')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('sets Vary: Accept-Encoding so the edge caches gzip/br variants separately', async () => {
    const loader = mkLoader({ 'assets/theme.css': 'body{}' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.css')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.headers['vary']).toBe('Accept-Encoding')
  })

  it('emits Access-Control-Allow-Origin: * for woff2 fonts (CORS font loading)', async () => {
    const loader = mkLoader({ 'assets/fonts/inter.woff2': 'BINARY' })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/fonts/inter.woff2')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('emits CORS for woff, ttf, otf as well', async () => {
    for (const file of ['fonts/a.woff', 'fonts/a.ttf', 'fonts/a.otf']) {
      const loader = mkLoader({ [`assets/${file}`]: 'BINARY' })
      const mw = buildAssetMiddleware({ getLoader: () => loader })
      const res = mkRes()
      await mw(mkReq(`/assets/${file}`) as never, res as never, vi.fn())
      expect(res.headers['access-control-allow-origin']).toBe('*')
    }
  })

  it('does NOT emit CORS for non-font assets (CSS/JS/SVG)', async () => {
    const loader = mkLoader({
      'assets/theme.css': 'body{}',
      'assets/theme.js': 'x',
      'assets/logo.svg': '<svg/>',
    })
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    for (const path of ['/assets/theme.css', '/assets/theme.js', '/assets/logo.svg']) {
      const res = mkRes()
      await mw(mkReq(path) as never, res as never, vi.fn())
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('returns Cache-Control: no-store on 404 so transient misses do not pin at the edge', async () => {
    const loader = mkLoader({})
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/missing.css')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(404)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('returns Cache-Control: no-store on 400 (bad path) so attackers can not pollute the edge', async () => {
    const loader = mkLoader({})
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/../etc/passwd')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(400)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('still sets Cache-Control + ETag on 304 so the edge can refresh its TTL', async () => {
    const loader = mkLoader({
      'assets/theme.css': {
        source: 'body{}',
        updatedAt: '2026-04-09T10:00:00.000Z',
      },
    })
    const mw = buildAssetMiddleware({ getLoader: () => loader })

    const res1 = mkRes()
    await mw(mkReq('/assets/theme.css') as never, res1 as never, vi.fn())
    const etag = res1.headers['etag']

    const res2 = mkRes()
    await mw(
      mkReq('/assets/theme.css', 'GET', { 'if-none-match': etag }) as never,
      res2 as never,
      vi.fn(),
    )
    expect(res2.statusCode).toBe(304)
    expect(res2.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(res2.headers['etag']).toBe(etag)
  })
})

// ---------------------------------------------------------------------------
// Errors / 404
// ---------------------------------------------------------------------------

describe('asset middleware — errors', () => {
  it('404s missing assets', async () => {
    const loader = mkLoader({})
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/missing.css')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(404)
    expect(res.ended).toBe(true)
  })

  it('rejects path traversal (..)', async () => {
    const loader = mkLoader({ 'assets/theme.css': 'body{}' })
    const load = vi.spyOn(loader, 'loadWithMeta')
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/../config/settings_data.json')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(400)
    expect(load).not.toHaveBeenCalled()
  })

  it('rejects encoded path traversal (%2e%2e)', async () => {
    const loader = mkLoader({})
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/%2e%2e/config.json')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(400)
  })

  it('propagates loader errors via next(err)', async () => {
    const loader: TemplateLoader = {
      name: 'memory:asset-error-test',
      async load() {
        throw new Error('db down')
      },
      async loadWithMeta() {
        throw new Error('db down')
      },
      async exists() {
        return false
      },
      async list() {
        return []
      },
    }
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/theme.css')
    const next = vi.fn()
    await mw(req as never, mkRes() as never, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it('404s when no loader is available for the current shop', async () => {
    const mw = buildAssetMiddleware({ getLoader: () => null })
    const req = mkReq('/assets/theme.css')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(404)
  })

  it('rejects empty asset path (/assets/)', async () => {
    const loader = mkLoader({})
    const mw = buildAssetMiddleware({ getLoader: () => loader })
    const req = mkReq('/assets/')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(404)
  })

  it('supports async getLoader (returns a Promise)', async () => {
    const loader = mkLoader({ 'assets/theme.css': 'body{}' })
    const mw = buildAssetMiddleware({
      getLoader: async () => loader,
    })
    const req = mkReq('/assets/theme.css')
    const res = mkRes()
    await mw(req as never, res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('body{}')
  })
})
