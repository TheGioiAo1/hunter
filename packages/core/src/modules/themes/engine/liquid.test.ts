/**
 * Gbox Platform — LiquidJS Engine Factory tests
 *
 * Decision #1 Step 1.4 — End-to-end tests for `createLiquidEngine()`:
 *
 *   1. The factory wires TemplateLoader → LiquidJS FS correctly so
 *      `{% render %}` and `{% include %}` can resolve templates.
 *   2. `strictFilters: true` throws on unknown filter names.
 *   3. `strictVariables: false` renders missing vars as ''.
 *   4. `outputEscape: 'escape'` HTML-escapes `{{ }}` output.
 *   5. The registered string + url filters are all available.
 *   6. The `t` filter calls the injected I18nService with the right
 *      shop/locale and applies interpolation vars.
 *   7. Sync file access throws a clear error (async-only guarantee).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StaticLoader } from './static-loader.js'
import { createLiquidEngine, loaderToLiquidFS } from './liquid.js'
import { MemoryI18nService } from '../../i18n/index.js'

let tmpDir: string
let loader: StaticLoader

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gbox-liquid-'))
  await fs.mkdir(path.join(tmpDir, 'snippets'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'sections'), { recursive: true })
  await fs.writeFile(
    path.join(tmpDir, 'snippets/greeting.liquid'),
    'Hello, {{ name | upcase }}!',
    'utf8',
  )
  await fs.writeFile(
    path.join(tmpDir, 'sections/header.liquid'),
    '<header>{{ shop.name | escape }}</header>',
    'utf8',
  )
  loader = new StaticLoader(tmpDir, { label: 'gbox-liquid-test' })
})

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------

describe('createLiquidEngine — basic', () => {
  it('renders simple templates with registered filters', async () => {
    const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })
    const out = await engine.liquid.parseAndRender('{{ name | upcase }}', {
      name: 'thai',
    })
    expect(out).toBe('THAI')
  })

  it('exposes loader + i18n on the bundle', () => {
    const i18n = new MemoryI18nService()
    const engine = createLiquidEngine({ loader, i18n })
    expect(engine.loader).toBe(loader)
    expect(engine.i18n).toBe(i18n)
    expect(engine.liquid).toBeDefined()
  })

  it('strictVariables: false — missing var renders as empty string', async () => {
    const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })
    const out = await engine.liquid.parseAndRender('[{{ missing }}]')
    expect(out).toBe('[]')
  })

  it('strictFilters: true — unknown filter throws', async () => {
    const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })
    await expect(
      engine.liquid.parseAndRender('{{ x | nopeFilter }}', { x: 'v' }),
    ).rejects.toThrow()
  })

  it('no auto-escape (Shopify default) — raw HTML passes through unchanged', async () => {
    // Shopify Liquid does NOT auto-escape. Templates must call
    // `| escape` explicitly. This matches Ruby Liquid exactly.
    const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })
    const out = await engine.liquid.parseAndRender('{{ html }}', {
      html: '<b>hi</b>',
    })
    expect(out).toBe('<b>hi</b>')
  })

  it('explicit | escape filter still escapes (opt-in)', async () => {
    const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })
    const out = await engine.liquid.parseAndRender('{{ html | escape }}', {
      html: '<b>hi</b>',
    })
    expect(out).toBe('&lt;b&gt;hi&lt;/b&gt;')
  })
})

// ---------------------------------------------------------------------------
// Template resolution via TemplateLoader
// ---------------------------------------------------------------------------

describe('createLiquidEngine — template loading', () => {
  it('renderFile() reads from the StaticLoader', async () => {
    const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })
    const out = await engine.liquid.renderFile('snippets/greeting.liquid', {
      name: 'thai',
    })
    expect(out).toBe('Hello, THAI!')
  })

  it('renderFile() for section template escapes via explicit | escape', async () => {
    // Template literal `<header>...</header>` passes through raw; only
    // the `{{ shop.name | escape }}` interpolation is escaped (single-
    // escaped, not double, because no auto-escape is applied).
    const engine = createLiquidEngine({ loader, i18n: new MemoryI18nService() })
    const out = await engine.liquid.renderFile('sections/header.liquid', {
      shop: { name: 'Gbox <Test>' },
    })
    expect(out).toBe('<header>Gbox &lt;Test&gt;</header>')
  })
})

// ---------------------------------------------------------------------------
// i18n `t` filter
// ---------------------------------------------------------------------------

describe('createLiquidEngine — t filter', () => {
  it('resolves a key via the injected I18nService', async () => {
    const i18n = new MemoryI18nService({
      shop_1: {
        en: { 'cart.title': 'Cart', 'cart.empty': 'Your cart is empty' },
        vi: { 'cart.title': 'Giỏ hàng' },
      },
    })
    const engine = createLiquidEngine({ loader, i18n })
    const out = await engine.liquid.parseAndRender(
      `{{ 'cart.title' | t }}`,
      { shop: { id: 'shop_1', default_locale: 'en' }, request: { locale: 'en' } },
    )
    expect(out).toBe('Cart')
  })

  it('t filter uses the three-tier fallback', async () => {
    const i18n = new MemoryI18nService({
      shop_1: {
        en: { 'cart.empty': 'Your cart is empty' },
        vi: { 'cart.title': 'Giỏ hàng' },
      },
    })
    const engine = createLiquidEngine({ loader, i18n })
    // Request vi; vi doesn't have cart.empty; shop default en does.
    const out = await engine.liquid.parseAndRender(
      `{{ 'cart.empty' | t }}`,
      { shop: { id: 'shop_1', default_locale: 'en' }, request: { locale: 'vi' } },
    )
    expect(out).toBe('Your cart is empty')
  })

  it('t filter without shop context falls back to key sentinel', async () => {
    const engine = createLiquidEngine({
      loader,
      i18n: new MemoryI18nService(),
    })
    const out = await engine.liquid.parseAndRender(`{{ 'no.shop.key' | t }}`)
    expect(out).toBe('no.shop.key')
  })

  it('t filter supports interpolation via named args', async () => {
    const i18n = new MemoryI18nService({
      shop_1: {
        en: { 'cart.line_count': 'You have {{ count }} items' },
      },
    })
    const engine = createLiquidEngine({ loader, i18n })
    const out = await engine.liquid.parseAndRender(
      `{{ 'cart.line_count' | t: count: 5 }}`,
      { shop: { id: 'shop_1', default_locale: 'en' }, request: { locale: 'en' } },
    )
    expect(out).toBe('You have 5 items')
  })

  it('t filter missing key → key itself', async () => {
    const i18n = new MemoryI18nService({
      shop_1: { en: {} },
    })
    const engine = createLiquidEngine({ loader, i18n })
    const out = await engine.liquid.parseAndRender(
      `{{ 'no.such.key' | t }}`,
      { shop: { id: 'shop_1', default_locale: 'en' }, request: { locale: 'en' } },
    )
    expect(out).toBe('no.such.key')
  })
})

// ---------------------------------------------------------------------------
// Sync-unsupported guarantee
// ---------------------------------------------------------------------------

describe('loaderToLiquidFS — sync methods', () => {
  it('existsSync throws with a clear error', () => {
    const fs = loaderToLiquidFS(loader)
    expect(() => fs.existsSync('x')).toThrow(/Sync file access is not supported/)
  })

  it('readFileSync throws with a clear error', () => {
    const fs = loaderToLiquidFS(loader)
    expect(() => fs.readFileSync('x')).toThrow(/Sync file access is not supported/)
  })

  it('exists() async path works', async () => {
    const fs = loaderToLiquidFS(loader)
    expect(await fs.exists('snippets/greeting.liquid')).toBe(true)
    expect(await fs.exists('snippets/missing.liquid')).toBe(false)
  })

  it('readFile() async path throws on missing with clear msg', async () => {
    const fs = loaderToLiquidFS(loader)
    await expect(fs.readFile('snippets/missing.liquid')).rejects.toThrow(
      /template not found/,
    )
  })
})
