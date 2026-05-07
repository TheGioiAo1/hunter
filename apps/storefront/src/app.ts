/**
 * Gbox Storefront — Express App Factory (Stage 3A.8)
 *
 * `buildApp()` constructs and returns a fresh Express instance with
 * exactly the middleware wired up for the current stage. It is split
 * out from `server.ts` so tests can instantiate the app without having
 * to open a socket, connect to Postgres, or start the graceful-shutdown
 * handlers.
 *
 * The factory is the single place where middleware order is decided.
 * Reading this file top-to-bottom tells you the exact shape of a
 * request as it flows through the storefront:
 *
 *   request
 *     ↓
 *   request-context    (3A.2 — X-Request-ID + per-req logger)
 *     ↓
 *   security headers   (3A.3 — CSP, HSTS, Referrer-Policy, …)
 *     ↓
 *   /_health short-circuit — never depends on anything below
 *     ↓
 *   resolve-shop       (3A.4 — Host → ResolvedShop lookup)
 *     ↓
 *   cookies            (3A.5 — cart / _session / locale bag)
 *     ↓
 *   locale             (3A.6 — URL → cookie → Accept-Lang → default)
 *     ↓
 *   assets             (3A.7 — /assets/* served from the TemplateLoader)
 *     ↓
 *   i18n               (5.6  — per-request bundles + sync req.gboxT)
 *     ↓
 *   marketing routes   (4.5  — POST /marketing/subscribe)
 *     ↓
 *   theme preview      (3F.2 — ?preview_theme_id + HMAC → draft theme)
 *     ↓
 *   storefront handler (3A.8 — delegates to handleStorefrontRequest)
 *     ↓
 *   error handler      (3A.9 — template-rendered 500 — future)
 *
 * Every middleware below `/_health` is OPTIONAL — the caller (the
 * real server entrypoint, tests, or a future Workers adapter) opts
 * in via the `buildApp()` options by providing the dependency the
 * middleware needs. A missing option silently disables that stage,
 * which keeps the lighter-weight stages (3A.1-3A.3) testable in
 * isolation without needing a DB, a cookie parser, or a theme.
 *
 * The same pattern applies all the way down: the integration test
 * wires every layer at once using in-memory fakes; the unit tests
 * for 3A.2 / 3A.3 spin up a bare app with zero downstream wiring.
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import { storefrontSecurityHeaders } from '@gbox/core/modules/security/headers.js'
import { sanitizeResponseMiddleware } from '@gbox/core/modules/security/sanitize-middleware.js'
import {
  buildRequestContextMiddleware,
  type RequestContextMiddlewareOptions,
} from './middleware/request-context.js'
import {
  buildAcmeChallengeMiddleware,
  type AcmeChallengeMiddlewareOptions,
} from './middleware/acme-challenge.js'
import {
  buildCanonicalHostRedirect,
  type CanonicalHostRedirectOptions,
} from './middleware/canonical-host-redirect.js'
import {
  buildResolveShopMiddleware,
  type ResolveShopMiddlewareOptions,
} from './middleware/resolve-shop.js'
import {
  buildCookieMiddleware,
  type CookieMiddlewareOptions,
} from './middleware/cookies.js'
import {
  buildUtmCaptureMiddleware,
  type UtmCaptureOptions,
} from './middleware/utm-capture.js'
import {
  buildLocaleMiddleware,
  type LocaleMiddlewareOptions,
} from './middleware/locale.js'
import {
  buildI18nMiddleware,
  type I18nMiddlewareOptions,
} from './middleware/i18n.js'
import {
  buildAssetMiddleware,
  type AssetMiddlewareOptions,
} from './middleware/assets.js'
import {
  buildStorefrontHandler,
  type StorefrontHandlerDeps,
} from './handler.js'
import {
  buildErrorMiddleware,
  buildNotFoundMiddleware,
  type ErrorHandlerDeps,
} from './middleware/error-handler.js'
import {
  buildCartRoutes,
  type CartRoutesDeps,
} from './middleware/cart-routes.js'
import {
  buildCheckoutRoutes,
  type CheckoutRoutesDeps,
} from './middleware/checkout-routes.js'
import {
  buildCustomerSessionMiddleware,
  type CustomerSessionMiddlewareOptions,
} from './middleware/customer-session.js'
import {
  buildAccountRoutes,
  type AccountRoutesDeps,
} from './middleware/account-routes.js'
import {
  buildSeoRoutes,
  type SeoRoutesDeps,
} from './middleware/seo-routes.js'
import {
  buildTrackingMiddleware,
  type TrackingMiddlewareOptions,
} from './middleware/tracking.js'
import {
  buildPixelInjectorMiddleware,
  type PixelInjectorOptions,
} from './middleware/pixel-injector.js'
import {
  buildEventsRoutes,
  type EventsRoutesDeps,
} from './middleware/events-routes.js'
import {
  buildThemePreviewMiddleware,
  type ThemePreviewMiddlewareOptions,
} from './middleware/theme-preview.js'
import {
  buildMarketingRoutes,
  type MarketingRoutesDeps,
} from './middleware/marketing-routes.js'
import {
  buildUnsubscribeRoutes,
  type UnsubscribeRoutesDeps,
} from './middleware/unsubscribe-routes.js'
import {
  buildReviewsRoutes,
  type ReviewsRoutesDeps,
} from './middleware/reviews-routes.js'
import {
  buildEmailTrackingRoutes,
  type EmailTrackingRoutesDeps,
} from './middleware/email-tracking-routes.js'
import {
  buildEmailWebhookRoutes,
  type EmailWebhookRoutesDeps,
} from './middleware/email-webhook-routes.js'
import {
  buildEdgeCacheHeadersMiddleware,
  type EdgeCacheHeadersOptions,
} from './middleware/edge-cache.js'

export interface BuildAppOptions {
  /**
   * Override the `service` name reported by `/_health` and by the
   * per-request logger. Defaults to `gbox-storefront`. Used by tests
   * so that two apps running in the same process can be distinguished
   * in logs.
   */
  serviceName?: string
  /**
   * Override the `/_health` handler. Production binds this to
   * `healthCheck(db)` from `@gbox/core/modules/monitoring/metrics`
   * so the probe pings Postgres + Redis and reports memory + latency
   * percentiles. Tests + bare integration runs leave this undefined
   * to keep the default zero-dep JSON response, so a crashing dep
   * never fails the health probe in unit tests.
   */
  healthHandler?: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void | Promise<void>
  /**
   * Optional hooks / overrides forwarded into the request-context
   * middleware — primarily used by tests to inject a fake logger or
   * observe `onFinish` without parsing log output.
   */
  requestContext?: Omit<RequestContextMiddlewareOptions, 'serviceName'>
  /**
   * ACME HTTP-01 challenge middleware (Phase 1 of custom-domain origin
   * TLS roadmap). Installs BEFORE resolve-shop so a `GET
   * /.well-known/acme-challenge/<token>` request never hits the
   * storefront router (which would 404 with a "Store not found" HTML
   * page that confuses Let's Encrypt's validator). When omitted the
   * middleware is not installed — production typically lets nginx
   * serve the file directly from `/var/www/acme-webroot`, but enabling
   * this gives belt-and-braces coverage in case nginx config drifts.
   * Empty object installs with defaults (`/var/www/acme-webroot`).
   */
  acmeChallenge?: AcmeChallengeMiddlewareOptions
  /**
   * Options for the host → shop resolver middleware (3A.4). When
   * omitted the middleware is not installed, which is handy for
   * tests that only want to exercise the top of the stack.
   */
  resolveShop?: ResolveShopMiddlewareOptions
  /**
   * Phase 2 of the custom-domain remediation roadmap. When the seller
   * has a verified `primary_domain_id` and the request comes in on
   * `<slug>.gbox.co`, redirect 301 to the canonical custom domain.
   * Mirrors Shopify's `<store>.myshopify.com → custom.com` behavior.
   * The resolver is supplied by the caller (production wires it to a
   * DB read; tests can return null to disable). Skipped when omitted.
   */
  canonicalHostRedirect?: CanonicalHostRedirectOptions
  /**
   * Cookie middleware options (3A.5). Empty object installs the
   * middleware with its defaults; `undefined` skips it.
   */
  cookies?: CookieMiddlewareOptions
  /**
   * UTM capture middleware (Sprint 2b). Stamps a first-party
   * `gbox_utm` cookie from `?utm_source=...` query params on the
   * landing page so attribution persists through checkout. Empty
   * object installs with defaults; `undefined` skips it (tests
   * that don't care about attribution).
   */
  utmCapture?: UtmCaptureOptions
  /** Locale middleware options (3A.6). */
  locale?: LocaleMiddlewareOptions
  /**
   * i18n middleware (5.6). When provided, installs a per-request
   * sync translator (`req.gboxT`) backed by the pure
   * `translateKey` helper. Requires the locale middleware to have
   * already pinned `req.gboxLocale`; omit to skip i18n entirely
   * (tests, asset-only deploys, health probes).
   */
  i18n?: I18nMiddlewareOptions
  /** Asset middleware options (3A.7). */
  assets?: AssetMiddlewareOptions
  /**
   * Customer session middleware (3C.1). Reads the
   * `gbox_customer_session` cookie and stamps `req.gboxCustomer` +
   * `req.gboxCustomerId` so downstream mutations (checkout hand-off)
   * and templated pages (account dashboard) can see who is signed
   * in. Omit to skip customer lookup entirely — the storefront then
   * renders every request as anonymous, which is handy for tests
   * that don't care about auth.
   */
  customerSession?: CustomerSessionMiddlewareOptions
  /**
   * Account route deps (3C.2). When provided, the `/account/login`,
   * `/account/login/verify`, `/account/otp`, and `/account/logout`
   * endpoints are mounted between the cart/checkout routes and the
   * storefront catch-all. The GET pages for `/account`,
   * `/account/orders`, etc. continue to flow through the storefront
   * handler so they render via the active theme's Liquid templates.
   */
  accountRoutes?: AccountRoutesDeps
  /**
   * Cart route deps (3B.2). When provided, `/cart.js` + the
   * `/cart/<action>.js` mutation endpoints are mounted AFTER the
   * asset handler and BEFORE the storefront catch-all. Omit to skip
   * the routes entirely (e.g. in unit tests for the render pipeline
   * that don't care about cart semantics).
   */
  cartRoutes?: CartRoutesDeps
  /**
   * Checkout hand-off route deps (3B.4 + 3B.5). When provided, the
   * single `POST /checkout` endpoint is mounted alongside the cart
   * routes. It reads the cart, calls `createCheckout`, issues a
   * handoff token, and 303s the buyer at the checkout subdomain.
   */
  checkoutRoutes?: CheckoutRoutesDeps
  /**
   * SEO route deps (3D.1 + 3D.2). When provided, `GET /robots.txt`
   * and `GET /sitemap.xml` are mounted AFTER the asset handler and
   * BEFORE the storefront catch-all so they take precedence over
   * any theme template with the same path. Omit to skip the
   * crawler-facing endpoints entirely — the storefront will then
   * either return 404 or render a theme template named robots.txt
   * / sitemap.xml if one exists.
   */
  seoRoutes?: SeoRoutesDeps
  /**
   * Tracking middleware (3E.2). When provided, installs the
   * automatic `page_view` recorder that fires on every successful
   * content-page GET response. The `recordPageView` dep is
   * typically bound to
   * `(shopId, input) => recordPageView(db, shopId, input)` from
   * `@gbox/core/modules/events`. Omit to disable auto page
   * tracking entirely — the beacon endpoint still works.
   */
  tracking?: TrackingMiddlewareOptions
  /**
   * Multi-pixel tracking injector (migration 034). When provided,
   * every 2xx `text/html` response is rewritten to include the
   * merchant's active Meta / GA4 / GTM / TikTok pixel snippets
   * before `</head>`. Omit to skip injection entirely — handy for
   * tests and minimal integration runs.
   */
  pixelInjector?: PixelInjectorOptions
  /**
   * Client-side events beacon (3E.3). When provided, mounts
   * `POST /events` alongside the other mutation routers. The four
   * recorder deps are the same ones used by `tracking`, bound
   * individually so tests can spy on each verb.
   */
  eventsRoutes?: EventsRoutesDeps
  /**
   * Theme preview middleware options (3F.2). When provided, reads
   * `?preview_theme_id=X&preview_token=Y` on every request,
   * verifies the HMAC token against `secret`, and stamps
   * `req.gboxPreviewThemeId` so `storefront.getHandlerOptions`
   * can swap in an unpublished theme for this one request. Also
   * sets `X-Robots-Tag: noindex, nofollow` so crawlers never
   * cache the draft. Omit to disable preview entirely — passing
   * an empty `secret` has the same effect.
   */
  themePreview?: ThemePreviewMiddlewareOptions
  /**
   * Marketing subscribe route deps (4.5). When provided, mounts
   * `POST /marketing/subscribe` in the same band as the cart +
   * events beacons. Omit to skip the newsletter/popup signup
   * endpoint entirely.
   */
  marketingRoutes?: MarketingRoutesDeps
  /**
   * Public unsubscribe routes (Phase 8 PR2e). When provided, mounts
   * `GET /unsubscribe/:token` (confirmation page) and
   * `POST /unsubscribe/:token` (commit) for the abandoned-cart
   * recovery flow's unsubscribe links. Does NOT require
   * `resolveShop` — the 32-hex-char token is globally unique.
   * Omit to skip the endpoint (the storefront then returns 404 for
   * `/unsubscribe/*` paths).
   */
  unsubscribeRoutes?: UnsubscribeRoutesDeps
  /**
   * Public reviews API (Phase 8 PR4). Mounts
   * `GET/POST /api/storefront/products/:id/reviews`. Requires
   * `resolveShop` to have run upstream so `req.gboxShopId` is set —
   * the route returns 404 otherwise. Omit to skip the endpoints.
   */
  reviewsRoutes?: ReviewsRoutesDeps
  /**
   * Email tracking routes (Phase 14 PR4). Mounts
   * `GET /email/track/open/:token.gif` (open pixel) and
   * `GET /email/track/click/:token?u=<base64url>` (click redirect).
   * Does NOT require resolveShop — the token is globally unique
   * across shops (same reason as unsubscribeRoutes). Omit to skip
   * the endpoints entirely (tracking pixels in outbound emails
   * will just 404 server-side, which is fine).
   */
  emailTrackingRoutes?: EmailTrackingRoutesDeps
  /**
   * Email webhook routes (Phase 14 PR4.B). Mounts
   * `POST /webhooks/email/ses` (AWS SNS bounce/complaint feed) and
   * `POST /webhooks/email/generic` (HMAC-authed generic feedback). Does
   * NOT require resolveShop — both endpoints are platform-global; shop
   * scope is resolved by the handler via matched delivery (or the
   * X-Gbox-Shop-Id hint for the generic path). Omit to disable the
   * endpoints entirely (useful for preview deploys that don't want to
   * expose webhooks).
   */
  emailWebhookRoutes?: EmailWebhookRoutesDeps
  /**
   * Storefront handler deps (3A.8). When provided, the handler is
   * mounted as the catch-all `GET *` route. Missing deps mean
   * unmapped routes keep returning Express's default 404.
   */
  storefront?: StorefrontHandlerDeps
  /**
   * Error + not-found middleware deps (3A.9). When provided, a
   * templated 404 is mounted after the storefront handler and a
   * templated 500 is mounted as the trailing Express error handler.
   * Callers typically reuse the same `getHandlerOptions` they pass
   * to `storefront.getHandlerOptions` so the error path renders via
   * the active theme. `undefined` leaves Express's default error
   * behaviour in place — useful for the minimal integration tests
   * that don't install the storefront handler at all.
   */
  errorHandler?: ErrorHandlerDeps
  /**
   * Edge cache headers (Phase 3D close-the-loop). When provided (or
   * `{}` to accept defaults), installs a middleware that stamps
   * `Cache-Control` / `CDN-Cache-Control` / `Surrogate-Control` /
   * `Vary` on every response using the six presets from
   * `@gbox/core/modules/cache/edge-headers`. Path → preset mapping
   * lives in `middleware/edge-cache.ts`. Omit entirely to leave
   * Express's default (no caching headers) — useful for tests that
   * assert bare responses.
   */
  edgeCache?: EdgeCacheHeadersOptions
}

/**
 * Build a fresh Express instance with all middleware wired up for the
 * current Phase 3A stage. Safe to call multiple times — no shared
 * global state lives on the module.
 */
export function buildApp(options: BuildAppOptions = {}): Express {
  const serviceName = options.serviceName ?? 'gbox-storefront'
  const app = express()

  // Trust the single reverse proxy hop in front of us (nginx on Server
  // 1 for test, or the production load balancer). Required for
  // `req.ip`, `req.protocol` and forthcoming X-Forwarded-Host handling.
  app.set('trust proxy', 1)

  // ---------------------------------------------------------------
  // 3A.2 — Request context (must run first so every downstream
  // middleware can log with req_id "for free").
  // ---------------------------------------------------------------
  app.use(
    buildRequestContextMiddleware({
      serviceName,
      ...(options.requestContext ?? {}),
    }),
  )

  // ---------------------------------------------------------------
  // 3A.3 — Security headers (CSP, HSTS, Referrer-Policy, etc.).
  // Applied to every response including the health check so a bad
  // actor can't use /_health to probe header configuration.
  // ---------------------------------------------------------------
  app.use(storefrontSecurityHeaders)

  // ---------------------------------------------------------------
  // Phase 0 close-the-loop — scrub sensitive fields out of every
  // JSON response (password_hash, tokens, secrets). The storefront
  // currently ships mostly HTML via the theme engine, but cart.js,
  // /events, and /account API endpoints do emit JSON and this is the
  // defence-in-depth guard that protects them regardless of how the
  // individual handlers compose their responses.
  // ---------------------------------------------------------------
  app.use(sanitizeResponseMiddleware())

  // ---------------------------------------------------------------
  // Phase 3D close-the-loop — Edge cache headers. Runs right after
  // security headers so every outgoing response (including error
  // paths and the 404 fall-through) gets a sane Cache-Control. The
  // middleware is pure-sync path→preset routing; downstream handlers
  // can override the stamped headers by calling `applyCachePolicy`
  // again (last-writer-wins). Gated on `options.edgeCache` so unit
  // tests that assert bare responses keep working.
  // ---------------------------------------------------------------
  if (options.edgeCache !== undefined) {
    app.use(buildEdgeCacheHeadersMiddleware(options.edgeCache))
  }

  // ---------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------
  // Lives BEFORE any per-request middleware so the monitor endpoint
  // never depends on the database, the theme engine, or the host
  // resolver. A crashing resolver must not cause health to flip.
  if (options.healthHandler) {
    app.get('/_health', options.healthHandler)
  } else {
    app.get('/_health', (_req, res) => {
      res.json({
        status: 'ok',
        service: serviceName,
        timestamp: new Date().toISOString(),
      })
    })
  }

  // ---------------------------------------------------------------
  // ACME HTTP-01 challenge — runs BEFORE resolve-shop so the Let's
  // Encrypt validator's `GET /.well-known/acme-challenge/<token>`
  // never hits the storefront router. Production typically lets
  // nginx serve the challenge directly from /var/www/acme-webroot;
  // this middleware is the belt-and-braces fallback. Skipped when
  // options.acmeChallenge is undefined.
  // ---------------------------------------------------------------
  if (options.acmeChallenge !== undefined) {
    app.use(buildAcmeChallengeMiddleware(options.acmeChallenge))
  }

  // ---------------------------------------------------------------
  // 3A.4 — Host → shop resolver.
  // ---------------------------------------------------------------
  if (options.resolveShop) {
    app.use(buildResolveShopMiddleware(options.resolveShop))
  }

  // ---------------------------------------------------------------
  // Phase 2 — Canonical-host 301. Runs AFTER resolve-shop so the
  // resolver callback can read the shop's primary_domain_id, but
  // BEFORE cookies/sessions so cookies never get scoped to the wrong
  // hostname. Skipped when canonicalHostRedirect is undefined.
  // ---------------------------------------------------------------
  if (options.canonicalHostRedirect !== undefined) {
    app.use(buildCanonicalHostRedirect(options.canonicalHostRedirect))
  }

  // ---------------------------------------------------------------
  // 3A.5 — Cookie parser (cart / _session / locale).
  // ---------------------------------------------------------------
  if (options.cookies !== undefined) {
    app.use(buildCookieMiddleware(options.cookies))
  }

  // ---------------------------------------------------------------
  // Sprint 2b — UTM attribution capture. Runs AFTER cookies so it
  // can read `req.gboxCookies.all['gbox_utm']` and merge with query
  // params. `first-touch wins`; persisted for 30 days.
  // ---------------------------------------------------------------
  if (options.utmCapture !== undefined) {
    app.use(buildUtmCaptureMiddleware(options.utmCapture))
  }

  // ---------------------------------------------------------------
  // 3A.6 — Locale negotiator. Runs after the cookie middleware so
  // it can read the visitor's `locale` cookie.
  // ---------------------------------------------------------------
  if (options.locale) {
    app.use(buildLocaleMiddleware(options.locale))
  }

  // ---------------------------------------------------------------
  // 5.6 — i18n middleware. Loads translation bundles for the
  // resolved shop once per request and stamps a synchronous
  // `req.gboxT('key', vars?)` translator. Must run after the
  // locale middleware (reads `req.gboxLocale`) and BEFORE the
  // storefront handler so the render path can hand the bundles
  // to the theme engine. Runs AFTER assets since CSS/JS doesn't
  // need translations — no point paying the loader cost on
  // every /assets/* hit.
  // ---------------------------------------------------------------

  // ---------------------------------------------------------------
  // 3A.7 — Asset static handler. Sits before the storefront
  // handler so theme CSS/JS never pays the datasource cost.
  // ---------------------------------------------------------------
  if (options.assets) {
    app.use(buildAssetMiddleware(options.assets))
  }

  if (options.i18n) {
    app.use(buildI18nMiddleware(options.i18n))
  }

  // ---------------------------------------------------------------
  // 3C.1 — Customer session middleware. Sits AFTER cookies (so it
  // can read the `gbox_customer_session` cookie) and BEFORE the
  // mutation routers (so cart/checkout/account mutations can all
  // see `req.gboxCustomerId`). Skipping this option leaves every
  // request anonymous — useful for tests that don't care about
  // auth, and for the minimal request-pipeline smoke tests.
  // ---------------------------------------------------------------
  if (options.customerSession) {
    app.use(buildCustomerSessionMiddleware(options.customerSession))
  }

  // ---------------------------------------------------------------
  // 3E.2 — Tracking middleware. Installs a `finish` listener on
  // every request so content-page GETs get recorded as
  // `page_view` events after the response flushes. Sits after
  // customer-session so the recorder can read
  // `req.gboxCustomerId`, and BEFORE the mutation routers so
  // the listener is attached before any of them responds.
  // ---------------------------------------------------------------
  if (options.tracking) {
    app.use(buildTrackingMiddleware(options.tracking))
  }

  // ---------------------------------------------------------------
  // Multi-pixel injector (migration 034). Rewrites 2xx text/html
  // bodies to stamp fbq/gtag/ttq + window.gboxTrack before </head>.
  // Installed after tracking so the internal page_view recorder
  // still fires first, and before cart/checkout routers so the
  // patched res.send sees HTML responses from every downstream
  // handler (including the storefront catch-all).
  // ---------------------------------------------------------------
  if (options.pixelInjector) {
    app.use(buildPixelInjectorMiddleware(options.pixelInjector))
  }

  // ---------------------------------------------------------------
  // 3E.3 — Client-side events beacon (POST /events). Mounted in
  // the same band as the cart + checkout routers so beacon
  // payloads get the same shop + cookie resolution.
  // ---------------------------------------------------------------
  if (options.eventsRoutes) {
    app.use(buildEventsRoutes(options.eventsRoutes))
  }

  // ---------------------------------------------------------------
  // 3C.2 — Account auth routes. Installed BEFORE the cart routes
  // so that a `/account/logout` POST never gets consumed by the
  // cart router's catch-all and BEFORE the storefront handler so
  // GET `/account/login` still falls through to the theme's Liquid
  // login template.
  // ---------------------------------------------------------------
  if (options.accountRoutes) {
    app.use(buildAccountRoutes(options.accountRoutes))
  }

  // ---------------------------------------------------------------
  // 3B.2 — Cart Ajax endpoints. Sits AFTER assets so `/cart.js`
  // can't be shadowed by a themeasset with the same name, and
  // BEFORE the storefront catch-all so the catch-all never sees
  // `/cart/*` requests.
  // ---------------------------------------------------------------
  if (options.cartRoutes) {
    app.use(buildCartRoutes(options.cartRoutes))
  }

  // ---------------------------------------------------------------
  // 3B.4 + 3B.5 — Checkout hand-off. POST /checkout turns the
  // Redis cart into a priced CheckoutSession and 303s the buyer
  // at the signed checkout subdomain URL.
  // ---------------------------------------------------------------
  if (options.checkoutRoutes) {
    app.use(buildCheckoutRoutes(options.checkoutRoutes))
  }

  // ---------------------------------------------------------------
  // 3D.1 + 3D.2 — Crawler endpoints (/robots.txt + /sitemap.xml).
  // Sits AFTER the mutation routers so `/robots.txt` can never be
  // shadowed by a themed template, and BEFORE the storefront
  // catch-all so the catch-all never sees these paths at all. The
  // routes are shop-scoped — the resolve-shop middleware has
  // already stamped `req.gboxShopId` by this point.
  // ---------------------------------------------------------------
  if (options.seoRoutes) {
    app.use(buildSeoRoutes(options.seoRoutes))
  }

  // ---------------------------------------------------------------
  // 4.5 — Marketing subscribe route. Lives next to the other
  // mutation routers (cart / checkout / events) so it sees the
  // same shop + cookie resolution. POST /marketing/subscribe
  // collects newsletter + exit-intent popup signups and hands
  // them to the caller-provided dep.
  // ---------------------------------------------------------------
  if (options.marketingRoutes) {
    app.use(buildMarketingRoutes(options.marketingRoutes))
  }

  // ---------------------------------------------------------------
  // Phase 8 PR2e — Public unsubscribe routes. Mounted in the same
  // band as the other customer-facing mutation routers. Sits
  // BEFORE the storefront catch-all so `/unsubscribe/*` never gets
  // swallowed by a theme template. Has no dependency on
  // resolveShop / cookies / customerSession — the URL is token-
  // authed and is intentionally render-any-host so an email link
  // reaches the handler regardless of which shop domain the
  // customer clicks from.
  // ---------------------------------------------------------------
  if (options.unsubscribeRoutes) {
    app.use(buildUnsubscribeRoutes(options.unsubscribeRoutes))
  }

  // ---------------------------------------------------------------
  // Phase 14 PR4 — Email tracking routes. Mounted alongside the
  // other email-triggered, token-authed, shop-agnostic routes
  // (unsubscribeRoutes). Paths: /email/track/open/:token.gif and
  // /email/track/click/:token. Sits BEFORE the storefront catch-all
  // so the theme engine never tries to render a tracking URL as a
  // page. Does not depend on resolveShop — the token is globally
  // unique across shops.
  // ---------------------------------------------------------------
  if (options.emailTrackingRoutes) {
    app.use(buildEmailTrackingRoutes(options.emailTrackingRoutes))
  }

  // ---------------------------------------------------------------
  // Phase 14 PR4.B — Email webhook routes. Mounts
  // POST /webhooks/email/ses (AWS SNS bounces/complaints) and
  // POST /webhooks/email/generic (HMAC-authed generic feedback).
  // Both are platform-global — no resolveShop dependency. Mounted
  // BEFORE the catch-all so a theme template never sees a webhook
  // POST (themes are GET-only, but defense in depth). Each route
  // mounts its own body parser internally (JSON for ses, raw for
  // generic so HMAC can verify the unmodified bytes).
  // ---------------------------------------------------------------
  if (options.emailWebhookRoutes) {
    app.use(buildEmailWebhookRoutes(options.emailWebhookRoutes))
  }

  // ---------------------------------------------------------------
  // Phase 8 PR4 — Public reviews API. Mounted AFTER resolve-shop
  // runs (so `req.gboxShopId` is populated) and BEFORE the
  // catch-all so `/api/storefront/*` never gets swallowed by a
  // theme template. Returns JSON, not HTML — this is an API.
  // ---------------------------------------------------------------
  if (options.reviewsRoutes) {
    app.use(buildReviewsRoutes(options.reviewsRoutes))
  }

  // ---------------------------------------------------------------
  // 3F.2 — Theme preview middleware. Sits after resolve-shop (so
  // it can cross-check the token's shopId against req.gboxShopId)
  // and before the storefront handler (so getHandlerOptions can
  // read req.gboxPreviewThemeId). Does nothing when omitted or
  // when `secret` is empty, so production deploys that haven't
  // configured the signing key see zero overhead.
  // ---------------------------------------------------------------
  if (options.themePreview) {
    app.use(buildThemePreviewMiddleware(options.themePreview))
  }

  // ---------------------------------------------------------------
  // 3A.8 — Storefront request handler (catch-all GET / HEAD).
  // This is always the last user-facing middleware — anything
  // below here is either the error handler (3A.9) or Express's
  // default 404.
  // ---------------------------------------------------------------
  if (options.storefront) {
    const handler = buildStorefrontHandler(options.storefront)
    // Use a regex catch-all (`/.*/`) instead of `'*'` so this works
    // under both Express 4 (path-to-regexp v0.x) and Express 5
    // (path-to-regexp v6+, which rejects bare `*` and requires a
    // named wildcard like `{*splat}`). The regex form is identical
    // in behaviour across both majors.
    app.get(/.*/, handler)
    app.head(/.*/, handler)
  }

  // ---------------------------------------------------------------
  // 3A.9 — Error + not-found handlers. Installed LAST so they
  // catch both unmatched routes (the fall-through 404) and
  // uncaught errors from any prior middleware. We gate the whole
  // block on `options.errorHandler` so tests that intentionally
  // want Express's default 404 behaviour can skip it.
  // ---------------------------------------------------------------
  if (options.errorHandler) {
    app.use(buildNotFoundMiddleware(options.errorHandler))
    app.use(buildErrorMiddleware(options.errorHandler))
  }

  return app
}
