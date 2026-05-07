/**
 * Store Admin — Gift Cards Flash Message Mapper
 *
 * Pure, dependency-free helper extracted from `pages/gift-cards.ts` so
 * the Phase 10 PR2 live-DB smoke (which seeds real shops / cards, but
 * deliberately does NOT boot the full admin server) can introspect the
 * Iron rule 5 guarantees without pulling the entire `../server.ts`
 * import graph (and with it, the AI SDK).
 *
 * Iron rule 5 contract (CLAUDE.md):
 *   - Never leak "god admin" or any internal route name.
 *   - Unknown / unmapped errors fall back to "Please contact Gbox
 *     support." — never a raw stack trace, never a hint about which
 *     server-side config is missing.
 */

export function safeFlashMessage(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.toLowerCase()
    if (m.includes('not found')) return 'Gift card not found.'
    if (m.includes('disabled')) return 'Gift card has been disabled.'
    if (m.includes('no recipient')) return 'Gift card has no recipient email on file.'
    if (m.includes('smtp') || m.includes('email') || m.includes('mail')) {
      return 'We could not send the email right now. Please try again shortly.'
    }
  }
  return 'Please contact Gbox support.'
}
