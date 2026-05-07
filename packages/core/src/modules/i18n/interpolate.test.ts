/**
 * Gbox Platform — i18n interpolate() unit tests
 *
 * Decision #1 Step 1.2b — Pure tests of the regex-based template
 * substitution helper. These run in <1ms and cover every branch the
 * production `t()` lookup will exercise.
 */

import { describe, it, expect } from 'vitest'
import { interpolate } from './interpolate.js'

describe('interpolate()', () => {
  it('passes through a string with no tokens', () => {
    expect(interpolate('Hello world')).toBe('Hello world')
  })

  it('substitutes a single token', () => {
    expect(interpolate('Hello {{ name }}', { name: 'Thai' })).toBe('Hello Thai')
  })

  it('substitutes multiple tokens', () => {
    expect(
      interpolate('{{ greeting }} {{ name }}!', { greeting: 'Hi', name: 'Bob' }),
    ).toBe('Hi Bob!')
  })

  it('tolerates missing inner whitespace', () => {
    expect(interpolate('{{name}} and {{ name }}', { name: 'X' })).toBe('X and X')
  })

  it('coerces numeric values to strings', () => {
    expect(interpolate('You have {{ count }} items', { count: 3 })).toBe(
      'You have 3 items',
    )
  })

  it('coerces boolean values to strings', () => {
    expect(interpolate('available={{ flag }}', { flag: true })).toBe('available=true')
  })

  it('leaves token literal when key is missing', () => {
    // Shopify behavior: missing var renders as the raw `{{ name }}` so
    // the bug is visible during dev review.
    expect(interpolate('Hello {{ name }}', { other: 'X' })).toBe('Hello {{ name }}')
  })

  it('leaves token literal when value is null', () => {
    expect(interpolate('a {{ x }} b', { x: null })).toBe('a {{ x }} b')
  })

  it('leaves token literal when value is undefined', () => {
    expect(interpolate('a {{ x }} b', { x: undefined })).toBe('a {{ x }} b')
  })

  it('returns template unchanged when no vars provided', () => {
    expect(interpolate('Hello {{ name }}')).toBe('Hello {{ name }}')
  })

  it('supports dotted variable names', () => {
    expect(
      interpolate('Hi {{ user.first_name }}', { 'user.first_name': 'Thai' }),
    ).toBe('Hi Thai')
  })

  it('supports dashed variable names', () => {
    expect(interpolate('{{ x-y }}', { 'x-y': 'ok' })).toBe('ok')
  })

  it('does not double-substitute (no recursion into substituted text)', () => {
    // If the substituted value happens to contain `{{...}}`, leave it.
    expect(interpolate('A {{ x }}', { x: '{{ y }}' })).toBe('A {{ y }}')
  })

  it('handles empty template', () => {
    expect(interpolate('', { x: 'a' })).toBe('')
  })
})
