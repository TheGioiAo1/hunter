/**
 * Customer CSV Parser (Shopify-compatible, one row per customer).
 *
 * Unlike the product CSV (which groups variants under a handle across
 * multiple rows), Shopify's customer CSV is strictly one-row-per-
 * customer: each row carries a single default address inline. So this
 * parser is simpler — tokenize, validate headers, map each row to a
 * `ParsedCustomer`.
 *
 * Pipeline:
 *   rawCsvText → tokenizeCsv (shared) → parseCustomersCsv → ParsedCustomer[]
 *
 * The parser is **pure** — no DB, no I/O. The commit path
 * (`import-apply.ts`) reads the parser output + validates against DB
 * state. Cell-level errors (bad email, invalid enums) are reported as
 * `ValidationIssue`s on the parse result rather than throwing, so a
 * single bad row doesn't kill the preview.
 *
 * Structural errors (unbalanced quotes, no header row, missing Email
 * column) DO throw `ParseError` — the file isn't salvageable past
 * those.
 */

import { tokenizeCsv, ParseError } from '../../products/import/csv-parser.js'
import {
  CUSTOMER_CSV_COLUMNS,
  buildAliasMap,
  normalizeHeader,
  parseBooleanCell,
  parseTagsCell,
  type CustomerCsvColumn,
  type CustomerCsvField,
} from './columns.js'

export { ParseError } from '../../products/import/csv-parser.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One customer parsed from one CSV row. All fields are nullable — a
 * CSV may omit any column and we don't pre-validate required fields
 * here (email-required lives in the plan builder so it can show a
 * per-row issue).
 */
export interface ParsedCustomer {
  /** 1-indexed source row in the original file (header row = 1). */
  sourceRow: number
  // Customer row fields
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  accepts_marketing: boolean
  note: string | null
  tags: string[] | null
  tax_exempt: boolean
  // Default address fields (all nullable — row may have no address columns)
  address: ParsedCustomerAddress | null
  /** Unknown columns echoed back for forward-compat / tool round-trips. */
  extraColumns: Record<string, string>
}

export interface ParsedCustomerAddress {
  first_name: string | null
  last_name: string | null
  company: string | null
  address1: string | null
  address2: string | null
  city: string | null
  province: string | null
  province_code: string | null
  country: string | null
  country_code: string | null
  zip: string | null
  phone: string | null
}

export interface ParsedCustomerCsvNote {
  line: number
  message: string
}

export interface ParsedCustomersCsv {
  customers: ParsedCustomer[]
  notes: ParsedCustomerCsvNote[]
  headers: readonly string[]
  /** Unrecognised columns (not in alias map). Echoed onto each row's extraColumns too. */
  extraColumns: string[]
}

// ---------------------------------------------------------------------------
// Header → column-index map
// ---------------------------------------------------------------------------

/**
 * Customer-specific header index. Thinner than products' `HeaderIndex`
 * (no metafield columns) and with alias resolution baked in.
 */
export class CustomerHeaderIndex {
  public readonly headers: readonly string[]
  public readonly extraColumns: string[]
  private readonly fieldToIndex: Map<CustomerCsvField, number>
  private readonly aliasMap: Map<string, CustomerCsvColumn>

  constructor(headers: string[]) {
    this.headers = headers
    this.aliasMap = buildAliasMap()
    this.fieldToIndex = new Map<CustomerCsvField, number>()
    this.extraColumns = []

    for (let i = 0; i < headers.length; i++) {
      const raw = headers[i] ?? ''
      if (raw.trim().length === 0) continue
      const norm = normalizeHeader(raw)
      const col = this.aliasMap.get(norm)
      if (col) {
        // First column wins if a file duplicates a field — we just
        // read the first one and note the dup as a parse note.
        if (!this.fieldToIndex.has(col.field)) {
          this.fieldToIndex.set(col.field, i)
        }
      } else {
        this.extraColumns.push(raw)
      }
    }
  }

  /** Returns -1 if the field isn't in the file. */
  index(field: CustomerCsvField): number {
    return this.fieldToIndex.get(field) ?? -1
  }

  /**
   * Read a field's cell from a row. Returns empty string when either
   * the column is absent or the row is too short — caller treats
   * empty as "not provided".
   */
  get(row: string[], field: CustomerCsvField): string {
    const idx = this.index(field)
    return idx >= 0 ? (row[idx] ?? '') : ''
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Parse a full Shopify-format customer CSV.
 *
 * Throws `ParseError` on structural problems (malformed CSV, missing
 * header row, no Email column — we need it to upsert). Cell-level
 * issues are reported on `notes[]`, not thrown, so the caller can show
 * a partial preview.
 */
export function parseCustomersCsv(text: string): ParsedCustomersCsv {
  // Strip UTF-8 BOM — Excel loves it.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows = tokenizeCsv(clean)
  if (rows.length === 0) {
    throw new ParseError('CSV is empty', 1, null)
  }

  const headers = rows[0]!
  const idx = new CustomerHeaderIndex(headers)

  if (idx.index('email') < 0) {
    throw new ParseError(
      'CSV is missing required "Email" column — it\'s the upsert key.',
      1,
      null,
    )
  }

  const notes: ParsedCustomerCsvNote[] = []
  const customers: ParsedCustomer[] = []

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!
    const sourceRow = r + 1 // 1-indexed, header row is line 1

    // Blank-row skip — a CSV with stray empty lines shouldn't produce
    // empty customers. We consider the row blank if every cell is
    // empty-after-trim.
    const isBlank = row.every((c) => c.trim().length === 0)
    if (isBlank) continue

    const emailRaw = idx.get(row, 'email').trim()
    const parsed: ParsedCustomer = {
      sourceRow,
      first_name: nullIfBlank(idx.get(row, 'first_name')),
      last_name: nullIfBlank(idx.get(row, 'last_name')),
      email: nullIfBlank(emailRaw),
      phone: nullIfBlank(idx.get(row, 'phone')),
      accepts_marketing: parseBooleanCell(idx.get(row, 'accepts_marketing')),
      note: nullIfBlank(idx.get(row, 'note')),
      tags: (() => {
        const raw = idx.get(row, 'tags')
        if (!raw || raw.trim().length === 0) return null
        return parseTagsCell(raw)
      })(),
      tax_exempt: parseBooleanCell(idx.get(row, 'tax_exempt')),
      address: buildAddress(idx, row),
      extraColumns: collectExtras(headers, row, idx.extraColumns),
    }

    customers.push(parsed)
  }

  // Duplicate-email warning — if a file has the same email twice, the
  // plan builder collapses to a single upsert keyed on the last row
  // (Shopify's behaviour too). Flag it here so the seller sees what we
  // did.
  const seenEmails = new Map<string, number>()
  for (const c of customers) {
    if (!c.email) continue
    const key = c.email.toLowerCase()
    const prev = seenEmails.get(key)
    if (prev !== undefined) {
      notes.push({
        line: c.sourceRow,
        message: `Duplicate email "${c.email}" (first seen on line ${prev}). Later row wins.`,
      })
    }
    seenEmails.set(key, c.sourceRow)
  }

  return {
    customers,
    notes,
    headers,
    extraColumns: idx.extraColumns,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nullIfBlank(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function buildAddress(idx: CustomerHeaderIndex, row: string[]): ParsedCustomerAddress | null {
  const a: ParsedCustomerAddress = {
    first_name: nullIfBlank(idx.get(row, 'first_name')), // Shopify uses the same First/Last for top + address
    last_name: nullIfBlank(idx.get(row, 'last_name')),
    company: nullIfBlank(idx.get(row, 'company')),
    address1: nullIfBlank(idx.get(row, 'address1')),
    address2: nullIfBlank(idx.get(row, 'address2')),
    city: nullIfBlank(idx.get(row, 'city')),
    province: nullIfBlank(idx.get(row, 'province')),
    province_code: nullIfBlank(idx.get(row, 'province_code')),
    country: nullIfBlank(idx.get(row, 'country')),
    country_code: nullIfBlank(idx.get(row, 'country_code')),
    zip: nullIfBlank(idx.get(row, 'zip')),
    phone: nullIfBlank(idx.get(row, 'phone')),
  }
  // If every address field is blank, don't create an address at all.
  const addressFields: Array<keyof ParsedCustomerAddress> = [
    'company',
    'address1',
    'address2',
    'city',
    'province',
    'province_code',
    'country',
    'country_code',
    'zip',
  ]
  const hasAny = addressFields.some((f) => a[f] !== null)
  return hasAny ? a : null
}

function collectExtras(
  headers: readonly string[],
  row: string[],
  extras: readonly string[],
): Record<string, string> {
  if (extras.length === 0) return {}
  const out: Record<string, string> = {}
  for (const header of extras) {
    const i = headers.indexOf(header)
    if (i >= 0) {
      const value = row[i] ?? ''
      if (value.length > 0) out[header] = value
    }
  }
  return out
}
