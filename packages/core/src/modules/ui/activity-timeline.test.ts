/**
 * Tests for the shared activity timeline UI renderer.
 */

import { describe, it, expect } from 'vitest'
import {
  activityTimeline,
  activityTimelineCompact,
  activityTimelineCss,
  relativeTime,
} from './activity-timeline.js'
import type { ActivityRecord } from '../activity/types.js'

const FIXED_NOW = new Date('2026-04-09T12:00:00.000Z')

function mkEvent(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    action: 'product_created',
    actorUserId: 'aaa',
    actorLabel: 'alice@example.com',
    shopId: 'shop-1',
    resourceType: 'product',
    resourceId: '22222222-2222-2222-2222-222222222222',
    details: null,
    ipAddress: '192.168.1.1',
    createdAt: '2026-04-09T11:58:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  const now = FIXED_NOW

  it('returns "just now" for <5s', () => {
    const iso = new Date(now.getTime() - 2000).toISOString()
    expect(relativeTime(iso, now)).toBe('just now')
  })

  it('returns seconds for <60s', () => {
    const iso = new Date(now.getTime() - 30_000).toISOString()
    expect(relativeTime(iso, now)).toBe('30 seconds ago')
  })

  it('returns minutes for <60m', () => {
    const iso = new Date(now.getTime() - 5 * 60_000).toISOString()
    expect(relativeTime(iso, now)).toBe('5 minutes ago')
  })

  it('returns singular "1 minute ago"', () => {
    const iso = new Date(now.getTime() - 60_000).toISOString()
    expect(relativeTime(iso, now)).toBe('1 minute ago')
  })

  it('returns hours for <24h', () => {
    const iso = new Date(now.getTime() - 3 * 3600_000).toISOString()
    expect(relativeTime(iso, now)).toBe('3 hours ago')
  })

  it('returns days for <7d', () => {
    const iso = new Date(now.getTime() - 4 * 86_400_000).toISOString()
    expect(relativeTime(iso, now)).toBe('4 days ago')
  })

  it('returns weeks for <5w', () => {
    const iso = new Date(now.getTime() - 14 * 86_400_000).toISOString()
    expect(relativeTime(iso, now)).toBe('2 weeks ago')
  })

  it('returns months for <12mo', () => {
    const iso = new Date(now.getTime() - 90 * 86_400_000).toISOString()
    expect(relativeTime(iso, now)).toBe('3 months ago')
  })

  it('returns years for ≥12mo', () => {
    const iso = new Date(now.getTime() - 400 * 86_400_000).toISOString()
    expect(relativeTime(iso, now)).toBe('1 year ago')
  })

  it('handles future dates gracefully', () => {
    const iso = new Date(now.getTime() + 60_000).toISOString()
    expect(relativeTime(iso, now)).toBe('in the future')
  })

  it('returns the input when ISO is unparseable', () => {
    expect(relativeTime('not-a-date', now)).toBe('not-a-date')
  })
})

// ---------------------------------------------------------------------------
// activityTimeline (full)
// ---------------------------------------------------------------------------

describe('activityTimeline', () => {
  it('renders an empty state when no events are passed', () => {
    const html = activityTimeline({ events: [], now: FIXED_NOW })
    // Uses the shared empty-state component.
    expect(html).toContain('gbox-empty')
    expect(html).toContain('No activity yet')
  })

  it('respects a custom empty message', () => {
    const html = activityTimeline({
      events: [],
      emptyMessage: 'Nothing here yet for this order.',
      now: FIXED_NOW,
    })
    expect(html).toContain('Nothing here yet for this order.')
  })

  it('renders one row per event', () => {
    const events = [
      mkEvent({ id: 'a' }),
      mkEvent({ id: 'b', action: 'order_paid' }),
      mkEvent({ id: 'c', action: 'product_deleted' }),
    ]
    const html = activityTimeline({ events, now: FIXED_NOW })
    const rowCount = (html.match(/class="gbox-at-row/g) ?? []).length
    expect(rowCount).toBe(3)
  })

  it('humanizes action names into badge labels', () => {
    const html = activityTimeline({
      events: [mkEvent({ action: 'order_partially_refunded' })],
      now: FIXED_NOW,
    })
    expect(html).toContain('Order partially refunded')
  })

  it('applies the danger class to destructive actions', () => {
    const html = activityTimeline({
      events: [mkEvent({ action: 'product_deleted' })],
      now: FIXED_NOW,
    })
    expect(html).toContain('gbox-at-danger')
  })

  it('applies the success class to positive actions', () => {
    const html = activityTimeline({
      events: [mkEvent({ action: 'order_paid' })],
      now: FIXED_NOW,
    })
    expect(html).toContain('gbox-at-success')
  })

  it('applies the warning class to mutation actions', () => {
    const html = activityTimeline({
      events: [mkEvent({ action: 'inventory_adjusted' })],
      now: FIXED_NOW,
    })
    expect(html).toContain('gbox-at-warning')
  })

  it('renders the actor label', () => {
    const html = activityTimeline({
      events: [mkEvent({ actorLabel: 'bob@example.com' })],
      now: FIXED_NOW,
    })
    expect(html).toContain('bob@example.com')
  })

  it('hides the actor column when hideActor is true', () => {
    const html = activityTimeline({
      events: [mkEvent({ actorLabel: 'bob@example.com' })],
      hideActor: true,
      now: FIXED_NOW,
    })
    expect(html).not.toContain('bob@example.com')
  })

  it('renders the resource label with a shortened id', () => {
    const html = activityTimeline({
      events: [
        mkEvent({
          resourceType: 'order',
          resourceId: 'abcdef12-3456-7890-abcd-ef1234567890',
        }),
      ],
      now: FIXED_NOW,
    })
    // First 8 chars of the uuid.
    expect(html).toContain('order:abcdef12')
  })

  it('hides the resource column when hideResource is true', () => {
    const html = activityTimeline({
      events: [
        mkEvent({
          resourceType: 'order',
          resourceId: 'abcdef12-3456-7890-abcd-ef1234567890',
        }),
      ],
      hideResource: true,
      now: FIXED_NOW,
    })
    expect(html).not.toContain('order:abcdef12')
  })

  it('renders the IP address', () => {
    const html = activityTimeline({
      events: [mkEvent({ ipAddress: '10.0.0.5' })],
      now: FIXED_NOW,
    })
    expect(html).toContain('10.0.0.5')
  })

  it('renders a details disclosure when details are present', () => {
    const html = activityTimeline({
      events: [mkEvent({ details: { before: 10, after: 5 } })],
      now: FIXED_NOW,
    })
    expect(html).toContain('<details')
    // JSON keys are HTML-escaped inside the <pre> block so the
    // literal quote char is rendered as &quot;.
    expect(html).toContain('&quot;before&quot;: 10')
    expect(html).toContain('&quot;after&quot;: 5')
  })

  it('omits the details disclosure when details is null or empty', () => {
    const nullHtml = activityTimeline({
      events: [mkEvent({ details: null })],
      now: FIXED_NOW,
    })
    expect(nullHtml).not.toContain('<details')

    const emptyHtml = activityTimeline({
      events: [mkEvent({ details: {} })],
      now: FIXED_NOW,
    })
    expect(emptyHtml).not.toContain('<details')
  })

  it('renders a relative time label', () => {
    const html = activityTimeline({
      events: [
        mkEvent({ createdAt: new Date(FIXED_NOW.getTime() - 3600_000).toISOString() }),
      ],
      now: FIXED_NOW,
    })
    expect(html).toContain('1 hour ago')
  })

  it('escapes HTML in user-supplied text', () => {
    const html = activityTimeline({
      events: [
        mkEvent({
          actorLabel: '<script>alert(1)</script>',
          action: 'custom_action',
          ipAddress: '<x>',
          resourceType: '<r>',
          resourceId: '<id>',
        }),
      ],
      now: FIXED_NOW,
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;x&gt;')
    // Resource label is built from <r>:<id> (both escaped).
    expect(html).toContain('&lt;r&gt;')
  })

  it('escapes potentially unsafe JSON in details', () => {
    const html = activityTimeline({
      events: [
        mkEvent({ details: { evil: '</script><script>alert(1)</script>' } }),
      ],
      now: FIXED_NOW,
    })
    expect(html).not.toContain('</script><script>alert(1)</script>')
    expect(html).toContain('&lt;/script&gt;')
  })
})

// ---------------------------------------------------------------------------
// activityTimelineCompact
// ---------------------------------------------------------------------------

describe('activityTimelineCompact', () => {
  it('renders an empty message when no events are passed', () => {
    const html = activityTimelineCompact({ events: [], now: FIXED_NOW })
    expect(html).toContain('No activity yet')
  })

  it('wraps events in a <ul>', () => {
    const html = activityTimelineCompact({
      events: [mkEvent()],
      now: FIXED_NOW,
    })
    expect(html).toMatch(/^<ul class="gbox-atc">/)
  })

  it('renders one <li> per event', () => {
    const events = [mkEvent({ id: '1' }), mkEvent({ id: '2' })]
    const html = activityTimelineCompact({ events, now: FIXED_NOW })
    const liCount = (html.match(/<li class="gbox-atc-row/g) ?? []).length
    expect(liCount).toBe(2)
  })

  it('hides actor when hideActor is true', () => {
    const html = activityTimelineCompact({
      events: [mkEvent({ actorLabel: 'bob@example.com' })],
      hideActor: true,
      now: FIXED_NOW,
    })
    expect(html).not.toContain('bob@example.com')
  })

  it('applies category class to each row', () => {
    const html = activityTimelineCompact({
      events: [
        mkEvent({ action: 'product_deleted' }),
        mkEvent({ action: 'order_paid' }),
      ],
      now: FIXED_NOW,
    })
    expect(html).toContain('gbox-at-danger')
    expect(html).toContain('gbox-at-success')
  })
})

// ---------------------------------------------------------------------------
// activityTimelineCss
// ---------------------------------------------------------------------------

describe('activityTimelineCss', () => {
  it('defines the core timeline classes', () => {
    const css = activityTimelineCss()
    expect(css).toContain('.gbox-at ')
    expect(css).toContain('.gbox-at-row')
    expect(css).toContain('.gbox-at-rail')
    expect(css).toContain('.gbox-at-dot')
    expect(css).toContain('.gbox-at-body')
    expect(css).toContain('.gbox-at-badge')
    expect(css).toContain('.gbox-at-actor')
  })

  it('defines per-category colors', () => {
    const css = activityTimelineCss()
    expect(css).toContain('.gbox-at-success .gbox-at-dot')
    expect(css).toContain('.gbox-at-danger .gbox-at-dot')
    expect(css).toContain('.gbox-at-warning .gbox-at-dot')
    expect(css).toContain('.gbox-at-info .gbox-at-dot')
  })

  it('defines the compact variant classes', () => {
    const css = activityTimelineCss()
    expect(css).toContain('.gbox-atc')
    expect(css).toContain('.gbox-atc-row')
    expect(css).toContain('.gbox-atc-dot')
    expect(css).toContain('.gbox-atc-time')
  })

  it('uses theme CSS variables', () => {
    const css = activityTimelineCss()
    expect(css).toContain('var(--god-surface')
    expect(css).toContain('var(--god-text')
    expect(css).toContain('var(--god-border')
  })
})
