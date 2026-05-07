/**
 * Staff layout — supporter.gbox.co.
 *
 * Messenger-inspired two-pane shell: left sidebar (nav + presence),
 * right content area (page body). Dark mode by default to match the
 * seller widget's `#0084FF` accent. Keeps a minimal footprint — the
 * whole CSS is inlined to avoid a 2nd request on cold-cache.
 *
 * Callers import `staffLayout({ ... })` and pass the page body as a
 * raw HTML string. Internal APIs like `esc()` are exported for page
 * handlers that need to inline user-supplied data safely.
 *
 * Iron Rule 5: the layout NEVER mentions "god admin" in user-visible
 * text (even though this IS the internal portal). We use "Staff" +
 * preset labels ("L1 Support", "Lead Support", etc) because those
 * are less jargony if a screenshot ever escapes into the wild.
 */

import type { StaffRequestUser } from '@gbox/core/modules/support-staff/index.js'
import { PRESET_LABEL } from '@gbox/core/modules/support-staff/index.js'

export interface StaffLayoutParams {
  title: string
  /** Staff user; `null` on the login page (pre-auth). */
  user: StaffRequestUser | null
  /** Nav item currently highlighted: inbox | staff | settings | etc. */
  activePage?: 'inbox' | 'staff' | 'analytics' | 'canned' | 'settings' | 'none'
  /** Raw HTML to drop into the main content pane. */
  content: string
  /** Optional inline script appended before </body> — pages use this
   *  to wire small DOM handlers without a separate JS file. */
  inlineScript?: string
  /** Unread ticket count to show on the inbox badge. */
  inboxUnread?: number
  /** Optional flash message (shown at the top of the content pane). */
  flash?: { kind: 'ok' | 'warn' | 'err'; text: string } | null
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Render the complete `<html>...</html>` document for a supporter page.
 * The content area sits in a flex row with a 260px sidebar on the left.
 */
export function staffLayout(p: StaffLayoutParams): string {
  const title = esc(p.title)
  const userPane = p.user ? renderUser(p.user) : renderAnon()
  const sidebar = p.user ? renderSidebar(p.activePage ?? 'inbox', p.inboxUnread ?? 0) : ''
  const flash = p.flash ? renderFlash(p.flash) : ''
  const script = p.inlineScript ? `<script>${p.inlineScript}</script>` : ''

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Gbox Support</title>
<style>
  :root {
    --bg: #0b1220;
    --bg-elevated: #131c2e;
    --bg-hover: #1b2540;
    --border: #24304d;
    --text: #e6edf7;
    --text-muted: #93a3c2;
    --accent: #0084FF;
    --ok: #10b981;
    --warn: #f59e0b;
    --err: #ef4444;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .shell { display: flex; min-height: 100vh; }
  .sidebar {
    width: 260px;
    flex-shrink: 0;
    background: var(--bg-elevated);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }
  .brand {
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .brand-logo {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .brand-name {
    font-weight: 600;
    font-size: 15px;
    letter-spacing: 0.2px;
  }
  .brand-sub {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  nav.menu { padding: 12px 8px; flex: 1 1 auto; }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    margin-bottom: 2px;
    cursor: pointer;
  }
  .menu-item:hover { background: var(--bg-hover); text-decoration: none; }
  .menu-item.active { background: var(--bg-hover); color: var(--accent); font-weight: 600; }
  .menu-badge {
    margin-left: auto;
    background: var(--err);
    color: #fff;
    font-size: 11px;
    border-radius: 999px;
    padding: 2px 7px;
    font-weight: 600;
    min-width: 20px;
    text-align: center;
  }
  .menu-badge[data-count="0"] { display: none; }

  .user-pane {
    border-top: 1px solid var(--border);
    padding: 12px 14px;
  }
  .user-row { display: flex; align-items: center; gap: 10px; }
  .user-avatar {
    width: 34px; height: 34px; border-radius: 50%;
    background: linear-gradient(135deg, #5b6ef5, #a855f7);
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 600;
  }
  .user-name { font-size: 13px; font-weight: 600; }
  .user-role { font-size: 11px; color: var(--text-muted); }
  .logout-btn {
    margin-top: 8px;
    display: inline-block;
    font-size: 12px;
    color: var(--text-muted);
  }

  main.content { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  .page-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 24px; border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
  }
  .page-title { font-size: 18px; font-weight: 600; margin: 0; }
  .page-body { padding: 20px 24px; }

  .flash {
    padding: 10px 14px; border-radius: 8px;
    font-size: 13px; margin-bottom: 16px;
    display: flex; align-items: center; gap: 10px;
  }
  .flash-ok  { background: rgba(16,185,129,.12); color: var(--ok);   border: 1px solid rgba(16,185,129,.3); }
  .flash-warn { background: rgba(245,158,11,.12); color: var(--warn); border: 1px solid rgba(245,158,11,.3); }
  .flash-err  { background: rgba(239,68,68,.12);  color: var(--err);  border: 1px solid rgba(239,68,68,.3); }

  /* Tables for ticket queue + staff list. */
  .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .data-table th, .data-table td {
    text-align: left; padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  .data-table th { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .data-table tr:hover td { background: var(--bg-hover); }

  /* Buttons. */
  .btn {
    display: inline-block; padding: 8px 14px;
    background: var(--accent); color: #fff; border: 0;
    border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; text-decoration: none;
  }
  .btn:hover { opacity: .92; text-decoration: none; }
  .btn-secondary { background: var(--bg-hover); color: var(--text); }
  .btn-danger { background: var(--err); }

  /* Form controls. */
  input[type="text"], input[type="email"], input[type="password"], textarea, select {
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px;
    padding: 9px 12px; font-size: 14px; width: 100%;
    font-family: inherit;
  }
  input:focus, textarea:focus, select:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(0,132,255,.15);
  }
  label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; font-weight: 600; }

  /* Status + priority pills. */
  .pill { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .pill-open       { background: rgba(59,130,246,.2);  color: #60a5fa; }
  .pill-pending-s  { background: rgba(168,85,247,.2);  color: #c084fc; }
  .pill-pending-a  { background: rgba(245,158,11,.2);  color: #fbbf24; }
  .pill-resolved   { background: rgba(16,185,129,.2);  color: #34d399; }
  .pill-closed     { background: rgba(148,163,184,.2); color: #94a3b8; }
  .pill-urgent     { background: rgba(239,68,68,.2);   color: #f87171; }
  .pill-high       { background: rgba(245,158,11,.2);  color: #fbbf24; }
  .pill-normal     { background: rgba(59,130,246,.2);  color: #60a5fa; }
  .pill-low        { background: rgba(148,163,184,.2); color: #94a3b8; }

  @media (max-width: 760px) {
    .sidebar { width: 80px; }
    .brand-name, .brand-sub, .menu-item span, .user-name, .user-role { display: none; }
    .menu-item { justify-content: center; }
  }
</style>
</head>
<body>
<div class="shell">
  ${sidebar ? `<aside class="sidebar">${sidebar}<div class="user-pane">${userPane}</div></aside>` : ''}
  <main class="content">
    <header class="page-header">
      <h1 class="page-title">${title}</h1>
      ${p.user ? '' : '<a class="btn btn-secondary" href="/login">Sign in</a>'}
    </header>
    <div class="page-body">
      ${flash}
      ${p.content}
    </div>
  </main>
</div>
${script}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function renderUser(u: StaffRequestUser): string {
  const initials = u.displayName
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'G'
  const presetLabel = PRESET_LABEL[u.preset] ?? u.preset
  return `<div class="user-row">
    <div class="user-avatar">${esc(initials)}</div>
    <div>
      <div class="user-name">${esc(u.displayName)}</div>
      <div class="user-role">${esc(presetLabel)}</div>
    </div>
  </div>
  <form method="post" action="/logout" style="margin:0">
    <button type="submit" class="logout-btn" style="background:none;border:0;padding:0;cursor:pointer;color:var(--text-muted)">Sign out</button>
  </form>`
}

function renderAnon(): string {
  return `<div style="color:var(--text-muted);font-size:12px">Not signed in</div>`
}

function renderSidebar(active: StaffLayoutParams['activePage'], unread: number): string {
  const unreadStr = unread > 99 ? '99+' : String(unread)
  const items: Array<{ id: NonNullable<StaffLayoutParams['activePage']>; label: string; href: string; badge?: string }> = [
    { id: 'inbox', label: 'Inbox', href: '/inbox', badge: unreadStr },
    { id: 'canned', label: 'Canned replies', href: '/canned-replies' },
    { id: 'analytics', label: 'Analytics', href: '/analytics' },
    { id: 'staff', label: 'Staff', href: '/staff' },
    { id: 'settings', label: 'Profile', href: '/settings/profile' },
  ]
  const body = items
    .map((i) => {
      const cls = i.id === active ? 'menu-item active' : 'menu-item'
      const badge = i.badge
        ? `<span class="menu-badge" data-count="${esc(i.badge === '0' ? '0' : '1')}">${esc(i.badge)}</span>`
        : ''
      return `<a class="${cls}" href="${esc(i.href)}"><span>${esc(i.label)}</span>${badge}</a>`
    })
    .join('')
  return `<div class="brand">
    <div class="brand-logo">G</div>
    <div>
      <div class="brand-name">Gbox Support</div>
      <div class="brand-sub">Staff portal</div>
    </div>
  </div>
  <nav class="menu">${body}</nav>`
}

function renderFlash(flash: NonNullable<StaffLayoutParams['flash']>): string {
  const cls =
    flash.kind === 'ok' ? 'flash-ok' : flash.kind === 'warn' ? 'flash-warn' : 'flash-err'
  return `<div class="flash ${cls}">${esc(flash.text)}</div>`
}

// Exported for unit tests.
export const __testables = { esc, renderSidebar, renderFlash, renderUser, renderAnon }
