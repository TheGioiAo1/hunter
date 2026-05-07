/**
 * section-schemas-seed unit tests.
 *
 * Cases:
 *   1. BUILTIN_SECTION_SCHEMAS has at least 16 entries
 *   2. Every schema entry has valid type + name + category
 *   3. ensureBuiltinSchemas issues 1 INSERT...ON CONFLICT per entry
 *   4. ensureBuiltinSchemas onConflict targets the `type` column
 *   5. Type strings are URL-safe lowercase + dash (matches client catalog)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  BUILTIN_SECTION_SCHEMAS,
  ensureBuiltinSchemas,
} from './section-schemas-seed.js'

describe('BUILTIN_SECTION_SCHEMAS', () => {
  it('ships at least 16 entries (matches client DEFAULT_SECTION_CATALOG)', () => {
    expect(BUILTIN_SECTION_SCHEMAS.length).toBeGreaterThanOrEqual(16)
  })

  it('every entry has valid type + name + category + schema.name', () => {
    for (const def of BUILTIN_SECTION_SCHEMAS) {
      expect(def.type).toMatch(/^[a-z][a-z0-9-]+$/) // lowercase + dash
      expect(def.name.length).toBeGreaterThan(0)
      expect(['content', 'commerce', 'navigation', 'social']).toContain(def.category)
      expect(def.schema.name).toBe(def.name)
      expect(Array.isArray(def.schema.settings)).toBe(true)
    }
  })

  it('every schema setting has a valid type from the supported set', () => {
    const supported = new Set([
      'text', 'textarea', 'richtext', 'url', 'image_picker', 'video_url',
      'product', 'collection', 'page', 'blog', 'article',
      'select', 'radio', 'checkbox', 'range', 'number', 'color',
      'header', 'paragraph',
    ])
    for (const def of BUILTIN_SECTION_SCHEMAS) {
      for (const s of def.schema.settings) {
        expect(supported.has(s.type), `type ${s.type} on ${def.type}`).toBe(true)
      }
    }
  })

  it('block-based sections declare blocks[] with valid types', () => {
    for (const def of BUILTIN_SECTION_SCHEMAS) {
      if (!def.schema.blocks) continue
      expect(def.schema.blocks.length).toBeGreaterThan(0)
      for (const b of def.schema.blocks) {
        expect(b.type).toMatch(/^[a-z][a-z0-9-]+$/)
        expect(b.name.length).toBeGreaterThan(0)
      }
    }
  })

  it('every entry has at least one preset (so "Add section" works)', () => {
    for (const def of BUILTIN_SECTION_SCHEMAS) {
      expect(
        def.schema.presets && def.schema.presets.length > 0,
        `missing presets on ${def.type}`,
      ).toBe(true)
    }
  })
})

describe('ensureBuiltinSchemas', () => {
  function mockDb() {
    const calls: Array<{ values: any; conflictColumns?: string[]; updateSet?: any }> = []
    const db: any = {
      insertInto(_table: string) {
        const op: { values: any; conflictColumns?: string[]; updateSet?: any } = { values: undefined }
        calls.push(op)
        return {
          values(v: any) {
            op.values = v
            return this
          },
          onConflict(cb: any) {
            cb({
              columns(cols: string[]) {
                op.conflictColumns = cols
                return {
                  doUpdateSet(s: any) {
                    op.updateSet = s
                    return { execute: async () => undefined }
                  },
                }
              },
            })
            return { execute: async () => undefined }
          },
          execute: async () => undefined,
        }
      },
    }
    return { db, calls }
  }

  it('issues one INSERT per built-in schema', async () => {
    const { db, calls } = mockDb()
    await ensureBuiltinSchemas(db)
    expect(calls.length).toBe(BUILTIN_SECTION_SCHEMAS.length)
  })

  it('each call carries the right type + name + schema_json', async () => {
    const { db, calls } = mockDb()
    await ensureBuiltinSchemas(db)
    for (let i = 0; i < BUILTIN_SECTION_SCHEMAS.length; i++) {
      const expected = BUILTIN_SECTION_SCHEMAS[i]!
      const actual = calls[i]!
      expect(actual.values.type).toBe(expected.type)
      expect(actual.values.name).toBe(expected.name)
      expect(actual.values.is_builtin).toBe(true)
      expect(actual.values.schema_json).toEqual(expected.schema)
    }
  })

  it("onConflict targets [type] so re-seeding upserts (idempotent)", async () => {
    const { db, calls } = mockDb()
    await ensureBuiltinSchemas(db)
    for (const c of calls) {
      expect(c.conflictColumns).toEqual(['type'])
      expect(c.updateSet).toBeDefined()
      expect(c.updateSet.schema_json).toBeDefined()
    }
  })
})
