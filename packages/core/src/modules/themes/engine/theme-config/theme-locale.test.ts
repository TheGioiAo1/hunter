/**
 * Gbox Platform — Theme Locale loader + schema-translation tests
 *
 * Decision #1 Step 1.15c + 1.15d. Covers `parseLocaleFileName`,
 * `flattenLocaleTree`, `parseThemeLocaleFile`, `loadThemeLocales`,
 * `applyThemeLocalesToI18n`, and `resolveSchemaTranslations`.
 *
 * Coverage:
 *   1. parseLocaleFileName accepts the four canonical shapes
 *   2. parseLocaleFileName rejects unknown extensions
 *   3. parseLocaleFileName rejects empty stems
 *   4. parseLocaleFileName accepts locale tags with dashes (en-CA)
 *   5. flattenLocaleTree handles nested objects
 *   6. flattenLocaleTree handles arrays as indexed keys
 *   7. flattenLocaleTree coerces non-string leaves
 *   8. flattenLocaleTree skips null leaves
 *   9. parseThemeLocaleFile flattens correctly
 *  10. parseThemeLocaleFile throws on invalid JSON
 *  11. loadThemeLocales parses storefront + schema flavors per locale
 *  12. loadThemeLocales detects default-locale marker
 *  13. loadThemeLocales records a warning on multiple defaults
 *  14. loadThemeLocales records a warning on parse failure but continues
 *  15. loadThemeLocales skips nested files inside locales/
 *  16. applyThemeLocalesToI18n pushes only storefront strings
 *  17. resolveSchemaTranslations resolves a top-level t: string
 *  18. resolveSchemaTranslations walks nested objects
 *  19. resolveSchemaTranslations walks arrays
 *  20. resolveSchemaTranslations falls back to bare key for missing refs
 *  21. resolveSchemaTranslations preserves reference equality on no-op subtrees
 *  22. resolveSchemaTranslations leaves non-t strings unchanged
 */

import { describe, expect, it } from 'vitest'
import { MemoryI18nService } from '../../../i18n/index.js'
import type { TemplateLoader, LoadResult, LogicalPath } from '../loader.js'
import {
  applyThemeLocalesToI18n,
  flattenLocaleTree,
  loadThemeLocales,
  parseLocaleFileName,
  parseThemeLocaleFile,
  resolveSchemaTranslations,
  THEME_LOCALES_DIR,
} from './theme-locale.js'

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

describe('parseLocaleFileName', () => {
  it('parses the four canonical shapes', () => {
    expect(parseLocaleFileName('en.json')).toEqual({
      locale: 'en',
      flavor: 'storefront',
      isDefault: false,
    })
    expect(parseLocaleFileName('en.default.json')).toEqual({
      locale: 'en',
      flavor: 'storefront',
      isDefault: true,
    })
    expect(parseLocaleFileName('en.schema.json')).toEqual({
      locale: 'en',
      flavor: 'schema',
      isDefault: false,
    })
    expect(parseLocaleFileName('en.default.schema.json')).toEqual({
      locale: 'en',
      flavor: 'schema',
      isDefault: true,
    })
  })

  it('rejects non-json extensions', () => {
    expect(parseLocaleFileName('en.yaml')).toBeNull()
    expect(parseLocaleFileName('readme.md')).toBeNull()
  })

  it('rejects empty stems', () => {
    expect(parseLocaleFileName('.json')).toBeNull()
  })

  it('accepts dash-separated locale tags', () => {
    expect(parseLocaleFileName('en-CA.default.json')).toEqual({
      locale: 'en-CA',
      flavor: 'storefront',
      isDefault: true,
    })
  })
})

describe('flattenLocaleTree', () => {
  it('flattens nested objects to dot keys', () => {
    expect(
      flattenLocaleTree({ cart: { title: 'Cart', subtotal: 'Sub' } }),
    ).toEqual({
      'cart.title': 'Cart',
      'cart.subtotal': 'Sub',
    })
  })

  it('flattens arrays to indexed keys', () => {
    expect(flattenLocaleTree({ tags: ['a', 'b', 'c'] })).toEqual({
      'tags.0': 'a',
      'tags.1': 'b',
      'tags.2': 'c',
    })
  })

  it('coerces non-string leaves', () => {
    expect(flattenLocaleTree({ count: 5, on: true })).toEqual({
      count: '5',
      on: 'true',
    })
  })

  it('skips null leaves', () => {
    expect(flattenLocaleTree({ a: 'x', b: null })).toEqual({ a: 'x' })
  })
})

describe('parseThemeLocaleFile', () => {
  it('parses + flattens', () => {
    const dict = parseThemeLocaleFile(
      JSON.stringify({ general: { hello: 'Hi' } }),
      'en.json',
    )
    expect(dict['general.hello']).toBe('Hi')
  })

  it('throws on invalid JSON', () => {
    expect(() => parseThemeLocaleFile('{', 'en.json')).toThrow(/invalid JSON/)
  })
})

describe('loadThemeLocales', () => {
  it('parses storefront + schema flavors per locale', async () => {
    const loader = new MapLoader({
      'locales/en.default.json': JSON.stringify({
        general: { hello: 'Hi' },
      }),
      'locales/en.default.schema.json': JSON.stringify({
        sections: { hero: { name: 'Hero' } },
      }),
      'locales/vi.json': JSON.stringify({ general: { hello: 'Xin chào' } }),
      'locales/vi.schema.json': JSON.stringify({
        sections: { hero: { name: 'Hùng' } },
      }),
    })
    const result = await loadThemeLocales(loader)
    expect(result.warnings).toEqual([])
    expect(result.defaultLocale).toBe('en')
    expect(result.byLocale.en.storefront['general.hello']).toBe('Hi')
    expect(result.byLocale.en.schema['sections.hero.name']).toBe('Hero')
    expect(result.byLocale.vi.storefront['general.hello']).toBe('Xin chào')
    expect(result.byLocale.vi.schema['sections.hero.name']).toBe('Hùng')
  })

  it('warns on multiple default markers', async () => {
    const loader = new MapLoader({
      'locales/en.default.json': '{}',
      'locales/vi.default.json': '{}',
    })
    const result = await loadThemeLocales(loader)
    // First wins.
    expect(result.defaultLocale).toBe('en')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/multiple/)
  })

  it('records a warning on parse failure but continues', async () => {
    const loader = new MapLoader({
      'locales/en.default.json': '{ broken',
      'locales/vi.json': JSON.stringify({ ok: 'yes' }),
    })
    const result = await loadThemeLocales(loader)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/invalid JSON/)
    // The vi file still loaded.
    expect(result.byLocale.vi.storefront.ok).toBe('yes')
  })

  it('skips files in nested subdirectories', async () => {
    const loader = new MapLoader({
      'locales/en.json': JSON.stringify({ ok: 'top' }),
      'locales/sub/en.json': JSON.stringify({ ok: 'nested' }),
    })
    const result = await loadThemeLocales(loader)
    expect(result.byLocale.en.storefront.ok).toBe('top')
    expect(Object.keys(result.byLocale)).toEqual(['en'])
  })

  it('finds files using the THEME_LOCALES_DIR constant', async () => {
    const loader = new MapLoader({
      [`${THEME_LOCALES_DIR}en.json`]: JSON.stringify({ a: 'b' }),
    })
    const result = await loadThemeLocales(loader)
    expect(result.byLocale.en.storefront.a).toBe('b')
  })
})

describe('applyThemeLocalesToI18n', () => {
  it('pushes only storefront strings', async () => {
    const i18n = new MemoryI18nService()
    await applyThemeLocalesToI18n(i18n, 'shop_test', {
      defaultLocale: 'en',
      warnings: [],
      byLocale: {
        en: {
          storefront: { 'cart.title': 'Cart' },
          schema: { 'sections.hero.name': 'Hero' },
        },
        vi: {
          storefront: { 'cart.title': 'Giỏ hàng' },
          schema: {},
        },
      },
    })
    // Storefront strings landed in the i18n service.
    expect(
      await i18n.t('shop_test', 'cart.title', { locale: 'en' }),
    ).toBe('Cart')
    expect(
      await i18n.t('shop_test', 'cart.title', { locale: 'vi' }),
    ).toBe('Giỏ hàng')
    // Schema strings did NOT land in the i18n service (would resolve
    // to the bare key, which equals 'sections.hero.name').
    expect(
      await i18n.t('shop_test', 'sections.hero.name', { locale: 'en' }),
    ).toBe('sections.hero.name')
  })

  it('skips locales with no storefront strings', async () => {
    const i18n = new MemoryI18nService()
    await applyThemeLocalesToI18n(i18n, 'shop_test', {
      defaultLocale: 'en',
      warnings: [],
      byLocale: {
        en: { storefront: {}, schema: { 'a.b': 'A B' } },
      },
    })
    // Nothing in the service for `en`.
    expect(await i18n.preload('shop_test', 'en')).toEqual({})
  })
})

describe('resolveSchemaTranslations', () => {
  const dict = {
    'sections.hero.name': 'Hero',
    'sections.hero.label': 'Hero label',
  }

  it('resolves a top-level t: string', () => {
    expect(resolveSchemaTranslations('t:sections.hero.name', dict)).toBe(
      'Hero',
    )
  })

  it('walks nested objects', () => {
    const out = resolveSchemaTranslations(
      {
        name: 't:sections.hero.name',
        settings: [{ label: 't:sections.hero.label' }],
      },
      dict,
    )
    expect(out).toEqual({
      name: 'Hero',
      settings: [{ label: 'Hero label' }],
    })
  })

  it('walks arrays', () => {
    expect(
      resolveSchemaTranslations(
        ['t:sections.hero.name', 'static', 't:sections.hero.label'],
        dict,
      ),
    ).toEqual(['Hero', 'static', 'Hero label'])
  })

  it('falls back to the bare key for missing refs', () => {
    expect(resolveSchemaTranslations('t:does.not.exist', dict)).toBe(
      'does.not.exist',
    )
  })

  it('preserves reference equality on no-op subtrees', () => {
    const subtree = { a: 'no refs', b: { c: 'plain' } }
    const out = resolveSchemaTranslations(
      { wrapper: subtree, label: 't:sections.hero.name' },
      dict,
    ) as { wrapper: typeof subtree; label: string }
    // The wrapper's `wrapper` field should be the same reference.
    expect(out.wrapper).toBe(subtree)
    expect(out.label).toBe('Hero')
  })

  it('leaves non-t strings unchanged', () => {
    expect(resolveSchemaTranslations('plain text', dict)).toBe('plain text')
    expect(resolveSchemaTranslations(42, dict)).toBe(42)
    expect(resolveSchemaTranslations(null, dict)).toBeNull()
  })
})
