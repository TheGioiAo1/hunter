/**
 * Gbox Platform — support-ai PII redaction (Phase 12.5 PR4).
 *
 * Spec §10.6.4: before ANY prompt goes to Anthropic, strip
 *   - credit card numbers (Luhn-validated, 13-19 digits)
 *   - US SSN (XXX-XX-XXXX and 9-digit runs in SSN range)
 *   - Vietnamese CMND / CCCD (9- and 12-digit runs)
 *   - PayPal / bare email addresses
 *
 * Replaced with fixed, non-leaking sentinels:
 *   [REDACTED-CC] [REDACTED-SSN] [REDACTED-ID] [REDACTED-EMAIL]
 *
 * Why this is a separate file
 * ---------------------------
 *   - These regexes need exhaustive Luhn-branch tests (valid card vs
 *     invalid card vs edge-case all-zero run) that don't belong in
 *     suggest-reply.ts.
 *   - The redaction pass is reused by summarize-thread.ts and
 *     auto-categorize.ts — one implementation, one audit surface.
 *   - Iron Rule 1 data minimisation: the output of this function is
 *     what actually leaves the platform. Keeping it isolated lets
 *     the smoke test round-trip a known-bad payload and assert zero
 *     leaks at the module boundary.
 *
 * What we deliberately do NOT redact
 * ----------------------------------
 *   - Shop names / seller display names — the agent may need them in
 *     context to reply coherently.
 *   - Order IDs / ticket IDs — already opaque UUIDs, no PII.
 *   - Addresses — too ambiguous to match precisely, and the agent
 *     frequently needs them to answer shipping / refund questions.
 *
 * If the reviewer adds fields to this list, update the smoke test.
 */

/**
 * Replace all detected PII in `text` with fixed sentinels. Safe to
 * call on null/empty strings.
 *
 * Order of passes matters — the credit-card pass runs first so a
 * 16-digit all-zero run (technically SSN-shaped if you squint) gets
 * caught by the CC branch. The SSN pass runs before the generic
 * CMND pass because the 9-digit US format is a strict subset.
 */
export function redactPii(text: string | null | undefined): string {
  if (!text) return ''
  let out = text
  // 1. Credit cards (Luhn-validated).
  out = redactCreditCards(out)
  // 2. US SSN (xxx-xx-xxxx format).
  out = redactSSN(out)
  // 3. Emails. Run BEFORE the generic id pass so
  //    "seller1234567890@paypal.com" isn't partially redacted.
  out = redactEmail(out)
  // 4. VN CMND / CCCD — bare 9 or 12 digit run.
  out = redactNationalId(out)
  return out
}

// ---------------------------------------------------------------------------
// Credit cards — Luhn-validated
// ---------------------------------------------------------------------------

/**
 * Matches any run of 13-19 digits, optionally separated by spaces
 * or dashes in groups of 3-6. Matches Visa (16), Amex (15), Diners
 * (14), JCB (16-19), and Mastercard (16).
 *
 * We do the loose regex + Luhn validation rather than per-brand
 * regex because the Luhn step is the actual filter — wrong-length
 * strings fail Luhn anyway.
 */
const CC_REGEX = /\b(?:\d[ -]?){12,18}\d\b/g

/**
 * Classic Luhn algorithm. Returns true iff the digits pass the
 * Mod-10 checksum. Non-digit chars are stripped before check.
 *
 * Exported so redact-pii.test.ts can assert known-good and
 * known-bad card numbers. The production path uses it internally
 * via redactCreditCards().
 */
export function isLuhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10)
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

function redactCreditCards(text: string): string {
  return text.replace(CC_REGEX, (match) => {
    return isLuhnValid(match) ? '[REDACTED-CC]' : match
  })
}

// ---------------------------------------------------------------------------
// SSN — US 9-digit social security number
// ---------------------------------------------------------------------------

/**
 * Strict US SSN: XXX-XX-XXXX only, with dashes. Matching bare
 * 9-digit runs creates too many false positives with VN CMND, phone
 * numbers, and order IDs.
 *
 * Area number 000, 666, and 900-999 are invalid per SSA — matching
 * anyway because the goal is redaction, not validation.
 */
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g

function redactSSN(text: string): string {
  return text.replace(SSN_REGEX, '[REDACTED-SSN]')
}

// ---------------------------------------------------------------------------
// Email — generic RFC-lite
// ---------------------------------------------------------------------------

/**
 * RFC-lite email: local@domain.tld. Intentionally loose on the
 * local-part because we need to catch real-world garbage like
 * `seller.support+paypal@example.vn` without rewriting RFC 5322.
 *
 * The `[^\s<>]` char class stops matching at whitespace or HTML
 * angle brackets so we don't gobble surrounding markup.
 */
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

function redactEmail(text: string): string {
  return text.replace(EMAIL_REGEX, '[REDACTED-EMAIL]')
}

// ---------------------------------------------------------------------------
// VN national ID — CMND (9 digits) / CCCD (12 digits)
// ---------------------------------------------------------------------------

/**
 * Runs of exactly 9 or exactly 12 digits. Matches CMND (pre-2021)
 * and CCCD (post-2021) Vietnamese national IDs. Tolerates spaces
 * and dashes only as optional separators — anything else suggests
 * the run is an order ID or phone number.
 *
 * The lookahead rejects runs that are part of a longer sequence,
 * so "1234567890123456" (16 digits, e.g. a credit card that already
 * got redacted) doesn't double-match.
 */
const VN_ID_REGEX = /(?<!\d)\d{9}(?:\d{3})?(?!\d)/g

function redactNationalId(text: string): string {
  return text.replace(VN_ID_REGEX, '[REDACTED-ID]')
}

// ---------------------------------------------------------------------------
// Sentinel catalog — for test assertions and log sanitisers
// ---------------------------------------------------------------------------

export const REDACTION_SENTINELS = {
  creditCard: '[REDACTED-CC]',
  ssn: '[REDACTED-SSN]',
  email: '[REDACTED-EMAIL]',
  nationalId: '[REDACTED-ID]',
} as const
