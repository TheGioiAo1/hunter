/**
 * Customer CSV — Shopify-parity column specification.
 *
 * Single source of truth for both the exporter (column order in the
 * output header) and the importer (aliases accepted in incoming CSVs).
 * The exporter writes headers in this exact order; the importer
 * resolves incoming headers case-insensitively against this table and
 * ignores any extra columns.
 *
 * Shopify's own customer CSV varies slightly across admin versions
 * ("Accepts Marketing" vs "Accepts Email Marketing"), so each logical
 * field lists every alias we'll accept on import. On export we emit
 * the canonical name (first entry in aliases).
 *
 * Read-only columns (Total Spent / Total Orders / Lifecycle Stage) are
 * emitted on export for visibility but silently ignored on import —
 * those values are denormalised from orders + the lifecycle classifier
 * and would be overwritten on the next order anyway.
 */

/** Logical field keys used by the parser/exporter/plan. */
export type CustomerCsvField =
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'company'
  | 'address1'
  | 'address2'
  | 'city'
  | 'province'
  | 'province_code'
  | 'country'
  | 'country_code'
  | 'zip'
  | 'phone'
  | 'accepts_marketing'
  | 'total_spent'
  | 'total_orders'
  | 'note'
  | 'tags'
  | 'tax_exempt'
  | 'lifecycle_stage'

/** Target of a field: customer row vs default address row. */
export type CustomerCsvTarget = 'customer' | 'address' | 'readonly'

export interface CustomerCsvColumn {
  field: CustomerCsvField
  /** Canonical header (first) + accepted aliases for import. */
  aliases: readonly string[]
  /**
   * Which table the field writes to on import. `readonly` = export-only,
   * ignored on import (e.g. Total Spent is computed from orders).
   */
  target: CustomerCsvTarget
}

/**
 * The canonical header set, in export order. Matches the Shopify admin
 * "Export customers" file column order so sellers can round-trip
 * through Shopify without reshaping.
 */
export const CUSTOMER_CSV_COLUMNS: readonly CustomerCsvColumn[] = [
  { field: 'first_name', target: 'customer', aliases: ['First Name', 'first_name'] },
  { field: 'last_name', target: 'customer', aliases: ['Last Name', 'last_name'] },
  { field: 'email', target: 'customer', aliases: ['Email', 'email'] },
  { field: 'company', target: 'address', aliases: ['Company', 'company'] },
  { field: 'address1', target: 'address', aliases: ['Address1', 'Address 1', 'address1'] },
  { field: 'address2', target: 'address', aliases: ['Address2', 'Address 2', 'address2'] },
  { field: 'city', target: 'address', aliases: ['City', 'city'] },
  { field: 'province', target: 'address', aliases: ['Province', 'State', 'province'] },
  { field: 'province_code', target: 'address', aliases: ['Province Code', 'State Code', 'province_code'] },
  { field: 'country', target: 'address', aliases: ['Country', 'country'] },
  { field: 'country_code', target: 'address', aliases: ['Country Code', 'country_code'] },
  { field: 'zip', target: 'address', aliases: ['Zip', 'ZIP', 'Postal Code', 'zip'] },
  { field: 'phone', target: 'customer', aliases: ['Phone', 'phone'] },
  {
    field: 'accepts_marketing',
    target: 'customer',
    aliases: ['Accepts Email Marketing', 'Accepts Marketing', 'accepts_marketing'],
  },
  { field: 'total_spent', target: 'readonly', aliases: ['Total Spent', 'total_spent'] },
  { field: 'total_orders', target: 'readonly', aliases: ['Total Orders', 'total_orders'] },
  { field: 'note', target: 'customer', aliases: ['Note', 'note'] },
  { field: 'tags', target: 'customer', aliases: ['Tags', 'tags'] },
  { field: 'tax_exempt', target: 'customer', aliases: ['Tax Exempt', 'tax_exempt'] },
  { field: 'lifecycle_stage', target: 'readonly', aliases: ['Lifecycle Stage', 'lifecycle_stage'] },
] as const

/**
 * Canonical export header row — first alias of every column, in order.
 * Stable across versions so diffs of exported CSVs stay small.
 */
export const CUSTOMER_CSV_HEADERS: readonly string[] = CUSTOMER_CSV_COLUMNS.map(
  (c) => c.aliases[0]!,
)

/**
 * Case-insensitive alias → column lookup for the importer. Normalises
 * whitespace and case so `accepts_marketing`, `Accepts Marketing`, and
 * `ACCEPTS EMAIL MARKETING` all map to the same field.
 */
export function buildAliasMap(): Map<string, CustomerCsvColumn> {
  const map = new Map<string, CustomerCsvColumn>()
  for (const col of CUSTOMER_CSV_COLUMNS) {
    for (const alias of col.aliases) {
      map.set(normalizeHeader(alias), col)
    }
  }
  return map
}

/** Normalise a header cell for alias lookup — trim + collapse spaces + lowercase. */
export function normalizeHeader(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Parse an "Accepts Marketing"-style cell into boolean. Accepts the
 * variants Shopify's CSV exports have used across versions:
 *   - yes / no
 *   - true / false
 *   - 1 / 0
 *   - y / n
 * Empty/unknown → `false` (seller-safe default — better to miss a
 * marketing opt-in than spam an unsubscribed customer).
 */
export function parseBooleanCell(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false
  const norm = String(value).trim().toLowerCase()
  return norm === 'yes' || norm === 'true' || norm === '1' || norm === 'y'
}

/** Encode a boolean for Shopify-parity export — "yes" / "no". */
export function encodeBooleanCell(value: boolean | null | undefined): string {
  return value === true ? 'yes' : 'no'
}

/**
 * Split a Tags cell into an array. Shopify uses a single column with
 * comma-separated values; internal whitespace is trimmed and blanks
 * dropped. Quoted cells reach us already unquoted by the tokenizer.
 */
export function parseTagsCell(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return []
  const out: string[] = []
  for (const part of String(value).split(',')) {
    const trimmed = part.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/** Join a tags array back into a comma-separated cell. Empty → ''. */
export function encodeTagsCell(tags: readonly string[] | null | undefined): string {
  if (!tags || tags.length === 0) return ''
  return tags.join(', ')
}
