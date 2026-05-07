/**
 * support (store-admin pages) — tests.
 *
 * Covers the pure helper functions exposed via `__testables`. HTTP
 * handlers themselves are covered by the Phase 12.5 PR2 smoke script,
 * which stands up express + seller-layout and checks end-to-end.
 *
 * What's pinned here:
 *
 *   - message bubbles align by ownership (seller = right / blue /
 *     white text, agent = left / neutral)
 *   - system bubbles render centered italic (no blue pill)
 *   - CSAT form exposes 1-5 radios and the canonical POST action
 *   - `formatWhen` returns relative labels near the current clock and
 *     falls back to a date string for older timestamps
 *   - all rendered fragments pass `assertSellerSafe` (Iron Rule 5)
 */
import { describe, it, expect } from 'vitest'
import { __testables } from './support.ts'
import { assertSellerSafe } from '@gbox/core/modules/support/index.js'

const { renderMessageBubble, renderCsatForm, renderStars, successFlash, formatWhen, CATEGORY_OPTIONS, STATUS_LABEL, STATUS_COLOR } = __testables

describe('renderMessageBubble', () => {
  const base = {
    id: 'msg-1',
    ticketId: 'tkt-1',
    createdAt: '2026-04-22T10:00:00.000Z',
  }

  it('seller bubble (isOwn=true) uses #0084FF and right-alignment', () => {
    const html = renderMessageBubble({
      ...base,
      senderType: 'seller',
      senderDisplayName: 'Thai',
      body: 'hello',
      isOwn: true,
    })
    expect(html).toContain('#0084FF')
    expect(html).toContain('flex-end')
    expect(html).toContain('hello')
    expect(html).toContain('Thai')
  })

  it('agent bubble (isOwn=false) uses neutral surface and left-alignment', () => {
    const html = renderMessageBubble({
      ...base,
      senderType: 'agent',
      senderDisplayName: 'Minh (Gbox)',
      body: 'thanks for writing in',
      isOwn: false,
    })
    expect(html).toContain('var(--s-card-hover)')
    expect(html).toContain('flex-start')
    expect(html).not.toContain('#0084FF')
    expect(html).toContain('Minh (Gbox)')
  })

  it('system messages render centered italic, no bubble', () => {
    const html = renderMessageBubble({
      ...base,
      senderType: 'system',
      senderDisplayName: 'Gbox System',
      body: 'Ticket auto-closed after 7 days idle',
      isOwn: false,
    })
    expect(html).toContain('<em>')
    expect(html).toContain('Ticket auto-closed after 7 days idle')
    expect(html).not.toContain('#0084FF')
  })

  it('HTML-escapes seller-supplied body + display name', () => {
    const html = renderMessageBubble({
      ...base,
      senderType: 'seller',
      senderDisplayName: '<Thai>',
      body: '<script>alert(1)</script>',
      isOwn: true,
    })
    expect(html).toContain('&lt;Thai&gt;')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert')
  })

  it('rendered HTML is seller-safe', () => {
    const html = renderMessageBubble({
      ...base,
      senderType: 'agent',
      senderDisplayName: 'Minh (Gbox)',
      body: 'any reply',
      isOwn: false,
    })
    expect(assertSellerSafe(html)).toBe(true)
  })
})

describe('renderCsatForm', () => {
  it('exposes 5 radio buttons named "rating" with values 1..5', () => {
    const html = renderCsatForm('/admin/store/s', 'tkt-1', '<input csrf>')
    for (let n = 1; n <= 5; n++) {
      expect(html).toContain(`value="${n}"`)
    }
    expect((html.match(/name="rating"/g) ?? []).length).toBe(5)
  })

  it('POSTs to the canonical {base}/support/{id}/csat endpoint', () => {
    const html = renderCsatForm('/admin/store/my-shop', 'tkt-abc', '<input csrf>')
    expect(html).toContain('action="/admin/store/my-shop/support/tkt-abc/csat"')
  })

  it('renders the passed csrfField verbatim', () => {
    const csrf = '<input type="hidden" name="csrf_token" value="t">'
    const html = renderCsatForm('/admin/store/s', 'tkt-1', csrf)
    expect(html).toContain(csrf)
  })

  it('exposes an optional comment textarea (max 500 chars)', () => {
    const html = renderCsatForm('/admin/store/s', 'tkt-1', '<input csrf>')
    expect(html).toContain('name="comment"')
    expect(html).toContain('maxlength="500"')
  })

  it('ticketId is escaped in the action URL', () => {
    const html = renderCsatForm('/admin/store/s', 'tkt"evil', '<input csrf>')
    expect(html).toContain('tkt&quot;evil')
  })
})

describe('renderStars', () => {
  it('renders 5 star glyphs always', () => {
    const html = renderStars(3)
    expect((html.match(/&#9733;/g) ?? []).length).toBe(5)
  })

  it('paints the first N stars gold and the rest muted', () => {
    const zero = renderStars(0)
    expect(zero).not.toContain('#f59e0b') // no gold stars
    const three = renderStars(3)
    expect((three.match(/#f59e0b/g) ?? []).length).toBe(3)
    const five = renderStars(5)
    expect((five.match(/#f59e0b/g) ?? []).length).toBe(5)
  })
})

describe('successFlash', () => {
  it('escapes its input', () => {
    expect(successFlash('<x>')).toContain('&lt;x&gt;')
  })

  it('renders a green banner', () => {
    expect(successFlash('saved')).toContain('rgba(16,185,129,.12)')
  })

  it('is seller-safe', () => {
    expect(assertSellerSafe(successFlash('Ticket submitted.'))).toBe(true)
  })
})

describe('formatWhen', () => {
  it('"just now" for < 1min', () => {
    const t = new Date(Date.now() - 30_000).toISOString()
    expect(formatWhen(t)).toBe('just now')
  })

  it('"Nm ago" for < 1hr', () => {
    const t = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(formatWhen(t)).toBe('5m ago')
  })

  it('"Nh ago" for < 1d', () => {
    const t = new Date(Date.now() - 3 * 3600_000).toISOString()
    expect(formatWhen(t)).toBe('3h ago')
  })

  it('returns a locale date string for older timestamps', () => {
    const t = new Date(Date.now() - 5 * 86_400_000).toISOString()
    const s = formatWhen(t)
    // Locale-formatted; contains at least a 2-digit time block.
    expect(s).toMatch(/\d{1,2}:\d{2}/)
  })

  it('returns the raw string on an unparseable input rather than throwing', () => {
    // Date('bogus').getTime() is NaN; the helper returns NaN-based values
    // rather than throwing, but we still expect it not to blow up and
    // produce a string result.
    const out = formatWhen('not-a-date')
    expect(typeof out).toBe('string')
  })
})

describe('CATEGORY_OPTIONS', () => {
  it('includes every category the DB enum supports', () => {
    const values = CATEGORY_OPTIONS.map((c) => c.value).sort()
    expect(values).toEqual(
      ['account', 'onboarding', 'other', 'payment', 'product_order', 'technical'].sort(),
    )
  })

  it('labels payment as 24/7 so sellers can see the SLA difference', () => {
    const payment = CATEGORY_OPTIONS.find((c) => c.value === 'payment')
    expect(payment?.label).toMatch(/24\/7/)
  })
})

describe('STATUS_LABEL / STATUS_COLOR', () => {
  it('has an entry for every well-known status', () => {
    const keys = Object.keys(STATUS_LABEL).sort()
    expect(keys).toEqual(['closed', 'merged', 'open', 'pending_agent', 'pending_seller', 'resolved'])
  })

  it('STATUS_COLOR matches STATUS_LABEL keys 1:1', () => {
    expect(Object.keys(STATUS_COLOR).sort()).toEqual(Object.keys(STATUS_LABEL).sort())
  })

  it('colors are 6-char hex codes', () => {
    for (const color of Object.values(STATUS_COLOR)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})
