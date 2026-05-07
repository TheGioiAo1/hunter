/**
 * Tests for the notification-center HTML helpers (Phase 2 Step 2.11).
 */

import { describe, it, expect } from 'vitest'
import {
  notificationBellButton,
  notificationDrawer,
  notificationItem,
  notificationCenterCss,
  notificationCenterScriptBody,
} from './notification-center.js'
import type { Notification } from '../notifications/types.js'

function mkNotif(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    userId: 'u1',
    kind: 'info',
    category: 'system',
    title: 'Welcome',
    message: 'Thanks for joining',
    read: false,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    shopId: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// notificationBellButton
// ---------------------------------------------------------------------------

describe('notificationBellButton', () => {
  it('renders a button with the bell icon', () => {
    const html = notificationBellButton()
    expect(html).toContain('<button')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('<svg')
  })

  it('uses default dialog id when none provided', () => {
    expect(notificationBellButton()).toContain('gbox-notif-dialog')
  })

  it('honors a custom dialog id', () => {
    expect(
      notificationBellButton({ dialogId: 'my-dlg' }),
    ).toContain('aria-controls="my-dlg"')
  })

  it('shows the unread badge when unread > 0', () => {
    const html = notificationBellButton({ unread: 3 })
    expect(html).toContain('gbox-notif-badge')
    expect(html).toContain('>3<')
  })

  it('caps the unread badge at 99+', () => {
    expect(notificationBellButton({ unread: 145 })).toContain('>99+<')
  })

  it('hides the badge when unread is 0', () => {
    const html = notificationBellButton({ unread: 0 })
    expect(html).toContain('hidden')
  })

  it('labels the button for screen readers', () => {
    expect(
      notificationBellButton({ label: 'Inbox' }),
    ).toContain('aria-label="Inbox"')
  })

  it('escapes the label', () => {
    const html = notificationBellButton({ label: '<b>x</b>' })
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&lt;b&gt;')
  })
})

// ---------------------------------------------------------------------------
// notificationItem
// ---------------------------------------------------------------------------

describe('notificationItem', () => {
  it('renders the title, time, and kind', () => {
    const html = notificationItem(mkNotif({ title: 'Order received' }))
    expect(html).toContain('Order received')
    expect(html).toContain('Info')
    expect(html).toContain('ago')
  })

  it('renders a link wrapper when link is provided', () => {
    const html = notificationItem(
      mkNotif({ link: '/orders/42' }),
    )
    expect(html).toContain('href="/orders/42"')
  })

  it('omits the link wrapper when absent', () => {
    const html = notificationItem(mkNotif({ link: undefined }))
    expect(html).not.toContain('href=')
  })

  it('applies the kind class', () => {
    expect(notificationItem(mkNotif({ kind: 'danger' }))).toContain(
      'gbox-notif-item-danger',
    )
    expect(notificationItem(mkNotif({ kind: 'success' }))).toContain(
      'gbox-notif-item-success',
    )
  })

  it('applies the read class when read is true', () => {
    expect(notificationItem(mkNotif({ read: true }))).toContain(
      'gbox-notif-item-read',
    )
  })

  it('escapes title, message, and link', () => {
    const html = notificationItem(
      mkNotif({
        title: '<script>bad</script>',
        message: '<img src=x>',
        link: '"><script>',
      }),
    )
    expect(html).not.toContain('<script>bad</script>')
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;script&gt;bad')
    expect(html).toContain('&lt;img')
  })

  it('renders "just now" when timestamp is fresh', () => {
    const html = notificationItem(
      mkNotif({ createdAt: new Date().toISOString() }),
    )
    expect(html).toContain('just now')
  })
})

// ---------------------------------------------------------------------------
// notificationDrawer
// ---------------------------------------------------------------------------

describe('notificationDrawer', () => {
  it('renders a <dialog> with labeled heading', () => {
    const html = notificationDrawer({ notifications: [], unread: 0 })
    expect(html).toContain('<dialog')
    expect(html).toContain('aria-labelledby=')
    expect(html).toContain('Notifications')
  })

  it('renders the empty state when no notifications', () => {
    const html = notificationDrawer({
      notifications: [],
      unread: 0,
    })
    expect(html).toContain('You&#39;re all caught up')
    expect(html).not.toContain('<ul')
  })

  it('lists notifications when provided', () => {
    const html = notificationDrawer({
      notifications: [
        mkNotif({ id: 'a', title: 'First' }),
        mkNotif({ id: 'b', title: 'Second' }),
      ],
      unread: 2,
    })
    expect(html).toContain('<ul')
    expect(html).toContain('First')
    expect(html).toContain('Second')
  })

  it('shows the Mark all as read button only when unread > 0', () => {
    const withUnread = notificationDrawer({
      notifications: [mkNotif()],
      unread: 1,
    })
    expect(withUnread).toContain('Mark all as read')

    const noUnread = notificationDrawer({
      notifications: [mkNotif({ read: true })],
      unread: 0,
    })
    expect(noUnread).not.toContain('Mark all as read')
  })

  it('includes the CSRF token when provided', () => {
    const html = notificationDrawer({
      notifications: [mkNotif()],
      unread: 1,
      csrfToken: 'abc123',
    })
    expect(html).toContain('name="csrf_token"')
    expect(html).toContain('value="abc123"')
  })

  it('renders the view-all footer when viewAllHref is set', () => {
    const html = notificationDrawer({
      notifications: [],
      unread: 0,
      viewAllHref: '/notifications',
    })
    expect(html).toContain('href="/notifications"')
    expect(html).toContain('View all')
  })

  it('honors custom dialogId', () => {
    const html = notificationDrawer({
      notifications: [],
      unread: 0,
      dialogId: 'my-dialog',
    })
    expect(html).toContain('id="my-dialog"')
    expect(html).toContain('aria-labelledby="my-dialog-title"')
  })

  it('honors custom heading and empty message', () => {
    const html = notificationDrawer({
      notifications: [],
      unread: 0,
      heading: 'Inbox',
      emptyMessage: 'Nothing to see',
    })
    expect(html).toContain('Inbox')
    expect(html).toContain('Nothing to see')
  })

  it('escapes the CSRF token', () => {
    const html = notificationDrawer({
      notifications: [mkNotif()],
      unread: 1,
      csrfToken: '"><script>',
    })
    expect(html).not.toContain('"><script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// notificationCenterCss / script
// ---------------------------------------------------------------------------

describe('notificationCenterCss', () => {
  it('defines core classes', () => {
    const css = notificationCenterCss()
    expect(css).toContain('.gbox-notif-bell')
    expect(css).toContain('.gbox-notif-badge')
    expect(css).toContain('.gbox-notif-dialog')
    expect(css).toContain('.gbox-notif-item')
  })

  it('styles the ::backdrop', () => {
    expect(notificationCenterCss()).toContain('::backdrop')
  })

  it('has different colors per kind', () => {
    const css = notificationCenterCss()
    expect(css).toContain('gbox-notif-item-info')
    expect(css).toContain('gbox-notif-item-success')
    expect(css).toContain('gbox-notif-item-warning')
    expect(css).toContain('gbox-notif-item-danger')
  })
})

describe('notificationCenterScriptBody', () => {
  it('wires open/close data attributes', () => {
    const js = notificationCenterScriptBody()
    expect(js).toContain('data-gbox-notif-open')
    expect(js).toContain('data-gbox-notif-close')
    expect(js).toContain('showModal')
    expect(js).toContain('close')
  })
})
