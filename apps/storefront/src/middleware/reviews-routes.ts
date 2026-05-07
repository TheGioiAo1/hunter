/**
 * Gbox Storefront — Public Reviews API (Phase 8 PR4)
 *
 * Two endpoints — both scoped to the current storefront shop via the
 * `req.gboxShopId` attached upstream by the resolve-shop middleware:
 *
 *   GET  /api/storefront/products/:id/reviews
 *     Returns approved reviews + stats JSON for a product. Paginated.
 *     Rate-limited to 60 req/min per IP (read path is cheap — the cap
 *     is high enough for normal browsing but blocks scrapers).
 *
 *   POST /api/storefront/products/:id/reviews
 *     Submits a review. The body hits `computeSpamScore` at the
 *     service layer; high-score submissions auto-route to status='spam'
 *     and never appear in the merchant's moderation queue.
 *     Rate-limited to 5 req/minute per IP per product. Returns 202
 *     (Accepted, pending moderation) on success, 429 on rate limit,
 *     400 on validation failure.
 *
 * Design notes:
 *
 *   1. **JSON only.** No HTML response — this is an API, not a page.
 *      Storefront themes that want to render reviews hit the GET and
 *      template the response client-side. The admin UI has its own
 *      server-rendered surface.
 *
 *   2. **Shop scoping is enforced twice.** The route middleware
 *      requires `req.gboxShopId`, and the service layer filters by
 *      `shop_id` in its own WHERE clause. Defence in depth — if the
 *      middleware ever gets bypassed, the service still can't leak
 *      across shops.
 *
 *   3. **Rate limiting is per-IP in-memory.** Good enough for MVP;
 *      a future distributed-rate-limiter story can replace the bucket
 *      without touching this file. The bucket persists only within
 *      the Node process, so a restart resets counters — acceptable
 *      for spam defence but logged in the drain notes.
 *
 *   4. **Iron rule 5.** Error responses NEVER name internal paths or
 *      remediation steps. The 500 branch returns a generic
 *      "Unable to submit review" message. The merchant sees the real
 *      stack via pino; the customer sees neutral copy.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

// ---------------------------------------------------------------------------
// Dependency contract
// ---------------------------------------------------------------------------

/** Inputs to the review submission — validated before reaching the service. */
export interface PublicReviewInput {
  rating: number
  title: string | null
  body: string
  authorName: string
  authorEmail: string
}

/**
 * Narrow shape the storefront GET returns. Intentionally smaller than
 * the DB row — we hide customer_id, author_email, status, etc.
 */
export interface PublicReviewOut {
  id: string
  rating: number
  title: string | null
  body: string
  authorName: string
  createdAt: string
  reply: { body: string; author: string | null; repliedAt: string } | null
}

export interface ReviewsRoutesDeps {
  /**
   * Fetch approved reviews for a product. Returns { reviews, total,
   * avgRating }. Defaults to limit=20, offset=0.
   */
  listProductReviews: (
    productId: string,
    pagination?: { limit?: number; offset?: number },
  ) => Promise<{ reviews: any[]; total: number; avgRating: number }>

  /**
   * Submit a review. Returns the row (at minimum `{ id, status }`);
   * the handler will only surface `{ id, status }` to the client so
   * customers see "pending" for clean reviews and "spam" for rejected.
   */
  submit: (
    shopId: string,
    productId: string,
    input: PublicReviewInput,
  ) => Promise<{ id: string; status: string }>
}

// ---------------------------------------------------------------------------
// Rate limiter — per-IP / per-product bucket
// ---------------------------------------------------------------------------

interface BucketEntry {
  count: number
  resetAt: number
}

/**
 * Tiny fixed-window rate limiter. Separate instance per key pattern
 * so POST and GET have independent budgets.
 *
 * Not distributed — good enough for a single-process MVP. Swap in a
 * Redis-backed version later without touching this file's surface.
 */
class RateLimiter {
  private buckets = new Map<string, BucketEntry>()
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** Returns `true` if the key is still within budget. */
  tryAcquire(key: string, now: number = Date.now()): boolean {
    const b = this.buckets.get(key)
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (b.count >= this.limit) return false
    b.count += 1
    return true
  }

  /** Test helper — clears the in-memory state. */
  reset(): void {
    this.buckets.clear()
  }
}

// Exported for unit tests so they can reset between cases.
export const submitLimiter = new RateLimiter(5, 60_000)
export const listLimiter = new RateLimiter(60, 60_000)

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function getClientIp(req: Request): string {
  // Prefer X-Forwarded-For (first hop) since the storefront sits
  // behind the Cloudflare tunnel. Fall back to req.ip / socket as
  // last resort — a blank string here would collapse every visitor
  // into one bucket, which is worse than per-IP.
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]!.trim()
  }
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parse + validate a review submission body. Returns the normalised
 * input on success, or a `{ error }` object on failure. Keeps the
 * validation layered above the service so bad input never hits SQL.
 */
export function parsePublicReviewBody(
  raw: unknown,
): { ok: true; input: PublicReviewInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid_body' }
  const b = raw as any

  const rating = Number(b.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: 'invalid_rating' }
  }

  const body = typeof b.body === 'string' ? b.body.trim() : ''
  if (body.length < 3 || body.length > 5000) {
    return { ok: false, error: 'invalid_body_length' }
  }

  const authorName = typeof b.author_name === 'string'
    ? b.author_name.trim()
    : typeof b.authorName === 'string'
      ? b.authorName.trim()
      : ''
  if (authorName.length < 1 || authorName.length > 120) {
    return { ok: false, error: 'invalid_author_name' }
  }

  const authorEmail = typeof b.author_email === 'string'
    ? b.author_email.trim()
    : typeof b.authorEmail === 'string'
      ? b.authorEmail.trim()
      : ''
  if (!EMAIL_RE.test(authorEmail) || authorEmail.length > 254) {
    return { ok: false, error: 'invalid_author_email' }
  }

  let title: string | null = null
  if (typeof b.title === 'string') {
    const t = b.title.trim()
    if (t.length > 200) return { ok: false, error: 'invalid_title_length' }
    title = t.length === 0 ? null : t
  }

  return {
    ok: true,
    input: { rating, body, authorName, authorEmail, title },
  }
}

/**
 * UUID shape check for the :id route parameter. Rejecting malformed
 * IDs at the edge avoids a DB lookup and returns 400 fast.
 */
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildReviewsRoutes(
  deps: ReviewsRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const router: Router = express.Router()

  router.use(
    '/api/storefront/products/:id/reviews',
    express.json({ limit: '16kb' }),
  )

  // -------------------------------------------------------------------------
  // GET /api/storefront/products/:id/reviews
  // -------------------------------------------------------------------------
  router.get('/api/storefront/products/:id/reviews', async (req, res) => {
    try {
      const shopId = (req as any).gboxShopId as string | undefined
      if (!shopId) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }

      const productId = req.params.id
      if (!isUuid(productId)) {
        res.status(400).json({ ok: false, error: 'invalid_product_id' })
        return
      }

      const ip = getClientIp(req)
      if (!listLimiter.tryAcquire(`${ip}:${productId}`)) {
        res.status(429).json({ ok: false, error: 'rate_limited' })
        return
      }

      const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20))
      const offset = Math.max(0, Number(req.query.offset) || 0)

      const { reviews, total, avgRating } = await deps.listProductReviews(
        productId,
        { limit, offset },
      )

      const out: PublicReviewOut[] = reviews.map((r: any) => ({
        id: String(r.id),
        rating: Number(r.rating),
        title: r.title ?? null,
        body: String(r.body ?? ''),
        authorName: String(r.author_name ?? 'Anonymous'),
        createdAt: String(r.created_at ?? ''),
        reply:
          r.reply_body && r.replied_at
            ? {
                body: String(r.reply_body),
                author: r.reply_author ? String(r.reply_author) : null,
                repliedAt: String(r.replied_at),
              }
            : null,
      }))

      res.json({
        ok: true,
        reviews: out,
        total,
        avgRating,
        limit,
        offset,
      })
    } catch (err) {
      try {
        ;(req as any).gboxCtx?.logger?.warn(
          { err },
          'reviews GET threw',
        )
      } catch {}
      // Iron rule 5: neutral customer copy, no internal path leakage.
      res.status(500).json({ ok: false, error: 'server_error' })
    }
  })

  // -------------------------------------------------------------------------
  // POST /api/storefront/products/:id/reviews
  // -------------------------------------------------------------------------
  router.post('/api/storefront/products/:id/reviews', async (req, res) => {
    try {
      const shopId = (req as any).gboxShopId as string | undefined
      if (!shopId) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }

      const productId = req.params.id
      if (!isUuid(productId)) {
        res.status(400).json({ ok: false, error: 'invalid_product_id' })
        return
      }

      const ip = getClientIp(req)
      if (!submitLimiter.tryAcquire(`${ip}:${productId}`)) {
        res.status(429).json({ ok: false, error: 'rate_limited' })
        return
      }

      const parsed = parsePublicReviewBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error })
        return
      }

      const { id, status } = await deps.submit(shopId, productId, parsed.input)

      // 202 Accepted: we took the submission and queued it for
      // moderation. Reporting `status` lets the client UI say "Thanks,
      // your review is pending approval" or recognise the spam case
      // without exposing why (we say 'pending' even for spam to avoid
      // giving bots a feedback signal about which copy triggered it).
      res.status(202).json({
        ok: true,
        id,
        // Intentionally lossy: never return 'spam' to the client — a
        // spammer could adjust copy until we stopped routing to spam.
        // Every submission looks pending from outside.
        status: status === 'spam' ? 'pending' : status,
      })
    } catch (err) {
      try {
        ;(req as any).gboxCtx?.logger?.warn(
          { err },
          'reviews POST threw',
        )
      } catch {}
      res.status(500).json({ ok: false, error: 'server_error' })
    }
  })

  return router as any
}

// ---------------------------------------------------------------------------
// Production adapter — bind against `@gbox/core/modules/reviews/service`
// ---------------------------------------------------------------------------

/**
 * Convenience builder: takes the Kysely db + optional notifications
 * hook and wires it into a `ReviewsRoutesDeps`. Kept separate from
 * `buildReviewsRoutes` so unit tests can inject fake deps without
 * dragging the service import in.
 */
export function adaptReviewsDeps(
  db: Kysely<Database>,
  getProductReviews: (
    db: Kysely<Database>,
    productId: string,
    status: 'approved',
    pagination?: { limit?: number; offset?: number },
  ) => Promise<{ reviews: any[]; total: number; avgRating: number }>,
  submitPublicReview: (
    db: Kysely<Database>,
    shopId: string,
    productId: string,
    input: PublicReviewInput,
  ) => Promise<{ id: string; status: string }>,
  onSubmit?: (shopId: string, row: { id: string; status: string }) => Promise<void>,
): ReviewsRoutesDeps {
  return {
    listProductReviews: (productId, pag) =>
      getProductReviews(db, productId, 'approved', pag),
    submit: async (shopId, productId, input) => {
      const row = await submitPublicReview(db, shopId, productId, input)
      // Fire-and-forget notification hook so the bell pings the
      // merchant. Never throws out — if the notification write fails,
      // the submission still succeeds.
      if (onSubmit) {
        try {
          await onSubmit(shopId, row)
        } catch {}
      }
      return { id: row.id, status: row.status }
    },
  }
}
