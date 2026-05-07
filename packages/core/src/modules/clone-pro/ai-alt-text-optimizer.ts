/**
 * Clone Pro — AI Alt-Text Optimizer (Stage 7b)
 *
 * Every image that clone-pro imports goes into `product_images` with an
 * `alt` value copied from the source site. Source sites are… inconsistent.
 * Half the time `alt` is empty, "image123.jpg", or the product title
 * repeated verbatim — none of which help screen readers or SEO.
 *
 * This module walks the imported images for a shop, calls
 * `AIBridge.generateAltText` for each one that's missing a real alt
 * value, and writes the result back in place. It is invoked from the
 * pipeline after images have been ingested; a separate "optimize
 * remaining" job can also call it directly.
 *
 * Design goals
 * ------------
 *
 *   1. Idempotent. Images that already have a non-empty `alt` are
 *      skipped entirely — merchant overrides are never touched.
 *
 *   2. Non-fatal. One failed AI call doesn't abort the whole batch.
 *      Failures are logged and counted; the caller decides what to
 *      do with a non-zero `failed` count.
 *
 *   3. Budget-respectful. Alt text for 10,000 product photos would
 *      empty an AI budget in one pipeline run — so each invocation is
 *      hard-capped (`maxImages`, default 200). Subsequent runs pick
 *      up where this left off.
 *
 *   4. Context-aware. We pass the product `title` as context to the
 *      AI so the generated alt text reads like "Red leather handbag
 *      with gold hardware" rather than generic "a product image".
 *
 *   5. Char-capped. Alt text is a single sentence; we cap at 125
 *      characters which is the soft limit screen readers respect.
 *
 * Persistence
 * -----------
 *
 *   UPDATE product_images SET alt = ? WHERE id = ?
 *
 * No `updated_at` column on `product_images`, so we just update `alt`.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { AIBridge } from './ai-bridge.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AltTextOptimizerInput {
  readonly db: Kysely<Database>
  readonly shopId: string
  readonly ai: AIBridge
  /**
   * Hard cap on images optimized in a single run.
   * Defaults to 200. Images that already have a non-empty `alt`
   * don't count — they are skipped outright.
   */
  readonly maxImages?: number
  /**
   * When true, everything runs except the final UPDATE. Useful
   * for cost previews. Defaults to false.
   */
  readonly dryRun?: boolean
  /**
   * Progress callback. Called before each AI call with the 1-based
   * index and a label ("image:<product-title>").
   */
  readonly onProgress?: (
    done: number,
    total: number,
    label: string,
  ) => void
}

export interface AltTextOptimizerResult {
  /** Images whose alt was generated + persisted (or would have been in dryRun). */
  readonly optimized: number
  /** Images that hit an AI error or empty result. */
  readonly failed: number
  /** Total images considered (equals optimized + failed). */
  readonly total: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MAX_ALT_CHARS = 125
const DEFAULT_MAX_IMAGES = 200

/**
 * Walk every `product_images` row for the shop that's missing an
 * `alt` value and fill it via AI. See module docstring for semantics.
 */
export async function optimizeAltTextForShop(
  input: AltTextOptimizerInput,
): Promise<AltTextOptimizerResult> {
  const limit = input.maxImages ?? DEFAULT_MAX_IMAGES

  const candidates = await fetchImagesMissingAlt(input.db, input.shopId, limit)
  const total = candidates.length

  let optimized = 0
  let failed = 0

  for (let i = 0; i < candidates.length; i++) {
    const img = candidates[i]!
    const label = `image:${img.productTitle || img.id}`
    input.onProgress?.(i + 1, total, label)

    try {
      const raw = await input.ai.generateAltText(img.src, img.productTitle || '')
      const alt = truncate((raw ?? '').trim(), MAX_ALT_CHARS)
      if (!alt) {
        failed += 1
        continue
      }

      if (!input.dryRun) {
        await updateImageAlt(input.db, img.id, alt)
      }
      optimized += 1
    } catch (err) {
      failed += 1
      // Non-fatal: log once per item so the operator can diagnose.
      // eslint-disable-next-line no-console
      console.warn(
        `[ai-alt-text-optimizer] ${img.id} failed:`,
        (err as Error).message,
      )
    }
  }

  return { optimized, failed, total }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function fetchImagesMissingAlt(
  db: Kysely<Database>,
  shopId: string,
  limit: number,
): Promise<Array<{ id: string; src: string; productTitle: string | null }>> {
  // Join products to scope by shop_id — product_images itself has none.
  return db
    .selectFrom('product_images')
    .innerJoin('products', 'products.id', 'product_images.product_id')
    .select([
      'product_images.id as id',
      'product_images.src as src',
      'products.title as productTitle',
    ])
    .where('products.shop_id', '=', shopId)
    .where((eb) =>
      eb.or([
        eb('product_images.alt', 'is', null),
        eb('product_images.alt', '=', ''),
      ]),
    )
    .limit(limit)
    .execute() as Promise<Array<{ id: string; src: string; productTitle: string | null }>>
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

async function updateImageAlt(
  db: Kysely<Database>,
  id: string,
  alt: string,
): Promise<void> {
  await db
    .updateTable('product_images')
    .set({ alt } as any)
    .where('id', '=', id)
    .execute()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cap a string to `limit` characters without splitting mid-word when
 * possible. Appends an ellipsis if we actually trimmed.
 */
function truncate(value: string, limit: number): string {
  if (!value) return ''
  if (value.length <= limit) return value
  const head = value.slice(0, limit - 1)
  const lastSpace = head.lastIndexOf(' ')
  const cutAt = lastSpace > Math.floor(limit * 0.6) ? lastSpace : limit - 1
  return head.slice(0, cutAt).trimEnd() + '…'
}
