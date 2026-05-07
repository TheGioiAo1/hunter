/**
 * Gbox Platform — Customer quick-filters service (Phase 4 / PR5).
 *
 * CRUD for the shared pill-row that shows above the customer list
 * page. Each row of `customer_quick_filters` is a named saved view,
 * shop-scoped — EVERY staff member of the shop sees the same pills.
 * Contrast `order_saved_filters` which is per-user-per-shop (fraud
 * watch filters don't belong on a teammate's dashboard). Customer
 * segmentation is a team concept, so we share.
 *
 * The `query` shape is intentionally small:
 *
 *   { q?: string          // free-text search over name + email
 *     lifecycle?: string  // one of {new,returning,at_risk,churned}
 *     marketing?: string  // "yes" | "no"
 *     tag?: string        // single tag match (array contains)
 *     status?: string }   // "active" | "disabled"
 *
 * This is a SUPERSET of what PR2 segments expose: segments do rule
 * trees, quick filters are flat field/value pairs that round-trip
 * through the URL. A power user who needs AND/OR goes to Segments.
 *
 * Authorization: caller passes `shopId` — every query we issue pins
 * on it. Cross-shop id reads fail-closed by returning `null`.
 */

import { CustomerApi } from '@gbox/api-client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The persisted filter payload. Every field is optional; an empty
 * object is a legal ("all customers") view. We don't store unknown
 * keys — only the whitelist — so a future schema change can't leak
 * stale params into the UI.
 */
export interface QuickFilterQuery {
  q?: string
  lifecycle?: 'new' | 'returning' | 'at_risk' | 'churned'
  marketing?: 'yes' | 'no'
  tag?: string
  status?: 'active' | 'disabled'
}

export interface QuickFilter {
  id: string
  shop_id: string
  name: string
  filter_json: QuickFilterQuery
  position: number
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

export interface CreateQuickFilterInput {
  name: string
  query: QuickFilterQuery
  createdByUserId?: string | null
}

// ---------------------------------------------------------------------------
// Utility — sanitize an arbitrary query object into our known shape.
// ---------------------------------------------------------------------------

/**
 * Strip unknown keys + coerce values to the enum set. Anything not in
 * the whitelist is dropped. Called on both write (so we don't persist
 * junk) and read (so a hand-edited row with stale fields doesn't
 * hydrate into the list page).
 */
export function normalizeQuickFilterQuery(input: unknown): QuickFilterQuery {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Record<string, unknown>
  const out: QuickFilterQuery = {}

  if (typeof raw.q === 'string' && raw.q.trim()) {
    out.q = raw.q.trim()
  }
  if (raw.lifecycle === 'new' || raw.lifecycle === 'returning' ||
      raw.lifecycle === 'at_risk' || raw.lifecycle === 'churned') {
    out.lifecycle = raw.lifecycle
  }
  if (raw.marketing === 'yes' || raw.marketing === 'no') {
    out.marketing = raw.marketing
  }
  if (typeof raw.tag === 'string' && raw.tag.trim()) {
    out.tag = raw.tag.trim()
  }
  if (raw.status === 'active' || raw.status === 'disabled') {
    out.status = raw.status
  }
  return out
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List all pills for this shop, ordered by position then created_at.
 * Position ties resolve via created_at so new pills (still position 0)
 * append chronologically rather than randomly interleaving.
 */
export async function listQuickFilters(
  _db: any,
  shopId: string,
): Promise<QuickFilter[]> {
  // TODO: Map to API [CustomerApi.QuickFilterService.list]
  return []
}

/**
 * Fetch one pill by id, pinned to `shopId`. A cross-shop id returns
 * `null` — never a 404-style exception, so the handler can fall back
 * to the unfiltered list.
 */
export async function getQuickFilter(
  _db: any,
  shopId: string,
  filterId: string,
): Promise<QuickFilter | null> {
  // TODO: Map to API [CustomerApi.QuickFilterService.get]
  return null
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a new pill OR update the one with the same `name` in the
 * shop (ON CONFLICT via unique idx_customer_quick_filters_shop_name).
 *
 * Returns the persisted row. New rows get `position = max(existing)+1`
 * so they append to the end of the pill row.
 *
 * Validation:
 *   - `name` is trimmed; empty string throws. Max length clamped to
 *     80 to match the varchar(80) column.
 *   - `query` is normalized — unknown keys dropped.
 */
export async function saveQuickFilter(
  _db: any,
  shopId: string,
  input: CreateQuickFilterInput,
): Promise<QuickFilter> {
  const name = (input.name ?? '').trim().slice(0, 80)
  if (!name) throw new Error('quick-filter name is required')

  // TODO: Map to API [CustomerApi.QuickFilterService.save]
  throw new Error('Method not implemented.')
}

/**
 * Rename or re-query an existing pill. Cross-shop attempts fail-closed
 * (return `null`). Empty name throws.
 */
export async function updateQuickFilter(
  _db: any,
  shopId: string,
  filterId: string,
  changes: Partial<Pick<CreateQuickFilterInput, 'name' | 'query'>>,
): Promise<QuickFilter | null> {
  // TODO: Map to API [CustomerApi.QuickFilterService.update]
  return null
}

/**
 * Delete one pill. Returns `true` if a row was removed, `false` if
 * the id was cross-shop or already gone — the caller can treat both
 * the same (no error toast).
 */
export async function deleteQuickFilter(
  _db: any,
  shopId: string,
  filterId: string,
): Promise<boolean> {
  // TODO: Map to API [CustomerApi.QuickFilterService.delete]
  return false
}

/**
 * Re-order pills. Takes an array of ids in the desired order and
 * renumbers `position` 0..N-1. Ids not in the shop are silently
 * dropped so a stale client request can't corrupt positions.
 */
export async function reorderQuickFilters(
  _db: any,
  shopId: string,
  orderedIds: string[],
): Promise<void> {
  // TODO: Map to API [CustomerApi.QuickFilterService.reorder]
}

// ---------------------------------------------------------------------------
// Query-param round-trip helpers for the list page
// ---------------------------------------------------------------------------

/**
 * Build a URL query string from a `QuickFilterQuery`. Skips empty
 * fields so the URL stays clean (e.g. just `?q=ada` instead of
 * `?q=ada&lifecycle=&marketing=`).
 */
export function queryToParams(q: QuickFilterQuery): string {
  const parts: string[] = []
  if (q.q) parts.push(`q=${encodeURIComponent(q.q)}`)
  if (q.lifecycle) parts.push(`lifecycle=${q.lifecycle}`)
  if (q.marketing) parts.push(`marketing=${q.marketing}`)
  if (q.tag) parts.push(`tag=${encodeURIComponent(q.tag)}`)
  if (q.status) parts.push(`status=${q.status}`)
  return parts.join('&')
}

/** Parse `req.query` → `QuickFilterQuery` using the same whitelist. */
export function paramsToQuery(params: Record<string, unknown>): QuickFilterQuery {
  return normalizeQuickFilterQuery(params)
}

