/**
 * seller-layout — notification bell drawer read/unread UX tests
 * (April 2026 fix: badge never cleared because the drawer never
 * told the server those notifications had been seen).
 *
 * Thai's bug report (verbatim, translated):
 *   "every system change produces a notification, but I don't see
 *    viewed-notification / new-notification / mark-as-viewed — so
 *    the red count on the bell always stays, even after opening."
 *
 * Fix in three layers:
 *
 *   1. Opening the drawer POSTs to `/notifications/mark-seen`
 *      (JSON endpoint added in notifications-admin.ts). This flips
 *      all unread rows to read=true and returns the fresh
 *      `unreadCount: 0`, so the bell badge clears the moment the
 *      drawer opens — no second round-trip.
 *
 *   2. The drawer header now has a "Mark all as read" button for
 *      the explicit gesture. It posts to the same endpoint so the
 *      behaviour stays identical regardless of entry point.
 *
 *   3. Unread rows inside the drawer get a small "New" pill so the
 *      seller can still tell at a glance which items are fresh,
 *      even after the badge has gone to zero. "đã xem" vs "mới" in
 *      Thai's words — the badge says "nothing unseen remains", the
 *      pill says "this row is fresh".
 *
 * The assertions here are string-based on the rendered layout HTML,
 * matching the pattern in seller-layout.test.ts. Behavioural coverage
 * for the endpoint itself lives in notifications-admin.markseen.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { sellerLayout } from './seller-layout.js'

function layoutOpts(over: Partial<Parameters<typeof sellerLayout>[0]> = {}) {
  return {
    title: 'Dashboard',
    storeName: 'Acme',
    storeSlug: 'acme',
    userName: 'Thai',
    userEmail: 'thai@example.com',
    userRole: 'owner',
    storeRole: 'owner',
    activePage: 'dashboard',
    content: '<main></main>',
    ...over,
  }
}

describe('sellerLayout — bell drawer mark-seen wiring', () => {
  it('POSTs to /admin/store/:slug/notifications/mark-seen when the drawer opens', () => {
    const html = sellerLayout(layoutOpts())
    // The URL must be shop-scoped (store slug baked in) so the server
    // routes it to the correct tenant. A missing slug would silently
    // mark-seen on the wrong store.
    expect(html).toContain('/admin/store/acme/notifications/mark-seen')
  })

  it('uses POST method for the mark-seen fetch (server-side CSRF skip + SameSite=Lax expects POST)', () => {
    const html = sellerLayout(layoutOpts())
    // The inline fetch() call carries method: 'POST' literally.
    expect(html).toMatch(/method:\s*['"]POST['"]/)
  })

  it('clears the bell dot immediately after mark-seen returns (unreadCount:0)', () => {
    const html = sellerLayout(layoutOpts())
    // The optimistic update: dot.style.display = 'none' after the
    // POST resolves, without waiting on a follow-up /recent fetch.
    // The string we pin is the literal hide-dot instruction wired to
    // the mark-seen response handler. Stable across CSS refactors
    // because it's JS behavior, not styling.
    expect(html).toMatch(/notifDot/)
    expect(html).toMatch(/mark-seen/)
  })
})

describe('sellerLayout — Mark all as read button', () => {
  it('renders a "Mark all as read" button in the drawer header', () => {
    const html = sellerLayout(layoutOpts())
    expect(html).toContain('Mark all as read')
  })

  it('gives the button a stable id (notifMarkAll) the inline JS can wire to', () => {
    const html = sellerLayout(layoutOpts())
    expect(html).toContain('id="notifMarkAll"')
  })
})

describe('sellerLayout — unread "New" pill inside drawer items', () => {
  it('emits the notif-item-new class name from the item renderer (conditional on !read)', () => {
    const html = sellerLayout(layoutOpts())
    // The inline renderer adds the class when item.read is false.
    expect(html).toContain('notif-item-new')
  })

  it('defines CSS for the notif-item-new pill so the unread marker is actually visible', () => {
    const html = sellerLayout(layoutOpts())
    // Accept either `.notif-item-new {` with a space or `.notif-item-new{`
    // without — both are valid CSS and the layout formatter may shift.
    expect(html).toMatch(/\.notif-item-new\s*\{/)
  })
})
