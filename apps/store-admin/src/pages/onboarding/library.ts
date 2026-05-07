/**
 * Store-admin — onboarding library helpers (Phase B / Task B3).
 *
 * Two small surfaces:
 *
 *   1. `getOnboardingLibraryRedirect(req, res)` handles the convenience
 *      alias route GET /admin/store/:slug/onboarding/library. It 302s
 *      straight into /onboarding/first-run?tab=library so the welcome
 *      page owns all tab-rendering logic in exactly one place.
 *
 *      Shopify does the equivalent with its "/admin/onboarding/theme"
 *      deep-links. Having the alias makes the URL you email/share/
 *      bookmark obvious ("that's the theme library page") without
 *      forcing the query string.
 *
 *   2. `renderFeaturedLibraryCardsHtml(db, storeSlug)` pulls the 4
 *      featured picks from the DB and turns them into Tab 2 tile HTML.
 *      Keeping this out of the `welcome.ts` render module means the
 *      view stays DB-free and trivially unit-testable; this module
 *      owns the plumbing.
 *
 *      Graceful degradation: any DB error or empty result returns the
 *      empty string so the welcome component falls through to its
 *      "Theme Library coming soon" empty state. A primary surface
 *      (onboarding!) must never 500 over a secondary panel glitch.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import {
  listFeaturedSeeds,
  type DesignLibraryCard,
} from '@gbox/core/modules/design-library/index.js'
import {
  libraryPreviewCards,
  type LibraryPreviewCardProps,
} from '@gbox/core/modules/ui/onboarding/library-preview.js'

// ---------------------------------------------------------------------------
// Redirect handler — GET /admin/store/:slug/onboarding/library
// ---------------------------------------------------------------------------

/**
 * Deep-link alias. Short URL that anything external (accounts portal,
 * Resume banner, emails) can link to; the welcome page does the actual
 * rendering.
 *
 * 302 (not 301) because the wizard is transient — the target changes
 * as the shop progresses through its onboarding state machine and we
 * don't want browsers to cache a redirect that may disappear later.
 */
export function getOnboardingLibraryRedirect(req: Request, res: Response): void {
  const store = req.store!
  res.redirect(302, `/admin/store/${store.slug}/onboarding/first-run?tab=library`)
}

// ---------------------------------------------------------------------------
// Render helper — pre-renders the Tab 2 grid HTML
// ---------------------------------------------------------------------------

/**
 * Map a DB row → the narrow props shape the card renderer consumes.
 * The preview href points into the existing design-library detail
 * route; keeping the wizard card as a "portal" into the full gallery
 * means users who want to explore don't get stuck on the 4-tile grid.
 */
function toPreviewProps(
  card: DesignLibraryCard,
  storeSlug: string,
): LibraryPreviewCardProps {
  return {
    slug: card.slug,
    title: card.title,
    summary: card.summary,
    category: card.category,
    thumbnailUrl: card.thumbnailUrl,
    // Route into the existing D4 gallery detail page so the full
    // preview experience (Live Preview / Copy DESIGN.md / Clone)
    // is reused rather than reimplemented on the wizard surface.
    previewHref: `/admin/store/${storeSlug}/design-library/${card.slug}`,
  }
}

/**
 * Fetch the 4 featured seed rows and return the rendered grid HTML, or
 * the empty string for any "no cards to show" condition:
 *
 *   - Featured seeds not yet loaded (fresh DB before migration 051 ran)
 *   - Every featured slug was renamed upstream (no rows matched)
 *   - DB error (graceful degradation — welcome must render)
 *
 * The empty string is the contract the welcome component expects to
 * trigger its "Theme Library coming soon" empty state.
 */
export async function renderFeaturedLibraryCardsHtml(
  db: Kysely<Database>,
  storeSlug: string,
): Promise<string> {
  let cards: readonly DesignLibraryCard[] = []
  try {
    cards = await listFeaturedSeeds(db)
  } catch (err) {
    // Intentionally swallowed — a broken library query is NOT a reason
    // to 500 the primary onboarding surface. Tab 1 (Clone from URL) is
    // the main path and must always render. Log for observability so
    // server operators see the underlying failure in the pino stream.
    // eslint-disable-next-line no-console
    console.warn(
      '[onboarding/library] listFeaturedSeeds failed, falling back to empty Tab 2:',
      (err as Error).message,
    )
    return ''
  }
  if (cards.length === 0) return ''
  return libraryPreviewCards(cards.map((c) => toPreviewProps(c, storeSlug)))
}
