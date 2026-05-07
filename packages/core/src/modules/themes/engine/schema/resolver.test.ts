/**
 * Gbox Platform — schema resolver tests
 *
 * Decision #1 Step 1.11. Covers merging a parsed schema with an
 * optional render-time instance into a `SectionDrop`. Scope:
 *
 *   resolveSettingsFromList
 *     - Precedence: instance → schema.default → type fallback
 *     - header/paragraph filtered out
 *     - Explicit null override preserved
 *     - Explicit false override preserved (not coerced away)
 *     - Explicit 0 override preserved
 *     - Unknown keys in override ignored (no leakage)
 *     - Unknown setting type falls back to null
 *
 *   resolveSectionSettings
 *     - Delegates to resolveSettingsFromList and hits the schema path
 *
 *   resolveSectionBlocks
 *     - No instance.blocks → empty array
 *     - Blocks without schema → settings pass through unchanged
 *     - Blocks with schema → settings resolved via the same rules
 *     - Block id defaults to <type>-<index> when not provided
 *     - shopify_attributes preserved when present
 *
 *   resolveSectionDrop
 *     - Returns id + settings + blocks + blocks_count
 *     - blocks_count matches blocks.length
 *     - Empty schema + no instance → empty drop
 */

import { describe, it, expect } from 'vitest'
import {
  resolveSectionDrop,
  resolveSectionSettings,
  resolveSectionBlocks,
  resolveSettingsFromList,
} from './resolver.js'
import type { ParsedSchema } from './types.js'

function schema(partial: Partial<ParsedSchema>): ParsedSchema {
  return { settings: [], blocks: [], ...partial }
}

// ---------------------------------------------------------------------------
// resolveSettingsFromList
// ---------------------------------------------------------------------------

describe('resolveSettingsFromList', () => {
  it('returns an empty object when list is empty', () => {
    expect(resolveSettingsFromList([])).toEqual({})
  })

  it('uses schema defaults when instance has no overrides', () => {
    const list = [
      { type: 'text', id: 'heading', default: 'Hi' },
      { type: 'color', id: 'bg', default: '#fff' },
    ]
    expect(resolveSettingsFromList(list)).toEqual({
      heading: 'Hi',
      bg: '#fff',
    })
  })

  it('instance overrides win over schema defaults', () => {
    const list = [{ type: 'text', id: 'heading', default: 'Hi' }]
    expect(
      resolveSettingsFromList(list, { heading: 'Override' }),
    ).toEqual({ heading: 'Override' })
  })

  it('missing default falls back to the type-specific default', () => {
    const list = [
      { type: 'text', id: 'heading' }, // → ''
      { type: 'number', id: 'count' }, // → 0
      { type: 'checkbox', id: 'enabled' }, // → false
      { type: 'image_picker', id: 'image' }, // → null
      { type: 'product_list', id: 'products' }, // → []
    ]
    expect(resolveSettingsFromList(list)).toEqual({
      heading: '',
      count: 0,
      enabled: false,
      image: null,
      products: [],
    })
  })

  it('explicit null override is preserved (not treated as missing)', () => {
    const list = [{ type: 'text', id: 'heading', default: 'Hi' }]
    expect(resolveSettingsFromList(list, { heading: null })).toEqual({
      heading: null,
    })
  })

  it('explicit false override is preserved', () => {
    const list = [{ type: 'checkbox', id: 'enabled', default: true }]
    expect(resolveSettingsFromList(list, { enabled: false })).toEqual({
      enabled: false,
    })
  })

  it('explicit 0 override is preserved', () => {
    const list = [{ type: 'number', id: 'count', default: 5 }]
    expect(resolveSettingsFromList(list, { count: 0 })).toEqual({
      count: 0,
    })
  })

  it('schema default of false is preserved (not coerced away)', () => {
    const list = [{ type: 'checkbox', id: 'enabled', default: false }]
    expect(resolveSettingsFromList(list)).toEqual({ enabled: false })
  })

  it('header and paragraph entries are filtered from the drop', () => {
    const list = [
      { type: 'header', content: 'General' },
      { type: 'text', id: 'heading', default: 'Hi' },
      { type: 'paragraph', content: 'Help text.' },
      { type: 'text', id: 'subheading', default: 'Sub' },
    ]
    expect(resolveSettingsFromList(list)).toEqual({
      heading: 'Hi',
      subheading: 'Sub',
    })
  })

  it('unknown keys in the override are ignored (no leakage)', () => {
    const list = [{ type: 'text', id: 'heading', default: 'Hi' }]
    expect(
      resolveSettingsFromList(list, {
        heading: 'X',
        rogue: 'should-not-leak',
      }),
    ).toEqual({ heading: 'X' })
  })

  it('unknown setting type falls back to null', () => {
    const list = [{ type: 'brand_new_type', id: 'neu' }]
    expect(resolveSettingsFromList(list)).toEqual({ neu: null })
  })

  it('returns a fresh object on every call (no shared state)', () => {
    const list = [{ type: 'text', id: 'h', default: 'x' }]
    const a = resolveSettingsFromList(list)
    const b = resolveSettingsFromList(list)
    expect(a).not.toBe(b)
    a.extra = 'leak'
    expect(b).toEqual({ h: 'x' })
  })
})

// ---------------------------------------------------------------------------
// resolveSectionSettings
// ---------------------------------------------------------------------------

describe('resolveSectionSettings', () => {
  it('reads schema.settings and merges with instance.settings', () => {
    const s = schema({
      settings: [
        { type: 'text', id: 'heading', default: 'Default' },
        { type: 'color', id: 'bg', default: '#fff' },
      ],
    })
    expect(
      resolveSectionSettings(s, { settings: { heading: 'Override' } }),
    ).toEqual({ heading: 'Override', bg: '#fff' })
  })

  it('empty instance returns all defaults', () => {
    const s = schema({
      settings: [{ type: 'text', id: 'heading', default: 'Hi' }],
    })
    expect(resolveSectionSettings(s)).toEqual({ heading: 'Hi' })
    expect(resolveSectionSettings(s, {})).toEqual({ heading: 'Hi' })
    expect(resolveSectionSettings(s, { settings: {} })).toEqual({
      heading: 'Hi',
    })
  })
})

// ---------------------------------------------------------------------------
// resolveSectionBlocks
// ---------------------------------------------------------------------------

describe('resolveSectionBlocks', () => {
  it('returns an empty array when instance has no blocks', () => {
    const s = schema({
      blocks: [
        {
          type: 'slide',
          settings: [{ type: 'text', id: 'title', default: 'T' }],
        },
      ],
    })
    expect(resolveSectionBlocks(s)).toEqual([])
    expect(resolveSectionBlocks(s, {})).toEqual([])
    expect(resolveSectionBlocks(s, { blocks: [] })).toEqual([])
  })

  it('resolves block settings against the matching schema block', () => {
    const s = schema({
      blocks: [
        {
          type: 'slide',
          settings: [
            { type: 'text', id: 'title', default: 'Default Title' },
            { type: 'url', id: 'link', default: '/home' },
          ],
        },
      ],
    })
    const out = resolveSectionBlocks(s, {
      blocks: [
        {
          type: 'slide',
          id: 'abc123',
          settings: { title: 'Hello' },
        },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      id: 'abc123',
      type: 'slide',
      settings: { title: 'Hello', link: '/home' },
    })
  })

  it('defaults block id to <type>-<index> when not provided', () => {
    const s = schema({
      blocks: [{ type: 'slide', settings: [] }],
    })
    const out = resolveSectionBlocks(s, {
      blocks: [{ type: 'slide' }, { type: 'slide' }],
    })
    expect(out[0].id).toBe('slide-0')
    expect(out[1].id).toBe('slide-1')
  })

  it('unknown block type passes settings through unchanged', () => {
    const s = schema({ blocks: [] })
    const out = resolveSectionBlocks(s, {
      blocks: [{ type: 'mystery', id: 'm1', settings: { x: 1, y: 2 } }],
    })
    expect(out).toEqual([
      { id: 'm1', type: 'mystery', settings: { x: 1, y: 2 } },
    ])
  })

  it('shopify_attributes is preserved on resolved blocks', () => {
    const s = schema({ blocks: [{ type: 'slide', settings: [] }] })
    const out = resolveSectionBlocks(s, {
      blocks: [
        {
          type: 'slide',
          id: 's1',
          shopify_attributes: 'data-xyz',
          settings: {},
        },
      ],
    })
    expect(out[0].shopify_attributes).toBe('data-xyz')
  })

  it('resolves mixed block types independently', () => {
    const s = schema({
      blocks: [
        {
          type: 'slide',
          settings: [{ type: 'text', id: 'title', default: 'T' }],
        },
        {
          type: 'quote',
          settings: [{ type: 'text', id: 'body', default: 'B' }],
        },
      ],
    })
    const out = resolveSectionBlocks(s, {
      blocks: [
        { type: 'slide', settings: { title: 'Alpha' } },
        { type: 'quote' },
      ],
    })
    expect(out[0]).toMatchObject({
      type: 'slide',
      settings: { title: 'Alpha' },
    })
    expect(out[1]).toMatchObject({ type: 'quote', settings: { body: 'B' } })
  })
})

// ---------------------------------------------------------------------------
// resolveSectionDrop
// ---------------------------------------------------------------------------

describe('resolveSectionDrop', () => {
  it('returns id, settings, blocks, blocks_count', () => {
    const s = schema({
      settings: [{ type: 'text', id: 'heading', default: 'Hi' }],
      blocks: [{ type: 'slide', settings: [] }],
    })
    const drop = resolveSectionDrop('hero', s, {
      blocks: [{ type: 'slide' }, { type: 'slide' }],
    })
    expect(drop.id).toBe('hero')
    expect(drop.settings).toEqual({ heading: 'Hi' })
    expect(drop.blocks).toHaveLength(2)
    expect(drop.blocks_count).toBe(2)
  })

  it('empty schema + no instance returns an empty drop', () => {
    const drop = resolveSectionDrop('empty', schema({}))
    expect(drop).toEqual({
      id: 'empty',
      settings: {},
      blocks: [],
      blocks_count: 0,
    })
  })

  it('sections with different ids never share state', () => {
    const s = schema({
      settings: [{ type: 'text', id: 'heading', default: 'Hi' }],
    })
    const a = resolveSectionDrop('a', s, { settings: { heading: 'A' } })
    const b = resolveSectionDrop('b', s, { settings: { heading: 'B' } })
    expect(a.settings.heading).toBe('A')
    expect(b.settings.heading).toBe('B')
    expect(a.settings).not.toBe(b.settings)
  })
})
