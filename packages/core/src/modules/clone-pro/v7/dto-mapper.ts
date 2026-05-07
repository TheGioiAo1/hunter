/**
 * Clone Pro v7 — DTO mapper.
 *
 * Sprint 2 Task 2.5. Bridges the v7-crawler `Row` shape (Lonspy-port,
 * verbatim from C# parity) to the v6 `ProductDTO` / `CollectionDTO` /
 * `PageDTO` shapes that downstream Stage 5-12 already consume. Keeping
 * the v6 shapes for the persisters means we get to reuse Stages 5-12
 * wholesale (YAGNI/DRY — re-implementing those would be 1500+ LOC).
 *
 * Public API:
 *   - rowToProductDto(row)             — full Row → ProductDTO mapping
 *   - slugify(text)                    — title → URL-safe handle
 *   - parseSpinIntoOptionsAndVariants  — Spin (option matrix) → variants
 *   - isProductRowComplete(row)        — quality gate predicate (image
 *                                        present + description ≥200ch)
 *   - collectionFromHandle(input)      — small builder for the listing
 *                                        crawler's CollectionSummary →
 *                                        CollectionDTO output.
 *
 * Iron Rule 5: this module is pure / dep-free. No DB, no HTTP, no
 * console.log. Errors throw native `Error` and the caller (Stage 4)
 * pipes them through `safeMessage()` at the orchestrator boundary.
 */

import type {
  Row,
} from '../v7-crawler/types.js'
import type {
  ProductDTO,
  VariantDTO,
  OptionDTO,
  ProductImageDTO,
  CollectionDTO,
} from '../v6/scrapers/types.js'

// ---------------------------------------------------------------------------
// slugify — Vietnamese-aware, deterministic
// ---------------------------------------------------------------------------

/** Strip diacritics by NFD-decomposing then dropping combining marks. */
function stripDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining marks
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
}

/**
 * Convert any title/string into a deterministic URL-safe handle.
 * Lower-case, ASCII-only, hyphen-separated, no leading/trailing hyphens.
 * Returns 'untitled' for null/empty input so downstream UNIQUE constraints
 * still get a non-null value.
 */
export function slugify(text: string | null | undefined): string {
  if (text === '') return ''
  if (text == null) return 'untitled'
  if (typeof text !== 'string') return 'untitled'
  const ascii = stripDiacritics(text).toLowerCase()
  const hyphenated = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return hyphenated
}

// ---------------------------------------------------------------------------
// Quality gate predicate
// ---------------------------------------------------------------------------

const DESCRIPTION_MIN_CHARS = 200

/**
 * Quality gate Q1 (spec): a product row counts as "complete" if it has
 * a title + at least one image + a description ≥200 chars. Aggregate
 * `qualityScore = completeRows / harvestedRows` and Stage 4 throws
 * QualityBelowThresholdError if the score < 0.95.
 */
export function isProductRowComplete(row: Row): boolean {
  if (!row.Title || row.Title.trim().length === 0) return false
  if (!Array.isArray(row.ImageUrls) || row.ImageUrls.length === 0) return false
  const desc = row.Description ?? ''
  if (desc.length < DESCRIPTION_MIN_CHARS) return false
  return true
}

// ---------------------------------------------------------------------------
// Spin parser — variant matrix
// ---------------------------------------------------------------------------

/**
 * Parse Lonspy `Spin` array into options + variants.
 *
 * Spin formats observed in the 22 platform configs:
 *   1. `["Size:S", "Size:M", "Color:Red", "Color:Blue"]`  ← Shopify-classic
 *   2. `["S × Red", "S × Blue", "M × Red"]`               ← composite legacy
 *   3. null / empty                                       ← no variants
 *
 * Format 1 (preferred, "Name:Value") gives explicit option names.
 * Format 2 (no colon, " × " separator) defaults to Option1/Option2/...
 *
 * Output: cartesian product of option values (size 3 × color 2 → 6 variants).
 * Each variant inherits the product's price/compareAtPrice; downstream
 * persisters will apply per-variant overrides if a future scraper enriches
 * the Row shape with per-variant price.
 */
export function parseSpinIntoOptionsAndVariants(
  spin: string[] | null | undefined,
  productPrice: string | null,
  productCompareAtPrice: number | null,
): {
  options: OptionDTO[]
  variants: VariantDTO[]
} {
  const compareAtPriceStr =
    productCompareAtPrice != null ? formatPrice(productCompareAtPrice) : null
  const priceStr = productPrice ?? '0.00'

  if (!spin || spin.length === 0) {
    return {
      options: [],
      variants: [
        defaultVariant({
          title: 'Default',
          price: priceStr,
          compareAtPrice: compareAtPriceStr,
          optionValues: {},
        }),
      ],
    }
  }

  // Detect format 1 (colon-separated "Name:Value").
  const hasColons = spin.some((s) => s.includes(':') && !s.startsWith(':'))

  if (hasColons) {
    return parseShopifySpin(spin, priceStr, compareAtPriceStr)
  }

  // Format 2: " × " separator, no explicit names.
  return parseLegacySpin(spin, priceStr, compareAtPriceStr)
}

function parseShopifySpin(
  spin: string[],
  priceStr: string,
  compareAtPriceStr: string | null,
): { options: OptionDTO[]; variants: VariantDTO[] } {
  // Group raw "Size:S" pairs by name → ordered values.
  const grouped = new Map<string, string[]>()
  for (const raw of spin) {
    if (!raw || !raw.includes(':')) continue
    const [name, ...rest] = raw.split(':')
    const value = rest.join(':').trim()
    if (!name || !name.trim() || !value) continue
    const list = grouped.get(name.trim()) ?? []
    if (!list.includes(value)) list.push(value)
    grouped.set(name.trim(), list)
  }
  const options: OptionDTO[] = Array.from(grouped.entries()).map(
    ([name, values], i) => ({
      name,
      position: i + 1,
      values,
    }),
  )
  if (options.length === 0) {
    return {
      options: [],
      variants: [
        defaultVariant({
          title: 'Default',
          price: priceStr,
          compareAtPrice: compareAtPriceStr,
          optionValues: {},
        }),
      ],
    }
  }
  const variants = cartesianVariants(options, priceStr, compareAtPriceStr)
  return { options, variants }
}

function parseLegacySpin(
  spin: string[],
  priceStr: string,
  compareAtPriceStr: string | null,
): { options: OptionDTO[]; variants: VariantDTO[] } {
  // Each entry is "S × Red" or just "S". Split on " × " to get the
  // multi-axis values; default option names to Option1, Option2, ...
  const splitEntries = spin
    .map((s) => s.split(/\s*[×x]\s*/).map((p) => p.trim()).filter((p) => p))
    .filter((parts) => parts.length > 0)

  if (splitEntries.length === 0) {
    return {
      options: [],
      variants: [
        defaultVariant({
          title: 'Default',
          price: priceStr,
          compareAtPrice: compareAtPriceStr,
          optionValues: {},
        }),
      ],
    }
  }
  const axisCount = Math.max(...splitEntries.map((e) => e.length))
  const optionsValues: string[][] = Array.from({ length: axisCount }, () => [])
  for (const entry of splitEntries) {
    for (let i = 0; i < entry.length; i++) {
      const v = entry[i]!
      if (!optionsValues[i]!.includes(v)) optionsValues[i]!.push(v)
    }
  }
  const options: OptionDTO[] = optionsValues.map((values, i) => ({
    name: `Option${i + 1}`,
    position: i + 1,
    values,
  }))
  const variants = cartesianVariants(options, priceStr, compareAtPriceStr)
  return { options, variants }
}

function cartesianVariants(
  options: OptionDTO[],
  priceStr: string,
  compareAtPriceStr: string | null,
): VariantDTO[] {
  // Cross-product of option values.
  let combos: Record<string, string>[] = [{}]
  for (const opt of options) {
    const next: Record<string, string>[] = []
    for (const combo of combos) {
      for (const v of opt.values) {
        next.push({ ...combo, [opt.name]: v })
      }
    }
    combos = next
  }
  return combos.map((optionValues, i) => ({
    sourceVariantId: `v${i + 1}`,
    title: Object.values(optionValues).join(' / ') || 'Default',
    price: priceStr,
    compareAtPrice: compareAtPriceStr,
    sku: null,
    optionValues,
    available: true,
  }))
}

function defaultVariant(args: {
  title: string
  price: string
  compareAtPrice: string | null
  optionValues: Record<string, string>
}): VariantDTO {
  return {
    sourceVariantId: 'default',
    title: args.title,
    price: args.price,
    compareAtPrice: args.compareAtPrice,
    sku: null,
    optionValues: args.optionValues,
    available: true,
  }
}

// ---------------------------------------------------------------------------
// Row → ProductDTO mapping
// ---------------------------------------------------------------------------

/**
 * Map a Lonspy `Row` to a v6 `ProductDTO`. Returns `null` when the row
 * is too sparse to produce a usable product (no Title AND no Link).
 *
 * Handle resolution priority:
 *   1. Extract from `Link` `/products/<handle>` segment if present.
 *   2. Fall back to `slugify(Title)`.
 *   3. Empty string → 'untitled' (still non-null, persister will dedup).
 */
export function rowToProductDto(row: Row): ProductDTO | null {
  if (!row.Title && !row.Link) return null

  const handle = handleFromRow(row)
  if (!handle) return null

  const title = (row.Title ?? handle).trim()
  const bodyHtml = row.Description ?? ''
  const priceStr = row.Price != null ? formatPrice(row.Price) : '0.00'

  const { options, variants } = parseSpinIntoOptionsAndVariants(
    row.Spin ?? null,
    priceStr,
    row.OldPrice ?? null,
  )

  const images: ProductImageDTO[] = (row.ImageUrls ?? []).map((url, i) => ({
    sourceUrl: url,
    alt: title,
    position: i + 1,
  }))

  return {
    sourceHandle: handle,
    sourceUrl: row.Link ?? '',
    title,
    bodyHtml,
    vendor: null,
    productType: null,
    tags: row.tags ?? [],
    variants,
    options,
    images,
    seo: {
      title: row.Title ?? null,
      description: row.seo_description ?? null,
    },
  }
}

function handleFromRow(row: Row): string {
  if (row.Link) {
    try {
      const url = new URL(row.Link)
      const m = /\/products\/([^/?#]+)/.exec(url.pathname)
      if (m && m[1]) return m[1]
    } catch {
      // fall through to title slugify
    }
  }
  if (row.Title) {
    const s = slugify(row.Title)
    if (s) return s
  }
  return 'untitled'
}

function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return '0.00'
  return n.toFixed(2)
}

// ---------------------------------------------------------------------------
// CollectionDTO builder
// ---------------------------------------------------------------------------

export interface CollectionFromHandleInput {
  handle: string
  title: string
  productHandles: string[]
  sourceUrl: string
}

/**
 * Build a v6 CollectionDTO from the listing crawler's CollectionSummary.
 * Keeps the body_html empty (Stage 5+ doesn't read it for the v7 path)
 * and seo nullable.
 */
export function collectionFromHandle(
  input: CollectionFromHandleInput,
): CollectionDTO {
  return {
    sourceHandle: input.handle,
    sourceUrl: input.sourceUrl,
    title: input.title,
    bodyHtml: '',
    productHandles: input.productHandles,
    seo: { title: null, description: null },
  }
}
