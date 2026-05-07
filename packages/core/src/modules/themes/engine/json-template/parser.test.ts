/**
 * Gbox Platform — JSON template parser tests
 *
 * Decision #1 Step 1.12. Cover:
 *
 *   1. Happy path — full Shopify-shaped JSON round-trips into the
 *      typed JsonTemplate structure.
 *   2. Order validation — missing sections, bad types, empty ids.
 *   3. Section validation — missing type, bad settings shape.
 *   4. Blocks — block_order drives render order, dangling ids are
 *      dropped, blocks not in order are omitted, insertion order is
 *      the fallback.
 *   5. Wrapper / layout validation — `layout: false` normalizes to
 *      null, string wrapper preserved, bad types throw.
 *   6. Forward-compat — unknown top-level keys survive parse.
 *   7. JSON syntax errors surface with the source path in the message.
 */

import { describe, it, expect } from 'vitest'
import { parseJsonTemplate, JsonTemplateParseError } from './parser.js'

describe('parseJsonTemplate — happy path', () => {
  it('parses a minimal valid template', () => {
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          main: { type: 'main-product' },
        },
        order: ['main'],
      }),
    )
    expect(tpl.order).toEqual(['main'])
    expect(tpl.sections.main.type).toBe('main-product')
    expect(tpl.sections.main.blocks).toEqual([])
  })

  it('parses a full Dawn-shaped template with blocks + wrapper + layout', () => {
    const source = JSON.stringify({
      sections: {
        main: {
          type: 'main-product',
          settings: { media_size: 'medium' },
          blocks: {
            abc123: { type: 'description', settings: { body: 'hi' } },
            def456: { type: 'title', settings: { text: 'Hello' } },
          },
          block_order: ['def456', 'abc123'],
          disabled: false,
        },
        related: {
          type: 'related-products',
          settings: { heading: 'Related' },
        },
      },
      order: ['main', 'related'],
      wrapper: 'main',
      layout: 'theme',
    })
    const tpl = parseJsonTemplate(source, 'templates/product.json')
    expect(tpl.order).toEqual(['main', 'related'])
    expect(tpl.wrapper).toBe('main')
    expect(tpl.layout).toBe('theme')
    expect(tpl.sections.main.blocks).toHaveLength(2)
    expect(tpl.sections.main.blocks[0].id).toBe('def456')
    expect(tpl.sections.main.blocks[0].type).toBe('title')
    expect(tpl.sections.main.blocks[1].id).toBe('abc123')
    expect(tpl.sections.main.disabled).toBe(false)
  })

  it('preserves forward-compat unknown top-level keys', () => {
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: { main: { type: 'x' } },
        order: ['main'],
        experimental_flag: true,
        theme_editor: { version: 2 },
      }),
    )
    expect((tpl as unknown as { experimental_flag: boolean }).experimental_flag).toBe(
      true,
    )
    expect(
      (tpl as unknown as { theme_editor: { version: number } }).theme_editor.version,
    ).toBe(2)
  })

  it('falls back to object insertion order when block_order is omitted', () => {
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          main: {
            type: 'x',
            blocks: {
              one: { type: 'a' },
              two: { type: 'b' },
              three: { type: 'c' },
            },
          },
        },
        order: ['main'],
      }),
    )
    expect(tpl.sections.main.blocks.map((b) => b.id)).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('silently skips dangling ids in block_order', () => {
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          main: {
            type: 'x',
            blocks: { a: { type: 'slide' } },
            block_order: ['a', 'ghost', 'also-ghost'],
          },
        },
        order: ['main'],
      }),
    )
    expect(tpl.sections.main.blocks).toHaveLength(1)
    expect(tpl.sections.main.blocks[0].id).toBe('a')
  })

  it('omits blocks that are not referenced in block_order', () => {
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: {
          main: {
            type: 'x',
            blocks: {
              kept: { type: 'slide' },
              dropped: { type: 'slide' },
            },
            block_order: ['kept'],
          },
        },
        order: ['main'],
      }),
    )
    expect(tpl.sections.main.blocks.map((b) => b.id)).toEqual(['kept'])
  })

  it('normalizes "layout: false" to null', () => {
    const tpl = parseJsonTemplate(
      JSON.stringify({
        sections: { main: { type: 'x' } },
        order: ['main'],
        layout: false,
      }),
    )
    expect(tpl.layout).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('parseJsonTemplate — validation errors', () => {
  it('throws on invalid JSON syntax', () => {
    expect(() => parseJsonTemplate('not json', 'foo.json')).toThrow(
      JsonTemplateParseError,
    )
    expect(() => parseJsonTemplate('not json', 'foo.json')).toThrow(
      /foo\.json/,
    )
  })

  it('throws when the top-level value is not an object', () => {
    expect(() => parseJsonTemplate('"just a string"')).toThrow(/must be an object/)
    expect(() => parseJsonTemplate('[1,2,3]')).toThrow(/must be an object/)
  })

  it('throws when "sections" is missing', () => {
    expect(() => parseJsonTemplate(JSON.stringify({ order: [] }))).toThrow(
      /missing "sections"/,
    )
  })

  it('throws when "order" is missing', () => {
    expect(() =>
      parseJsonTemplate(
        JSON.stringify({ sections: { main: { type: 'x' } } }),
      ),
    ).toThrow(/missing "order"/)
  })

  it('throws when order references an unknown section id', () => {
    expect(() =>
      parseJsonTemplate(
        JSON.stringify({
          sections: { main: { type: 'x' } },
          order: ['main', 'ghost'],
        }),
      ),
    ).toThrow(/unknown section id "ghost"/)
  })

  it('throws when a section has no type', () => {
    expect(() =>
      parseJsonTemplate(
        JSON.stringify({
          sections: { main: { settings: {} } },
          order: ['main'],
        }),
      ),
    ).toThrow(/missing a "type" string/)
  })

  it('throws when section.settings is not an object', () => {
    expect(() =>
      parseJsonTemplate(
        JSON.stringify({
          sections: { main: { type: 'x', settings: 'oops' } },
          order: ['main'],
        }),
      ),
    ).toThrow(/settings.*must be an object/)
  })

  it('throws when a block is missing a type', () => {
    expect(() =>
      parseJsonTemplate(
        JSON.stringify({
          sections: {
            main: {
              type: 'x',
              blocks: { a: { settings: {} } },
              block_order: ['a'],
            },
          },
          order: ['main'],
        }),
      ),
    ).toThrow(/blocks\["a"\].*missing a "type"/)
  })

  it('throws when "wrapper" is not a string', () => {
    expect(() =>
      parseJsonTemplate(
        JSON.stringify({
          sections: { main: { type: 'x' } },
          order: ['main'],
          wrapper: 42,
        }),
      ),
    ).toThrow(/wrapper/)
  })

  it('throws when "layout" is neither string nor false', () => {
    expect(() =>
      parseJsonTemplate(
        JSON.stringify({
          sections: { main: { type: 'x' } },
          order: ['main'],
          layout: 42,
        }),
      ),
    ).toThrow(/layout/)
  })
})
