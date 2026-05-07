/**
 * Tests for the shared skeleton loader (Phase 2 Step 2.2).
 *
 * We pin: each atom renders with the expected size/shape, composites
 * respect row/column counts, aria-hidden for decorative atoms, and
 * aria-label for composites so screen readers announce "Loading".
 */

import { describe, it, expect } from 'vitest'
import {
  skeletonLine,
  skeletonRect,
  skeletonCircle,
  skeletonTable,
  skeletonCardGrid,
  skeletonForm,
  skeletonCss,
} from './skeleton.js'

describe('skeletonLine', () => {
  it('defaults to full-width 12px line', () => {
    const html = skeletonLine()
    expect(html).toContain('width:100%')
    expect(html).toContain('height:12px')
    expect(html).toContain('gbox-skel-line')
  })

  it('accepts custom width and height', () => {
    const html = skeletonLine({ width: '50%', height: '8px' })
    expect(html).toContain('width:50%')
    expect(html).toContain('height:8px')
  })

  it('is decorative (aria-hidden)', () => {
    expect(skeletonLine()).toContain('aria-hidden="true"')
  })
})

describe('skeletonRect', () => {
  it('defaults to 80px height 6px radius', () => {
    const html = skeletonRect()
    expect(html).toContain('height:80px')
    expect(html).toContain('border-radius:6px')
  })

  it('accepts custom radius', () => {
    const html = skeletonRect({ radius: '12px' })
    expect(html).toContain('border-radius:12px')
  })
})

describe('skeletonCircle', () => {
  it('defaults to 32px square (CSS border-radius makes it a circle)', () => {
    const html = skeletonCircle()
    expect(html).toContain('width:32px')
    expect(html).toContain('height:32px')
    expect(html).toContain('gbox-skel-circle')
  })

  it('accepts custom size', () => {
    expect(skeletonCircle({ size: '48px' })).toContain('width:48px')
  })
})

describe('skeletonTable', () => {
  it('renders 6 rows and 5 columns by default plus a header', () => {
    const html = skeletonTable()
    const rows = html.match(/gbox-skel-tr(?!\w)/g) ?? []
    // 1 header row + 6 body rows = 7
    expect(rows.length).toBe(7)
  })

  it('renders the correct number of rows', () => {
    const html = skeletonTable({ rows: 3, withHeader: false })
    const rows = html.match(/gbox-skel-tr(?!\w)/g) ?? []
    expect(rows.length).toBe(3)
  })

  it('renders the correct number of columns', () => {
    const html = skeletonTable({ rows: 1, columns: 8, withHeader: false })
    const cells = html.match(/gbox-skel-td/g) ?? []
    expect(cells.length).toBe(8)
  })

  it('can skip the header row', () => {
    const html = skeletonTable({ withHeader: false })
    expect(html).not.toContain('gbox-skel-thead')
    expect(html).not.toContain('gbox-skel-th')
  })

  it('announces itself as loading for screen readers', () => {
    const html = skeletonTable()
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="Loading"')
  })
})

describe('skeletonCardGrid', () => {
  it('renders 6 cards by default', () => {
    const html = skeletonCardGrid()
    const cards = html.match(/gbox-skel-card(?!-)/g) ?? []
    expect(cards.length).toBe(6)
  })

  it('accepts a custom count', () => {
    const html = skeletonCardGrid({ count: 3 })
    const cards = html.match(/gbox-skel-card(?!-)/g) ?? []
    expect(cards.length).toBe(3)
  })

  it('each card has a body with line placeholders', () => {
    const html = skeletonCardGrid({ count: 1 })
    expect(html).toContain('gbox-skel-card-body')
    expect(html).toContain('gbox-skel-line')
  })

  it('uses a responsive grid', () => {
    expect(skeletonCardGrid()).toContain('gbox-skel-grid')
  })
})

describe('skeletonForm', () => {
  it('renders 4 field pairs by default', () => {
    const html = skeletonForm()
    const fields = html.match(/gbox-skel-field/g) ?? []
    expect(fields.length).toBe(4)
  })

  it('accepts a custom field count', () => {
    const html = skeletonForm({ fields: 2 })
    const fields = html.match(/gbox-skel-field/g) ?? []
    expect(fields.length).toBe(2)
  })

  it('includes a button row by default', () => {
    expect(skeletonForm()).toContain('gbox-skel-buttons')
  })

  it('can skip the button row', () => {
    expect(skeletonForm({ withButtons: false })).not.toContain(
      'gbox-skel-buttons',
    )
  })

  it('announces itself as a loading form', () => {
    expect(skeletonForm()).toContain('aria-label="Loading form"')
  })
})

describe('skeletonCss', () => {
  it('defines the shimmer keyframes', () => {
    const css = skeletonCss()
    expect(css).toContain('@keyframes gbox-skel-shimmer')
    expect(css).toContain('background-position')
  })

  it('applies the shimmer animation to .gbox-skel', () => {
    const css = skeletonCss()
    expect(css).toContain('.gbox-skel ')
    expect(css).toContain('animation:')
    expect(css).toContain('gbox-skel-shimmer')
  })

  it('uses theme CSS variables so it adapts to dark/light', () => {
    const css = skeletonCss()
    expect(css).toContain('var(--god-border')
    expect(css).toContain('var(--god-surface')
  })

  it('respects prefers-reduced-motion', () => {
    const css = skeletonCss()
    expect(css).toContain('prefers-reduced-motion')
    expect(css).toContain('animation: none')
  })

  it('class names stay in sync with the atom/composite functions', () => {
    const css = skeletonCss()
    const combined =
      skeletonLine() +
      skeletonRect() +
      skeletonCircle() +
      skeletonTable({ rows: 1 }) +
      skeletonCardGrid({ count: 1 }) +
      skeletonForm({ fields: 1 })
    for (const cls of [
      'gbox-skel',
      'gbox-skel-line',
      'gbox-skel-rect',
      'gbox-skel-circle',
      'gbox-skel-table',
      'gbox-skel-tr',
      'gbox-skel-td',
      'gbox-skel-grid',
      'gbox-skel-card',
      'gbox-skel-card-body',
      'gbox-skel-form',
      'gbox-skel-field',
      'gbox-skel-buttons',
    ]) {
      expect(combined).toContain(cls)
      expect(css).toContain(cls)
    }
  })
})
