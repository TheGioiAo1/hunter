/**
 * Gbox Storefront — Theme preview middleware tests (Stage 3F.2)
 *
 * The middleware is the bridge between the admin-minted preview
 * token (`@gbox/core/modules/themes/preview-token`) and the
 * storefront handler's `getHandlerOptions` lookup. Its job, in one
 * sentence: "if `?preview_theme_id=X&preview_token=Y` is on the
 * URL AND verifies against our secret AND is scoped to the
 * current shop, stamp `req.gboxPreviewThemeId` and set
 * `X-Robots-Tag: noindex, nofollow`; otherwise leave the request
 * untouched."
 *
 * We test it with an Express instance wired up end-to-end (no
 * supertest) so the tests also cover the `declare module` merge
 * and the real header-writing pipeline.
 */

import { describe, it, expect } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { signPreviewToken } from '@gbox/core/modules/themes/preview-token.js'
import { buildThemePreviewMiddleware } from './theme-preview.js'

const SECRET = 'test-preview-secret-hmac-key-1234567890'

function stampShop(shopId: string) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.gboxShopId = shopId
    next()
  }
}

function probeRoute(app: express.Express) {
  app.get('/probe', (req, res) => {
    res.status(200).json({
      previewThemeId: req.gboxPreviewThemeId ?? null,
    })
  })
}

async function startApp(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` }
}

async function stopApp(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
}

// ---------------------------------------------------------------------------
// Fresh app per test — middleware is stateless but it's easier to
// reason about failure modes when nothing leaks between cases.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string

async function buildTestApp(shopId: string): Promise<void> {
  const app = express()
  app.use(stampShop(shopId))
  app.use(buildThemePreviewMiddleware({ secret: SECRET }))
  probeRoute(app)
  const started = await startApp(app)
  server = started.server
  baseUrl = started.baseUrl
}

// Vitest's afterEach can't easily close a server opened by an
// async helper, so each `it` closes its own server.

// ---------------------------------------------------------------------------
// Happy path — valid token stamps req + sets X-Robots-Tag
// ---------------------------------------------------------------------------

describe('theme-preview middleware — happy path', () => {
  it('stamps req.gboxPreviewThemeId when the token verifies', async () => {
    await buildTestApp('shop_1')
    try {
      const token = signPreviewToken(SECRET, {
        shopId: 'shop_1',
        themeId: 'theme_draft_1',
        adminId: 'admin_alice',
      })
      const res = await fetch(
        `${baseUrl}/probe?preview_theme_id=theme_draft_1&preview_token=${encodeURIComponent(token)}`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { previewThemeId: string | null }
      expect(body.previewThemeId).toBe('theme_draft_1')
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    } finally {
      await stopApp(server)
    }
  })

  it('leaves req.gboxPreviewThemeId undefined on a normal request', async () => {
    await buildTestApp('shop_1')
    try {
      const res = await fetch(`${baseUrl}/probe`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { previewThemeId: string | null }
      expect(body.previewThemeId).toBeNull()
      expect(res.headers.get('x-robots-tag')).toBeNull()
    } finally {
      await stopApp(server)
    }
  })

  it('requires BOTH preview_theme_id AND preview_token', async () => {
    await buildTestApp('shop_1')
    try {
      const res1 = await fetch(`${baseUrl}/probe?preview_theme_id=theme_x`)
      const body1 = (await res1.json()) as { previewThemeId: string | null }
      expect(body1.previewThemeId).toBeNull()

      const res2 = await fetch(`${baseUrl}/probe?preview_token=abc.def`)
      const body2 = (await res2.json()) as { previewThemeId: string | null }
      expect(body2.previewThemeId).toBeNull()
    } finally {
      await stopApp(server)
    }
  })
})

// ---------------------------------------------------------------------------
// Failure modes — invalid tokens must NEVER flip the active theme
// ---------------------------------------------------------------------------

describe('theme-preview middleware — failure modes', () => {
  it('ignores a token signed with a different secret', async () => {
    await buildTestApp('shop_1')
    try {
      const token = signPreviewToken('other-secret-0000000000', {
        shopId: 'shop_1',
        themeId: 'theme_draft_1',
        adminId: 'admin_alice',
      })
      const res = await fetch(
        `${baseUrl}/probe?preview_theme_id=theme_draft_1&preview_token=${encodeURIComponent(token)}`,
      )
      const body = (await res.json()) as { previewThemeId: string | null }
      expect(body.previewThemeId).toBeNull()
      expect(res.headers.get('x-robots-tag')).toBeNull()
    } finally {
      await stopApp(server)
    }
  })

  it('ignores a token whose themeId does not match the query param', async () => {
    await buildTestApp('shop_1')
    try {
      const token = signPreviewToken(SECRET, {
        shopId: 'shop_1',
        themeId: 'theme_draft_1',
        adminId: 'admin_alice',
      })
      const res = await fetch(
        `${baseUrl}/probe?preview_theme_id=theme_DIFFERENT&preview_token=${encodeURIComponent(token)}`,
      )
      const body = (await res.json()) as { previewThemeId: string | null }
      expect(body.previewThemeId).toBeNull()
      expect(res.headers.get('x-robots-tag')).toBeNull()
    } finally {
      await stopApp(server)
    }
  })

  it('ignores a token minted for a different shop', async () => {
    await buildTestApp('shop_1')
    try {
      const token = signPreviewToken(SECRET, {
        shopId: 'shop_2',
        themeId: 'theme_draft_1',
        adminId: 'admin_alice',
      })
      const res = await fetch(
        `${baseUrl}/probe?preview_theme_id=theme_draft_1&preview_token=${encodeURIComponent(token)}`,
      )
      const body = (await res.json()) as { previewThemeId: string | null }
      expect(body.previewThemeId).toBeNull()
      expect(res.headers.get('x-robots-tag')).toBeNull()
    } finally {
      await stopApp(server)
    }
  })

  it('ignores a malformed token string', async () => {
    await buildTestApp('shop_1')
    try {
      const res = await fetch(
        `${baseUrl}/probe?preview_theme_id=theme_draft_1&preview_token=not-a-token`,
      )
      const body = (await res.json()) as { previewThemeId: string | null }
      expect(body.previewThemeId).toBeNull()
    } finally {
      await stopApp(server)
    }
  })

  it('ignores a preview request when no shop has been resolved', async () => {
    // Skip the stampShop helper so req.gboxShopId is undefined.
    const app = express()
    app.use(buildThemePreviewMiddleware({ secret: SECRET }))
    probeRoute(app)
    const started = await startApp(app)
    try {
      const token = signPreviewToken(SECRET, {
        shopId: 'shop_1',
        themeId: 'theme_draft_1',
        adminId: 'admin_alice',
      })
      const res = await fetch(
        `${started.baseUrl}/probe?preview_theme_id=theme_draft_1&preview_token=${encodeURIComponent(token)}`,
      )
      const body = (await res.json()) as { previewThemeId: string | null }
      expect(body.previewThemeId).toBeNull()
    } finally {
      await stopApp(started.server)
    }
  })

  it('is disabled entirely when secret is empty', async () => {
    const app = express()
    app.use(stampShop('shop_1'))
    app.use(buildThemePreviewMiddleware({ secret: '' }))
    probeRoute(app)
    const started = await startApp(app)
    try {
      // Even a "valid looking" request is ignored because the
      // middleware refused to install itself without a secret.
      const res = await fetch(
        `${started.baseUrl}/probe?preview_theme_id=theme_draft_1&preview_token=anything.anything`,
      )
      const body = (await res.json()) as { previewThemeId: string | null }
      expect(body.previewThemeId).toBeNull()
      expect(res.headers.get('x-robots-tag')).toBeNull()
    } finally {
      await stopApp(started.server)
    }
  })
})
