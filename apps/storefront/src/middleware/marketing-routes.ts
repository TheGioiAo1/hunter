/**
 * Gbox Storefront — Marketing subscribe route (Stage 4.5)
 *
 * Single endpoint: `POST /marketing/subscribe`.
 *
 * Collects a newsletter signup from the storefront — exit-intent
 * popup, footer form, checkout upsell, all of them post the same
 * shape:
 *
 *   { email, name?, source? }
 *
 * The route validates the input, normalises the email, and hands
 * off to the caller-provided `subscribe` dep. The dep is the only
 * side-effectful thing in the module — it reaches into Postgres,
 * fires an email confirmation, and persists audit metadata. The
 * route itself stays testable without any of that.
 *
 * Why not merge with `POST /events`? The events beacon is
 * fire-and-forget (always 204, swallows errors, no feedback loop).
 * A subscribe needs a response so the popup can show
 * "thanks! check your inbox" vs "you're already on the list".
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubscribeRejection =
  | 'already_subscribed'
  | 'blocked'
  | 'rate_limited'

export type SubscribeResult =
  | { ok: true }
  | { ok: false; reason: SubscribeRejection }

export interface SubscribeInput {
  email: string
  name: string | null
  source: string
  locale: string | null
  userAgent: string
  referrer: string | null
  customerId: string | null
}

export interface MarketingRoutesDeps {
  subscribe: (shopId: string, input: SubscribeInput) => Promise<SubscribeResult>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_FIELD_LEN = 200

export function buildMarketingRoutes(
  deps: MarketingRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const router: Router = express.Router()

  // 2 KiB is plenty for an email + optional name + source. Anything
  // larger is abuse — body-parser returns `entity.too.large` and we
  // map it to 400 in the error tail below.
  router.use('/marketing/subscribe', express.json({ limit: '2kb' }))

  router.post('/marketing/subscribe', async (req, res) => {
    try {
      const shopId =
        typeof req.gboxShopId === 'string' ? req.gboxShopId : null
      if (!shopId) {
        res.status(404).type('text/plain').send('Not Found')
        return
      }

      const body = req.body as Record<string, unknown> | undefined
      if (!body || typeof body !== 'object') {
        jsonError(res, 400, 'invalid body')
        return
      }

      const rawEmail = typeof body.email === 'string' ? body.email : null
      if (!rawEmail) {
        jsonError(res, 400, 'email is required')
        return
      }
      const email = rawEmail.trim().toLowerCase()
      if (email.length > MAX_FIELD_LEN || !EMAIL_RE.test(email)) {
        jsonError(res, 400, 'invalid email')
        return
      }

      const rawName = typeof body.name === 'string' ? body.name.trim() : ''
      const name =
        rawName.length > 0 && rawName.length <= MAX_FIELD_LEN ? rawName : null

      const rawSource =
        typeof body.source === 'string' ? body.source.trim() : ''
      const source =
        rawSource.length > 0 && rawSource.length <= MAX_FIELD_LEN
          ? rawSource
          : 'unknown'

      const ua = req.headers['user-agent']
      const userAgent = typeof ua === 'string' ? ua : ''
      const referrerHeader = req.headers.referer
      const referrer =
        typeof referrerHeader === 'string' && referrerHeader.length > 0
          ? referrerHeader
          : null

      const locale =
        req.gboxLocale && typeof req.gboxLocale.locale === 'string'
          ? req.gboxLocale.locale
          : null

      const customerId =
        typeof req.gboxCustomerId === 'string' && req.gboxCustomerId.length > 0
          ? req.gboxCustomerId
          : null

      const result = await deps.subscribe(shopId, {
        email,
        name,
        source,
        locale,
        userAgent,
        referrer,
        customerId,
      })

      if (result.ok) {
        res.status(204).end()
        return
      }

      // Soft rejections are 200 so the popup JS can show a friendly
      // message without treating a dupe as a crash. Hard rejections
      // (blocked domains, global rate limit) use 429/403.
      switch (result.reason) {
        case 'already_subscribed':
          res
            .status(200)
            .type('application/json')
            .send(JSON.stringify({ status: 'already_subscribed' }))
          return
        case 'rate_limited':
          jsonError(res, 429, 'rate limited')
          return
        case 'blocked':
          jsonError(res, 403, 'blocked')
          return
        default: {
          const _n: never = result.reason
          jsonError(res, 400, 'rejected')
          return _n
        }
      }
    } catch (err) {
      try {
        req.gboxCtx?.logger?.warn({ err }, 'marketing subscribe route threw')
      } catch {
        // ignore
      }
      jsonError(res, 500, 'internal error')
    }
  })

  // Map body-parser errors to 400 instead of Express's default 500.
  router.use(
    '/marketing/subscribe',
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (
        err &&
        typeof err === 'object' &&
        'type' in err &&
        typeof (err as { type: unknown }).type === 'string' &&
        ((err as { type: string }).type.startsWith('entity.') ||
          (err as { type: string }).type === 'charset.unsupported')
      ) {
        jsonError(res, 400, 'invalid body')
        return
      }
      jsonError(res, 400, 'bad request')
    },
  )

  return router as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(res: Response, status: number, message: string): void {
  res
    .status(status)
    .type('application/json')
    .send(JSON.stringify({ error: message }))
}
