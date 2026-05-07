/**
 * Storefront — Pixel Injector middleware (migration 034).
 *
 * Sits after resolve-shop and before the storefront catch-all. For
 * every 2xx `text/html` response it:
 *
 *   1. Looks up the shop's active tracking pixels (cached 60s).
 *   2. Calls `buildClientSnippet()` to produce the `<script>` body.
 *   3. Injects the block immediately before `</head>` so fbq/gtag/ttq
 *      load before the first render.
 *
 * We do NOT touch the Liquid theme engine — a response rewriter keeps
 * every theme automatically tracked, and merchants can't accidentally
 * nuke the pixel by editing Liquid.
 *
 * The injector monkey-patches `res.send` + `res.end`. Non-HTML
 * responses pass through untouched. If `req.gboxShopId` isn't set
 * (e.g. `/_health`, static assets) the middleware no-ops.
 */

import type { Request, Response, NextFunction } from 'express'
import { buildClientSnippet, listActivePixels } from '@gbox/core/modules/tracking/index.js'
import type { TrackingPixelPublic } from '@gbox/core/modules/tracking/index.js'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000

interface CacheEntry {
  expiresAt: number
  pixels: TrackingPixelPublic[]
}

const pixelCache = new Map<string, CacheEntry>()

/** Drop a shop's entry — called when the admin saves a pixel. */
export function invalidatePixelCache(shopId: string): void {
  pixelCache.delete(shopId)
}

async function loadCachedPixels(
  db: Kysely<Database>,
  shopId: string,
): Promise<TrackingPixelPublic[]> {
  const now = Date.now()
  const hit = pixelCache.get(shopId)
  if (hit && hit.expiresAt > now) return hit.pixels

  const fresh = await listActivePixels(db, shopId)
  pixelCache.set(shopId, { expiresAt: now + CACHE_TTL_MS, pixels: fresh })
  return fresh
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export interface PixelInjectorOptions {
  db: Kysely<Database>
  /**
   * Full URL the client hits for `/api/track`. Typically the
   * platform-api host; left configurable so staging/preview envs
   * can point at a separate backend.
   */
  trackEndpoint: string
}

export function buildPixelInjectorMiddleware(
  opts: PixelInjectorOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  return function pixelInjector(req, res, next) {
    // Only HTML GET responses carry a `<head>`. Cart POSTs, beacons,
    // etc. are JSON or text/plain — skip them without patching.
    if (req.method !== 'GET') return next()

    const shopId =
      typeof (req as any).gboxShopId === 'string' ? ((req as any).gboxShopId as string) : null
    if (!shopId) return next()

    // Patch res.send + res.end so we catch both code paths. Many
    // route handlers use res.send(html); the theme engine's own
    // stream path ends up in res.end(buffer).
    const origSend = res.send.bind(res)
    const origEnd = res.end.bind(res)
    let alreadyPatched = false

    const injectIntoHtml = async (body: unknown): Promise<unknown> => {
      // Guard: only rewrite text/html, only 2xx, only strings.
      if (alreadyPatched) return body
      if (res.statusCode < 200 || res.statusCode >= 300) return body
      const ct = String(res.get('content-type') ?? '')
      if (!/text\/html/i.test(ct)) return body

      let html: string
      if (typeof body === 'string') {
        html = body
      } else if (Buffer.isBuffer(body)) {
        html = body.toString('utf8')
      } else {
        return body
      }

      try {
        const pixels = await loadCachedPixels(opts.db, shopId)
        if (pixels.length === 0) return body // nothing to inject

        const snippet = buildClientSnippet({
          pixels,
          trackEndpoint: opts.trackEndpoint,
          shopId,
        })
        const tag = `<script data-gbox-tracker="1">${snippet}</script>`

        const headClose = html.search(/<\/head\s*>/i)
        const out =
          headClose === -1
            ? // No </head> — fallback: stamp at the top so the bootstrap still runs.
              tag + html
            : html.slice(0, headClose) + tag + html.slice(headClose)

        alreadyPatched = true
        // Adjust Content-Length so gzip / HTTP/1 keep-alive doesn't truncate.
        if (res.get('content-length')) {
          res.setHeader('Content-Length', Buffer.byteLength(out, 'utf8'))
        }
        return out
      } catch (err) {
        try {
          ;(req as any).gboxCtx?.logger?.warn(
            { err },
            'pixel-injector failed — serving page without pixels',
          )
        } catch {
          // fall through
        }
        return body
      }
    }

    // res.send(...) — sync signature but our injector is async, so
    // we flip it to a promise chain. Express allows returning self
    // from res.send, which lets us preserve the fluent API.
    ;(res as any).send = function patchedSend(body: unknown) {
      injectIntoHtml(body)
        .then((finalBody) => origSend(finalBody as any))
        .catch(() => origSend(body as any))
      return res
    }

    ;(res as any).end = function patchedEnd(
      chunk?: unknown,
      encoding?: BufferEncoding | (() => void),
      cb?: () => void,
    ) {
      if (chunk === undefined) {
        return origEnd(chunk as any, encoding as any, cb as any)
      }
      injectIntoHtml(chunk)
        .then((finalBody) =>
          origEnd(finalBody as any, encoding as any, cb as any),
        )
        .catch(() => origEnd(chunk as any, encoding as any, cb as any))
      return res
    }

    next()
  }
}
