/**
 * Gbox Storefront — Express Server Entrypoint (Production Wiring)
 *
 * Phase 6.1 — GAP #1 closure. Builds a fully-wired Express app for the
 * production storefront and listens on `STOREFRONT_PORT`. Every layer
 * the integration test exercises with in-memory fakes is bound here to
 * a real backing store:
 *
 *   resolve-shop      → Postgres (`shop_domains` + `shops` lookup)
 *   cookies / locale  → static config (no external deps)
 *   i18n              → DbI18nService backed by `translations` table
 *   assets            → DbLoader on the active theme's `theme_assets`
 *   storefront render → DbDataSource + DbLoader, per-shop LRU cache
 *   error handler     → reuses the same per-shop bundle
 *
 * The server keeps two LRU caches in memory:
 *
 *   1. host → ResolvedShop (lives inside resolve-shop middleware itself
 *      via cacheMaxEntries / cacheTtlMs).
 *   2. shopId → StorefrontHandlerOptions (rebuilt when the active theme
 *      row id changes — we cache by `${shopId}:${themeId}` so a
 *      `setActiveTheme` call invalidates instantly without a process
 *      restart).
 *
 * Graceful shutdown closes the HTTP socket, drains in-flight requests,
 * and `await`s `destroyDb()` so pg connections are released. SIGTERM
 * (PM2 stop) and SIGINT (Ctrl-C) both flow through the same path.
 *
 * Phase 8.2 — Read-replica routing. Two pg pools live side by side:
 *
 *   db      → primary, used by the production health check (so /_health
 *             really verifies the WRITE path) and any future writes.
 *   readDb  → replica, used by every storefront read: shop lookup,
 *             active-theme lookup, DbLoader (template + asset bytes),
 *             DbI18nService (translations), DbDataSource (page data).
 *
 * `createReadDb()` falls back to the primary if `DATABASE_READ_URL`
 * is unset, so single-Postgres dev/test environments keep working
 * with no config changes.
 */

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { config as dotenvConfig } from 'dotenv'
;(function loadRootEnv() {
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const p = resolve(dir, '.env')
    if (existsSync(p)) { dotenvConfig({ path: p }); return }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
})()
import type { Request, Response } from 'express'
import { buildApp } from './app.js'
import { closeRedis } from '@gbox/core/modules/cache/redis.js'
import { installProcessErrorHandlers } from '@gbox/core/modules/logging/logger.js'
import { getDefaultTieredBackend } from '@gbox/core/modules/cache/tiered.js'
import {
  createLiquidEngine,
  type LiquidEngine,
} from '@gbox/core/modules/themes/engine/liquid.js'
import { DbI18nService } from '@gbox/core/modules/i18n/index.js'
import { DbLoader } from '@gbox/core/modules/themes/engine/storefront/db-loader.js'
import { DbDataSource } from '@gbox/core/modules/themes/engine/storefront/db-datasource.js'
import { CachedStorefrontDataSource } from '@gbox/core/modules/themes/engine/storefront/cached-datasource.js'
import type { StorefrontHandlerOptions } from '@gbox/core/modules/themes/engine/storefront/index.js'
import type { ResolvedShop } from './middleware/resolve-shop.js'
import {
  recordPageView,
  recordAddToCart,
  recordCheckoutStart,
  recordPurchase,
} from '@gbox/core/modules/events/storefront-events.js'
import {
  recordPageViewDedicated,
} from '@gbox/core/modules/analytics/page-views.js'
import {
  incrementVisitor,
} from '@gbox/core/modules/analytics/daily-metrics.js'
import {
  dispatchServerSide,
  newEventId,
  type CanonicalEvent,
  type TrackingEventPayload,
} from '@gbox/core/modules/tracking/index.js'
// Phase 8 PR2e — public abandoned-cart unsubscribe handler
import { unsubscribeByToken as unsubscribeByTokenCore } from '@gbox/core/modules/marketing/abandoned-cart.js'
// Phase 14 PR4 — email open/click tracking recorder
import {
  recordOpen as recordOpenCore,
  recordClick as recordClickCore,
} from '@gbox/core/modules/email/tracking-recorder.js'
// Phase 14 PR4.B — email webhook orchestrator + default cert fetcher
import {
  handleSnsWebhook as handleSnsWebhookCore,
  handleGenericWebhook as handleGenericWebhookCore,
  confirmSnsSubscription as confirmSnsSubscriptionCore,
} from '@gbox/core/modules/email/webhook-handler.js'
import { createDefaultCertFetcher } from '@gbox/core/modules/email/webhook-verify.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number.parseInt(
  process.env.STOREFRONT_PORT ?? process.env.PORT ?? '4326',
  10,
)

const SUPPORTED_LOCALES = (process.env.STOREFRONT_LOCALES ?? 'en,vi')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const DEFAULT_LOCALE = process.env.STOREFRONT_DEFAULT_LOCALE ?? 'en'

const DEV_SHOP_SLUG = process.env.STOREFRONT_DEV_SHOP_SLUG // optional

// ---------------------------------------------------------------------------
// DB handles — primary + read replica
// ---------------------------------------------------------------------------
//
// // API-MODE: storefront previously imported `createDb` / `createReadDb`
// // from `@gbox/db` for direct Postgres access (Phase 8.2 read-replica
// // routing). The `@gbox/db` workspace package is currently absent in
// // dev — every DB-backed lookup below short-circuits to a null guard
// // and the storefront falls back to either a mock shop or no-render.
// // When the API gateway exposes the storefront read endpoints, replace
// // these stubs with the matching api-client calls.
const db = null as any
const readDb = null as any

// ---------------------------------------------------------------------------
// Process-wide tiered cache backend (Phase 3 close-the-loop)
// ---------------------------------------------------------------------------
//
// One in-process LRU shared across every shop so hot keys (the active
// theme row, the homepage product list, the navigation collection tree)
// don't get duplicated per-tenant. Write-through to Redis via the
// standalone `cacheGet/cacheSet/cacheDel/cacheDelPattern` helpers —
// exactly the wiring sketched in `cache/tiered.ts`'s doc comment.
//
// Env overrides are documented in `tiered.ts`:
//   STOREFRONT_CACHE_LOCAL_MAX — max entries in the LRU (default 1000)
//   STOREFRONT_CACHE_LOCAL_TTL — max LRU TTL in ms (default 60_000)
//
// The backend is fail-open at every tier so a Redis blip degrades
// gracefully to the in-process LRU + DB fall-through.

const cacheBackend = getDefaultTieredBackend({
  memoryMaxEntries: Number.parseInt(
    process.env.STOREFRONT_CACHE_LOCAL_MAX ?? '5000',
    10,
  ),
  memoryMaxTtlMs: Number.parseInt(
    process.env.STOREFRONT_CACHE_LOCAL_TTL ?? '60000',
    10,
  ),
})

// ---------------------------------------------------------------------------
// Per-shop handler options cache
// ---------------------------------------------------------------------------
//
// Building the engine + datasource costs one DB roundtrip (theme lookup)
// plus zero allocations on cache hit. Cache key includes the active
// theme id so publishing a new theme invalidates instantly — no LRU TTL
// needed because the key changes when the data does.

interface CachedHandler {
  themeId: string
  options: StorefrontHandlerOptions
}

const handlerCache = new Map<string, CachedHandler>()

async function getActiveThemeId(shopId: string): Promise<string | null> {
  // // API-MODE: would query themes WHERE shop_id=? AND role='main' on the
  // // read replica. With db stubbed, no theme is ever resolved → storefront
  // // render returns null options and the catch-all middleware 404s.
  if (!readDb) return null
  const row = await readDb
    .selectFrom('themes')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('role', '=', 'main')
    .executeTakeFirst()
  return row?.id ?? null
}

/**
 * Sprint 9: verify a (themeId, shopId) pair before honouring a preview
 * request. The theme-preview middleware already cross-checks `shopId`
 * against the HMAC token, but we re-verify here so a tampered cache
 * entry or a corrupted shopId stamp can never render a different
 * shop's draft on this storefront.
 */
async function getThemeIfOwned(
  themeId: string,
  shopId: string,
): Promise<string | null> {
  // // API-MODE: cross-checks (themeId, shopId) ownership before honouring
  // // a preview request. Stubbed off in demo mode — no preview rendering.
  if (!readDb) return null
  const row = await readDb
    .selectFrom('themes')
    .select(['id', 'shop_id'])
    .where('id', '=', themeId)
    .executeTakeFirst()
  if (!row || row.shop_id !== shopId) return null
  return row.id
}

/**
 * Sprint 9 — preview path. Builds handler options against an
 * unpublished theme id WITHOUT going through the persistent
 * handlerCache; preview themes change every few seconds while the
 * seller drags settings, so cache reuse would just stale up the
 * iframe. We do still cache for the duration of a single request
 * via a tiny per-call cache (Map keyed by themeId) so multiple
 * subrequests inside one render cycle don't rebuild the engine.
 */
async function buildHandlerOptionsForPreviewTheme(
  shopId: string,
  themeId: string,
): Promise<StorefrontHandlerOptions | null> {
  const verified = await getThemeIfOwned(themeId, shopId)
  if (!verified) return null

  const loader = new DbLoader(readDb, verified)
  const i18n = new DbI18nService(readDb)
  const engine: LiquidEngine = createLiquidEngine({ loader, i18n })
  const dbDatasource = new DbDataSource(readDb, shopId)
  const datasource = new CachedStorefrontDataSource(dbDatasource, {
    backend: cacheBackend,
  })
  return {
    engine,
    datasource,
    locales: { supported: SUPPORTED_LOCALES, default: DEFAULT_LOCALE },
  }
}

async function buildHandlerOptionsForShop(
  shopId: string,
): Promise<StorefrontHandlerOptions | null> {
  const themeId = await getActiveThemeId(shopId)
  if (!themeId) return null

  const cached = handlerCache.get(shopId)
  if (cached && cached.themeId === themeId) {
    return cached.options
  }

  // All three of these are pure-read services — engine template
  // loading, translation lookup, datasource queries — so they go to
  // the replica. The handler cache means we only build them once per
  // (shop, themeId), so the replica connection count stays bounded.
  const loader = new DbLoader(readDb, themeId)
  const i18n = new DbI18nService(readDb)
  const engine: LiquidEngine = createLiquidEngine({ loader, i18n })

  // Phase 3B close-the-loop: wrap the raw DB datasource with the
  // cache-aside decorator so every shop read goes through the
  // tiered backend (in-process LRU → Redis → Postgres). The decorator
  // handles its own key isolation by shopId + locale, so all shops
  // can safely share the same process-wide backend instance.
  const dbDatasource = new DbDataSource(readDb, shopId)
  const datasource = new CachedStorefrontDataSource(dbDatasource, {
    backend: cacheBackend,
  })

  const options: StorefrontHandlerOptions = {
    engine,
    datasource,
    locales: { supported: SUPPORTED_LOCALES, default: DEFAULT_LOCALE },
  }

  handlerCache.set(shopId, { themeId, options })
  return options
}

// ---------------------------------------------------------------------------
// Host → shop lookup
// ---------------------------------------------------------------------------
//
// Search order on every cold cache miss:
//   1. shop_domains.domain     (custom + verified domains)
//   2. shops.custom_domain     (legacy column kept for migration safety)
//   3. shops.domain            (the platform-issued *.gbox.co subdomain)
//
// Each query selects the columns the resolve-shop middleware exposes to
// the rest of the pipeline.

const SHOP_COLUMNS = [
  'id',
  'slug',
  'name',
  'currency',
  'default_locale',
  'status',
] as const

function rowToResolvedShop(row: {
  id: string
  slug: string
  name: string
  currency: string
  default_locale: string
  status: string
}): ResolvedShop {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    currency: row.currency,
    defaultLocale: row.default_locale,
    status: row.status,
  }
}

async function lookupShopByHost(host: string): Promise<ResolvedShop | null> {
  // // API-MODE: would search shop_domains → shops.custom_domain →
  // // shops.domain. In dev/demo without DB, every host resolves to a
  // // single mock shop so the boot path stays live for smoke testing.
  if (!readDb) {
    return {
      id: 'shop_demo1',
      slug: 'gbox-demo',
      name: 'Gbox Demo Store',
      currency: 'USD',
      defaultLocale: DEFAULT_LOCALE,
      status: 'active',
    }
  }
  // Tenant resolution → replica. The resolve-shop middleware already
  // memoises the result per host, so even a 100ms replica lag has
  // negligible storefront impact (a freshly-added domain takes one
  // page reload + cache miss to propagate).

  // 1. Verified custom domain in shop_domains table.
  //
  // IMPORTANT: the `verified=true` filter is load-bearing. Without it,
  // an unverified domain row would route traffic (any seller who
  // adds a domain and forgets to verify would effectively hijack
  // visitors). The nginx catch-all server block forwards every
  // unknown Host to us, so this SQL guard is the one thing keeping
  // "added but not verified" domains from serving content.
  const dom = await readDb
    .selectFrom('shop_domains')
    .innerJoin('shops', 'shops.id', 'shop_domains.shop_id')
    .select(SHOP_COLUMNS.map((c) => `shops.${c}` as const))
    .where('shop_domains.domain', '=', host)
    .where('shop_domains.verified', '=', true)
    .executeTakeFirst()
  if (dom) return rowToResolvedShop(dom as any)

  // 2. Legacy `shops.custom_domain` column.
  const cd = await readDb
    .selectFrom('shops')
    .select(SHOP_COLUMNS)
    .where('custom_domain', '=', host)
    .executeTakeFirst()
  if (cd) return rowToResolvedShop(cd as any)

  // 3. Platform-issued *.gbox.co subdomain stored in shops.domain.
  const dn = await readDb
    .selectFrom('shops')
    .select(SHOP_COLUMNS)
    .where('domain', '=', host)
    .executeTakeFirst()
  if (dn) return rowToResolvedShop(dn as any)

  return null
}

async function lookupShopBySlug(slug: string): Promise<ResolvedShop | null> {
  // // API-MODE: dev fallback used when STOREFRONT_DEV_SHOP_SLUG is set.
  // // Without DB, mirror the host-lookup demo shape.
  if (!readDb) {
    return {
      id: 'shop_demo1',
      slug,
      name: slug === 'gbox-demo' ? 'Gbox Demo Store' : slug,
      currency: 'USD',
      defaultLocale: DEFAULT_LOCALE,
      status: 'active',
    }
  }
  const row = await readDb
    .selectFrom('shops')
    .select(SHOP_COLUMNS)
    .where('slug', '=', slug)
    .executeTakeFirst()
  return row ? rowToResolvedShop(row as any) : null
}

// ---------------------------------------------------------------------------
// Build the app
// ---------------------------------------------------------------------------

const app = buildApp({
  serviceName: 'gbox-storefront',
  // // API-MODE: production wiring uses healthCheck(db) which pings DB +
  // // Redis. Without DB in dev, return a simple liveness ping so PM2 /
  // // smoke probes still get a 200.
  healthHandler: (_req: Request, res: Response) => {
    res.json({ ok: true, mode: 'demo', service: 'gbox-storefront' })
  },
  // Phase 3D close-the-loop — stamp Cache-Control / CDN-Cache-Control /
  // Surrogate-Control / Vary on every response according to the six
  // presets in `@gbox/core/modules/cache/edge-headers`. Path → preset
  // routing lives in `middleware/edge-cache.ts`.
  edgeCache: {},
  resolveShop: {
    lookup: lookupShopByHost,
    lookupBySlug: lookupShopBySlug,
    devShopSlug: DEV_SHOP_SLUG,
    // We always sit behind the nginx reverse proxy on Server 1, so the
    // X-Forwarded-Host header is the source of truth for tenant routing.
    trustForwardedHost: true,
  },
  // Phase 1 of custom-domain origin TLS — installs the ACME HTTP-01
  // challenge fallback middleware. Empty object = use defaults
  // (/var/www/acme-webroot). Production keeps this on as a backup
  // for nginx; if the nginx well-known location ever drops out of
  // config, lego challenges still resolve via Express.
  acmeChallenge: {},
  // Phase 2 of custom-domain remediation — `<slug>.gbox.co` → 301 →
  // canonical custom domain. Resolver hits the read replica with the
  // currently resolved shop; if the shop has no primary_domain_id or
  // the row is unverified, returns null (middleware passes through).
  // Cached at the resolve-shop layer's per-host LRU so this only
  // touches the DB once per host change.
  canonicalHostRedirect: {
    enabled: process.env.GBOX_CANONICAL_REDIRECT_ENABLED !== 'false',
    getCanonicalHost: async (req) => {
      const shopId = req.gboxShopId
      if (!shopId) return null
      // // API-MODE: would resolve shops.primary_domain_id → shop_domains
      // // and 301 the seller's `<slug>.gbox.co` to the verified custom
      // // domain. Skip in demo mode (no canonical redirect).
      if (!readDb) return null
      try {
        const shop = await readDb
          .selectFrom('shops')
          .select(['primary_domain_id'])
          .where('id', '=', shopId)
          .executeTakeFirst()
        if (!shop?.primary_domain_id) return null
        const dom = await readDb
          .selectFrom('shop_domains')
          .select(['domain', 'verified'])
          .where('id', '=', shop.primary_domain_id)
          .executeTakeFirst()
        if (!dom || !dom.verified) return null
        return { hostname: dom.domain }
      } catch {
        return null
      }
    },
  },
  cookies: {},
  // Sprint 9 — Theme preview wiring. With THEME_PREVIEW_SECRET set the
  // storefront verifies short-lived HMAC tokens minted by store-admin
  // /customize/preview-url and renders the unpublished theme for the
  // duration of that one request. Empty/unset secret = pass-through (no
  // preview, no overhead).
  themePreview: {
    secret: process.env.THEME_PREVIEW_SECRET || '',
  },
  utmCapture: {},  // Enable UTM first-touch capture (30-day cookie, M1)
  locale: {
    getSupportedLocales: () => SUPPORTED_LOCALES,
  },
  // i18n middleware (req.gboxT) intentionally skipped — the Liquid
  // engine has its own DbI18nService injected per shop, so the `{{ 'k'
  // | t }}` filter resolves directly against the translations table.
  // Adding a second loader here would just duplicate the cache.
  assets: {
    getLoader: async (req) => {
      const shopId = req.gboxShopId
      if (!shopId) return null
      // Sprint 9 — preview-aware. /assets/* must serve the DRAFT theme's
      // assets when the customizer iframe loads with a preview token,
      // otherwise CSS/JS for the draft never reaches the browser.
      const previewId =
        typeof req.gboxPreviewThemeId === 'string' && req.gboxPreviewThemeId.length > 0
          ? req.gboxPreviewThemeId
          : null
      const themeId = previewId
        ? await getThemeIfOwned(previewId, shopId)
        : await getActiveThemeId(shopId)
      if (!themeId) return null
      return new DbLoader(readDb, themeId)
    },
  },
  storefront: {
    getHandlerOptions: async (req) => {
      const shopId = req.gboxShopId
      if (!shopId) return null
      // Sprint 9 — preview pathway. When a verified preview token has
      // stamped req.gboxPreviewThemeId, render against that theme.
      const previewId =
        typeof req.gboxPreviewThemeId === 'string' && req.gboxPreviewThemeId.length > 0
          ? req.gboxPreviewThemeId
          : null
      if (previewId) {
        return buildHandlerOptionsForPreviewTheme(shopId, previewId)
      }
      return buildHandlerOptionsForShop(shopId)
    },
  },
  errorHandler: {
    getHandlerOptions: async (req) => {
      const shopId = req.gboxShopId
      if (!shopId) return null
      // Errors during preview should also render via the draft theme so
      // the seller sees what their visitors would see.
      const previewId =
        typeof req.gboxPreviewThemeId === 'string' && req.gboxPreviewThemeId.length > 0
          ? req.gboxPreviewThemeId
          : null
      if (previewId) {
        return buildHandlerOptionsForPreviewTheme(shopId, previewId)
      }
      return buildHandlerOptionsForShop(shopId)
    },
  },
  // ── Measurement Foundation (M1) ──────────────────────────────────
  // Auto page-view recorder: fires on every content-page GET that
  // returns 2xx. Writes to both the generic `events` table (for the
  // conversion funnel) and the dedicated `page_views` table (for
  // analytics queries: visitors/day, top pages, traffic sources).
  tracking: {
    recordPageView: async (shopId, input) => {
      // // API-MODE: writes to events / page_views / daily_metrics. No-op
      // // when db is stubbed.
      if (!db) return
      // 1) Generic events table — powers conversion funnel
      void recordPageView(db, shopId, input).catch(() => {})
      // 2) Dedicated page_views table — powers analytics/live-view
      //    Also bumps daily_metrics.visitors on new sessions.
      void recordPageViewDedicated(db, shopId, {
        path: input.path,
        referrer: input.referrer,
        userAgent: input.userAgent,
        sessionId: input.sessionId,
        customerId: input.customerId,
        ip: input.ip ?? null,
        utmSource: input.utmSource ?? null,
        utmMedium: input.utmMedium ?? null,
        utmCampaign: input.utmCampaign ?? null,
      }).then((inserted) => {
        // If this was a genuinely new page view (not debounced), bump
        // daily_metrics.visitors. The nightly rollup will correct the
        // count to exact unique sessions — this hot-path is approximate.
        if (inserted) {
          void incrementVisitor(db, shopId).catch(() => {})
        }
      }).catch(() => {})
      // 3) M3: Fan out to configured server-side pixel providers
      //    (Meta CAPI, GA4 MP, TikTok Events API). Fire-and-forget —
      //    network failures are swallowed and never block the render.
      void fireRelay(shopId, {
        event: 'page_view',
        sourceUrl: input.path,
        params: { session_id: input.sessionId },
        userData: {
          clientIp: input.ip ?? null,
          userAgent: input.userAgent,
          externalId: input.customerId ?? null,
        },
      })
    },
  },
  // Client-side events beacon: POST /events from theme JS.
  eventsRoutes: {
    recordPageView: async (shopId, input) => {
      // // API-MODE: would forward client beacon → events table + pixels.
      if (!db) return
      await recordPageView(db, shopId, input)
      void fireRelay(shopId, {
        event: 'page_view',
        sourceUrl: input.path,
        params: { session_id: input.sessionId },
        userData: {
          userAgent: input.userAgent,
          externalId: input.customerId ?? null,
        },
      })
    },
    recordAddToCart: async (shopId, input) => {
      if (!db) return
      await recordAddToCart(db, shopId, input)
      void fireRelay(shopId, {
        event: 'add_to_cart',
        params: { session_id: input.sessionId },
        userData: { externalId: input.customerId ?? null },
        customData: {
          value: Number(input.price) * input.quantity,
          currency: input.currency,
          contentIds: [input.productId],
          itemCount: input.quantity,
        },
      })
    },
    recordCheckoutStart: async (shopId, input) => {
      if (!db) return
      await recordCheckoutStart(db, shopId, input)
      void fireRelay(shopId, {
        event: 'checkout_start',
        params: { session_id: input.sessionId },
        userData: { externalId: input.customerId ?? null },
        customData: {
          value: Number(input.total),
          currency: input.currency,
          itemCount: input.itemCount,
          orderId: input.checkoutId,
        },
      })
    },
    recordPurchase: async (shopId, input) => {
      if (!db) return
      await recordPurchase(db, shopId, input)
      void fireRelay(shopId, {
        event: 'purchase',
        params: { session_id: input.sessionId },
        userData: { externalId: input.customerId ?? null },
        customData: {
          value: Number(input.total),
          currency: input.currency,
          itemCount: input.itemCount,
          orderId: input.orderId,
        },
      })
    },
  },
  // ── Multi-pixel tracking injector (migration 034) ────────────────
  // Rewrites every 2xx text/html response to stamp the merchant's
  // active Meta / GA4 / GTM / TikTok pixel snippets before </head>.
  // Pixel list is cached 60s per shop to keep the hot path cheap.
  pixelInjector: {
    db,
    trackEndpoint: process.env.STOREFRONT_TRACK_ENDPOINT ?? '/api/track',
  },
  // ── Phase 8 PR2e: Public unsubscribe (abandoned-cart) ────────────
  // Mounts GET/POST /unsubscribe/:token. The token is globally unique
  // (32 hex chars) so no shop scoping is needed. `unsubscribeByToken`
  // conflates not-found + already-unsubscribed intentionally so the
  // route can't be used to enumerate valid tokens.
  // Cross-package Kysely identity workaround — see store-admin
  // handlers for the same pattern.
  unsubscribeRoutes: {
    unsubscribeByToken: async (token) => {
      // // API-MODE: writes to email_unsubscribe_tokens. Ack as not-found
      // // in demo so the route still 404s without leaking enumeration.
      if (!db) return { ok: false }
      const out = await unsubscribeByTokenCore(db as any, token)
      if (!out.ok) return { ok: false }
      return {
        ok: true,
        enrollment: {
          id: out.enrollment.id,
          shop_id: out.enrollment.shop_id,
          email: out.enrollment.email,
          unsubscribed_at: out.enrollment.unsubscribed_at,
        },
      }
    },
  },
  // ── Phase 14 PR4: Email tracking (open pixel + click redirect) ────
  // Mounts GET /email/track/open/:token.gif + GET /email/track/click/
  // :token. Token is globally unique (HMAC-signed, 32 hex chars) so
  // no shop scoping is needed. Both deps are best-effort — DB errors
  // never leak to the recipient; they still see the pixel/redirect.
  emailTrackingRoutes: {
    recordOpen: async (token, meta) => {
      // // API-MODE: writes open event to email_events. No-op in demo.
      if (!db) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recordOpenCore(db as any, token, meta)
    },
    recordClick: async (token, encoded, meta) => {
      // // API-MODE: same as recordOpen. Returning null target makes the
      // // route 404 cleanly instead of redirecting to a stale target.
      if (!db) return { target: null }
      const result = await recordClickCore(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        token,
        encoded,
        meta,
      )
      return { target: result.ok ? result.target : null }
    },
  },
  // ── Phase 14 PR4.B: Email webhooks (SNS + generic HMAC) ──────────
  // The deps adapter closes over the primary db + a pre-built cert
  // fetcher so the route layer never sees either. The cert fetcher
  // enforces the SigningCertURL host allowlist (defaults to
  // `.amazonaws.com`, override via EMAIL_WEBHOOK_SNS_CERT_HOST_ALLOWLIST).
  emailWebhookRoutes: {
    handleSnsWebhook: (input) => {
      // // API-MODE: stores SNS bounce/complaint events. No-op in demo.
      if (!db) return Promise.resolve({ ok: true })
      return handleSnsWebhookCore(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        {
          envelope: input.envelope,
          sourceIp: input.sourceIp,
          certFetcher: createDefaultCertFetcher(),
        },
      )
    },
    handleGenericWebhook: (input) => {
      if (!db) return Promise.resolve({ ok: true })
      return handleGenericWebhookCore(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        input,
      )
    },
    confirmSubscriptionUrl: (url) => confirmSnsSubscriptionCore(url),
    getGenericSecret: () => process.env.EMAIL_WEBHOOK_GENERIC_SECRET ?? '',
  },
})

// ---------------------------------------------------------------------------
// Migration 034: Multi-pixel server-side dispatcher
// ---------------------------------------------------------------------------
//
// Replaces the old `relayPixelEvent` singleton. Takes a legacy event
// shape and forwards it to `dispatchServerSide` in the new tracking
// module. Hot-path safe: every error is swallowed so a slow / broken
// partner API never blocks the render pipeline.
//
// `fireRelay` still exists so call sites don't need rewriting; it
// converts the legacy event name + userData bag into a canonical
// TrackingEventPayload.

interface LegacyRelayEvent {
  event: 'page_view' | 'add_to_cart' | 'checkout_start' | 'purchase'
  sourceUrl?: string
  params?: Record<string, unknown>
  userData?: {
    clientIp?: string | null
    userAgent?: string | null
    externalId?: string | null
    email?: string | null
    phone?: string | null
  }
  customData?: Record<string, unknown>
}

const LEGACY_TO_CANONICAL: Record<LegacyRelayEvent['event'], CanonicalEvent> = {
  page_view: 'PageView',
  add_to_cart: 'AddToCart',
  checkout_start: 'InitiateCheckout',
  purchase: 'Purchase',
}

async function fireRelay(shopId: string, event: LegacyRelayEvent): Promise<void> {
  // // API-MODE: forwards canonical events to Meta CAPI / GA4 / TikTok via
  // // tracking_events_log. Skip when db is stubbed.
  if (!db) return
  try {
    const canonical = LEGACY_TO_CANONICAL[event.event]
    if (!canonical) return
    const payload: TrackingEventPayload = {
      canonicalEvent: canonical,
      eventId: newEventId(),
      eventTimeMs: Date.now(),
      sourceUrl: event.sourceUrl ?? '',
      userAgent: event.userData?.userAgent ?? null,
      clientIp: event.userData?.clientIp ?? null,
      userEmail: event.userData?.email ?? null,
      userPhone: event.userData?.phone ?? null,
      userExternalId: event.userData?.externalId ?? null,
      customData: { ...(event.params ?? {}), ...(event.customData ?? {}) },
    }
    await dispatchServerSide(db, shopId, payload)
  } catch {
    // Never let a pixel-provider error bubble into the storefront
    // response. dispatchServerSide already captures per-attempt
    // errors in tracking_events_log.
  }
}

// ---------------------------------------------------------------------------
// Process error handlers
// ---------------------------------------------------------------------------
//
// Public-facing storefront — an uncaught exception or unhandled
// promise rejection inside a theme render, a pixel dispatch, or a
// DB callback must hit structured logs (pino fatal/error lines),
// not vanish into stderr where no log aggregator will index them.
// `installProcessErrorHandlers` subscribes `process.on('uncaughtException')`
// + `process.on('unhandledRejection')` and emits JSON log lines under
// service=`gbox-storefront` so every incident lands in the same
// telemetry pipeline as checkout / accounts / store-admin / god-admin.
// Exit-on-uncaught is delayed 500ms so pino has time to flush.

installProcessErrorHandlers('gbox-storefront')

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[Gbox Storefront] Running on http://localhost:${PORT} | PID: ${process.pid}`,
  )
  // eslint-disable-next-line no-console
  console.log(
    `[Gbox Storefront] ENV: ${process.env.NODE_ENV ?? 'development'} | locales: ${SUPPORTED_LOCALES.join(',')} (default ${DEFAULT_LOCALE})`,
  )
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[Gbox Storefront] Received ${signal}, shutting down...`)

  // Stop accepting new sockets, then wait for in-flight requests.
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[Gbox Storefront] Error closing HTTP server:', err)
  })

  // Drain pg pools. Calling `.destroy()` directly avoids the
  // `destroyDb()` helper, which carries a `Kysely<Database>` parameter
  // typed against @gbox/db's hoisted Kysely copy — that union confuses
  // TS when this app pulls Kysely from a nested node_modules instead.
  // We tear down the read replica first so any in-flight read finishes
  // before the primary closes.
  // // API-MODE: db handles are stubbed null in demo mode → nothing to drain.
  if (readDb) {
    try {
      await readDb.destroy()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Gbox Storefront] Error closing read-replica pool:', err)
    }
  }
  if (db) {
    try {
      await db.destroy()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Gbox Storefront] Error closing DB pool:', err)
    }
  }

  // Drain Redis client (lazy-init singleton — no-op if never connected).
  try {
    await closeRedis()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[Gbox Storefront] Error closing Redis client:', err)
  }

  process.exit(0)
}

// If anything is still holding the event loop 10s after a shutdown
// request, hard-exit so PM2 can restart us instead of hanging forever.
function armWatchdog(): void {
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('[Gbox Storefront] Forced shutdown after 10s timeout')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => {
  armWatchdog()
  void shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  armWatchdog()
  void shutdown('SIGINT')
})
