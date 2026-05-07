/**
 * Gbox Platform — Shopify-compatible Form + Payment Filters
 *
 * Decision #1 Step 1.9 — The handful of filter names Shopify themes
 * use for payment icons in footers and checkout pages:
 *
 *   payment_type_img_url     — URL of a payment icon SVG
 *                              ({{ 'visa' | payment_type_img_url }}
 *                               → /global/payment_icons/visa.svg)
 *   payment_type_svg_tag     — Inline <svg> reference tag
 *                              ({{ 'visa' | payment_type_svg_tag }}
 *                               → <svg class="payment-icon ..." …>
 *                                   <use href="/global/payment_icons/visa.svg#visa"/>
 *                                 </svg>)
 *
 * Both delegate to the injected `AssetUrlBuilder`, so in production
 * the icons come from the CDN with a cache-bust token; in dev they
 * resolve to `/global/payment_icons/<type>.svg`. The actual SVG files
 * are shipped with the platform (Step 1.18 imports the Shopify icon
 * set into `global/payment_icons/`).
 *
 * Why not return an <img> tag from `payment_type_svg_tag`?
 *   Shopify's behaviour is to inline the SVG so CSS can recolor it
 *   via `currentColor`. An <img> blocks CSS styling. We match the
 *   Shopify output shape (SVG + <use>) so themes that rely on the
 *   inline-SVG styling trick keep working.
 *
 * The unknown payment types (merchant adds a custom gateway icon)
 * are NOT rejected — we pass the type through unchanged so the SVG
 * just won't load, matching Shopify's behaviour where an unknown
 * type URL 404s silently rather than breaking the page render.
 *
 * This file does NOT register filters that belong elsewhere:
 *   - `t` / `translate`     → i18n.ts
 *   - `asset_url` etc.      → image.ts
 */

import type { Liquid } from 'liquidjs'
import type { AssetUrlBuilder } from '../assets/asset-url-builder.js'

function toStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Slugify a raw payment-type string to the safe filename we use for
 * the SVG file. Shopify accepts inputs like `american_express` or
 * `AMERICAN EXPRESS`; we normalize to lowercase + underscores.
 */
function slugifyPaymentType(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Build the URL for a payment icon SVG via the injected builder.
 * Pulled out so both filters share the same path logic.
 */
function paymentIconUrl(builder: AssetUrlBuilder, type: string): string {
  const slug = slugifyPaymentType(type)
  if (!slug) return ''
  // Payment icons live under `payment_icons/` on the global asset
  // origin. In dev this is `/global/payment_icons/visa.svg`; in
  // production the builder rewrites to the CDN origin with a
  // cache-bust token.
  return builder.globalAssetUrl(`payment_icons/${slug}.svg`)
}

/**
 * Register payment/form filters on a Liquid instance. The builder is
 * captured in a closure so the filters can produce CDN URLs without
 * the engine having to look up an env variable on every call.
 */
export function registerFormFilters(
  liquid: Liquid,
  builder: AssetUrlBuilder,
): void {
  liquid.registerFilter('payment_type_img_url', (type: unknown): string => {
    return paymentIconUrl(builder, toStr(type))
  })

  liquid.registerFilter('payment_type_svg_tag', (type: unknown): string => {
    const raw = toStr(type)
    const url = paymentIconUrl(builder, raw)
    if (!url) return ''
    const slug = slugifyPaymentType(raw)
    // Matches the Shopify output shape: inline SVG with a <use> that
    // references the external file by fragment, so CSS rules like
    // `.payment-icon { color: #666 }` cascade into the icon path.
    return (
      `<svg class="payment-icon payment-icon--${htmlEscape(slug)}" ` +
      `role="img" aria-label="${htmlEscape(raw)}">` +
      `<use href="${htmlEscape(url)}#${htmlEscape(slug)}" />` +
      `</svg>`
    )
  })
}
