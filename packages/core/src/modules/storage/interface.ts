/**
 * Gbox Platform — ObjectStore Interface
 *
 * Decision #1 Step 1.2a — storage abstraction for theme assets (and any
 * other large blobs the platform produces later: media uploads, export
 * bundles, sitemap.xml, etc.).
 *
 * The theme engine stores assets ≤256KB inline in `theme_assets.value`
 * (TEXT column) and pushes anything larger to this object store. That
 * way a vanilla Gbox Dawn theme (~1.5 MB total, ~50 files) fits entirely
 * inline, while a merchant who uploads a 3 MB hero video or a fat JS
 * bundle gets transparently promoted to R2 without the template loader
 * caring.
 *
 * Two implementations ship in this step:
 *   - MemoryStore  → tests + local dev without credentials
 *   - R2Store      → Cloudflare R2 via the S3-compatible AWS SDK
 *
 * Future implementations (not built yet, but the interface is shaped to
 * support them without breaking changes):
 *   - S3Store         → plain AWS S3 for self-hosted merchants
 *   - FilesystemStore → for a single-box dev setup
 *
 * The interface is intentionally small: `put/get/delete/has/url`. Anything
 * richer (ACL, metadata, lifecycle) lives in implementation-specific
 * config and should never leak into caller code.
 */

export interface PutOptions {
  /**
   * MIME type for the stored object. R2/S3 honors this in the `Content-Type`
   * response header when the object is served from the public CDN, which is
   * what lets browsers pick the right renderer for images, fonts, css, js.
   */
  contentType?: string

  /**
   * Cache-Control header to set on the stored object. Defaults to
   * `public, max-age=31536000, immutable` for theme assets (they're
   * fingerprinted in the URL). Callers can override for mutable blobs.
   */
  cacheControl?: string
}

export interface UrlOptions {
  /**
   * For signed URLs only. Seconds until the signed URL expires.
   * MemoryStore + the public-CDN path on R2Store ignore this.
   */
  expiresIn?: number

  /**
   * Force a signed URL even if the implementation could return a public
   * one. Used when the blob is private (e.g. an exported order bundle).
   */
  signed?: boolean
}

export interface ObjectStore {
  /**
   * Store an object under `key`. Returns the absolute URL where the
   * object can be fetched (public CDN for R2Store with a custom domain,
   * `memory://key` for MemoryStore).
   */
  put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<string>

  /**
   * Fetch an object by key. Returns `null` if the key does not exist.
   * The return type is `Uint8Array` so callers can decode as text or
   * treat as binary without ambiguity.
   */
  get(key: string): Promise<Uint8Array | null>

  /**
   * Delete an object by key. Idempotent: deleting a missing key is a
   * no-op (does not throw).
   */
  delete(key: string): Promise<void>

  /**
   * Returns true if the key exists. Does not download the body.
   */
  has(key: string): Promise<boolean>

  /**
   * Return the URL for an object. For R2Store with a custom domain the
   * URL is a direct CDN link; for signed/private buckets this returns a
   * presigned URL. MemoryStore returns `memory://<key>` as a sentinel.
   *
   * Synchronous on purpose: url construction must never hit the network.
   * Presigning is a deterministic local computation.
   */
  url(key: string, opts?: UrlOptions): string

  /**
   * Diagnostic label for logs. e.g. `'memory'`, `'r2:gbox-theme-assets'`.
   */
  readonly name: string
}
