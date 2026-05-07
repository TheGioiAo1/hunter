/**
 * Gbox Platform — Response Sanitizer (Phase 7.1)
 *
 * Iron Rule #1 from CLAUDE.md says "ALL API responses strip
 * sensitive fields (password_hash, tokens, internal IDs)". This
 * module is the single chokepoint that enforces it: route handlers
 * pass their result through `sanitizeForResponse()` (or sit behind
 * the Express middleware in `./sanitize-middleware.ts`) before the
 * JSON ever leaves the process.
 *
 * Why a recursive scrubber instead of explicit DTO mapping? Three
 * reasons:
 *
 *   1. We have ~80 route handlers across api/admin/accounts. Hand-
 *      writing a DTO mapper for each one is the kind of rote work
 *      that gets out of date the moment a new column lands. A
 *      sanitizer that walks the response tree adapts automatically.
 *   2. Defence-in-depth: even if a route author forgets to project
 *      `select()` away `password_hash`, the response middleware
 *      catches it before it goes to the wire.
 *   3. The default key set is auditable in one place. Adding a new
 *      sensitive column means adding one entry here, not hunting 80
 *      handlers.
 *
 * The trade-off: false positives. If a legitimate column happens to
 * be named e.g. `secret_santa_pair_id`, it gets scrubbed. We accept
 * that — the failure mode is "field missing in JSON", which an
 * integration test catches loudly, vs. "leaked credential", which
 * we might never notice.
 */

// ---------------------------------------------------------------------------
// Default sensitive key list
// ---------------------------------------------------------------------------

/**
 * The canonical list. Keep alphabetised within each group. Match is
 * case-insensitive (we lowercase both sides), so you don't need to
 * add `Password_Hash` if `password_hash` is already here — but adding
 * both common shapes (snake_case + camelCase) keeps grep'ability.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  // Credentials
  'password',
  'password_hash',
  'passwordHash',
  'pwd',
  'pwd_hash',
  'pwdHash',
  'salt',

  // Sessions
  'session_token',
  'sessionToken',
  'session_secret',
  'sessionSecret',
  'csrf_token',
  'csrfToken',
  'csrf_secret',
  'csrfSecret',

  // OAuth / API tokens
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
  'api_key',
  'apiKey',
  'api_secret',
  'apiSecret',
  'client_secret',
  'clientSecret',
  'webhook_secret',
  'webhookSecret',
  'private_key',
  'privateKey',

  // Magic-link / verification tokens
  'magic_link_token',
  'magicLinkToken',
  'verification_token',
  'verificationToken',
  'reset_token',
  'resetToken',
  'two_factor_secret',
  'twoFactorSecret',
  'totp_secret',
  'totpSecret',

  // Payment instruments
  'card_number',
  'cardNumber',
  'cvv',
  'cvc',
  'card_cvv',
  'cardCvv',
  'iban',
  'routing_number',
  'routingNumber',
  'account_number',
  'accountNumber',
]

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SanitizeOptions {
  /** Additional keys to scrub on top of `DEFAULT_SENSITIVE_KEYS`. */
  extraKeys?: readonly string[]
  /**
   * If true, replace sensitive values with `'[REDACTED]'` instead of
   * deleting the key entirely. Useful for admin debug endpoints
   * where the operator needs to confirm "yes a value was set" but
   * shouldn't see it.
   */
  redactInsteadOfStrip?: boolean
}

const REDACTION = '[REDACTED]'

// ---------------------------------------------------------------------------
// sanitizeForResponse
// ---------------------------------------------------------------------------

/**
 * Returns a deep copy of `value` with sensitive fields removed (or
 * replaced with `[REDACTED]` if `redactInsteadOfStrip` is set).
 *
 * Behavioural guarantees:
 *
 *   - Primitives, null, and undefined pass through unchanged.
 *   - Date instances pass through by reference (we don't recurse
 *     into their internal slots — they're not "objects" in the
 *     sense the scrubber cares about).
 *   - Arrays of objects are sanitized element-by-element.
 *   - Cycles are broken: a value that points to itself becomes a
 *     sanitized copy of itself with the back-edge replaced by the
 *     same sanitized object.
 *   - Match is case-insensitive: `Password_Hash`, `password_hash`,
 *     and `PASSWORDHASH` all hit the same sensitive entry.
 *   - The input is never mutated.
 */
export function sanitizeForResponse(
  value: unknown,
  options: SanitizeOptions = {},
): unknown {
  const sensitive = buildKeySet(options.extraKeys)
  // WeakMap tracks "we've already produced a sanitized copy of this
  // input object" → its sanitized output. Lets us preserve cycles
  // and shared references without infinite recursion.
  const seen = new WeakMap<object, unknown>()
  return walk(value, sensitive, options.redactInsteadOfStrip ?? false, seen)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildKeySet(extra?: readonly string[]): Set<string> {
  const set = new Set<string>()
  for (const k of DEFAULT_SENSITIVE_KEYS) set.add(k.toLowerCase())
  if (extra) for (const k of extra) set.add(k.toLowerCase())
  return set
}

function walk(
  value: unknown,
  sensitive: Set<string>,
  redact: boolean,
  seen: WeakMap<object, unknown>,
): unknown {
  // Primitives, null, undefined → return as-is.
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value

  // Date is "object-shaped" but semantically a value. Don't recurse.
  if (value instanceof Date) return value

  // Cycle guard.
  const cached = seen.get(value as object)
  if (cached !== undefined) return cached

  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) {
      out.push(walk(item, sensitive, redact, seen))
    }
    return out
  }

  // Plain object branch.
  const out: Record<string, unknown> = {}
  seen.set(value as object, out)
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (sensitive.has(key.toLowerCase())) {
      if (redact) {
        out[key] = REDACTION
      }
      // else: drop the key entirely
      continue
    }
    out[key] = walk(child, sensitive, redact, seen)
  }
  return out
}
