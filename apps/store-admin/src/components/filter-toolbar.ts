/**
 * filter-toolbar.ts
 * GET form with search input + dropdown filters + clear-all link.
 * Pure HTML string render, no framework.
 */

import { esc } from '../layouts/seller-layout.js'

export interface FilterOption {
  /** caller phải esc */
  value: string
  /** caller phải esc */
  label: string
}

export interface FilterDef {
  /** HTML name attribute for the select — caller phải esc */
  name: string
  /** caller phải esc */
  label: string
  options: FilterOption[]
  /** Currently selected value — caller phải esc */
  current?: string
}

export interface FilterToolbarOptions {
  /** caller phải esc */
  searchPlaceholder: string
  /** caller phải esc */
  searchValue?: string
  filters: FilterDef[]
  /** Form action URL — caller phải esc */
  formAction: string
}

/**
 * Returns an HTML string for a filter toolbar.
 * All user-supplied strings are escaped internally.
 * @param opts.searchPlaceholder — caller phải esc
 * @param opts.searchValue — caller phải esc
 * @param opts.formAction — caller phải esc
 */
export function filterToolbar(opts: FilterToolbarOptions): string {
  const { searchPlaceholder, searchValue = '', filters, formAction } = opts

  const searchIcon = `<svg class="gx-filter-toolbar__search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`

  const selectsHtml = filters
    .map((f) => {
      const optionsHtml = f.options
        .map(
          (o) =>
            `<option value="${esc(o.value)}"${f.current === o.value ? ' selected' : ''}>${esc(o.label)}</option>`,
        )
        .join('')
      return `<select
      class="gx-filter-toolbar__select"
      name="${esc(f.name)}"
      aria-label="${esc(f.label)}"
    >
      <option value="">${esc(f.label)}</option>
      ${optionsHtml}
    </select>`
    })
    .join('\n    ')

  const hasActiveFilters =
    searchValue.trim() !== '' || filters.some((f) => f.current)

  const clearLink = hasActiveFilters
    ? `<a class="gx-filter-toolbar__clear" href="${esc(formAction)}" aria-label="Clear all filters">Clear all</a>`
    : ''

  return `<form
  class="gx-filter-toolbar"
  method="get"
  action="${esc(formAction)}"
  role="search"
>
  <div class="gx-filter-toolbar__search">
    ${searchIcon}
    <input
      class="gx-filter-toolbar__search-input"
      type="search"
      name="q"
      value="${esc(searchValue)}"
      placeholder="${esc(searchPlaceholder)}"
      aria-label="${esc(searchPlaceholder)}"
    >
  </div>
  ${selectsHtml}
  <button
    type="submit"
    class="gx-bulk-bar__btn"
    style="flex-shrink:0"
    aria-label="Apply filters"
  >Filter</button>
  ${clearLink}
</form>`
}
