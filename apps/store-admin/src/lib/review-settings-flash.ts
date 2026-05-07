/**
 * Gbox Platform — Review Settings flash copy (Phase 10 PR3)
 *
 * Dep-free helper extracted so the PR3 smoke can import it without
 * dragging in the rest of the admin (server.ts → ai-copywriter →
 * @anthropic-ai/sdk, which isn't installed on the smoke server). Same
 * pattern as `gift-cards-flash.ts`.
 */

/**
 * Maps a persistence error into a seller-safe message. Iron rule 5 —
 * never expose internal paths, DB error text, or platform-internal
 * admin surfaces. The default fallback is the canonical contact copy.
 */
export function safeReviewSettingsMessage(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.toLowerCase()
    if (m.includes('not found')) return 'Shop not found.'
    if (m.includes('invalid')) return 'Some of the values you entered are invalid.'
  }
  return 'Please contact Gbox support.'
}
