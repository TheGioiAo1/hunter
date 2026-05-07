/**
 * Gbox Platform — SEO meta-tag builders (Stage 3D.4)
 *
 * Pure functions that emit head-tag strings: canonical links,
 * OpenGraph properties, Twitter Card properties, and the combined
 * "everything" helper used by the default theme's `<head>` partial.
 *
 * Output shape: one tag per line, no indentation, no trailing
 * newline. Consumers concat directly into a Liquid `{{ seo_meta }}`
 * variable, so adding indentation here would leak into the
 * rendered page source.
 *
 * Escaping: every value is run through `escapeHtml` which encodes
 * `&`, `<`, `>`, `"`, and `'`. That's enough to make the content
 * safe inside a double-quoted attribute; we do NOT additionally
 * strip tags because these helpers are called with values sourced
 * from the shop's own CMS (product titles, shop settings). The
 * higher layer is responsible for not feeding in full HTML blobs.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetaTagInput {
  /** Page title. Used for og:title and twitter:title (NOT `<title>`). */
  title: string
  /** Short description — meta description + OG / Twitter description. */
  description: string
  /** Absolute canonical URL. Use buildCanonicalUrl() to produce this. */
  canonical: string
  /** Fully qualified image URL. Omits og/twitter image tags when null. */
  imageUrl: string | null
  /** Shop / site display name. */
  siteName: string
  /**
   * OpenGraph type. Defaults to `website`. Use `product` on PDPs,
   * `article` on blog posts, `website` for the homepage.
   */
  type?: 'website' | 'product' | 'article' | string
  /** BCP-47 / Facebook locale, e.g. `en_US`. */
  locale?: string
  /** Twitter account handle (with or without leading @). */
  twitterHandle?: string | null
  /**
   * When false, emits `<meta name="robots" content="noindex, nofollow">`.
   * When true or unset, no robots tag is emitted. Used on search
   * result pages, customer account pages, etc.
   */
  index?: boolean
}

// ---------------------------------------------------------------------------
// Canonical URL helpers
// ---------------------------------------------------------------------------

/**
 * Build an absolute canonical URL from a baseUrl and a path. Strips
 * the Gbox-internal preview params (`preview_theme_id`, `design_mode`)
 * so theme-editor requests don't leak into the canonical form.
 */
export function buildCanonicalUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const rawPath = path.startsWith('/') ? path : `/${path}`
  // Split path + query so we can filter query params.
  const qIdx = rawPath.indexOf('?')
  if (qIdx === -1) return `${base}${rawPath}`

  const pathOnly = rawPath.slice(0, qIdx)
  const queryString = rawPath.slice(qIdx + 1)
  const params = new URLSearchParams(queryString)
  params.delete('preview_theme_id')
  params.delete('design_mode')
  const cleaned = params.toString()
  return cleaned ? `${base}${pathOnly}?${cleaned}` : `${base}${pathOnly}`
}

/**
 * `<link rel="canonical" href="…">` tag. The URL is HTML-escaped so
 * a stray quote in the input can't break the attribute.
 */
export function buildCanonicalLinkTag(canonicalUrl: string): string {
  return `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`
}

// ---------------------------------------------------------------------------
// OpenGraph
// ---------------------------------------------------------------------------

export function buildOpenGraphTags(input: MetaTagInput): string {
  const lines: string[] = []
  const ogType = input.type ?? 'website'
  lines.push(ogTag('og:title', input.title))
  lines.push(ogTag('og:description', input.description))
  lines.push(ogTag('og:url', input.canonical))
  lines.push(ogTag('og:site_name', input.siteName))
  lines.push(ogTag('og:type', ogType))
  if (input.locale) lines.push(ogTag('og:locale', input.locale))
  if (input.imageUrl) lines.push(ogTag('og:image', input.imageUrl))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Twitter Cards
// ---------------------------------------------------------------------------

export function buildTwitterCardTags(input: MetaTagInput): string {
  const lines: string[] = []
  const card = input.imageUrl ? 'summary_large_image' : 'summary'
  lines.push(twTag('twitter:card', card))
  if (input.twitterHandle) {
    const handle = input.twitterHandle.startsWith('@')
      ? input.twitterHandle
      : `@${input.twitterHandle}`
    lines.push(twTag('twitter:site', handle))
  }
  lines.push(twTag('twitter:title', input.title))
  lines.push(twTag('twitter:description', input.description))
  if (input.imageUrl) lines.push(twTag('twitter:image', input.imageUrl))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// buildMetaTags — the combined "everything" helper
// ---------------------------------------------------------------------------

/**
 * Returns one big string containing every head tag the storefront
 * needs: meta description, canonical, OG set, Twitter set, and an
 * optional robots noindex tag.
 *
 * Use this from the theme's `<head>` include. The output is safe
 * to inject directly — every value has been HTML-escaped.
 */
export function buildMetaTags(input: MetaTagInput): string {
  const lines: string[] = []
  lines.push(
    `<meta name="description" content="${escapeHtml(input.description)}">`,
  )
  lines.push(buildCanonicalLinkTag(input.canonical))
  if (input.index === false) {
    lines.push('<meta name="robots" content="noindex, nofollow">')
  }
  lines.push(buildOpenGraphTags(input))
  lines.push(buildTwitterCardTags(input))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ogTag(property: string, content: string): string {
  return `<meta property="${property}" content="${escapeHtml(content)}">`
}

function twTag(name: string, content: string): string {
  return `<meta name="${name}" content="${escapeHtml(content)}">`
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
