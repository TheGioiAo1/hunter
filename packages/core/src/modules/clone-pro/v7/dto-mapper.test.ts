/**
 * Clone Pro v7 — DTO mapper tests.
 *
 * Sprint 2 Task 2.5. Maps Lonspy `Row` (raw crawler output) to v6
 * `ProductDTO` (the shape downstream Stages 5-12 already understand).
 * This is the bridge between the v7-crawler (battle-tested XPath
 * extractor) and the v6 asset-graph + persister + grader pipeline.
 */

import { describe, it, expect } from 'vitest'
import type { Row } from '../v7-crawler/types.js'
import {
  rowToProductDto,
  slugify,
  parseSpinIntoOptionsAndVariants,
  isProductRowComplete,
  collectionFromHandle,
} from './dto-mapper.js'

describe('slugify', () => {
  it('converts spaces to hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('lowercases ASCII', () => {
    expect(slugify('Big Red Hat')).toBe('big-red-hat')
  })

  it('strips special characters', () => {
    expect(slugify("Mom's Day Special!")).toBe('mom-s-day-special')
  })

  it('collapses repeated hyphens', () => {
    expect(slugify('A   B   C')).toBe('a-b-c')
  })

  it('strips leading/trailing hyphens', () => {
    expect(slugify('  Hello  ')).toBe('hello')
  })

  it('handles empty string → empty', () => {
    expect(slugify('')).toBe('')
  })

  it('strips Vietnamese diacritics', () => {
    // common e-com VN words
    expect(slugify('Áo Phông Đỏ')).toBe('ao-phong-do')
  })

  it('falls back to "untitled" for null-only input', () => {
    expect(slugify(null as unknown as string)).toBe('untitled')
  })
})

describe('parseSpinIntoOptionsAndVariants', () => {
  it('returns empty options + single default variant when Spin null', () => {
    const result = parseSpinIntoOptionsAndVariants(null, '19.99', null)
    expect(result.options).toEqual([])
    expect(result.variants).toHaveLength(1)
    expect(result.variants[0].title).toBe('Default')
    expect(result.variants[0].price).toBe('19.99')
  })

  it('parses single-axis Shopify-style spin (size only)', () => {
    const spin = ['Size:S', 'Size:M', 'Size:L']
    const result = parseSpinIntoOptionsAndVariants(spin, '24.50', null)
    expect(result.options).toHaveLength(1)
    expect(result.options[0].name).toBe('Size')
    expect(result.options[0].values).toEqual(['S', 'M', 'L'])
    expect(result.variants).toHaveLength(3)
    expect(result.variants[0].title).toBe('S')
    expect(result.variants[0].optionValues).toEqual({ Size: 'S' })
  })

  it('parses multi-axis (size × color)', () => {
    const spin = [
      'Size:S',
      'Size:M',
      'Color:Red',
      'Color:Blue',
    ]
    const result = parseSpinIntoOptionsAndVariants(spin, '30', null)
    expect(result.options).toHaveLength(2)
    expect(result.options.map((o) => o.name).sort()).toEqual(['Color', 'Size'])
    // All variants should be S×Red, S×Blue, M×Red, M×Blue (4 total)
    expect(result.variants).toHaveLength(4)
  })

  it('uses compareAtPrice when OldPrice provided', () => {
    const result = parseSpinIntoOptionsAndVariants(null, '19.99', 29.99)
    expect(result.variants[0].compareAtPrice).toBe('29.99')
  })

  it('handles legacy " × " separator', () => {
    const spin = ['S × Red', 'S × Blue', 'M × Red']
    const result = parseSpinIntoOptionsAndVariants(spin, '15', null)
    // Without explicit option names, the mapper defaults to Option1, Option2.
    expect(result.options).toHaveLength(2)
    expect(result.variants.length).toBeGreaterThan(0)
  })

  it('does not crash on malformed Spin entries', () => {
    const spin = ['', ':', 'Size:', ':M']
    expect(() =>
      parseSpinIntoOptionsAndVariants(spin, '10', null),
    ).not.toThrow()
  })
})

describe('isProductRowComplete', () => {
  it('returns true for full row', () => {
    const row: Row = {
      Title: 'Test Product',
      ImageUrls: ['https://cdn/x.jpg'],
      Description:
        'A long description that exceeds 200 characters. ' .padEnd(220, 'x'),
      Price: 19.99,
      Link: 'https://example.com/p/test',
    }
    expect(isProductRowComplete(row)).toBe(true)
  })

  it('returns false for missing image', () => {
    const row: Row = {
      Title: 'Test',
      ImageUrls: [],
      Description: 'x'.repeat(250),
      Price: 19.99,
      Link: 'https://example.com/p/test',
    }
    expect(isProductRowComplete(row)).toBe(false)
  })

  it('returns false for short description (<200 chars)', () => {
    const row: Row = {
      Title: 'Test',
      ImageUrls: ['https://cdn/x.jpg'],
      Description: 'short',
      Price: 19.99,
      Link: 'https://example.com/p/test',
    }
    expect(isProductRowComplete(row)).toBe(false)
  })

  it('returns false for null Title', () => {
    const row: Row = {
      Title: null,
      ImageUrls: ['https://cdn/x.jpg'],
      Description: 'x'.repeat(250),
      Price: 19.99,
      Link: 'https://example.com/p/test',
    }
    expect(isProductRowComplete(row)).toBe(false)
  })
})

describe('rowToProductDto', () => {
  it('maps a full Row → ProductDTO with all fields', () => {
    const row: Row = {
      Title: 'Cool T-Shirt',
      ImageUrls: ['https://cdn/img1.jpg', 'https://cdn/img2.jpg'],
      Description: '<p>A long description.</p>'.padEnd(220, 'x'),
      Price: 19.99,
      OldPrice: 29.99,
      Link: 'https://shop.com/products/cool-t-shirt',
      tags: ['summer', 'cotton'],
    }
    const dto = rowToProductDto(row)
    expect(dto).not.toBeNull()
    expect(dto!.sourceHandle).toBe('cool-t-shirt')
    expect(dto!.title).toBe('Cool T-Shirt')
    expect(dto!.bodyHtml).toContain('<p>')
    expect(dto!.images).toHaveLength(2)
    expect(dto!.images[0].sourceUrl).toBe('https://cdn/img1.jpg')
    expect(dto!.images[0].position).toBe(1)
    expect(dto!.variants).toHaveLength(1)
    expect(dto!.variants[0].price).toBe('19.99')
    expect(dto!.variants[0].compareAtPrice).toBe('29.99')
    expect(dto!.tags).toEqual(['summer', 'cotton'])
  })

  it('falls back to slugify(title) when Link is null', () => {
    const row: Row = {
      Title: 'Hello World',
      ImageUrls: [],
      Description: null,
      Price: null,
      Link: null,
    }
    const dto = rowToProductDto(row)
    expect(dto).not.toBeNull()
    expect(dto!.sourceHandle).toBe('hello-world')
  })

  it('returns null when Title is null AND Link is null', () => {
    const row: Row = {
      Title: null,
      ImageUrls: [],
      Description: null,
      Price: null,
      Link: null,
    }
    expect(rowToProductDto(row)).toBeNull()
  })

  it('extracts handle from Link if present', () => {
    const row: Row = {
      Title: 'Whatever',
      ImageUrls: [],
      Description: null,
      Price: 9.99,
      Link: 'https://shop.com/products/my-special-handle?var=1',
    }
    const dto = rowToProductDto(row)
    expect(dto!.sourceHandle).toBe('my-special-handle')
  })

  it('uses Spin to populate options + variants', () => {
    const row: Row = {
      Title: 'Variant Product',
      ImageUrls: ['https://cdn/x.jpg'],
      Description: null,
      Price: 25,
      Link: 'https://shop.com/products/variant',
      Spin: ['Size:M', 'Size:L', 'Size:XL'],
    }
    const dto = rowToProductDto(row)
    expect(dto!.options).toHaveLength(1)
    expect(dto!.options[0].values).toEqual(['M', 'L', 'XL'])
    expect(dto!.variants).toHaveLength(3)
  })

  it('preserves raw price string format with 2 decimal places', () => {
    const row: Row = {
      Title: 'Test',
      ImageUrls: [],
      Description: null,
      Price: 19,
      Link: 'https://shop.com/products/test',
    }
    const dto = rowToProductDto(row)
    expect(dto!.variants[0].price).toBe('19.00')
  })

  it('treats empty tags as empty array (not undefined)', () => {
    const row: Row = {
      Title: 'Test',
      ImageUrls: [],
      Description: null,
      Price: 1,
      Link: 'https://shop.com/products/test',
    }
    const dto = rowToProductDto(row)
    expect(dto!.tags).toEqual([])
  })
})

describe('collectionFromHandle', () => {
  it('builds a CollectionDTO with product handles', () => {
    const dto = collectionFromHandle({
      handle: 'summer-2025',
      title: 'Summer 2025',
      productHandles: ['hat', 't-shirt'],
      sourceUrl: 'https://shop.com/collections/summer-2025',
    })
    expect(dto.sourceHandle).toBe('summer-2025')
    expect(dto.title).toBe('Summer 2025')
    expect(dto.productHandles).toEqual(['hat', 't-shirt'])
    expect(dto.sourceUrl).toBe('https://shop.com/collections/summer-2025')
  })
})
