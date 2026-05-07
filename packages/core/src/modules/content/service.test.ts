/**
 * Unit tests for the pure helpers in content/service.ts added in
 * Phase 7 PR1 (SEO surfacing + bulk ops + tag chips).
 *
 * The DB-bound helpers (`createPage` / `updatePage` / `bulkUpdatePages` /
 * `createBlogPost` / `updateBlogPost` / `bulkUpdateBlogPosts`) are covered
 * by the live smoke test at `scripts/smoke-phase7-pr1.ts`.
 *
 * This file exercises the pure input-normalisation helpers the admin forms
 * depend on: `normaliseTags` for the blog chip editor, and the blank->NULL
 * behaviour exposed via the exported `normaliseTags` plus documented via
 * the service's JSDoc.
 */

import { describe, it, expect } from 'vitest'
import { normaliseTags } from './service.js'

describe('normaliseTags', () => {
  it('returns null for null / undefined / non-array', () => {
    expect(normaliseTags(null)).toBeNull()
    expect(normaliseTags(undefined)).toBeNull()
    // @ts-expect-error — explicitly testing wrong type
    expect(normaliseTags('not-an-array')).toBeNull()
    // @ts-expect-error
    expect(normaliseTags(42)).toBeNull()
  })

  it('returns null for empty arrays', () => {
    expect(normaliseTags([])).toBeNull()
  })

  it('returns null for arrays that only contain blank/whitespace strings', () => {
    expect(normaliseTags([''])).toBeNull()
    expect(normaliseTags(['', '  ', '\t\n'])).toBeNull()
  })

  it('trims whitespace around each tag', () => {
    expect(normaliseTags(['  sale  ', '\tnew\n'])).toEqual(['sale', 'new'])
  })

  it('drops blank entries but keeps non-blank neighbours', () => {
    expect(normaliseTags(['sale', '', '  ', 'new'])).toEqual(['sale', 'new'])
  })

  it('dedupes case-insensitively, preserving first-seen casing', () => {
    expect(normaliseTags(['Sale', 'sale', 'SALE'])).toEqual(['Sale'])
    expect(normaliseTags(['new', 'New', 'sale', 'SALE', 'hot'])).toEqual([
      'new',
      'sale',
      'hot',
    ])
  })

  it('preserves order on first occurrence', () => {
    expect(normaliseTags(['c', 'b', 'a', 'B', 'A'])).toEqual(['c', 'b', 'a'])
  })

  it('skips non-string entries', () => {
    // @ts-expect-error — testing filter
    expect(normaliseTags(['ok', 42, null, undefined, 'also-ok'])).toEqual([
      'ok',
      'also-ok',
    ])
  })

  it('does NOT collapse internal whitespace inside a tag', () => {
    // "on sale" is a single tag; we don't touch its internals beyond
    // outer-trim. That matches how Shopify treats multi-word tags.
    expect(normaliseTags(['on sale', 'on  sale'])).toEqual([
      'on sale',
      'on  sale',
    ])
  })

  it('keeps unicode tags (Vietnamese, emoji) intact', () => {
    expect(normaliseTags(['giảm-giá', '🔥 hot'])).toEqual([
      'giảm-giá',
      '🔥 hot',
    ])
  })

  it('is idempotent: normaliseTags(normaliseTags(x)) === normaliseTags(x)', () => {
    const input = ['  Sale  ', 'sale', 'NEW', 'new', '', 'hot']
    const once = normaliseTags(input)
    const twice = normaliseTags(once)
    expect(twice).toEqual(once)
  })
})
