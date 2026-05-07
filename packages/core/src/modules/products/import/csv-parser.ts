/**
 * Products CSV Parser (Shopify-compatible, inverse of csv-exporter.ts)
 *
 * Reads a Shopify-format Products CSV and re-assembles it into an array of
 * `ParsedProduct` structures ready for validation + import. The parser is
 * deliberately pure — no DB access, no I/O — so it can be unit-tested
 * without fixtures.
 *
 * Multi-row product handling (Shopify parity):
 *   - The first row for a product carries the product-level columns.
 *     Subsequent rows with the same `Handle` and blank product columns
 *     append variants or images to the existing product.
 *   - An "image-only" row (blank Variant SKU + blank Option1 Value, but
 *     non-blank Image Src) adds an image only.
 *   - Tags, Vendor, Type, etc. on subsequent rows are IGNORED — Shopify
 *     treats the first row as authoritative.
 *
 * Error handling:
 *   - Malformed CSV (unbalanced quotes, bad line endings) throws ParseError.
 *     The caller surfaces this as a top-level error — the rest of the file
 *     isn't salvageable past a quote imbalance.
 *   - Cell-level issues (bad numbers, invalid enums, missing required) are
 *     NOT thrown here — they become validator errors downstream. Parser's
 *     job is just to shape.
 *
 * Forward-compat:
 *   - Unknown columns are preserved on `ParsedProduct.extraColumns` (keyed
 *     by header) so a later round-trip can echo them back. This matches
 *     the exporter's tail-append convention.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A product parsed from one or more CSV rows. */
export interface ParsedProduct {
  /** 1-indexed source row of the first (header-bearing) product row. */
  sourceRow: number
  handle: string
  title: string | null
  body_html: string | null
  vendor: string | null
  product_type: string | null
  tags: string[] | null
  published: boolean | null
  status: string | null                 // 'active' | 'draft' | 'archived' | null
  seo_title: string | null
  seo_description: string | null
  gift_card: boolean | null
  variants: ParsedVariant[]
  images: ParsedImage[]
  /** Option name per position (position is 1/2/3 index). */
  optionNames: [string | null, string | null, string | null]
  /**
   * Product-level metafield cells indexed by `${namespace}.${key}`. Header
   * format parsed: "Product Metafield: ns.key [value_type]".
   */
  metafields: Record<string, ParsedMetafieldCell>
  /** Any unrecognised columns echoed back verbatim per-row. */
  extraColumns: Record<string, string>
}

export interface ParsedVariant {
  /** 1-indexed source row that introduced this variant. */
  sourceRow: number
  sku: string | null
  barcode: string | null
  price: string | null                  // decimal string, preserved verbatim
  compare_at_price: string | null
  cost: string | null
  grams: number | null
  weight_unit: string | null            // 'kg' | 'g' | 'lb' | 'oz' | null
  inventory_quantity: number | null
  inventory_policy: string | null       // 'deny' | 'continue' | null
  inventory_tracker: string | null      // 'shopify' | '' | null (mapped to inventory_management downstream)
  fulfillment_service: string | null
  requires_shipping: boolean | null
  taxable: boolean | null
  option1: string | null
  option2: string | null
  option3: string | null
  image_url: string | null
  // Migration 054 — variant deep fields.
  hs_code: string | null
  country_of_origin: string | null
  /** Variant-level metafields keyed by `${namespace}.${key}`. */
  metafields: Record<string, ParsedMetafieldCell>
}

export interface ParsedImage {
  sourceRow: number
  src: string
  alt: string | null
  position: number | null
}

export interface ParsedMetafieldCell {
  namespace: string
  key: string
  value_type: string
  /** Raw cell value (caller decides JSON parse / cast). */
  value: string
}

export class ParseError extends Error {
  public readonly line: number
  public readonly column: number | null
  constructor(message: string, line: number, column: number | null = null) {
    super(message)
    this.name = 'ParseError'
    this.line = line
    this.column = column
  }
}

// ---------------------------------------------------------------------------
// CSV tokenizer (RFC 4180-ish)
// ---------------------------------------------------------------------------

/**
 * Tokenize raw CSV text into `string[][]`. Handles quoted fields, escaped
 * double quotes (`""`), and both `\n` / `\r\n` line endings. Trailing empty
 * lines are dropped. Throws ParseError on unbalanced quotes.
 */
export function tokenizeCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let line = 1
  let col = 0

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    col++

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
          col++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
        if (ch === '\n') {
          line++
          col = 0
        }
      }
      continue
    }

    if (ch === '"') {
      // Quote only legal at field start
      if (field.length === 0) {
        inQuotes = true
      } else {
        throw new ParseError('Unexpected quote mid-field', line, col)
      }
      continue
    }

    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }

    if (ch === '\r') {
      // CR is swallowed; LF terminates the row
      continue
    }

    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      line++
      col = 0
      continue
    }

    field += ch
  }

  if (inQuotes) {
    throw new ParseError('Unterminated quoted field at end of file', line, col)
  }

  // Flush final row if the file didn't end on \n.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  // Drop any all-blank trailing rows (common CSV editors).
  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last && last.every((c) => c === '')) rows.pop()
    else break
  }

  return rows
}

// ---------------------------------------------------------------------------
// Header → column-index map
// ---------------------------------------------------------------------------

/**
 * Case-insensitive, whitespace-tolerant header-index resolver.
 * Returns `-1` if the column isn't present — callers treat missing columns
 * as "field always null" rather than throwing.
 */
export class HeaderIndex {
  private readonly map: Map<string, number>
  public readonly headers: readonly string[]
  /**
   * Parsed Shopify-format metafield column metadata. One entry per column
   * whose header matches `/(Product|Variant) Metafield: ns.key [type]/`.
   */
  public readonly metafieldColumns: ParsedMetafieldColumn[]
  public readonly extraColumns: string[]

  constructor(headers: string[]) {
    this.headers = headers
    this.map = new Map()
    this.metafieldColumns = []
    this.extraColumns = []

    for (let i = 0; i < headers.length; i++) {
      const raw = headers[i] ?? ''
      const norm = raw.trim().toLowerCase()
      this.map.set(norm, i)

      const mfMatch = /^(product|variant) metafield:\s*([^.]+)\.([^\s\[]+)\s*\[([^\]]+)\]$/i.exec(
        raw.trim(),
      )
      if (mfMatch) {
        this.metafieldColumns.push({
          index: i,
          owner: mfMatch[1]!.toLowerCase() as 'product' | 'variant',
          namespace: mfMatch[2]!.trim(),
          key: mfMatch[3]!.trim(),
          value_type: mfMatch[4]!.trim(),
          cacheKey: `${mfMatch[2]!.trim()}.${mfMatch[3]!.trim()}`,
        })
      } else if (!CORE_HEADERS.has(norm) && raw.trim().length > 0) {
        this.extraColumns.push(raw)
      }
    }
  }

  index(header: string): number {
    return this.map.get(header.trim().toLowerCase()) ?? -1
  }

  get(row: string[], header: string): string {
    const idx = this.index(header)
    return idx >= 0 ? (row[idx] ?? '') : ''
  }
}

export interface ParsedMetafieldColumn {
  index: number
  owner: 'product' | 'variant'
  namespace: string
  key: string
  value_type: string
  /** `${namespace}.${key}` */
  cacheKey: string
}

/**
 * Lower-cased set of every core column the exporter emits. Used by
 * `HeaderIndex` to classify stray columns into `extraColumns` (preserved
 * for round-trip) vs metafields (parsed).
 */
const CORE_HEADERS = new Set<string>(
  [
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
    'Variant HS Code',
    'Variant Country of Origin',
    'SEO Title',
    'SEO Description',
    'Cost per item',
  ].map((h) => h.toLowerCase()),
)

// ---------------------------------------------------------------------------
// Cell coercion helpers
// ---------------------------------------------------------------------------

function emptyToNull(s: string): string | null {
  return s.length === 0 ? null : s
}

function parseBool(s: string): boolean | null {
  const v = s.trim().toLowerCase()
  if (v === '') return null
  if (v === 'true' || v === 'yes' || v === '1') return true
  if (v === 'false' || v === 'no' || v === '0') return false
  return null
}

function parseIntLoose(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number.parseInt(t, 10)
  return Number.isFinite(n) ? n : null
}

function parseTagList(s: string): string[] | null {
  const t = s.trim()
  if (t === '') return null
  return t
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

// ---------------------------------------------------------------------------
// Row classification
// ---------------------------------------------------------------------------

/**
 * A row is a "product header" row if Title is non-blank OR Option1 Value
 * is non-blank AND Handle is non-blank and no prior row for this handle
 * has established product fields. We take the simpler rule that matches
 * Shopify's CSV:
 *
 *   - The FIRST row for any given Handle carries product-level columns.
 *   - Subsequent rows with the same Handle append variants/images.
 *
 * So the parser groups by Handle in appearance order and treats the first
 * row of each group as the product header.
 */

// ---------------------------------------------------------------------------
// Main parse()
// ---------------------------------------------------------------------------

export interface ParseResult {
  products: ParsedProduct[]
  headers: readonly string[]
  /** Row-level parse notes (non-fatal). Validator emits the real errors. */
  notes: Array<{ line: number; message: string }>
}

export function parseCsv(input: string): ParseResult {
  const rows = tokenizeCsv(input)
  if (rows.length === 0) {
    return { products: [], headers: [], notes: [] }
  }

  const headers = rows[0]!
  const hx = new HeaderIndex(headers)
  const notes: Array<{ line: number; message: string }> = []

  // Handle column is required. Without it we can't group.
  if (hx.index('Handle') < 0) {
    throw new ParseError('CSV is missing the required "Handle" column', 1)
  }

  const byHandle = new Map<string, ParsedProduct>()
  const order: string[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!
    const sourceRow = i + 1 // 1-indexed, accounting for header row
    const handle = hx.get(row, 'Handle').trim()

    if (handle === '') {
      // Row with no handle is ignored but noted.
      notes.push({ line: sourceRow, message: 'Row has no Handle; skipped' })
      continue
    }

    let product = byHandle.get(handle)
    const isFirst = product === undefined
    if (!product) {
      product = newParsedProduct(handle, sourceRow)
      byHandle.set(handle, product)
      order.push(handle)
    }

    if (isFirst) {
      applyProductLevelFields(product, row, hx)
    }

    // Each row can contribute a variant and/or an image. An "image-only"
    // row is one where Image Src is set but Variant SKU + Option1 Value +
    // Price are all blank.
    const imageSrc = hx.get(row, 'Image Src').trim()
    const hasVariantSignal =
      hx.get(row, 'Variant SKU').trim() !== '' ||
      hx.get(row, 'Option1 Value').trim() !== '' ||
      hx.get(row, 'Variant Price').trim() !== '' ||
      hx.get(row, 'Variant Barcode').trim() !== '' ||
      isFirst // first row always contributes a variant

    if (hasVariantSignal) {
      product.variants.push(parseVariantRow(row, hx, sourceRow))
    }

    if (imageSrc !== '') {
      const existing = product.images.find((img) => img.src === imageSrc)
      if (!existing) {
        product.images.push({
          sourceRow,
          src: imageSrc,
          alt: emptyToNull(hx.get(row, 'Image Alt Text')),
          position: parseIntLoose(hx.get(row, 'Image Position')),
        })
      }
    }

    // Capture extra (unknown) columns verbatim on the product (first row only
    // to avoid duplicating per-row).
    if (isFirst) {
      for (const extra of hx.extraColumns) {
        const idx = hx.index(extra)
        if (idx >= 0) product.extraColumns[extra] = row[idx] ?? ''
      }
    }

    // Metafields — product-level on first row, variant-level on the last
    // variant row we just pushed (if any).
    for (const mf of hx.metafieldColumns) {
      const raw = row[mf.index] ?? ''
      if (raw === '') continue

      const cell: ParsedMetafieldCell = {
        namespace: mf.namespace,
        key: mf.key,
        value_type: mf.value_type,
        value: raw,
      }
      if (mf.owner === 'product' && isFirst) {
        product.metafields[mf.cacheKey] = cell
      } else if (mf.owner === 'variant' && hasVariantSignal) {
        const v = product.variants[product.variants.length - 1]
        if (v) v.metafields[mf.cacheKey] = cell
      }
    }
  }

  return {
    products: order.map((h) => byHandle.get(h)!),
    headers,
    notes,
  }
}

function newParsedProduct(handle: string, sourceRow: number): ParsedProduct {
  return {
    sourceRow,
    handle,
    title: null,
    body_html: null,
    vendor: null,
    product_type: null,
    tags: null,
    published: null,
    status: null,
    seo_title: null,
    seo_description: null,
    gift_card: null,
    variants: [],
    images: [],
    optionNames: [null, null, null],
    metafields: {},
    extraColumns: {},
  }
}

function applyProductLevelFields(
  product: ParsedProduct,
  row: string[],
  hx: HeaderIndex,
): void {
  product.title = emptyToNull(hx.get(row, 'Title'))
  product.body_html = emptyToNull(hx.get(row, 'Body (HTML)'))
  product.vendor = emptyToNull(hx.get(row, 'Vendor'))
  product.product_type = emptyToNull(hx.get(row, 'Type'))
  product.tags = parseTagList(hx.get(row, 'Tags'))
  product.published = parseBool(hx.get(row, 'Published'))
  product.status = emptyToNull(hx.get(row, 'Status'))?.toLowerCase() ?? null
  product.seo_title = emptyToNull(hx.get(row, 'SEO Title'))
  product.seo_description = emptyToNull(hx.get(row, 'SEO Description'))
  product.gift_card = parseBool(hx.get(row, 'Gift Card'))
  product.optionNames = [
    emptyToNull(hx.get(row, 'Option1 Name')),
    emptyToNull(hx.get(row, 'Option2 Name')),
    emptyToNull(hx.get(row, 'Option3 Name')),
  ]
}

function parseVariantRow(
  row: string[],
  hx: HeaderIndex,
  sourceRow: number,
): ParsedVariant {
  return {
    sourceRow,
    sku: emptyToNull(hx.get(row, 'Variant SKU')),
    barcode: emptyToNull(hx.get(row, 'Variant Barcode')),
    price: emptyToNull(hx.get(row, 'Variant Price')),
    compare_at_price: emptyToNull(hx.get(row, 'Variant Compare At Price')),
    cost: emptyToNull(hx.get(row, 'Cost per item')),
    grams: parseIntLoose(hx.get(row, 'Variant Grams')),
    weight_unit: emptyToNull(hx.get(row, 'Variant Weight Unit')),
    inventory_quantity: parseIntLoose(hx.get(row, 'Variant Inventory Qty')),
    inventory_policy: emptyToNull(hx.get(row, 'Variant Inventory Policy'))?.toLowerCase() ?? null,
    inventory_tracker: emptyToNull(hx.get(row, 'Variant Inventory Tracker'))?.toLowerCase() ?? null,
    fulfillment_service: emptyToNull(hx.get(row, 'Variant Fulfillment Service')),
    requires_shipping: parseBool(hx.get(row, 'Variant Requires Shipping')),
    taxable: parseBool(hx.get(row, 'Variant Taxable')),
    option1: emptyToNull(hx.get(row, 'Option1 Value')),
    option2: emptyToNull(hx.get(row, 'Option2 Value')),
    option3: emptyToNull(hx.get(row, 'Option3 Value')),
    image_url: emptyToNull(hx.get(row, 'Variant Image')),
    hs_code: emptyToNull(hx.get(row, 'Variant HS Code')),
    country_of_origin:
      emptyToNull(hx.get(row, 'Variant Country of Origin'))?.toUpperCase() ?? null,
    metafields: {},
  }
}
