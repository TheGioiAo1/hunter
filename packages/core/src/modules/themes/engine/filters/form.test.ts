/**
 * Gbox Platform — Form/payment filter tests
 *
 * Decision #1 Step 1.9. Covers the two filters shipped by
 * `registerFormFilters()`:
 *
 *   payment_type_img_url    — URL of a payment icon SVG
 *   payment_type_svg_tag    — Inline <svg> tag with <use href="...">
 *
 * Both with the default (relative-path) AssetUrlBuilder and a
 * CDN-backed one with a cache-bust token.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Liquid } from 'liquidjs'
import { registerFormFilters } from './form.js'
import { DefaultAssetUrlBuilder } from '../assets/asset-url-builder.js'

let liquid: Liquid
let cdnLiquid: Liquid

beforeAll(() => {
  liquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
    outputEscape: undefined,
  })
  registerFormFilters(liquid, new DefaultAssetUrlBuilder())

  cdnLiquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
    outputEscape: undefined,
  })
  registerFormFilters(
    cdnLiquid,
    new DefaultAssetUrlBuilder({
      globalAssetBase: 'https://cdn.gbox.co/global',
      cacheBustToken: '2026-04-09',
    }),
  )
})

async function render(tpl: string): Promise<string> {
  return liquid.parseAndRender(tpl)
}
async function renderCdn(tpl: string): Promise<string> {
  return cdnLiquid.parseAndRender(tpl)
}

// ---------------------------------------------------------------------------
// payment_type_img_url
// ---------------------------------------------------------------------------

describe('payment_type_img_url', () => {
  it('builds a relative URL under /global/payment_icons', async () => {
    expect(await render('{{ "visa" | payment_type_img_url }}')).toBe(
      '/global/payment_icons/visa.svg',
    )
  })

  it('slugifies display names with spaces', async () => {
    expect(
      await render('{{ "american express" | payment_type_img_url }}'),
    ).toBe('/global/payment_icons/american_express.svg')
  })

  it('slugifies display names with casing + symbols', async () => {
    expect(
      await render('{{ "Apple Pay" | payment_type_img_url }}'),
    ).toBe('/global/payment_icons/apple_pay.svg')
  })

  it('returns empty string for empty/null input', async () => {
    expect(await render('{{ "" | payment_type_img_url }}')).toBe('')
    expect(await render('{{ nothing | payment_type_img_url }}')).toBe('')
  })

  it('CDN builder emits absolute URL with cache-bust', async () => {
    expect(await renderCdn('{{ "visa" | payment_type_img_url }}')).toBe(
      'https://cdn.gbox.co/global/payment_icons/visa.svg?v=2026-04-09',
    )
  })
})

// ---------------------------------------------------------------------------
// payment_type_svg_tag
// ---------------------------------------------------------------------------

describe('payment_type_svg_tag', () => {
  it('wraps visa URL in an <svg> with <use href="...">', async () => {
    const out = await render('{{ "visa" | payment_type_svg_tag }}')
    expect(out).toContain('<svg class="payment-icon payment-icon--visa"')
    expect(out).toContain('role="img"')
    expect(out).toContain('aria-label="visa"')
    expect(out).toContain(
      '<use href="/global/payment_icons/visa.svg#visa" />',
    )
    expect(out).toMatch(/<\/svg>$/)
  })

  it('slugified name is used in class + use fragment', async () => {
    const out = await render('{{ "American Express" | payment_type_svg_tag }}')
    expect(out).toContain('payment-icon--american_express')
    expect(out).toContain('american_express.svg#american_express')
  })

  it('HTML-escapes the aria-label preserving original text', async () => {
    const out = await render('{{ "American Express" | payment_type_svg_tag }}')
    expect(out).toContain('aria-label="American Express"')
  })

  it('returns empty string for empty input', async () => {
    expect(await render('{{ "" | payment_type_svg_tag }}')).toBe('')
  })

  it('CDN builder: <use href> is absolute with cache-bust', async () => {
    const out = await renderCdn('{{ "mastercard" | payment_type_svg_tag }}')
    expect(out).toContain(
      '<use href="https://cdn.gbox.co/global/payment_icons/mastercard.svg?v=2026-04-09#mastercard" />',
    )
  })
})
