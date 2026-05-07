/**
 * Products CSV Import Service — dry-run path.
 *
 * Takes a parsed + validated upload and reconciles it against current DB
 * state to produce an `ImportPlan`: what would be created vs updated,
 * per-row DB-level conflicts, and a stats summary.
 *
 * Shop-scoping: every query filters by shop_id. Cross-shop handles/SKUs
 * are naturally invisible. A handle or SKU existing in another shop is
 * NOT a conflict here — uniqueness is per-shop.
 *
 * Commit path (applying the plan) ships in a follow-up PR — this module
 * only READS the DB. That keeps this PR small enough to review
 * comfortably and gives sellers a safe preview today.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ParsedProduct } from './csv-parser.js'
import type { ValidationIssue } from './validator.js'
import { validateParsed } from './validator.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportPlanItem {
  handle: string
  parsed: ParsedProduct
  action: 'create' | 'update' | 'blocked'
  /** Existing product id, present when action === 'update'. */
  existingProductId: string | null
  /** Per-item db-sourced issues that couldn't be detected structurally. */
  issues: ValidationIssue[]
  /** Per-variant resolution (reuse existing id by SKU, else create). */
  variantPlan: VariantPlanEntry[]
}

export interface VariantPlanEntry {
  parsedRow: number
  sku: string | null
  option1: string | null
  option2: string | null
  option3: string | null
  action: 'create' | 'update'
  /** Existing variant id, present when action === 'update'. */
  existingVariantId: string | null
}

export interface ImportPlan {
  items: ImportPlanItem[]
  /** Structural + DB-sourced issues merged. */
  issues: ValidationIssue[]
  stats: {
    productsCreating: number
    productsUpdating: number
    productsBlocked: number
    variantsCreating: number
    variantsUpdating: number
    /** CSV rows that passed parsing but failed validation and won't import. */
    rowsBlocked: number
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Reconcile a parsed upload against current DB state and return a diff
 * plan. Does not write anything.
 */
export async function buildImportPlan(
  shopId: string,
  parsed: ParsedProduct[],
  db: Kysely<Database>,
): Promise<ImportPlan> {
  // Step 1 — structural validation (pure).
  const structural = validateParsed(parsed)
  const issues: ValidationIssue[] = [...structural.issues]

  // Step 2 — resolve existing products by handle within this shop.
  const handles = parsed.map((p) => p.handle)
  const existingProducts = handles.length
    ? await db
        .selectFrom('products')
        .select(['id', 'handle'])
        .where('shop_id', '=', shopId)
        .where('handle', 'in', handles)
        .execute()
    : []

  const productIdByHandle = new Map<string, string>()
  for (const p of existingProducts) {
    productIdByHandle.set(p.handle, p.id)
  }

  // Step 3 — load the variants for all resolved products so we can match
  // by SKU or option combo.
  const existingProductIds = existingProducts.map((p) => p.id)
  const existingVariants = existingProductIds.length
    ? await db
        .selectFrom('product_variants')
        .select([
          'id',
          'product_id',
          'sku',
          'option1',
          'option2',
          'option3',
        ])
        .where('product_id', 'in', existingProductIds)
        .execute()
    : []

  const variantsByProduct = new Map<string, typeof existingVariants>()
  for (const v of existingVariants) {
    const list = variantsByProduct.get(v.product_id) ?? []
    list.push(v)
    variantsByProduct.set(v.product_id, list)
  }

  // Step 4 — detect SKUs in-use by OTHER products in the same shop (a
  // blocking conflict).
  const allSkus = new Set<string>()
  for (const p of parsed) {
    for (const v of p.variants) {
      if (v.sku) allSkus.add(v.sku)
    }
  }

  const skuOwners = allSkus.size
    ? await db
        .selectFrom('product_variants')
        .innerJoin('products', 'products.id', 'product_variants.product_id')
        .select(['product_variants.sku', 'products.handle', 'products.id as product_id'])
        .where('products.shop_id', '=', shopId)
        .where('product_variants.sku', 'in', [...allSkus])
        .execute()
    : []

  /** Map SKU → set of handles it already belongs to (in THIS shop). */
  const skuToHandles = new Map<string, Set<string>>()
  for (const row of skuOwners) {
    if (!row.sku) continue
    const set = skuToHandles.get(row.sku) ?? new Set<string>()
    set.add(row.handle)
    skuToHandles.set(row.sku, set)
  }

  // Step 5 — build plan items.
  const items: ImportPlanItem[] = []
  let productsCreating = 0
  let productsUpdating = 0
  let productsBlocked = 0
  let variantsCreating = 0
  let variantsUpdating = 0

  for (const parsedProduct of parsed) {
    const existingId = productIdByHandle.get(parsedProduct.handle) ?? null
    const perItemIssues: ValidationIssue[] = []

    // Cross-product SKU collision (sku exists on a different handle in this shop).
    for (const v of parsedProduct.variants) {
      if (!v.sku) continue
      const ownerHandles = skuToHandles.get(v.sku)
      if (!ownerHandles) continue
      // Conflict iff at least one owner handle is different from ours.
      const otherOwners = [...ownerHandles].filter((h) => h !== parsedProduct.handle)
      if (otherOwners.length > 0) {
        perItemIssues.push({
          line: v.sourceRow,
          handle: parsedProduct.handle,
          sku: v.sku,
          severity: 'error',
          code: 'sku_conflict_other_product',
          message: `SKU "${v.sku}" is already used by product "${otherOwners[0]}" in this shop`,
          column: 'Variant SKU',
        })
      }
    }

    const structuralBlocked = structural.blockedHandles.has(parsedProduct.handle)
    const dbBlocked = perItemIssues.some((i) => i.severity === 'error')
    const blocked = structuralBlocked || dbBlocked

    const existingVariantList = existingId ? (variantsByProduct.get(existingId) ?? []) : []
    const variantPlan: VariantPlanEntry[] = []
    for (const v of parsedProduct.variants) {
      const match = resolveExistingVariant(v, existingVariantList)
      variantPlan.push({
        parsedRow: v.sourceRow,
        sku: v.sku,
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        action: match ? 'update' : 'create',
        existingVariantId: match ?? null,
      })
    }

    const action: ImportPlanItem['action'] = blocked
      ? 'blocked'
      : existingId
        ? 'update'
        : 'create'

    items.push({
      handle: parsedProduct.handle,
      parsed: parsedProduct,
      action,
      existingProductId: existingId,
      issues: perItemIssues,
      variantPlan,
    })

    issues.push(...perItemIssues)

    if (blocked) {
      productsBlocked++
    } else if (existingId) {
      productsUpdating++
      for (const v of variantPlan) {
        if (v.action === 'create') variantsCreating++
        else variantsUpdating++
      }
    } else {
      productsCreating++
      variantsCreating += variantPlan.length
    }
  }

  const rowsBlocked = items
    .filter((it) => it.action === 'blocked')
    .reduce((sum, it) => sum + 1 + it.parsed.variants.length + it.parsed.images.length, 0)

  return {
    items,
    issues,
    stats: {
      productsCreating,
      productsUpdating,
      productsBlocked,
      variantsCreating,
      variantsUpdating,
      rowsBlocked,
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick an existing variant id matching the parsed variant — by SKU first,
 * then by option-tuple. Returns null when no match.
 */
function resolveExistingVariant(
  parsed: { sku: string | null; option1: string | null; option2: string | null; option3: string | null },
  existing: Array<{
    id: string
    sku: string | null
    option1: string | null
    option2: string | null
    option3: string | null
  }>,
): string | null {
  // Prefer SKU match (sellers treat SKU as identity).
  if (parsed.sku) {
    const bySku = existing.find((e) => e.sku === parsed.sku)
    if (bySku) return bySku.id
  }
  // Fall back to option-combo match.
  const byOptions = existing.find(
    (e) =>
      (e.option1 ?? null) === (parsed.option1 ?? null) &&
      (e.option2 ?? null) === (parsed.option2 ?? null) &&
      (e.option3 ?? null) === (parsed.option3 ?? null),
  )
  return byOptions?.id ?? null
}
