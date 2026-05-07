/**
 * Gbox Platform — URL filter unit tests
 *
 * Decision #1 Step 1.4 — Verifies URL filters register and produce
 * the Shopify-compatible output formats.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Liquid } from 'liquidjs'
import { registerUrlFilters } from './url.js'

let liquid: Liquid

beforeAll(() => {
  liquid = new Liquid({ strictFilters: true, strictVariables: false, outputEscape: undefined })
  registerUrlFilters(liquid)
})

async function render(tpl: string, ctx: Record<string, unknown> = {}): Promise<string> {
  return liquid.parseAndRender(tpl, ctx)
}

// ---------------------------------------------------------------------------
// url_encode / url_decode / url_escape / url_param_escape
// ---------------------------------------------------------------------------

describe('URL filters — encode/decode', () => {
  it('url_encode encodes reserved chars', async () => {
    expect(await render('{{ "hello world" | url_encode }}')).toBe('hello%20world')
  })
  it('url_decode decodes percent-encoded strings', async () => {
    expect(await render('{{ "hello%20world" | url_decode }}')).toBe('hello world')
  })
  it('url_decode tolerates malformed input', async () => {
    // `%` alone is malformed; Shopify returns the original.
    expect(await render('{{ "bad%" | url_decode }}')).toBe('bad%')
  })
  it('url_escape escapes # and ?', async () => {
    expect(
      await render('{{ "a#b?c" | url_escape }}'),
    ).toBe('a%23b%3Fc')
  })
  it('url_param_escape preserves +', async () => {
    expect(
      await render('{{ "a+b" | url_param_escape }}'),
    ).toBe('a+b')
  })
})

// ---------------------------------------------------------------------------
// link_to
// ---------------------------------------------------------------------------

describe('URL filters — link_to', () => {
  it('link_to builds an anchor', async () => {
    expect(
      await render('{{ "Home" | link_to: "/" }}'),
    ).toBe('<a href="/">Home</a>')
  })
  it('link_to with title attribute', async () => {
    expect(
      await render('{{ "Home" | link_to: "/", "Go home" }}'),
    ).toBe('<a href="/" title="Go home">Home</a>')
  })
  it('link_to HTML-escapes label and URL', async () => {
    expect(
      await render('{{ "<x>" | link_to: "/?a=1&b=2" }}'),
    ).toBe('<a href="/?a=1&amp;b=2">&lt;x&gt;</a>')
  })
  it('link_to_type builds a type-filter link', async () => {
    const out = await render('{{ "Shirts" | link_to_type }}')
    expect(out).toContain('href="/collections/types?q=Shirts"')
    expect(out).toContain('>Shirts<')
  })
  it('link_to_vendor builds a vendor-filter link', async () => {
    const out = await render('{{ "Nike" | link_to_vendor }}')
    expect(out).toContain('href="/collections/vendors?q=Nike"')
    expect(out).toContain('>Nike<')
  })
})

// ---------------------------------------------------------------------------
// within
// ---------------------------------------------------------------------------

describe('URL filters — within', () => {
  it('combines product + collection slugs', async () => {
    const out = await render(
      '{{ product | within: collection }}',
      {
        product: { slug: 'cool-shirt' },
        collection: { slug: 'summer' },
      },
    )
    expect(out).toBe('/collections/summer/products/cool-shirt')
  })
  it('falls back to /products/<slug> when collection empty', async () => {
    const out = await render(
      '{{ product | within: collection }}',
      {
        product: { slug: 'cool-shirt' },
        collection: null,
      },
    )
    expect(out).toBe('/products/cool-shirt')
  })
  it('handles `handle` field instead of `slug`', async () => {
    const out = await render(
      '{{ product | within: collection }}',
      {
        product: { handle: 'h1' },
        collection: { handle: 'c1' },
      },
    )
    expect(out).toBe('/collections/c1/products/h1')
  })
})

// Image/asset URL filters moved to filters/image.test.ts in Step 1.8.
// They need an AssetUrlBuilder, so they're tested separately.
