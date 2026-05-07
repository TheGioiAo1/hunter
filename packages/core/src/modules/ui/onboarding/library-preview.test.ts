/**
 * Library preview card — unit tests (Phase B / Task B3).
 *
 * Pure render helpers that turn a row from the design-library featured
 * seeds into a compact tile for the welcome page's Tab 2. Tests cover
 * the grid wrapper, single-card output, empty-state branch, and the
 * user-facing label invariant ("Theme Library", never "Design Library").
 */

import { describe, expect, it } from 'vitest'
import {
  libraryPreviewCard,
  libraryPreviewCards,
  type LibraryPreviewCardProps,
} from './library-preview.js'

function card(overrides: Partial<LibraryPreviewCardProps> = {}): LibraryPreviewCardProps {
  return {
    slug: 'airbnb',
    title: 'Airbnb',
    summary: 'Editorial travel marketplace.',
    category: 'travel',
    thumbnailUrl: 'https://cdn.example.com/airbnb.webp',
    previewHref: '/admin/store/lifeasy/design-library/airbnb',
    ...overrides,
  }
}

describe('libraryPreviewCard — single tile', () => {
  it('links to the preview href and includes the title', () => {
    const html = libraryPreviewCard(card({ previewHref: '/admin/store/x/design-library/airbnb' }))
    expect(html).toMatch(/href="\/admin\/store\/x\/design-library\/airbnb"/)
    expect(html).toMatch(/Airbnb/)
  })

  it('renders the thumbnail as an <img> with alt text when URL is provided', () => {
    const html = libraryPreviewCard(card({ thumbnailUrl: 'https://cdn.example.com/stripe.webp', title: 'Stripe' }))
    expect(html).toMatch(/<img[^>]*src="https:\/\/cdn\.example\.com\/stripe\.webp"/)
    expect(html).toMatch(/alt="Stripe thumbnail"/)
  })

  it('falls back to a placeholder tile when thumbnail URL is null', () => {
    const html = libraryPreviewCard(card({ thumbnailUrl: null, title: 'Notion' }))
    // No <img> tag — would 404 if we rendered an empty src.
    expect(html).not.toMatch(/<img/)
    // Instead, a placeholder div with a visual fallback.
    expect(html).toMatch(/library-preview-card__placeholder/)
  })

  it('includes the category chip when a category is provided', () => {
    const html = libraryPreviewCard(card({ category: 'devtool' }))
    // Category label comes from DESIGN_LIBRARY_CATEGORY_LABELS — 'devtool' → 'Developer Tools'.
    expect(html).toMatch(/Developer Tools/i)
  })

  it('omits the chip when category is null', () => {
    const html = libraryPreviewCard(card({ category: null }))
    expect(html).not.toMatch(/library-preview-card__chip/)
  })

  it('HTML-escapes hostile titles and summaries', () => {
    const html = libraryPreviewCard(
      card({ title: '<script>alert(1)</script>', summary: 'x"&<y>' }),
    )
    expect(html).not.toMatch(/<script>alert/)
    expect(html).toMatch(/&lt;script&gt;/)
    expect(html).toMatch(/x&quot;&amp;&lt;y&gt;/)
  })
})

describe('libraryPreviewCards — grid', () => {
  it('returns empty string when the list is empty', () => {
    // The welcome component detects "" and renders its empty state.
    expect(libraryPreviewCards([])).toBe('')
  })

  it('renders one tile per entry', () => {
    const html = libraryPreviewCards([
      card({ slug: 'airbnb', title: 'Airbnb' }),
      card({ slug: 'stripe', title: 'Stripe' }),
      card({ slug: 'linear', title: 'Linear' }),
      card({ slug: 'notion', title: 'Notion' }),
    ])
    expect((html.match(/library-preview-card"/g) ?? []).length).toBe(4)
    expect(html).toMatch(/Airbnb/)
    expect(html).toMatch(/Stripe/)
    expect(html).toMatch(/Linear/)
    expect(html).toMatch(/Notion/)
  })

  it('preserves the input order (caller has already sorted by featured_rank)', () => {
    const html = libraryPreviewCards([
      card({ slug: 'stripe', title: 'Stripe' }),
      card({ slug: 'airbnb', title: 'Airbnb' }),
    ])
    const stripeIdx = html.indexOf('Stripe')
    const airbnbIdx = html.indexOf('Airbnb')
    expect(stripeIdx).toBeLessThan(airbnbIdx)
  })
})

describe('libraryPreviewCard — no "Design Library" leaks', () => {
  it('never emits the string "Design Library" as visible text', () => {
    // Routes can contain `design-library` (hrefs) but visible labels must say
    // "Theme Library" per Thai's rename.
    const html = libraryPreviewCard(card())
    const hrefless = html.replace(/href="[^"]*"/g, '')
    expect(hrefless).not.toMatch(/Design Library/)
  })
})
