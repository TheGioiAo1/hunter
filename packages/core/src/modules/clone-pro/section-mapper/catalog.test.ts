/**
 * Section catalog — the 20-section source of truth.
 *
 * These tests verify:
 *   - Every section file in the Gbox Dawn bundle is represented exactly
 *     once in the catalog (drift guard).
 *   - Each catalog entry has a parsed schema, correct bucket, and (for
 *     main-* entries) a pageType binding.
 *   - The helper lookups (`getSectionDef`, `sectionsInBucket`,
 *     `mainSectionForPageType`) behave correctly.
 *
 * If any of these fail, the most likely cause is that someone added a
 * new Liquid file under `themes/seed/gbox-dawn/sections/` without
 * updating CATALOG_REFERENCES in `catalog.ts`.
 */

import { describe, it, expect } from 'vitest'
import {
  assertCatalogMatchesBundle,
  getSectionCatalog,
  getSectionDef,
  mainSectionForPageType,
  sectionsInBucket,
} from './catalog.js'
import type { SectionBucket, SectionId } from './types.js'

describe('section catalog', () => {
  it('builds a 20-entry catalog with one entry per bundled section', () => {
    const catalog = getSectionCatalog()
    const ids = Object.keys(catalog) as SectionId[]
    expect(ids).toHaveLength(20)
  })

  it('every catalog entry has a parsed schema with a name', () => {
    const catalog = getSectionCatalog()
    for (const def of Object.values(catalog)) {
      expect(def.schema).toBeTruthy()
      expect(typeof def.schema.name).toBe('string')
      expect(Array.isArray(def.schema.settings)).toBe(true)
    }
  })

  it('assigns bucket correctly (2 chrome, 4 composable, 14 main)', () => {
    expect(sectionsInBucket('chrome')).toEqual(['header', 'footer'])
    expect(sectionsInBucket('composable')).toEqual([
      'hero',
      'featured-collection',
      'image-with-text',
      'newsletter',
    ])
    expect(sectionsInBucket('main')).toHaveLength(14)
  })

  it('main-* sections have pageType bindings; chrome/composable do not', () => {
    const catalog = getSectionCatalog()
    for (const def of Object.values(catalog)) {
      if (def.bucket === 'main') {
        expect(def.pageType).toBeTruthy()
      } else {
        expect(def.pageType).toBeUndefined()
      }
    }
  })

  it('mainSectionForPageType returns the right id for each page type', () => {
    const bindings: ReadonlyArray<[string, SectionId]> = [
      ['404', 'main-404'],
      ['account', 'main-account'],
      ['blog-post', 'main-article'],
      ['blog', 'main-blog'],
      ['cart', 'main-cart'],
      ['collection', 'main-collection'],
      ['gift_card', 'main-gift-card'],
      ['list-collections', 'main-list-collections'],
      ['login', 'main-login'],
      ['page', 'main-page'],
      ['password', 'main-password'],
      ['policy', 'main-policy'],
      ['product', 'main-product'],
      ['search', 'main-search'],
    ]
    for (const [pageType, expected] of bindings) {
      expect(mainSectionForPageType(pageType)).toBe(expected)
    }
  })

  it('mainSectionForPageType returns null for unknown page types', () => {
    expect(mainSectionForPageType('unknown-type')).toBeNull()
    expect(mainSectionForPageType('')).toBeNull()
  })

  it('getSectionDef returns the catalog entry for a known id', () => {
    const def = getSectionDef('hero')
    expect(def.id).toBe('hero')
    expect(def.bucket).toBe('composable')
  })

  it('getSectionDef throws for an unknown id', () => {
    expect(() =>
      getSectionDef('made-up-section' as SectionId),
    ).toThrow(/Unknown section/)
  })

  it('catalog is in lockstep with the bundle (no drift)', () => {
    expect(() => assertCatalogMatchesBundle()).not.toThrow()
  })

  it('caches the catalog — two calls return the same object reference', () => {
    const a = getSectionCatalog()
    const b = getSectionCatalog()
    expect(a).toBe(b)
  })

  it('each bucket roundtrips via sectionsInBucket', () => {
    const buckets: SectionBucket[] = ['chrome', 'composable', 'main']
    const catalog = getSectionCatalog()
    for (const bucket of buckets) {
      const ids = sectionsInBucket(bucket)
      for (const id of ids) {
        expect(catalog[id].bucket).toBe(bucket)
      }
    }
  })
})
