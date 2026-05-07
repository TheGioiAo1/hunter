/**
 * Server-side event dispatch — Meta CAPI + GA4 Measurement Protocol +
 * TikTok Events API.
 *
 * Entry point: `dispatchServerSide`. It loads every active pixel for
 * the shop, fans the canonical event out to each provider's API in
 * parallel (Promise.allSettled so one slow partner doesn't block the
 * others), and writes one audit row per dispatch to
 * `tracking_events_log`.
 *
 * Client-side pixel fires happen independently in the browser; both
 * carry the SAME event_id so each partner dedupes us.
 *
 * PII handling:
 *  - Meta CAPI requires SHA-256(email) and SHA-256(phone) — we do
 *    that here, never sending plaintext.
 *  - GA4 MP does not want PII; we strip it.
 *  - TikTok Events API also wants SHA-256 for email/phone.
 *  - Logged request_payload is redacted (no PII, no tokens).
 */

import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { partnerEventName } from './event-map.ts'
import { listActivePixelsWithTokens } from './config.ts'
import type {
  CanonicalEvent,
  TrackingEventPayload,
  TrackingPixelWithToken,
  TrackingProvider,
} from './types.ts'

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface DispatchAttempt {
  pixelRowId: string
  provider: TrackingProvider
  eventName: CanonicalEvent
  success: boolean
  httpStatus: number | null
  latencyMs: number
  errorMessage: string | null
}

export interface DispatchResult {
  totalPixels: number
  attempts: DispatchAttempt[]
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fan the canonical event out to every active pixel for a shop.
 * Writes one log row per attempt, returns a summary. Never throws —
 * individual pixel errors are captured in `attempts[].errorMessage`.
 */
export async function dispatchServerSide(
  db: Kysely<Database>,
  shopId: string,
  payload: TrackingEventPayload,
): Promise<DispatchResult> {
  const pixels = await listActivePixelsWithTokens(db, shopId)
  const relevant = pixels.filter((p) => p.eventsEnabled.includes(payload.canonicalEvent))
  if (relevant.length === 0) {
    return { totalPixels: 0, attempts: [] }
  }

  const attempts = await Promise.all(
    relevant.map((pixel) => dispatchOne(db, shopId, pixel, payload)),
  )
  return { totalPixels: relevant.length, attempts }
}

/** Dispatch one canonical event to one pixel row. */
async function dispatchOne(
  db: Kysely<Database>,
  shopId: string,
  pixel: TrackingPixelWithToken,
  payload: TrackingEventPayload,
): Promise<DispatchAttempt> {
  const started = Date.now()
  let httpStatus: number | null = null
  let success = false
  let errorMessage: string | null = null
  let responseBody: string | null = null
  let requestPayload: unknown = null

  try {
    if (pixel.provider === 'gtm') {
      // GTM has no server-side API; its role is to inject dataLayer
      // on the storefront. Mark as success so the UI doesn't confuse
      // merchants with fake failures.
      success = true
      httpStatus = 0
      requestPayload = { note: 'GTM is client-side only — server skips dispatch.' }
    } else if (pixel.provider === 'meta_pixel') {
      const r = await sendMetaCapi(pixel, payload)
      httpStatus = r.httpStatus
      success = r.success
      responseBody = r.responseBody
      errorMessage = r.errorMessage
      requestPayload = r.requestPayload
    } else if (pixel.provider === 'ga4') {
      const r = await sendGa4Mp(pixel, payload)
      httpStatus = r.httpStatus
      success = r.success
      responseBody = r.responseBody
      errorMessage = r.errorMessage
      requestPayload = r.requestPayload
    } else if (pixel.provider === 'tiktok') {
      const r = await sendTikTokEvents(pixel, payload)
      httpStatus = r.httpStatus
      success = r.success
      responseBody = r.responseBody
      errorMessage = r.errorMessage
      requestPayload = r.requestPayload
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
  }

  const latencyMs = Date.now() - started

  // Audit row — fire and forget so a log DB blip doesn't fail the
  // entire dispatch. Errors here are swallowed intentionally.
  try {
    await db
      .insertInto('tracking_events_log')
      .values({
        shop_id: shopId,
        pixel_id_ref: pixel.id,
        event_id: payload.eventId,
        event_name: payload.canonicalEvent,
        provider: pixel.provider,
        http_status: httpStatus,
        success,
        error_message: errorMessage,
        latency_ms: latencyMs,
        request_payload: requestPayload ? JSON.stringify(requestPayload) : null,
        response_body: responseBody,
      })
      .execute()
  } catch {
    // swallow — the attempt itself is what matters to the caller
  }

  return {
    pixelRowId: pixel.id,
    provider: pixel.provider,
    eventName: payload.canonicalEvent,
    success,
    httpStatus,
    latencyMs,
    errorMessage,
  }
}

// ---------------------------------------------------------------------------
// Provider clients
// ---------------------------------------------------------------------------

interface ProviderResult {
  httpStatus: number
  success: boolean
  responseBody: string | null
  errorMessage: string | null
  requestPayload: unknown
}

/** SHA-256 hex — Meta/TikTok PII normalization. */
function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw.trim().toLowerCase()).digest('hex')
}

/** Meta Conversions API — v18.0 */
async function sendMetaCapi(
  pixel: TrackingPixelWithToken,
  payload: TrackingEventPayload,
): Promise<ProviderResult> {
  if (!pixel.apiToken) {
    return {
      httpStatus: 0,
      success: false,
      responseBody: null,
      errorMessage: 'meta_pixel has no CAPI access token configured',
      requestPayload: null,
    }
  }

  const userData: Record<string, unknown> = {}
  if (payload.userEmail) userData.em = [sha256Hex(payload.userEmail)]
  if (payload.userPhone) userData.ph = [sha256Hex(payload.userPhone)]
  if (payload.userExternalId) userData.external_id = [sha256Hex(payload.userExternalId)]
  if (payload.clientIp) userData.client_ip_address = payload.clientIp
  if (payload.userAgent) userData.client_user_agent = payload.userAgent
  if (payload.fbp) userData.fbp = payload.fbp
  if (payload.fbc) userData.fbc = payload.fbc

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: payload.canonicalEvent, // Meta = canonical
        event_time: Math.floor(payload.eventTimeMs / 1000),
        event_id: payload.eventId,
        event_source_url: payload.sourceUrl,
        action_source: 'website',
        user_data: userData,
        custom_data: payload.customData ?? {},
      },
    ],
  }
  if (pixel.testEventCode) body.test_event_code = pixel.testEventCode

  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(pixel.pixelId)}/events?access_token=${encodeURIComponent(pixel.apiToken)}`

  return httpPost(url, body, { tokenInUrl: true })
}

/** GA4 Measurement Protocol */
async function sendGa4Mp(
  pixel: TrackingPixelWithToken,
  payload: TrackingEventPayload,
): Promise<ProviderResult> {
  if (!pixel.apiToken) {
    return {
      httpStatus: 0,
      success: false,
      responseBody: null,
      errorMessage: 'ga4 pixel has no Measurement Protocol api_secret configured',
      requestPayload: null,
    }
  }

  const clientId = payload.ga4ClientId || `${Date.now()}.${Math.floor(Math.random() * 1e9)}`

  const body = {
    client_id: clientId,
    timestamp_micros: payload.eventTimeMs * 1000,
    events: [
      {
        name: partnerEventName('ga4', payload.canonicalEvent),
        params: {
          page_location: payload.sourceUrl,
          engagement_time_msec: 1,
          ...(payload.customData ?? {}),
        },
      },
    ],
  }

  const debugPath = pixel.testEventCode ? 'debug/mp/collect' : 'mp/collect'
  const url = `https://www.google-analytics.com/${debugPath}?measurement_id=${encodeURIComponent(pixel.pixelId)}&api_secret=${encodeURIComponent(pixel.apiToken)}`

  return httpPost(url, body, { tokenInUrl: true })
}

/** TikTok Events API — v1.3 */
async function sendTikTokEvents(
  pixel: TrackingPixelWithToken,
  payload: TrackingEventPayload,
): Promise<ProviderResult> {
  if (!pixel.apiToken) {
    return {
      httpStatus: 0,
      success: false,
      responseBody: null,
      errorMessage: 'tiktok pixel has no Events API access token configured',
      requestPayload: null,
    }
  }

  const user: Record<string, unknown> = {}
  if (payload.userEmail) user.email = sha256Hex(payload.userEmail)
  if (payload.userPhone) user.phone = sha256Hex(payload.userPhone)
  if (payload.userExternalId) user.external_id = sha256Hex(payload.userExternalId)
  if (payload.clientIp) user.ip = payload.clientIp
  if (payload.userAgent) user.user_agent = payload.userAgent

  const body: Record<string, unknown> = {
    pixel_code: pixel.pixelId,
    event: partnerEventName('tiktok', payload.canonicalEvent),
    event_id: payload.eventId,
    timestamp: new Date(payload.eventTimeMs).toISOString(),
    context: {
      ad: payload.ttclid ? { callback: payload.ttclid } : undefined,
      user,
      page: { url: payload.sourceUrl },
    },
    properties: payload.customData ?? {},
  }
  if (pixel.testEventCode) body.test_event_code = pixel.testEventCode

  const url = 'https://business-api.tiktok.com/open_api/v1.3/event/track/'

  return httpPostWithHeaders(url, body, { 'Access-Token': pixel.apiToken })
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 5000

interface RedactOpts {
  tokenInUrl?: boolean
}

async function httpPost(
  url: string,
  body: unknown,
  opts: RedactOpts = {},
): Promise<ProviderResult> {
  return httpPostWithHeaders(url, body, {}, opts)
}

async function httpPostWithHeaders(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string>,
  opts: RedactOpts = {},
): Promise<ProviderResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    return {
      httpStatus: res.status,
      success: res.ok,
      responseBody: text.slice(0, 2000),
      errorMessage: res.ok ? null : `HTTP ${res.status}`,
      requestPayload: redactRequest(url, body, opts),
    }
  } catch (err) {
    return {
      httpStatus: 0,
      success: false,
      responseBody: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      requestPayload: redactRequest(url, body, opts),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Build a loggable version of the request — scrub tokens and PII. */
function redactRequest(url: string, body: unknown, opts: RedactOpts): unknown {
  const redactedUrl = opts.tokenInUrl
    ? url.replace(/(access_token|api_secret)=[^&]+/gi, '$1=[REDACTED]')
    : url
  return {
    url: redactedUrl,
    body: redactBody(body),
  }
}

function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(body))
  walkAndRedact(clone)
  return clone
}

function walkAndRedact(node: unknown): void {
  if (!node || typeof node !== 'object') return
  for (const key of Object.keys(node as Record<string, unknown>)) {
    const val = (node as Record<string, unknown>)[key]
    if (/pass(word)?|token|secret|access[-_]?token/i.test(key)) {
      ;(node as Record<string, unknown>)[key] = '[REDACTED]'
    } else if (/^(em|ph|external_id|email|phone)$/i.test(key)) {
      // PII — never persist plaintext or hashed to our log table.
      ;(node as Record<string, unknown>)[key] = '[PII_STRIPPED]'
    } else if (val && typeof val === 'object') {
      walkAndRedact(val)
    }
  }
}
