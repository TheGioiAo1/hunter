/**
 * Gbox Platform — parseSchemaBody() tests
 *
 * Decision #1 Step 1.11. Covers the JSON parser that turns a raw
 * `{% schema %}` body into a typed `ParsedSchema`. Scope:
 *
 *   1. Valid JSON with nested settings + blocks round-trips correctly
 *   2. All known setting types are accepted
 *   3. `header` / `paragraph` separators don't require an `id`
 *   4. Missing `settings` / `blocks` default to empty arrays
 *   5. Invalid JSON throws SchemaParseError with source path
 *   6. Non-object top-level value throws
 *   7. Non-array `settings` / `blocks` throws
 *   8. Settings entries without `type` throw
 *   9. Value-typed settings without `id` throw
 *  10. Duplicate setting ids throw
 *  11. Duplicate block types throw
 *  12. Block settings inherit the same duplicate-id check
 *  13. Empty body returns an empty schema (not an error)
 *  14. Unknown top-level keys pass through unchanged
 *  15. Unknown setting types are preserved (forwards-compat)
 */

import { describe, it, expect } from 'vitest'
import { parseSchemaBody, emptySchema, SchemaParseError } from './parser.js'

describe('parseSchemaBody', () => {
  it('parses a valid schema with settings and blocks', () => {
    const body = JSON.stringify({
      name: 'Hero',
      tag: 'section',
      class: 'hero-section',
      settings: [
        { type: 'text', id: 'heading', default: 'Welcome', label: 'Heading' },
        { type: 'color', id: 'bg', default: '#ffffff', label: 'Background' },
      ],
      blocks: [
        {
          type: 'slide',
          name: 'Slide',
          settings: [
            { type: 'text', id: 'title', default: 'Slide title' },
            { type: 'image_picker', id: 'image' },
          ],
        },
      ],
    })
    const out = parseSchemaBody(body)
    expect(out.name).toBe('Hero')
    expect(out.tag).toBe('section')
    expect(out.class).toBe('hero-section')
    expect(out.settings).toHaveLength(2)
    expect(out.settings[0]).toMatchObject({
      type: 'text',
      id: 'heading',
      default: 'Welcome',
    })
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0].type).toBe('slide')
    expect(out.blocks[0].settings).toHaveLength(2)
  })

  it('accepts all known setting types', () => {
    const types = [
      'text',
      'textarea',
      'richtext',
      'number',
      'range',
      'checkbox',
      'radio',
      'select',
      'color',
      'url',
      'image_picker',
      'product',
      'collection',
      'blog',
      'page',
      'link_list',
    ]
    const body = JSON.stringify({
      settings: types.map((t, i) => ({ type: t, id: `f${i}` })),
    })
    const out = parseSchemaBody(body)
    expect(out.settings).toHaveLength(types.length)
    types.forEach((t, i) => {
      expect(out.settings[i].type).toBe(t)
      expect(out.settings[i].id).toBe(`f${i}`)
    })
  })

  it('allows header and paragraph entries without an id', () => {
    const body = JSON.stringify({
      settings: [
        { type: 'header', content: 'General' },
        { type: 'paragraph', content: 'Tune the hero below.' },
        { type: 'text', id: 'heading', default: 'Hi' },
      ],
    })
    const out = parseSchemaBody(body)
    expect(out.settings).toHaveLength(3)
    expect(out.settings[0].type).toBe('header')
    expect(out.settings[0].id).toBeUndefined()
    expect(out.settings[1].type).toBe('paragraph')
    expect(out.settings[2].id).toBe('heading')
  })

  it('missing settings / blocks arrays default to empty', () => {
    const body = JSON.stringify({ name: 'Empty' })
    const out = parseSchemaBody(body)
    expect(out.settings).toEqual([])
    expect(out.blocks).toEqual([])
  })

  it('empty body returns an empty schema', () => {
    expect(parseSchemaBody('')).toEqual(emptySchema())
    expect(parseSchemaBody('   \n  \n ')).toEqual(emptySchema())
  })

  it('throws SchemaParseError with source path on invalid JSON', () => {
    expect(() =>
      parseSchemaBody('{ not: "json" }', 'sections/hero.liquid'),
    ).toThrow(SchemaParseError)
    try {
      parseSchemaBody('{ bad }', 'sections/hero.liquid')
    } catch (err) {
      const e = err as SchemaParseError
      expect(e.name).toBe('SchemaParseError')
      expect(e.sourcePath).toBe('sections/hero.liquid')
      expect(e.message).toMatch(/invalid JSON/)
      expect(e.message).toMatch(/sections\/hero\.liquid/)
    }
  })

  it('throws when the top-level value is not an object', () => {
    expect(() => parseSchemaBody('[1,2,3]', 'x.liquid')).toThrow(
      /must be a JSON object/,
    )
    expect(() => parseSchemaBody('"hi"', 'x.liquid')).toThrow(
      /must be a JSON object/,
    )
    expect(() => parseSchemaBody('42', 'x.liquid')).toThrow(
      /must be a JSON object/,
    )
    expect(() => parseSchemaBody('null', 'x.liquid')).toThrow(
      /must be a JSON object/,
    )
  })

  it('throws when settings is not an array', () => {
    const body = JSON.stringify({ settings: { foo: 'bar' } })
    expect(() => parseSchemaBody(body, 'x.liquid')).toThrow(
      /settings.*must be an array/,
    )
  })

  it('throws when blocks is not an array', () => {
    const body = JSON.stringify({ blocks: 'nope' })
    expect(() => parseSchemaBody(body, 'x.liquid')).toThrow(
      /blocks.*must be an array/,
    )
  })

  it('throws when a setting is missing type', () => {
    const body = JSON.stringify({ settings: [{ id: 'heading' }] })
    expect(() => parseSchemaBody(body)).toThrow(/missing a "type" string/)
  })

  it('throws when a value-typed setting is missing id', () => {
    const body = JSON.stringify({ settings: [{ type: 'text' }] })
    expect(() => parseSchemaBody(body)).toThrow(/requires an "id" string/)
  })

  it('throws on duplicate setting ids', () => {
    const body = JSON.stringify({
      settings: [
        { type: 'text', id: 'heading' },
        { type: 'text', id: 'heading' },
      ],
    })
    expect(() => parseSchemaBody(body, 'hero.liquid')).toThrow(
      /duplicate id "heading"/,
    )
  })

  it('throws on duplicate block types', () => {
    const body = JSON.stringify({
      blocks: [
        { type: 'slide', settings: [] },
        { type: 'slide', settings: [] },
      ],
    })
    expect(() => parseSchemaBody(body)).toThrow(/duplicate type "slide"/)
  })

  it('block settings inherit duplicate-id validation', () => {
    const body = JSON.stringify({
      blocks: [
        {
          type: 'slide',
          settings: [
            { type: 'text', id: 'title' },
            { type: 'text', id: 'title' },
          ],
        },
      ],
    })
    expect(() => parseSchemaBody(body)).toThrow(
      /blocks\[0\]\.settings.*duplicate id "title"/,
    )
  })

  it('preserves unknown top-level keys for editor round-trip', () => {
    const body = JSON.stringify({
      name: 'X',
      max_blocks: 5,
      presets: [{ name: 'Default' }],
      enabled_on: { templates: ['index'] },
      locales: { en: { foo: 'bar' } },
    })
    const out = parseSchemaBody(body)
    expect(out.max_blocks).toBe(5)
    expect(out.presets).toEqual([{ name: 'Default' }])
    expect(out.enabled_on).toEqual({ templates: ['index'] })
    expect(out.locales).toEqual({ en: { foo: 'bar' } })
  })

  it('preserves unknown setting types (forwards-compat)', () => {
    const body = JSON.stringify({
      settings: [
        { type: 'future_type_v2', id: 'new_field', default: 'x' },
      ],
    })
    const out = parseSchemaBody(body)
    expect(out.settings[0].type).toBe('future_type_v2')
    expect(out.settings[0].default).toBe('x')
  })

  it('rejects JSON with trailing commas (Shopify strict mode)', () => {
    const body = '{ "settings": [{ "type": "text", "id": "h", },] }'
    expect(() => parseSchemaBody(body)).toThrow(/invalid JSON/)
  })

  it('rejects JSON with JS comments', () => {
    const body = '// comment\n{ "settings": [] }'
    expect(() => parseSchemaBody(body)).toThrow(/invalid JSON/)
  })

  it('rejects single-quoted strings', () => {
    const body = "{ 'name': 'X' }"
    expect(() => parseSchemaBody(body)).toThrow(/invalid JSON/)
  })

  it('returns a fresh object on every call (no shared state)', () => {
    const body = JSON.stringify({ settings: [{ type: 'text', id: 'h' }] })
    const a = parseSchemaBody(body)
    const b = parseSchemaBody(body)
    expect(a).not.toBe(b)
    expect(a.settings).not.toBe(b.settings)
    // Mutating one must not affect the other.
    a.settings.push({ type: 'text', id: 'extra' })
    expect(b.settings).toHaveLength(1)
  })
})

describe('emptySchema', () => {
  it('returns a fresh empty schema on each call', () => {
    const a = emptySchema()
    const b = emptySchema()
    expect(a).toEqual({ settings: [], blocks: [] })
    expect(a).not.toBe(b)
    expect(a.settings).not.toBe(b.settings)
  })
})
