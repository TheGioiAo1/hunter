/**
 * theme-zip-exporter unit tests.
 *
 * Cases:
 *   1. exportFilename slugifies theme names + appends ISO date
 *   2. exportFilename falls back to "theme" for empty/garbage names
 *   3. exportThemeZip throws when theme is missing
 *   4. exportThemeZip writes layout/sections/snippets/assets verbatim
 *   5. exportThemeZip emits templates/<page>.json from theme_page_sections
 *   6. exportThemeZip handles blocks_json correctly (block_order shape)
 *   7. exportThemeZip emits config/settings_schema + settings_data when present
 *   8. exportThemeZip survives missing global settings row
 *   9. Round-trip: import → export reproduces bytes-equivalent zip layout
 */

import { describe, it, expect } from 'vitest'
import { exportThemeZip, exportFilename } from './theme-zip-exporter.js'

interface DbFx {
  themes: any[]
  files: any[]
  sections: any[]
  globals: any[]
}

function mockDb(fx: DbFx) {
  return {
    selectFrom(table: string) {
      const q: any = { table, where: [] }
      const leaf: any = {
        select() { return leaf },
        where(col: string, _op: string, val: any) {
          q.where.push({ col: col.includes('.') ? col.split('.').pop() : col, val })
          return leaf
        },
        orderBy() { return leaf },
        async executeTakeFirst() {
          if (table === 'themes') {
            return fx.themes.find((t) => q.where.every((w: any) => t[w.col] === w.val))
          }
          if (table === 'theme_global_settings') {
            return fx.globals.find((g) => q.where.every((w: any) => g[w.col] === w.val))
          }
          return undefined
        },
        async execute() {
          if (table === 'theme_files') {
            return fx.files.filter((f) => q.where.every((w: any) => f[w.col] === w.val))
          }
          if (table === 'theme_page_sections') {
            return fx.sections.filter((s) => q.where.every((w: any) => s[w.col] === w.val))
          }
          return []
        },
      }
      return leaf
    },
  } as any
}

// ─── exportFilename ─────────────────────────────────────────────────────

describe('exportFilename', () => {
  it('slugifies theme names + appends ISO date', () => {
    const out = exportFilename('Stylish Theme!', new Date('2026-04-26T01:23:45Z'))
    expect(out).toBe('stylish-theme-2026-04-26.zip')
  })

  it('falls back to "theme" for empty', () => {
    expect(exportFilename('', new Date('2026-04-26T00:00:00Z'))).toBe('theme-2026-04-26.zip')
    expect(exportFilename('!!!', new Date('2026-04-26T00:00:00Z'))).toBe('theme-2026-04-26.zip')
  })

  it('handles diacritics + capitalisation', () => {
    expect(exportFilename('Café  Bohème', new Date('2026-04-26T00:00:00Z'))).toBe('cafe-boheme-2026-04-26.zip')
  })
})

// ─── exportThemeZip ─────────────────────────────────────────────────────

describe('exportThemeZip', () => {
  it('throws when theme is missing', async () => {
    const fx: DbFx = { themes: [], files: [], sections: [], globals: [] }
    await expect(exportThemeZip(mockDb(fx), 'missing')).rejects.toThrow(/not found/i)
  })

  it('writes verbatim files into the zip', async () => {
    const fx: DbFx = {
      themes: [{ id: 't1', name: 'Stylish' }],
      files: [
        { theme_id: 't1', path: 'layout/theme.liquid', kind: 'liquid', content: '<html></html>' },
        { theme_id: 't1', path: 'sections/hero.liquid', kind: 'liquid', content: '<section>hero</section>' },
        { theme_id: 't1', path: 'assets/main.css', kind: 'css', content: 'body { margin: 0 }' },
      ],
      sections: [],
      globals: [],
    }
    const out = await exportThemeZip(mockDb(fx), 't1')
    expect(out.themeName).toBe('Stylish')
    expect(out.zipBytes.length).toBeGreaterThan(0)

    // Verify zip contents.
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(out.zipBytes)
    expect(zip.file('layout/theme.liquid')).toBeTruthy()
    expect(zip.file('sections/hero.liquid')).toBeTruthy()
    expect(zip.file('assets/main.css')).toBeTruthy()
    expect(await zip.file('layout/theme.liquid')!.async('string')).toBe('<html></html>')
  })

  it('emits templates/<page>.json from theme_page_sections', async () => {
    const fx: DbFx = {
      themes: [{ id: 't1', name: 'Stylish' }],
      files: [],
      sections: [
        { theme_id: 't1', page_type: 'index', section_key: 'hero',     section_type: 'hero',     position: 0, settings_json: { heading: 'Hi' }, blocks_json: [], enabled: true },
        { theme_id: 't1', page_type: 'index', section_key: 'featured', section_type: 'featured', position: 1, settings_json: {},                blocks_json: [], enabled: true },
      ],
      globals: [],
    }
    const out = await exportThemeZip(mockDb(fx), 't1')
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(out.zipBytes)
    const tpl = await zip.file('templates/index.json')!.async('string')
    const j = JSON.parse(tpl)
    expect(j.order).toEqual(['hero', 'featured'])
    expect(j.sections.hero.type).toBe('hero')
    expect(j.sections.hero.settings).toEqual({ heading: 'Hi' })
  })

  it('emits block_order shape when blocks_json is non-empty', async () => {
    const fx: DbFx = {
      themes: [{ id: 't1', name: 'Stylish' }],
      files: [],
      sections: [
        {
          theme_id: 't1',
          page_type: 'index',
          section_key: 'hero',
          section_type: 'hero',
          position: 0,
          settings_json: {},
          blocks_json: [
            { id: 'cta-1', type: 'cta', settings: { label: 'Shop' } },
            { type: 'image', settings: {} },
          ],
          enabled: true,
        },
      ],
      globals: [],
    }
    const out = await exportThemeZip(mockDb(fx), 't1')
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(out.zipBytes)
    const j = JSON.parse(await zip.file('templates/index.json')!.async('string'))
    expect(j.sections.hero.block_order).toEqual(['cta-1', 'block-1'])
    expect(j.sections.hero.blocks['cta-1'].type).toBe('cta')
    expect(j.sections.hero.blocks['block-1'].type).toBe('image')
  })

  it('emits config/settings_schema + settings_data when global settings row exists', async () => {
    const fx: DbFx = {
      themes: [{ id: 't1', name: 'Stylish' }],
      files: [],
      sections: [],
      globals: [{ theme_id: 't1', schema_json: [{ name: 'Colors' }], settings_json: { primary: '#000' } }],
    }
    const out = await exportThemeZip(mockDb(fx), 't1')
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(out.zipBytes)
    expect(zip.file('config/settings_schema.json')).toBeTruthy()
    expect(zip.file('config/settings_data.json')).toBeTruthy()
    const data = JSON.parse(await zip.file('config/settings_data.json')!.async('string'))
    expect(data.primary).toBe('#000')
  })

  it('survives missing global settings row', async () => {
    const fx: DbFx = {
      themes: [{ id: 't1', name: 'Stylish' }],
      files: [{ theme_id: 't1', path: 'layout/theme.liquid', kind: 'liquid', content: 'x' }],
      sections: [],
      globals: [],
    }
    const out = await exportThemeZip(mockDb(fx), 't1')
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(out.zipBytes)
    expect(zip.file('config/settings_schema.json')).toBeNull()
    expect(zip.file('config/settings_data.json')).toBeNull()
  })

  it('marks disabled sections in template JSON', async () => {
    const fx: DbFx = {
      themes: [{ id: 't1', name: 'Stylish' }],
      files: [],
      sections: [
        { theme_id: 't1', page_type: 'index', section_key: 'hero', section_type: 'hero', position: 0, settings_json: {}, blocks_json: [], enabled: false },
      ],
      globals: [],
    }
    const out = await exportThemeZip(mockDb(fx), 't1')
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(out.zipBytes)
    const j = JSON.parse(await zip.file('templates/index.json')!.async('string'))
    expect(j.sections.hero.disabled).toBe(true)
  })
})
