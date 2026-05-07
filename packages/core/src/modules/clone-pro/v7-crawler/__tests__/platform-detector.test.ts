import { describe, it, expect } from 'vitest'
import { detectPlatform } from '../platform-detector.js'

describe('platform-detector', () => {
  it('detects shopify-classic via meta generator', () => {
    const html = `<!doctype html><html><head><meta name="generator" content="Shopify"></head></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('shopify-classic')
  })

  it('detects shopify-classic via cdn.shopify.com asset', () => {
    const html = `<html><head><script src="https://cdn.shopify.com/s/files/1/0001/0001/t/2/assets/x.js"></script></head></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('shopify-classic')
  })

  it('detects shopify-classic via Shopify.theme JS object', () => {
    const html = `<html><body><script>var Shopify = Shopify || {}; Shopify.theme = { name: 'Dawn' };</script></body></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('shopify-classic')
  })

  it('detects shopify-hydrogen via __remixContext (Hydrogen 2.0 = Remix)', () => {
    const html = `<html><body><script>window.__remixContext = { state: {} };</script></body></html>`
    expect(detectPlatform(html, 'https://hydrogen.example.com')).toBe('shopify-hydrogen')
  })

  it('detects shopify-hydrogen via @shopify/hydrogen import', () => {
    const html = `<html><body><script type="module">import '@shopify/hydrogen'</script></body></html>`
    expect(detectPlatform(html, 'https://hydrogen.example.com')).toBe('shopify-hydrogen')
  })

  it('detects shopify-hydrogen via meta generator Hydrogen', () => {
    const html = `<html><head><meta name="generator" content="Hydrogen"></head></html>`
    expect(detectPlatform(html, 'https://hydrogen.example.com')).toBe('shopify-hydrogen')
  })

  it('prefers hydrogen over classic when both signals appear (Hydrogen also uses cdn.shopify.com)', () => {
    const html = `<html><head>
      <script src="https://cdn.shopify.com/s/files/x.js"></script>
      <script>window.__remixContext = {};</script>
    </head></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('shopify-hydrogen')
  })

  it('detects woocommerce via wp-content path', () => {
    const html = `<html><head><link rel="stylesheet" href="/wp-content/themes/storefront/style.css"></head></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('woocommerce')
  })

  it('detects woocommerce via woocommerce class hint', () => {
    const html = `<html><body class="woocommerce-page woocommerce"></body></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('woocommerce')
  })

  it('detects bigcommerce via stencil-utils', () => {
    const html = `<html><head><script src="//cdn11.bigcommerce.com/stencil-utils/x.js"></script></head></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('bigcommerce')
  })

  it('detects shopbase via sbase-cdn', () => {
    const html = `<html><head><link href="//sbase-cdn.com/x.css"></head></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('shopbase')
  })

  it('returns unknown for generic html with no platform signature', () => {
    const html = `<html><head><title>Plain</title></head><body>nothing</body></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('unknown')
  })

  it('is case-insensitive on signature matching', () => {
    const html = `<html><head><META NAME="GENERATOR" CONTENT="SHOPIFY"></head></html>`
    expect(detectPlatform(html, 'https://shop.example.com')).toBe('shopify-classic')
  })
})
