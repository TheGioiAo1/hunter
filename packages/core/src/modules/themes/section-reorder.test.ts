/**
 * Gbox Platform — Section reorder helper tests (Stage 5.5)
 *
 * The theme visual editor will ship a drag-drop section rail
 * (same UX as Shopify's `/admin/themes/:id/editor`). When the
 * user drops a section, the admin front-end sends a single
 * reorder intent to the API:
 *
 *   POST /admin/themes/:id/sections/reorder
 *   { fromId: 'featured_products',
 *     toId:   'hero',
 *     position: 'before' }
 *
 * This module is the pure floor that computes the new order
 * array (or a rejection) — no HTTP, no DB. The API handler calls
 * it, persists the result, and renders the preview.
 *
 * Locked sections (header, footer) must never move. Duplicates
 * in the input array are a programming error and should surface
 * as a clean rejection, not silent corruption.
 */

import { describe, it, expect } from 'vitest'
import {
  reorderSections,
  moveSectionToIndex,
  type ReorderSectionsResult,
} from './section-reorder.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const base = Object.freeze([
  'header',
  'hero',
  'featured_products',
  'testimonials',
  'newsletter',
  'footer',
])

function assertOk(res: ReorderSectionsResult): string[] {
  if (!res.ok) {
    throw new Error(`expected ok, got error ${res.error.code}: ${res.error.message}`)
  }
  return res.order
}

// ---------------------------------------------------------------------------
// reorderSections — happy paths
// ---------------------------------------------------------------------------

describe('reorderSections — happy path', () => {
  it('moves a later section before an earlier one', () => {
    const out = reorderSections(base, 'newsletter', 'hero', 'before')
    expect(assertOk(out)).toEqual([
      'header',
      'newsletter',
      'hero',
      'featured_products',
      'testimonials',
      'footer',
    ])
  })

  it('moves an earlier section after a later one', () => {
    const out = reorderSections(base, 'hero', 'testimonials', 'after')
    expect(assertOk(out)).toEqual([
      'header',
      'featured_products',
      'testimonials',
      'hero',
      'newsletter',
      'footer',
    ])
  })

  it('moving a section before its immediate successor is a no-op', () => {
    const out = reorderSections(base, 'hero', 'featured_products', 'before')
    // hero is already immediately before featured_products
    expect(assertOk(out)).toEqual(base as unknown as string[])
  })

  it('moving a section after its immediate predecessor is a no-op', () => {
    const out = reorderSections(base, 'featured_products', 'hero', 'after')
    expect(assertOk(out)).toEqual(base as unknown as string[])
  })

  it('returns a fresh array — does not mutate the input', () => {
    const input = [...base]
    const snapshot = [...input]
    reorderSections(input, 'newsletter', 'hero', 'before')
    expect(input).toEqual(snapshot)
  })
})

// ---------------------------------------------------------------------------
// reorderSections — locked sections
// ---------------------------------------------------------------------------

describe('reorderSections — locked sections', () => {
  it('refuses to move a locked section', () => {
    const out = reorderSections(base, 'header', 'hero', 'after', {
      locked: ['header', 'footer'],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('from_locked')
  })

  it('refuses to drop before a locked section', () => {
    const out = reorderSections(base, 'hero', 'header', 'before', {
      locked: ['header', 'footer'],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('to_locked')
  })

  it('refuses to drop after a locked section', () => {
    const out = reorderSections(base, 'hero', 'footer', 'after', {
      locked: ['header', 'footer'],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('to_locked')
  })

  it('allows reordering non-locked sections even when locked set is set', () => {
    const out = reorderSections(base, 'newsletter', 'hero', 'before', {
      locked: ['header', 'footer'],
    })
    expect(assertOk(out)).toEqual([
      'header',
      'newsletter',
      'hero',
      'featured_products',
      'testimonials',
      'footer',
    ])
  })
})

// ---------------------------------------------------------------------------
// reorderSections — rejections
// ---------------------------------------------------------------------------

describe('reorderSections — rejections', () => {
  it('rejects an unknown fromId', () => {
    const out = reorderSections(base, 'missing', 'hero', 'before')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('unknown_from_id')
  })

  it('rejects an unknown toId', () => {
    const out = reorderSections(base, 'hero', 'missing', 'before')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('unknown_to_id')
  })

  it('rejects fromId === toId', () => {
    const out = reorderSections(base, 'hero', 'hero', 'before')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('same_id')
  })

  it('rejects duplicate ids in the input array', () => {
    const out = reorderSections(
      ['a', 'b', 'a', 'c'],
      'b',
      'c',
      'after',
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('duplicate_ids')
  })
})

// ---------------------------------------------------------------------------
// moveSectionToIndex
// ---------------------------------------------------------------------------

describe('moveSectionToIndex', () => {
  it('moves a section to a later index', () => {
    const out = moveSectionToIndex(base, 'hero', 3)
    expect(assertOk(out)).toEqual([
      'header',
      'featured_products',
      'testimonials',
      'hero',
      'newsletter',
      'footer',
    ])
  })

  it('moves a section to an earlier index', () => {
    const out = moveSectionToIndex(base, 'newsletter', 1)
    expect(assertOk(out)).toEqual([
      'header',
      'newsletter',
      'hero',
      'featured_products',
      'testimonials',
      'footer',
    ])
  })

  it('clamps a target index past the end', () => {
    const out = moveSectionToIndex(base, 'hero', 999)
    expect(assertOk(out)).toEqual([
      'header',
      'featured_products',
      'testimonials',
      'newsletter',
      'footer',
      'hero',
    ])
  })

  it('clamps a negative target index to 0', () => {
    const out = moveSectionToIndex(base, 'newsletter', -5)
    expect(assertOk(out)).toEqual([
      'newsletter',
      'header',
      'hero',
      'featured_products',
      'testimonials',
      'footer',
    ])
  })

  it('refuses to move a locked section', () => {
    const out = moveSectionToIndex(base, 'header', 3, {
      locked: ['header', 'footer'],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('from_locked')
  })

  it('refuses to drop into a locked slot', () => {
    // Target index 5 is 'footer' (locked); we forbid pushing a
    // non-locked section into that slot since it would displace
    // the lock.
    const out = moveSectionToIndex(base, 'hero', 5, {
      locked: ['header', 'footer'],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('to_locked')
  })

  it('rejects an unknown id', () => {
    const out = moveSectionToIndex(base, 'missing', 2)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('unknown_from_id')
  })

  it('rejects duplicate ids in the input array', () => {
    const out = moveSectionToIndex(['a', 'b', 'a'], 'b', 2)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('duplicate_ids')
  })
})
