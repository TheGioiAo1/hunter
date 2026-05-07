/**
 * Gbox Storefront — UTM Attribution Middleware (Sprint 2b)
 *
 * Captures UTM parameters (utm_source, utm_medium, utm_campaign,
 * utm_content, utm_term) from the request query string and persists
 * them in a first-party `gbox_utm` cookie so the attribution survives
 * across the buyer's browsing session and is still available when
 * they hit POST /checkout.
 *
 * Design:
 *
 *   1. **First-touch wins.** If the cookie is already set AND any UTM
 *      param is present in the query, we prefer the cookie values —
 *      the first campaign the visitor arrived from gets credit. This
 *      matches Shopify's Shop Pay attribution behaviour. A merchant
 *      who wants last-touch can clear the cookie on their landing
 *      page.
 *
 *   2. **Only persist on non-empty UTM.** If the query has no UTM
 *      params and no cookie exists, we do nothing — no wasted cookie
 *      on visitors who arrive from typed URLs.
 *
 *   3. **Always expose `req.gboxUtm`.** Downstream code (the checkout
 *      route) reads this without needing to parse cookies again. An
 *      empty object `{}` means "no attribution".
 *
 *   4. **Never throws.** Malformed cookies or mile-long query params
 *      are discarded silently. A bad UTM cookie must NEVER break a
 *      page request.
 *
 * Cookie format: URL-encoded JSON blob `{"s":..,"m":..,"c":..,"t":..,"x":..}`
 * with short keys so we stay well under RFC 6265 limits even with
 * full utf-8 campaign names. The cookie is HttpOnly=false so that
 * the theme's client-side analytics can read it too (e.g. for a GTM
 * dataLayer push). It is SameSite=Lax and 30 days TTL.
 */

import type { NextFunction, Request, Response } from 'express'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UtmAttribution {
  source?: string | null
  medium?: string | null
  campaign?: string | null
  content?: string | null
  term?: string | null
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Attached by the UTM capture middleware. Empty `{}` when none. */
    gboxUtm?: UtmAttribution
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** First-party cookie name holding the URL-encoded JSON UTM blob. */
export const UTM_COOKIE_NAME = 'gbox_utm'

/** Max length of any single UTM value we are willing to store. */
const MAX_UTM_LEN = 255

/** 30 days in seconds — cookie TTL matches Shopify attribution window. */
const UTM_TTL_SECONDS = 60 * 60 * 24 * 30

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > MAX_UTM_LEN) return null
  // Reject control chars to prevent header injection.
  if (/[\r\n\t]/.test(trimmed)) return null
  return trimmed
}

function isEmpty(u: UtmAttribution): boolean {
  return (
    !u.source &&
    !u.medium &&
    !u.campaign &&
    !u.content &&
    !u.term
  )
}

function readFromQuery(query: Record<string, unknown>): UtmAttribution {
  return {
    source: clamp(query.utm_source),
    medium: clamp(query.utm_medium),
    campaign: clamp(query.utm_campaign),
    content: clamp(query.utm_content),
    term: clamp(query.utm_term),
  }
}

function readFromCookie(raw: string | undefined | null): UtmAttribution {
  if (!raw) return {}
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(decoded) as {
      s?: unknown
      m?: unknown
      c?: unknown
      t?: unknown
      x?: unknown
    }
    if (!parsed || typeof parsed !== 'object') return {}
    return {
      source: clamp(parsed.s),
      medium: clamp(parsed.m),
      campaign: clamp(parsed.c),
      content: clamp(parsed.t),
      term: clamp(parsed.x),
    }
  } catch {
    return {}
  }
}

function encodeForCookie(u: UtmAttribution): string {
  return encodeURIComponent(
    JSON.stringify({
      s: u.source ?? undefined,
      m: u.medium ?? undefined,
      c: u.campaign ?? undefined,
      t: u.content ?? undefined,
      x: u.term ?? undefined,
    }),
  )
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface UtmCaptureOptions {
  /**
   * Override the cookie name. Mostly for tests. The default
   * `gbox_utm` is what downstream readers expect.
   */
  cookieName?: string
  /**
   * Cookie TTL in seconds. Defaults to 30 days.
   */
  ttlSeconds?: number
}

/**
 * Build the UTM capture middleware. Synchronous and allocation-light.
 */
export function buildUtmCaptureMiddleware(
  options: UtmCaptureOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const cookieName = options.cookieName ?? UTM_COOKIE_NAME
  const ttl = options.ttlSeconds ?? UTM_TTL_SECONDS

  return function utmCaptureMiddleware(req, res, next) {
    // The cookie middleware (cookies.ts) may have already parsed
    // `req.cookies` for us. Fall back to reading raw header if not.
    const existing =
      (req.gboxCookies?.all?.[cookieName] as string | undefined) ??
      (req.cookies?.[cookieName] as string | undefined) ??
      null

    const cookieUtm = readFromCookie(existing)
    const queryUtm = readFromQuery(
      (req.query ?? {}) as Record<string, unknown>,
    )

    // First-touch wins: prefer cookie values, fall in query only when
    // the cookie slot is empty. This matches Shopify's attribution.
    const merged: UtmAttribution = {
      source: cookieUtm.source ?? queryUtm.source ?? null,
      medium: cookieUtm.medium ?? queryUtm.medium ?? null,
      campaign: cookieUtm.campaign ?? queryUtm.campaign ?? null,
      content: cookieUtm.content ?? queryUtm.content ?? null,
      term: cookieUtm.term ?? queryUtm.term ?? null,
    }

    req.gboxUtm = merged

    // Persist the cookie only when (a) the query introduced NEW
    // attribution that wasn't in the cookie, and (b) the merged blob
    // is non-empty. We avoid rewriting an unchanged cookie to keep
    // Set-Cookie headers off hot paths.
    const cookieWasEmpty = isEmpty(cookieUtm)
    const queryHasSomething = !isEmpty(queryUtm)
    if (cookieWasEmpty && queryHasSomething && !isEmpty(merged)) {
      try {
        res.cookie(cookieName, encodeForCookie(merged), {
          maxAge: ttl * 1000,
          httpOnly: false,
          sameSite: 'lax',
          path: '/',
          // `secure` is set by the reverse proxy config in prod; leave
          // it off so local dev (http://localhost) still works.
        })
      } catch {
        // Defensive — some test shims don't support res.cookie.
      }
    }

    next()
  }
}
