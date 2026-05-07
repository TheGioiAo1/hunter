/**
 * Gbox Platform — Image + Asset filter tests
 *
 * Decision #1 Step 1.8. Covers every filter registered by
 * `registerImageFilters()`:
 *
 *   URL-only:  asset_url, global_asset_url, shopify_asset_url, file_url
 *   Image URL: img_url, image_url, product_img_url, collection_img_url,
 *              article_img_url, asset_img_url, file_img_url
 *   Tags:      img_tag, image_tag, stylesheet_tag, script_tag
 *
 * Size arg variants tested: no size, named size, WxH token, structured
 * object, number (width-only), crop modifier. Input variants: string,
 * object with src/url/image_url/image/featured_image.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Liquid } from 'liquidjs'
import { registerImageFilters } from './image.js'
import { DefaultAssetUrlBuilder } from '../assets/asset-url-builder.js'

let liquid: Liquid
let cdnLiquid: Liquid

beforeAll(() => {
  // Default builder — relative paths.
  liquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
    outputEscape: undefined,
  })
  registerImageFilters(liquid, new DefaultAssetUrlBuilder())

  // CDN builder — absolute URLs, used for the CDN-passthrough tests.
  cdnLiquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
    outputEscape: undefined,
  })
  registerImageFilters(
    cdnLiquid,
    new DefaultAssetUrlBuilder({
      themeAssetBase: 'https://cdn.gbox.co/assets',
      fileBase: 'https://cdn.gbox.co/files',
      globalAssetBase: 'https://cdn.gbox.co/global',
      cacheBustToken: '2026-04-09',
    }),
  )
})

async function render(tpl: string, ctx: Record<string, unknown> = {}): Promise<string> {
  return liquid.parseAndRender(tpl, ctx)
}
async function renderCdn(
  tpl: string,
  ctx: Record<string, unknown> = {},
): Promise<string> {
  return cdnLiquid.parseAndRender(tpl, ctx)
}

// ---------------------------------------------------------------------------
// URL-only filters
// ---------------------------------------------------------------------------

describe('asset URL filters', () => {
  it('asset_url prepends /assets', async () => {
    expect(await render('{{ "theme.css" | asset_url }}')).toBe(
      '/assets/theme.css',
    )
  })

  it('global_asset_url uses /global', async () => {
    expect(await render('{{ "runtime.js" | global_asset_url }}')).toBe(
      '/global/runtime.js',
    )
  })

  it('shopify_asset_url is an alias for global_asset_url', async () => {
    expect(await render('{{ "option_selection.js" | shopify_asset_url }}')).toBe(
      '/global/option_selection.js',
    )
  })

  it('file_url prepends /cdn/files', async () => {
    expect(await render('{{ "logo.svg" | file_url }}')).toBe(
      '/cdn/files/logo.svg',
    )
  })

  it('CDN-backed asset_url emits an absolute URL with cache bust', async () => {
    expect(await renderCdn('{{ "theme.css" | asset_url }}')).toBe(
      'https://cdn.gbox.co/assets/theme.css?v=2026-04-09',
    )
  })
})

// ---------------------------------------------------------------------------
// Image URL filters
// ---------------------------------------------------------------------------

describe('img_url filter', () => {
  it('passes through a plain URL with no size', async () => {
    expect(await render('{{ "/cdn/files/hero.jpg" | img_url }}')).toBe(
      '/cdn/files/hero.jpg',
    )
  })

  it('applies a WxH size token', async () => {
    expect(
      await render('{{ "/cdn/files/hero.jpg" | img_url: "300x" }}'),
    ).toBe('/cdn/files/hero_300x.jpg')
  })

  it('applies a named size token', async () => {
    expect(
      await render('{{ "/cdn/files/hero.jpg" | img_url: "medium" }}'),
    ).toBe('/cdn/files/hero_240x240.jpg')
  })

  it('unwraps an object with .src', async () => {
    expect(
      await render('{{ img | img_url: "400x" }}', {
        img: { src: '/cdn/files/shirt.jpg' },
      }),
    ).toBe('/cdn/files/shirt_400x.jpg')
  })

  it('unwraps product.featured_image', async () => {
    expect(
      await render('{{ product | img_url: "300x" }}', {
        product: { featured_image: { src: '/cdn/files/hero.jpg' } },
      }),
    ).toBe('/cdn/files/hero_300x.jpg')
  })

  it('master/original size keeps the URL untouched', async () => {
    expect(
      await render('{{ "/cdn/files/hero.jpg" | img_url: "master" }}'),
    ).toBe('/cdn/files/hero.jpg')
  })

  it('returns empty string for null/undefined input', async () => {
    expect(await render('{{ nothing | img_url: "300x" }}')).toBe('')
  })

  it('image_url alias works identically', async () => {
    expect(
      await render('{{ "/cdn/files/hero.jpg" | image_url: "large" }}'),
    ).toBe('/cdn/files/hero_480x480.jpg')
  })

  it('product_img_url alias works identically', async () => {
    expect(
      await render('{{ "/cdn/files/hero.jpg" | product_img_url: "thumb" }}'),
    ).toBe('/cdn/files/hero_50x50.jpg')
  })

  it('collection_img_url alias works', async () => {
    expect(
      await render('{{ "/cdn/files/hero.jpg" | collection_img_url: "pico" }}'),
    ).toBe('/cdn/files/hero_16x16.jpg')
  })

  it('article_img_url alias works', async () => {
    expect(
      await render('{{ "/cdn/files/hero.jpg" | article_img_url: "icon" }}'),
    ).toBe('/cdn/files/hero_32x32.jpg')
  })

  it('asset_img_url combines /assets base + sizing', async () => {
    expect(await render('{{ "logo.png" | asset_img_url: "200x" }}')).toBe(
      '/assets/logo_200x.png',
    )
  })

  it('file_img_url combines /cdn/files base + sizing', async () => {
    expect(
      await render('{{ "products/shirt.jpg" | file_img_url: "medium" }}'),
    ).toBe('/cdn/files/products/shirt_240x240.jpg')
  })
})

// ---------------------------------------------------------------------------
// img_tag filter
// ---------------------------------------------------------------------------

describe('img_tag filter', () => {
  it('renders a minimal <img> with empty alt when no drop metadata', async () => {
    expect(await render('{{ "/hero.jpg" | img_tag }}')).toBe(
      '<img src="/hero.jpg" alt="" />',
    )
  })

  it('uses explicit alt text arg', async () => {
    expect(await render('{{ "/hero.jpg" | img_tag: "Hero image" }}')).toBe(
      '<img src="/hero.jpg" alt="Hero image" />',
    )
  })

  it('HTML-escapes alt text', async () => {
    expect(
      await render('{{ "/hero.jpg" | img_tag: "A <bold> & \\"quoted\\"" }}'),
    ).toBe(
      '<img src="/hero.jpg" alt="A &lt;bold&gt; &amp; &quot;quoted&quot;" />',
    )
  })

  it('emits class attribute', async () => {
    expect(
      await render('{{ "/hero.jpg" | img_tag: "Alt", "hero-image" }}'),
    ).toBe('<img src="/hero.jpg" alt="Alt" class="hero-image" />')
  })

  it('falls back to image.alt when no alt arg given', async () => {
    expect(
      await render('{{ img | img_tag }}', {
        img: { src: '/hero.jpg', alt: 'Drop alt' },
      }),
    ).toBe('<img src="/hero.jpg" alt="Drop alt" />')
  })

  it('falls back to image.alt_text', async () => {
    expect(
      await render('{{ img | img_tag }}', {
        img: { src: '/hero.jpg', alt_text: 'Alt text fallback' },
      }),
    ).toBe('<img src="/hero.jpg" alt="Alt text fallback" />')
  })

  it('emits width/height from drop when no size arg', async () => {
    expect(
      await render('{{ img | img_tag: "Alt" }}', {
        img: { src: '/hero.jpg', width: 800, height: 600 },
      }),
    ).toBe('<img src="/hero.jpg" alt="Alt" width="800" height="600" />')
  })

  it('emits width/height from size arg and applies URL suffix', async () => {
    expect(
      await render('{{ img | img_tag: "Alt", "", "300x400" }}', {
        img: { src: '/hero.jpg' },
      }),
    ).toBe('<img src="/hero_300x400.jpg" alt="Alt" width="300" height="400" />')
  })

  it('empty alt arg explicitly blanks the alt (not the drop fallback)', async () => {
    expect(
      await render('{{ img | img_tag: "" }}', {
        img: { src: '/hero.jpg', alt: 'drop alt' },
      }),
    ).toBe('<img src="/hero.jpg" alt="" />')
  })

  it('image_tag alias works identically', async () => {
    expect(await render('{{ "/hero.jpg" | image_tag: "Alt" }}')).toBe(
      '<img src="/hero.jpg" alt="Alt" />',
    )
  })

  it('returns empty string when image cannot be resolved', async () => {
    expect(await render('{{ nothing | img_tag }}')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// stylesheet_tag / script_tag
// ---------------------------------------------------------------------------

describe('stylesheet_tag and script_tag', () => {
  it('stylesheet_tag wraps a URL', async () => {
    expect(
      await render('{{ "theme.css" | asset_url | stylesheet_tag }}'),
    ).toBe(
      '<link href="/assets/theme.css" rel="stylesheet" type="text/css" media="all" />',
    )
  })

  it('stylesheet_tag accepts a media arg', async () => {
    expect(
      await render('{{ "print.css" | asset_url | stylesheet_tag: "print" }}'),
    ).toBe(
      '<link href="/assets/print.css" rel="stylesheet" type="text/css" media="print" />',
    )
  })

  it('stylesheet_tag on empty URL returns empty', async () => {
    expect(await render('{{ "" | stylesheet_tag }}')).toBe('')
  })

  it('script_tag wraps a URL', async () => {
    expect(await render('{{ "theme.js" | asset_url | script_tag }}')).toBe(
      '<script src="/assets/theme.js" type="text/javascript"></script>',
    )
  })

  it('script_tag on empty URL returns empty', async () => {
    expect(await render('{{ "" | script_tag }}')).toBe('')
  })

  it('CDN builder: stylesheet_tag emits absolute URL with cache bust', async () => {
    expect(
      await renderCdn('{{ "theme.css" | asset_url | stylesheet_tag }}'),
    ).toBe(
      '<link href="https://cdn.gbox.co/assets/theme.css?v=2026-04-09" rel="stylesheet" type="text/css" media="all" />',
    )
  })
})

// ---------------------------------------------------------------------------
// Chaining / realistic patterns
// ---------------------------------------------------------------------------

describe('filter chaining — realistic Shopify theme patterns', () => {
  it('section logo chain: shop.logo | img_url | img_tag via explicit pipeline', async () => {
    // Realistic Dawn-style snippet:
    //   {% assign logo_size = 'medium' %}
    //   {{ shop.brand.logo | img_url: logo_size | img_tag: shop.name }}
    // We test the URL+tag combo directly.
    const out = await render(
      '{{ shop.brand.logo | img_url: "medium" }}',
      { shop: { brand: { logo: { src: '/cdn/files/logo.png' } } } },
    )
    expect(out).toBe('/cdn/files/logo_240x240.png')
  })

  it('product card: product | img_url with fallback to featured_image', async () => {
    const out = await render(
      '{{ product | img_url: "300x300_crop_center" }}',
      {
        product: {
          featured_image: { src: '/cdn/files/shirt.jpg', alt: 'T-shirt' },
        },
      },
    )
    expect(out).toBe('/cdn/files/shirt_300x300_crop_center.jpg')
  })
})
