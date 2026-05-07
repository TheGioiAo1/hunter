/**
 * Gbox Platform — Shared Cursor Pagination (Phase 2 Step 2.4)
 *
 * Shopify-style cursor pagination (NOT offset pagination):
 *   [←  Previous]  showing 1–50 of ~1,240  [Next  →]
 *
 * Why cursor, not offset?
 * -----------------------
 * Offset pagination (`?page=3&per_page=50`) has three fatal bugs for
 * a marketplace-scale product list:
 *   1. Skipping / double-reading. If a row is inserted at position 10
 *      while the user is on page 2, the user sees page 3 start with
 *      a row they already saw. Worse, a row can be skipped.
 *   2. Deep-page cost. `OFFSET 10000 LIMIT 50` makes Postgres scan
 *      10050 rows to discard 10000 of them. Cursor pagination uses
 *      `WHERE (created_at, id) < ($cursor, $id) LIMIT 50` which
 *      hits an index and is O(log n).
 *   3. Can't share deep links. If the underlying list changes, page
 *      5 today is page 6 tomorrow — URL-based reproducibility is dead.
 *
 * Cursor pagination fixes all three by encoding "where the last page
 * ended" into an opaque string (base64url of `{ts, id}`). Shopify,
 * GitHub, Twitter all use this. We match.
 *
 * This module ships:
 *   - `encodeCursor(row)` / `decodeCursor(str)` — serialize the
 *     (sort_key, id) pair for a stable tiebreaker.
 *   - `paginate(query, opts)` — a query-builder-agnostic helper that
 *     takes a list + current URL and returns `{ items, nextCursor,
 *     prevCursor, hasNext, hasPrev }`.
 *   - `paginationBarHtml(state)` — the bottom-of-list prev/next
 *     buttons with page-size dropdown + total count.
 *   - `paginationCss()` — styling that matches the rest of the admin.
 *
 * Triết lý: "clone giống hệt Shopify" (cursor-based prev/next, no
 * "page 1 2 3 ... 47" UI) + "power-ful hơn Shopify nhờ Claude"
 * (single shared helper that plugs into any route; the same `paginate`
 * fn works for products, orders, customers, audit logs, everything).
 */

export interface CursorPayload {
  /** Primary sort value — typically an ISO timestamp or numeric id. */
  k: string
  /** Tiebreaker row id. */
  i: string
}

export interface PaginatedList<T> {
  items: T[]
  /** Cursor for the next page (forward). Null if we're on the last page. */
  nextCursor: string | null
  /** Cursor for the previous page (backward). Null if we're on the first page. */
  prevCursor: string | null
  /** Convenience booleans derived from next/prev cursors. */
  hasNext: boolean
  hasPrev: boolean
  /**
   * Approximate total count if the caller provided one. Shown as
   * "1–50 of ~1,240" in the UI. Optional — Shopify themselves show
   * "showing 50" without a total on big datasets.
   */
  totalApprox?: number
  /** Current page size (for the dropdown). */
  pageSize: number
  /** Currently-used cursor that produced this page (for the "reload current page" URL). */
  currentCursor: string | null
  /**
   * True when we're paginating backward (prev button was clicked).
   * Affects which end of the result set the cursors are generated from.
   */
  isBackward: boolean
}

export interface PaginateOptions<T> {
  /** Parsed `?cursor=…` from the query string. Null for first page. */
  cursor?: string | null
  /** Parsed `?dir=…` — 'next' (default) or 'prev'. */
  direction?: 'next' | 'prev'
  /** Parsed `?per_page=…`. Default: 50. Clamped to [DEFAULT_PAGE_SIZES]. */
  pageSize?: number
  /**
   * Function that extracts a `{k, i}` cursor payload from a row.
   * Typically `(row) => ({ k: row.created_at.toISOString(), i: row.id })`.
   */
  getCursor: (row: T) => CursorPayload
  /**
   * The rows fetched from the DB. The caller is expected to fetch
   * `pageSize + 1` rows so we can detect `hasNext` by seeing if
   * the extra row is present.
   */
  fetched: T[]
  /** Optional approximate total count (e.g. from a cached estimate). */
  totalApprox?: number
}

/** Allowed page sizes (for the dropdown). */
export const DEFAULT_PAGE_SIZES = [25, 50, 100, 250] as const
export const DEFAULT_PAGE_SIZE = 50

/**
 * Encode a cursor payload to a URL-safe string. We use base64url
 * (not plain base64) so cursors can be embedded directly in URLs
 * without percent-encoding.
 */
export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload)
  // Base64-encode; then make it URL-safe per RFC 4648 §5.
  const b64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(json, 'utf8').toString('base64')
      : // Fallback for non-Node runtimes (Cloudflare Workers, Deno, browsers)
        btoa(unescape(encodeURIComponent(json)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode a URL-safe cursor string back into a payload. Returns null
 * if the cursor is malformed — callers should treat that as "start
 * from the beginning" rather than crashing.
 */
export function decodeCursor(encoded: string): CursorPayload | null {
  if (!encoded) return null
  try {
    // Restore standard base64 alphabet and re-pad.
    let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    const json =
      typeof Buffer !== 'undefined'
        ? Buffer.from(b64, 'base64').toString('utf8')
        : decodeURIComponent(escape(atob(b64)))
    const parsed = JSON.parse(json) as CursorPayload
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.k !== 'string' ||
      typeof parsed.i !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Clamp a requested page size to the allowed list, or fall back to
 * the default. This prevents a malicious user from passing
 * `?per_page=1000000` and DoSing the DB.
 */
export function clampPageSize(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE
  const allowed = DEFAULT_PAGE_SIZES as readonly number[]
  if (allowed.includes(requested)) return requested
  return DEFAULT_PAGE_SIZE
}

/**
 * Build a PaginatedList from a `fetched` result set. The caller must
 * fetch `pageSize + 1` rows; we detect `hasNext` by checking if the
 * extra row came back.
 *
 * Responsibility split:
 *   - The caller owns the DB query (Kysely, raw SQL, whatever). They
 *     decode the incoming cursor and build the WHERE clause.
 *   - This function owns the post-processing: slicing off the extra
 *     row, extracting the next/prev cursors, and flipping the order
 *     for backward pagination.
 *
 * For backward pagination, the caller should fetch in REVERSE order
 * (so "one row past the last visible row" is at position 0) and pass
 * direction='prev'. We un-reverse the slice before returning it.
 */
export function paginate<T>(opts: PaginateOptions<T>): PaginatedList<T> {
  const pageSize = clampPageSize(opts.pageSize)
  const direction = opts.direction ?? 'next'
  const isBackward = direction === 'prev'

  // Detect hasNext by seeing if the caller's extra row came back.
  const hasExtra = opts.fetched.length > pageSize
  let items = hasExtra ? opts.fetched.slice(0, pageSize) : opts.fetched.slice()

  // Backward pagination: the caller fetched in reverse, so un-reverse
  // before returning.
  if (isBackward) {
    items = items.reverse()
  }

  const incomingCursor = opts.cursor ?? null

  // Compute next/prev cursors from the visible items.
  let nextCursor: string | null = null
  let prevCursor: string | null = null

  if (items.length > 0) {
    const firstPayload = opts.getCursor(items[0])
    const lastPayload = opts.getCursor(items[items.length - 1])

    if (isBackward) {
      // Going backward: extra row means there's an even earlier page.
      if (hasExtra) prevCursor = encodeCursor(firstPayload)
      // Unless we ended up at the first page, we can always go forward.
      nextCursor = encodeCursor(lastPayload)
    } else {
      // Going forward (default).
      if (hasExtra) nextCursor = encodeCursor(lastPayload)
      // If we came from a cursor, we can go back.
      if (incomingCursor) prevCursor = encodeCursor(firstPayload)
    }
  }

  return {
    items,
    nextCursor,
    prevCursor,
    hasNext: nextCursor !== null,
    hasPrev: prevCursor !== null,
    totalApprox: opts.totalApprox,
    pageSize,
    currentCursor: incomingCursor,
    isBackward,
  }
}

export interface PaginationBarOptions {
  /** The paginated state (from `paginate()`). */
  state: Pick<
    PaginatedList<unknown>,
    'hasNext' | 'hasPrev' | 'nextCursor' | 'prevCursor' | 'pageSize' | 'totalApprox' | 'items'
  >
  /**
   * The base pathname of the current list page (e.g.
   * '/god-admin/users'). Query string is rebuilt with new cursor/dir.
   */
  basePath: string
  /**
   * Additional query params to preserve on navigation (filter state,
   * search query, sort column, etc.). Key/value map.
   */
  extraParams?: Record<string, string | number | undefined>
  /** Page-size dropdown change handler. Default: `location.href = ...`. */
  pageSizeOnChange?: string
  /**
   * Label for the "showing X items" counter. Default: generic.
   * Customize to "showing 50 products" for better context.
   */
  itemLabel?: string
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildUrl(
  base: string,
  params: Record<string, string | number | undefined>,
): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length > 0 ? `${base}?${parts.join('&')}` : base
}

/**
 * Render the prev/next pagination bar at the bottom of a list page.
 * Emits both buttons as `<a>` when enabled and `<span>` when disabled
 * so the tab order stays correct for keyboard users.
 */
export function paginationBarHtml(opts: PaginationBarOptions): string {
  const { state, basePath } = opts
  const extra = opts.extraParams ?? {}
  const itemLabel = opts.itemLabel ?? 'items'

  const prevUrl = state.hasPrev
    ? buildUrl(basePath, {
        ...extra,
        cursor: state.prevCursor!,
        dir: 'prev',
        per_page:
          state.pageSize !== DEFAULT_PAGE_SIZE ? state.pageSize : undefined,
      })
    : null

  const nextUrl = state.hasNext
    ? buildUrl(basePath, {
        ...extra,
        cursor: state.nextCursor!,
        dir: 'next',
        per_page:
          state.pageSize !== DEFAULT_PAGE_SIZE ? state.pageSize : undefined,
      })
    : null

  const prevBtn = prevUrl
    ? `<a href="${esc(prevUrl)}" class="gbox-pg-btn" rel="prev" aria-label="Previous page">&larr; Previous</a>`
    : `<span class="gbox-pg-btn gbox-pg-btn-disabled" aria-disabled="true">&larr; Previous</span>`

  const nextBtn = nextUrl
    ? `<a href="${esc(nextUrl)}" class="gbox-pg-btn" rel="next" aria-label="Next page">Next &rarr;</a>`
    : `<span class="gbox-pg-btn gbox-pg-btn-disabled" aria-disabled="true">Next &rarr;</span>`

  const shownCount = state.items.length
  const countText =
    typeof state.totalApprox === 'number'
      ? `showing ${shownCount} of ~${state.totalApprox.toLocaleString()} ${esc(itemLabel)}`
      : `showing ${shownCount} ${esc(itemLabel)}`

  const pageSizeChange =
    opts.pageSizeOnChange ??
    `var u=new URL(location.href);u.searchParams.set('per_page',this.value);u.searchParams.delete('cursor');u.searchParams.delete('dir');location.href=u.toString()`

  const sizeOptions = DEFAULT_PAGE_SIZES.map(
    (n) =>
      `<option value="${n}"${n === state.pageSize ? ' selected' : ''}>${n} / page</option>`,
  ).join('')

  return (
    `<nav class="gbox-pg" role="navigation" aria-label="Pagination">` +
    `<div class="gbox-pg-info">${countText}</div>` +
    `<div class="gbox-pg-controls">` +
    `<label class="gbox-pg-size">` +
    `<span class="gbox-pg-size-label">Rows:</span>` +
    `<select class="gbox-pg-size-select" onchange="${esc(pageSizeChange)}">${sizeOptions}</select>` +
    `</label>` +
    `<div class="gbox-pg-buttons">${prevBtn}${nextBtn}</div>` +
    `</div>` +
    `</nav>`
  )
}

export function paginationCss(): string {
  return `
    .gbox-pg {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      border-top: 1px solid var(--god-border, rgba(255,255,255,0.08));
      font-size: 13px;
      color: var(--god-text-secondary, #9ca3af);
      flex-wrap: wrap;
    }
    .gbox-pg-info {
      flex-shrink: 0;
    }
    .gbox-pg-controls {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .gbox-pg-size {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .gbox-pg-size-label {
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
    }
    .gbox-pg-size-select {
      padding: 4px 24px 4px 8px;
      border-radius: 6px;
      background: var(--god-surface, #1f2937);
      color: var(--god-text, #f3f4f6);
      border: 1px solid var(--god-border, rgba(255,255,255,0.08));
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .gbox-pg-size-select:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }
    .gbox-pg-buttons {
      display: inline-flex;
      gap: 6px;
    }
    .gbox-pg-btn {
      display: inline-flex;
      align-items: center;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 6px;
      text-decoration: none;
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      color: var(--god-text, #f3f4f6);
      background: var(--god-surface, #1f2937);
      transition: background 0.1s ease, border-color 0.1s ease;
    }
    .gbox-pg-btn:hover:not(.gbox-pg-btn-disabled) {
      background: var(--god-border-light, rgba(255,255,255,0.06));
      border-color: var(--god-accent, #3b82f6);
    }
    .gbox-pg-btn-disabled {
      opacity: 0.4;
      cursor: not-allowed;
      pointer-events: none;
    }
    .gbox-pg-btn:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }
  `
}
