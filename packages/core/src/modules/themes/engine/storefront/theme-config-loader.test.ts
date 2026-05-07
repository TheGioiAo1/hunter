/**
 * Gbox Platform — prepareThemeConfig tests
 *
 * Decision #1 Step 1.15f. Covers the host helper that wires the
 * theme-config loaders to a TemplateLoader and the existing
 * I18nService, returning the bag the storefront router consumes.
 *
 * Coverage:
 *   1. Builds settings + schemaLocales from a complete theme tree
 *   2. Pushes storefront strings into the supplied I18nService
 *   3. Does NOT push schema strings into the i18n service
 *   4. Records defaultSchemaLocale from the .default.json marker
 *   5. Returns empty bag for a brand-new theme (no files)
 *   6. Aggregates warnings from settings + locale loaders
 *   7. Warns when i18n is supplied without shopId
 *   8. Skips i18n adapter when no i18n + no shopId is supplied
 *   9. Omits schemaLocales from the bag when no .schema.json files exist
 */

import { describe, expect, it } from 'vitest'
import { MemoryI18nService } from '../../../i18n/index.js'
import type { LoadResult, LogicalPath, TemplateLoader } from '../loader.js'
import { prepareThemeConfig } from './theme-config-loader.js'

class MapLoader implements TemplateLoader {
  readonly name = 'map-loader'
  constructor(private readonly files: Record<string, string>) {}
  async load(p: LogicalPath): Promise<string | null> {
    return this.files[p] ?? null
  }
  async loadWithMeta(p: LogicalPath): Promise<LoadResult | null> {
    const src = this.files[p]
    return src === undefined ? null : { source: src }
  }
  async exists(p: LogicalPath): Promise<boolean> {
    return p in this.files
  }
  async list(prefix = ''): Promise<LogicalPath[]> {
    return Object.keys(this.files).filter((k) => k.startsWith(prefix))
  }
}

const SCHEMA_SRC = JSON.stringify([
  { name: 'theme_info', theme_name: 'Acme' },
  {
    name: 'Colors',
    settings: [
      { type: 'color', id: 'primary', default: '#000' },
      { type: 'text', id: 'tagline', default: 'Welcome' },
    ],
  },
])

const DATA_SRC = JSON.stringify({
  current: { primary: '#aaa', tagline: 'Hello world' },
})

const EN_STORE = JSON.stringify({ general: { hello: 'Hi' } })
const VI_STORE = JSON.stringify({ general: { hello: 'Xin chào' } })
const EN_SCHEMA = JSON.stringify({
  sections: { hero: { name: 'Hero (en)' } },
})
const VI_SCHEMA = JSON.stringify({
  sections: { hero: { name: 'Hero (vi)' } },
})

describe('prepareThemeConfig', () => {
  it('builds settings + schemaLocales from a complete theme tree', async () => {
    const loader = new MapLoader({
      'config/settings_schema.json': SCHEMA_SRC,
      'config/settings_data.json': DATA_SRC,
      'locales/en.default.json': EN_STORE,
      'locales/en.default.schema.json': EN_SCHEMA,
      'locales/vi.json': VI_STORE,
      'locales/vi.schema.json': VI_SCHEMA,
    })
    const i18n = new MemoryI18nService()
    const result = await prepareThemeConfig({
      loader,
      i18n,
      shopId: 'shop_test',
    })

    expect(result.settings).toEqual({
      primary: '#aaa',
      tagline: 'Hello world',
    })
    expect(result.themeConfig.settings).toEqual(result.settings)
    expect(result.themeConfig.schemaLocales).toBeDefined()
    expect(result.themeConfig.schemaLocales!.en['sections.hero.name']).toBe(
      'Hero (en)',
    )
    expect(result.themeConfig.schemaLocales!.vi['sections.hero.name']).toBe(
      'Hero (vi)',
    )
    expect(result.themeConfig.defaultSchemaLocale).toBe('en')
    expect(result.warnings).toEqual([])
  })

  it('pushes storefront strings into the I18nService', async () => {
    const loader = new MapLoader({
      'config/settings_schema.json': SCHEMA_SRC,
      'locales/en.default.json': EN_STORE,
      'locales/vi.json': VI_STORE,
    })
    const i18n = new MemoryI18nService()
    await prepareThemeConfig({ loader, i18n, shopId: 'shop_test' })
    expect(
      await i18n.t('shop_test', 'general.hello', { locale: 'en' }),
    ).toBe('Hi')
    expect(
      await i18n.t('shop_test', 'general.hello', { locale: 'vi' }),
    ).toBe('Xin chào')
  })

  it('does NOT push schema strings into the I18nService', async () => {
    const loader = new MapLoader({
      'config/settings_schema.json': SCHEMA_SRC,
      'locales/en.default.json': EN_STORE,
      'locales/en.default.schema.json': EN_SCHEMA,
    })
    const i18n = new MemoryI18nService()
    await prepareThemeConfig({ loader, i18n, shopId: 'shop_test' })
    // Schema key should NOT resolve via the i18n service — i18n.t
    // returns the bare key on miss.
    expect(
      await i18n.t('shop_test', 'sections.hero.name', { locale: 'en' }),
    ).toBe('sections.hero.name')
  })

  it('returns empty bag for a brand-new theme (no files)', async () => {
    const loader = new MapLoader({})
    const result = await prepareThemeConfig({ loader })
    expect(result.themeConfig.settings).toBeUndefined()
    expect(result.themeConfig.schemaLocales).toBeUndefined()
    expect(result.themeConfig.defaultSchemaLocale).toBeNull()
    // Warning from the missing schema file.
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('aggregates warnings from both loaders', async () => {
    const loader = new MapLoader({
      // No schema → warning from settings loader.
      'locales/en.default.json': '{ broken json',
      'locales/vi.default.json': '{}', // second default → warning
    })
    const result = await prepareThemeConfig({ loader })
    expect(result.warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('warns when i18n is supplied without shopId', async () => {
    const loader = new MapLoader({
      'config/settings_schema.json': SCHEMA_SRC,
      'locales/en.default.json': EN_STORE,
    })
    const i18n = new MemoryI18nService()
    const result = await prepareThemeConfig({ loader, i18n })
    expect(result.warnings.some((w) => w.includes('shopId'))).toBe(true)
  })

  it('skips the i18n adapter when neither i18n nor shopId is supplied', async () => {
    const loader = new MapLoader({
      'config/settings_schema.json': SCHEMA_SRC,
      'locales/en.default.json': EN_STORE,
    })
    const result = await prepareThemeConfig({ loader })
    // No warnings about shopId.
    expect(result.warnings.some((w) => w.includes('shopId'))).toBe(false)
  })

  it('omits schemaLocales from the bag when no .schema.json files exist', async () => {
    const loader = new MapLoader({
      'config/settings_schema.json': SCHEMA_SRC,
      'locales/en.default.json': EN_STORE,
      'locales/vi.json': VI_STORE,
    })
    const result = await prepareThemeConfig({ loader })
    expect(result.themeConfig.schemaLocales).toBeUndefined()
    expect(result.themeConfig.defaultSchemaLocale).toBe('en')
  })
})
