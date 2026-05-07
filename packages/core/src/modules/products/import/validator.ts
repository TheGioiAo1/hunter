/**
 * Products CSV Validator — pure, no I/O.
 *
 * Takes `ParsedProduct[]` from csv-parser and returns per-row issues. The
 * service.ts layer augments these issues with DB-dependent ones (e.g.
 * "handle already exists in a different product in this shop").
 *
 * Severity model:
 *   - 'error'   — row is blocked; import skips this product
 *   - 'warning' — row imports but flags a quirk (e.g. unknown weight_unit
 *                 falls back to 'g'; unknown inventory_tracker coerces to '')
 *
 * Scoping: purely structural. Cross-product / cross-shop checks live in
 * service.ts.
 */

import type {
  ParsedProduct,
  ParsedVariant,
} from './csv-parser.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning'

export interface ValidationIssue {
  /** 1-indexed CSV source row the issue was found on. */
  line: number
  handle: string
  /** Optional variant context when the issue is variant-scoped. */
  sku?: string | null
  severity: IssueSeverity
  code: string
  message: string
  /** The offending column name from the CSV header (when applicable). */
  column?: string
}

export interface ValidationResult {
  issues: ValidationIssue[]
  /** Number of products with at least one error issue. */
  blockedProducts: number
  /** Convenience: split list of handles blocked by error severity. */
  blockedHandles: Set<string>
}

// ---------------------------------------------------------------------------
// Regexes / enums
// ---------------------------------------------------------------------------

const HANDLE_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i
const DECIMAL_REGEX = /^\d+(?:\.\d{1,4})?$/
const COUNTRY_REGEX = /^[A-Z]{2}$/
const HS_MAX_LEN = 14

const VALID_STATUS = new Set(['active', 'draft', 'archived'])
const VALID_POLICY = new Set(['deny', 'continue'])
const VALID_TRACKER = new Set(['', 'shopify', 'gbox'])
const VALID_WEIGHT_UNIT = new Set(['kg', 'g', 'lb', 'oz'])

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function validateParsed(products: ParsedProduct[]): ValidationResult {
  const issues: ValidationIssue[] = []
  const handleCounts = new Map<string, number>()

  // Pass 1 — tally handle frequencies so duplicates can point at all rows.
  for (const p of products) {
    handleCounts.set(p.handle, (handleCounts.get(p.handle) ?? 0) + 1)
  }

  for (const product of products) {
    validateProduct(product, issues, handleCounts)
  }

  const blockedHandles = new Set<string>()
  for (const issue of issues) {
    if (issue.severity === 'error') blockedHandles.add(issue.handle)
  }

  return {
    issues,
    blockedProducts: blockedHandles.size,
    blockedHandles,
  }
}

// ---------------------------------------------------------------------------
// Per-product
// ---------------------------------------------------------------------------

function validateProduct(
  product: ParsedProduct,
  issues: ValidationIssue[],
  handleCounts: Map<string, number>,
): void {
  // Handle is already non-blank (parser filtered blanks), so check slug format.
  if (!HANDLE_REGEX.test(product.handle)) {
    issues.push({
      line: product.sourceRow,
      handle: product.handle,
      severity: 'error',
      code: 'handle_invalid_format',
      message: `Handle "${product.handle}" must be kebab-case (a-z, 0-9, hyphens)`,
      column: 'Handle',
    })
  }

  // NOTE: we only emit the duplicate handle issue once per handle (on the
  // first occurrence) to avoid burying the log in duplicates.
  if ((handleCounts.get(product.handle) ?? 0) > 1) {
    issues.push({
      line: product.sourceRow,
      handle: product.handle,
      severity: 'error',
      code: 'handle_duplicate_in_upload',
      message: `Handle "${product.handle}" appears as the FIRST row in multiple products`,
      column: 'Handle',
    })
    // Suppress further duplicate reports by clearing the count.
    handleCounts.set(product.handle, 1)
  }

  // Title is required on a parsed product — without it we can't upsert a
  // meaningful row.
  if (!product.title || product.title.trim() === '') {
    issues.push({
      line: product.sourceRow,
      handle: product.handle,
      severity: 'error',
      code: 'title_required',
      message: 'Title is required',
      column: 'Title',
    })
  }

  // Status enum check (if provided).
  if (product.status !== null && !VALID_STATUS.has(product.status)) {
    issues.push({
      line: product.sourceRow,
      handle: product.handle,
      severity: 'error',
      code: 'status_invalid',
      message: `Status "${product.status}" must be one of: ${[...VALID_STATUS].join(', ')}`,
      column: 'Status',
    })
  }

  // Every product must have at least one variant — otherwise there's
  // nothing to sell and the storefront query joins will skip it.
  if (product.variants.length === 0) {
    issues.push({
      line: product.sourceRow,
      handle: product.handle,
      severity: 'error',
      code: 'no_variants',
      message: 'Product must have at least one variant row',
    })
  }

  // Option1 Name presence → every variant must have option1 filled in.
  if (product.optionNames[0] && product.variants.length > 0) {
    for (const v of product.variants) {
      if (!v.option1 || v.option1.trim() === '') {
        issues.push({
          line: v.sourceRow,
          handle: product.handle,
          sku: v.sku,
          severity: 'error',
          code: 'option1_required',
          message: `Option1 Value is required because Option1 Name "${product.optionNames[0]}" is set`,
          column: 'Option1 Value',
        })
      }
    }
  }

  // Detect duplicate (option1, option2, option3) combinations inside the
  // same product.
  const optionCombos = new Map<string, ParsedVariant>()
  const skusSeen = new Map<string, ParsedVariant>()
  for (const v of product.variants) {
    validateVariant(product, v, issues)

    const combo = JSON.stringify([v.option1, v.option2, v.option3])
    const prev = optionCombos.get(combo)
    if (prev) {
      issues.push({
        line: v.sourceRow,
        handle: product.handle,
        sku: v.sku,
        severity: 'error',
        code: 'variant_duplicate_options',
        message: `Variant options [${v.option1 ?? ''},${v.option2 ?? ''},${v.option3 ?? ''}] duplicate variant on row ${prev.sourceRow}`,
      })
    } else {
      optionCombos.set(combo, v)
    }

    // Duplicate SKU within one product (within a single shop this is still
    // blockable — SKUs must be unique per shop).
    if (v.sku) {
      const prevSku = skusSeen.get(v.sku)
      if (prevSku) {
        issues.push({
          line: v.sourceRow,
          handle: product.handle,
          sku: v.sku,
          severity: 'error',
          code: 'sku_duplicate_in_product',
          message: `SKU "${v.sku}" is used by another variant on row ${prevSku.sourceRow}`,
          column: 'Variant SKU',
        })
      } else {
        skusSeen.set(v.sku, v)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-variant
// ---------------------------------------------------------------------------

function validateVariant(
  product: ParsedProduct,
  v: ParsedVariant,
  issues: ValidationIssue[],
): void {
  checkDecimal(v.price, 'Variant Price', product, v, issues)
  checkDecimal(v.compare_at_price, 'Variant Compare At Price', product, v, issues)
  checkDecimal(v.cost, 'Cost per item', product, v, issues)

  // Inventory policy
  if (v.inventory_policy !== null && !VALID_POLICY.has(v.inventory_policy)) {
    issues.push({
      line: v.sourceRow,
      handle: product.handle,
      sku: v.sku,
      severity: 'error',
      code: 'inventory_policy_invalid',
      message: `Inventory Policy "${v.inventory_policy}" must be one of: ${[...VALID_POLICY].join(', ')}`,
      column: 'Variant Inventory Policy',
    })
  }

  // Inventory tracker (blank and 'shopify'/'gbox' accepted — anything else
  // is a warning because the importer coerces unknowns to '' [untracked]).
  if (v.inventory_tracker !== null && !VALID_TRACKER.has(v.inventory_tracker)) {
    issues.push({
      line: v.sourceRow,
      handle: product.handle,
      sku: v.sku,
      severity: 'warning',
      code: 'inventory_tracker_unknown',
      message: `Inventory Tracker "${v.inventory_tracker}" unrecognised — treating variant as untracked`,
      column: 'Variant Inventory Tracker',
    })
  }

  // Non-negative integer for qty and grams.
  if (v.inventory_quantity !== null && v.inventory_quantity < 0) {
    issues.push({
      line: v.sourceRow,
      handle: product.handle,
      sku: v.sku,
      severity: 'error',
      code: 'inventory_quantity_negative',
      message: 'Variant Inventory Qty must be >= 0',
      column: 'Variant Inventory Qty',
    })
  }
  if (v.grams !== null && v.grams < 0) {
    issues.push({
      line: v.sourceRow,
      handle: product.handle,
      sku: v.sku,
      severity: 'error',
      code: 'grams_negative',
      message: 'Variant Grams must be >= 0',
      column: 'Variant Grams',
    })
  }

  // Weight unit enum.
  if (v.weight_unit !== null && !VALID_WEIGHT_UNIT.has(v.weight_unit)) {
    issues.push({
      line: v.sourceRow,
      handle: product.handle,
      sku: v.sku,
      severity: 'warning',
      code: 'weight_unit_unknown',
      message: `Variant Weight Unit "${v.weight_unit}" unrecognised — defaulting to "g"`,
      column: 'Variant Weight Unit',
    })
  }

  // Country of origin format (migration 054 CHECK mirrors this).
  if (v.country_of_origin !== null && !COUNTRY_REGEX.test(v.country_of_origin)) {
    issues.push({
      line: v.sourceRow,
      handle: product.handle,
      sku: v.sku,
      severity: 'error',
      code: 'country_of_origin_invalid',
      message: `Country of Origin "${v.country_of_origin}" must be a 2-letter ISO 3166-1 alpha-2 code`,
      column: 'Variant Country of Origin',
    })
  }

  // HS code length — CHECK cap.
  if (v.hs_code !== null && v.hs_code.length > HS_MAX_LEN) {
    issues.push({
      line: v.sourceRow,
      handle: product.handle,
      sku: v.sku,
      severity: 'error',
      code: 'hs_code_too_long',
      message: `Variant HS Code "${v.hs_code}" exceeds ${HS_MAX_LEN} characters`,
      column: 'Variant HS Code',
    })
  }
}

function checkDecimal(
  value: string | null,
  column: string,
  product: ParsedProduct,
  v: ParsedVariant,
  issues: ValidationIssue[],
): void {
  if (value === null) return
  const trimmed = value.trim()
  if (trimmed === '') return
  if (!DECIMAL_REGEX.test(trimmed)) {
    issues.push({
      line: v.sourceRow,
      handle: product.handle,
      sku: v.sku,
      severity: 'error',
      code: 'decimal_invalid',
      message: `${column} "${value}" must be a non-negative decimal (max 4 decimal places)`,
      column,
    })
  }
}
