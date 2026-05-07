/**
 * Audit Log Export — Phase 0 §8 Item #6
 *
 * Builds a CSV (or JSON) stream of audit_logs rows for download from
 * the god-admin security page (all shops) or the store-admin audit
 * view (single shop, deferred to Phase 2 Admin Polish).
 *
 * The exporter deliberately keeps its query surface tiny — the only
 * filters are the ones that are already exposed on the god-admin
 * security page (action pattern, user email, date window, shop_id).
 * Anything fancier (joins against users/shops for humanised output)
 * happens in this module, not in the caller, so the god-admin page
 * and a future store-admin page share one implementation.
 *
 * # Safety
 *
 * - `limit` is hard-capped at 10_000 rows. Larger exports should go
 *   through a background job (Phase 2+). 10k rows is ~1.5 MB of CSV
 *   which every modern browser can handle as a direct download.
 * - The `details` JSONB column is serialised back to a compact JSON
 *   string and CSV-escaped. We deliberately DO NOT flatten it — the
 *   shape varies across call sites (auth vs store-action vs error)
 *   and flattening would lose information.
 * - All user-supplied filters are bound via Kysely parameter
 *   placeholders. No string concatenation into SQL.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export interface ExportFilters {
  /** ilike match on `audit_logs.action`. */
  action?: string
  /** ilike match on `users.email`. */
  userEmail?: string
  /** Exact match on `audit_logs.shop_id`. */
  shopId?: string
  /** Lower bound on `created_at` (inclusive). ISO string. */
  fromIso?: string
  /** Upper bound on `created_at` (exclusive). ISO string. */
  toIso?: string
  /** Max rows to return. Default 10000, capped at 10000. */
  limit?: number
}

export interface ExportRow {
  id: string
  created_at: string
  action: string
  resource_type: string | null
  resource_id: string | null
  user_email: string | null
  shop_slug: string | null
  ip_address: string | null
  details: string | null
}

const MAX_ROWS = 10_000
const DEFAULT_ROWS = 10_000

/**
 * Fetch the rows that should appear in an export. Joins users + shops
 * for human-readable output so a non-technical admin can open the CSV
 * in Excel without cross-referencing UUIDs.
 */
export async function fetchAuditLogsForExport(
  db: Kysely<Database>,
  filters: ExportFilters = {},
): Promise<ExportRow[]> {
  const limit = Math.min(
    Math.max(1, filters.limit ?? DEFAULT_ROWS),
    MAX_ROWS,
  )

  let q = db
    .selectFrom('audit_logs as a')
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .leftJoin('shops as s', 's.id', 'a.shop_id')
    .select([
      'a.id',
      'a.created_at',
      'a.action',
      'a.resource_type',
      'a.resource_id',
      'a.ip_address',
      'a.details',
      'u.email as user_email',
      's.slug as shop_slug',
    ])
    .orderBy('a.created_at', 'desc')
    .limit(limit)

  if (filters.action) {
    q = q.where('a.action', 'ilike', `%${filters.action}%`)
  }
  if (filters.userEmail) {
    q = q.where('u.email', 'ilike', `%${filters.userEmail}%`)
  }
  if (filters.shopId) {
    q = q.where('a.shop_id', '=', filters.shopId)
  }
  if (filters.fromIso) {
    q = q.where('a.created_at', '>=', filters.fromIso)
  }
  if (filters.toIso) {
    q = q.where('a.created_at', '<', filters.toIso)
  }

  const rows = await q.execute()

  return rows.map((r) => ({
    id: String(r.id),
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
    action: r.action ?? '',
    resource_type: r.resource_type ?? null,
    resource_id: r.resource_id ? String(r.resource_id) : null,
    user_email: r.user_email ?? null,
    shop_slug: r.shop_slug ?? null,
    ip_address: r.ip_address ?? null,
    details: serialiseDetails(r.details),
  }))
}

function serialiseDetails(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    // Some driver versions hand jsonb back as a string already. Keep
    // as-is so the CSV escapes once, not twice.
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserialisable]'
  }
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------

const CSV_HEADERS: Array<keyof ExportRow> = [
  'created_at',
  'action',
  'user_email',
  'shop_slug',
  'resource_type',
  'resource_id',
  'ip_address',
  'details',
  'id',
]

const CSV_HEADER_LABELS: Record<keyof ExportRow, string> = {
  created_at: 'Timestamp',
  action: 'Action',
  user_email: 'User',
  shop_slug: 'Shop',
  resource_type: 'Resource Type',
  resource_id: 'Resource ID',
  ip_address: 'IP Address',
  details: 'Details',
  id: 'Audit ID',
}

/**
 * Serialise rows to a CSV string. Escapes per RFC 4180:
 *   - wraps cells in " when the value contains , " \n or \r
 *   - doubles any " inside the cell
 */
export function rowsToCsv(rows: ExportRow[]): string {
  const header = CSV_HEADERS.map((k) => csvCell(CSV_HEADER_LABELS[k])).join(',')
  const body = rows
    .map((row) =>
      CSV_HEADERS.map((k) => csvCell(row[k])).join(','),
    )
    .join('\n')
  return body.length > 0 ? `${header}\n${body}\n` : `${header}\n`
}

function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Build the Content-Disposition filename for an export. Embeds the
 * filter fingerprint + an ISO-ish date so a user running 2 exports
 * back-to-back doesn't overwrite the first download.
 */
export function buildExportFilename(prefix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)
  return `gbox-${prefix}-audit-${stamp}.csv`
}
