/**
 * Gbox Platform — imgproxy URL Signer
 *
 * Phase B — spec §11 (Image transformation pipeline).
 *
 * imgproxy (https://docs.imgproxy.net) is the self-hosted image transform
 * service fronted by Cloudflare at `cdn.gbox.co`. It accepts signed URLs of
 * the form:
 *
 *   https://cdn.gbox.co/img/{signature}/{processing_options}/{encoded_source_uri}
 *
 * Where:
 *   - `processing_options` is a slash-separated list — e.g.
 *     `rs:fit:800:0/q:85/f:webp/g:ce`.
 *   - `encoded_source_uri` is the base64url-encoded source — e.g.
 *     `base64url("s3://gbox-public-media-prod/shops/abc/products/123/img-42.jpg")`.
 *   - `signature` is `base64url(HMAC-SHA256(key, salt + path_to_sign))`
 *     truncated to `signature_size` bytes.
 *
 * The signature prevents abuse: without the HMAC key a client cannot
 * request arbitrary resize dimensions (spec §11.7). Keys are provisioned
 * to imgproxy via `IMGPROXY_KEY` / `IMGPROXY_SALT` env vars and mirrored
 * to the backend via the same names — both must be 64-character hex
 * strings (32 raw bytes each).
 *
 * ### Width normalization (spec §11.4)
 *
 * The storefront rarely asks for exact pixel widths. We round every
 * requested `w` UP to the nearest bucket below, collapsing the cache
 * keyspace from "infinite" to ~12 variants per image. Cloudflare's edge
 * then gets ~99% hit rate on steady-state traffic.
 *
 * ### Why we don't just use Cloudflare Image Resizing
 *
 * Decision-0 #3 of the spec says we self-host. imgproxy gives us control
 * over quality/format/crop semantics without waiting on Cloudflare
 * product changes, and moves off vendor lock-in.
 */

import { createHmac } from 'node:crypto'

// ---------------------------------------------------------------------------
// Constants pulled straight from spec §11.2 + §11.4.
// ---------------------------------------------------------------------------

/**
 * Default imgproxy signature size (bytes). Matches the
 * `IMGPROXY_SIGNATURE_SIZE=32` env var we ship to the container.
 * Signatures are base64url-encoded after truncation, so the URL segment
 * ends up ~43 chars long.
 */
export const IMGPROXY_SIGNATURE_SIZE = 32

/**
 * Width buckets — every requested `w` is rounded UP to the nearest bucket
 * so cache variants stay bounded. 12 widths × 3 formats = 36 variants per
 * image, which is cheap to keep warm at the Cloudflare edge.
 *
 * Do NOT add arbitrary sizes to this array — every new width multiplies
 * the cache keyspace for every image on the platform.
 */
export const WIDTH_BUCKETS = [
  64, 128, 256, 384, 512, 768, 1024, 1280, 1600, 2048, 3200, 4096,
] as const

export type WidthBucket = (typeof WIDTH_BUCKETS)[number]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transform options accepted by `signImgproxyUrl`. Matches spec §11.3 +
 * §16.1 (`cdnImage()` signature). Converted to imgproxy processing
 * options under the hood.
 */
export interface ImgproxyOptions {
  /**
   * Target width in CSS pixels. Rounded up to the nearest `WIDTH_BUCKETS`
   * entry. Pass `0` or omit to let imgproxy auto-size based on `height`.
   */
  width?: number

  /**
   * Target height in CSS pixels. Rounded to the nearest `WIDTH_BUCKETS`
   * entry (the same ladder applies — no separate height ladder).
   * Usually omitted in favour of `width` + `fit=cover`.
   */
  height?: number

  /**
   * Output format. `auto` lets imgproxy pick based on the `Accept` header
   * (serves AVIF > WebP > original). Use `webp` explicitly when pre-warming
   * so the cache variant is deterministic.
   */
  format?: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png'

  /**
   * Output quality, 1-100. imgproxy default is 80 for jpeg/webp, 50 for
   * avif. Callers rarely need to override — it's there for edge cases
   * (hero image that needs extra sharpness, thumbnail that can be
   * aggressively compressed).
   */
  quality?: number

  /**
   * Crop/fit strategy.
   *   - `cover`   (default) — fill + crop to the exact w×h, center gravity
   *   - `contain` — fit within w×h, pad with transparent/letterbox
   *   - `fill`    — stretch (distorts)
   *   - `inside`  — fit preserving aspect, no upscaling
   *   - `outside` — fit to cover preserving aspect
   *
   * Mapped to imgproxy's `rs:{type}` processing option.
   */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'

  /**
   * Gravity / anchor point when cropping. Mapped to imgproxy `g:{gravity}`.
   */
  crop?: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'entropy'

  /**
   * Device pixel ratio. imgproxy internally multiplies target dimensions
   * by DPR. Typical values: 1 (desktop), 2 (retina), 3 (newest phones).
   */
  dpr?: 1 | 2 | 3
}

export interface ImgproxySignerConfig {
  /**
   * Hex-encoded HMAC key — must be exactly 64 hex chars (32 raw bytes).
   * Source of truth is AWS Secrets Manager in prod; `.env` for dev.
   */
  key: string

  /**
   * Hex-encoded HMAC salt — 64 hex chars. Provisioned to imgproxy via
   * `IMGPROXY_SALT` env var.
   */
  salt: string

  /**
   * Signature truncation length (bytes). Defaults to
   * `IMGPROXY_SIGNATURE_SIZE` (32). Must match what the imgproxy
   * container is configured with.
   */
  signatureSize?: number

  /**
   * Public base URL for the imgproxy CDN — typically `https://cdn.gbox.co`.
   * The `/img/` path segment is hard-coded by imgproxy; we do not prefix
   * it here, callers get it automatically.
   */
  cdnBaseUrl: string
}

export interface SignImgproxyUrlInput {
  /**
   * Absolute source URI imgproxy should fetch. Supported schemes:
   *   - `s3://bucket/key`           (the default — spec §11.2 `IMGPROXY_ALLOWED_SOURCES`)
   *   - `https://...`               (for passthrough of already-hosted images — rare)
   *
   * The scheme+path are base64url-encoded into the URL, so anything
   * URL-safe works.
   */
  sourceUri: string

  /** Transform options — see `ImgproxyOptions` */
  options?: ImgproxyOptions
}

/**
 * Return true if `value` is a 64-char hex string. Guards config validation
 * — imgproxy rejects non-hex keys at startup, but it's nicer to catch
 * misconfiguration at import time instead of first request.
 */
export function isHexKey(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value)
}

/**
 * Round `width` up to the nearest bucket in `WIDTH_BUCKETS`. Widths
 * larger than the max bucket clamp to the max (4096). Widths ≤ 0 return
 * the smallest bucket.
 *
 * Exported for testing and for the pre-warm helper in §11.5.
 */
export function normalizeWidth(width: number): WidthBucket {
  if (!Number.isFinite(width) || width <= 0) return WIDTH_BUCKETS[0]
  for (const bucket of WIDTH_BUCKETS) {
    if (width <= bucket) return bucket
  }
  return WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1]
}

/**
 * Build imgproxy `processing_options` path segment from `ImgproxyOptions`.
 * The wire format is slash-separated `key:arg:arg2`. Order matters for
 * cache hit rate — we emit options in a stable order so two equivalent
 * requests produce byte-identical URLs.
 *
 * See https://docs.imgproxy.net/usage/processing for the full option list.
 */
export function buildProcessingOptions(opts: ImgproxyOptions = {}): string {
  const parts: string[] = []

  // Resize — `rs:type:width:height:enlarge:extend`.
  if (opts.width || opts.height) {
    const fit = opts.fit ?? 'cover'
    const imgproxyFit = FIT_TO_IMGPROXY[fit]
    const w = opts.width ? normalizeWidth(opts.width) : 0
    const h = opts.height ? normalizeWidth(opts.height) : 0
    parts.push(`rs:${imgproxyFit}:${w}:${h}`)
  }

  // Gravity — center is imgproxy default; only emit when non-default.
  if (opts.crop && opts.crop !== 'center') {
    const g = CROP_TO_IMGPROXY[opts.crop]
    parts.push(`g:${g}`)
  }

  // Quality — imgproxy clamps 1..100 internally but we sanitize here too.
  if (opts.quality !== undefined) {
    const q = Math.max(1, Math.min(100, Math.round(opts.quality)))
    parts.push(`q:${q}`)
  }

  // DPR — imgproxy multiplies target by dpr server-side. Only emit for
  // non-default (1).
  if (opts.dpr && opts.dpr !== 1) {
    parts.push(`dpr:${opts.dpr}`)
  }

  // Format — always last. `f:auto` is expressed via the URL extension
  // (e.g. `.../@webp` suffix) — cleaner for Cloudflare to cache by URL
  // path only. We pick explicit format here so signers don't need to
  // know about extension handling.
  if (opts.format && opts.format !== 'auto') {
    parts.push(`f:${opts.format}`)
  }

  return parts.join('/')
}

const FIT_TO_IMGPROXY: Record<NonNullable<ImgproxyOptions['fit']>, string> = {
  cover: 'fill',
  contain: 'fit',
  fill: 'force',
  inside: 'fit',
  outside: 'fill',
}

const CROP_TO_IMGPROXY: Record<NonNullable<ImgproxyOptions['crop']>, string> = {
  center: 'ce',
  top: 'no',
  bottom: 'so',
  left: 'we',
  right: 'ea',
  entropy: 'sm',
}

/**
 * Base64url-encode a UTF-8 string. imgproxy requires NO padding (`=`).
 */
export function base64urlEncode(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Compute the signature for `path` using imgproxy's HMAC scheme.
 *
 * Algorithm (verbatim from imgproxy source):
 *   1. Decode `key` + `salt` from hex → raw bytes.
 *   2. `HMAC-SHA256(key, salt || path)` — note `||` = concatenation.
 *   3. Truncate HMAC output to `signatureSize` bytes.
 *   4. Base64url-encode (no padding).
 *
 * `path` MUST include the leading `/` but NOT the `/img/` prefix.
 * Example: `/rs:fit:800:0/q:85/aHR0cHM6Ly9leGFt...`
 */
export function signImgproxyPath(
  path: string,
  config: Pick<ImgproxySignerConfig, 'key' | 'salt' | 'signatureSize'>,
): string {
  if (!isHexKey(config.key)) {
    throw new Error('signImgproxyPath: key must be 64 hex chars (32 bytes)')
  }
  if (!isHexKey(config.salt)) {
    throw new Error('signImgproxyPath: salt must be 64 hex chars (32 bytes)')
  }

  const keyBytes = Buffer.from(config.key, 'hex')
  const saltBytes = Buffer.from(config.salt, 'hex')
  const pathBytes = Buffer.from(path, 'utf-8')

  const hmac = createHmac('sha256', keyBytes)
  hmac.update(saltBytes)
  hmac.update(pathBytes)
  const fullDigest = hmac.digest()

  const size = config.signatureSize ?? IMGPROXY_SIGNATURE_SIZE
  const truncated = fullDigest.subarray(0, size)

  return truncated
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Build a fully-signed imgproxy URL.
 *
 * Example:
 *   signImgproxyUrl({
 *     sourceUri: 's3://gbox-public-media-prod/shops/abc/products/123.jpg',
 *     options: { width: 800, format: 'webp', quality: 82 },
 *   }, config)
 *   → 'https://cdn.gbox.co/img/{sig}/rs:fill:1024:0/q:82/f:webp/{b64uri}'
 */
export function signImgproxyUrl(
  input: SignImgproxyUrlInput,
  config: ImgproxySignerConfig,
): string {
  const processing = buildProcessingOptions(input.options)
  const encodedSource = base64urlEncode(input.sourceUri)

  const pathBody = processing ? `${processing}/${encodedSource}` : encodedSource
  const pathToSign = `/${pathBody}`
  const signature = signImgproxyPath(pathToSign, config)

  const base = config.cdnBaseUrl.replace(/\/+$/, '')
  return `${base}/img/${signature}/${pathBody}`
}

/**
 * Read an `ImgproxySignerConfig` from environment variables.
 *
 *   IMGPROXY_KEY            required in production, 64 hex chars
 *   IMGPROXY_SALT           required in production, 64 hex chars
 *   IMGPROXY_SIGNATURE_SIZE optional, default 32
 *   CDN_PUBLIC_BASE_URL     defaults to https://cdn.gbox.co
 *
 * Returns `null` if `key` or `salt` is missing — caller decides whether
 * to throw (prod) or fall back to passthrough (dev).
 */
export function readImgproxyConfigFromEnv(): ImgproxySignerConfig | null {
  const key = process.env.IMGPROXY_KEY
  const salt = process.env.IMGPROXY_SALT
  if (!key || !salt) return null

  const cdnBaseUrl = process.env.CDN_PUBLIC_BASE_URL || 'https://cdn.gbox.co'
  const sizeStr = process.env.IMGPROXY_SIGNATURE_SIZE
  const signatureSize = sizeStr ? parseInt(sizeStr, 10) : IMGPROXY_SIGNATURE_SIZE

  return { key, salt, signatureSize, cdnBaseUrl }
}

/**
 * Generate the pre-warm URL set for a source image. Per §11.5 we issue
 * HEAD requests to 5 widths × WebP after ingestion so Cloudflare edge is
 * hot when a real visitor first sees the image.
 *
 * Returns the URLs — worker is responsible for fetching them.
 */
export function preWarmUrls(
  sourceUri: string,
  config: ImgproxySignerConfig,
): string[] {
  const widths: WidthBucket[] = [64, 256, 512, 1024, 2048]
  return widths.map((w) =>
    signImgproxyUrl(
      { sourceUri, options: { width: w, format: 'webp' } },
      config,
    ),
  )
}
