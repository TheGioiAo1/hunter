/**
 * Gbox Storefront — Cookie Middleware (Stage 3A.5)
 *
 * Parses the incoming `Cookie` header once per request and attaches
 * a typed `req.gboxCookies` object with the three storefront
 * cookies the router currently cares about:
 *
 *   • `cart`     — opaque cart token, consumed by the datasource
 *                   loader via `req.cookies['cart']`.
 *   • `_session` — customer session token, consumed similarly via
 *                   `req.cookies['_session']`.
 *   • `locale`   — ISO language tag chosen by the visitor (or by
 *                   the locale negotiator in Stage 3A.6 when the
 *                   visitor hasn't made an explicit choice).
 *
 * Design principles:
 *
 *   1. **One parser, one pass.** We don't use `cookie-parser` on
 *      purpose — the storefront hot path only reads three cookies
 *      and we want deterministic, dependency-free behaviour. The
 *      parsing logic is also reused verbatim by later stages for
 *      signed cookie verification, so keeping it local makes it
 *      easier to evolve.
 *   2. **Shape the output.** `gboxCookies.cart / session / locale`
 *      is the "happy path" API that downstream middleware should
 *      prefer. `gboxCookies.all` is the raw bag for anyone who
 *      needs to read a less common cookie (e.g. analytics opt-out).
 *   3. **Defence in depth.** Values containing CR/LF are discarded
 *      to prevent log-line injection. Values longer than 4 KiB are
 *      discarded to deflect header-stuffing abuse.
 *   4. **Never throw.** A malformed header must NEVER crash a
 *      request — we log a warning via `req.gboxCtx.logger` and
 *      continue with an empty object.
 *
 * The middleware also writes `req.cookies = { ... }` for
 * compatibility with the existing `StorefrontRequestContext` shape
 * the engine expects (see `packages/core/src/modules/themes/engine/
 * storefront/types.ts`). This lets us plug into the engine without
 * needing a shim.
 */

import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum length of a single cookie value we are willing to
 * process. 4096 bytes matches the RFC 6265 practical limit and
 * leaves plenty of headroom for legitimate session tokens.
 */
export const MAX_COOKIE_VALUE_LENGTH = 4096

/** Cookie names the storefront reads at v1. */
export const STOREFRONT_COOKIE_NAMES = {
  cart: 'cart',
  session: '_session',
  locale: 'locale',
} as const

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StorefrontCookies {
  /** Cart token or `null` when the visitor has no cart yet. */
  cart: string | null
  /** Customer session token or `null` for anonymous visitors. */
  session: string | null
  /** Locale override set by the visitor, or `null` when unset. */
  locale: string | null
  /** The full parsed cookie bag — useful for ad-hoc reads. */
  all: Record<string, string>
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Attached by the cookie middleware. */
    gboxCookies?: StorefrontCookies
  }
}

// ---------------------------------------------------------------------------
// parseCookieHeader
// ---------------------------------------------------------------------------

/**
 * Parse a raw `Cookie` header into a plain `{ name → value }` map.
 *
 * Follows the cookie-parser semantics close enough that tests can
 * replay the same headers and get the same output, but trimmed to
 * just what the storefront hot path needs. Never throws.
 */
export function parseCookieHeader(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === undefined || raw === null) return out

  // Node sometimes hands us an array for headers that arrived as
  // duplicates — join them before parsing.
  const header = Array.isArray(raw) ? raw.join('; ') : String(raw)
  if (header.length === 0) return out

  // Reject the whole header if it contains CR/LF — something
  // upstream has either broken the parser or is fuzzing us.
  if (/[\r\n]/.test(header)) return out

  const parts = header.split(';')
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) continue // Cookie fragments without `=` are ignored.

    const name = part.slice(0, eq).trim()
    let value = part.slice(eq + 1).trim()

    if (name.length === 0) continue
    if (value.length === 0) {
      out[name] = ''
      continue
    }

    // Strip surrounding double quotes if present.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }

    // Reject oversized values outright.
    if (value.length > MAX_COOKIE_VALUE_LENGTH) continue

    // URL-decode. Malformed percent sequences must not crash the
    // whole parse — skip just that cookie.
    let decoded: string
    try {
      decoded = decodeURIComponent(value)
    } catch {
      continue
    }

    out[name] = decoded
  }

  return out
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface CookieMiddlewareOptions {
  /**
   * Override cookie names. Mostly used for tests — the defaults
   * match what the storefront engine and auth system already
   * expect.
   */
  names?: Partial<typeof STOREFRONT_COOKIE_NAMES>
}

/**
 * Build the cookie middleware. The returned function is synchronous
 * and cheap — parsing is O(header length).
 */
export function buildCookieMiddleware(
  options: CookieMiddlewareOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const names = {
    ...STOREFRONT_COOKIE_NAMES,
    ...(options.names ?? {}),
  }

  return function cookieMiddleware(req, _res, next) {
    let all: Record<string, string>
    try {
      all = parseCookieHeader(req.headers.cookie)
    } catch (err) {
      // parseCookieHeader never throws in practice, but be defensive
      // against future refactors or exotic edge cases.
      req.gboxCtx?.logger?.warn?.(
        { err },
        'cookie middleware: parse failed, falling back to empty',
      )
      all = {}
    }

    const cookies: StorefrontCookies = {
      cart: all[names.cart] ?? null,
      session: all[names.session] ?? null,
      locale: all[names.locale] ?? null,
      all,
    }

    req.gboxCookies = cookies
    // Compatibility shim for the storefront engine which reads
    // `req.cookies['cart']` / `req.cookies['_session']` directly.
    req.cookies = all

    next()
  }
}
