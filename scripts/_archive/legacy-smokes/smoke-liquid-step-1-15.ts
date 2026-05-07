/**
 * Smoke test — Decision #1 Step 1.15 Theme Settings + Locale files
 *
 * End-to-end smoke test that exercises an in-memory theme containing:
 *   - config/settings_schema.json (theme_info + a Colors section)
 *   - config/settings_data.json   (a "current" preset reference)
 *   - locales/en.default.json     (storefront strings)
 *   - locales/en.default.schema.json (schema labels for the editor)
 *   - locales/vi.json             (storefront strings)
 *   - locales/vi.schema.json      (vi schema labels)
 *   - sections/hero.liquid        (uses {{ section.settings.heading }}
 *                                  whose default is `t:hero.heading`)
 *   - templates/index.liquid      (renders {{ settings.primary }} +
 *                                  the hero section)
 *
 * What we assert (16):
 *   1. prepareThemeConfig builds a complete bag (settings + schemaLocales)
 *   2. Default locale is detected from `<locale>.default.json`
 *   3. Storefront strings made it into the I18nService
 *   4. Schema strings did NOT make it into the I18nService
 *   5. renderPage exposes settings.primary via {{ settings.* }}
 *   6. Section default value resolves t: refs at render time (en)
 *   7. Section default value resolves t: refs (vi) when locale flips
 *   8. Router exposes settings on the index template
 *   9. Router resolves t: refs in section schemas via en locale prefix
 *  10. Router resolves t: refs via vi locale prefix
 *  11. Missing schema dict → t: refs render as bare keys (no crash)
 *  12. Format A settings_data (preset name) round-trips through
 *  13. Format B settings_data (inline current object) overrides preset
 *  14. Bad preset name in current falls back to schema defaults + warning
 *  15. Brand-new theme (no config files) → empty drop, no crash
 *  16. Multiple .default markers produces a warning + first wins
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-15.ts
 */

import {
  createLiquidEngine,
  handleStorefrontRequest,
  loadThemeLocales,
  loadThemeSettings,
  MemoryDataSource,
  prepareThemeConfig,
  resolveThemeSettings,
  type LoadResult,
  type LogicalPath,
  type StorefrontHandlerOptions,
  type StorefrontRequestContext,
  type TemplateLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

// ---------------------------------------------------------------------------
// In-memory loader
// ---------------------------------------------------------------------------

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory-theme'
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

// ---------------------------------------------------------------------------
// Theme files
// ---------------------------------------------------------------------------

const SETTINGS_SCHEMA = JSON.stringify([
  { name: 'theme_info', theme_name: 'Acme', theme_version: '1.0.0' },
  {
    name: 'Colors',
    settings: [
      { type: 'color', id: 'primary', default: '#000000', label: 't:colors.primary' },
      { type: 'text', id: 'tagline', default: 'Welcome', label: 't:colors.tagline' },
    ],
  },
])

const SETTINGS_DATA_PRESET = JSON.stringify({
  current: 'Default',
  presets: {
    Default: { primary: '#ff0099', tagline: 'Hello world' },
    Alt: { primary: '#000000', tagline: 'Alt' },
  },
})

const SETTINGS_DATA_INLINE = JSON.stringify({
  current: { primary: '#aabbcc', tagline: 'Inline wins' },
  presets: { Default: { primary: '#ffffff' } },
})

const SETTINGS_DATA_BAD_PRESET = JSON.stringify({
  current: 'NoSuchPreset',
  presets: { Default: { primary: '#xxxxxx' } },
})

const EN_STORE = JSON.stringify({
  general: { hello: 'Hi there', cart: { title: 'Cart' } },
})
const VI_STORE = JSON.stringify({
  general: { hello: 'Xin chào', cart: { title: 'Giỏ hàng' } },
})
const EN_SCHEMA = JSON.stringify({
  hero: { heading: 'Welcome aboard' },
  colors: { primary: 'Primary color', tagline: 'Site tagline' },
})
const VI_SCHEMA = JSON.stringify({
  hero: { heading: 'Hân hạnh chào đón' },
  colors: { primary: 'Màu chính', tagline: 'Khẩu hiệu' },
})

const FULL_THEME: Record<string, string> = {
  'config/settings_schema.json': SETTINGS_SCHEMA,
  'config/settings_data.json': SETTINGS_DATA_PRESET,
  'locales/en.default.json': EN_STORE,
  'locales/en.default.schema.json': EN_SCHEMA,
  'locales/vi.json': VI_STORE,
  'locales/vi.schema.json': VI_SCHEMA,
  'layout/theme.liquid':
    '<!doctype html><html lang="{{ request.locale }}"><body>{{ content_for_layout }}</body></html>',
  'templates/index.liquid':
    '<h1>{{ settings.tagline }}</h1>' +
    '<p style="color: {{ settings.primary }}">{{ shop.name }}</p>' +
    "{% section 'hero' %}",
  'sections/hero.liquid':
    '{% schema %}{"name":"Hero","settings":[' +
    '{"type":"text","id":"heading","default":"t:hero.heading","label":"t:hero.heading"}' +
    ']}{% endschema %}' +
    '<section class="hero">{{ section.settings.heading }}</section>',
  'templates/404.liquid': '<h1>404</h1>',
  'templates/500.liquid': '<h1>500</h1>',
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`  \u2713 ${name}`)
  } else {
    failed++
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}
function expectContains(haystack: string, needle: string, label: string): void {
  check(label, haystack.includes(needle), `expected to contain "${needle}"`)
}

function mkReq(
  path: string,
  overrides: Partial<StorefrontRequestContext> = {},
): StorefrontRequestContext {
  return {
    method: 'GET',
    path,
    query: {},
    headers: {},
    cookies: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Smoke \u2014 Step 1.15 Theme Settings + Locale Files')
  console.log('=================================================')

  // ---- 1. prepareThemeConfig builds the bag -----------------------------
  {
    const loader = new MemoryLoader(FULL_THEME)
    const i18n = new MemoryI18nService()
    const result = await prepareThemeConfig({
      loader,
      i18n,
      shopId: 'shop_smoke',
    })
    check(
      '1. prepareThemeConfig populates settings',
      result.themeConfig.settings?.primary === '#ff0099' &&
        result.themeConfig.settings?.tagline === 'Hello world',
    )
    check(
      '1. prepareThemeConfig populates schemaLocales for en + vi',
      !!result.themeConfig.schemaLocales?.en &&
        !!result.themeConfig.schemaLocales?.vi,
    )

    // 2. Default locale detection
    check(
      '2. defaultSchemaLocale === "en" (from .default marker)',
      result.themeConfig.defaultSchemaLocale === 'en',
    )

    // 3. Storefront strings landed in i18n
    const enHello = await i18n.t('shop_smoke', 'general.hello', {
      locale: 'en',
    })
    const viHello = await i18n.t('shop_smoke', 'general.hello', {
      locale: 'vi',
    })
    check(
      '3. storefront strings reach the i18n service',
      enHello === 'Hi there' && viHello === 'Xin chào',
    )

    // 4. Schema strings stayed OUT of the i18n service
    const schemaProbe = await i18n.t('shop_smoke', 'hero.heading', {
      locale: 'en',
    })
    check(
      '4. schema strings are NOT pushed into the i18n service',
      schemaProbe === 'hero.heading',
    )
  }

  // ---- 5. renderPage exposes settings.primary ---------------------------
  {
    const loader = new MemoryLoader(FULL_THEME)
    const settingsResult = await loadThemeSettings(loader)
    const localesResult = await loadThemeLocales(loader)

    const engine = createLiquidEngine({
      loader,
      i18n: new MemoryI18nService(),
    })
    // Direct renderPage path (sanity).
    const { renderPage } = await import(
      '../packages/core/src/modules/themes/engine/pipeline.js'
    )
    const out = await renderPage(engine, {
      template: 'index',
      shop: { name: 'Acme' },
      themeSettings: settingsResult.settings,
      schemaLocaleDict: localesResult.byLocale.en?.schema,
    })
    expectContains(out.html, 'color: #ff0099', '5. settings.primary in template')
    expectContains(out.html, 'Hello world', '5. settings.tagline rendered')
    expectContains(out.html, 'Acme', '5. shop drop visible alongside settings')

    // 6. t: ref in section schema resolved (en)
    expectContains(
      out.html,
      'Welcome aboard',
      '6. t:hero.heading resolves via en schema dict',
    )

    // 7. t: ref via vi
    const viOut = await renderPage(engine, {
      template: 'index',
      shop: { name: 'Acme' },
      themeSettings: settingsResult.settings,
      schemaLocaleDict: localesResult.byLocale.vi?.schema,
    })
    expectContains(
      viOut.html,
      'Hân hạnh chào đón',
      '7. t:hero.heading resolves via vi schema dict',
    )
  }

  // ---- 8-11. Router end-to-end ------------------------------------------
  {
    const loader = new MemoryLoader(FULL_THEME)
    const i18n = new MemoryI18nService()
    const themeConfigResult = await prepareThemeConfig({
      loader,
      i18n,
      shopId: 'shop_smoke',
    })
    const engine = createLiquidEngine({ loader, i18n })
    const opts: StorefrontHandlerOptions = {
      engine,
      datasource: new MemoryDataSource({
        shop: { id: 'shop_smoke', name: 'Acme' },
      }),
      locales: { supported: ['en', 'vi'], default: 'en' },
      themeConfig: themeConfigResult.themeConfig,
    }

    // 8. Settings on the index template
    const enRes = await handleStorefrontRequest(opts, mkReq('/'))
    check('8. router success status', enRes.status === 200)
    expectContains(enRes.body, 'color: #ff0099', '8. settings.primary in router output')

    // 9. en t: ref via router
    expectContains(
      enRes.body,
      'Welcome aboard',
      '9. router resolves t: refs in en',
    )

    // 10. vi t: ref via router (locale prefix)
    const viRes = await handleStorefrontRequest(opts, mkReq('/vi/'))
    check(
      '10. router renders vi locale',
      viRes.status === 200 && viRes.headers['content-language'] === 'vi',
    )
    expectContains(
      viRes.body,
      'Hân hạnh chào đón',
      '10. router resolves t: refs in vi',
    )

    // 11. Missing schema dict — bare key fallback
    const optsNoConfig: StorefrontHandlerOptions = {
      ...opts,
      themeConfig: undefined,
    }
    const bareRes = await handleStorefrontRequest(optsNoConfig, mkReq('/'))
    check('11. router still serves 200 with no themeConfig', bareRes.status === 200)
    expectContains(
      bareRes.body,
      't:hero.heading',
      '11. bare t: key visible when no schemaLocaleDict',
    )
  }

  // ---- 12. Format A settings_data (preset name) -------------------------
  {
    const loader = new MemoryLoader({
      ...FULL_THEME,
      'config/settings_data.json': SETTINGS_DATA_PRESET,
    })
    const result = await loadThemeSettings(loader)
    check(
      '12. Format A — current="Default" resolves to preset',
      result.settings.primary === '#ff0099' &&
        result.settings.tagline === 'Hello world',
    )
  }

  // ---- 13. Format B settings_data (inline current) ----------------------
  {
    const loader = new MemoryLoader({
      ...FULL_THEME,
      'config/settings_data.json': SETTINGS_DATA_INLINE,
    })
    const result = await loadThemeSettings(loader)
    check(
      '13. Format B — current{} overrides preset',
      result.settings.primary === '#aabbcc' &&
        result.settings.tagline === 'Inline wins',
    )
  }

  // ---- 14. Bad preset name → warning + schema defaults ------------------
  {
    const loader = new MemoryLoader({
      ...FULL_THEME,
      'config/settings_data.json': SETTINGS_DATA_BAD_PRESET,
    })
    const result = await loadThemeSettings(loader)
    // Falls back to schema defaults.
    check(
      '14. bad preset → schema defaults',
      result.settings.primary === '#000000' &&
        result.settings.tagline === 'Welcome',
    )
    check(
      '14. bad preset → warning recorded',
      result.warnings.some((w) => w.includes('NoSuchPreset')),
    )
  }

  // ---- 15. Brand-new theme (no config) ----------------------------------
  {
    const loader = new MemoryLoader({
      'layout/theme.liquid': '{{ content_for_layout }}',
      'templates/index.liquid': 'idx',
    })
    const result = await prepareThemeConfig({ loader })
    check(
      '15. brand-new theme → empty bag, no crash',
      result.themeConfig.settings === undefined &&
        result.themeConfig.schemaLocales === undefined,
    )
    check(
      '15. brand-new theme → warnings include missing schema',
      result.warnings.length > 0,
    )
  }

  // ---- 16. Multiple .default markers ------------------------------------
  {
    const loader = new MemoryLoader({
      'locales/en.default.json': '{}',
      'locales/vi.default.json': '{}',
    })
    const result = await loadThemeLocales(loader)
    check(
      '16. multiple .default markers → first wins',
      result.defaultLocale === 'en',
    )
    check(
      '16. multiple .default markers → warning recorded',
      result.warnings.some((w) => w.includes('multiple')),
    )
  }

  // ---- 17. Sanity check on the settings resolver alone ------------------
  // (Counted under 16 in the header but a quick assertion that we
  // don't drop the theme_info section into the drop.)
  {
    const result = resolveThemeSettings(
      [
        { name: 'theme_info', theme_name: 'Acme' },
        {
          name: 'X',
          settings: [{ type: 'text', id: 'a', default: 'A' }],
        },
      ],
      undefined,
    )
    check(
      '17. theme_info section is filtered from the drop',
      !('theme_name' in result.settings) && result.settings.a === 'A',
    )
  }

  // ---- Summary ----------------------------------------------------------
  console.log('=================================================')
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
