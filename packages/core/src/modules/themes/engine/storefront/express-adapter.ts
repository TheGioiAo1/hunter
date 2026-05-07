/**
 * Gbox Platform — Express Storefront Adapter
 *
 * Decision #1 Step 1.14 — Thin shim that maps Express's
 * `(req, res, next)` callback signature to the framework-agnostic
 * `handleStorefrontRequest` function. The router does all the work;
 * this file only normalizes types in and out.
 *
 * Why a separate file?
 *
 *   - Keeps `router.ts` framework-agnostic. The pure router can be
 *     reused by Hono / Workers / Fastify adapters without dragging
 *     in `@types/express`.
 *   - Tests for the adapter can stub the Express request shape
 *     directly without spinning up a real Express app.
 *
 * Express type imports are done structurally — we don't take a
 * dependency on `@types/express` here because that package is huge
 * and only needed at the consumer's app boundary. The minimal
 * `ExpressLike*` interfaces below capture exactly what we touch.
 */

import { handleStorefrontRequest } from './router.js'
import type {
  StorefrontHandlerOptions,
  StorefrontRequestContext,
} from './types.js'

// ---------------------------------------------------------------------------
// Structural Express types
// ---------------------------------------------------------------------------

/**
 * The subset of Express's `Request` we actually read. Defined
 * structurally so consumers don't have to install `@types/express`
 * just to type-check this file.
 */
export interface ExpressLikeRequest {
  method: string
  /** The path WITHOUT the query string. Express exposes this on `req.path`. */
  path: string
  query: Record<string, unknown>
  headers: Record<string, unknown>
  cookies?: Record<string, string>
  /**
   * Express's `req.hostname` (preferred) or `req.headers.host` as
   * fallback. Either way, we surface it via `request.host` in Liquid.
   */
  hostname?: string
  /** Optional shop id injected by upstream multi-tenant middleware. */
  gboxShopId?: string
}

/**
 * The subset of Express's `Response` we actually write. Sufficient
 * for `status / set / send`.
 */
export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse
  set(headers: Record<string, string>): ExpressLikeResponse
  send(body: string): unknown
}

/** Standard Express `next` callback. */
export type ExpressLikeNext = (err?: unknown) => void

/**
 * The shape `createExpressStorefrontHandler` returns — an
 * Express-compatible middleware function. Plug it into an Express app
 * with `app.get('*', createExpressStorefrontHandler(opts))`.
 */
export type ExpressStorefrontHandler = (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: ExpressLikeNext,
) => Promise<void>

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Build an Express middleware that delegates to the pure storefront
 * router. The closure captures the `opts` bundle so the engine /
 * datasource / locale config / error logger are constructed once at
 * app startup, not per-request.
 *
 * Errors thrown synchronously by `handleStorefrontRequest` are
 * caught and forwarded to `next(err)` so Express's error middleware
 * can take over. The pure router catches its own errors and turns
 * them into 500 responses, so reaching `next(err)` only happens for
 * truly unexpected failures (e.g. opts.engine is null).
 */
export function createExpressStorefrontHandler(
  opts: StorefrontHandlerOptions,
): ExpressStorefrontHandler {
  return async function gboxStorefrontHandler(req, res, next) {
    try {
      const ctx = expressToStorefrontContext(req)
      const response = await handleStorefrontRequest(opts, ctx)
      res.status(response.status).set(response.headers).send(response.body)
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Convert an Express `Request` to a `StorefrontRequestContext`.
 * Exported for tests + so a custom Express setup can pre-process
 * the context (e.g. adding tenant info) before calling the pure
 * router directly.
 */
export function expressToStorefrontContext(
  req: ExpressLikeRequest,
): StorefrontRequestContext {
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: ensureLeadingSlash(req.path ?? '/'),
    query: normalizeQuery(req.query),
    headers: normalizeHeaders(req.headers),
    cookies: req.cookies ?? {},
    host: req.hostname ?? extractHost(req.headers),
    designMode: detectDesignMode(req.query, req.headers),
    shopId: req.gboxShopId,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Make sure the path starts with `/`. Express normally guarantees this. */
function ensureLeadingSlash(path: string): string {
  if (!path) return '/'
  return path.startsWith('/') ? path : '/' + path
}

/**
 * Express's `req.query` is `Record<string, string | string[] | ParsedQs>`.
 * We collapse arrays to their first value and stringify everything
 * else. The router never expects multi-value params (Shopify's
 * storefront doesn't use them).
 */
function normalizeQuery(
  raw: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v == null) continue
    if (Array.isArray(v)) {
      const first = v[0]
      if (first != null) out[k] = String(first)
      continue
    }
    if (typeof v === 'object') {
      // Express qs parser produces nested objects for `a[b]=c`.
      // Stringify for forward compat — no current route uses this.
      out[k] = JSON.stringify(v)
      continue
    }
    out[k] = String(v)
  }
  return out
}

/**
 * Express headers come in as `string | string[] | undefined`. Force
 * lowercase keys (the router expects them) and pick the first value
 * when an array is provided.
 */
function normalizeHeaders(
  raw: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v == null) continue
    const key = k.toLowerCase()
    if (Array.isArray(v)) {
      const first = v[0]
      if (first != null) out[key] = String(first)
      continue
    }
    out[key] = String(v)
  }
  return out
}

/**
 * Last-resort host extraction when `req.hostname` is missing
 * (happens for raw `http` server objects that haven't been wrapped
 * by Express's request prototype).
 */
function extractHost(headers: Record<string, unknown>): string {
  const xfh = headers['x-forwarded-host']
  if (typeof xfh === 'string') return xfh.split(',')[0]?.trim() ?? ''
  const host = headers['host']
  if (typeof host === 'string') return host
  return ''
}

/**
 * `?design_mode=true` (theme editor preview) OR `x-gbox-design-mode`
 * header. We accept both because the editor frame and the visual
 * builder can each set whichever is convenient.
 */
function detectDesignMode(
  query: Record<string, unknown>,
  headers: Record<string, unknown>,
): boolean {
  const q = query['design_mode']
  if (typeof q === 'string' && q.toLowerCase() === 'true') return true
  const h = headers['x-gbox-design-mode']
  if (typeof h === 'string' && h.toLowerCase() === 'true') return true
  return false
}
