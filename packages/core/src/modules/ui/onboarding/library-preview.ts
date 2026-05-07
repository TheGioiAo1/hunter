/**
 * Gbox Platform — Library preview cards for the onboarding wizard (Phase B / Task B3).
 *
 * Pure render helpers. The welcome page's Tab 2 calls
 * `libraryPreviewCards(cards)` with the 3-4 featured seed rows returned
 * by `listFeaturedSeeds(db)` (see apps/store-admin/src/pages/onboarding/library.ts).
 *
 * Each tile is deliberately compact — thumbnail + title + category chip —
 * because the welcome page's primary job is funneling the seller into a
 * single clear action. The library tiles are a "psst, we have options"
 * backup path, not the hero. If we need a full gallery experience later
 * it already exists at `/admin/store/:slug/design-library`; that's what
 * the "Browse full library →" link on the welcome page is for.
 *
 * Label discipline
 * ----------------
 * Per Thai's rename (2026-04-18), "Theme Library" is the user-facing
 * surface name. The `/design-library/` route stays as plumbing (URLs
 * are not visible copy); a companion label-audit test greps this file
 * + CSS for the forbidden pre-rename literal to lock the invariant.
 *
 * Graceful degradation
 * --------------------
 * `libraryPreviewCards([])` returns the empty string so the welcome
 * component can fall through to its "coming soon" empty state without
 * branching logic in the render path.
 */

import { DESIGN_LIBRARY_CATEGORY_LABELS, type DesignLibraryCategory } from '../../design-library/types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LibraryPreviewCardProps {
  /** Stable slug — used as the href segment for the preview modal. */
  readonly slug: string
  /** Display title. Escaped in the render path. */
  readonly title: string
  /** One-liner blurb. Escaped. Null is fine (just omitted). */
  readonly summary: string | null
  /** Gallery category chip — NULL entries skip the chip. */
  readonly category: DesignLibraryCategory | null
  /** CDN URL for the thumbnail. NULL renders a placeholder block. */
  readonly thumbnailUrl: string | null
  /**
   * Where clicking the card leads. The welcome view wires this to the
   * existing design-library entry page so the card preserves the full
   * preview experience (Live Preview, Copy DESIGN.md, Clone) without
   * reimplementing it on the onboarding surface.
   */
  readonly previewHref: string
}

// ---------------------------------------------------------------------------
// HTML escape — local copy to keep this module dependency-free.
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/**
 * Render one preview tile. Returns raw HTML — caller is responsible
 * for sanitising the props BEFORE passing them in (already escaped
 * here as defence-in-depth).
 */
export function libraryPreviewCard(p: LibraryPreviewCardProps): string {
  const chip =
    p.category !== null
      ? `<span class="library-preview-card__chip">${esc(DESIGN_LIBRARY_CATEGORY_LABELS[p.category])}</span>`
      : ''
  const thumb =
    p.thumbnailUrl !== null && p.thumbnailUrl.length > 0
      ? `<img class="library-preview-card__thumb"
             src="${esc(p.thumbnailUrl)}"
             alt="${esc(p.title)} thumbnail"
             loading="lazy">`
      : `<div class="library-preview-card__placeholder" aria-hidden="true">
           <span>${esc(p.title.charAt(0).toUpperCase() || '·')}</span>
         </div>`
  const summary =
    p.summary !== null && p.summary.trim().length > 0
      ? `<p class="library-preview-card__summary">${esc(p.summary)}</p>`
      : ''
  return `
<a class="library-preview-card"
   href="${esc(p.previewHref)}"
   data-slug="${esc(p.slug)}">
  <div class="library-preview-card__media">${thumb}</div>
  <div class="library-preview-card__body">
    <span class="library-preview-card__title">${esc(p.title)}</span>
    ${chip}
    ${summary}
  </div>
</a>`
}

/**
 * Render the full grid — concatenated card HTML, or empty string when
 * the input is empty (the welcome component treats "" as signal to
 * render its empty state).
 *
 * Caller is expected to have already ordered the cards by
 * `featured_rank ASC NULLS LAST, slug ASC`. The render path makes no
 * ordering assumptions and preserves input order verbatim.
 */
export function libraryPreviewCards(
  cards: readonly LibraryPreviewCardProps[],
): string {
  if (cards.length === 0) return ''
  return cards.map(libraryPreviewCard).join('\n')
}
