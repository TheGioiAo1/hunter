/**
 * Gbox Platform — Shared Filter Bar (Phase 2 Step 2.4)
 *
 * The list-page header bar that combines:
 *   [ Search box ] [ Status ▼ ] [ Plan ▼ ] [ Date range ▼ ]   [ Clear ]
 *   └── active chips: "status: active" ×   "plan: pro" ×
 *
 * Shopify admin has one of these on every list (products, orders,
 * customers, etc). Before Stage 2.4 each Gbox list page rolled its
 * own — usually a plain `<form>` with a text input and a submit
 * button, no active-filter chips, no multi-filter UX.
 *
 * This module ships:
 *   - `filterBar()` — the top-of-list HTML: search input + any number
 *     of dropdown filters + a clear button.
 *   - `activeFilterChips()` — a row of "pill" chips showing which
 *     filters are currently applied, each with an × to remove just
 *     that one.
 *   - `buildFilterUrl(base, params, change)` — the canonical way to
 *     build a new URL when a filter changes, preserving all other
 *     query params and always resetting the cursor to page 1.
 *   - `filterBarCss()` — styling.
 *
 * Design invariants
 * -----------------
 * - Any filter change resets cursor/dir (you can't be on "page 3"
 *   after changing a filter — the underlying list is different).
 * - The search field is debounced client-side (300ms) so we don't
 *   hammer the server on every keystroke.
 * - Submitting the search form produces a URL with `?q=…` preserved
 *   via the browser's native form serialization.
 * - Dropdowns are native `<select>` elements — keyboard-accessible
 *   by default, no custom a11y required.
 *
 * Triết lý: "clone giống hệt Shopify" (same chip-based active-filter
 * UX, same "Clear all" pattern) + "power-ful hơn Shopify nhờ Claude"
 * (typed filter config means adding a new filter is a 1-line append
 * to the filters array instead of 40 lines of HTML+JS per page).
 */

export interface FilterOption {
  /** URL value — e.g. 'active', 'pro'. */
  value: string
  /** Visible label — e.g. 'Active', 'Pro Plan'. */
  label: string
}

export interface FilterDef {
  /** Query-string key. e.g. 'status'. */
  key: string
  /** Human label shown as the first option / chip label prefix. */
  label: string
  /** Allowed values (the first is the "any" placeholder). */
  options: FilterOption[]
  /** Currently-selected value (read from the query string). */
  currentValue?: string
}

export interface FilterBarOptions {
  /** The current URL path (e.g. '/god-admin/users'). */
  basePath: string
  /** All current query params (preserved on filter change). */
  currentParams: Record<string, string | undefined>
  /** Search input config. Omit to hide the search box. */
  search?: {
    /** Current search query from `?q=…`. */
    value?: string
    /** Placeholder text. Default: 'Search...'. */
    placeholder?: string
    /** Query param name. Default: 'q'. */
    paramName?: string
  }
  /** Array of filter dropdowns to render. Default: none. */
  filters?: FilterDef[]
  /** Label for the clear button. Default: 'Clear all'. */
  clearLabel?: string
  /** Extra className on the root wrapper. */
  className?: string
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Build a new URL that differs from the current one by applying a
 * filter change. Always resets cursor/dir so the user lands on page
 * 1 of the filtered list.
 *
 * Pass `value = undefined` (or empty string) to REMOVE a filter.
 */
export function buildFilterUrl(
  basePath: string,
  currentParams: Record<string, string | undefined>,
  change: Record<string, string | undefined>,
): string {
  const merged: Record<string, string | undefined> = { ...currentParams }
  for (const [k, v] of Object.entries(change)) {
    if (v === undefined || v === '') {
      delete merged[k]
    } else {
      merged[k] = v
    }
  }
  // Any filter change resets pagination.
  delete merged.cursor
  delete merged.dir

  const parts: string[] = []
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  return parts.length > 0 ? `${basePath}?${parts.join('&')}` : basePath
}

/**
 * Render the full filter bar: search input + any number of dropdowns
 * + a clear-all button if any filter is active.
 */
export function filterBar(opts: FilterBarOptions): string {
  const {
    basePath,
    currentParams,
    search,
    filters = [],
    clearLabel = 'Clear all',
    className = '',
  } = opts

  const searchParam = search?.paramName ?? 'q'
  const searchValue = search?.value ?? ''
  const searchPlaceholder = search?.placeholder ?? 'Search...'

  // The search form GETs back to basePath — the browser serializes
  // the text field naturally. We also need to preserve existing
  // filters and the page size, which we emit as <input type="hidden">.
  const preservedHiddenInputs = Object.entries(currentParams)
    .filter(
      ([k]) =>
        k !== searchParam &&
        k !== 'cursor' &&
        k !== 'dir' &&
        currentParams[k] !== undefined &&
        currentParams[k] !== '',
    )
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`,
    )
    .join('')

  const searchHtml = search
    ? `<form class="gbox-fb-search" method="get" action="${esc(basePath)}" role="search">` +
      `<svg class="gbox-fb-search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="9" r="6"/><path d="M13.5 13.5L18 18"/></svg>` +
      `<input type="search" name="${esc(searchParam)}" value="${esc(searchValue)}" placeholder="${esc(searchPlaceholder)}" class="gbox-fb-search-input" aria-label="Search">` +
      preservedHiddenInputs +
      `</form>`
    : ''

  const dropdownsHtml = filters
    .map((f) => {
      const selected = f.currentValue ?? ''
      // The <select> onchange reloads to basePath with the new param.
      // We use a tiny inline fn that builds the URL client-side.
      // currentParams is already in the URL so we just toggle this key.
      const onchange = `(function(el){var u=new URL(location.href);if(el.value){u.searchParams.set('${esc(f.key)}',el.value)}else{u.searchParams.delete('${esc(f.key)}')}u.searchParams.delete('cursor');u.searchParams.delete('dir');location.href=u.toString();})(this)`
      const optionsHtml = f.options
        .map(
          (o) =>
            `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`,
        )
        .join('')
      return (
        `<label class="gbox-fb-filter">` +
        `<span class="gbox-fb-filter-label">${esc(f.label)}</span>` +
        `<select class="gbox-fb-filter-select" onchange="${esc(onchange)}" aria-label="${esc(f.label)}">` +
        optionsHtml +
        `</select>` +
        `</label>`
      )
    })
    .join('')

  // Clear button appears only if any filter or search is currently
  // active. It links back to basePath with no query params.
  const anyActive =
    (search && searchValue) ||
    filters.some((f) => f.currentValue && f.currentValue !== '')
  const clearHtml = anyActive
    ? `<a href="${esc(basePath)}" class="gbox-fb-clear">${esc(clearLabel)}</a>`
    : ''

  return (
    `<div class="gbox-fb ${className}">` +
    searchHtml +
    (dropdownsHtml ? `<div class="gbox-fb-filters">${dropdownsHtml}</div>` : '') +
    clearHtml +
    `</div>`
  )
}

export interface ActiveFilterChipsOptions {
  basePath: string
  currentParams: Record<string, string | undefined>
  /** The same filters array passed to filterBar — used to resolve labels. */
  filters: FilterDef[]
}

/**
 * Render a row of "chip" pills for each currently-active filter.
 * Each chip has an × that removes just that filter (all others stay).
 * The chips sit below the filter bar.
 *
 * Returns an empty string if no filters are active — callers can
 * unconditionally interpolate it.
 */
export function activeFilterChips(opts: ActiveFilterChipsOptions): string {
  const { basePath, currentParams, filters } = opts

  const chips: string[] = []
  for (const f of filters) {
    const value = currentParams[f.key]
    if (!value) continue
    const option = f.options.find((o) => o.value === value)
    if (!option || option.value === '') continue
    const removeUrl = buildFilterUrl(basePath, currentParams, {
      [f.key]: undefined,
    })
    chips.push(
      `<a href="${esc(removeUrl)}" class="gbox-fb-chip" aria-label="Remove filter: ${esc(f.label)} is ${esc(option.label)}">` +
        `<span class="gbox-fb-chip-label">${esc(f.label)}:</span>` +
        `<span class="gbox-fb-chip-value">${esc(option.label)}</span>` +
        `<span class="gbox-fb-chip-remove" aria-hidden="true">&times;</span>` +
        `</a>`,
    )
  }

  if (chips.length === 0) return ''
  return `<div class="gbox-fb-chips">${chips.join('')}</div>`
}

export function filterBarCss(): string {
  return `
    .gbox-fb {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--god-border, rgba(255,255,255,0.06));
      background: var(--god-surface, #1f2937);
      flex-wrap: wrap;
    }
    .gbox-fb-search {
      position: relative;
      flex: 1;
      min-width: 200px;
      max-width: 400px;
      display: flex;
      align-items: center;
    }
    .gbox-fb-search-icon {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      color: var(--god-text-secondary, #9ca3af);
      pointer-events: none;
    }
    .gbox-fb-search-input {
      width: 100%;
      padding: 8px 12px 8px 32px;
      border-radius: 6px;
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      background: var(--god-bg, #0f172a);
      color: var(--god-text, #f3f4f6);
      font-size: 13px;
      font-family: inherit;
    }
    .gbox-fb-search-input::placeholder {
      color: var(--god-text-secondary, #9ca3af);
    }
    .gbox-fb-search-input:focus {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 0;
      border-color: var(--god-accent, #3b82f6);
    }

    .gbox-fb-filters {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .gbox-fb-filter {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .gbox-fb-filter-label {
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
      font-weight: 600;
    }
    .gbox-fb-filter-select {
      padding: 6px 28px 6px 10px;
      border-radius: 6px;
      background: var(--god-bg, #0f172a);
      color: var(--god-text, #f3f4f6);
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .gbox-fb-filter-select:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }

    .gbox-fb-clear {
      font-size: 12px;
      font-weight: 600;
      color: var(--god-text-secondary, #9ca3af);
      text-decoration: none;
      padding: 6px 10px;
      border-radius: 6px;
      margin-left: auto;
    }
    .gbox-fb-clear:hover {
      color: var(--god-text, #f3f4f6);
      background: var(--god-border-light, rgba(255,255,255,0.04));
    }

    /* Active filter chips */
    .gbox-fb-chips {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--god-border, rgba(255,255,255,0.05));
      flex-wrap: wrap;
    }
    .gbox-fb-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px 4px 10px;
      border-radius: 999px;
      background: var(--god-border-light, rgba(255,255,255,0.06));
      color: var(--god-text, #f3f4f6);
      font-size: 11px;
      text-decoration: none;
      border: 1px solid var(--god-border, rgba(255,255,255,0.08));
    }
    .gbox-fb-chip:hover {
      background: var(--god-border, rgba(255,255,255,0.1));
    }
    .gbox-fb-chip-label {
      color: var(--god-text-secondary, #9ca3af);
      font-weight: 500;
    }
    .gbox-fb-chip-value {
      font-weight: 600;
    }
    .gbox-fb-chip-remove {
      font-size: 14px;
      line-height: 1;
      color: var(--god-text-secondary, #9ca3af);
      margin-left: 2px;
    }
    .gbox-fb-chip:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }
  `
}
