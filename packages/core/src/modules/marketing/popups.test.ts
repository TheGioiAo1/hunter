/**
 * Gbox Platform — Popup trigger engine tests (Stage 4.4)
 *
 * The popup engine is a pure decision function that answers
 * exactly one question:
 *
 *   "Given this popup rule and the current session snapshot,
 *    should we fire the popup right now? And if not, why not?"
 *
 * The caller (storefront runtime) collects the session state
 * (time on page, scroll depth, mouse trajectory, visit count,
 * previous dismissal cookies) and passes it to `evaluatePopup`.
 * The engine itself never touches the DOM.
 *
 * Triggers supported:
 *   • exit_intent — pointer left the top of the viewport
 *   • time_on_page — dwell time ≥ threshold
 *   • scroll_depth — scrolled past a % of the page
 *   • page_view_count — Nth visit in the current session
 *
 * Every failure path returns a discriminated rejection reason so
 * the admin UI can explain why a preview popup isn't firing.
 */

import { describe, it, expect } from 'vitest'
import {
  evaluatePopup,
  type PopupRule,
  type PopupSessionSnapshot,
} from './popups.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const baseRule = (overrides: Partial<PopupRule> = {}): PopupRule => ({
  id: 'pop_1',
  active: true,
  trigger: { kind: 'exit_intent' },
  audienceSegments: null,
  excludePaths: null,
  includePaths: null,
  showOncePerSession: true,
  cooldownHours: 24,
  ...overrides,
})

const baseSnapshot = (
  overrides: Partial<PopupSessionSnapshot> = {},
): PopupSessionSnapshot => ({
  path: '/',
  now: new Date('2026-04-09T12:00:00Z'),
  dwellSeconds: 0,
  scrollDepthPercent: 0,
  pageViewCount: 1,
  exitIntentDetected: false,
  customerSegment: null,
  lastShownAt: null,
  shownThisSession: false,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Inactive / dismissed / cooldown gates
// ---------------------------------------------------------------------------

describe('evaluatePopup — global gates', () => {
  it('rejects an inactive rule', () => {
    const out = evaluatePopup(baseRule({ active: false }), baseSnapshot())
    expect(out.show).toBe(false)
    if (out.show) return
    expect(out.reason).toBe('inactive')
  })

  it('rejects when already shown this session and showOncePerSession=true', () => {
    const out = evaluatePopup(
      baseRule({ showOncePerSession: true }),
      baseSnapshot({ shownThisSession: true, exitIntentDetected: true }),
    )
    expect(out.show).toBe(false)
    if (out.show) return
    expect(out.reason).toBe('already_shown_session')
  })

  it('rejects when the cooldown window is still open', () => {
    const out = evaluatePopup(
      baseRule({ cooldownHours: 24 }),
      baseSnapshot({
        lastShownAt: new Date('2026-04-09T06:00:00Z'), // 6h ago, inside 24h cooldown
        exitIntentDetected: true,
      }),
    )
    expect(out.show).toBe(false)
    if (out.show) return
    expect(out.reason).toBe('cooldown')
  })

  it('allows when cooldown has elapsed', () => {
    const out = evaluatePopup(
      baseRule({ cooldownHours: 24 }),
      baseSnapshot({
        lastShownAt: new Date('2026-04-08T06:00:00Z'), // 30h ago
        exitIntentDetected: true,
      }),
    )
    expect(out.show).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Path filters
// ---------------------------------------------------------------------------

describe('evaluatePopup — path filters', () => {
  it('excludes pages in excludePaths', () => {
    const out = evaluatePopup(
      baseRule({ excludePaths: ['/checkout', '/cart'] }),
      baseSnapshot({ path: '/checkout', exitIntentDetected: true }),
    )
    expect(out.show).toBe(false)
    if (out.show) return
    expect(out.reason).toBe('path_excluded')
  })

  it('only allows pages in includePaths when specified', () => {
    const out = evaluatePopup(
      baseRule({ includePaths: ['/products/*'] }),
      baseSnapshot({ path: '/', exitIntentDetected: true }),
    )
    expect(out.show).toBe(false)
    if (out.show) return
    expect(out.reason).toBe('path_not_included')
  })

  it('matches glob wildcards in includePaths', () => {
    const out = evaluatePopup(
      baseRule({ includePaths: ['/products/*'] }),
      baseSnapshot({ path: '/products/t-shirt', exitIntentDetected: true }),
    )
    expect(out.show).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Audience segment gate
// ---------------------------------------------------------------------------

describe('evaluatePopup — audience segment', () => {
  it('rejects when segment is not in the audience list', () => {
    const out = evaluatePopup(
      baseRule({ audienceSegments: ['vip'] }),
      baseSnapshot({ customerSegment: 'returning', exitIntentDetected: true }),
    )
    expect(out.show).toBe(false)
    if (out.show) return
    expect(out.reason).toBe('audience_mismatch')
  })

  it('allows when segment is in the audience list', () => {
    const out = evaluatePopup(
      baseRule({ audienceSegments: ['vip', 'new'] }),
      baseSnapshot({ customerSegment: 'new', exitIntentDetected: true }),
    )
    expect(out.show).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Trigger: exit_intent
// ---------------------------------------------------------------------------

describe('evaluatePopup — exit_intent trigger', () => {
  it('fires when exitIntentDetected is true', () => {
    const out = evaluatePopup(
      baseRule({ trigger: { kind: 'exit_intent' } }),
      baseSnapshot({ exitIntentDetected: true }),
    )
    expect(out.show).toBe(true)
  })

  it('does not fire when exitIntentDetected is false', () => {
    const out = evaluatePopup(
      baseRule({ trigger: { kind: 'exit_intent' } }),
      baseSnapshot({ exitIntentDetected: false }),
    )
    expect(out.show).toBe(false)
    if (out.show) return
    expect(out.reason).toBe('trigger_not_met')
  })
})

// ---------------------------------------------------------------------------
// Trigger: time_on_page
// ---------------------------------------------------------------------------

describe('evaluatePopup — time_on_page trigger', () => {
  it('fires when dwellSeconds crosses the threshold', () => {
    const out = evaluatePopup(
      baseRule({ trigger: { kind: 'time_on_page', seconds: 30 } }),
      baseSnapshot({ dwellSeconds: 31 }),
    )
    expect(out.show).toBe(true)
  })

  it('does not fire before the dwell threshold', () => {
    const out = evaluatePopup(
      baseRule({ trigger: { kind: 'time_on_page', seconds: 30 } }),
      baseSnapshot({ dwellSeconds: 29 }),
    )
    expect(out.show).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Trigger: scroll_depth
// ---------------------------------------------------------------------------

describe('evaluatePopup — scroll_depth trigger', () => {
  it('fires when scrollDepthPercent crosses the threshold', () => {
    const out = evaluatePopup(
      baseRule({ trigger: { kind: 'scroll_depth', percent: 50 } }),
      baseSnapshot({ scrollDepthPercent: 60 }),
    )
    expect(out.show).toBe(true)
  })

  it('does not fire before the scroll threshold', () => {
    const out = evaluatePopup(
      baseRule({ trigger: { kind: 'scroll_depth', percent: 50 } }),
      baseSnapshot({ scrollDepthPercent: 40 }),
    )
    expect(out.show).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Trigger: page_view_count
// ---------------------------------------------------------------------------

describe('evaluatePopup — page_view_count trigger', () => {
  it('fires on the Nth page view', () => {
    const out = evaluatePopup(
      baseRule({ trigger: { kind: 'page_view_count', count: 3 } }),
      baseSnapshot({ pageViewCount: 3 }),
    )
    expect(out.show).toBe(true)
  })

  it('does not fire before reaching N', () => {
    const out = evaluatePopup(
      baseRule({ trigger: { kind: 'page_view_count', count: 3 } }),
      baseSnapshot({ pageViewCount: 2 }),
    )
    expect(out.show).toBe(false)
  })
})
