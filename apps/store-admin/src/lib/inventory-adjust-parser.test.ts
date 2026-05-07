/**
 * Unit tests cho inventory-adjust-parser.
 * Pure function — không cần mock. Cover: 3 ops, boundary, error paths.
 */

import { describe, it, expect } from 'vitest'
import { parseAdjust } from './inventory-adjust-parser.js'

describe('parseAdjust', () => {
  describe('absolute set (=N)', () => {
    it('returns N as targetQty', () => {
      expect(parseAdjust('=100')).toEqual({ targetQty: 100 })
    })

    it('works without current value', () => {
      expect(parseAdjust('=42')).toEqual({ targetQty: 42 })
    })

    it('accepts 0', () => {
      expect(parseAdjust('=0')).toEqual({ targetQty: 0 })
    })

    it('rejects above MAX_QTY', () => {
      expect(() => parseAdjust('=1000000')).toThrow(RangeError)
    })

    it('accepts MAX_QTY exactly', () => {
      expect(parseAdjust('=999999')).toEqual({ targetQty: 999999 })
    })
  })

  describe('add (+N)', () => {
    it('adds to current', () => {
      expect(parseAdjust('+5', 10)).toEqual({ targetQty: 15 })
    })

    it('rejects without current', () => {
      expect(() => parseAdjust('+5')).toThrow(SyntaxError)
    })

    it('rejects when result exceeds MAX_QTY', () => {
      expect(() => parseAdjust('+1', 999999)).toThrow(RangeError)
    })
  })

  describe('subtract (-N)', () => {
    it('subtracts from current', () => {
      expect(parseAdjust('-3', 10)).toEqual({ targetQty: 7 })
    })

    it('rejects without current', () => {
      expect(() => parseAdjust('-3')).toThrow(SyntaxError)
    })

    it('rejects when result goes negative', () => {
      expect(() => parseAdjust('-20', 5)).toThrow(RangeError)
      expect(() => parseAdjust('-20', 5)).toThrow(/below 0/)
    })

    it('accepts result exactly 0', () => {
      expect(parseAdjust('-10', 10)).toEqual({ targetQty: 0 })
    })
  })

  describe('format errors', () => {
    it('rejects non-numeric input', () => {
      expect(() => parseAdjust('abc')).toThrow(SyntaxError)
    })

    it('rejects missing operator', () => {
      expect(() => parseAdjust('100')).toThrow(SyntaxError)
    })

    it('rejects empty string', () => {
      expect(() => parseAdjust('')).toThrow(SyntaxError)
    })

    it('rejects null/undefined', () => {
      expect(() => parseAdjust(null as any)).toThrow(SyntaxError)
      expect(() => parseAdjust(undefined as any)).toThrow(SyntaxError)
    })

    it('rejects negative N (double sign)', () => {
      expect(() => parseAdjust('+-5', 10)).toThrow(SyntaxError)
    })

    it('rejects decimal', () => {
      expect(() => parseAdjust('+5.5', 10)).toThrow(SyntaxError)
    })

    it('trims whitespace', () => {
      expect(parseAdjust('  =100  ')).toEqual({ targetQty: 100 })
    })
  })
})
