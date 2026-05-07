/**
 * Gbox Platform — Storefront Server (Multi-Tenant)
 *
 * Express server that renders storefronts through the Shopify-compatible
 * LiquidJS engine. Supports multiple shops via Host-header-based routing:
 *
 *   1. Incoming request → extract Host header
 *   2. Look up `shops` table for matching `domain`
 *   3. Lazily build & cache engine per shop (loader, datasource, i18n)
 *   4. Render with the shop-specific engine
 *
 * If no matching shop is found for the Host, returns a friendly 404.
 */

import 'dotenv/config'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'

import { createLiquidEngine } from '@gbox/core/modules/themes/engine/liquid.js'
import { DbLoader } from '@gbox/core/modules/themes/engine/storefront/db-loader.js'
import { DbDataSource } from '@gbox/core/modules/themes/engine/storefront/db-datasource.js'
import { createExpressStorefrontHandler } from '@gbox/core/modules/themes/engine/storefront/express-adapter.js'
import { createDefaultErrorLogger } from '@gbox/core/modules/themes/engine/storefront/error-logger.js'
import { prepareThemeConfig } from '@gbox/core/modules/themes/engine/storefront/theme-config-loader.js'
import { MemoryI18nService } from '@gbox/core/modules/i18n/memory-service.js'
import { buildAssetMiddleware } from './apps/storefront/src/middleware/assets.js'

// Customer auth
import {
  issueLoginCode,
  verifyOtpCode,
  verifyMagicLink,
  revokeSession,
  CUSTOMER_COOKIE_NAME,
} from '@gbox/core/modules/customer-auth/service.js'

// Cart service
import {
  CartService,
  redisCartStore,
} from '@gbox/core/modules/cart/service.js'

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new Kysely<any>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  }),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flatten(
  obj: any,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = String(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// Multi-tenant shop engine cache
// ---------------------------------------------------------------------------

interface ShopEngine {
  shopId: string
  shopName: string
  handler: (req: any, res: any, next: any) => Promise<void>
  cachedAt: number
}

/** Cache engines per domain. TTL = 5 minutes to pick up theme changes. */
const engineCache = new Map<string, ShopEngine>()
const ENGINE_TTL_MS = 5 * 60 * 1000

/** Domains we already know don't exist — short negative cache (30s). */
const negativeCache = new Map<string, number>()
const NEGATIVE_TTL_MS = 30 * 1000

/**
 * Build a storefront engine for a specific shop + theme.
 */
async function buildShopEngine(shopId: string, shopName: string): Promise<ShopEngine | null> {
  // Find the main theme for this shop
  const theme = await db
    .selectFrom('themes' as any)
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('role', '=', 'main')
    .executeTakeFirst()
    .catch(() => null)

  if (!theme) {
    console.warn(`[storefront] No main theme for shop ${shopName} (${shopId})`)
    return null
  }

  const themeId = (theme as any).id
  const loader = new DbLoader(db, themeId)

  // Load locale files
  const i18nSeed: Record<string, Record<string, Record<string, string>>> = {}
  const localeKeys = await loader.list('locales/')
  for (const key of localeKeys) {
    if (key.includes('.schema.')) continue
    const src = await loader.load(key)
    if (!src) continue
    try {
      const parsed = JSON.parse(src)
      const match = key.match(/locales\/([a-z]{2})(?:\.default)?\.json$/i)
      if (match) {
        const locale = match[1]!
        if (!i18nSeed[shopId]) i18nSeed[shopId] = {}
        i18nSeed[shopId]![locale] = flatten(parsed)
      }
    } catch {
      console.warn(`[storefront] Failed to parse locale: ${key}`)
    }
  }

  const i18n = new MemoryI18nService(i18nSeed)
  const engine = createLiquidEngine({ loader, i18n })

  // Theme config
  let themeConfig
  try {
    const result = await prepareThemeConfig({ loader, i18n, shopId })
    themeConfig = result.themeConfig
  } catch (err) {
    console.warn(`[storefront] Failed to load theme config for ${shopName}:`, err)
  }

  const datasource = new DbDataSource(db, shopId)
  const errorLogger = createDefaultErrorLogger()

  const handler = createExpressStorefrontHandler({
    engine,
    datasource,
    errorLogger,
    locales: { supported: ['en', 'vi'], default: 'en' },
    themeConfig,
  })

  console.log(`[storefront] Engine ready for ${shopName} (${shopId.slice(0, 8)})`)

  return {
    shopId,
    shopName,
    handler: handler as any,
    cachedAt: Date.now(),
  }
}

/**
 * Resolve Host header → shop engine. Caches the engine per domain.
 */
async function resolveEngine(host: string): Promise<ShopEngine | null> {
  // Strip port from host (e.g. "tw3.store:4326" → "tw3.store")
  const domain = host.split(':')[0]?.toLowerCase() ?? ''
  if (!domain) return null

  // Check negative cache
  const negTs = negativeCache.get(domain)
  if (negTs && Date.now() - negTs < NEGATIVE_TTL_MS) return null

  // Check engine cache
  const cached = engineCache.get(domain)
  if (cached && Date.now() - cached.cachedAt < ENGINE_TTL_MS) return cached

  // Look up shop by domain
  const shop = await db
    .selectFrom('shops' as any)
    .selectAll()
    .where('domain', '=', domain)
    .where('status', '=', 'active')
    .executeTakeFirst()
    .catch(() => null)

  // Also check shop_domains table for custom domains
  let resolvedShop = shop
  if (!resolvedShop) {
    const customDomain = await db
      .selectFrom('shop_domains' as any)
      .selectAll()
      .where('domain', '=', domain)
      .executeTakeFirst()
      .catch(() => null)

    if (customDomain) {
      resolvedShop = await db
        .selectFrom('shops' as any)
        .selectAll()
        .where('id', '=', (customDomain as any).shop_id)
        .where('status', '=', 'active')
        .executeTakeFirst()
        .catch(() => null)
    }
  }

  if (!resolvedShop) {
    negativeCache.set(domain, Date.now())
    return null
  }

  const shopId = (resolvedShop as any).id
  const shopName = (resolvedShop as any).name

  const eng = await buildShopEngine(shopId, shopName)
  if (!eng) {
    negativeCache.set(domain, Date.now())
    return null
  }

  engineCache.set(domain, eng)
  return eng
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

// Cookie parser — needed for session/cart cookies
import cookieParser from 'cookie-parser'
app.use(cookieParser())

// ---------------------------------------------------------------------------
// Static file serving for cloned assets (images, JS, etc.)
// ---------------------------------------------------------------------------
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const CLONE_ASSETS_DIR = join(process.cwd(), 'clone-assets')
if (existsSync(CLONE_ASSETS_DIR)) {
  app.use('/clone-assets', express.static(CLONE_ASSETS_DIR, {
    maxAge: '7d',
    immutable: true,
    setHeaders: (res, filePath) => {
      // CORS for fonts
      if (/\.(woff2?|ttf|otf|eot)$/i.test(filePath)) {
        res.setHeader('Access-Control-Allow-Origin', '*')
      }
    },
  }))
  console.log(`[storefront] Serving clone assets from ${CLONE_ASSETS_DIR}`)
} else {
  console.log(`[storefront] No clone-assets directory found, will create on first clone`)
}

// Health check — always available
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'gbox-storefront',
    engine: 'liquid-multitenant',
    cached_shops: engineCache.size,
    timestamp: new Date().toISOString(),
  })
})

// ---------------------------------------------------------------------------
// Cart service (Redis-backed)
// ---------------------------------------------------------------------------

let cartService: CartService
try {
  cartService = new CartService(redisCartStore())
} catch {
  console.warn('[storefront] Redis not available for cart — using in-memory fallback')
  // In-memory fallback for development
  const store = new Map<string, any>()
  cartService = new CartService({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: any) => { store.set(k, v) },
    del: async (k: string) => { store.delete(k) },
  } as any)
}

// ---------------------------------------------------------------------------
// Middleware: resolve shop from Host header
// ---------------------------------------------------------------------------

async function resolveShopFromHost(host: string) {
  const domain = host.split(':')[0]?.toLowerCase() ?? ''
  if (!domain) return null
  const shop = await db
    .selectFrom('shops' as any)
    .selectAll()
    .where('domain', '=', domain)
    .where('status', '=', 'active')
    .executeTakeFirst()
    .catch(() => null)
  if (shop) return shop
  const customDomain = await db
    .selectFrom('shop_domains' as any)
    .selectAll()
    .where('domain', '=', domain)
    .executeTakeFirst()
    .catch(() => null)
  if (!customDomain) return null
  return db
    .selectFrom('shops' as any)
    .selectAll()
    .where('id', '=', (customDomain as any).shop_id)
    .where('status', '=', 'active')
    .executeTakeFirst()
    .catch(() => null)
}

// ---------------------------------------------------------------------------
// POST /account/login — Issue magic link + OTP
// ---------------------------------------------------------------------------

app.post('/account/login', async (req: Request, res: Response) => {
  const host = (req.hostname ?? req.headers.host ?? '') as string
  const shop = await resolveShopFromHost(host)
  if (!shop) { res.status(404).send('Store not found'); return }

  const email = req.body?.customer?.email || req.body?.email
  if (!email) {
    res.redirect('/account/login?error=email_required')
    return
  }

  try {
    const result = await issueLoginCode(db as any, (shop as any).id, email, req.ip)
    // In production: send email via queue. In dev: show the code.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[storefront] OTP for ${email}: ${result.otpCode}`)
    }
    // TODO: Queue email delivery with magic link token
    res.redirect(`/account/login?step=verify&email=${encodeURIComponent(email)}`)
  } catch (err: any) {
    console.error('[storefront] Login error:', err.message)
    res.redirect(`/account/login?error=${err.code || 'unknown'}`)
  }
})

// POST /account/login/verify — Verify OTP code
app.post('/account/login/verify', async (req: Request, res: Response) => {
  const host = (req.hostname ?? req.headers.host ?? '') as string
  const shop = await resolveShopFromHost(host)
  if (!shop) { res.status(404).send('Store not found'); return }

  const email = req.body?.email
  const code = req.body?.code
  if (!email || !code) {
    res.redirect('/account/login?error=missing_fields')
    return
  }

  try {
    const result = await verifyOtpCode(db as any, (shop as any).id, email, code, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })

    // Set session cookie
    res.cookie(CUSTOMER_COOKIE_NAME, result.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: result.sessionExpiresAt,
    })

    // Also set the _session cookie (used by the Liquid router datasource)
    res.cookie('_session', result.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: result.sessionExpiresAt,
    })

    res.redirect('/account')
  } catch (err: any) {
    console.error('[storefront] Verify error:', err.message)
    res.redirect(`/account/login?step=verify&email=${encodeURIComponent(email)}&error=${err.code || 'invalid_code'}`)
  }
})

// GET /account/verify — Magic link verification (from email)
app.get('/account/verify', async (req: Request, res: Response) => {
  const host = (req.hostname ?? req.headers.host ?? '') as string
  const shop = await resolveShopFromHost(host)
  if (!shop) { res.status(404).send('Store not found'); return }

  const email = req.query.email as string
  const token = req.query.token as string
  if (!email || !token) {
    res.redirect('/account/login?error=invalid_link')
    return
  }

  try {
    const result = await verifyMagicLink(db as any, (shop as any).id, email, token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })

    res.cookie(CUSTOMER_COOKIE_NAME, result.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: result.sessionExpiresAt,
    })
    res.cookie('_session', result.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: result.sessionExpiresAt,
    })

    res.redirect('/account')
  } catch (err: any) {
    res.redirect(`/account/login?error=${err.code || 'invalid_link'}`)
  }
})

// GET /account/logout — Revoke session and clear cookie
app.get('/account/logout', async (req: Request, res: Response) => {
  const token = req.cookies?.[CUSTOMER_COOKIE_NAME] || req.cookies?.['_session']
  if (token) {
    await revokeSession(db as any, token).catch(() => {})
  }
  res.clearCookie(CUSTOMER_COOKIE_NAME, { path: '/' })
  res.clearCookie('_session', { path: '/' })
  res.redirect('/')
})

// ---------------------------------------------------------------------------
// POST /cart/add — Add item to cart
// ---------------------------------------------------------------------------

app.post('/cart/add', async (req: Request, res: Response) => {
  const host = (req.hostname ?? req.headers.host ?? '') as string
  const shop = await resolveShopFromHost(host)
  if (!shop) { res.status(404).send('Store not found'); return }

  const shopId = (shop as any).id
  const variantId = req.body?.id || req.body?.variant_id
  const quantity = parseInt(req.body?.quantity || '1', 10) || 1

  if (!variantId) {
    res.redirect('/cart?error=no_variant')
    return
  }

  try {
    const cartToken = req.cookies?.cart || null
    const cart = await cartService.addItem(cartToken, shopId, {
      variant_id: variantId,
      quantity,
    })

    // Set cart cookie
    res.cookie('cart', cart.token, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 14 * 86400 * 1000, // 14 days
    })

    // If AJAX (fetch/XHR), return JSON
    if (req.headers.accept?.includes('application/json') || req.xhr) {
      res.json({ cart, item_count: cart.lines.reduce((s, l) => s + l.quantity, 0) })
    } else {
      res.redirect('/cart')
    }
  } catch (err: any) {
    console.error('[storefront] Cart add error:', err.message)
    res.redirect('/cart?error=add_failed')
  }
})

// POST /cart/update — Update cart line quantities
app.post('/cart/update', async (req: Request, res: Response) => {
  const host = (req.hostname ?? req.headers.host ?? '') as string
  const shop = await resolveShopFromHost(host)
  if (!shop) { res.status(404).send('Store not found'); return }

  const cartToken = req.cookies?.cart
  if (!cartToken) { res.redirect('/cart'); return }

  try {
    // Shopify-compatible: updates = { variant_id: quantity, ... }
    const updates = req.body?.updates
    if (updates && typeof updates === 'object') {
      for (const [variantId, qty] of Object.entries(updates)) {
        const quantity = parseInt(String(qty), 10)
        if (quantity <= 0) {
          await cartService.removeLine(cartToken, variantId)
        } else {
          await cartService.updateLine(cartToken, variantId, quantity)
        }
      }
    }

    // Single line update
    const lineId = req.body?.line || req.body?.variant_id
    const lineQty = parseInt(req.body?.quantity || '0', 10)
    if (lineId) {
      if (lineQty <= 0) {
        await cartService.removeLine(cartToken, lineId)
      } else {
        await cartService.updateLine(cartToken, lineId, lineQty)
      }
    }

    if (req.headers.accept?.includes('application/json') || req.xhr) {
      const cart = await cartService.getCart(cartToken)
      res.json({ cart, item_count: cart?.lines.reduce((s, l) => s + l.quantity, 0) ?? 0 })
    } else {
      res.redirect('/cart')
    }
  } catch (err: any) {
    console.error('[storefront] Cart update error:', err.message)
    res.redirect('/cart?error=update_failed')
  }
})

// POST /cart/clear — Clear entire cart
app.post('/cart/clear', async (req: Request, res: Response) => {
  const cartToken = req.cookies?.cart
  if (cartToken) {
    await cartService.clearCart(cartToken).catch(() => {})
  }
  res.clearCookie('cart', { path: '/' })
  res.redirect('/cart')
})

// ---------------------------------------------------------------------------
// Asset middleware — serves /assets/* from theme_assets table
// ---------------------------------------------------------------------------

/** Cache of shopDomain → active themeId (TTL 60s) */
const themeIdCache = new Map<string, { themeId: string; ts: number }>()
const THEME_ID_TTL = 60_000

async function getActiveThemeIdForHost(host: string): Promise<string | null> {
  const domain = host.split(':')[0]?.toLowerCase() ?? ''
  if (!domain) return null

  const cached = themeIdCache.get(domain)
  if (cached && Date.now() - cached.ts < THEME_ID_TTL) return cached.themeId

  // Resolve shop
  const shop = await resolveShopFromHost(host)
  if (!shop) return null

  const shopId = (shop as any).id
  const theme = await db
    .selectFrom('themes' as any)
    .select('id')
    .where('shop_id', '=', shopId)
    .where('role', '=', 'main')
    .executeTakeFirst()
    .catch(() => null)

  if (!theme) return null

  const themeId = (theme as any).id as string
  themeIdCache.set(domain, { themeId, ts: Date.now() })
  return themeId
}

// Binary asset types that are base64-encoded in the DB
const BINARY_EXTENSIONS = new Set([
  '.woff2', '.woff', '.ttf', '.otf', '.eot',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.svg', // SVGs from CSS clone are stored as base64 too
])

function isBinaryAsset(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

// Serve binary assets (fonts, images) — decode base64 from DB
app.use(async (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return }
  if (!req.path.startsWith('/assets/')) { next(); return }
  const sub = req.path.slice('/assets/'.length)
  if (!sub || !isBinaryAsset(sub)) { next(); return }

  const host = (req.hostname ?? req.headers.host ?? '') as string
  const themeId = await getActiveThemeIdForHost(host)
  if (!themeId) { next(); return }

  const loader = new DbLoader(db, themeId)
  const key = `assets/${sub}`
  const result = await loader.loadWithMeta(key).catch(() => null)
  if (!result) { next(); return }

  // Decode base64 to binary Buffer
  const buf = Buffer.from(result.source, 'base64')

  // Content-type mapping
  const ext = key.slice(key.lastIndexOf('.')).toLowerCase()
  const ctMap: Record<string, string> = {
    '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  }

  res.set('Content-Type', ctMap[ext] || 'application/octet-stream')
  res.set('Cache-Control', 'public, max-age=31536000, immutable')
  res.set('Access-Control-Allow-Origin', '*')
  res.status(200).send(buf)
})

// Text-based assets (CSS, JS, SVG, JSON, Liquid)
app.use(buildAssetMiddleware({
  getLoader: async (req) => {
    const host = (req.hostname ?? req.headers.host ?? '') as string
    const themeId = await getActiveThemeIdForHost(host)
    if (!themeId) return null
    return new DbLoader(db, themeId)
  },
  cacheControl: 'public, max-age=300', // 5min for dev
}))

// Multi-tenant storefront handler
app.use(async (req: Request, res: Response, next: NextFunction) => {
  const host = (req.hostname ?? req.headers.host ?? '') as string

  const eng = await resolveEngine(host)
  if (!eng) {
    res.status(404).send(notFoundPage(host))
    return
  }

  // Inject shopId into the Express request so the adapter picks it up
  ;(req as any).gboxShopId = eng.shopId

  try {
    await eng.handler(req, res, next)
  } catch (err) {
    console.error(`[storefront] Handler error for ${eng.shopName}:`, err)
    next(err)
  }
})

// ---------------------------------------------------------------------------
// 404 page (no shop found for this domain)
// ---------------------------------------------------------------------------

function notFoundPage(host: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Store Not Found — Gbox Platform</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{text-align:center;padding:48px;max-width:520px}
h1{font-size:28px;margin-bottom:16px;color:#f8fafc}
p{color:#94a3b8;font-size:15px;line-height:1.6}
code{background:#1e293b;padding:2px 8px;border-radius:4px;font-size:14px;color:#38bdf8}
</style>
</head>
<body>
<div class="card">
<h1>Store Not Found</h1>
<p>No Gbox store is configured for <code>${host.replace(/[<>"'&]/g, '')}</code>.</p>
<p style="margin-top:12px">If you just set up a custom domain, it may take a few minutes to propagate.</p>
</div>
</body></html>`
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '4326')

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  GBOX STOREFRONT SERVER (multi-tenant) running on http://0.0.0.0:${PORT}\n`)
})
