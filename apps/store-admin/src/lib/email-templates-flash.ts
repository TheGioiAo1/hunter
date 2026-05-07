/**
 * Gbox Platform — Email Templates flash copy (Phase 14 PR1.5)
 *
 * Dep-free helper extracted so the PR1.5 smoke can import it without
 * pulling in the rest of the admin server graph. Same pattern as
 * `review-settings-flash.ts` / `gift-cards-flash.ts`.
 *
 * Iron rule 5: every error path routes through `safeMessage()` →
 * "Please contact Gbox support." — sellers never see internal
 * stack / path / registry details.
 */

/**
 * Maps a persistence or validation error into a seller-safe message.
 * We recognise two specific user-facing shapes (unknown template, bad
 * input) and fall through to the canonical contact copy for everything
 * else.
 */
export function safeEmailTemplatesMessage(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.toLowerCase()
    if (m.includes('unknown_template') || m.includes('template not found')) {
      return 'That email template is not available.'
    }
    if (m.includes('not_seller_visible') || m.includes('forbidden')) {
      // Iron rule 5 — don't hint that the template IS real but just
      // platform-only. Generic "not available" keeps god-admin surface
      // invisible to sellers.
      return 'That email template is not available.'
    }
    if (m.includes('invalid')) {
      return 'Some of the values you entered are invalid.'
    }
  }
  return 'Please contact Gbox support.'
}
