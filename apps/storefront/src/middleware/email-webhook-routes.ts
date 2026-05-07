/**
 * Gbox Storefront — Email webhook routes (Phase 14 PR4.B)
 *
 * Two POST endpoints that consume bounce / complaint / delivery feedback
 * from upstream mail transports:
 *
 *   POST /webhooks/email/ses
 *     AWS SNS envelope (application/json). SigningCertURL fetched with
 *     allowlist-guarded HTTPS; signature verified per AWS spec; payload
 *     classified into hard/soft/complaint/delivery; matched delivery
 *     marked bounced; suppression row inserted for hard + complaint.
 *
 *     Handles both Notification and SubscriptionConfirmation envelopes.
 *     The confirm URL is fetched asynchronously — we respond 200 to SNS
 *     immediately so the producer pipeline doesn't back up. Any network
 *     failure on the confirm fetch is logged server-side (the caller
 *     supplies `confirmSubscriptionUrl`) but never bubbles to SNS.
 *
 *   POST /webhooks/email/generic
 *     Non-SES providers (Resend, Postmark, home-grown SMTP DSN relays).
 *     Body is the SES-shaped inner Message JSON — same classifier path,
 *     same suppression writes. Authentication is generic HMAC-SHA256
 *     over the raw body; shared secret comes from
 *     `EMAIL_WEBHOOK_GENERIC_SECRET` (or the deps-level getter in tests).
 *
 * STATUS-CODE POLICY
 * ------------------
 * SNS's retry behaviour is driven by status code:
 *   - 2xx → ack, no retry
 *   - 4xx → drop, no retry (useful for "malformed payload", so AWS
 *           doesn't retry a bad message forever)
 *   - 5xx → retry with backoff (used for our own DB outages)
 * We follow that:
 *   - Signature-invalid → 401 (attacker, don't retry)
 *   - Missing fields / parse failure → 200 (drop; logged for forensics)
 *   - DB error → 500 (we want SNS to retry)
 *   - Success → 200
 *
 * IRON RULE 5
 * -----------
 * Responses are structured JSON with a short reason enum; never template
 * strings, never god-admin terminology, never internal URLs. Server-side
 * logs carry the detail.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import express from 'express'

import type {
  HandleGenericWebhookResult,
  HandleSnsWebhookResult,
} from '@gbox/core/modules/email/webhook-handler.js'
import type { SnsEnvelope } from '@gbox/core/modules/email/webhook-verify.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailWebhookRoutesDeps {
  /**
   * Production adapter: closes over the Kysely db + default CertFetcher,
   * so the route layer never sees either. Return shape matches
   * HandleSnsWebhookResult from @gbox/core/modules/email/webhook-handler.
   */
  handleSnsWebhook: (input: {
    envelope: SnsEnvelope
    sourceIp: string | null
  }) => Promise<HandleSnsWebhookResult>

  /**
   * Production adapter: closes over the Kysely db. Same separation as
   * handleSnsWebhook — the route layer cares about HTTP concerns only.
   */
  handleGenericWebhook: (input: {
    rawBody: string
    signatureBase64: string
    secret: string
    shopIdHint: string | null
    sourceIp: string | null
  }) => Promise<HandleGenericWebhookResult>

  /**
   * Production: `(url) => confirmSnsSubscription(url)` from webhook-handler.
   * Called asynchronously after responding 200 to the SubscriptionConfirmation
   * envelope. Errors are swallowed at the route layer — the handler should
   * log its own outcome.
   */
  confirmSubscriptionUrl: (url: string) => Promise<unknown>

  /**
   * Lazy secret lookup — called on every generic request so ops can rotate
   * the secret without restarting the storefront process. Return empty
   * string to disable the generic endpoint.
   */
  getGenericSecret: () => string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSourceIp(req: Request): string | null {
  if (typeof req.ip === 'string' && req.ip) return req.ip
  return req.socket?.remoteAddress ?? null
}

function firstHeader(req: Request, name: string): string | null {
  const v = req.headers[name.toLowerCase()]
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length > 0) return String(v[0])
  return null
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildEmailWebhookRoutes(
  deps: EmailWebhookRoutesDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const router: Router = express.Router()

  // -------------------------------------------------------------------------
  // POST /webhooks/email/ses
  // -------------------------------------------------------------------------
  //
  // SNS posts `application/json; charset=UTF-8` (or `text/plain` when the
  // subscription is created with RawMessageDelivery=false — still JSON
  // underneath). We accept either with `type: '*/*'` so quirky content-
  // type headers don't trip us up. 1 MiB is 30× the largest realistic
  // SES notification (~30 KiB) but leaves headroom for fanout payloads.
  router.post(
    '/webhooks/email/ses',
    express.json({ limit: '1mb', type: '*/*' }),
    async (req, res) => {
      const envelope = (req.body ?? {}) as SnsEnvelope

      let result: HandleSnsWebhookResult
      try {
        result = await deps.handleSnsWebhook({
          envelope,
          sourceIp: extractSourceIp(req),
        })
      } catch (err) {
        // Handler should catch its own errors; this is belt + braces.
        // eslint-disable-next-line no-console
        console.error('[email-webhook:ses] unexpected handler error', err)
        res.status(500).json({ ok: false, reason: 'db_error' })
        return
      }

      if (result.ok && result.outcome === 'subscribe_confirm') {
        // Fire + forget. AWS doesn't wait for the confirm to finish —
        // the SubscribeURL GET establishes the subscription out of band.
        // If it fails, ops gets paged by the next Notification that
        // arrives to an unconfirmed topic (or AWS's own alarms).
        deps.confirmSubscriptionUrl(result.subscribeUrl).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[email-webhook:ses] confirm fetch failed', err)
        })
        res.status(200).json({ ok: true, outcome: 'subscribe_confirm' })
        return
      }

      if (!result.ok) {
        if (result.reason === 'signature_invalid') {
          res.status(401).json({ ok: false, reason: 'signature_invalid' })
          return
        }
        if (result.reason === 'db_error') {
          res.status(500).json({ ok: false, reason: 'db_error' })
          return
        }
        // missing_field / parse_failed — drop with 200 so SNS doesn't
        // retry obviously malformed traffic. Forensics live in
        // ses_webhook_events (if we got far enough to write one) +
        // pino logs.
        res.status(200).json({ ok: true, outcome: 'dropped', reason: result.reason })
        return
      }

      if (result.outcome === 'replayed') {
        res.status(200).json({ ok: true, outcome: 'replayed', eventId: result.eventId })
        return
      }

      // Successful processed
      res.status(200).json({
        ok: true,
        outcome: 'processed',
        eventId: result.eventId,
        matchedDeliveryId: result.matchedDeliveryId,
        eventsCreated: result.eventsCreated,
        suppressionsCreated: result.suppressionsCreated,
      })
    },
  )

  // -------------------------------------------------------------------------
  // POST /webhooks/email/generic
  // -------------------------------------------------------------------------
  //
  // Raw body access is required for HMAC — parsing the JSON first would
  // change whitespace / key order and invalidate the signature. We mount
  // `express.raw({ type: '*/*' })` so req.body is a Buffer we can turn
  // into a string verbatim.
  //
  // Authentication:
  //   - X-Gbox-Signature: base64(HMAC-SHA256(secret, rawBody))
  //   - Optional X-Gbox-Shop-Id: used when the transport doesn't embed a
  //     shop-scoped matcher in the payload. Precedence inside the
  //     handler: matched delivery > hint > null.
  router.post(
    '/webhooks/email/generic',
    express.raw({ limit: '1mb', type: '*/*' }),
    async (req, res) => {
      const secret = deps.getGenericSecret()
      if (!secret) {
        // Endpoint is disabled (missing secret) — respond 404-like so
        // it doesn't look enabled-but-broken to probes.
        res.status(404).json({ ok: false, reason: 'not_found' })
        return
      }

      const rawBody =
        req.body instanceof Buffer
          ? req.body.toString('utf8')
          : typeof req.body === 'string'
            ? req.body
            : ''
      const signature = firstHeader(req, 'x-gbox-signature') ?? ''
      const shopIdHint = firstHeader(req, 'x-gbox-shop-id')

      let result: HandleGenericWebhookResult
      try {
        result = await deps.handleGenericWebhook({
          rawBody,
          signatureBase64: signature,
          secret,
          shopIdHint,
          sourceIp: extractSourceIp(req),
        })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[email-webhook:generic] unexpected handler error', err)
        res.status(500).json({ ok: false, reason: 'db_error' })
        return
      }

      if (!result.ok) {
        if (result.reason === 'signature_invalid') {
          res.status(401).json({ ok: false, reason: 'signature_invalid' })
          return
        }
        if (result.reason === 'missing_secret') {
          // Should have been caught above; defense in depth.
          res.status(500).json({ ok: false, reason: 'misconfigured' })
          return
        }
        if (result.reason === 'db_error') {
          res.status(500).json({ ok: false, reason: 'db_error' })
          return
        }
        // parse_failed — drop.
        res.status(200).json({ ok: true, outcome: 'dropped', reason: result.reason })
        return
      }

      if (result.outcome === 'replayed') {
        res.status(200).json({ ok: true, outcome: 'replayed', eventId: result.eventId })
        return
      }

      res.status(200).json({
        ok: true,
        outcome: 'processed',
        eventId: result.eventId,
        matchedDeliveryId: result.matchedDeliveryId,
        eventsCreated: result.eventsCreated,
        suppressionsCreated: result.suppressionsCreated,
      })
    },
  )

  return router as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void
}
