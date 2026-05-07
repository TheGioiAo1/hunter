/**
 * Customer CSV Exporter (Shopify-compatible).
 *
 * Produces a Shopify-shape CSV from an in-memory customer + addresses
 * list. Mirror-image of `csv-parser.ts`: same canonical header order,
 * same boolean encoding ("yes"/"no"), same tags join. A file exported
 * here can be re-imported by `parseCustomersCsv` and the plan builder
 * will see an all-update plan (values round-trip).
 *
 * One row per customer — the default address (or first address if no
 * default flag) is inlined. Customers with multiple addresses emit
 * only the default; secondary addresses are a separate export (not
 * part of Phase 4 PR4 scope).
 *
 * Pure module — no DB. The store-admin handler is responsible for
 * loading `ExportCustomer[]` from Postgres and calling
 * `exportCustomersCsv`.
 */

import { csvField } from '../../products/export/csv-exporter.js'
import {
  CUSTOMER_CSV_COLUMNS,
  CUSTOMER_CSV_HEADERS,
  encodeBooleanCell,
  encodeTagsCell,
  type CustomerCsvField,
} from './columns.js'

// ---------------------------------------------------------------------------
// Types — what the caller must hand us. Kept as a literal shape so
// service.ts (or a live SQL query) can construct it directly.
// ---------------------------------------------------------------------------

export interface ExportCustomer {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  accepts_marketing: boolean
  note: string | null
  tags: string[] | null
  tax_exempt: boolean
  total_spent: string | null          // decimal string e.g. "42.50"
  orders_count: number | null
  lifecycle_stage: string | null      // 'new' | 'returning' | 'at_risk' | 'churned'
  /** Default address picked by the caller (or null if the customer has none). */
  default_address: ExportCustomerAddress | null
}

export interface ExportCustomerAddress {
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

// ---------------------------------------------------------------------------
// Row builder (pure, testable without stringifying)
// ---------------------------------------------------------------------------

/**
 * Render one customer as an array of strings, ordered to match
 * `CUSTOMER_CSV_HEADERS`. Null/undefined become empty strings —
 * Shopify parity ("").
 */
export function customerToRow(c: ExportCustomer): string[] {
  const addr = c.default_address
  const cells: Record<CustomerCsvField, string> = {
    first_name: c.first_name ?? '',
    last_name: c.last_name ?? '',
    email: c.email ?? '',
    company: addr?.company ?? '',
    address1: addr?.address1 ?? '',
    address2: addr?.address2 ?? '',
    city: addr?.city ?? '',
    province: addr?.province ?? '',
    province_code: addr?.province_code ?? '',
    country: addr?.country ?? '',
    country_code: addr?.country_code ?? '',
    zip: addr?.zip ?? '',
    // Prefer customer-level phone; fall back to default address phone
    // so the exported row isn't blank for legacy customers that only
    // stored a phone on the address.
    phone: c.phone ?? addr?.phone ?? '',
    accepts_marketing: encodeBooleanCell(c.accepts_marketing),
    total_spent: c.total_spent ?? '0.00',
    total_orders: String(c.orders_count ?? 0),
    note: c.note ?? '',
    tags: encodeTagsCell(c.tags),
    tax_exempt: encodeBooleanCell(c.tax_exempt),
    lifecycle_stage: c.lifecycle_stage ?? '',
  }

  return CUSTOMER_CSV_COLUMNS.map((col) => cells[col.field])
}

// ---------------------------------------------------------------------------
// CSV emitter
// ---------------------------------------------------------------------------

/** Escape + join one row into a single CSV line (no trailing newline). */
function encodeRow(cells: string[]): string {
  return cells.map((c) => csvField(c)).join(',')
}

/**
 * Build the full CSV string. The first line is always the canonical
 * header row. Rows are separated by `\n` (Shopify's own export uses
 * `\r\n` — we normalise to `\n` and let callers upgrade if needed).
 */
export function exportCustomersCsv(customers: readonly ExportCustomer[]): string {
  const lines: string[] = [encodeRow([...CUSTOMER_CSV_HEADERS])]
  for (const c of customers) {
    lines.push(encodeRow(customerToRow(c)))
  }
  return lines.join('\n') + '\n'
}

/**
 * Async-generator variant — yields line-by-line so the handler can
 * stream to the response without buffering the full file. Each yield
 * already includes its trailing `\n`. First yield is the header row.
 *
 * Usage:
 *   for await (const chunk of exportCustomersCsvStream(rows)) {
 *     res.write(chunk)
 *   }
 */
export async function* exportCustomersCsvStream(
  customers: AsyncIterable<ExportCustomer> | Iterable<ExportCustomer>,
): AsyncGenerator<string, void, undefined> {
  yield encodeRow([...CUSTOMER_CSV_HEADERS]) + '\n'
  for await (const c of customers) {
    yield encodeRow(customerToRow(c)) + '\n'
  }
}
