/**
 * Gbox Platform — S3Store
 *
 * Phase B — AWS S3 implementation of `ObjectStore`.
 *
 * Companion to `R2Store`. Both classes wrap `@aws-sdk/client-s3` but aim at
 * different backends:
 *
 *   R2Store  → Cloudflare R2 (endpoint override + `region: 'auto'` + path-style)
 *   S3Store  → AWS S3       (real region, default virtual-hosted-style addressing)
 *
 * Phase B spec §4.1 mandates four primary buckets (+ four `-dr` replicas):
 *   - gbox-public-media-prod      — shop images/videos/themes (Cloudflare front)
 *   - gbox-theme-library-prod     — platform marketplace themes (Cloudflare front)
 *   - gbox-private-prod           — signed URL only (Cloudflare Worker issues URLs)
 *   - gbox-backups-prod           — DB dumps + audit logs, admin-only (no CDN)
 *
 * This class is generic: one instance per bucket. The `getPublicMediaStore()`
 * / `getThemeLibraryStore()` / `getPrivateStore()` / `getBackupsStore()` factories
 * in `./index.ts` own the multi-bucket wiring.
 *
 * Config (all from env — never hard-coded):
 *   AWS_REGION              `ap-southeast-1` (primary)
 *   AWS_ACCESS_KEY_ID       IAM user / role key
 *   AWS_SECRET_ACCESS_KEY   ^^ (or omit and let the SDK resolve from EC2/ECS task role)
 *   S3_<ROLE>_BUCKET        bucket name per role (see index.ts)
 *   CDN_PUBLIC_BASE_URL     `https://cdn.gbox.co` for public buckets; omitted for private
 *
 * Presigned URLs:
 *   - Public path → `${publicBaseUrl}/${key}` (Cloudflare fronts the bucket)
 *   - Private path → `s3-signed://<key>` sentinel, resolved by `signedUrl()`
 *     (async) at the CF Worker or Store Admin backend
 *
 * Why a sentinel instead of a real presigned URL in `url()`:
 *   Presigning requires a network-free but async signing operation. The
 *   ObjectStore.url() contract is synchronous so callers can render URLs
 *   deep inside template loops without `await`. For public buckets the
 *   Cloudflare URL is the normal case; for private buckets the caller
 *   must explicitly `await store.signedUrl(key)` — which is a deliberate
 *   friction so nobody accidentally renders a signed URL into an HTML
 *   template (they expire).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ObjectStore, PutOptions, UrlOptions } from './interface.js'

export interface S3StoreConfig {
  /**
   * AWS region the bucket lives in — e.g. `'ap-southeast-1'` for the
   * primary, `'ap-northeast-1'` for the DR replica. Required.
   */
  region: string

  /**
   * Bucket name. Required. Must match an actual S3 bucket the configured
   * credentials can read/write.
   */
  bucket: string

  /**
   * IAM access key id. Optional: if omitted, the SDK's default credential
   * chain is used (EC2/ECS task role, env vars, ~/.aws/credentials, etc).
   * In production we prefer attached IAM roles — leave these unset.
   */
  accessKeyId?: string

  /**
   * IAM secret access key. See `accessKeyId`.
   */
  secretAccessKey?: string

  /**
   * Public-read base URL. If set, `url()` returns `${publicBaseUrl}/${key}`
   * for unsigned reads. Omit for private buckets (forces every `url()`
   * call through the `s3-signed://` sentinel).
   *
   * For `gbox-public-media-prod` + `gbox-theme-library-prod` this is
   * `https://cdn.gbox.co` (Cloudflare-fronted).
   */
  publicBaseUrl?: string

  /**
   * Default `Cache-Control` header for `put()` when the caller does not
   * supply one. Public buckets carry fingerprinted assets → immutable
   * year-long TTL. Private buckets should default to `no-store` — callers
   * should override explicitly.
   */
  defaultCacheControl?: string
}

const DEFAULT_PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const DEFAULT_SIGNED_EXPIRY_SECONDS = 3600 // 1 hour — matches §10.5 Worker TTL

export class S3Store implements ObjectStore {
  readonly name: string

  private readonly client: S3Client
  private readonly bucket: string
  private readonly publicBaseUrl?: string
  private readonly defaultCacheControl: string

  constructor(config: S3StoreConfig) {
    if (!config.region) throw new Error('S3Store: region is required')
    if (!config.bucket) throw new Error('S3Store: bucket is required')
    if (config.accessKeyId && !config.secretAccessKey) {
      throw new Error('S3Store: secretAccessKey is required when accessKeyId is provided')
    }
    if (!config.accessKeyId && config.secretAccessKey) {
      throw new Error('S3Store: accessKeyId is required when secretAccessKey is provided')
    }

    this.bucket = config.bucket
    this.publicBaseUrl = config.publicBaseUrl?.replace(/\/$/, '')
    this.defaultCacheControl = config.defaultCacheControl ?? DEFAULT_PUBLIC_CACHE_CONTROL
    this.name = `s3:${config.bucket}`

    // If no explicit key pair was supplied, the SDK falls back to the
    // default credential-provider chain. In production we want this
    // (IAM role attached to the ECS/EC2 task). Pass `credentials: undefined`
    // to keep that behavior.
    const credentials =
      config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          }
        : undefined

    this.client = new S3Client({
      region: config.region,
      credentials,
      // AWS S3 defaults to virtual-hosted-style addressing
      // (`bucket.s3.region.amazonaws.com`) — do NOT set `forcePathStyle`
      // here or we'll break DNS resolution for bucket names with dots.
    })
  }

  async put(key: string, body: Uint8Array | string, opts: PutOptions = {}): Promise<string> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl ?? this.defaultCacheControl,
      }),
    )

    return this.url(key)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      if (!res.Body) return null
      const bytes = await (res.Body as { transformToByteArray(): Promise<Uint8Array> })
        .transformToByteArray()
      return bytes
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        return null
      }
      throw err
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      )
    } catch (err: any) {
      // S3 DeleteObject is already idempotent at the API level; swallow
      // surprise NoSuchKey responses from weird edge cases (e.g. the
      // object was already lifecycled out between HEAD and DELETE).
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        return
      }
      throw err
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      return true
    } catch (err: any) {
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
        return false
      }
      throw err
    }
  }

  /**
   * Return the URL for an object.
   *
   * For PUBLIC buckets with `publicBaseUrl` configured: returns the
   * Cloudflare-fronted CDN URL, no query string, no expiry — the normal
   * case for 99% of callers.
   *
   * For PRIVATE buckets or when `opts.signed === true`: returns the
   * sentinel `s3-signed://<key>`. Callers who need a real presigned URL
   * must call `signedUrl()` (async) — typically inside the CF Worker at
   * `download.gbox.co/*` or in the backend when issuing a download
   * link after a paid order.
   */
  url(key: string, opts: UrlOptions = {}): string {
    if (opts.signed || !this.publicBaseUrl) {
      return `s3-signed://${key}`
    }
    return `${this.publicBaseUrl}/${encodeURI(key)}`
  }

  /**
   * Async signed GetObject URL. Use this when a time-limited URL is
   * actually required — e.g. digital download after purchase, POD file
   * for fulfillment, invoice PDF shown to a logged-in merchant.
   *
   * Not part of the `ObjectStore` interface because most callers don't
   * need it; keeping it off the interface prevents accidental signing
   * of URLs that ought to be public.
   */
  async signedUrl(key: string, opts: { expiresIn?: number } = {}): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key })
    return getSignedUrl(this.client, command, {
      expiresIn: opts.expiresIn ?? DEFAULT_SIGNED_EXPIRY_SECONDS,
    })
  }

  /**
   * Async signed PutObject URL. Storefront/admin uploads go direct from
   * the browser to S3 via this URL — backend never touches the body.
   * See spec §15.2 for the direct-to-S3 upload flow.
   *
   * Caller is responsible for setting Content-Type on the PUT request
   * that uses this URL; the signature locks the verb, bucket, key, and
   * expiry but NOT the content type, so the uploader can pick it.
   */
  async signedPutUrl(
    key: string,
    opts: { expiresIn?: number; contentType?: string } = {},
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: opts.contentType,
    })
    return getSignedUrl(this.client, command, {
      expiresIn: opts.expiresIn ?? DEFAULT_SIGNED_EXPIRY_SECONDS,
    })
  }
}
