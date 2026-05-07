/**
 * Gbox Platform — SEO JSON-LD builders (Stage 3D.3)
 *
 * Pure functions that emit schema.org structured data as JSON
 * strings ready to drop inside a `<script type="application/ld+json">`
 * tag. No DB, no HTTP, no async — every function takes a narrow
 * input shape and returns a string.
 *
 * Why narrow input types (not ShopData / ProductData)?
 *
 *   These helpers are consumed by Liquid filters and by the SEO
 *   runtime that injects structured data into the `<head>`. Both
 *   callers already hold fully hydrated drops; bending the helpers
 *   to the drop shape would tie SEO forever to the theme engine's
 *   internal types. Narrow shapes keep the contract stable and
 *   testable in isolation.
 *
 * Why hand-stringified JSON (not JSON.stringify of a builder object)?
 *
 *   We DO use JSON.stringify. But after serialising, we patch the
 *   output to escape `</` as `<\/` so the emitted JSON can't close
 *   a surrounding `<script>` tag early. That's the canonical XSS
 *   hardening for inline JSON-LD and it MUST happen in this module
 *   — callers that trust the return value will not re-escape.
 */

// ---------------------------------------------------------------------------
// Shared input types
// ---------------------------------------------------------------------------

export interface ProductJsonLdInput {
  /** Product title / name. */
  name: string
  /** URL handle, used to build the canonical product URL. */
  handle: string
  /** Long description. May contain HTML; this helper strips tags. */
  description: string | null
  /** Primary SKU (usually the default variant's SKU). */
  sku: string | null
  /** Brand / vendor name. */
  brand: string | null
  /** Price as a string so we never round-trip through floats. */
  price: string
  /** ISO 4217 currency code, e.g. 'USD'. */
  currency: string
  /** Availability flag — true = InStock, false = OutOfStock. */
  available: boolean
  /** Fully-qualified image URLs. Empty array means no image. */
  imageUrls: string[]
  /** Shop name. Currently unused in output but kept for future merchants/seller data. */
  shopName: string
  /** Base URL for building the canonical product URL in offers.url. */
  baseUrl: string
}

export interface OrganizationJsonLdInput {
  name: string
  baseUrl: string
  logoUrl: string | null
  description: string | null
  /** Social profile URLs — Twitter, Instagram, Facebook, etc. */
  sameAs?: string[]
}

export interface BreadcrumbItem {
  /** Visible label. */
  name: string
  /** Path relative to baseUrl, e.g. `/collections/hats`. */
  path: string
}

export interface BreadcrumbListJsonLdInput {
  baseUrl: string
  items: BreadcrumbItem[]
}

export interface WebSiteJsonLdInput {
  name: string
  baseUrl: string
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildProductJsonLd(input: ProductJsonLdInput): string {
  const base = normaliseBaseUrl(input.baseUrl)
  const offersUrl = `${base}/products/${input.handle}`

  // `image` is "string or array" per schema.org — prefer the bare
  // string form when there's only one image, and omit the key
  // entirely when there are none.
  let image: string | string[] | undefined
  if (input.imageUrls.length === 1) image = input.imageUrls[0]
  else if (input.imageUrls.length > 1) image = input.imageUrls

  const doc: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: input.name,
  }
  if (image !== undefined) doc.image = image
  const cleanDesc = stripHtml(input.description ?? '')
  if (cleanDesc) doc.description = cleanDesc
  if (input.sku) doc.sku = input.sku
  if (input.brand) doc.brand = { '@type': 'Brand', name: input.brand }

  doc.offers = {
    '@type': 'Offer',
    url: offersUrl,
    price: input.price,
    priceCurrency: input.currency,
    availability: input.available
      ? 'https://schema.org/InStock'
      : 'https://schema.org/OutOfStock',
  }

  return serialise(doc)
}

export function buildOrganizationJsonLd(
  input: OrganizationJsonLdInput,
): string {
  const base = normaliseBaseUrl(input.baseUrl)
  const doc: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: input.name,
    url: base,
  }
  if (input.logoUrl) doc.logo = input.logoUrl
  if (input.description) doc.description = stripHtml(input.description)
  if (input.sameAs && input.sameAs.length > 0) doc.sameAs = input.sameAs
  return serialise(doc)
}

export function buildBreadcrumbListJsonLd(
  input: BreadcrumbListJsonLdInput,
): string {
  const base = normaliseBaseUrl(input.baseUrl)
  const itemListElement = input.items.map((item, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: item.name,
    item: `${base}${item.path.startsWith('/') ? item.path : `/${item.path}`}`,
  }))
  return serialise({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement,
  })
}

export function buildWebSiteJsonLd(input: WebSiteJsonLdInput): string {
  const base = normaliseBaseUrl(input.baseUrl)
  return serialise({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: input.name,
    url: base,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${base}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Strip HTML tags and collapse whitespace. Good enough for the short
 * product blurbs shown in search snippets — Google strongly prefers
 * plaintext inside JSON-LD anyway.
 */
function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Serialise with the `</` → `<\/` escape so the JSON can be embedded
 * directly inside a `<script>` tag without ever closing it early.
 * We also escape U+2028 / U+2029 because old JSON.stringify leaves
 * them bare — most browsers accept them inside <script> but not all.
 */
function serialise(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
