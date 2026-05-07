/**
 * Gbox Storefront — Asset Middleware (Stage 3A.7)
 *
 * Serves theme assets (CSS, JS, SVG, fonts, JSON) under `/assets/*`.
 * The assets themselves live in the active theme's `TemplateLoader`
 * — in production that's a `DbLoader` backed by the `theme_assets`
 * table with R2 spillover for large blobs; in tests it's a plain
 * in-memory map. The loader is resolved per-request so each shop's
 * active theme version can be served independently.
 *
 * Pipeline position: runs AFTER the locale negotiator (3A.6) so
 * that `/vi/assets/theme.css` has already been stripped to
 * `/assets/theme.css`, but BEFORE the main storefront handler
 * (3A.8) so that asset requests never pay the datasource cost.
 *
 * Design notes:
 *
 *   • **Immutable Cache-Control.** Every theme edit produces a new
 *     `themes` row with a new id, so the same `/assets/theme.css`
 *     URL on a different theme version is, from the server's
 *     perspective, a different resource. The URL itself doesn't
 *     change — we rely on the theme_id → loader binding and on
 *     browsers re-fetching when the shop admin publishes. For
 *     public CDNs we also emit an ETag from `updatedAt` so
 *     `If-None-Match` revalidation short-circuits to 304.
 *
 *   • **Path traversal defence.** Both literal `..` / `.` segments
 *     and percent-encoded `%2e%2e` are rejected with 400 before
 *     touching the loader. Loaders also normalise internally, but
 *     belt-and-braces matters when the input is attacker-controlled.
 *
 *   • **No binary path yet.** The `TemplateLoader` API returns
 *     strings, so this middleware streams the body as UTF-8 text.
 *     That's fine for every asset Gbox Dawn ships (CSS/JS/SVG) and
 *     for theme JSON. Proper binary serving (PNG/WOFF2 over an
 *     `ObjectStore` direct read) is tracked for a later stage and
 *     will land as a second middleware behind the same URL prefix.
 *
 *   • **Method gating.** Only GET + HEAD are handled. Anything
 *     else (POST, DELETE) falls through so a future upload route
 *     can live at the same prefix.
 */

import type { Request, Response, NextFunction } from 'express'
import { createHash } from 'node:crypto'
import type {
  TemplateLoader,
  LoadResult,
} from '@gbox/core/modules/themes/engine/loader.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AssetMiddlewareOptions {
  /**
   * Resolve the loader to use for this request. Sync or async.
   * Returns `null` when no theme is available (e.g. the shop has
   * no published theme yet) — the middleware will 404 in that
   * case.
   */
  getLoader: (
    req: Request,
  ) => TemplateLoader | null | Promise<TemplateLoader | null>
  /**
   * Cache-Control header value. Defaults to the immutable form —
   * see the module docstring for the rationale. Tests can override.
   */
  cacheControl?: string
}

// ---------------------------------------------------------------------------
// Extension → Content-Type
// ---------------------------------------------------------------------------

/**
 * Minimal MIME map covering every asset type the Gbox Dawn seed
 * theme ships plus the common font/image formats merchant themes
 * tend to include. Anything not in this table gets served as
 * `application/octet-stream` — safe default that browsers won't
 * interpret as a script.
 */
const MIME_BY_EXT: Record<string, string> = {
  // Text formats — add charset=utf-8 for correctness.
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  // Binary formats — no charset.
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
}

function contentTypeFor(path: string): string {
  const dotIdx = path.lastIndexOf('.')
  if (dotIdx === -1) return 'application/octet-stream'
  const ext = path.slice(dotIdx + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Validate and normalise the asset sub-path (the bit after
 * `/assets/`). Returns the logical path `assets/<rest>` suitable
 * for `loader.load()`, or `null` when the input is unsafe.
 *
 * Rejects:
 *   • Empty string.
 *   • `..` or `.` segments (literal or percent-encoded).
 *   • Leading slash inside the sub-path (breaks the loader key).
 *   • Any null byte.
 */
function safeAssetPath(raw: string): string | null {
  if (!raw) return null
  if (raw.includes('\0')) return null

  // Reject literal and encoded traversal before decoding, so that
  // `%2e%2e` can never sneak in via a second decode pass.
  const lower = raw.toLowerCase()
  if (
    lower.includes('..') ||
    lower.includes('%2e%2e') ||
    lower.includes('%2e.') ||
    lower.includes('.%2e')
  ) {
    return null
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }

  // After decoding, re-check for traversal. Paranoid but cheap.
  if (decoded.includes('..') || decoded.includes('\0')) return null

  // No leading slash, no empty path, no trailing slash (directories
  // aren't servable).
  if (decoded.startsWith('/')) return null
  if (decoded.length === 0) return null
  if (decoded.endsWith('/')) return null

  // Split into segments and reject empty / single-dot segments.
  const segs = decoded.split('/')
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return null
  }

  return `assets/${decoded}`
}

// ---------------------------------------------------------------------------
// ETag generation
// ---------------------------------------------------------------------------

/**
 * Compute a weak-ish ETag from the loader metadata. When the loader
 * gives us an `updatedAt`, we hash it; otherwise we hash the source
 * itself (slower path, used only when the DB layer couldn't emit
 * a timestamp).
 */
function computeEtag(result: LoadResult): string {
  const hasher = createHash('sha256')
  if (result.sha256) {
    hasher.update(result.sha256)
  } else if (result.updatedAt) {
    hasher.update(result.updatedAt)
  } else {
    hasher.update(result.source)
  }
  const hex = hasher.digest('base64url').slice(0, 27)
  return `"${hex}"`
}

// ---------------------------------------------------------------------------
// CORS-needy MIME prefixes (Phase 8.3)
// ---------------------------------------------------------------------------
//
// Browsers refuse to use cross-origin fonts unless the response carries
// `Access-Control-Allow-Origin`. The set of asset types that need this
// is small and well-known: all the font formats. We do NOT enable CORS
// for CSS/JS/SVG because we don't want a third-party site embedding a
// merchant's storefront script — same-origin is the right default
// there.

const FONT_EXTS = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot'])

function needsCors(path: string): boolean {
  const dotIdx = path.lastIndexOf('.')
  if (dotIdx === -1) return false
  return FONT_EXTS.has(path.slice(dotIdx + 1).toLowerCase())
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Cache directive for error responses (404, 400). Without this, a
 * transient miss or an attacker-crafted bad path can pin a junk
 * response at the edge for hours.
 */
const NO_STORE = 'no-store'

/**
 * Build the asset middleware. Returned function is async because
 * the loader is async; callers should await it in tests but
 * Express handles promises via the 5.x async error path.
 */
export function buildAssetMiddleware(
  options: AssetMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL

  // Small closures to keep the main flow legible. Both error helpers
  // explicitly stamp `Cache-Control: no-store` so a CDN never pins a
  // 404/400 (Cloudflare's default behaviour for 404s is otherwise to
  // cache for 3min, which is brutal for freshly-published assets).
  function send404(res: Response): void {
    res.set('Cache-Control', NO_STORE)
    res.status(404).type('text/plain').send('404 Asset Not Found')
  }
  function send400(res: Response): void {
    res.set('Cache-Control', NO_STORE)
    res.status(400).type('text/plain').send('400 Bad Asset Path')
  }

  return async function assetMiddleware(req, res, next) {
    // 1. Route gating — only GET / HEAD under /assets/.
    const path = typeof req.path === 'string' ? req.path : req.url
    if (!path.startsWith('/assets/')) {
      next()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next()
      return
    }

    // 2. Path safety.
    const rawSub = path.slice('/assets/'.length)
    const logicalPath = safeAssetPath(rawSub)
    if (logicalPath === null) {
      // An empty sub-path means `/assets/` — treat as 404 (not a
      // security issue, just "no file requested").
      if (rawSub === '') {
        send404(res)
        return
      }
      send400(res)
      return
    }

    // 3. Resolve the loader.
    let loader: TemplateLoader | null
    try {
      loader = await options.getLoader(req)
    } catch (err) {
      next(err)
      return
    }
    if (loader === null) {
      send404(res)
      return
    }

    // 4. Load.
    let result: LoadResult | null
    try {
      result = await loader.loadWithMeta(logicalPath)
    } catch (err) {
      next(err)
      return
    }
    if (result === null) {
      send404(res)
      return
    }

    // 5. Build response headers.
    //
    // The header set is split into three groups so the intent is
    // obvious in the wire trace:
    //
    //   • Browser cache + revalidation:  Cache-Control, ETag,
    //                                    Last-Modified
    //   • Edge / CDN cache:              CDN-Cache-Control, Vary
    //   • Security + CORS:               X-Content-Type-Options,
    //                                    Access-Control-Allow-Origin
    //
    // CDN-Cache-Control is the Cloudflare/Fastly/Akamai standard for
    // a separate edge directive — it lets us keep a long edge TTL
    // even if we ever weaken the browser-side Cache-Control. Today
    // they're identical, but the header is here so the migration is
    // a one-line change.
    //
    // Vary: Accept-Encoding tells the edge to key the cache on the
    // compression negotiation, so a brotli client and a gzip client
    // each get the right pre-compressed body.
    //
    // X-Content-Type-Options: nosniff stops legacy browsers from
    // re-interpreting a CSS file as JS based on the bytes — cheap
    // belt-and-braces.
    //
    // CORS for fonts is required by every browser. We restrict it
    // to font extensions so a third-party site can't embed a
    // merchant's storefront JS by using <script crossorigin>.
    const etag = computeEtag(result)
    const contentType = contentTypeFor(logicalPath)

    res.set('Content-Type', contentType)
    res.set('Cache-Control', cacheControl)
    res.set('CDN-Cache-Control', cacheControl)
    res.set('Vary', 'Accept-Encoding')
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('ETag', etag)
    if (result.updatedAt) {
      res.set('Last-Modified', new Date(result.updatedAt).toUTCString())
    }
    if (needsCors(logicalPath)) {
      res.set('Access-Control-Allow-Origin', '*')
    }

    // 6. Conditional GET — 304 when If-None-Match matches.
    // We deliberately leave the cache + ETag headers in place on the
    // 304 so a CDN can refresh its TTL on a revalidation hit.
    const inm = req.headers['if-none-match']
    if (typeof inm === 'string' && inm === etag) {
      res.status(304).end('')
      return
    }

    // 7. Body.
    if (req.method === 'HEAD') {
      res.status(200).end('')
      return
    }
    res.status(200).send(result.source)
  }
}

// Re-export types callers commonly need alongside the factory.
export type { TemplateLoader, LoadResult }
