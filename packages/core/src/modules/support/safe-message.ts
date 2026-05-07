/**
 * Iron Rule 5 enforcement helper.
 *
 * Sellers should never see "god admin", internal route paths, feature
 * flag names, or any leak of the platform's internal architecture.
 * Anywhere a seller-facing error message is composed, pipe it through
 * `safeMessage()` so the canonical "Please contact Gbox support."
 * string is what actually reaches the wire.
 *
 * The function is opinionated on purpose:
 *
 *   - It does NOT accept a locale arg — the seller API layer picks
 *     which string to send (vi vs en) from the request's Accept-Language.
 *   - It returns a tuple `{ safe, diagnostic }` so callers can log the
 *     raw error server-side (pino) without risking that the raw string
 *     ever reaches the response JSON.
 *
 * Callers MUST use the `safe` field in responses and the `diagnostic`
 * field only in server-side log records. Vitest snapshot tests in
 * seller-facing route modules grep for leak-terms to enforce this.
 */

/** The canonical seller-facing fallback message. */
export const SAFE_MESSAGE_EN = 'Please contact Gbox support.'
export const SAFE_MESSAGE_VI = 'Vui lòng liên hệ Gbox support.'

export interface SafeMessage {
  /** What to return to the seller. Always free of internal leakage. */
  safe: string
  /** The raw error for server-side logs only. Never send this to a seller. */
  diagnostic: string
}

/**
 * Wrap any error into a seller-safe message. The caller should pass
 * through `safe` in the API response and log `diagnostic` separately.
 */
export function safeMessage(
  err: unknown,
  opts: { locale?: 'vi' | 'en' } = {},
): SafeMessage {
  const locale = opts.locale ?? 'en'
  const safe = locale === 'vi' ? SAFE_MESSAGE_VI : SAFE_MESSAGE_EN
  const diagnostic = diagnosticOf(err)
  return { safe, diagnostic }
}

function diagnosticOf(err: unknown): string {
  if (err instanceof Error) {
    // Intentionally keep stack separate — caller logs it via pino
    // structured field, not concatenated into this string.
    return err.message || err.name || 'Error'
  }
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return 'unknown error'
  try {
    return JSON.stringify(err)
  } catch {
    return '[unserialisable error]'
  }
}

/**
 * Regex used by audit tests to confirm a given response body is free
 * of leak terms. Exported so each seller-facing route module can
 * assert the property in its own unit test rather than relying on a
 * distant integration test to catch it.
 */
/**
 * The regex is a union of several patterns. We build each alternate as
 * its own fragment (with its own boundary logic) rather than wrapping
 * the whole thing in `\b…\b` — `\b` between two non-word chars (space
 * then `/` or `$`) doesn't match, which would let `"/god-admin/"` and
 * `"$env.SUPPORT_…"` through unflagged.
 */
export const LEAK_TERMS_REGEX = new RegExp(
  [
    // word-anchored terms (prevent matching inside "engodadmin" etc.)
    '\\b(?:god[ _-]?admin|platform[ _-]?admin|internal[ _-]?route|feature[ _-]?flag|god_admin)\\b', // iron-rule-5-ok: this IS the sanitiser regex for Iron Rule 5; the forbidden terms must appear literally
    // path-like term — trigger on the literal slash pair regardless of surrounding ws.
    '/god-admin/', // iron-rule-5-ok: ditto — part of the sanitiser alternation
    // identifier-like terms that include trailing word chars.
    'FEATURE_FLAG_[A-Z0-9_]*',
    '\\$env\\.SUPPORT_[A-Z0-9_]*',
    // hostname — period is non-word so \b won't help; match literally.
    'supporter\\.gbox\\.co',
  ].join('|'),
  'i',
)

/**
 * Returns true if `text` is free of leak-terms. Called from seller
 * API unit tests as `expect(assertSellerSafe(body)).toBe(true)`.
 */
export function assertSellerSafe(text: string): boolean {
  return !LEAK_TERMS_REGEX.test(text)
}
