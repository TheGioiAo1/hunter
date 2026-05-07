/**
 * Tests for the shared empty state (Phase 2 Step 2.2).
 *
 * We pin the invariants that matter for consistency across list
 * pages: variant defaults, XSS-safe escaping, action rendering as
 * <a> vs <button>, and the CSS hook class names.
 */

import { describe, it, expect } from 'vitest'
import {
  emptyState,
  emptyStateCss,
  type EmptyStateAction,
} from './empty-state.js'

describe('emptyState — defaults', () => {
  it('defaults to the no-data variant', () => {
    const html = emptyState()
    expect(html).toContain('gbox-empty-no-data')
    expect(html).toContain('Nothing here yet')
  })

  it('wraps everything in a role="status" container', () => {
    const html = emptyState()
    expect(html).toContain('role="status"')
  })

  it('renders the variant-specific icon by default', () => {
    const noData = emptyState({ variant: 'no-data' })
    const noResults = emptyState({ variant: 'no-results' })
    const error = emptyState({ variant: 'error' })
    // All three should contain an <svg>
    expect(noData).toContain('<svg')
    expect(noResults).toContain('<svg')
    expect(error).toContain('<svg')
    // And they should be distinct (different viewBoxes/paths)
    expect(noData).not.toBe(noResults)
    expect(noResults).not.toBe(error)
  })
})

describe('emptyState — variants', () => {
  it('no-results variant has its own title', () => {
    expect(emptyState({ variant: 'no-results' })).toContain(
      'No results found',
    )
  })

  it('no-access variant has its own title', () => {
    // Note: title contains an apostrophe which emptyState escapes to
    // `&#39;` before inlining — assert on the escaped form so the
    // test mirrors what actually ships in the HTML.
    const html = emptyState({ variant: 'no-access' })
    expect(html).toContain('have access')
    expect(html).toContain('&#39;t')
  })

  it('error variant has its own title', () => {
    expect(emptyState({ variant: 'error' })).toContain('Something went wrong')
  })

  it('each variant adds a matching class hook for CSS', () => {
    expect(emptyState({ variant: 'no-data' })).toContain('gbox-empty-no-data')
    expect(emptyState({ variant: 'no-results' })).toContain(
      'gbox-empty-no-results',
    )
    expect(emptyState({ variant: 'no-access' })).toContain(
      'gbox-empty-no-access',
    )
    expect(emptyState({ variant: 'error' })).toContain('gbox-empty-error')
  })
})

describe('emptyState — title and description', () => {
  it('overrides the default title when title is passed', () => {
    const html = emptyState({ title: 'No products yet' })
    expect(html).toContain('No products yet')
    expect(html).not.toContain('Nothing here yet')
  })

  it('includes the description when provided', () => {
    const html = emptyState({
      title: 'No products yet',
      description: 'Create your first product to start selling.',
    })
    expect(html).toContain('Create your first product to start selling.')
    expect(html).toContain('gbox-empty-desc')
  })

  it('omits the description block entirely when not provided', () => {
    const html = emptyState({ title: 'No products yet' })
    expect(html).not.toContain('gbox-empty-desc')
  })

  it('HTML-escapes the title to prevent XSS', () => {
    const html = emptyState({ title: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('HTML-escapes the description to prevent XSS', () => {
    const html = emptyState({
      title: 'Safe',
      description: '<img src=x onerror=alert(1)>',
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})

describe('emptyState — actions', () => {
  it('renders an href action as an <a>', () => {
    const html = emptyState({
      actions: [{ label: 'Create product', href: '/products/new' }],
    })
    expect(html).toContain('<a href="/products/new"')
    expect(html).toContain('>Create product</a>')
  })

  it('renders an onclick action as a <button>', () => {
    const html = emptyState({
      actions: [{ label: 'Clear filters', onclick: 'clearFilters()' }],
    })
    expect(html).toContain('<button')
    expect(html).toContain('type="button"')
    expect(html).toContain('onclick="clearFilters()"')
  })

  it('marks the first action as primary by default', () => {
    const html = emptyState({
      actions: [{ label: 'Create', href: '/new' }],
    })
    expect(html).toContain('gbox-empty-action-primary')
  })

  it('marks the second action as secondary by default', () => {
    const html = emptyState({
      actions: [
        { label: 'Create', href: '/new' },
        { label: 'Learn more', href: '/docs' },
      ],
    })
    expect(html).toContain('gbox-empty-action-primary')
    expect(html).toContain('gbox-empty-action-secondary')
  })

  it('respects an explicit kind override', () => {
    const html = emptyState({
      actions: [
        { label: 'A', href: '/a', kind: 'secondary' },
        { label: 'B', href: '/b', kind: 'primary' },
      ],
    })
    const firstIdx = html.indexOf('Label A'.replace('Label ', ''))
    expect(html.indexOf('gbox-empty-action-secondary')).toBeLessThan(
      html.indexOf('gbox-empty-action-primary'),
    )
    expect(firstIdx).toBeGreaterThanOrEqual(-1) // sanity
  })

  it('HTML-escapes the action label', () => {
    const html = emptyState({
      actions: [{ label: '<b>Click</b>', href: '/' }],
    })
    expect(html).not.toContain('<b>Click</b>')
    expect(html).toContain('&lt;b&gt;Click&lt;/b&gt;')
  })

  it('HTML-escapes the href to prevent attribute injection', () => {
    const html = emptyState({
      actions: [{ label: 'Go', href: '" onmouseover="alert(1)' }],
    })
    expect(html).not.toContain('onmouseover="alert(1)"')
    expect(html).toContain('&quot;')
  })

  it('renders an action with neither href nor onclick as a disabled span', () => {
    const html = emptyState({
      actions: [{ label: 'Locked' } as EmptyStateAction],
    })
    expect(html).toContain('<span')
    expect(html).toContain('gbox-empty-action-disabled')
    expect(html).toContain('Locked')
  })

  it('omits the actions block entirely when no actions are passed', () => {
    const html = emptyState()
    expect(html).not.toContain('gbox-empty-actions')
  })
})

describe('emptyState — icon override', () => {
  it('uses a custom icon when provided', () => {
    const customIcon = '<svg data-test="custom"></svg>'
    const html = emptyState({ icon: customIcon })
    expect(html).toContain('data-test="custom"')
  })

  it('custom icon replaces the default icon entirely', () => {
    const customIcon = '<svg data-test="custom"></svg>'
    const html = emptyState({ variant: 'no-results', icon: customIcon })
    // Should not also include the default no-results magnifying glass
    // (we detect the default via its circle cx="28" pattern)
    expect(html).toContain('data-test="custom"')
    expect(html.match(/<svg/g)?.length).toBe(1)
  })
})

describe('emptyState — className passthrough', () => {
  it('appends a custom className to the root container', () => {
    const html = emptyState({ className: 'my-custom-empty' })
    expect(html).toContain('my-custom-empty')
    expect(html).toContain('gbox-empty')
  })

  it('works when className is empty string', () => {
    const html = emptyState({ className: '' })
    expect(html).toContain('gbox-empty')
  })
})

describe('emptyStateCss', () => {
  it('defines the root .gbox-empty class', () => {
    expect(emptyStateCss()).toContain('.gbox-empty ')
  })

  it('scopes actions as .gbox-empty-action-primary / -secondary', () => {
    const css = emptyStateCss()
    expect(css).toContain('.gbox-empty-action-primary')
    expect(css).toContain('.gbox-empty-action-secondary')
  })

  it('uses CSS variables so it adapts to dark/light theme', () => {
    const css = emptyStateCss()
    expect(css).toContain('var(--god-text')
    expect(css).toContain('var(--god-accent')
    expect(css).toContain('var(--god-border')
  })

  it('has focus-visible styles for a11y', () => {
    const css = emptyStateCss()
    expect(css).toContain(':focus-visible')
    expect(css).toContain('outline')
  })

  it('class names stay in sync with emptyState output', () => {
    const html = emptyState({
      actions: [{ label: 'Go', href: '/' }],
      description: 'desc',
    })
    const css = emptyStateCss()
    for (const cls of [
      'gbox-empty',
      'gbox-empty-icon',
      'gbox-empty-title',
      'gbox-empty-desc',
      'gbox-empty-actions',
      'gbox-empty-action',
    ]) {
      expect(html).toContain(cls)
      expect(css).toContain(cls)
    }
  })
})
