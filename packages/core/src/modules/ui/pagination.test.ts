/**
 * Tests for cursor pagination (Phase 2 Step 2.4).
 */

import { describe, it, expect } from 'vitest'
import {
  encodeCursor,
  decodeCursor,
  clampPageSize,
  paginate,
  paginationBarHtml,
  paginationCss,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGE_SIZES,
} from './pagination.js'

interface Row {
  id: string
  created_at: string
  name: string
}

function makeRows(n: number): Row[] {
  return Array.from({ length: n }).map((_, i) => ({
    id: `id-${i}`,
    created_at: new Date(2025, 0, i + 1).toISOString(),
    name: `Row ${i}`,
  }))
}

const getCursor = (r: Row) => ({ k: r.created_at, i: r.id })

describe('encodeCursor + decodeCursor', () => {
  it('round-trips a simple payload', () => {
    const original = { k: '2025-04-01T00:00:00.000Z', i: 'user-123' }
    const encoded = encodeCursor(original)
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual(original)
  })

  it('produces URL-safe output (no +, /, =)', () => {
    // Build a payload that would base64 into chars needing URL escape
    const encoded = encodeCursor({
      k: '??????',
      i: '>>>>>>',
    })
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
  })

  it('returns null for an empty string', () => {
    expect(decodeCursor('')).toBeNull()
  })

  it('returns null for a garbage string', () => {
    expect(decodeCursor('not-base64-at-all!!')).toBeNull()
  })

  it('returns null for a valid base64 that is not a cursor payload', () => {
    // base64 of "just a string"
    const notACursor = Buffer.from(JSON.stringify({ foo: 'bar' })).toString(
      'base64',
    )
    expect(decodeCursor(notACursor)).toBeNull()
  })

  it('handles unicode correctly', () => {
    const payload = { k: 'Thái — Gbox 🚀', i: 'id-01' }
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload)
  })
})

describe('clampPageSize', () => {
  it('returns the default when input is undefined', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE)
  })

  it('returns the default when input is 0', () => {
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE)
  })

  it('returns the default when input is NaN', () => {
    expect(clampPageSize(NaN)).toBe(DEFAULT_PAGE_SIZE)
  })

  it('returns the default when input is not an allowed size', () => {
    expect(clampPageSize(17)).toBe(DEFAULT_PAGE_SIZE)
    expect(clampPageSize(1000000)).toBe(DEFAULT_PAGE_SIZE)
  })

  it('accepts each of the allowed sizes', () => {
    for (const size of DEFAULT_PAGE_SIZES) {
      expect(clampPageSize(size)).toBe(size)
    }
  })
})

describe('paginate — forward direction', () => {
  it('returns all rows when fetched is smaller than pageSize', () => {
    const rows = makeRows(5)
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 50,
    })
    expect(result.items).toHaveLength(5)
    expect(result.hasNext).toBe(false)
    expect(result.nextCursor).toBeNull()
    expect(result.hasPrev).toBe(false)
  })

  it('detects hasNext when an extra row is present', () => {
    const rows = makeRows(51) // pageSize+1
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 50,
    })
    expect(result.items).toHaveLength(50)
    expect(result.hasNext).toBe(true)
    expect(result.nextCursor).not.toBeNull()
  })

  it('hasPrev=true when cursor is present (we got here from somewhere)', () => {
    const rows = makeRows(10)
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 50,
      cursor: encodeCursor({ k: 'x', i: 'y' }),
    })
    expect(result.hasPrev).toBe(true)
    expect(result.prevCursor).not.toBeNull()
  })

  it('hasPrev=false when no incoming cursor (first page)', () => {
    const rows = makeRows(10)
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 50,
    })
    expect(result.hasPrev).toBe(false)
  })

  it('nextCursor points to the last visible row', () => {
    const rows = makeRows(51)
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 50,
    })
    const decoded = decodeCursor(result.nextCursor!)
    expect(decoded?.i).toBe('id-49')
  })

  it('prevCursor points to the first visible row', () => {
    const rows = makeRows(10)
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 50,
      cursor: encodeCursor({ k: 'x', i: 'y' }),
    })
    const decoded = decodeCursor(result.prevCursor!)
    expect(decoded?.i).toBe('id-0')
  })
})

describe('paginate — backward direction', () => {
  it('reverses the fetched order back to natural reading order', () => {
    // Caller fetched in reverse; we expect the result to be re-reversed
    const rows = [makeRows(3)[2], makeRows(3)[1], makeRows(3)[0]]
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 50,
      direction: 'prev',
      cursor: encodeCursor({ k: 'x', i: 'y' }),
    })
    expect(result.items.map((r) => r.id)).toEqual(['id-0', 'id-1', 'id-2'])
  })

  it('detects hasPrev (further back) via the extra row', () => {
    const rows = makeRows(51) // reverse-order scenario — 51 fetched
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 50,
      direction: 'prev',
    })
    expect(result.items).toHaveLength(50)
    expect(result.hasPrev).toBe(true)
  })

  it('always has nextCursor when paginating backward (because we came from somewhere forward)', () => {
    const rows = makeRows(10)
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 50,
      direction: 'prev',
    })
    expect(result.hasNext).toBe(true)
  })

  it('sets isBackward on the result', () => {
    const result = paginate({
      getCursor,
      fetched: makeRows(5),
      pageSize: 50,
      direction: 'prev',
    })
    expect(result.isBackward).toBe(true)
  })
})

describe('paginate — page size clamping', () => {
  it('clamps invalid page sizes to the default', () => {
    const rows = makeRows(60)
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 17, // not allowed
    })
    expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE)
    // 60 fetched > pageSize 50 → 50 items + hasNext
    expect(result.items).toHaveLength(DEFAULT_PAGE_SIZE)
  })

  it('honors an allowed custom page size', () => {
    const rows = makeRows(30)
    const result = paginate({
      getCursor,
      fetched: rows,
      pageSize: 25,
    })
    expect(result.pageSize).toBe(25)
    expect(result.items).toHaveLength(25)
    expect(result.hasNext).toBe(true)
  })
})

describe('paginate — totalApprox pass-through', () => {
  it('forwards the approximate count', () => {
    const result = paginate({
      getCursor,
      fetched: makeRows(10),
      pageSize: 50,
      totalApprox: 12345,
    })
    expect(result.totalApprox).toBe(12345)
  })
})

describe('paginationBarHtml', () => {
  const baseState = {
    hasNext: true,
    hasPrev: true,
    nextCursor: 'NEXT_CURSOR',
    prevCursor: 'PREV_CURSOR',
    pageSize: 50,
    items: new Array(50),
    totalApprox: 1240,
  }

  it('renders as a <nav> with pagination role', () => {
    const html = paginationBarHtml({ state: baseState, basePath: '/users' })
    expect(html).toContain('<nav')
    expect(html).toContain('role="navigation"')
    expect(html).toContain('aria-label="Pagination"')
  })

  it('renders Previous as a link when hasPrev is true', () => {
    const html = paginationBarHtml({ state: baseState, basePath: '/users' })
    expect(html).toContain('cursor=PREV_CURSOR')
    expect(html).toContain('dir=prev')
    expect(html).toContain('rel="prev"')
  })

  it('renders Next as a link when hasNext is true', () => {
    const html = paginationBarHtml({ state: baseState, basePath: '/users' })
    expect(html).toContain('cursor=NEXT_CURSOR')
    expect(html).toContain('dir=next')
    expect(html).toContain('rel="next"')
  })

  it('renders Previous as disabled span when hasPrev is false', () => {
    const html = paginationBarHtml({
      state: { ...baseState, hasPrev: false, prevCursor: null },
      basePath: '/users',
    })
    expect(html).toContain('gbox-pg-btn-disabled')
    expect(html).toContain('aria-disabled="true"')
  })

  it('shows the "showing N of ~T" counter when totalApprox is present', () => {
    const html = paginationBarHtml({ state: baseState, basePath: '/users' })
    expect(html).toContain('showing 50 of ~1,240 items')
  })

  it('shows "showing N" counter when totalApprox is absent', () => {
    const html = paginationBarHtml({
      state: { ...baseState, totalApprox: undefined },
      basePath: '/users',
    })
    expect(html).toContain('showing 50 items')
    expect(html).not.toContain('of ~')
  })

  it('uses a custom item label', () => {
    const html = paginationBarHtml({
      state: baseState,
      basePath: '/users',
      itemLabel: 'products',
    })
    expect(html).toContain('products')
  })

  it('preserves extraParams in the prev/next URLs', () => {
    const html = paginationBarHtml({
      state: baseState,
      basePath: '/users',
      extraParams: { q: 'thai', status: 'active' },
    })
    expect(html).toContain('q=thai')
    expect(html).toContain('status=active')
  })

  it('omits per_page from the URL when it matches the default', () => {
    const html = paginationBarHtml({ state: baseState, basePath: '/users' })
    expect(html).not.toContain('per_page=50')
  })

  it('includes per_page when it differs from the default', () => {
    const html = paginationBarHtml({
      state: { ...baseState, pageSize: 100 },
      basePath: '/users',
    })
    expect(html).toContain('per_page=100')
  })

  it('renders a page-size <select> with all allowed sizes', () => {
    const html = paginationBarHtml({ state: baseState, basePath: '/users' })
    for (const size of DEFAULT_PAGE_SIZES) {
      expect(html).toContain(`value="${size}"`)
    }
  })

  it('marks the current pageSize as selected', () => {
    const html = paginationBarHtml({
      state: { ...baseState, pageSize: 100 },
      basePath: '/users',
    })
    expect(html).toContain('value="100" selected')
  })

  it('HTML-escapes the base path and extraParams', () => {
    const html = paginationBarHtml({
      state: baseState,
      basePath: '/users',
      extraParams: { q: '"><script>alert(1)</script>' },
    })
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})

describe('paginationCss', () => {
  it('defines the root .gbox-pg class', () => {
    expect(paginationCss()).toContain('.gbox-pg ')
  })

  it('defines button, disabled, size-select classes', () => {
    const css = paginationCss()
    expect(css).toContain('.gbox-pg-btn')
    expect(css).toContain('.gbox-pg-btn-disabled')
    expect(css).toContain('.gbox-pg-size-select')
  })

  it('uses theme CSS vars for dark/light adaption', () => {
    const css = paginationCss()
    expect(css).toContain('var(--god-border')
    expect(css).toContain('var(--god-text')
    expect(css).toContain('var(--god-accent')
  })

  it('has focus-visible outlines for a11y', () => {
    const css = paginationCss()
    expect(css).toContain(':focus-visible')
  })
})
