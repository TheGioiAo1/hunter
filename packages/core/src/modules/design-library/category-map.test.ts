/**
 * Design Library — category map guardrails (Phase D1).
 *
 * The upstream mirror ships 58 brands at the locked ref 80bbbc2
 * (2026-04-18). These tests don't contact the network — they lock the
 * map's invariants so a sloppy edit can't silently demote a brand into
 * the wrong bucket or widen the enum without updating the map.
 */

import { describe, it, expect } from 'vitest'
import {
  BRAND_CATEGORY_MAP,
  KNOWN_BRAND_SLUGS,
  categoryFor,
} from './category-map.js'
import { DESIGN_LIBRARY_CATEGORIES } from './types.js'

describe('category-map', () => {
  it('ships exactly 58 brand → category entries (matches upstream @80bbbc2)', () => {
    // If upstream adds/removes brands, this number bumps and the
    // author must update the map consciously. Protects against silent
    // dropping of a brand.
    expect(KNOWN_BRAND_SLUGS.length).toBe(58)
  })

  it('every mapped category is in the enum (no typos)', () => {
    const enumSet = new Set<string>(DESIGN_LIBRARY_CATEGORIES)
    for (const [slug, cat] of Object.entries(BRAND_CATEGORY_MAP)) {
      expect(enumSet.has(cat), `slug=${slug} category=${cat}`).toBe(true)
    }
  })

  it('slugs are lowercase (matches upstream folder convention)', () => {
    for (const slug of KNOWN_BRAND_SLUGS) {
      expect(slug).toBe(slug.toLowerCase())
    }
  })

  it('no duplicate slugs', () => {
    const unique = new Set(KNOWN_BRAND_SLUGS)
    expect(unique.size).toBe(KNOWN_BRAND_SLUGS.length)
  })

  it('categoryFor() returns the mapped category for known slugs', () => {
    expect(categoryFor('airbnb')).toBe('travel')
    expect(categoryFor('stripe')).toBe('finance')
    expect(categoryFor('claude')).toBe('ai')
    expect(categoryFor('figma')).toBe('devtool')
    expect(categoryFor('notion')).toBe('saas')
    expect(categoryFor('tesla')).toBe('lifestyle')
    expect(categoryFor('spotify')).toBe('media')
    expect(categoryFor('pinterest')).toBe('social')
  })

  it('categoryFor() is case-insensitive on input', () => {
    // Upstream is lowercase today but a future commit with mixed case
    // shouldn't silently drop the brand.
    expect(categoryFor('AIRBNB')).toBe('travel')
    expect(categoryFor('Claude')).toBe('ai')
  })

  it('categoryFor() returns null for unknown slugs (no guessing)', () => {
    expect(categoryFor('unknown-brand')).toBeNull()
    expect(categoryFor('')).toBeNull()
  })

  it('category distribution matches the documented counts', () => {
    // If a refactor rebalances the buckets, this guards against silent
    // drift. Update the expected counts when the map changes.
    const counts: Record<string, number> = {}
    for (const cat of Object.values(BRAND_CATEGORY_MAP)) {
      counts[cat] = (counts[cat] ?? 0) + 1
    }
    expect(counts).toEqual({
      ai: 13,
      devtool: 22, // +1 from clay (2026-04-18)
      saas: 6, // -1 from semrush removal (2026-04-18)
      media: 1,
      finance: 5,
      social: 1,
      travel: 2,
      lifestyle: 8,
    })
  })

  it('ecom category is empty today but exists in the enum (future seeds)', () => {
    // Thai put E-commerce in position 1 knowing that the current 58
    // brands don't populate it. The bucket must exist in the enum so
    // the UI chip renders (with count 0) and future seeds can land in
    // it without a code change.
    expect(DESIGN_LIBRARY_CATEGORIES).toContain('ecom')
    const ecomSlugs = Object.entries(BRAND_CATEGORY_MAP)
      .filter(([, c]) => c === 'ecom')
      .map(([s]) => s)
    expect(ecomSlugs).toEqual([])
  })

  it('KNOWN_BRAND_SLUGS is sorted for deterministic diffing', () => {
    const sorted = [...KNOWN_BRAND_SLUGS].sort()
    expect(KNOWN_BRAND_SLUGS).toEqual(sorted)
  })
})
