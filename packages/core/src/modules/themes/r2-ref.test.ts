/**
 * Gbox Platform — R2 reference helpers tests
 *
 * Decision #1 Step 1.16. Pure-function unit tests for the sentinel
 * format that gates R2 storage. No DB, no ObjectStore, no I/O.
 *
 * Coverage:
 *   1. r2KeyForAsset builds the canonical layout
 *   2. r2KeyForAsset rejects empty inputs
 *   3. formatR2Reference adds the prefix
 *   4. formatR2ReferenceForAsset is a one-shot helper
 *   5. isR2Reference recognizes the prefix
 *   6. isR2Reference rejects non-strings + non-r2 strings
 *   7. parseR2Reference round-trips a real ref
 *   8. parseR2Reference returns null for non-refs
 *   9. byteLengthUtf8 counts multibyte characters correctly
 *  10. shouldPromoteToR2 uses the default threshold
 *  11. shouldPromoteToR2 honors a custom threshold
 *  12. shouldPromoteToR2 is exclusive at the boundary (256 KB stays inline)
 *  13. r2KeyForAsset is stable for the duplication scenario
 */

import { describe, expect, it } from 'vitest'
import {
  byteLengthUtf8,
  formatR2Reference,
  formatR2ReferenceForAsset,
  isR2Reference,
  parseR2Reference,
  R2_REF_PREFIX,
  R2_THRESHOLD_BYTES,
  r2KeyForAsset,
  shouldPromoteToR2,
} from './r2-ref.js'

describe('r2KeyForAsset', () => {
  it('builds the canonical themes/{id}/{key} layout', () => {
    expect(r2KeyForAsset('abc-123', 'snippets/card.liquid')).toBe(
      'themes/abc-123/snippets/card.liquid',
    )
  })

  it('rejects empty themeId', () => {
    expect(() => r2KeyForAsset('', 'foo.css')).toThrow(/themeId/)
  })

  it('rejects empty key', () => {
    expect(() => r2KeyForAsset('abc', '')).toThrow(/key/)
  })

  it('produces disjoint keys for two themes (duplication safety)', () => {
    const a = r2KeyForAsset('theme-1', 'assets/theme.css')
    const b = r2KeyForAsset('theme-2', 'assets/theme.css')
    expect(a).not.toBe(b)
    expect(a.startsWith('themes/theme-1/')).toBe(true)
    expect(b.startsWith('themes/theme-2/')).toBe(true)
  })
})

describe('formatR2Reference', () => {
  it('adds the r2:// prefix', () => {
    expect(formatR2Reference('themes/abc/foo.css')).toBe(
      'r2://themes/abc/foo.css',
    )
  })

  it('uses the canonical R2_REF_PREFIX constant', () => {
    expect(R2_REF_PREFIX).toBe('r2://')
  })

  it('rejects empty input', () => {
    expect(() => formatR2Reference('')).toThrow(/r2Key/)
  })
})

describe('formatR2ReferenceForAsset', () => {
  it('chains r2KeyForAsset + formatR2Reference', () => {
    expect(formatR2ReferenceForAsset('abc', 'foo.css')).toBe(
      'r2://themes/abc/foo.css',
    )
  })
})

describe('isR2Reference', () => {
  it('recognizes a valid ref', () => {
    expect(isR2Reference('r2://themes/abc/foo.css')).toBe(true)
  })

  it('rejects inline source that happens to mention r2://', () => {
    expect(isR2Reference('  r2://something')).toBe(false)
    expect(isR2Reference('see r2://docs')).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isR2Reference(null)).toBe(false)
    expect(isR2Reference(undefined)).toBe(false)
    expect(isR2Reference(42)).toBe(false)
    expect(isR2Reference({})).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isR2Reference('')).toBe(false)
  })
})

describe('parseR2Reference', () => {
  it('strips the prefix and returns the key', () => {
    expect(parseR2Reference('r2://themes/abc/foo.css')).toBe(
      'themes/abc/foo.css',
    )
  })

  it('round-trips with formatR2Reference', () => {
    const key = 'themes/xyz/snippets/header.liquid'
    expect(parseR2Reference(formatR2Reference(key))).toBe(key)
  })

  it('returns null for non-refs', () => {
    expect(parseR2Reference('plain inline source')).toBeNull()
    expect(parseR2Reference(null)).toBeNull()
    expect(parseR2Reference(undefined)).toBeNull()
  })
})

describe('byteLengthUtf8', () => {
  it('counts ASCII at one byte each', () => {
    expect(byteLengthUtf8('hello')).toBe(5)
  })

  it('counts Vietnamese tone marks correctly', () => {
    // 'Xin chào' = 8 chars but 'à' is 2 bytes in UTF-8
    expect(byteLengthUtf8('Xin chào')).toBe(9)
  })

  it('counts emoji as 4 bytes', () => {
    expect(byteLengthUtf8('🎉')).toBe(4)
  })
})

describe('shouldPromoteToR2', () => {
  it('returns false for short strings under the default threshold', () => {
    expect(shouldPromoteToR2('hello world')).toBe(false)
  })

  it('returns true for strings over the default threshold', () => {
    const big = 'a'.repeat(R2_THRESHOLD_BYTES + 1)
    expect(shouldPromoteToR2(big)).toBe(true)
  })

  it('is exclusive at the boundary — exactly threshold stays inline', () => {
    const exact = 'a'.repeat(R2_THRESHOLD_BYTES)
    expect(shouldPromoteToR2(exact)).toBe(false)
  })

  it('honors a custom threshold', () => {
    expect(shouldPromoteToR2('hello', 4)).toBe(true)
    expect(shouldPromoteToR2('hi', 4)).toBe(false)
  })

  it('uses byte length, not character length', () => {
    // 100 emoji × 4 bytes each = 400 bytes; under threshold of 500
    const emoji100 = '🎉'.repeat(100)
    expect(shouldPromoteToR2(emoji100, 500)).toBe(false)
    expect(shouldPromoteToR2(emoji100, 399)).toBe(true)
  })
})

describe('R2_THRESHOLD_BYTES constant', () => {
  it('is 256 KB exactly', () => {
    expect(R2_THRESHOLD_BYTES).toBe(256 * 1024)
  })
})
