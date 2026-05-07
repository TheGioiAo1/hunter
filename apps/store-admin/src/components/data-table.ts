/**
 * data-table.ts
 * Sortable data table with optional checkbox column — pure HTML string render.
 *
 * IMPORTANT: cells in rows are rendered as-is. Caller is responsible for
 * escaping all dynamic content before passing to this function.
 */

import { esc } from '../layouts/seller-layout.js'

export interface TableColumn {
  key: string
  /** caller phải esc */
  label: string
  sortable?: boolean
}

export interface TableRow {
  /** Unique row id — used for checkbox value */
  id: string
  /**
   * Pre-rendered HTML cell contents.
   * CALLER PHẢI ESC mọi nội dung động trước khi truyền vào.
   */
  cells: string[]
  selectable?: boolean
}

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

export interface DataTableOptions {
  columns: TableColumn[]
  rows: TableRow[]
  sort?: SortState
  /** Base URL for sort links (query params appended) */
  baseUrl: string
  /** Enable checkbox column for bulk selection */
  selectable?: boolean
  density?: 'compact' | 'normal'
}

function sortUrl(baseUrl: string, key: string, current?: SortState): string {
  const dir =
    current?.key === key && current.dir === 'asc' ? 'desc' : 'asc'
  const params = new URLSearchParams({ sort: key, dir })
  return `${baseUrl}?${params.toString()}`
}

function sortIcon(key: string, sort?: SortState): string {
  if (!sort || sort.key !== key) {
    return `<span class="gx-table__sort-icon" aria-hidden="true">↕</span>`
  }
  const icon = sort.dir === 'asc' ? '↑' : '↓'
  return `<span class="gx-table__sort-icon gx-table__sort-icon--active" aria-hidden="true">${icon}</span>`
}

/**
 * Returns an HTML string for a data table.
 *
 * Security note: `row.cells` values are injected verbatim — caller must
 * escape dynamic content before passing. This is documented in the type.
 */
export function dataTable(opts: DataTableOptions): string {
  const { columns, rows, sort, baseUrl, selectable = false, density = 'normal' } = opts

  const densityClass = density === 'compact' ? ' gx-table--compact' : ''

  // Header row
  const cbHeader = selectable
    ? `<th class="gx-table__cb" scope="col">
        <input
          type="checkbox"
          id="gx-select-all"
          aria-label="Select all rows"
        >
      </th>`
    : ''

  const headerCells = columns
    .map((col) => {
      if (!col.sortable) {
        return `<th scope="col">${esc(col.label)}</th>`
      }
      const href = esc(sortUrl(baseUrl, col.key, sort))
      const ariaSort =
        sort?.key === col.key
          ? sort.dir === 'asc'
            ? 'ascending'
            : 'descending'
          : 'none'
      return `<th scope="col" aria-sort="${ariaSort}">
        <a class="gx-table__sort-link" href="${href}" aria-label="Sort by ${esc(col.label)}">
          ${esc(col.label)}
          ${sortIcon(col.key, sort)}
        </a>
      </th>`
    })
    .join('\n      ')

  // Body rows
  const bodyRows = rows
    .map((row) => {
      const cbCell =
        selectable && row.selectable !== false
          ? `<td class="gx-table__cb">
          <input
            type="checkbox"
            class="gx-row-cb"
            name="ids[]"
            value="${esc(row.id)}"
            aria-label="Select row ${esc(row.id)}"
          >
        </td>`
          : selectable
            ? '<td class="gx-table__cb"></td>'
            : ''

      // cells are pre-escaped by caller — injected verbatim
      const dataCells = row.cells.map((c) => `<td>${c}</td>`).join('\n      ')

      return `<tr data-row-id="${esc(row.id)}">
      ${cbCell}
      ${dataCells}
    </tr>`
    })
    .join('\n    ')

  const emptyRow =
    rows.length === 0
      ? `<tr><td colspan="${columns.length + (selectable ? 1 : 0)}" style="text-align:center;padding:32px;color:var(--gx-muted)">No records found.</td></tr>`
      : ''

  return `<div class="gx-table-wrap" role="region" aria-label="Data table" tabindex="0">
  <table class="gx-table${densityClass}">
    <thead>
      <tr>
        ${cbHeader}
        ${headerCells}
      </tr>
    </thead>
    <tbody>
      ${bodyRows || emptyRow}
    </tbody>
  </table>
</div>`
}
