/**
 * Gbox Platform — cdnImage() storefront helper
 *
 * Phase B spec §16.1.
 *
 * The canonical way the storefront (Astro + EmDash) renders image URLs.
 * Wraps the low-level imgproxy signer and adds:
 *
 *   - Input polymorphism: accepts a full media_assets row, a
 *     `{ cdn_url }`-shaped record, or a bare string.
 *   - Version/cache-busting: if the asset has an `updated_at`, we fold a
 *     short hash into the URL so a re-upload under the same key evicts
 *     cleanly.
 *   - Fallback: when `IMGPROXY_KEY`/`IMGPROXY_SALT` env is not set (dev
 *     laptop without secrets) we return a passthrough URL without
 *     transforms. Storefront still renders, just without resize.
 *
 * The storefront should ALWAYS go through `cdnImage()` — never concat
 * the CDN base manually, never call imgproxy directly. This keeps the
 * transform policy (width buckets, signed URLs, format negotiation) in
 * one place.
 *
 * Usage:
 *
 *   import { cdnImage } from '@gbox/core/media/cdn'
 *
 *   // In an Astro template:
 *   <img
 *     src={cdnImage(product.image, { width: 800 })}
 *     srcset={cdnSrcSet(product.image, [400, 800, 1200])}
 *     alt={product.image.alt ?? product.title}
 *   />
 */

import type { ImgproxyOptions } from './imgproxy.js'
import {
  readImgproxyConfigFromEnv,
  signImgproxyUrl,
  normalizeWidth,
} from './imgproxy.js'

// ---------------------------------------------------------------------------
// Asset shape — matches the `media_assets` DB row plus a few convenience
// aliases so the helper also accepts bare strings and older shapes.
// ---------------------------------------------------------------------------

/**
 * The canonical media-asset row we pass to `cdnImage`. Matches a subset
 * of the `media_assets` table (spec §14.1) + compatibility with the
 * existing `product_images` row shape.
 */
export interface MediaAssetLike {
  /**
   * Fully-qualified absolute URL of the source — either an `s3://...`
   * URI that imgproxy can fetch, or an `https://...` URL if the asset
   * is hosted outside the platform bucket.
   */
  cdn_url?: string | null

  /**
   * Back-compat alias used by the existing `product_images` table —
   * `src` can be either the relative path or the absolute CDN URL.
   */
  src?: string | null

  /**
   * Optional pre-baked variants from the ingestion worker. Keyed by
   * width (`'256'`, `'512'`, `'1024'` …) — if the caller requests a
   * matching width we can serve the pre-baked variant directly without
   * round-tripping imgproxy.
   */
  variants_json?: Record<string, string> | null

  /** Timestamp used for URL versioning (cache busting on mutation). */
  updated_at?: string | Date | null

  /** Unused by the URL builder but common on the row. */
  alt?: string | null
  width?: number | null
  height?: number | null
  dominant_color?: string | null
  blurhash?: string | null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a storefront-ready URL for an image asset.
 *
 * Provider priority:
 *   1. If the caller requested an exact width that matches a pre-baked
 *      `variants_json` entry, return that directly — skip imgproxy, skip
 *      signing, cheapest path.
 *   2. If the source is an `s3://` URI AND imgproxy env is configured,
 *      return a signed `cdn.gbox.co/img/...` URL.
 *   3. Else return the raw `cdn_url` (passthrough) — dev fallback.
 */
export function cdnImage(
  asset: MediaAssetLike | string | null | undefined,
  opts: ImgproxyOptions = {},
): string {
  const src = resolveSrc(asset)
  if (!src) return ''

  // 1. Pre-baked variant shortcut.
  if (typeof asset === 'object' && asset && asset.variants_json && opts.width) {
    const target = normalizeWidth(opts.width)
    const variant = asset.variants_json[String(target)]
    if (variant) {
      return appendVersion(variant, asset)
    }
  }

  // 2. Signed imgproxy URL — production path.
  const config = readImgproxyConfigFromEnv()
  if (config && isS3Uri(src)) {
    const url = signImgproxyUrl({ sourceUri: src, options: opts }, config)
    return appendVersion(url, asset)
  }

  // 3. Passthrough — storefront still renders, just without transforms.
  return appendVersion(src, asset)
}

/**
 * Build a responsive `srcset` string. Uses `cdnImage()` for each width
 * so the pre-baked variant shortcut applies per breakpoint.
 */
export function cdnSrcSet(
  asset: MediaAssetLike | string | null | undefined,
  widths: number[],
  opts: Omit<ImgproxyOptions, 'width'> = {},
): string {
  return widths
    .map((w) => `${cdnImage(asset, { ...opts, width: w })} ${w}w`)
    .join(', ')
}

/**
 * Return the 5 DPR-friendly URLs the storefront `<Image>` component
 * uses by default. Mirrors spec §16.2.
 */
export function defaultSrcSet(
  asset: MediaAssetLike | string | null | undefined,
  opts: Omit<ImgproxyOptions, 'width'> = {},
): string {
  return cdnSrcSet(asset, [400, 800, 1200, 1600], opts)
}

/**
 * Generate a signed URL for the theme-library bucket — the marketplace
 * uses a different path prefix (`/themes/*`). Same signer, different
 * source prefix.
 */
export function cdnThemeLibraryAsset(
  slug: string,
  version: string,
  path: string,
  opts: ImgproxyOptions = {},
): string {
  // Theme library assets often aren't images (zip, manifest.json) — only
  // sign if the caller is requesting a transform. Otherwise return the
  // direct CDN URL (Cloudflare origin rule #1 routes /themes/* to S3_THEME).
  const base = process.env.CDN_THEME_LIBRARY_BASE_URL || 'https://cdn.gbox.co'
  const key = `themes/${slug}/${version}/${path.replace(/^\//, '')}`

  const isImageRequest =
    opts.width || opts.height || opts.format || opts.quality || opts.crop || opts.fit
  if (!isImageRequest) {
    return `${base.replace(/\/+$/, '')}/${key}`
  }

  const config = readImgproxyConfigFromEnv()
  if (!config) {
    return `${base.replace(/\/+$/, '')}/${key}`
  }

  const bucket = process.env.S3_THEME_LIBRARY_BUCKET || 'gbox-theme-library-prod'
  return signImgproxyUrl({ sourceUri: `s3://${bucket}/${key}`, options: opts }, config)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSrc(asset: MediaAssetLike | string | null | undefined): string {
  if (!asset) return ''
  if (typeof asset === 'string') return asset
  return asset.cdn_url ?? asset.src ?? ''
}

function isS3Uri(uri: string): boolean {
  return uri.startsWith('s3://')
}

function appendVersion(
  url: string,
  asset: MediaAssetLike | string | null | undefined,
): string {
  if (typeof asset !== 'object' || !asset || !asset.updated_at) return url
  const version = shortHash(
    typeof asset.updated_at === 'string'
      ? asset.updated_at
      : asset.updated_at.toISOString(),
  )
  if (!version) return url
  return url + (url.includes('?') ? '&' : '?') + 'v=' + version
}

/**
 * Short, URL-safe hash of a string. Used only for URL version stamping —
 * not a security primitive. 6-char base36 gives ~2B values, enough to
 * make accidental collisions between timestamps negligible.
 */
function shortHash(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 31) + input.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36).slice(0, 6)
}
