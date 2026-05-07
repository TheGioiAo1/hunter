/**
 * Gbox Platform — R2Store
 *
 * Decision #1 Step 1.2a — Cloudflare R2 implementation of `ObjectStore`.
 *
 * R2 speaks the S3 API, so we use `@aws-sdk/client-s3` with the R2
 * endpoint and `region: 'auto'`. This is the recommended Cloudflare
 * pattern: https://developers.cloudflare.com/r2/api/s3/tokens/
 *
 * Config (all from env — never hard-coded):
 *   R2_ENDPOINT          https://<accountid>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID     from Cloudflare dashboard → R2 → Manage Tokens
 *   R2_SECRET_ACCESS_KEY ^^
 *   R2_BUCKET            gbox-theme-assets  (default)
 *   R2_PUBLIC_BASE_URL   https://cdn.gbox.co  (default — the custom domain
 *                        bound to the bucket in the R2 dashboard)
 *
 * Why a custom-domain public URL instead of presigned:
 *   Theme assets (CSS, JS, images, fonts) are served on every page view,
 *   often with Cache-Control: immutable + long TTL. Presigning them would
 *   add ~100 bytes of query string per asset for zero security benefit
 *   (they're public anyway). A custom domain gives clean URLs, CDN
 *   caching, and lets us swap storage providers later without changing
 *   the theme's `{{ 'file.css' | asset_url }}` output.
 *
 * Security: the AWS SDK caches credentials on the client instance. We
 * create one client per R2Store instance — typically one per server
 * process. Never log credentials; never pass them through request
 * context.
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

export interface R2StoreConfig {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /**
   * Public-read base URL. If set, `url()` returns `${publicBaseUrl}/${key}`
   * for unsigned reads. Omit to force every `url()` call through signing.
   */
  publicBaseUrl?: string
  /**
   * Default `Cache-Control` header for `put()` when the caller does not
   * supply one. Theme assets are fingerprinted, so a long immutable TTL
   * is the sensible default.
   */
  defaultCacheControl?: string
}

const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const DEFAULT_SIGNED_EXPIRY_SECONDS = 3600 // 1 hour

export class R2Store implements ObjectStore {
  readonly name: string

  private readonly client: S3Client
  private readonly bucket: string
  private readonly publicBaseUrl?: string
  private readonly defaultCacheControl: string

  constructor(config: R2StoreConfig) {
    if (!config.endpoint) throw new Error('R2Store: endpoint is required')
    if (!config.accessKeyId) throw new Error('R2Store: accessKeyId is required')
    if (!config.secretAccessKey) throw new Error('R2Store: secretAccessKey is required')
    if (!config.bucket) throw new Error('R2Store: bucket is required')

    this.bucket = config.bucket
    this.publicBaseUrl = config.publicBaseUrl?.replace(/\/$/, '') // strip trailing slash
    this.defaultCacheControl = config.defaultCacheControl ?? DEFAULT_CACHE_CONTROL
    this.name = `r2:${config.bucket}`

    this.client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // R2 requires path-style addressing because the bucket name is not
      // part of the hostname.
      forcePathStyle: true,
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
      // transformToByteArray exists on the Node + browser streams the SDK
      // wraps the response body in. It is the SDK-recommended way to read
      // the full body.
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
      // R2/S3 delete is already idempotent at the API level, but guard
      // against surprise NoSuchKey responses from edge cases.
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
   * NOTE: When `opts.signed === true` this method returns a SENTINEL prefix
   * `r2-signed://<key>` instead of a real presigned URL, because signing is
   * asynchronous and the `ObjectStore.url()` contract is synchronous. The
   * theme engine resolves that sentinel via `getSignedUrl()` in the
   * async asset pipeline. For the common case (public assets), we return
   * the CDN URL directly, which is what 99% of callers want.
   */
  url(key: string, opts: UrlOptions = {}): string {
    if (opts.signed || !this.publicBaseUrl) {
      return `r2-signed://${key}`
    }
    return `${this.publicBaseUrl}/${encodeURI(key)}`
  }

  /**
   * Async signed URL. Use this directly when a presigned URL is actually
   * required (private assets, time-limited downloads). Not part of the
   * `ObjectStore` interface because most callers don't need it.
   */
  async signedUrl(key: string, opts: { expiresIn?: number } = {}): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key })
    return getSignedUrl(this.client, command, {
      expiresIn: opts.expiresIn ?? DEFAULT_SIGNED_EXPIRY_SECONDS,
    })
  }
}
