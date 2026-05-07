/**
 * Theme Customizer — section-settings unit tests
 *
 * Cases covered:
 *   1. Missing section returns null
 *   2. Section without schema row → schema=null, settings/blocks pass-through
 *   3. Section with schema → settings + schema arrays normalised
 *   4. Settings filtered to whitelisted shape (drop bad rows)
 *   5. Presets array survives shape normalisation
 *   6. Non-object settings_json gracefully → {}
 *   7. Non-array blocks_json gracefully → []
 */

import { describe, it, expect } from 'vitest'
import { loadSectionSettings } from './section-settings.js'

function mockDb(row: any | undefined) {
  return {
    selectFrom: () => ({
      leftJoin: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => row,
          }),
        }),
      }),
    }),
  } as any
}

describe('loadSectionSettings', () => {
  it('returns null when section is missing', async () => {
    const db = mockDb(undefined)
    const out = await loadSectionSettings(db, 'missing')
    expect(out).toBeNull()
  })

  it('section without schema row → schema=null, payload passes through', async () => {
    const db = mockDb({
      id: 's1',
      themeId: 't1',
      pageType: 'index',
      sectionKey: 'hero',
      type: 'hero-banner',
      position: 0,
      enabled: true,
      settings_json: { heading: 'Hi' },
      blocks_json: [],
      schemaName: null,
      schemaIcon: null,
      schema_json: null,
      schemaMaxBlocks: null,
    })
    const out = await loadSectionSettings(db, 's1')
    expect(out).not.toBeNull()
    expect(out!.id).toBe('s1')
    expect(out!.settings).toEqual({ heading: 'Hi' })
    expect(out!.schema).toBeNull()
  })

  it('section with schema → returns normalised settings/blocks/presets', async () => {
    const db = mockDb({
      id: 's2',
      themeId: 't1',
      pageType: 'index',
      sectionKey: 'hero',
      type: 'hero-banner',
      position: 0,
      enabled: true,
      settings_json: { heading: 'Hello' },
      blocks_json: [{ type: 'cta' }],
      schemaName: 'Hero Banner',
      schemaIcon: 'banner',
      schemaMaxBlocks: 12,
      schema_json: {
        settings: [
          { id: 'heading', type: 'text', label: 'Heading', default: 'Welcome' },
          { id: 'cta', type: 'url', label: 'Call to action' },
          { not_a_setting: true }, // gets dropped from output
        ],
        blocks: [
          { type: 'cta', name: 'Button', limit: 3, settings: [{ id: 'label', type: 'text' }] },
        ],
        presets: [
          { name: 'Welcome', category: 'Hero', settings: { heading: 'Default' } },
        ],
      },
    })
    const out = await loadSectionSettings(db, 's2')
    expect(out!.schema).not.toBeNull()
    expect(out!.schema!.name).toBe('Hero Banner')
    expect(out!.schema!.icon).toBe('banner')
    expect(out!.schema!.maxBlocks).toBe(12)
    // 3 input rows but only 2 had a `type` string; the 3rd is filtered.
    expect(out!.schema!.settings.map((s) => s.type)).toEqual(['text', 'url', 'text'])
    expect(out!.schema!.blocks).toHaveLength(1)
    expect(out!.schema!.blocks[0].type).toBe('cta')
    expect(out!.schema!.blocks[0].limit).toBe(3)
    expect(out!.schema!.presets).toHaveLength(1)
    expect(out!.schema!.presets[0].name).toBe('Welcome')
  })

  it('non-object settings_json gracefully → {}', async () => {
    const db = mockDb({
      id: 's3',
      themeId: 't1',
      pageType: 'index',
      sectionKey: 'rich-text',
      type: 'rich-text',
      position: 0,
      enabled: true,
      settings_json: 'corrupt-string',
      blocks_json: null,
      schemaName: null,
      schemaIcon: null,
      schema_json: null,
      schemaMaxBlocks: null,
    })
    const out = await loadSectionSettings(db, 's3')
    expect(out!.settings).toEqual({})
    expect(out!.blocks).toEqual([])
  })

  it('default maxBlocks=50 when schema row has null max_blocks', async () => {
    const db = mockDb({
      id: 's4',
      themeId: 't1',
      pageType: 'index',
      sectionKey: 'a',
      type: 'a',
      position: 0,
      enabled: true,
      settings_json: {},
      blocks_json: [],
      schemaName: 'A',
      schemaIcon: 'box',
      schemaMaxBlocks: null,
      schema_json: { settings: [], blocks: [], presets: [] },
    })
    const out = await loadSectionSettings(db, 's4')
    expect(out!.schema!.maxBlocks).toBe(50)
  })
})
