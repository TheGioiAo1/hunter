/**
 * Gbox Platform — Notification Center UI (Phase 2 Step 2.11)
 *
 * Pure HTML/CSS fragments for the persistent notification inbox that
 * lives in the admin topbar:
 *
 *   - `notificationBellButton()` — topbar trigger with an unread badge
 *   - `notificationDrawer()` — slide-in panel listing notifications
 *   - `notificationItem()` — single row with kind chip, title, body,
 *     relative time, and optional link
 *   - `notificationCenterCss()` — styles for everything above
 *   - `notificationCenterScriptBody()` — vanilla JS runtime that
 *     opens/closes the drawer, handles "Mark all as read", and fetches
 *     fresh rows from a user-provided endpoint
 *
 * Design choices
 * --------------
 * - The drawer is a native `<dialog>` so focus trapping + ESC-to-close
 *   are free and the panel is announced as a dialog by assistive tech.
 * - Unread count sits in a `<span aria-live="polite">` so screen
 *   readers re-announce when it changes.
 * - Mark-all-read is a POST form that falls back to a plain HTTP
 *   round-trip if the client JS hasn't booted yet (progressive
 *   enhancement — Iron Rule: admin MUST work without JS).
 */

import type {
  Notification,
  NotificationKind,
} from '../notifications/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function kindLabel(kind: NotificationKind): string {
  switch (kind) {
    case 'info':
      return 'Info'
    case 'success':
      return 'Success'
    case 'warning':
      return 'Warning'
    case 'danger':
      return 'Alert'
  }
}

// Re-implemented here — importing from `activity-timeline` would
// create a cross-module dependency we don't need.
function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return iso
  const diff = Math.floor((now.getTime() - then.getTime()) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return then.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Bell button
// ---------------------------------------------------------------------------

export interface NotificationBellOptions {
  /** Unread count (0 hides the badge). */
  unread?: number
  /** Element id for the dialog it should open. */
  dialogId?: string
  /** Button label for screen readers. */
  label?: string
}

export function notificationBellButton(
  opts: NotificationBellOptions = {},
): string {
  const unread = Math.max(0, Math.floor(opts.unread ?? 0))
  const dialogId = opts.dialogId ?? 'gbox-notif-dialog'
  const label = opts.label ?? 'Notifications'
  const badge =
    unread > 0
      ? `<span class="gbox-notif-badge" aria-live="polite">${unread > 99 ? '99+' : unread}</span>`
      : `<span class="gbox-notif-badge gbox-notif-badge-empty" aria-live="polite" hidden></span>`

  return `
    <button type="button"
            class="gbox-notif-bell"
            aria-label="${esc(label)}"
            aria-haspopup="dialog"
            aria-controls="${esc(dialogId)}"
            data-gbox-notif-open="${esc(dialogId)}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      ${badge}
    </button>
  `.trim()
}

// ---------------------------------------------------------------------------
// Notification item
// ---------------------------------------------------------------------------

export function notificationItem(n: Notification): string {
  const kindClass = `gbox-notif-item-${n.kind}`
  const readClass = n.read ? ' gbox-notif-item-read' : ''
  const linkOpen = n.link ? `<a href="${esc(n.link)}" class="gbox-notif-item-link">` : ''
  const linkClose = n.link ? `</a>` : ''
  const message = n.message
    ? `<p class="gbox-notif-item-msg">${esc(n.message)}</p>`
    : ''
  return `
    <li class="gbox-notif-item ${kindClass}${readClass}" data-notif-id="${esc(n.id)}">
      ${linkOpen}
      <div class="gbox-notif-item-body">
        <div class="gbox-notif-item-head">
          <span class="gbox-notif-item-kind">${esc(kindLabel(n.kind))}</span>
          <span class="gbox-notif-item-time">${esc(relativeTime(n.createdAt))}</span>
        </div>
        <h4 class="gbox-notif-item-title">${esc(n.title)}</h4>
        ${message}
      </div>
      ${linkClose}
    </li>
  `.trim()
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export interface NotificationDrawerOptions {
  /** Rows to render (typically the latest 20). */
  notifications: Notification[]
  /** Unread count (drives the "Mark all as read" button visibility). */
  unread: number
  /** Dialog element id (must match the button's aria-controls). */
  dialogId?: string
  /** Endpoint the form POSTs to when the user clicks "Mark all as read". */
  markAllReadAction?: string
  /** CSRF token embedded as a hidden field (recommended). */
  csrfToken?: string
  /** "View all" link to the full inbox page. */
  viewAllHref?: string
  /** Empty-state text when there are zero notifications. */
  emptyMessage?: string
  /** Heading text for the drawer (a11y). */
  heading?: string
}

export function notificationDrawer(opts: NotificationDrawerOptions): string {
  const {
    notifications,
    unread,
    dialogId = 'gbox-notif-dialog',
    markAllReadAction = '/notifications/read-all',
    csrfToken,
    viewAllHref,
    emptyMessage = "You're all caught up",
    heading = 'Notifications',
  } = opts

  const list =
    notifications.length === 0
      ? `<p class="gbox-notif-empty">${esc(emptyMessage)}</p>`
      : `<ul class="gbox-notif-list" role="list">${notifications
          .map(n => notificationItem(n))
          .join('')}</ul>`

  const csrfField = csrfToken
    ? `<input type="hidden" name="csrf_token" value="${esc(csrfToken)}" />`
    : ''

  const markAllReadButton =
    unread > 0
      ? `
      <form method="post" action="${esc(markAllReadAction)}" class="gbox-notif-mark-form">
        ${csrfField}
        <button type="submit" class="gbox-notif-mark-btn">Mark all as read</button>
      </form>`
      : ''

  const viewAllFooter = viewAllHref
    ? `<a class="gbox-notif-view-all" href="${esc(viewAllHref)}">View all</a>`
    : ''

  return `
    <dialog id="${esc(dialogId)}" class="gbox-notif-dialog" aria-labelledby="${esc(dialogId)}-title">
      <header class="gbox-notif-header">
        <h3 id="${esc(dialogId)}-title" class="gbox-notif-title">${esc(heading)}</h3>
        <button type="button"
                class="gbox-notif-close"
                aria-label="Close"
                data-gbox-notif-close="${esc(dialogId)}">×</button>
      </header>
      <div class="gbox-notif-toolbar">
        ${markAllReadButton}
      </div>
      <div class="gbox-notif-body">
        ${list}
      </div>
      <footer class="gbox-notif-footer">
        ${viewAllFooter}
      </footer>
    </dialog>
  `.trim()
}

// ---------------------------------------------------------------------------
// Runtime script
// ---------------------------------------------------------------------------

/**
 * Minimal runtime: wires `[data-gbox-notif-open]` buttons to call
 * `dialog.showModal()` on the matching `<dialog>`, and
 * `[data-gbox-notif-close]` buttons to call `dialog.close()`. Also
 * closes when the user clicks outside the dialog content.
 *
 * Returns a plain function body (no `<script>` tags) so layouts can
 * wrap it themselves and stay CSP-aware.
 */
export function notificationCenterScriptBody(): string {
  return `
    (function () {
      function openDialog(id) {
        var dlg = document.getElementById(id);
        if (dlg && typeof dlg.showModal === 'function') {
          dlg.showModal();
        }
      }
      function closeDialog(id) {
        var dlg = document.getElementById(id);
        if (dlg && typeof dlg.close === 'function') {
          dlg.close();
        }
      }
      document.addEventListener('click', function (e) {
        var target = e.target;
        if (!(target instanceof Element)) return;
        var opener = target.closest('[data-gbox-notif-open]');
        if (opener) {
          e.preventDefault();
          openDialog(opener.getAttribute('data-gbox-notif-open'));
          return;
        }
        var closer = target.closest('[data-gbox-notif-close]');
        if (closer) {
          e.preventDefault();
          closeDialog(closer.getAttribute('data-gbox-notif-close'));
          return;
        }
      });
      // Click-outside to close: dialog.showModal() adds ::backdrop,
      // so a click whose target IS the dialog element means the user
      // hit the backdrop (the content lives inside children).
      document.addEventListener('click', function (e) {
        var target = e.target;
        if (target instanceof HTMLDialogElement && target.classList.contains('gbox-notif-dialog')) {
          var rect = target.getBoundingClientRect();
          var inside =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom;
          if (!inside) target.close();
        }
      });
    })();
  `.trim()
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

export function notificationCenterCss(): string {
  return `
    .gbox-notif-bell {
      position: relative;
      background: transparent;
      border: none;
      color: var(--god-text, #111);
      cursor: pointer;
      padding: 6px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .gbox-notif-bell:hover {
      background: var(--god-bg-muted, #f3f4f6);
    }
    .gbox-notif-badge {
      position: absolute;
      top: 2px;
      right: 2px;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      background: var(--god-danger, #ef4444);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .gbox-notif-badge-empty[hidden] {
      display: none;
    }
    .gbox-notif-dialog {
      width: min(420px, calc(100vw - 32px));
      max-height: min(640px, calc(100vh - 80px));
      padding: 0;
      border: 1px solid var(--god-border, #d1d5db);
      border-radius: 10px;
      background: var(--god-bg, #fff);
      color: var(--god-text, #111);
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.18);
      overflow: hidden;
    }
    .gbox-notif-dialog::backdrop {
      background: rgba(0, 0, 0, 0.25);
    }
    .gbox-notif-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid var(--god-border, #e5e7eb);
    }
    .gbox-notif-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }
    .gbox-notif-close {
      background: transparent;
      border: none;
      font-size: 24px;
      line-height: 1;
      color: var(--god-text-muted, #6b7280);
      cursor: pointer;
      padding: 0 4px;
    }
    .gbox-notif-close:hover {
      color: var(--god-text, #111);
    }
    .gbox-notif-toolbar {
      padding: 8px 16px;
      border-bottom: 1px solid var(--god-border, #f3f4f6);
      min-height: 12px;
    }
    .gbox-notif-mark-btn {
      background: transparent;
      border: none;
      color: var(--god-accent, #3b82f6);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
    }
    .gbox-notif-mark-btn:hover {
      text-decoration: underline;
    }
    .gbox-notif-body {
      overflow-y: auto;
      max-height: 480px;
    }
    .gbox-notif-empty {
      padding: 32px 16px;
      text-align: center;
      color: var(--god-text-muted, #6b7280);
      font-size: 14px;
    }
    .gbox-notif-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .gbox-notif-item {
      border-bottom: 1px solid var(--god-border, #f3f4f6);
      position: relative;
    }
    .gbox-notif-item:last-child {
      border-bottom: none;
    }
    .gbox-notif-item::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
    }
    .gbox-notif-item-info::before    { background: #3b82f6; }
    .gbox-notif-item-success::before { background: #22c55e; }
    .gbox-notif-item-warning::before { background: #f59e0b; }
    .gbox-notif-item-danger::before  { background: #ef4444; }
    .gbox-notif-item-read {
      opacity: 0.55;
    }
    .gbox-notif-item-link {
      display: block;
      padding: 12px 16px 12px 20px;
      text-decoration: none;
      color: inherit;
    }
    .gbox-notif-item-link:hover {
      background: var(--god-bg-muted, #f9fafb);
    }
    .gbox-notif-item-body {
      padding: 12px 16px 12px 20px;
    }
    .gbox-notif-item-link .gbox-notif-item-body {
      padding: 0;
    }
    .gbox-notif-item-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .gbox-notif-item-kind {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--god-text-muted, #6b7280);
    }
    .gbox-notif-item-time {
      font-size: 11px;
      color: var(--god-text-muted, #9ca3af);
    }
    .gbox-notif-item-title {
      margin: 0 0 2px 0;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.35;
    }
    .gbox-notif-item-msg {
      margin: 2px 0 0 0;
      font-size: 12px;
      color: var(--god-text-muted, #6b7280);
      line-height: 1.45;
    }
    .gbox-notif-footer {
      padding: 10px 16px;
      border-top: 1px solid var(--god-border, #f3f4f6);
      text-align: center;
    }
    .gbox-notif-view-all {
      font-size: 13px;
      color: var(--god-accent, #3b82f6);
      text-decoration: none;
      font-weight: 500;
    }
    .gbox-notif-view-all:hover {
      text-decoration: underline;
    }
  `
}
