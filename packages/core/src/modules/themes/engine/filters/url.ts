/**
 * Gbox Platform — Shopify-compatible URL Filters
 *
 * Decision #1 Step 1.4 + Step 1.8 cleanup — URL-building filter set.
 * These produce the URLs Shopify themes expect: product URLs,
 * collection URLs, link_to anchors.
 *
 * Filters in this file:
 *
 *   url_encode              → encodeURIComponent
 *   url_decode              → decodeURIComponent
 *   url_escape              → encodeURI + stricter reserved-char escape
 *   url_param_escape        → encodeURIComponent but preserve '+'
 *   link_to                 → '<a href="{url}">{label}</a>'
 *   link_to_type            → '<a href="/collections/types?q=X">X</a>'
 *   link_to_vendor          → '<a href="/collections/vendors?q=X">X</a>'
 *   within                  → build a product URL scoped to a collection
 *                             ({{ product | within: collection }})
 *
 * IMAGE + ASSET URL FILTERS moved to `./image.ts` in Step 1.8. They
 * need an `AssetUrlBuilder` closure, so they're registered separately
 * by `registerImageFilters(liquid, builder)`. The filter names
 * (`asset_url`, `img_url`, `stylesheet_tag`, ...) are unchanged —
 * just registered from a different file.
 *
 * The URLs use Shopify-style paths by default:
 *   /products/{slug}
 *   /collections/{slug}
 *   /collections/{collection_slug}/products/{slug}
 *
 * The storefront router (Step 1.14) registers these exact paths so
 * the URLs built here actually resolve.
 */

import type { Liquid } from 'liquidjs'

function toStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  return String(v)
}

/**
 * Pick a slug off an object that might be a product/collection drop
 * or just a string. Lets themes write `{{ product | link_to: 'Buy' }}`.
 */
function slugOf(v: any): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  return toStr(v.slug ?? v.handle ?? '')
}

function titleOf(v: any): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  return toStr(v.title ?? v.name ?? '')
}

// ---------------------------------------------------------------------------
// URL encoding variants
// ---------------------------------------------------------------------------

function urlEscape(s: string): string {
  // encodeURI leaves reserved chars alone; encodeURIComponent escapes
  // them. Shopify's `url_escape` is closer to encodeURI but also
  // escapes `#` and `?`.
  return encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

function urlParamEscape(s: string): string {
  // Shopify's filter escapes everything encodeURIComponent would,
  // except `+` is preserved (matches form-url-encoded conventions).
  return encodeURIComponent(s).replace(/%2B/g, '+')
}

// ---------------------------------------------------------------------------
// link_to family
// ---------------------------------------------------------------------------

/**
 * `{{ 'Label' | link_to: '/url', 'title attr' }}`  →  '<a href="/url" title="title attr">Label</a>'
 * Shopify HTML-escapes the label in the output; we do the same.
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function linkTo(label: unknown, url: unknown, title?: unknown): string {
  const l = htmlEscape(toStr(label))
  const u = htmlEscape(toStr(url))
  const t = title != null ? ` title="${htmlEscape(toStr(title))}"` : ''
  return `<a href="${u}"${t}>${l}</a>`
}

function linkToType(typeLabel: unknown): string {
  const s = toStr(typeLabel)
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const url = `/collections/types?q=${encodeURIComponent(s)}`
  return `<a href="${url}" title="${htmlEscape(s)}">${htmlEscape(s)}</a>`.replace(
    /title="[^"]*"/,
    `title="${htmlEscape(s)}"`,
  ).replace('{slug}', slug) // slug unused currently; kept for future namespacing
}

function linkToVendor(vendorLabel: unknown): string {
  const s = toStr(vendorLabel)
  const url = `/collections/vendors?q=${encodeURIComponent(s)}`
  return `<a href="${url}" title="${htmlEscape(s)}">${htmlEscape(s)}</a>`
}

// ---------------------------------------------------------------------------
// within — product URL scoped to a collection
// ---------------------------------------------------------------------------

/**
 * `{{ product | within: collection }}` →
 *     "/collections/{collection.slug}/products/{product.slug}"
 *
 * Used by collection pages to preserve the browse context as the
 * visitor clicks into a product.
 */
function within(product: unknown, collection: unknown): string {
  const pSlug = slugOf(product)
  const cSlug = slugOf(collection)
  if (!pSlug) return ''
  if (!cSlug) return `/products/${pSlug}`
  return `/collections/${cSlug}/products/${pSlug}`
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerUrlFilters(liquid: Liquid): void {
  liquid.registerFilter('url_encode', (v) => encodeURIComponent(toStr(v)))
  liquid.registerFilter('url_decode', (v) => {
    try {
      return decodeURIComponent(toStr(v))
    } catch {
      // Shopify silently returns the original string on malformed input.
      return toStr(v)
    }
  })
  liquid.registerFilter('url_escape', (v) => urlEscape(toStr(v)))
  liquid.registerFilter('url_param_escape', (v) => urlParamEscape(toStr(v)))

  liquid.registerFilter('link_to', linkTo)
  liquid.registerFilter('link_to_type', linkToType)
  liquid.registerFilter('link_to_vendor', linkToVendor)

  liquid.registerFilter('within', within)
}
