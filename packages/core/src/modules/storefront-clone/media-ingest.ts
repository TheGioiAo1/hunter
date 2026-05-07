/**
 * Gbox Platform — Storefront Clone: media ingestion pipeline.
 *
 * Downloads product images from Shopify source URLs → uploads to S3
 * (via ObjectStore) → rewrites `product_images.src` to the CDN URL.
 *
 * Architecture decision: we skip server-side resize (sharp) and let
 * the existing CDN Image Resizing pipeline (Cloudflare/imgix) handle
 * responsive transforms at request time. This means:
 *
 *   - S3 stores ONE original per image (no 4×2 resize matrix).
 *   - Templates call `imageSrcSet()` from `@gbox/core/modules/content/image-url`
 *     which emits CDN-transformed URLs with width/format params.
 *   - `srcset_json` on `product_images` stores the S3 key + original
 *     dimensions so the CDN layer knows how to transform.
 *
 * Benefits:
 *   - No native dependency (sharp is ~60 MB + platform-specific binary)
 *   - Upload is ~10× faster (one PUT per image instead of 8)
 *   - CDN handles format negotiation (Accept: image/avif → AVIF; else WebP)
 *   - Same approach Shopify, Vercel, and Cloudflare Pages use
 *
 * Concurrency: we download + upload in batches of N_CONCURRENT_IMAGES
 * to avoid saturating the outbound network or hitting Shopify's CDN
 * rate limit. Each image is independent, so partial failures are
 * logged and skipped (fail-open).
 *
 * Flow per image:
 *   1. safeFetch(sourceUrl) → Buffer
 *   2. Hash the buffer (SHA-256) for dedup / fingerprinted URLs
 *   3. objectStore.put(`shops/${shopId}/products/${productId}/${hash}.${ext}`)
 *   4. UPDATE product_images SET src = cdnUrl, srcset_json = {...}
 */

import type { Kysely } from 'kysely';
import type { Database } from '@gbox/db/schema/tables.js';
import type { ObjectStore } from '../storage/interface.js';
import { safeFetch, type SafeFetchOptions } from '../clone-shopify/safe-fetch.js';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Number of images to download + upload in parallel per batch. */
const N_CONCURRENT_IMAGES = 6;

/** Max bytes per image download (10 MB). Larger images are skipped. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** safeFetch options for image downloads. */
const IMAGE_FETCH_OPTS: SafeFetchOptions = {
  maxBytes: MAX_IMAGE_BYTES,
  timeoutMs: 30_000,
  maxRedirects: 3,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MediaIngestInput {
  readonly shopId: string;
  readonly cloneJobId: string;
  readonly objectStore: ObjectStore;
  /**
   * Limit processing to images from a specific clone job. When null,
   * processes ALL product images in the shop whose `src` starts with
   * `http` (i.e. not yet on our CDN).
   */
  readonly onlyCloneJobId?: string | null;
  /** Optional progress callback for SSE streaming. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface MediaIngestResult {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errors: readonly MediaIngestError[];
}

export interface MediaIngestError {
  readonly imageId: string;
  readonly sourceUrl: string;
  readonly code: string;
  readonly message: string;
}

interface ImageRow {
  readonly id: string;
  readonly product_id: string;
  readonly src: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface SrcsetJson {
  /** S3 object key (without CDN prefix). */
  readonly key: string;
  /** Original width from source (if known). */
  readonly width: number | null;
  /** Original height from source (if known). */
  readonly height: number | null;
  /** Content-type detected from source. */
  readonly contentType: string;
  /** SHA-256 hex hash of the original image bytes (for dedup). */
  readonly hash: string;
  /** Byte count of the original image. */
  readonly bytes: number;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Download all external product images for a shop and re-host them
 * on the platform's ObjectStore (S3/R2). Updates `product_images.src`
 * to the CDN URL and populates `srcset_json` with metadata so the
 * template layer can emit responsive `srcset` attributes.
 */
export async function ingestProductImages(
  db: Kysely<Database>,
  input: MediaIngestInput,
): Promise<MediaIngestResult> {
  // Fetch all product images that are still pointing at external URLs.
  let query = db
    .selectFrom('product_images')
    .innerJoin('products', 'products.id', 'product_images.product_id')
    .select([
      'product_images.id as id',
      'product_images.product_id as product_id',
      'product_images.src as src',
      'product_images.width as width',
      'product_images.height as height',
    ])
    .where('products.shop_id', '=', input.shopId)
    // Only process images still pointing at external HTTP(S) URLs.
    .where('product_images.src', 'like', 'http%')
    .orderBy('product_images.id', 'asc');

  if (input.onlyCloneJobId) {
    query = query.where('products.clone_job_id', '=', input.onlyCloneJobId) as typeof query;
  }

  const images = (await query.execute()) as readonly ImageRow[];
  const total = images.length;

  if (total === 0) {
    return { total: 0, succeeded: 0, failed: 0, skipped: 0, errors: [] };
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const errors: MediaIngestError[] = [];

  // Process in batches of N_CONCURRENT_IMAGES.
  for (let i = 0; i < images.length; i += N_CONCURRENT_IMAGES) {
    const batch = images.slice(i, i + N_CONCURRENT_IMAGES);
    const results = await Promise.allSettled(
      batch.map((img) =>
        processOneImage(db, input.shopId, img, input.objectStore),
      ),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j]!;
      const img = batch[j]!;
      if (result.status === 'fulfilled') {
        if (result.value === 'skipped') {
          skipped += 1;
        } else {
          succeeded += 1;
        }
      } else {
        failed += 1;
        const err = result.reason as Error;
        errors.push({
          imageId: img.id,
          sourceUrl: img.src,
          code: (err as any).code ?? 'download_failed',
          message: err.message,
        });
      }
    }

    input.onProgress?.(i + batch.length, total);
  }

  return { total, succeeded, failed, skipped, errors };
}

// ---------------------------------------------------------------------------
// Per-image pipeline
// ---------------------------------------------------------------------------

async function processOneImage(
  db: Kysely<Database>,
  shopId: string,
  image: ImageRow,
  objectStore: ObjectStore,
): Promise<'ok' | 'skipped'> {
  // Skip non-HTTP URLs (already on CDN, data: URIs, etc.).
  if (!image.src.startsWith('http://') && !image.src.startsWith('https://')) {
    return 'skipped';
  }

  // Download via safeFetch (SSRF-safe, byte-capped, redirects handled).
  const fetchResult = await safeFetch(image.src, IMAGE_FETCH_OPTS);
  if (fetchResult.statusCode !== 200) {
    throw new MediaIngestImageError(
      'bad_status',
      `GET ${image.src} → ${fetchResult.statusCode}`,
    );
  }

  const body = fetchResult.body;
  if (body.length === 0) {
    throw new MediaIngestImageError('empty_body', `GET ${image.src} → 0 bytes`);
  }

  // Detect content type from response headers or extension.
  const rawCt = fetchResult.headers['content-type'];
  const headerCt = Array.isArray(rawCt) ? rawCt[0] ?? '' : rawCt ?? '';
  const contentType = detectImageContentType(headerCt, image.src);
  if (!contentType) {
    throw new MediaIngestImageError(
      'unsupported_type',
      `GET ${image.src} → content-type ${headerCt || '(none)'}`,
    );
  }

  // Hash for dedup + fingerprinted URL.
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const ext = CONTENT_TYPE_TO_EXT[contentType] ?? 'bin';
  const s3Key = `shops/${shopId}/products/${image.product_id}/${hash}.${ext}`;

  // Check if we already uploaded this exact image (dedup).
  const exists = await objectStore.has(s3Key);
  if (!exists) {
    await objectStore.put(s3Key, body, {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }

  const cdnUrl = objectStore.url(s3Key);

  // Build srcset metadata JSON.
  const srcsetJson: SrcsetJson = {
    key: s3Key,
    width: image.width,
    height: image.height,
    contentType,
    hash,
    bytes: body.length,
  };

  // Update the product_images row.
  await db
    .updateTable('product_images')
    .set({
      src: cdnUrl,
      srcset_json: JSON.stringify(srcsetJson) as any,
    })
    .where('id', '=', image.id)
    .execute();

  return 'ok';
}

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/svg+xml',
]);

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

function detectImageContentType(
  headerContentType: string,
  url: string,
): string | null {
  // Prefer the Content-Type header if it looks like an image.
  const ct = headerContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (SUPPORTED_IMAGE_TYPES.has(ct)) return ct;

  // Fall back to file extension.
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
    return EXT_TO_CONTENT_TYPE[ext] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class MediaIngestImageError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MediaIngestImageError';
    this.code = code;
  }
}
