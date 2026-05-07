/**
 * Gbox Platform — SEO JSON-LD builders tests (Stage 3D.3)
 *
 * These are pure functions: no HTTP, no DB, no async. Every test
 * calls the builder and then asserts the structured-data shape
 * matches schema.org. We parse the emitted JSON once per test
 * rather than string-matching so the tests don't get brittle on
 * key ordering.
 */

import { describe, it, expect } from 'vitest'
import {
  buildProductJsonLd,
  buildOrganizationJsonLd,
  buildBreadcrumbListJsonLd,
  buildWebSiteJsonLd,
  type ProductJsonLdInput,
  type OrganizationJsonLdInput,
  type BreadcrumbListJsonLdInput,
  type WebSiteJsonLdInput,
} from './json-ld.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP: OrganizationJsonLdInput = {
  name: 'Demo Shop',
  baseUrl: 'https://demo.gbox.test',
  logoUrl: 'https://demo.gbox.test/assets/logo.png',
  description: 'Best demo shop in town',
  sameAs: ['https://twitter.com/demo', 'https://instagram.com/demo'],
}

const PRODUCT: ProductJsonLdInput = {
  name: 'Cap',
  handle: 'cap',
  description: 'A lovely cap',
  sku: 'CAP-001',
  brand: 'Demo Brand',
  price: '19.99',
  currency: 'USD',
  available: true,
  imageUrls: [
    'https://demo.gbox.test/cdn/cap-front.jpg',
    'https://demo.gbox.test/cdn/cap-side.jpg',
  ],
  shopName: 'Demo Shop',
  baseUrl: 'https://demo.gbox.test',
}

// ---------------------------------------------------------------------------
// parse helper — every builder returns a string, tests want the object
// ---------------------------------------------------------------------------

function parse(jsonLd: string): any {
  return JSON.parse(jsonLd)
}

// ---------------------------------------------------------------------------
// buildProductJsonLd
// ---------------------------------------------------------------------------

describe('buildProductJsonLd', () => {
  it('emits a schema.org/Product with the required fields', () => {
    const doc = parse(buildProductJsonLd(PRODUCT))
    expect(doc['@context']).toBe('https://schema.org')
    expect(doc['@type']).toBe('Product')
    expect(doc.name).toBe('Cap')
    expect(doc.description).toBe('A lovely cap')
    expect(doc.sku).toBe('CAP-001')
    expect(doc.image).toEqual([
      'https://demo.gbox.test/cdn/cap-front.jpg',
      'https://demo.gbox.test/cdn/cap-side.jpg',
    ])
  })

  it('emits a nested brand with @type Brand', () => {
    const doc = parse(buildProductJsonLd(PRODUCT))
    expect(doc.brand).toEqual({ '@type': 'Brand', name: 'Demo Brand' })
  })

  it('emits an offers object with price, currency, url, and availability', () => {
    const doc = parse(buildProductJsonLd(PRODUCT))
    expect(doc.offers).toMatchObject({
      '@type': 'Offer',
      price: '19.99',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: 'https://demo.gbox.test/products/cap',
    })
  })

  it('uses OutOfStock availability when available is false', () => {
    const doc = parse(buildProductJsonLd({ ...PRODUCT, available: false }))
    expect(doc.offers.availability).toBe('https://schema.org/OutOfStock')
  })

  it('omits brand entirely when no brand is supplied', () => {
    const doc = parse(buildProductJsonLd({ ...PRODUCT, brand: null }))
    expect('brand' in doc).toBe(false)
  })

  it('omits sku entirely when no sku is supplied', () => {
    const doc = parse(buildProductJsonLd({ ...PRODUCT, sku: null }))
    expect('sku' in doc).toBe(false)
  })

  it('collapses image array to a single string when there is one image', () => {
    const doc = parse(
      buildProductJsonLd({ ...PRODUCT, imageUrls: ['https://x/y.jpg'] }),
    )
    expect(doc.image).toBe('https://x/y.jpg')
  })

  it('omits the image key entirely when there are no images', () => {
    const doc = parse(buildProductJsonLd({ ...PRODUCT, imageUrls: [] }))
    expect('image' in doc).toBe(false)
  })

  it('trims description HTML and keeps plain text only', () => {
    const doc = parse(
      buildProductJsonLd({
        ...PRODUCT,
        description: '<p>Hello <strong>world</strong>!</p>',
      }),
    )
    // No tags in the emitted description — Google penalises HTML in
    // structured data, so we strip aggressively.
    expect(doc.description).toBe('Hello world!')
  })

  it('builds a safe offers.url even when baseUrl has a trailing slash', () => {
    const doc = parse(
      buildProductJsonLd({ ...PRODUCT, baseUrl: 'https://demo.gbox.test/' }),
    )
    expect(doc.offers.url).toBe('https://demo.gbox.test/products/cap')
  })
})

// ---------------------------------------------------------------------------
// buildOrganizationJsonLd
// ---------------------------------------------------------------------------

describe('buildOrganizationJsonLd', () => {
  it('emits a schema.org/Organization with name, url, and logo', () => {
    const doc = parse(buildOrganizationJsonLd(SHOP))
    expect(doc['@context']).toBe('https://schema.org')
    expect(doc['@type']).toBe('Organization')
    expect(doc.name).toBe('Demo Shop')
    expect(doc.url).toBe('https://demo.gbox.test')
    expect(doc.logo).toBe('https://demo.gbox.test/assets/logo.png')
  })

  it('emits sameAs as an array of profile URLs', () => {
    const doc = parse(buildOrganizationJsonLd(SHOP))
    expect(doc.sameAs).toEqual([
      'https://twitter.com/demo',
      'https://instagram.com/demo',
    ])
  })

  it('omits logo when no logo URL is provided', () => {
    const doc = parse(buildOrganizationJsonLd({ ...SHOP, logoUrl: null }))
    expect('logo' in doc).toBe(false)
  })

  it('omits sameAs when the array is empty or missing', () => {
    const doc = parse(buildOrganizationJsonLd({ ...SHOP, sameAs: [] }))
    expect('sameAs' in doc).toBe(false)
  })

  it('omits description when not supplied', () => {
    const doc = parse(buildOrganizationJsonLd({ ...SHOP, description: null }))
    expect('description' in doc).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildBreadcrumbListJsonLd
// ---------------------------------------------------------------------------

describe('buildBreadcrumbListJsonLd', () => {
  const INPUT: BreadcrumbListJsonLdInput = {
    baseUrl: 'https://demo.gbox.test',
    items: [
      { name: 'Home', path: '/' },
      { name: 'Hats', path: '/collections/hats' },
      { name: 'Cap', path: '/products/cap' },
    ],
  }

  it('emits a schema.org/BreadcrumbList with ordered ListItems', () => {
    const doc = parse(buildBreadcrumbListJsonLd(INPUT))
    expect(doc['@context']).toBe('https://schema.org')
    expect(doc['@type']).toBe('BreadcrumbList')
    expect(doc.itemListElement).toHaveLength(3)
    expect(doc.itemListElement[0]).toEqual({
      '@type': 'ListItem',
      position: 1,
      name: 'Home',
      item: 'https://demo.gbox.test/',
    })
    expect(doc.itemListElement[2]).toEqual({
      '@type': 'ListItem',
      position: 3,
      name: 'Cap',
      item: 'https://demo.gbox.test/products/cap',
    })
  })

  it('keeps positions 1-based and contiguous', () => {
    const doc = parse(buildBreadcrumbListJsonLd(INPUT))
    const positions = doc.itemListElement.map((i: any) => i.position)
    expect(positions).toEqual([1, 2, 3])
  })

  it('handles a single breadcrumb without error', () => {
    const doc = parse(
      buildBreadcrumbListJsonLd({
        baseUrl: 'https://demo.gbox.test',
        items: [{ name: 'Home', path: '/' }],
      }),
    )
    expect(doc.itemListElement).toHaveLength(1)
    expect(doc.itemListElement[0].position).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// buildWebSiteJsonLd
// ---------------------------------------------------------------------------

describe('buildWebSiteJsonLd', () => {
  const INPUT: WebSiteJsonLdInput = {
    name: 'Demo Shop',
    baseUrl: 'https://demo.gbox.test',
  }

  it('emits a schema.org/WebSite with a SearchAction target', () => {
    const doc = parse(buildWebSiteJsonLd(INPUT))
    expect(doc['@context']).toBe('https://schema.org')
    expect(doc['@type']).toBe('WebSite')
    expect(doc.name).toBe('Demo Shop')
    expect(doc.url).toBe('https://demo.gbox.test')
    expect(doc.potentialAction).toMatchObject({
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate:
          'https://demo.gbox.test/search?q={search_term_string}',
      },
      'query-input': 'required name=search_term_string',
    })
  })

  it('normalises a trailing-slash baseUrl', () => {
    const doc = parse(
      buildWebSiteJsonLd({ ...INPUT, baseUrl: 'https://demo.gbox.test/' }),
    )
    expect(doc.url).toBe('https://demo.gbox.test')
    expect(doc.potentialAction.target.urlTemplate).toBe(
      'https://demo.gbox.test/search?q={search_term_string}',
    )
  })
})

// ---------------------------------------------------------------------------
// Security — JSON-LD must not leak HTML
// ---------------------------------------------------------------------------

describe('JSON-LD HTML safety', () => {
  it('escapes </script> so the emitted JSON cannot break out of a <script> tag', () => {
    // The classic XSS in JSON-LD: if the description contains </script>
    // and the page emits it verbatim inside <script type="application/ld+json">,
    // the browser closes the tag early. We escape `/` in `</` as `\/`.
    const jsonLd = buildProductJsonLd({
      ...PRODUCT,
      description: 'Nice </script><script>alert(1)</script> cap',
    })
    expect(jsonLd).not.toContain('</script>')
    // The Unicode-escaped form is still valid JSON and parses back.
    expect(() => JSON.parse(jsonLd)).not.toThrow()
  })
})
