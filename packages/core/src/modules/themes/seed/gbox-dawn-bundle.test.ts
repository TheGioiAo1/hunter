/**
 * Gbox Platform — Gbox Dawn bundle tests
 *
 * Decision #1 Step 1.17c. Validates the build-time generated bundle
 * has every Shopify-shaped path the engine + router rely on, plus
 * a handful of structural sanity checks (non-empty source, sensible
 * content type, no path traversal). The point is to catch a missing
 * file the moment it's deleted from the seed and the generator is
 * re-run, BEFORE a fresh shop install crashes at runtime.
 */

import { describe, expect, it } from 'vitest'
import {
  GBOX_DAWN_BUNDLE,
  GBOX_DAWN_BUNDLE_VERSION,
  filterGboxDawnAssetsByPrefix,
  gboxDawnBundleSize,
  getGboxDawnAsset,
  listGboxDawnAssets,
} from './gbox-dawn-bundle.js'

// ---------------------------------------------------------------------------
// Required keys — every path the engine, router and Shopify Dawn parity
// guarantees expect to find inside a freshly installed Gbox Dawn theme.
// ---------------------------------------------------------------------------

const REQUIRED_LAYOUT = ['layout/theme.liquid', 'layout/password.liquid']

const REQUIRED_TEMPLATES = [
  'templates/index.json',
  'templates/product.json',
  'templates/collection.json',
  'templates/list-collections.liquid',
  'templates/page.liquid',
  'templates/page.policy.liquid',
  'templates/cart.liquid',
  'templates/blog.liquid',
  'templates/article.liquid',
  'templates/search.liquid',
  'templates/404.liquid',
  'templates/500.liquid',
  'templates/password.liquid',
  'templates/gift_card.liquid',
  'templates/customers/login.liquid',
  'templates/customers/account.liquid',
]

const REQUIRED_SECTIONS = [
  'sections/header.liquid',
  'sections/footer.liquid',
  'sections/hero.liquid',
  'sections/featured-collection.liquid',
  'sections/image-with-text.liquid',
  'sections/newsletter.liquid',
  'sections/main-product.liquid',
  'sections/main-collection.liquid',
  'sections/main-list-collections.liquid',
  'sections/main-cart.liquid',
  'sections/main-page.liquid',
  'sections/main-policy.liquid',
  'sections/main-blog.liquid',
  'sections/main-article.liquid',
  'sections/main-search.liquid',
  'sections/main-404.liquid',
  'sections/main-password.liquid',
  'sections/main-gift-card.liquid',
  'sections/main-login.liquid',
  'sections/main-account.liquid',
]

const REQUIRED_SNIPPETS = [
  'snippets/product-card.liquid',
  'snippets/price.liquid',
  'snippets/pagination.liquid',
  'snippets/quantity-input.liquid',
  'snippets/icon-cart.liquid',
  'snippets/icon-account.liquid',
  'snippets/icon-search.liquid',
  'snippets/meta-tags.liquid',
  'snippets/breadcrumb.liquid',
]

const REQUIRED_ASSETS = [
  'assets/theme.css',
  'assets/theme.js',
  'assets/favicon.svg',
]

const REQUIRED_CONFIG = [
  'config/settings_schema.json',
  'config/settings_data.json',
]

const REQUIRED_LOCALES = [
  'locales/en.default.json',
  'locales/en.default.schema.json',
  'locales/vi.json',
  'locales/vi.schema.json',
]

const ALL_REQUIRED = [
  ...REQUIRED_LAYOUT,
  ...REQUIRED_TEMPLATES,
  ...REQUIRED_SECTIONS,
  ...REQUIRED_SNIPPETS,
  ...REQUIRED_ASSETS,
  ...REQUIRED_CONFIG,
  ...REQUIRED_LOCALES,
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GBOX_DAWN_BUNDLE — shape', () => {
  it('exports a non-empty Map', () => {
    expect(GBOX_DAWN_BUNDLE.size).toBeGreaterThan(0)
    expect(gboxDawnBundleSize()).toBe(GBOX_DAWN_BUNDLE.size)
  })

  it('declares a semver bundle version', () => {
    expect(GBOX_DAWN_BUNDLE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('contains every required key', () => {
    for (const key of ALL_REQUIRED) {
      expect(GBOX_DAWN_BUNDLE.has(key), `missing key: ${key}`).toBe(true)
    }
  })

  it('size matches the union of expected categories (no orphans)', () => {
    // This is intentionally exact — if you add a new asset to the seed,
    // bump REQUIRED_* above and the count will follow.
    expect(GBOX_DAWN_BUNDLE.size).toBe(ALL_REQUIRED.length)
  })
})

describe('GBOX_DAWN_BUNDLE — entry validation', () => {
  it('every entry has key/source/contentType strings', () => {
    for (const asset of GBOX_DAWN_BUNDLE.values()) {
      expect(typeof asset.key).toBe('string')
      expect(asset.key.length).toBeGreaterThan(0)
      expect(typeof asset.source).toBe('string')
      expect(asset.source.length).toBeGreaterThan(0)
      expect(typeof asset.contentType).toBe('string')
      expect(asset.contentType.length).toBeGreaterThan(0)
    }
  })

  it('keys never contain backslashes or .. segments', () => {
    for (const asset of GBOX_DAWN_BUNDLE.values()) {
      expect(asset.key.includes('\\')).toBe(false)
      expect(asset.key.split('/').includes('..')).toBe(false)
    }
  })

  it('liquid files report application/x-liquid', () => {
    for (const asset of GBOX_DAWN_BUNDLE.values()) {
      if (asset.key.endsWith('.liquid')) {
        expect(asset.contentType).toBe('application/x-liquid')
      }
    }
  })

  it('json files report application/json', () => {
    for (const asset of GBOX_DAWN_BUNDLE.values()) {
      if (asset.key.endsWith('.json')) {
        expect(asset.contentType).toBe('application/json')
      }
    }
  })

  it('css/js/svg files report sensible content types', () => {
    expect(getGboxDawnAsset('assets/theme.css')?.contentType).toBe('text/css')
    expect(getGboxDawnAsset('assets/theme.js')?.contentType).toBe(
      'application/javascript',
    )
    expect(getGboxDawnAsset('assets/favicon.svg')?.contentType).toBe(
      'image/svg+xml',
    )
  })
})

describe('GBOX_DAWN_BUNDLE — content sanity', () => {
  it('layout/theme.liquid renders the page chrome and content slot', () => {
    const layout = getGboxDawnAsset('layout/theme.liquid')!
    expect(layout.source).toContain('<!doctype html>')
    expect(layout.source).toContain('{{ content_for_header }}')
    expect(layout.source).toContain('{{ content_for_layout }}')
    expect(layout.source).toContain("{% section 'header' %}")
    expect(layout.source).toContain("{% section 'footer' %}")
  })

  it('templates/index.json declares the four homepage sections', () => {
    const index = getGboxDawnAsset('templates/index.json')!
    const parsed = JSON.parse(index.source) as {
      sections: Record<string, { type: string }>
      order: string[]
    }
    expect(parsed.order).toEqual([
      'hero',
      'featured-collection',
      'image-with-text',
      'newsletter',
    ])
    for (const id of parsed.order) {
      expect(parsed.sections[id]?.type).toBeTruthy()
    }
  })

  it('templates/product.json points at main-product', () => {
    const tpl = getGboxDawnAsset('templates/product.json')!
    const parsed = JSON.parse(tpl.source) as {
      sections: Record<string, { type: string }>
    }
    expect(parsed.sections.main?.type).toBe('main-product')
  })

  it('templates/collection.json points at main-collection', () => {
    const tpl = getGboxDawnAsset('templates/collection.json')!
    const parsed = JSON.parse(tpl.source) as {
      sections: Record<string, { type: string }>
    }
    expect(parsed.sections.main?.type).toBe('main-collection')
  })

  it('config/settings_schema.json is a JSON array starting with theme_info', () => {
    const cfg = getGboxDawnAsset('config/settings_schema.json')!
    const parsed = JSON.parse(cfg.source) as Array<{ name?: string; theme_name?: string }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0]?.theme_name).toBe('Gbox Dawn')
  })

  it('en + vi locale dicts share the same key shape', () => {
    const en = JSON.parse(getGboxDawnAsset('locales/en.default.json')!.source)
    const vi = JSON.parse(getGboxDawnAsset('locales/vi.json')!.source)
    expect(Object.keys(en).sort()).toEqual(Object.keys(vi).sort())
  })

  it('en.default.schema.json has settings_schema + sections branches', () => {
    const en = JSON.parse(
      getGboxDawnAsset('locales/en.default.schema.json')!.source,
    )
    expect(en.settings_schema).toBeDefined()
    expect(en.sections).toBeDefined()
    // The header schema in sections/header.liquid uses these refs:
    expect(en.sections.header?.name).toBeTruthy()
  })
})

describe('helpers', () => {
  it('listGboxDawnAssets returns sorted entries', () => {
    const list = listGboxDawnAssets()
    const sorted = [...list].sort((a, b) => a.key.localeCompare(b.key))
    expect(list).toEqual(sorted)
  })

  it('filterGboxDawnAssetsByPrefix narrows by directory', () => {
    const sections = filterGboxDawnAssetsByPrefix('sections/')
    expect(sections.length).toBe(REQUIRED_SECTIONS.length)
    for (const s of sections) {
      expect(s.key.startsWith('sections/')).toBe(true)
    }
  })

  it('getGboxDawnAsset returns undefined for unknown keys', () => {
    expect(getGboxDawnAsset('not/a/real/file.liquid')).toBeUndefined()
  })
})
