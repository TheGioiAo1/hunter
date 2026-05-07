/**
 * Unit tests cho collection-form-schema:
 *   - deriveSlug (Vietnamese normalization)
 *   - parseCollectionForm (zod validate + auto-slug)
 */

import { describe, it, expect } from 'vitest'
import { deriveSlug, parseCollectionForm } from './collection-form-schema.js'

describe('deriveSlug', () => {
  it('lowercase ASCII', () => {
    expect(deriveSlug('Summer Collection')).toBe('summer-collection')
  })

  it('normalize Vietnamese diacritics', () => {
    expect(deriveSlug('Áo dài')).toBe('ao-dai')
    expect(deriveSlug('Đồ ngủ')).toBe('do-ngu')
    expect(deriveSlug('Túi xách')).toBe('tui-xach')
  })

  it('handle numbers', () => {
    expect(deriveSlug('Bộ Sưu Tập 2026')).toBe('bo-suu-tap-2026')
  })

  it('strip special characters', () => {
    expect(deriveSlug("Men's @ T-Shirt!")).toBe('men-s-t-shirt')
  })

  it('collapse multiple separators', () => {
    expect(deriveSlug('a   b___c')).toBe('a-b-c')
  })

  it('trim leading/trailing hyphens', () => {
    expect(deriveSlug('---hello---')).toBe('hello')
  })

  it('cap at 100 chars', () => {
    const long = 'a'.repeat(200)
    expect(deriveSlug(long).length).toBeLessThanOrEqual(100)
  })

  it('empty input returns empty', () => {
    expect(deriveSlug('')).toBe('')
  })
})

describe('parseCollectionForm', () => {
  it('valid minimal payload', () => {
    const result = parseCollectionForm({ name: 'Summer' })
    expect(result.errors).toBeNull()
    expect(result.data?.name).toBe('Summer')
    expect(result.data?.slug).toBe('summer')
    expect(result.data?.status).toBe(false) // checkbox not sent → false
  })

  it('checkbox status="on" parsed as true', () => {
    const result = parseCollectionForm({ name: 'X', status: 'on' })
    expect(result.data?.status).toBe(true)
  })

  it('checkbox status="true" parsed as true', () => {
    const result = parseCollectionForm({ name: 'X', status: 'true' })
    expect(result.data?.status).toBe(true)
  })

  it('uses provided slug instead of auto-generating', () => {
    const result = parseCollectionForm({ name: 'Áo dài', slug: 'custom-slug' })
    expect(result.data?.slug).toBe('custom-slug')
  })

  it('auto-generates slug from Vietnamese name when empty', () => {
    const result = parseCollectionForm({ name: 'Áo dài' })
    expect(result.data?.slug).toBe('ao-dai')
  })

  it('rejects empty name', () => {
    const result = parseCollectionForm({ name: '' })
    expect(result.data).toBeNull()
    expect(result.errors?.name).toBeDefined()
  })

  it('rejects name > 200 chars', () => {
    const result = parseCollectionForm({ name: 'a'.repeat(201) })
    expect(result.errors?.name).toContain('200')
  })

  it('rejects invalid image_url', () => {
    const result = parseCollectionForm({ name: 'X', image_url: 'not-a-url' })
    expect(result.errors?.image_url).toBeDefined()
  })

  it('accepts empty image_url', () => {
    const result = parseCollectionForm({ name: 'X', image_url: '' })
    expect(result.errors).toBeNull()
  })

  it('rejects description > 5000 chars', () => {
    const result = parseCollectionForm({ name: 'X', description: 'a'.repeat(5001) })
    expect(result.errors?.description).toBeDefined()
  })

  it('trims whitespace from name', () => {
    const result = parseCollectionForm({ name: '  Summer  ' })
    expect(result.data?.name).toBe('Summer')
  })

  it('ignores non-string inputs gracefully', () => {
    const result = parseCollectionForm({ name: 'X', description: 123 as any })
    expect(result.errors).toBeNull()
    expect(result.data?.description).toBeUndefined()
  })
})
