/**
 * theme-files-helpers unit tests.
 */

import { describe, it, expect } from 'vitest'
import {
  synthesizeThemeFileSourceUrl,
  isSynthesizedThemeFileSourceUrl,
} from './theme-files-helpers.js'

describe('synthesizeThemeFileSourceUrl', () => {
  it('produces a gbox:// URL with the theme id + path', () => {
    expect(
      synthesizeThemeFileSourceUrl('a9eeb3f6-1234', 'layout/theme.liquid'),
    ).toBe('gbox://theme/a9eeb3f6-1234/layout/theme.liquid')
  })

  it('different paths under the same theme produce distinct URLs (UNIQUE index satisfied)', () => {
    const u1 = synthesizeThemeFileSourceUrl('t1', 'layout/theme.liquid')
    const u2 = synthesizeThemeFileSourceUrl('t1', 'sections/header.liquid')
    expect(u1).not.toBe(u2)
  })

  it('different theme ids with the same path produce distinct URLs', () => {
    const u1 = synthesizeThemeFileSourceUrl('t1', 'layout/theme.liquid')
    const u2 = synthesizeThemeFileSourceUrl('t2', 'layout/theme.liquid')
    expect(u1).not.toBe(u2)
  })

  it('is deterministic (same input → same output every time)', () => {
    const a = synthesizeThemeFileSourceUrl('t1', 'a/b.css')
    const b = synthesizeThemeFileSourceUrl('t1', 'a/b.css')
    expect(a).toBe(b)
  })
})

describe('isSynthesizedThemeFileSourceUrl', () => {
  it('returns true for gbox://theme/ URLs', () => {
    expect(isSynthesizedThemeFileSourceUrl('gbox://theme/x/y')).toBe(true)
  })
  it('returns false for real URLs', () => {
    expect(isSynthesizedThemeFileSourceUrl('https://example.com/style.css')).toBe(false)
    expect(isSynthesizedThemeFileSourceUrl('http://x')).toBe(false)
  })
  it('returns false for empty / null / undefined', () => {
    expect(isSynthesizedThemeFileSourceUrl('')).toBe(false)
    expect(isSynthesizedThemeFileSourceUrl(null)).toBe(false)
    expect(isSynthesizedThemeFileSourceUrl(undefined)).toBe(false)
  })
})
