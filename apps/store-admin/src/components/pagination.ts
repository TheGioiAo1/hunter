/**
 * pagination.ts
 * Prev/Next + page number jumper — pure HTML string render.
 * Query params from `query` are preserved on every link.
 */

import { esc } from '../layouts/seller-layout.js'

export interface PaginationOptions {
  page: number
  totalPages: number
  /** Base URL without query string (e.g. "/store/abc/products") */
  baseUrl: string
  /** Extra query params to preserve (e.g. { q: 'shoes', status: 'active' }) */
  query?: Record<string, string>
}

function buildUrl(
  baseUrl: string,
  page: number,
  query: Record<string, string>,
): string {
  const params = new URLSearchParams({ ...query, page: String(page) })
  return `${baseUrl}?${params.toString()}`
}

/**
 * Returns an HTML string for a pagination bar.
 * Shows up to 7 page links with ellipsis for large page counts.
 */
export function pagination(opts: PaginationOptions): string {
  const { page, totalPages, baseUrl, query = {} } = opts

  if (totalPages <= 1) return ''

  // Build page window: always show first, last, current±2
  const pages: (number | 'ellipsis')[] = []
  const range = new Set<number>()
  range.add(1)
  range.add(totalPages)
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
    range.add(i)
  }
  const sorted = [...range].sort((a, b) => a - b)
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) pages.push('ellipsis')
    pages.push(sorted[i])
  }

  const prevDisabled = page <= 1
  const nextDisabled = page >= totalPages

  const prevLink = prevDisabled
    ? `<span class="gx-pagination__disabled" aria-disabled="true" aria-label="Previous page">&#8592;</span>`
    : `<a href="${esc(buildUrl(baseUrl, page - 1, query))}" aria-label="Previous page">&#8592;</a>`

  const nextLink = nextDisabled
    ? `<span class="gx-pagination__disabled" aria-disabled="true" aria-label="Next page">&#8594;</span>`
    : `<a href="${esc(buildUrl(baseUrl, page + 1, query))}" aria-label="Next page">&#8594;</a>`

  const pageLinks = pages
    .map((p, idx) => {
      if (p === 'ellipsis') {
        return `<span aria-hidden="true" key="${idx}">…</span>`
      }
      if (p === page) {
        return `<span class="gx-pagination__current" aria-current="page">${p}</span>`
      }
      return `<a href="${esc(buildUrl(baseUrl, p, query))}" aria-label="Page ${p}">${p}</a>`
    })
    .join('\n  ')

  return `<nav class="gx-pagination" aria-label="Pagination">
  ${prevLink}
  ${pageLinks}
  ${nextLink}
</nav>`
}
