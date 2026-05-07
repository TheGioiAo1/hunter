/**
 * Section schema reader — parses {% schema %} blocks out of Liquid.
 *
 * Pinning this behaviour matters because the catalog's entire contract
 * depends on every Gbox Dawn section yielding the schema we expect.
 */

import { describe, it, expect } from 'vitest'
import { parseSectionSchema } from './schema-reader.js'

describe('parseSectionSchema', () => {
  it('extracts name, settings, and presets from a typical schema block', () => {
    const src = `
      <section>Hello</section>
      {% schema %}
      {
        "name": "t:sections.demo.name",
        "settings": [
          { "type": "text", "id": "heading", "label": "Heading", "default": "Hi" },
          { "type": "range", "id": "count", "min": 1, "max": 10, "step": 1, "default": 4 }
        ],
        "presets": [
          { "name": "Default", "category": "Demo" }
        ]
      }
      {% endschema %}
    `
    const schema = parseSectionSchema(src)
    expect(schema.name).toBe('t:sections.demo.name')
    expect(schema.settings).toHaveLength(2)
    expect(schema.settings[0]).toMatchObject({ id: 'heading', type: 'text', default: 'Hi' })
    expect(schema.settings[1]).toMatchObject({ id: 'count', type: 'range', default: 4, min: 1, max: 10 })
    expect(schema.presets).toEqual([{ name: 'Default', category: 'Demo' }])
  })

  it('falls back to type "text" for unknown setting types', () => {
    const src = `
      {% schema %}
      { "name": "x", "settings": [{ "type": "super_exotic", "id": "field_a" }] }
      {% endschema %}
    `
    const schema = parseSectionSchema(src)
    expect(schema.settings[0].type).toBe('text')
  })

  it('coerces a numeric default given as a string', () => {
    const src = `
      {% schema %}
      { "name": "x", "settings": [{ "type": "range", "id": "n", "default": "5" }] }
      {% endschema %}
    `
    const schema = parseSectionSchema(src)
    expect(schema.settings[0].default).toBe(5)
  })

  it('coerces a checkbox default given as the string "true"', () => {
    const src = `
      {% schema %}
      { "name": "x", "settings": [{ "type": "checkbox", "id": "on", "default": "true" }] }
      {% endschema %}
    `
    const schema = parseSectionSchema(src)
    expect(schema.settings[0].default).toBe(true)
  })

  it('skips settings without an id', () => {
    const src = `
      {% schema %}
      { "name": "x", "settings": [{ "type": "text" }, { "type": "text", "id": "valid" }] }
      {% endschema %}
    `
    const schema = parseSectionSchema(src)
    expect(schema.settings).toHaveLength(1)
    expect(schema.settings[0].id).toBe('valid')
  })

  it('throws when the opening {% schema %} tag is missing', () => {
    const src = `<section>No schema here</section>`
    expect(() => parseSectionSchema(src)).toThrow(/Missing.*schema/)
  })

  it('throws when the closing {% endschema %} tag is missing', () => {
    const src = `
      {% schema %}
      { "name": "x" }
    `
    expect(() => parseSectionSchema(src)).toThrow(/endschema/)
  })

  it('throws with an informative message when JSON is malformed', () => {
    const src = `
      {% schema %}
      { "name": "x", "settings": [ bad json ] }
      {% endschema %}
    `
    expect(() => parseSectionSchema(src)).toThrow(/not valid JSON/)
  })

  it('defaults name to "Unnamed Section" when absent', () => {
    const src = `
      {% schema %}
      { "settings": [] }
      {% endschema %}
    `
    const schema = parseSectionSchema(src)
    expect(schema.name).toBe('Unnamed Section')
  })
})
