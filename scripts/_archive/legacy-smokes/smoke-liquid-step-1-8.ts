/**
 * Smoke test — Decision #1 Step 1.8 Image + Asset filters (R2/CDN ready).
 *
 * Exercises the full filter set registered by `registerImageFilters`:
 *
 *   1. `asset_url` with default (relative) builder
 *   2. `asset_url` with CDN builder + cache-bust token
 *   3. `global_asset_url` + `shopify_asset_url` alias
 *   4. `file_url` for merchant uploads
 *   5. `img_url` with WxH token
 *   6. `img_url` with named size (medium = 240x240)
 *   7. `img_url` with crop modifier (300x300_crop_center)
 *   8. `img_url` unwraps product.featured_image drop chain
 *   9. `img_url` master/original size passthrough
 *  10. `img_tag` with drop → width/height attrs extracted
 *  11. `img_tag` with size arg → width/height attrs from parsed token
 *  12. `stylesheet_tag` + `script_tag` via `asset_url` pipeline
 *  13. Absolute URL passthrough (no double-prefix)
 *  14. End-to-end Shopify-style snippet chain
 *
 * These are the exact patterns Shopify themes use in the wild — ported
 * themes should "just work" against this filter set.
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-8.ts
 */

import {
  createLiquidEngine,
  DefaultAssetUrlBuilder,
  type LoadResult,
  type LogicalPath,
  type TemplateLoader,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

// ---------------------------------------------------------------------------
// Minimal loader (not actually used for render here, but createLiquidEngine
// requires one — filters run fine without file reads).
// ---------------------------------------------------------------------------

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory'
  constructor(private readonly files: Record<string, string> = {}) {}
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

function makeDev() {
  return createLiquidEngine({
    loader: new MemoryLoader(),
    i18n: new MemoryI18nService(),
  })
}

function makeCdn() {
  return createLiquidEngine({
    loader: new MemoryLoader(),
    i18n: new MemoryI18nService(),
    assetUrlBuilder: new DefaultAssetUrlBuilder({
      themeAssetBase: 'https://cdn.gbox.co/shop_1/assets',
      fileBase: 'https://cdn.gbox.co/shop_1/files',
      globalAssetBase: 'https://cdn.gbox.co/global',
      cacheBustToken: 'v2026-04-09',
    }),
  })
}

// ---------------------------------------------------------------------------

async function main() {
  const dev = makeDev()
  const cdn = makeCdn()

  // ----- (1) asset_url default (relative) ---------------------------------
  {
    const out = await dev.liquid.parseAndRender('{{ "theme.css" | asset_url }}')
    if (out !== '/assets/theme.css') throw new Error(`(1) ${out}`)
    console.log('PASS (1) asset_url default:', out)
  }

  // ----- (2) asset_url CDN + cache bust -----------------------------------
  {
    const out = await cdn.liquid.parseAndRender('{{ "theme.css" | asset_url }}')
    if (out !== 'https://cdn.gbox.co/shop_1/assets/theme.css?v=v2026-04-09')
      throw new Error(`(2) ${out}`)
    console.log('PASS (2) asset_url CDN + cache bust:', out)
  }

  // ----- (3) global_asset_url + shopify_asset_url alias -------------------
  {
    const a = await dev.liquid.parseAndRender(
      '{{ "runtime.js" | global_asset_url }}',
    )
    const b = await dev.liquid.parseAndRender(
      '{{ "option_selection.js" | shopify_asset_url }}',
    )
    if (a !== '/global/runtime.js') throw new Error(`(3a) ${a}`)
    if (b !== '/global/option_selection.js') throw new Error(`(3b) ${b}`)
    console.log('PASS (3) global_asset_url + shopify_asset_url alias')
  }

  // ----- (4) file_url -----------------------------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      '{{ "invoice.pdf" | file_url }}',
    )
    if (out !== '/cdn/files/invoice.pdf') throw new Error(`(4) ${out}`)
    console.log('PASS (4) file_url:', out)
  }

  // ----- (5) img_url WxH --------------------------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      '{{ "/cdn/files/hero.jpg" | img_url: "600x" }}',
    )
    if (out !== '/cdn/files/hero_600x.jpg') throw new Error(`(5) ${out}`)
    console.log('PASS (5) img_url WxH:', out)
  }

  // ----- (6) img_url named size ------------------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      '{{ "/cdn/files/hero.jpg" | img_url: "medium" }}',
    )
    if (out !== '/cdn/files/hero_240x240.jpg') throw new Error(`(6) ${out}`)
    console.log('PASS (6) img_url named size medium:', out)
  }

  // ----- (7) img_url crop modifier ---------------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      '{{ "/cdn/files/hero.jpg" | img_url: "300x300_crop_center" }}',
    )
    if (out !== '/cdn/files/hero_300x300_crop_center.jpg')
      throw new Error(`(7) ${out}`)
    console.log('PASS (7) img_url crop modifier:', out)
  }

  // ----- (8) img_url product drop chain ----------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      '{{ product | img_url: "large" }}',
      {
        product: {
          featured_image: { src: '/cdn/files/shirt.jpg' },
        },
      },
    )
    if (out !== '/cdn/files/shirt_480x480.jpg') throw new Error(`(8) ${out}`)
    console.log('PASS (8) img_url unwraps product.featured_image:', out)
  }

  // ----- (9) master/original size passthrough ----------------------------
  {
    const out = await dev.liquid.parseAndRender(
      '{{ "/cdn/files/hero.jpg" | img_url: "master" }}',
    )
    if (out !== '/cdn/files/hero.jpg') throw new Error(`(9) ${out}`)
    console.log('PASS (9) master size passthrough:', out)
  }

  // ----- (10) img_tag with drop width/height -----------------------------
  {
    const out = await dev.liquid.parseAndRender('{{ img | img_tag }}', {
      img: {
        src: '/cdn/files/hero.jpg',
        alt: 'Hero banner',
        width: 1600,
        height: 900,
      },
    })
    const expected =
      '<img src="/cdn/files/hero.jpg" alt="Hero banner" width="1600" height="900" />'
    if (out !== expected) throw new Error(`(10) ${out}`)
    console.log('PASS (10) img_tag width/height from drop')
  }

  // ----- (11) img_tag with size arg parsed -------------------------------
  {
    const out = await dev.liquid.parseAndRender(
      '{{ img | img_tag: "Logo", "brand-logo", "240x240" }}',
      { img: { src: '/cdn/files/logo.png' } },
    )
    const expected =
      '<img src="/cdn/files/logo_240x240.png" alt="Logo" class="brand-logo" width="240" height="240" />'
    if (out !== expected) throw new Error(`(11) ${out}`)
    console.log('PASS (11) img_tag width/height from size token')
  }

  // ----- (12) stylesheet_tag + script_tag piped from asset_url -----------
  {
    const css = await cdn.liquid.parseAndRender(
      '{{ "theme.css" | asset_url | stylesheet_tag }}',
    )
    const js = await cdn.liquid.parseAndRender(
      '{{ "theme.js" | asset_url | script_tag }}',
    )
    const expectedCss =
      '<link href="https://cdn.gbox.co/shop_1/assets/theme.css?v=v2026-04-09" rel="stylesheet" type="text/css" media="all" />'
    const expectedJs =
      '<script src="https://cdn.gbox.co/shop_1/assets/theme.js?v=v2026-04-09" type="text/javascript"></script>'
    if (css !== expectedCss) throw new Error(`(12 css) ${css}`)
    if (js !== expectedJs) throw new Error(`(12 js) ${js}`)
    console.log('PASS (12) stylesheet_tag + script_tag chain w/ CDN + cache bust')
  }

  // ----- (13) absolute URL passthrough -----------------------------------
  {
    // An already-absolute src should not get a base prefixed onto it.
    const out = await cdn.liquid.parseAndRender(
      '{{ "https://other.cdn/img/hero.jpg" | img_url: "300x" }}',
    )
    if (out !== 'https://other.cdn/img/hero_300x.jpg')
      throw new Error(`(13) ${out}`)
    console.log('PASS (13) absolute URL passthrough with size:', out)
  }

  // ----- (14) end-to-end realistic snippet chain -------------------------
  {
    // Mirrors a Dawn-style header-logo snippet.
    const tpl = [
      '{%- assign logo_size = "medium" -%}',
      '{{ shop.brand.logo | img_url: logo_size | script_tag }}', // intentionally odd chain to prove chaining works
      '\n',
      '{{ shop.brand.logo | img_tag: shop.name, "logo", logo_size }}',
    ].join('')
    const out = await cdn.liquid.parseAndRender(tpl, {
      shop: {
        name: 'Gbox Demo Shop',
        brand: { logo: { src: '/cdn/files/brand.png' } },
      },
    })
    if (!out.includes('brand_240x240.png?v=v2026-04-09')) {
      throw new Error(`(14) CDN-sized URL missing: ${out}`)
    }
    if (!out.includes('alt="Gbox Demo Shop"')) {
      throw new Error(`(14) alt from shop.name missing: ${out}`)
    }
    if (!out.includes('class="logo"')) {
      throw new Error(`(14) class attr missing: ${out}`)
    }
    if (!out.includes('width="240" height="240"')) {
      throw new Error(`(14) width/height missing: ${out}`)
    }
    console.log('PASS (14) end-to-end realistic snippet chain')
  }

  console.log('\nALL PASSED — Step 1.8 image filters + AssetUrlBuilder wired')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
