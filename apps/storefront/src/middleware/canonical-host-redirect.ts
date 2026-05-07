/**
 * Gbox Storefront — Canonical-host redirect (Shopify-class).
 *
 * When a seller has a verified primary custom domain (`tw3.store`),
 * Shopify auto-redirects the platform subdomain (`store.myshopify.com`)
 * to the custom one with a 301. We do the same for `<slug>.gbox.co`:
 * if `req.gboxShop.primaryDomain` is set + verified + the request
 * came in on the platform subdomain, redirect to the canonical host.
 *
 * Why redirect rather than render both:
 *   - SEO: search engines penalise duplicate content. One canonical URL
 *     prevents two storefronts indexing the same products.
 *   - Brand: the seller picked the custom domain because they want it
 *     to be THE address. Mirroring at the platform subdomain confuses
 *     customers who screenshot URLs.
 *   - Auth: customer cookies and pixels are scoped to the canonical
 *     hostname; serving from both leaks sessions across origins.
 *
 * What we DO NOT redirect:
 *   - Direct visits to the custom domain (the canonical case — pass through).
 *   - `/.well-known/acme-challenge/*` (must answer on every host
 *     during cert renewal — let acme-challenge middleware handle it).
 *   - Health checks (`/_health`) — must work on both hosts so monitors
 *     can ping the platform subdomain even when the custom DNS is down.
 *   - Asset paths (`/assets/*`) — kept on the same origin as the page.
 *   - Preview URLs (`?preview_theme_id=`) — admin links into the
 *     storefront with a token, redirecting would lose the token.
 *
 * Order in app.ts: install AFTER resolve-shop (so we know which shop
 * we're on + can read its primary domain) but BEFORE the cookie /
 * customer-session / theme-preview middleware (so we redirect before
 * any session work that would tie cookies to the wrong host).
 */

import type { NextFunction, Request, Response } from 'express'

export interface CanonicalHostRedirectOptions {
  /**
   * Loader the middleware calls per request to resolve "what's the
   * canonical hostname for this shop?". Returns null when the shop
   * has no primary domain (or it's unverified) — the middleware
   * then passes through. Defaults to a no-op resolver so the
   * middleware is a no-op until the caller wires it up.
   */
  getCanonicalHost?: (
    req: Request,
  ) => Promise<{ hostname: string } | null> | { hostname: string } | null
  /**
   * Set to false to disable redirects entirely (kill switch). Default true.
   */
  enabled?: boolean
}

const SKIP_PATH_PREFIXES = [
  '/.well-known/',
  '/_health',
  '/_admin/health',
  '/assets/',
  '/cart.js',
  '/api/',
] as const

const SKIP_QUERY_PARAMS = ['preview_theme_id', '_gbox_preview_theme'] as const

function shouldSkip(req: Request): boolean {
  for (const p of SKIP_PATH_PREFIXES) {
    if (req.path.startsWith(p)) return true
  }
  if (req.path === '/_health') return true
  for (const q of SKIP_QUERY_PARAMS) {
    if (q in (req.query as Record<string, unknown>)) return true
  }
  return false
}

/**
 * Pull the request hostname (no port) the way Express normalises it.
 * Behind a proxy with `trust proxy` set, this is the X-Forwarded-Host
 * value — same source resolve-shop reads, so the two are guaranteed
 * to agree on what host we're on.
 */
function reqHost(req: Request): string {
  const raw = (req as unknown as { hostname?: string }).hostname
  if (typeof raw === 'string' && raw.length > 0) {
    return raw.toLowerCase()
  }
  const headerHost = req.headers.host
  if (typeof headerHost === 'string') {
    return headerHost.split(':')[0]!.toLowerCase()
  }
  return ''
}

export function buildCanonicalHostRedirect(
  options: CanonicalHostRedirectOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const enabled = options.enabled !== false
  const resolver = options.getCanonicalHost ?? (async () => null)

  if (!enabled) {
    return function canonicalHostRedirectDisabled(_req, _res, next) {
      next()
    }
  }

  return function canonicalHostRedirect(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Don't 301 a POST — would lose the body. Cart submits / form
      // posts to the platform subdomain still get processed normally
      // (and the response will set canonical <link> in HTML, which
      // search engines respect on its own).
      return next()
    }
    if (shouldSkip(req)) return next()

    Promise.resolve(resolver(req))
      .then((canonical) => {
        if (!canonical || !canonical.hostname) return next()
        const currentHost = reqHost(req)
        if (!currentHost) return next()
        // Already on the canonical host — pass through.
        if (currentHost === canonical.hostname.toLowerCase()) return next()
        // Build the destination: same path + querystring, https.
        const target = `https://${canonical.hostname}${req.originalUrl}`
        res
          .status(301)
          .setHeader('Location', target)
          // Belt-and-braces canonical — search engines take the
          // strongest hint, so emit both Location AND Link.
          .setHeader('Link', `<${target}>; rel="canonical"`)
          .setHeader('Cache-Control', 'public, max-age=300')
          .type('text/plain')
          .send(`Redirecting to ${target}`)
      })
      .catch(() => {
        // Resolver error — pass through so the storefront still
        // serves the request. We never want a transient resolver
        // hiccup to break the storefront.
        next()
      })
  }
}

// Internal helpers exported for tests.
export const __test = { shouldSkip, reqHost, SKIP_PATH_PREFIXES, SKIP_QUERY_PARAMS }
