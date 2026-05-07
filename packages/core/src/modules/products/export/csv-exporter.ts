/**
 * Products CSV Exporter (Shopify-compatible)
 *
 * Generates a CSV export of products + their variants + images + optional
 * metafields. The column layout mirrors Shopify's Products CSV so the
 * file round-trips through tools that already understand Shopify.
 *
 * Row layout (Shopify parity):
 *   - First row for a product carries the product-level columns
 *     (Title/Body/Vendor/Type/Tags/…) plus the first variant + first
 *     image.
 *   - Each additional variant gets its own row with Handle set and
 *     product-level columns blank. The variant columns are populated.
 *   - Each additional image (beyond the one attached to the first row)
 *     gets its own image-only row — Handle set, everything else blank
 *     except Image Src / Image Position / Image Alt Text.
 *
 * This is the layout Shopify's import/export assumes, so the same file
 * can be dropped into Shopify (or re-imported into Gbox in PR3) without
 * reshaping.
 *
 * The module is pure: no DB imports, no I/O. The `service.ts` sibling is
 * responsible for hydrating the `ExportProduct[]` shape from Postgres.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportProduct {
  id: string
  handle: string                      // slug
  title: string
  body_html: string | null
  vendor: string | null
  product_type: string | null
  tags: string[] | null
  status: string                       // 'active' | 'draft' | 'archived'
  published_at: string | null          // ISO string or null
  seo_title: string | null
  seo_description: string | null
  variants: ExportVariant[]
  images: ExportImage[]
  options: ExportOption[]              // in position order
  /**
   * Product-level metafields indexed by `${namespace}.${key}`. The value
   * is already JSON-encoded (the raw string stored in `metafields.value`),
   * matching Shopify's "[type]"-tagged CSV columns.
   */
  metafields: Record<string, ExportMetafieldCell>
}

export interface ExportVariant {
  id: string
  sku: string | null
  barcode: string | null
  price: string                        // decimal string, e.g. "12.00"
  compare_at_price: string | null
  cost: string | null
  grams: number                        // weight in grams (derived)
  weight: string | null                // raw numeric text
  weight_unit: string                  // 'kg' | 'g' | 'lb' | 'oz'
  inventory_quantity: number
  inventory_policy: 'deny' | 'continue'
  inventory_tracker: 'shopify' | ''    // 'shopify' = tracked, '' = untracked
  fulfillment_service: string          // 'manual' default
  requires_shipping: boolean
  taxable: boolean
  option1: string | null
  option2: string | null
  option3: string | null
  image_url: string | null
  // Migration 054 — Shopify-parity variant deep fields.
  hs_code: string | null
  country_of_origin: string | null     // ISO 3166-1 alpha-2
  /**
   * Variant-level metafields indexed by `${namespace}.${key}`.
   */
  metafields: Record<string, ExportMetafieldCell>
}

export interface ExportImage {
  src: string
  alt: string | null
  position: number
}

export interface ExportOption {
  name: string
  position: number
}

/** Shape stored per metafield cell so the exporter can format the header tag. */
export interface ExportMetafieldCell {
  namespace: string
  key: string
  value_type: string
  /** The raw `metafields.value` string (already JSON-encoded per service contract). */
  value: string
}

/** Metadata for a discovered metafield column. */
export interface MetafieldColumn {
  owner: 'product' | 'variant'
  namespace: string
  key: string
  value_type: string
  /**
   * Cache key used to look up a cell on a product/variant at row-build
   * time. Always `${namespace}.${key}`.
   */
  cacheKey: string
  /** Human-readable header text (Shopify parity). */
  header: string
}

export interface ExportOptions {
  /** Include product-level metafields (default: true when columns provided). */
  includeProductMetafields?: boolean
  /** Include variant-level metafields (default: true when columns provided). */
  includeVariantMetafields?: boolean
  /** Include SEO title / description columns (default: true). */
  includeSeo?: boolean
  /** Include cost-per-item column (default: true). */
  includeCost?: boolean
  /**
   * Metafield columns to include. Normally computed by the fetch service
   * from a DISTINCT query and passed in — this keeps the exporter pure.
   */
  metafieldColumns?: MetafieldColumn[]
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Escape a CSV field — wrap in quotes if it contains comma, newline, or quote. */
export function csvField(val: unknown): string {
  if (val === null || val === undefined) return ''
  const s = typeof val === 'string' ? val : String(val)
  if (
    s.includes(',') ||
    s.includes('"') ||
    s.includes('\n') ||
    s.includes('\r')
  ) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

// ---------------------------------------------------------------------------
// Column definitions (Shopify parity)
// ---------------------------------------------------------------------------

/**
 * Core product + variant + image columns. The order matches Shopify's
 * Products CSV verbatim so third-party tools don't need a translation
 * table.
 */
export const CORE_COLUMNS = [
  'Handle',
  'Title',
  'Body (HTML)',
  'Vendor',
  'Type',
  'Tags',
  'Published',
  'Option1 Name',
  'Option1 Value',
  'Option2 Name',
  'Option2 Value',
  'Option3 Name',
  'Option3 Value',
  'Variant SKU',
  'Variant Grams',
  'Variant Inventory Tracker',
  'Variant Inventory Qty',
  'Variant Inventory Policy',
  'Variant Fulfillment Service',
  'Variant Price',
  'Variant Compare At Price',
  'Variant Requires Shipping',
  'Variant Taxable',
  'Variant Barcode',
  'Image Src',
  'Image Position',
  'Image Alt Text',
  'Gift Card',
  'Variant Image',
  'Variant Weight Unit',
  'Status',
  // Migration 054 — Variant deep fields (Shopify CSV parity). Appended
  // at the tail so third-party tools that ignore unknown columns still
  // parse the core layout unchanged.
  'Variant HS Code',
  'Variant Country of Origin',
] as const

const SEO_COLUMNS = ['SEO Title', 'SEO Description'] as const
const COST_COLUMNS = ['Cost per item'] as const

/** Build the Shopify-style header text for a metafield column. */
export function metafieldHeader(col: {
  owner: 'product' | 'variant'
  namespace: string
  key: string
  value_type: string
}): string {
  const ownerLabel = col.owner === 'product' ? 'Product Metafield' : 'Variant Metafield'
  return `${ownerLabel}: ${col.namespace}.${col.key} [${col.value_type}]`
}

// ---------------------------------------------------------------------------
// Header builder
// ---------------------------------------------------------------------------

/**
 * Build the header row given the chosen options. Metafield columns (if
 * any) land after the core columns — never interleaved, so third-party
 * importers that ignore unknown columns still work.
 */
export function buildHeaders(options: ExportOptions = {}): string[] {
  const {
    includeSeo = true,
    includeCost = true,
    metafieldColumns = [],
    includeProductMetafields = true,
    includeVariantMetafields = true,
  } = options

  const cols: string[] = [...CORE_COLUMNS]
  if (includeSeo) cols.push(...SEO_COLUMNS)
  if (includeCost) cols.push(...COST_COLUMNS)

  for (const mc of metafieldColumns) {
    if (mc.owner === 'product' && !includeProductMetafields) continue
    if (mc.owner === 'variant' && !includeVariantMetafields) continue
    cols.push(mc.header)
  }
  return cols
}

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------

/**
 * Map Gbox status ('active' | 'draft' | 'archived') to Shopify's "Published"
 * and "Status" columns.
 *   - active    → Published=TRUE, Status=active
 *   - draft     → Published=FALSE, Status=draft
 *   - archived  → Published=FALSE, Status=archived
 */
function statusCells(status: string): { published: string; status: string } {
  const s = (status || 'draft').toLowerCase()
  if (s === 'active') return { published: 'TRUE', status: 'active' }
  if (s === 'archived') return { published: 'FALSE', status: 'archived' }
  return { published: 'FALSE', status: 'draft' }
}

/** Derive grams from a variant's `weight` + `weight_unit` for Shopify parity. */
function toGrams(weight: string | null, unit: string): number {
  if (!weight) return 0
  const n = Number(weight)
  if (!Number.isFinite(n)) return 0
  const u = (unit || 'kg').toLowerCase()
  switch (u) {
    case 'kg':
      return Math.round(n * 1000)
    case 'g':
      return Math.round(n)
    case 'lb':
      return Math.round(n * 453.59237)
    case 'oz':
      return Math.round(n * 28.3495231)
    default:
      return Math.round(n)
  }
}

/**
 * Convert a single product to CSV rows (Shopify layout). Always at least
 * one row per product even if it has no variants and no images (the row
 * still carries Handle + Title so the product exists in the import).
 */
export function productToRows(
  product: ExportProduct,
  options: ExportOptions = {},
): string[][] {
  const {
    includeSeo = true,
    includeCost = true,
    metafieldColumns = [],
    includeProductMetafields = true,
    includeVariantMetafields = true,
  } = options

  const rows: string[][] = []
  const variants = product.variants.length > 0 ? product.variants : [null]
  const extraImages = product.images.slice(1) // images beyond the first

  const optionNames = [
    product.options[0]?.name ?? '',
    product.options[1]?.name ?? '',
    product.options[2]?.name ?? '',
  ]

  const { published, status } = statusCells(product.status)
  const tagsText = Array.isArray(product.tags) ? product.tags.join(', ') : ''
  const firstImage = product.images[0]

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]
    const isFirstVariantRow = i === 0

    // Product-level fields only appear on the first variant row — Shopify's
    // convention for re-import reliability (importer picks the first row per
    // handle as the "product identity" row).
    const row: Array<string | number> = []
    row.push(product.handle)
    row.push(isFirstVariantRow ? product.title : '')
    row.push(isFirstVariantRow ? (product.body_html ?? '') : '')
    row.push(isFirstVariantRow ? (product.vendor ?? '') : '')
    row.push(isFirstVariantRow ? (product.product_type ?? '') : '')
    row.push(isFirstVariantRow ? tagsText : '')
    row.push(isFirstVariantRow ? published : '')

    // Option names repeat on every row (Shopify parity). Option values come
    // from the variant.
    row.push(optionNames[0])
    row.push(v?.option1 ?? '')
    row.push(optionNames[1])
    row.push(v?.option2 ?? '')
    row.push(optionNames[2])
    row.push(v?.option3 ?? '')

    if (v) {
      row.push(v.sku ?? '')
      row.push(v.grams)
      row.push(v.inventory_tracker)
      row.push(v.inventory_quantity)
      row.push(v.inventory_policy)
      row.push(v.fulfillment_service)
      row.push(v.price)
      row.push(v.compare_at_price ?? '')
      row.push(v.requires_shipping ? 'TRUE' : 'FALSE')
      row.push(v.taxable ? 'TRUE' : 'FALSE')
      row.push(v.barcode ?? '')
    } else {
      // No variants — blank variant columns.
      row.push('', '', '', '', '', '', '', '', '', '', '')
    }

    // First image goes on the first variant row; otherwise blank here (extra
    // image rows are emitted at the tail).
    if (isFirstVariantRow && firstImage) {
      row.push(firstImage.src)
      row.push(firstImage.position)
      row.push(firstImage.alt ?? '')
    } else {
      row.push('', '', '')
    }

    // Shopify parity: "Gift Card" column — we don't model gift-card products
    // yet, so always FALSE for now.
    row.push('FALSE')

    row.push(v?.image_url ?? '')
    row.push(v?.weight_unit ?? 'kg')
    row.push(isFirstVariantRow ? status : '')
    // Migration 054 — Variant HS Code + Country of Origin (per variant).
    row.push(v?.hs_code ?? '')
    row.push(v?.country_of_origin ?? '')

    if (includeSeo) {
      row.push(isFirstVariantRow ? (product.seo_title ?? '') : '')
      row.push(isFirstVariantRow ? (product.seo_description ?? '') : '')
    }
    if (includeCost) {
      row.push(v?.cost ?? '')
    }

    for (const mc of metafieldColumns) {
      if (mc.owner === 'product') {
        if (!includeProductMetafields) continue
        // Product metafields render only on first variant row to avoid
        // duplicating the same value down every row.
        const cell = isFirstVariantRow ? product.metafields[mc.cacheKey] : undefined
        row.push(cell ? cell.value : '')
      } else {
        if (!includeVariantMetafields) continue
        const cell = v ? v.metafields[mc.cacheKey] : undefined
        row.push(cell ? cell.value : '')
      }
    }

    rows.push(row.map((x) => (x === null || x === undefined ? '' : String(x))))
  }

  // Extra images — each on its own row, Handle + image cols only.
  for (const img of extraImages) {
    const row: string[] = []
    for (const _ of CORE_COLUMNS) row.push('')
    if (includeSeo) for (const _ of SEO_COLUMNS) row.push('')
    if (includeCost) for (const _ of COST_COLUMNS) row.push('')
    for (const mc of metafieldColumns) {
      if (mc.owner === 'product' && !includeProductMetafields) continue
      if (mc.owner === 'variant' && !includeVariantMetafields) continue
      row.push('')
    }
    // Fill the three image cells and Handle at their indices in CORE_COLUMNS.
    row[CORE_COLUMNS.indexOf('Handle')] = product.handle
    row[CORE_COLUMNS.indexOf('Image Src')] = img.src
    row[CORE_COLUMNS.indexOf('Image Position')] = String(img.position)
    row[CORE_COLUMNS.indexOf('Image Alt Text')] = img.alt ?? ''
    rows.push(row)
  }

  return rows
}

// ---------------------------------------------------------------------------
// Top-level CSV builder
// ---------------------------------------------------------------------------

/**
 * Materialize the full CSV as a single string. For large exports prefer
 * streaming via buildHeaders + productToRows row-by-row, but for small
 * exports (the common case) this is the simplest entry point.
 */
export function exportProductsCsv(
  products: ExportProduct[],
  options: ExportOptions = {},
): string {
  const headers = buildHeaders(options)
  const lines: string[] = [headers.map(csvField).join(',')]
  for (const p of products) {
    const rows = productToRows(p, options)
    for (const row of rows) {
      lines.push(row.map(csvField).join(','))
    }
  }
  return lines.join('\n')
}

/** JSON export — straight passthrough for merchants who want structured data. */
export function exportProductsJson(products: ExportProduct[]): string {
  return JSON.stringify(products, null, 2)
}

// ---------------------------------------------------------------------------
// Column discovery helpers (used by the fetch service)
// ---------------------------------------------------------------------------

/**
 * Given a list of raw metafield rows (already filtered to shop+owner_type+
 * owner_ids in scope), return the stable sorted set of unique
 * `MetafieldColumn` entries that need CSV columns.
 *
 * Ordering: product columns first (alphabetical by namespace.key), then
 * variant columns (alphabetical by namespace.key). This keeps the header
 * deterministic across runs — golden tests depend on it.
 */
export function discoverMetafieldColumns(
  rows: Array<{ owner_type: string; namespace: string; key: string; value_type: string }>,
): MetafieldColumn[] {
  const seen = new Map<string, MetafieldColumn>()
  for (const r of rows) {
    if (r.owner_type !== 'product' && r.owner_type !== 'variant') continue
    const owner = r.owner_type as 'product' | 'variant'
    const cacheKey = `${r.namespace}.${r.key}`
    const uniqueKey = `${owner}|${cacheKey}|${r.value_type}`
    if (seen.has(uniqueKey)) continue
    seen.set(uniqueKey, {
      owner,
      namespace: r.namespace,
      key: r.key,
      value_type: r.value_type,
      cacheKey,
      header: metafieldHeader({
        owner,
        namespace: r.namespace,
        key: r.key,
        value_type: r.value_type,
      }),
    })
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.owner !== b.owner) return a.owner === 'product' ? -1 : 1
    return a.cacheKey.localeCompare(b.cacheKey)
  })
}
