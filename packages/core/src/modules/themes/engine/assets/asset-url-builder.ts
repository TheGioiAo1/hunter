/**
 * Gbox Platform — AssetUrlBuilder
 *
 * Decision #1 Step 1.8 — The production-grade URL builder that turns
 * filenames and image drops into the correct CDN URL for a given
 * shop/theme. This replaces the placeholder `assetUrlStub` /
 * `imgUrlStub` functions from Step 1.4's url.ts.
 *
 * Why a separate service and not inline in the filter?
 *
 *   - The URL scheme varies between dev (relative `/assets/foo.css`),
 *     preview (Cloudflare Workers edge CDN), and production (R2
 *     bucket fronted by Cloudflare with Image Resizing). A swappable
 *     builder lets the same filter code run in every environment.
 *   - Tests can inject a deterministic builder (e.g. `/theme-cdn`)
 *     instead of mocking network calls.
 *   - Step 1.17 replaces the Nunjucks engine; the builder is reusable
 *     by non-Liquid code paths (email rendering, sitemap, feeds).
 *
 * Three asset classes, three base URLs:
 *
 *   1. THEME assets — CSS/JS/SVG/font files bundled with a theme
 *      version. Upload path: admin → theme editor → `theme_assets`
 *      table (text) or R2 (binary). Public URL path: served via the
 *      storefront router which proxies from R2.
 *
 *   2. FILE assets — merchant uploads (product images, blog post
 *      images, PDF downloads). Upload path: admin → files page →
 *      `files` table + R2 object. Public URL path: CDN with image
 *      transforms.
 *
 *   3. GLOBAL assets — platform-level resources (frontend JS bundle
 *      for cart/search, web font subsets, shared SVGs). Served from
 *      a platform-owned origin, NOT tenant-scoped.
 *
 * Shopify image sizing conventions we honour:
 *
 *   - Named sizes: pico (16), icon (32), thumb (50), small (100),
 *     compact (160), medium (240), large (480), grande (600),
 *     original/master (no transform).
 *
 *   - WxH strings: `'300x'` (width only), `'x400'` (height only),
 *     `'300x400'` (both). Parsed by `parseSizeToken`.
 *
 *   - Crop modifier: `'300x400_crop_center'` or the structured form
 *     `{ width: 300, height: 400, crop: 'center' }`. Shopify supports
 *     center/top/bottom/left/right.
 *
 *   - Output URL pattern: Shopify inserts the size suffix before the
 *     file extension: `shirt.jpg` + `300x` → `shirt_300x.jpg`. We
 *     match that exactly so themes ported from Shopify render
 *     pixel-identical URLs.
 *
 *   - A cache-busting `?v=` query string is appended when the builder
 *     is constructed with a `cacheBustToken` (usually the theme
 *     updated_at timestamp). Absent → no query string, so asset
 *     URLs are deterministic across renders for easier diffing in
 *     snapshot tests.
 *
 * Non-goals (handled elsewhere):
 *
 *   - Actual image resizing. Production plugs Cloudflare Image
 *     Resizing at the CDN edge; the builder only produces the URL.
 *   - Signed URLs for private files. Step 2.x adds a separate
 *     `SignedUrlBuilder` for downloads that require auth.
 *   - Absolute vs relative URL negotiation. The builder always emits
 *     what its base URLs say — if you want `//cdn.gbox.co/...`
 *     instead of `/assets/...`, construct the builder with
 *     `{ themeAssetBase: 'https://cdn.gbox.co/assets' }`.
 */

// ---------------------------------------------------------------------------
// Image input shape
// ---------------------------------------------------------------------------

/**
 * What Shopify themes might pass to an image filter. Strings are
 * used as-is; objects are unwrapped via a fallback chain so the
 * common Shopify drop shapes (`product`, `article`, `image`,
 * `variant.featured_image`, etc.) all work without templates having
 * to call the right property.
 */
export type ImageInput =
  | string
  | null
  | undefined
  | {
      src?: string
      url?: string
      image_url?: string
      image?: ImageInput
      featured_image?: ImageInput
      [key: string]: unknown
    }

// ---------------------------------------------------------------------------
// Size tokens
// ---------------------------------------------------------------------------

/** Structured image size — intermediate between the filter and the URL. */
export interface ImageSize {
  width?: number
  height?: number
  crop?: 'center' | 'top' | 'bottom' | 'left' | 'right'
}

/**
 * Shopify's named sizes. Values taken from the public Shopify image
 * URL documentation. If a Shopify version introduces new named sizes
 * we add them here without touching the filter layer.
 */
const NAMED_SIZES: Readonly<Record<string, ImageSize>> = Object.freeze({
  pico: { width: 16, height: 16 },
  icon: { width: 32, height: 32 },
  thumb: { width: 50, height: 50 },
  small: { width: 100, height: 100 },
  compact: { width: 160, height: 160 },
  medium: { width: 240, height: 240 },
  large: { width: 480, height: 480 },
  grande: { width: 600, height: 600 },
  original: {},
  master: {},
})

/** Valid crop modifier names. */
const CROP_MODES = new Set(['center', 'top', 'bottom', 'left', 'right'] as const)

/**
 * Parse a Shopify-style size token into an `ImageSize`. Returns
 * `undefined` if the input is empty/undefined, which the builder
 * treats as "no transform".
 *
 * Accepted forms:
 *
 *   - `'medium'`            → `{ width: 240, height: 240 }`
 *   - `'300x'`              → `{ width: 300 }`
 *   - `'x400'`              → `{ height: 400 }`
 *   - `'300x400'`           → `{ width: 300, height: 400 }`
 *   - `'300x400_crop_center'` → `{ width: 300, height: 400, crop: 'center' }`
 *
 * Any other string returns `undefined` — the filter then falls back
 * to the original URL without a size suffix.
 */
export function parseSizeToken(token: string | undefined): ImageSize | undefined {
  if (!token) return undefined
  if (token in NAMED_SIZES) return { ...NAMED_SIZES[token] }

  // Split off `_crop_X` suffix if present.
  let dims = token
  let crop: ImageSize['crop'] | undefined
  const cropMatch = /^(.*)_crop_([a-z]+)$/.exec(token)
  if (cropMatch) {
    dims = cropMatch[1]
    const cropName = cropMatch[2] as ImageSize['crop']
    if (cropName && CROP_MODES.has(cropName)) crop = cropName
    else return undefined // unknown crop name → reject whole token
  }

  // WxH form.
  const m = /^(\d*)x(\d*)$/.exec(dims)
  if (!m) return undefined
  const width = m[1] ? Number(m[1]) : undefined
  const height = m[2] ? Number(m[2]) : undefined
  if (width === undefined && height === undefined) return undefined
  return { width, height, crop }
}

// ---------------------------------------------------------------------------
// AssetUrlBuilder interface
// ---------------------------------------------------------------------------

/**
 * The contract every URL builder must honour. The Liquid filter set
 * depends on this interface, not the concrete class, so production
 * can swap in a Cloudflare-specific or Imgproxy-specific builder
 * without touching the filter layer.
 */
export interface AssetUrlBuilder {
  /** URL for a theme-bundled asset (CSS/JS/SVG/font). */
  assetUrl(file: string): string

  /** URL for a platform-global asset. */
  globalAssetUrl(file: string): string

  /** URL for a merchant-uploaded file. */
  fileUrl(file: string): string

  /**
   * URL for an image, optionally resized. `image` can be a string or
   * an object with any of the common Shopify image drop fields.
   * `size` may be a Shopify size token string, a structured
   * `ImageSize`, or omitted (= original).
   */
  imgUrl(image: ImageInput, size?: string | ImageSize): string

  /**
   * URL for a theme-bundled image with optional resizing. Equivalent
   * to `assetUrl(file)` then applying a size suffix.
   */
  assetImgUrl(file: string, size?: string | ImageSize): string

  /**
   * URL for a merchant-uploaded image with optional resizing.
   * Equivalent to `fileUrl(file)` then applying a size suffix.
   */
  fileImgUrl(file: string, size?: string | ImageSize): string
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

export interface DefaultAssetUrlBuilderOptions {
  /** Base URL for theme assets. Default `/assets`. */
  themeAssetBase?: string
  /** Base URL for merchant-uploaded files. Default `/cdn/files`. */
  fileBase?: string
  /** Base URL for platform-global assets. Default `/global`. */
  globalAssetBase?: string
  /**
   * Cache-busting token appended as `?v=<token>` to every URL. Set
   * to the theme's `updated_at` ISO string for automatic cache
   * invalidation on theme upgrade. Default `undefined` (no query).
   */
  cacheBustToken?: string
}

/**
 * Default builder. Produces Shopify-compatible URLs suitable for the
 * dev server, local tests, and the Node VPS production path (which
 * proxies these paths to R2 via the storefront router). Cloudflare
 * preview deployments can inject a different builder via
 * `createLiquidEngine({ assetUrlBuilder })`.
 */
export class DefaultAssetUrlBuilder implements AssetUrlBuilder {
  private readonly themeAssetBase: string
  private readonly fileBase: string
  private readonly globalAssetBase: string
  private readonly cacheBustQuery: string

  constructor(opts: DefaultAssetUrlBuilderOptions = {}) {
    this.themeAssetBase = stripTrailingSlash(opts.themeAssetBase ?? '/assets')
    this.fileBase = stripTrailingSlash(opts.fileBase ?? '/cdn/files')
    this.globalAssetBase = stripTrailingSlash(opts.globalAssetBase ?? '/global')
    this.cacheBustQuery = opts.cacheBustToken
      ? `?v=${encodeURIComponent(opts.cacheBustToken)}`
      : ''
  }

  assetUrl(file: string): string {
    return this.withCacheBust(joinUrl(this.themeAssetBase, file))
  }

  globalAssetUrl(file: string): string {
    return this.withCacheBust(joinUrl(this.globalAssetBase, file))
  }

  fileUrl(file: string): string {
    return this.withCacheBust(joinUrl(this.fileBase, file))
  }

  imgUrl(image: ImageInput, size?: string | ImageSize): string {
    const raw = resolveImageUrl(image)
    if (!raw) return ''
    // Absolute URLs are used as-is — merchants linking an external
    // image host (Instagram, Unsplash, etc.) don't get their URL
    // rewritten. We still apply the size suffix so Shopify-style
    // dynamic sizing works on CDN-like hosts.
    const parsed = parseSize(size)
    const sized = parsed ? applySizeSuffix(raw, parsed) : raw
    // Only apply cache-bust to URLs we own. An external absolute URL
    // (`https://images.unsplash.com/...`) shouldn't have our theme
    // cache-bust token grafted onto it — that's meaningless and can
    // break signed-URL CDNs that reject unknown query params.
    if (isAbsoluteUrl(sized) && !this.isOwnUrl(sized)) return sized
    return this.withCacheBust(sized)
  }

  assetImgUrl(file: string, size?: string | ImageSize): string {
    const parsed = parseSize(size)
    const base = joinUrl(this.themeAssetBase, file)
    const sized = parsed ? applySizeSuffix(base, parsed) : base
    return this.withCacheBust(sized)
  }

  fileImgUrl(file: string, size?: string | ImageSize): string {
    const parsed = parseSize(size)
    const base = joinUrl(this.fileBase, file)
    const sized = parsed ? applySizeSuffix(base, parsed) : base
    return this.withCacheBust(sized)
  }

  /**
   * Is `url` served by one of our configured bases? Used by `imgUrl`
   * to decide whether to apply the cache-bust token — we only want to
   * add it to URLs we actually own, not third-party hosts.
   */
  private isOwnUrl(url: string): boolean {
    const bases = [this.themeAssetBase, this.fileBase, this.globalAssetBase]
    return bases.some(
      (b) => b && isAbsoluteUrl(b) && url.startsWith(b),
    )
  }

  /**
   * Append the cache-bust query to a URL, preserving any existing
   * query string. Private; exposed via the URL methods.
   */
  private withCacheBust(url: string): string {
    if (!this.cacheBustQuery || !url) return url
    // Don't double-append if someone already added a `?v=`.
    if (url.includes('?v=') || url.includes('&v=')) return url
    return url.includes('?')
      ? `${url}&${this.cacheBustQuery.slice(1)}`
      : `${url}${this.cacheBustQuery}`
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-private, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Strip a trailing slash from a base URL so `joinUrl` can safely add
 * its own slash. Leaves an empty string alone.
 */
export function stripTrailingSlash(s: string): string {
  if (!s) return s
  return s.endsWith('/') ? s.slice(0, -1) : s
}

/**
 * Strip a leading slash from a path segment. Same reason as above.
 */
function stripLeadingSlash(s: string): string {
  if (!s) return s
  return s.startsWith('/') ? s.slice(1) : s
}

/**
 * Join a base URL and a path. Absolute inputs (`http://...`,
 * `https://...`, `//cdn.x.y/...`) are returned as-is, ignoring the
 * base. This lets merchants drop external URLs into theme settings
 * without them getting rewritten.
 */
export function joinUrl(base: string, path: string): string {
  if (!path) return base
  if (isAbsoluteUrl(path)) return path
  const cleanBase = stripTrailingSlash(base)
  const cleanPath = stripLeadingSlash(path)
  if (!cleanBase) return '/' + cleanPath
  return `${cleanBase}/${cleanPath}`
}

function isAbsoluteUrl(s: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(s)
}

/**
 * Coerce an `ImageInput` (string | drop | null) to a raw URL string.
 * Walks through the common Shopify drop field names in order:
 * `src` → `url` → `image_url` → `image` → `featured_image`. Returns
 * `''` if nothing matches.
 */
export function resolveImageUrl(image: ImageInput): string {
  if (!image) return ''
  if (typeof image === 'string') return image
  if (typeof image !== 'object') return ''
  if (typeof image.src === 'string' && image.src) return image.src
  if (typeof image.url === 'string' && image.url) return image.url
  if (typeof image.image_url === 'string' && image.image_url) return image.image_url
  // Recursive fallbacks — `image` might itself be a drop with `.src`,
  // and `featured_image` might be a drop (product → variant pattern).
  if (image.image) return resolveImageUrl(image.image)
  if (image.featured_image) return resolveImageUrl(image.featured_image)
  return ''
}

/**
 * Normalize a size input (string token or structured ImageSize) into
 * a canonical ImageSize or `undefined` when no size was requested.
 */
function parseSize(size?: string | ImageSize): ImageSize | undefined {
  if (size === undefined || size === null) return undefined
  if (typeof size === 'string') return parseSizeToken(size)
  // Structured input — copy to an own object to avoid mutating caller state.
  const out: ImageSize = {}
  if (typeof size.width === 'number' && size.width > 0) out.width = size.width
  if (typeof size.height === 'number' && size.height > 0) out.height = size.height
  if (size.crop && CROP_MODES.has(size.crop)) out.crop = size.crop
  if (out.width === undefined && out.height === undefined) return undefined
  return out
}

/**
 * Hosts known NOT to support Shopify-style `_WxH` resize suffixes —
 * appending `_300x300` to a URL like `<sha1>.jpg` produces a 404 there.
 *
 * The v6 S3 bucket (and any other content-addressed direct-S3 store)
 * goes here. For any URL matching this list we return the original
 * and let the browser scale via the `width`/`height` attributes the
 * theme already sets.
 *
 * Default behaviour (anything not matched) PRESERVES the suffix —
 * Shopify CDN, our own `/clone-assets/` mirror, etc. all auto-resize
 * and the existing themes assume that.
 */
const NON_RESIZE_HOST_RE = /(?:^https?:\/\/[^/]*\.s3[.-][^/]+\.amazonaws\.com|gbox-clone-storage|\.cloudfront\.net)/i
function hostSkipsResizeSuffix(url: string): boolean {
  return NON_RESIZE_HOST_RE.test(url)
}

/**
 * Apply a Shopify-style size suffix to a URL. `shirt.jpg` + 300x →
 * `shirt_300x.jpg`. Preserves the query string. If the URL has no
 * recognizable extension (e.g. a REST endpoint), returns the original
 * so we don't corrupt it.
 *
 * For URLs hosted on backends that don't support the suffix (notably
 * the v6 S3 bucket), returns the original URL unchanged — the
 * resized variant doesn't exist and would 404 if requested.
 */
export function applySizeSuffix(url: string, size: ImageSize): string {
  const { width, height, crop } = size
  if (width === undefined && height === undefined) return url

  // Skip the suffix on hosts that don't auto-resize (e.g. v6 S3 bucket).
  // Browser will scale the original image via <img width=… height=…> instead.
  if (hostSkipsResizeSuffix(url)) return url

  // Split off query string / fragment before operating on the path.
  let path = url
  let tail = ''
  const qIdx = url.search(/[?#]/)
  if (qIdx >= 0) {
    path = url.slice(0, qIdx)
    tail = url.slice(qIdx)
  }

  // Find the last segment's extension.
  const dot = path.lastIndexOf('.')
  const lastSlash = path.lastIndexOf('/')
  if (dot <= lastSlash || dot < 0) {
    // No extension on the last segment — can't insert a suffix.
    return url
  }

  const dims = `${width ?? ''}x${height ?? ''}`
  const cropSuffix = crop ? `_crop_${crop}` : ''
  const withSuffix = `${path.slice(0, dot)}_${dims}${cropSuffix}${path.slice(dot)}`
  return withSuffix + tail
}
