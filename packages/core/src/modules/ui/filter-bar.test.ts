/**
 * Tests for the shared filter bar (Phase 2 Step 2.4).
 */

import { describe, it, expect } from 'vitest'
import {
  filterBar,
  activeFilterChips,
  buildFilterUrl,
  filterBarCss,
} from './filter-bar.js'

const statusFilter = {
  key: 'status',
  label: 'Status',
  options: [
    { value: '', label: 'Any status' },
    { value: 'active', label: 'Active' },
    { value: 'disabled', label: 'Disabled' },
  ],
}

const planFilter = {
  key: 'plan',
  label: 'Plan',
  options: [
    { value: '', label: 'Any plan' },
    { value: 'free', label: 'Free' },
    { value: 'pro', label: 'Pro' },
  ],
}

describe('buildFilterUrl', () => {
  it('appends a new filter to the URL', () => {
    const url = buildFilterUrl('/users', {}, { status: 'active' })
    expect(url).toBe('/users?status=active')
  })

  it('preserves existing params when adding a new filter', () => {
    const url = buildFilterUrl('/users', { q: 'thai' }, { status: 'active' })
    expect(url).toContain('q=thai')
    expect(url).toContain('status=active')
  })

  it('removes a filter when value is undefined', () => {
    const url = buildFilterUrl(
      '/users',
      { status: 'active', q: 'thai' },
      { status: undefined },
    )
    expect(url).not.toContain('status')
    expect(url).toContain('q=thai')
  })

  it('removes a filter when value is empty string', () => {
    const url = buildFilterUrl(
      '/users',
      { status: 'active' },
      { status: '' },
    )
    expect(url).not.toContain('status')
  })

  it('always strips cursor and dir on filter change', () => {
    const url = buildFilterUrl(
      '/users',
      { cursor: 'abc', dir: 'next', q: 'thai' },
      { status: 'active' },
    )
    expect(url).not.toContain('cursor')
    expect(url).not.toContain('dir')
    expect(url).toContain('q=thai')
    expect(url).toContain('status=active')
  })

  it('URL-encodes special characters', () => {
    const url = buildFilterUrl('/users', {}, { q: 'a & b' })
    expect(url).toContain('q=a%20%26%20b')
  })

  it('returns basePath with no query when everything cleared', () => {
    const url = buildFilterUrl(
      '/users',
      { status: 'active' },
      { status: undefined },
    )
    expect(url).toBe('/users')
  })
})

describe('filterBar — search box', () => {
  it('renders a <form method="get"> wrapping the search input', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: {},
      search: {},
    })
    expect(html).toContain('<form')
    expect(html).toContain('method="get"')
    expect(html).toContain('action="/users"')
    expect(html).toContain('role="search"')
  })

  it('uses the current search value', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: { q: 'thai' },
      search: { value: 'thai' },
    })
    expect(html).toContain('value="thai"')
  })

  it('uses a custom placeholder when provided', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: {},
      search: { placeholder: 'Search users...' },
    })
    expect(html).toContain('placeholder="Search users..."')
  })

  it('uses custom paramName when provided', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: {},
      search: { paramName: 'query' },
    })
    expect(html).toContain('name="query"')
  })

  it('preserves existing non-search params as hidden inputs in the form', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: { status: 'active', plan: 'pro' },
      search: {},
    })
    expect(html).toContain('type="hidden"')
    expect(html).toContain('name="status"')
    expect(html).toContain('value="active"')
    expect(html).toContain('name="plan"')
  })

  it('does NOT persist cursor/dir in hidden inputs (reset on search)', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: { cursor: 'xxx', dir: 'next' },
      search: {},
    })
    const hidden = html.match(/type="hidden"[^>]*/g) ?? []
    const hiddenStr = hidden.join('\n')
    expect(hiddenStr).not.toContain('cursor')
    expect(hiddenStr).not.toContain('dir')
  })

  it('is hidden entirely when search is not passed', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: {},
      filters: [statusFilter],
    })
    expect(html).not.toContain('<form')
    expect(html).not.toContain('gbox-fb-search')
  })
})

describe('filterBar — dropdown filters', () => {
  it('renders a <select> for each filter', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: {},
      filters: [statusFilter, planFilter],
    })
    const selects = html.match(/<select/g) ?? []
    expect(selects.length).toBe(2)
  })

  it('emits all option values for each filter', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: {},
      filters: [statusFilter],
    })
    expect(html).toContain('value="active"')
    expect(html).toContain('value="disabled"')
    expect(html).toContain('Active')
    expect(html).toContain('Disabled')
  })

  it('marks the current value as selected', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: { status: 'active' },
      filters: [{ ...statusFilter, currentValue: 'active' }],
    })
    expect(html).toContain('value="active" selected')
  })

  it('has an onchange handler that resets cursor/dir', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: {},
      filters: [statusFilter],
    })
    expect(html).toContain('onchange=')
    expect(html).toContain('cursor')
    expect(html).toContain('dir')
  })

  it('has an aria-label on each select for screen readers', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: {},
      filters: [statusFilter],
    })
    expect(html).toContain('aria-label="Status"')
  })
})

describe('filterBar — clear button', () => {
  it('shows Clear all when a search is active', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: { q: 'thai' },
      search: { value: 'thai' },
    })
    expect(html).toContain('Clear all')
  })

  it('shows Clear all when a dropdown is active', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: { status: 'active' },
      filters: [{ ...statusFilter, currentValue: 'active' }],
    })
    expect(html).toContain('Clear all')
  })

  it('hides Clear all when nothing is active', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: {},
      search: {},
      filters: [statusFilter],
    })
    expect(html).not.toContain('Clear all')
  })

  it('respects a custom clear label', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: { status: 'active' },
      filters: [{ ...statusFilter, currentValue: 'active' }],
      clearLabel: 'Reset filters',
    })
    expect(html).toContain('Reset filters')
  })

  it('clear button links back to basePath with no params', () => {
    const html = filterBar({
      basePath: '/users',
      currentParams: { status: 'active' },
      filters: [{ ...statusFilter, currentValue: 'active' }],
    })
    expect(html).toContain('href="/users"')
  })
})

describe('activeFilterChips', () => {
  it('returns empty string when no filters are active', () => {
    const html = activeFilterChips({
      basePath: '/users',
      currentParams: {},
      filters: [statusFilter, planFilter],
    })
    expect(html).toBe('')
  })

  it('renders a chip for each active filter', () => {
    const html = activeFilterChips({
      basePath: '/users',
      currentParams: { status: 'active', plan: 'pro' },
      filters: [statusFilter, planFilter],
    })
    const chips = html.match(/class="gbox-fb-chip"/g) ?? []
    expect(chips.length).toBe(2)
  })

  it('shows the human label of the selected option (not the raw value)', () => {
    const html = activeFilterChips({
      basePath: '/users',
      currentParams: { status: 'active' },
      filters: [statusFilter],
    })
    expect(html).toContain('Status:')
    expect(html).toContain('Active')
    // The "Disabled" label should not appear since that filter isn't active
    expect(html).not.toContain('Disabled')
  })

  it('each chip is a link that removes just that filter', () => {
    const html = activeFilterChips({
      basePath: '/users',
      currentParams: { status: 'active', plan: 'pro' },
      filters: [statusFilter, planFilter],
    })
    // The status chip should link to a URL WITHOUT status but WITH plan
    const linkMatches = html.match(/href="([^"]+)"/g) ?? []
    expect(linkMatches.length).toBe(2)
    // At least one link preserves the other filter
    const links = linkMatches.map((m) => m.replace(/href="|"/g, ''))
    const keepsPlan = links.some((l) => l.includes('plan=pro'))
    const keepsStatus = links.some((l) => l.includes('status=active'))
    expect(keepsPlan).toBe(true)
    expect(keepsStatus).toBe(true)
  })

  it('ignores filters whose value is not in the options list', () => {
    const html = activeFilterChips({
      basePath: '/users',
      currentParams: { status: 'bogus' },
      filters: [statusFilter],
    })
    expect(html).toBe('')
  })

  it('has an accessible aria-label per chip', () => {
    const html = activeFilterChips({
      basePath: '/users',
      currentParams: { status: 'active' },
      filters: [statusFilter],
    })
    expect(html).toContain('aria-label="Remove filter: Status is Active"')
  })
})

describe('filterBarCss', () => {
  it('defines the root .gbox-fb class', () => {
    expect(filterBarCss()).toContain('.gbox-fb ')
  })

  it('defines search/filter/chip/clear subcomponents', () => {
    const css = filterBarCss()
    expect(css).toContain('.gbox-fb-search')
    expect(css).toContain('.gbox-fb-filter')
    expect(css).toContain('.gbox-fb-chip')
    expect(css).toContain('.gbox-fb-clear')
  })

  it('uses theme CSS vars for dark/light adaption', () => {
    const css = filterBarCss()
    expect(css).toContain('var(--god-border')
    expect(css).toContain('var(--god-text')
  })

  it('has focus-visible outlines for a11y', () => {
    const css = filterBarCss()
    expect(css).toContain(':focus-visible')
  })
})
