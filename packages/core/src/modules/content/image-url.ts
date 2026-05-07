/**
 * Content — Image URL helper (Phase 4.3.4 + Phase B imgproxy bridge)
 *
 * Product images are currently served as raw DB-stored paths. To scale:
 *
 *   1. Use a single source of truth (CDN) for URL generation so
 *      switching providers (Cloudflare Images, Bunny, imgix, self-hosted)
 *      is a one-line change instead of 40 scattered sites.
 *   2. Emit hashed / versioned URLs so we can return
 *      `Cache-Control: public, max-age=31536000, immutable` headers
 *      without invalidation pain.
 *   3. Allow callers to request responsive transforms via a `{width,
 *      height, format}` option bag without knowing the backend syntax.
 *
 * Backend selection is driven by `GBOX_IMAGE_CDN` env var:
 *
 *   unset              → passthrough (serve the original URL unchanged)
 *   'imgproxy'         → https://cdn.gbox.co/img/<sig>/rs:fill:800:0/...
 *                        (Phase B — self-hosted imgproxy, spec §11)
 *   'cloudflare'       → https://images.gbox.co/cdn-cgi/image/w=400,f=webp/<src>
 *   'imgix'            → https://gbox.imgix.net/<src>?w=400&auto=format
 *   'local'            → /media/<hash>/<width>w/<filename>.<format>
 *
 * Production default: `imgproxy` once `IMGPROXY_KEY`/`IMGPROXY_SALT` are
 * configured. Until then, callers that set `GBOX_IMAGE_CDN=imgproxy`
 * without the keys fall back to passthrough so dev environments don't
 * break.
 */

import { cdnImage } from '../media/cdn.js'

export interface ImageTransformOptions {
  width?: number
  height?: number
  format?: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png'
  quality?: number // 1-100
  fit?: 'cover' | 'contain' | 'crop' | 'scale-down'
}

/** Shape of a product_images row (only the fields we care about). */
export interface ImageRecord {
  src: string
  alt?: string | null
  width?: number | null
  height?: number | null
  updated_at?: string | null
}

// ---------------------------------------------------------------------------
// Provider dispatch
// ---------------------------------------------------------------------------

export function imageUrl(
  image: ImageRecord | string,
  opts: ImageTransformOptions = {},
): string {
  const src = typeof image === 'string' ? image : image.src
  if (!src) return ''

  // Already an absolute URL we don't own — passthrough.
  if (/^data:/.test(src)) return src

  const provider = (process.env.GBOX_IMAGE_CDN || 'passthrough').toLowerCase()

  switch (provider) {
    case 'imgproxy':
      return imgproxyUrl(image, opts)
    case 'cloudflare':
      return cloudflareUrl(src, opts)
    case 'imgix':
      return imgixUrl(src, opts)
    case 'local':
      return localUrl(src, opts)
    case 'passthrough':
    default:
      return passthroughUrl(src, opts)
  }
}

/**
 * Return a versioned URL that is safe to send with immutable cache
 * headers. The version query param flips whenever the DB row's
 * updated_at changes, so clients that had the old image evict it
 * naturally.
 */
export function versionedImageUrl(
  image: ImageRecord,
  opts: ImageTransformOptions = {},
): string {
  const base = imageUrl(image, opts)
  const version = versionOf(image)
  if (!version) return base
  return base + (base.includes('?') ? '&' : '?') + 'v=' + version
}

/**
 * Headers to set on image responses served by our own origin. Use only
 * for hashed/versioned assets — never for HTML pages.
 */
export const IMMUTABLE_IMAGE_HEADERS: Record<string, string> = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  Vary: 'Accept',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * Build a `srcset` attribute string for responsive images. Typical call:
 *
 *   <img src={imageUrl(image, {width: 800})}
 *        srcSet={imageSrcSet(image, [400, 800, 1200])} />
 */
export function imageSrcSet(
  image: ImageRecord,
  widths: number[],
  opts: Omit<ImageTransformOptions, 'width'> = {},
): string {
  return widths
    .map((w) => `${imageUrl(image, { ...opts, width: w })} ${w}w`)
    .join(', ')
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

function passthroughUrl(src: string, opts: ImageTransformOptions): string {
  // With no CDN, transform opts are ignored. Still return the src as-is
  // so callers don't have to branch on env.
  void opts
  return src
}

/**
 * Phase B — route through the self-hosted imgproxy pipeline at
 * `cdn.gbox.co/img/...`. Delegates to `cdnImage()` which owns the
 * HMAC signing + width bucketing + variants_json shortcut.
 *
 * Gracefully degrades to passthrough if `IMGPROXY_KEY` / `IMGPROXY_SALT`
 * are not configured — dev laptops without secrets still render images.
 */
function imgproxyUrl(
  image: ImageRecord | string,
  opts: ImageTransformOptions,
): string {
  return cdnImage(image as any, {
    width: opts.width,
    height: opts.height,
    format: opts.format,
    quality: opts.quality,
    fit: mapLegacyFit(opts.fit),
  })
}

/**
 * Legacy `ImageTransformOptions.fit` accepts `'crop'` + `'scale-down'`
 * which don't exist in imgproxy's vocabulary. Map to the closest
 * equivalent so call sites don't have to care.
 */
function mapLegacyFit(
  fit?: ImageTransformOptions['fit'],
): 'cover' | 'contain' | 'fill' | 'inside' | 'outside' | undefined {
  switch (fit) {
    case 'crop':
      return 'cover'
    case 'scale-down':
      return 'inside'
    case 'cover':
    case 'contain':
    case undefined:
      return fit
    default:
      return undefined
  }
}

function cloudflareUrl(src: string, opts: ImageTransformOptions): string {
  const base = process.env.GBOX_CDN_BASE || 'https://images.gbox.co'
  const parts: string[] = []
  if (opts.width) parts.push(`w=${opts.width}`)
  if (opts.height) parts.push(`h=${opts.height}`)
  if (opts.format && opts.format !== 'auto') parts.push(`f=${opts.format}`)
  else parts.push('f=auto')
  if (opts.quality) parts.push(`q=${Math.max(1, Math.min(100, opts.quality))}`)
  if (opts.fit) parts.push(`fit=${opts.fit}`)
  const transform = parts.join(',')
  // Cloudflare Image Resizing path: /cdn-cgi/image/<params>/<original>
  const clean = src.replace(/^https?:\/\/[^/]+/, '')
  return `${base}/cdn-cgi/image/${transform}${clean.startsWith('/') ? '' : '/'}${clean}`
}

function imgixUrl(src: string, opts: ImageTransformOptions): string {
  const base = process.env.GBOX_CDN_BASE || 'https://gbox.imgix.net'
  const u = new URL(base + (src.startsWith('/') ? src : '/' + src))
  if (opts.width) u.searchParams.set('w', String(opts.width))
  if (opts.height) u.searchParams.set('h', String(opts.height))
  if (opts.quality) u.searchParams.set('q', String(opts.quality))
  u.searchParams.set('auto', 'format,compress')
  return u.toString()
}

function localUrl(src: string, opts: ImageTransformOptions): string {
  // Placeholder for a local /media/<hash>/<width>w/<filename> scheme.
  // Not wired yet — returns the passthrough URL plus transform hints as
  // query params that can be interpreted by an on-origin transformer.
  const qs: string[] = []
  if (opts.width) qs.push(`w=${opts.width}`)
  if (opts.format) qs.push(`f=${opts.format}`)
  return qs.length > 0 ? `${src}?${qs.join('&')}` : src
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function versionOf(image: ImageRecord): string | null {
  if (!image.updated_at) return null
  // Short hash of the updated_at to keep URLs readable.
  let h = 0
  for (let i = 0; i < image.updated_at.length; i++) {
    h = (h * 31 + image.updated_at.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}
