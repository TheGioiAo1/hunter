import { describe, it, expect } from 'vitest'
import { esc } from './esc.js'

describe('esc', () => {
  it('escapes ampersand', () => {
    expect(esc('a & b')).toBe('a &amp; b')
  })
  it('escapes <, >, "', () => {
    expect(esc('<img src="x">')).toBe('&lt;img src=&quot;x&quot;&gt;')
  })
  it("escapes single quote", () => {
    expect(esc("it's")).toBe('it&#39;s')
  })
  it('null and undefined collapse to empty string', () => {
    expect(esc(null)).toBe('')
    expect(esc(undefined)).toBe('')
  })
  it('numbers and booleans are stringified', () => {
    expect(esc(42)).toBe('42')
    expect(esc(true)).toBe('true')
  })
})
