/**
 * Gbox Seller Dashboard — Professional Dark Layout
 *
 * Dark theme with indigo accent (#6366f1)
 * Light/dark mode toggle (cookie-based)
 * Sidebar: 12 groups (A-L)
 * AI Panel: 360px right
 * Audit: every action logged to god admin
 *
 * Phase 2 Step 2.1:
 *   - Theme auto-resolves from the `gbox_theme` cookie when the caller
 *     doesn't pass an explicit `theme` (prevents flash-of-wrong-theme
 *     after a page reload).
 *   - `themeInitScript()` is injected in <head> as a belt-and-suspenders
 *     fallback: even if SSR guesses wrong it corrects before first paint.
 *   - Toggle button + cookie write path now share the canonical helper
 *     from `@gbox/core/modules/ui` so store-admin and god-admin stay in
 *     sync (same cookie name, same max-age, same SameSite).
 */

import {
  readThemeFromCookieHeader,
  themeInitScript,
  type Theme,
} from '../../../../packages/core/src/modules/ui/theme.js'
import { emptyStateCss } from '../../../../packages/core/src/modules/ui/empty-state.js'
import { skeletonCss } from '../../../../packages/core/src/modules/ui/skeleton.js'
import {
  flashContainerHtml,
  toastRuntimeScriptBody,
  toastCss,
} from '../../../../packages/core/src/modules/ui/toast.js'
import {
  modal,
  modalRuntimeScriptBody,
  modalCss,
} from '../../../../packages/core/src/modules/ui/modal.js'
import { paginationCss } from '../../../../packages/core/src/modules/ui/pagination.js'
import { filterBarCss } from '../../../../packages/core/src/modules/ui/filter-bar.js'
import {
  bulkRuntimeScriptBody,
  bulkActionsCss,
} from '../../../../packages/core/src/modules/ui/bulk-actions.js'
import {
  commandPaletteHtml,
  keyboardShortcutsHtml,
  keyboardRuntimeScriptBody,
  keyboardCss,
  type CommandItem,
  type KeyboardShortcut,
  type ChordBinding,
  type SingleKeyBinding,
} from '../../../../packages/core/src/modules/ui/keyboard.js'
import { activityTimelineCss } from '../../../../packages/core/src/modules/ui/activity-timeline.js'
import {
  skipToMainLink,
  ariaCurrent,
  a11yCss,
} from '../../../../packages/core/src/modules/ui/a11y.js'
import { formFieldCss } from '../../../../packages/core/src/modules/ui/form-field.js'
import {
  notificationCenterCss,
  notificationCenterScriptBody,
} from '../../../../packages/core/src/modules/ui/notification-center.js'
import { errorPageCss } from '../../../../packages/core/src/modules/ui/error-page.js'
import { supportWidgetHtml } from '../components/support-widget.js'

export interface SellerLayoutOptions {
  title: string
  storeName: string
  storeSlug: string
  userName: string
  userEmail: string
  userRole: string       // owner | admin | staff
  storeRole: string      // owner | admin | editor | viewer
  activePage: string
  content: string
  aiPanel?: string
  /** 'dark' | 'light' — default: read from cookieHeader, then 'dark'. */
  theme?: Theme
  /**
   * Raw `Cookie` request header. When present and `theme` is not set,
   * the layout reads the persisted `gbox_theme` value so the initial
   * SSR render matches what the user picked last time.
   */
  cookieHeader?: string | null
  /**
   * 2026-04-26: Clone Pro re-scoped to god-admin-only concierge tooling.
   * Field kept for backwards compatibility with existing callers but
   * ignored — sellers no longer have a Clone Pro nav entry.
   * @deprecated Will be removed once all callers are updated.
   */
  activeCloneJobs?: number
  /**
   * Keyboard-shortcut scope for the current page. Set on
   * `<body data-kbd-scope="...">` so the keyboard runtime knows which
   * chords/single-keys should fire. Omit on pages without scoped shortcuts.
   */
  kbdScope?: string
}

export function sellerLayout(opts: SellerLayoutOptions): string {
  const {
    title,
    storeName,
    storeSlug,
    userName,
    userEmail,
    userRole,
    storeRole,
    activePage,
    content,
    aiPanel,
  } = opts

  // Phase 2 Step 2.1: if the caller didn't pass an explicit theme, try
  // to derive it from the Cookie header. This keeps existing callers
  // (which pass `theme: 'dark'` directly) working unchanged while
  // letting new callers pass `cookieHeader` and skip the manual read.
  const theme: Theme =
    opts.theme ?? readThemeFromCookieHeader(opts.cookieHeader ?? null)

  const base = `/admin/store/${esc(storeSlug)}`

  // Accounts portal base URL for cross-app navigation
  // Prod fallback = '' → links thành relative ('/accounts/...') → same-origin
  // (admin.gbox.co/accounts/* qua nginx path routing). Single-domain deploy
  // không phụ thuộc ACCOUNTS_BASE_URL.
  const accountsBase = process.env.ACCOUNTS_BASE_URL
    || (process.env.NODE_ENV === 'production'
      ? ''
      : `http://localhost:${process.env.ACCOUNTS_PORT || '4323'}`)

  const navGroups = buildNav(base, activePage, storeRole)

  // Phase 2 Step 2.6 — per-store command palette. Commands are built
  // inside the render fn so hrefs carry the current store slug. The
  // list is intentionally conservative (Shopify-grade "jump to" only);
  // destructive actions never go in the palette.
  const storeCommands: CommandItem[] = [
    { id: 'nav-home', label: 'Home', href: `${base}`, group: 'Navigation', shortcut: 'g h' },
    { id: 'nav-orders', label: 'Orders', href: `${base}/orders`, group: 'Navigation', shortcut: 'g o' },
    { id: 'nav-draft-orders', label: 'Draft orders', href: `${base}/orders/drafts`, group: 'Navigation' },
    { id: 'nav-abandoned', label: 'Abandoned checkouts', href: `${base}/orders/abandoned`, group: 'Navigation' },
    // Fulfillment is centralized in god admin → Lenful (Phase F0). Nav entry removed.
    { id: 'nav-products', label: 'Products', href: `${base}/products`, group: 'Navigation', shortcut: 'g p', keywords: ['inventory', 'catalog'] },
    { id: 'nav-collections', label: 'Collections', href: `${base}/products/collections`, group: 'Navigation' },
    { id: 'nav-customers', label: 'Customers', href: `${base}/customers`, group: 'Navigation', shortcut: 'g c', keywords: ['buyers'] },
    { id: 'nav-analytics', label: 'Analytics', href: `${base}/analytics`, group: 'Navigation', shortcut: 'g a', keywords: ['reports', 'metrics'] },
    { id: 'nav-analytics-traffic', label: 'Traffic sources', href: `${base}/analytics/traffic`, group: 'Navigation', keywords: ['utm', 'sources', 'channels'] },
    { id: 'nav-analytics-funnel', label: 'Conversion funnel', href: `${base}/analytics/funnel`, group: 'Navigation', keywords: ['funnel', 'conversion', 'drop-off'] },
    { id: 'nav-analytics-attribution', label: 'UTM attribution', href: `${base}/analytics/attribution`, group: 'Navigation', keywords: ['attribution', 'utm', 'campaign'] },
    { id: 'nav-analytics-cohort', label: 'Cohort retention', href: `${base}/analytics/cohort`, group: 'Navigation', keywords: ['cohort', 'retention', 'repeat'] },
    // Phase 14 PR4 — email open/click analytics. Keyword coverage
    // mirrors the search terms sellers will actually type: "emails",
    // "opens", "clicks", "bounce", plus the generic "deliverability"
    // which sellers unfamiliar with the per-template report often
    // reach for.
    { id: 'nav-email-analytics', label: 'Email analytics', href: `${base}/reports/email-analytics`, group: 'Navigation', keywords: ['emails', 'opens', 'clicks', 'bounce', 'deliverability', 'marketing', 'campaigns'] },
    // Phase 14 PR4.B — email suppressions (bounce / complaint blocklist).
    // Keywords cover how sellers actually describe the problem: "my VIP
    // can't get emails", "blocked", "spam", "unsubscribe admin". The word
    // "unsubscribe" overlaps with the customer-facing unsubscribe page
    // intentionally — sellers searching that term want to unblock.
    { id: 'nav-email-suppressions', label: 'Email suppressions', href: `${base}/settings/email-suppressions`, group: 'Navigation', keywords: ['bounces', 'complaints', 'blocked', 'deliverability', 'suppressed', 'unsubscribe', 'spam'] },
    { id: 'nav-marketing', label: 'Marketing', href: `${base}/marketing`, group: 'Navigation', shortcut: 'g m' },
    { id: 'nav-discounts', label: 'Discounts', href: `${base}/discounts`, group: 'Navigation', shortcut: 'g d', keywords: ['coupons', 'promos'] },
    { id: 'nav-content', label: 'Content', href: `${base}/content`, group: 'Navigation', keywords: ['pages', 'blogs'] },
    { id: 'nav-settings', label: 'Settings', href: `${base}/settings`, group: 'Navigation', shortcut: 'g s', keywords: ['preferences'] },
    { id: 'nav-online-store', label: 'Online store', href: `${base}/online-store`, group: 'Navigation', keywords: ['themes', 'storefront'] },
    // Visual theme customizer — `g e` jumps via storeGoBindings to the
    // entry-point handler that resolves the seller's main theme and
    // 302s onward.
    { id: 'nav-theme-editor', label: 'Theme editor', href: `${base}/online-store/theme-editor`, group: 'Navigation', shortcut: 'g e', keywords: ['theme', 'editor', 'customize', 'sections', 'design'] },
    // 2026-04-26: Clone Pro nav + 'New clone' action removed — clone is
    // god-admin-only concierge tooling. Sellers contact support if they
    // want a storefront cloned. (Iron Rule 5.)
    { id: 'nav-inventory', label: 'Inventory', href: `${base}/products/inventory`, group: 'Navigation', keywords: ['stock'] },
    { id: 'nav-gift-cards', label: 'Gift cards', href: `${base}/products/gift-cards`, group: 'Navigation' },
    // Phase 10 PR4 — expose reviews in the command palette so 'reviews',
    // 'moderation', 'profanity' all jump to the right place. The
    // settings entry gets its own keyword bundle so sellers searching
    // for 'profanity' land on the settings screen, not the queue.
    { id: 'nav-reviews', label: 'Reviews', href: `${base}/products/reviews`, group: 'Navigation', keywords: ['reviews', 'moderation', 'ratings'] },
    { id: 'nav-review-settings', label: 'Review settings', href: `${base}/products/reviews/settings`, group: 'Navigation', keywords: ['profanity', 'filter', 'reviews', 'notifications'] },
    { id: 'act-add-product', label: 'Add product', href: `${base}/products/new`, group: 'Actions', keywords: ['create product', 'new product'] },
    { id: 'act-add-discount', label: 'Create discount', href: `${base}/discounts/new`, group: 'Actions', keywords: ['coupon', 'promo'] },
    { id: 'act-add-page', label: 'Add page', href: `${base}/online-store/pages/new`, group: 'Actions', keywords: ['create page'] },
    { id: 'act-add-blog', label: 'Add blog post', href: `${base}/online-store/blog/new`, group: 'Actions', keywords: ['create blog'] },
    // Phase 12.5 PR2 — surface Support in the command palette so
    // sellers jumping with ⌘K can type "support", "ticket", "help",
    // or "contact" and land on the inbox. Also registers an action
    // entry for "New ticket" so sellers can kick off a new ticket
    // without going through the inbox page first.
    { id: 'nav-support', label: 'Support', href: `${base}/support`, group: 'Navigation', keywords: ['support', 'help', 'ticket', 'contact', 'gbox'] },
    { id: 'act-new-ticket', label: 'New support ticket', href: `${base}/support/new`, group: 'Actions', keywords: ['help', 'contact', 'new ticket'] },
    { id: 'act-switch-store', label: 'Switch store', href: '/accounts/stores', group: 'Account' },
    { id: 'act-account', label: 'Account settings', href: '/accounts/account', group: 'Account' },
    { id: 'act-logout', label: 'Log out', href: '/accounts/logout', group: 'Account' },
  ]

  const storeShortcuts: KeyboardShortcut[] = [
    { keys: '⌘ K', description: 'Open command palette', group: 'General' },
    { keys: 'Ctrl K', description: 'Open command palette (Windows/Linux)', group: 'General' },
    { keys: '?', description: 'Show keyboard shortcuts', group: 'General' },
    { keys: 'Esc', description: 'Close palette or modal', group: 'General' },
    { keys: 'g h', description: 'Go to Home', group: 'Navigation' },
    { keys: 'g o', description: 'Go to Orders', group: 'Navigation' },
    { keys: 'g p', description: 'Go to Products', group: 'Navigation' },
    { keys: 'g c', description: 'Go to Customers', group: 'Navigation' },
    { keys: 'g a', description: 'Go to Analytics', group: 'Navigation' },
    { keys: 'g m', description: 'Go to Marketing', group: 'Navigation' },
    { keys: 'g d', description: 'Go to Discounts', group: 'Navigation' },
    { keys: 'g e', description: 'Go to Theme editor', group: 'Navigation' },
    { keys: 'g s', description: 'Go to Settings', group: 'Navigation' },
    { keys: '↑', description: 'Move selection up (palette)', group: 'Palette' },
    { keys: '↓', description: 'Move selection down (palette)', group: 'Palette' },
    { keys: 'Enter', description: 'Select current result', group: 'Palette' },
  ]

  const storeGoBindings: Record<string, string> = {
    h: `${base}`,
    o: `${base}/orders`,
    p: `${base}/products`,
    c: `${base}/customers`,
    a: `${base}/analytics`,
    m: `${base}/marketing`,
    d: `${base}/discounts`,
    // 'g e' → Theme editor entry-point. The 'e' mnemonic stays open
    // for theme-only intent; settings are 's', online-store is 'g'-only.
    e: `${base}/online-store/theme-editor`,
    s: `${base}/settings`,
  }

  // 2026-04-26: Clone Pro chord + single-key shortcuts removed (clone
  // is god-admin-only concierge tooling — sellers no longer have those
  // pages, so binding 'n' / 'c p' / 'c d' would fire on stale scopes).
  const storeChords: ChordBinding[] = []
  const storeSingleKeys: SingleKeyBinding[] = []
  const initials = userName.charAt(0).toUpperCase()
  const roleBadge = storeRole === 'owner'
    ? '<span class="role-badge role-owner">Owner</span>'
    : storeRole === 'admin'
    ? '<span class="role-badge role-admin">Admin</span>'
    : '<span class="role-badge role-staff">Staff</span>'

  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — ${esc(storeName)} — Gbox</title>
  ${themeInitScript()}
  ${SELLER_STYLES}
  <style>
    /* Phase 2 Step 2.2: shared empty state + skeleton CSS inlined so
       every store-admin page can use them without another stylesheet
       round-trip. Tokens resolve via the dark/light data-theme scope
       defined in SELLER_STYLES above.

       Phase 2 Step 2.3: toast + modal CSS follow the same inlining
       pattern so every page gets consistent flash notifications and
       confirmation dialogs. Alias --god-success for toast borders. */
    :root, [data-theme="dark"], [data-theme="light"] {
      --god-success: var(--s-success);
      --god-bg: var(--s-bg);
    }
    ${emptyStateCss()}
    ${skeletonCss()}
    ${toastCss()}
    ${modalCss()}
    ${paginationCss()}
    ${filterBarCss()}
    ${bulkActionsCss()}
    ${keyboardCss()}
    ${activityTimelineCss()}
    ${a11yCss()}
    ${formFieldCss()}
    ${notificationCenterCss()}
    ${errorPageCss()}
  </style>
</head>
<body${opts.kbdScope ? ` data-kbd-scope="${esc(opts.kbdScope)}"` : ''}>
  <!-- Phase 2 Step 2.8: WCAG 2.4.1 Skip to main content link. -->
  ${skipToMainLink('main-content')}

  <!-- SIDEBAR -->
  <aside class="sidebar" id="sidebar">
    <button type="button" class="sidebar-header" id="sidebarStoreSwitcher" aria-haspopup="menu" aria-expanded="false" title="Switch store">
      <div class="store-logo">${esc(storeName.charAt(0).toUpperCase())}</div>
      <div class="store-info">
        <div class="store-name">${esc(storeName)}</div>
        <div class="store-plan">Basic plan</div>
      </div>
      <span class="sidebar-header-arrow">${ICON_CHEVRON_DOWN}</span>
    </button>
    <div class="store-switcher-menu" id="sidebarStoreMenu" role="menu" hidden>
      <div class="store-switcher-loading">Loading stores…</div>
    </div>
    <nav class="sidebar-nav">
      ${navGroups}
    </nav>
    <div class="sidebar-footer">
      <a href="${esc(accountsBase)}/accounts/stores" class="nav-item">
        ${ICON_SWITCH}
        <span class="nav-label">Switch store</span>
      </a>
    </div>
  </aside>

  <!-- MAIN -->
  <main class="main-area" id="main-content" tabindex="-1">
    <!-- TOP BAR -->
    <header class="topbar">
      <button class="topbar-toggle" onclick="document.getElementById('sidebar').classList.toggle('open')" aria-label="Menu">
        ${ICON_MENU}
      </button>
      <div class="topbar-search" id="searchTrigger" onclick="document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true}))">
        <span class="search-icon-wrap">${ICON_SEARCH}</span>
        <span class="search-placeholder">Search</span>
        <span class="search-shortcut">Ctrl K</span>
      </div>
      <div class="topbar-actions">
        <button class="topbar-btn" id="themeToggle" title="Toggle theme" aria-label="Toggle theme">
          <span id="themeIconSun" style="${theme === 'dark' ? '' : 'display:none'}"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4"/></svg></span>
          <span id="themeIconMoon" style="${theme === 'light' ? '' : 'display:none'}"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17.3 14.2A7.5 7.5 0 015.8 2.7 7.5 7.5 0 1017.3 14.2z"/></svg></span>
        </button>
        <button class="topbar-btn" id="aiToggle" title="AI Assistant" aria-label="Toggle AI assistant">
          ${ICON_AI}
        </button>
        <button class="topbar-btn" title="Notifications" id="notifToggle" aria-label="Notifications">
          ${ICON_BELL}
          <span class="notif-dot" id="notifDot" style="display:none"></span>
        </button>
        <!-- Notification Drawer -->
        <div class="notif-drawer" id="notifDrawer" style="display:none">
          <div class="notif-drawer-header">
            <span class="notif-drawer-title">Notifications</span>
            <div class="notif-drawer-actions">
              <!-- April 2026: explicit "mark all as read" gesture next to
                   the implicit open-to-clear behaviour, so sellers who
                   like the Shopify/Linear muscle memory have a button
                   to point at. Hidden until loadNotifications() sees
                   unreadCount > 0 so a zero-inbox drawer stays clean. -->
              <button type="button" class="notif-mark-all" id="notifMarkAll" style="display:none">Mark all as read</button>
              <button class="notif-drawer-close" id="notifClose" aria-label="Close notifications">&times;</button>
            </div>
          </div>
          <div class="notif-drawer-body" id="notifList">
            <div class="notif-loading">Loading...</div>
          </div>
          <div class="notif-drawer-footer">
            <a href="${base}/settings/activity">View all activity</a>
          </div>
        </div>
        <div class="topbar-user" id="userMenu">
          <div class="user-avatar">${initials}</div>
          <div class="user-dropdown" id="userDropdown">
            <div class="dd-header">
              <div class="dd-name">${esc(userName)}</div>
              <div class="dd-email">${esc(userEmail)}</div>
              <div style="margin-top:4px">${roleBadge}</div>
            </div>
            <div class="dd-divider"></div>
            <a href="${esc(accountsBase)}/accounts/account" class="dd-item">Account settings</a>
            <a href="${esc(accountsBase)}/accounts/stores" class="dd-item">All stores</a>
            <div class="dd-divider"></div>
            <a href="${esc(accountsBase)}/accounts/logout" class="dd-item dd-danger">Log out</a>
          </div>
        </div>
      </div>
    </header>

    <!-- CONTENT -->
    <div class="content-area${aiPanel ? ' with-ai' : ''}" id="contentArea">
      <!-- Phase D (2026-04-18) — Onboarding Resume-setup banner slot.
           The onboarding-banner middleware string-replaces this comment
           with banner HTML when res.locals.showOnboardingBanner is set
           (by the onboarding-gate middleware for skipped-state shops).
           Sits INSIDE .content-area so it scrolls with the page grid
           but OUTSIDE the per-page content block so page JS can't
           accidentally remove it. -->
      <!--GBOX_ONBOARDING_BANNER_SLOT-->
      ${content}
    </div>

    <!-- AI ASSISTANT PANEL -->
    <aside class="ai-panel" id="aiPanel" style="${aiPanel ? '' : 'display:none'}">
      <div class="ai-header">
        <span class="ai-title">${ICON_AI} Gbox AI</span>
        <button class="ai-close" id="aiCloseBtn" aria-label="Close AI panel">&times;</button>
      </div>
      <div class="ai-body" id="aiBody">
        ${aiPanel || renderDefaultAI(storeName)}
      </div>
      <div class="ai-input-area">
        <input type="text" id="aiInput" placeholder="Ask AI about your store..." aria-label="Ask AI about your store">
        <button id="aiSendBtn" class="ai-send" aria-label="Send message to AI">${ICON_SEND}</button>
      </div>
    </aside>
  </main>

  <!-- Phase 2 Step 2.3: shared flash/toast container + modal runtime. -->
  ${flashContainerHtml()}

  <!-- Phase 2 Step 2.6: command palette (Cmd+K) + shortcuts cheatsheet (?). -->
  ${commandPaletteHtml({ placeholder: 'Jump to a page or action...' })}
  ${modal({
    id: 'gboxShortcutsModal',
    title: 'Keyboard shortcuts',
    description: 'Press ⌘K / Ctrl+K to open the command palette.',
    body: keyboardShortcutsHtml(storeShortcuts),
    actions: [{ label: 'Close', kind: 'primary', close: true }],
  })}

  <script>
    ${toastRuntimeScriptBody()}
    ${modalRuntimeScriptBody()}
    ${bulkRuntimeScriptBody()}
    ${keyboardRuntimeScriptBody({
      commands: storeCommands,
      shortcutsModalId: 'gboxShortcutsModal',
      goToBindings: storeGoBindings,
      chords: storeChords,
      singleKeys: storeSingleKeys,
    })}
    ${notificationCenterScriptBody()}
    ${csrfAutoRefreshScriptBody(storeSlug)}
    ${storeSwitcherScriptBody(storeSlug)}
  </script>

  ${SELLER_SCRIPTS(storeSlug)}

  <!-- Phase 12.5 PR2 — floating Gbox support launcher (bottom-right).
       Drops a Messenger-style button on every seller page with a live
       unread badge. Polls /support/api/unread every 3s. -->
  ${supportWidgetHtml({ base })}
</body>
</html>`
}

/**
 * Global CSRF auto-refresh — chống "Invalid or expired form submission" 403.
 *
 * Mọi <form method="POST"> trên trang sẽ được intercept submit:
 * 1. Fetch fresh CSRF token từ /admin/store/:slug/csrf-refresh
 * 2. Update tất cả input[name="_csrf"] trong form bằng token mới
 * 3. Tiếp tục submit form
 *
 * Skip cho:
 * - Form opt-out: <form data-no-csrf-refresh>
 * - Form đang busy (đã submit lần trước, đang chờ response)
 * - Form không có _csrf field (BE không yêu cầu)
 *
 * Nguyên nhân 403 mà fix này xử lý:
 * - Form mở > 1h → token TTL hết hạn
 * - Server restart giữa lúc form mở → Redis empty → secret mất
 * - Multi-tab race với rotated cookie
 */
function csrfAutoRefreshScriptBody(storeSlug: string): string {
  return `
    (function(){
      var REFRESH_URL = '/admin/store/' + ${JSON.stringify(storeSlug)} + '/csrf-refresh';
      var IN_FLIGHT = new WeakSet();

      async function refreshAndSubmit(form){
        if (IN_FLIGHT.has(form)) return;
        IN_FLIGHT.add(form);
        try {
          var r = await fetch(REFRESH_URL, { credentials: 'same-origin', headers: { accept: 'application/json' } });
          if (r.ok) {
            var data = await r.json();
            if (data && data.token) {
              form.querySelectorAll('input[name="_csrf"]').forEach(function(el){ el.value = data.token; });
            }
          }
        } catch (e) {
          console.warn('[csrf-refresh] failed, submitting with stale token', e);
        }
        // Submit qua HTMLFormElement.prototype.submit để tránh re-trigger event listener.
        HTMLFormElement.prototype.submit.call(form);
      }

      document.addEventListener('submit', function(ev){
        var form = ev.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (form.method.toLowerCase() !== 'post') return;
        if (form.hasAttribute('data-no-csrf-refresh')) return;
        // Form không có _csrf field → BE không yêu cầu (ví dụ JSON API form), skip.
        if (!form.querySelector('input[name="_csrf"]')) return;
        if (IN_FLIGHT.has(form)) return;

        ev.preventDefault();
        refreshAndSubmit(form);
      }, true); // capture phase — intercept TRƯỚC mọi submit handler khác
    })();
  `
}

/**
 * Sidebar store-switcher dropdown — toggle on click, lazy-fetch list từ
 * /admin/store/<slug>/api/my-stores. Click outside → close.
 */
function storeSwitcherScriptBody(storeSlug: string): string {
  return `
    (function(){
      var btn = document.getElementById('sidebarStoreSwitcher');
      var menu = document.getElementById('sidebarStoreMenu');
      if (!btn || !menu) return;
      var FETCHED = false;
      var API_URL = '/admin/store/' + ${JSON.stringify(storeSlug)} + '/api/my-stores';

      function escH(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }

      function open(){
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        if (!FETCHED) { FETCHED = true; loadStores(); }
      }
      function close(){
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }

      async function loadStores(){
        try {
          var r = await fetch(API_URL, { credentials: 'same-origin', headers: { accept: 'application/json' } });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var data = await r.json();
          renderStores(data.stores || []);
        } catch (err) {
          menu.innerHTML = '<div class="store-switcher-loading" style="color:#fca5a5">Failed to load stores: ' + escH(err && err.message) + '</div>';
        }
      }

      function renderStores(stores){
        if (!stores.length) {
          menu.innerHTML = '<div class="store-switcher-loading">No stores found</div>';
          return;
        }
        // Inline icons (svg). Avoid extra HTTP for icon font/sprite.
        var ICON_OPEN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
        var ICON_SWITCH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
        var rows = stores.map(function(s){
          var initial = (s.name && s.name.charAt(0).toUpperCase()) || '?';
          var cls = s.isActive ? 'store-switcher-item active' : 'store-switcher-item';
          var dotClass = s.isOnline ? 'store-switcher-dot online' : 'store-switcher-dot offline';
          var dotTitle = s.isOnline ? 'Online' : 'Offline';
          var domain = s.privateDomain || s.publicDomain || '';
          var domainHtml = domain
            ? escH(domain)
            : '<em style="font-style:italic;color:#64748b">no domain</em>';
          var openBtn = domain
            ? '<a class="store-switcher-icon-btn" href="https://' + escH(domain) + '" target="_blank" rel="noopener" title="Open store" aria-label="Open store">' + ICON_OPEN + '</a>'
            : '<span class="store-switcher-icon-btn disabled" title="No domain" aria-label="No domain">' + ICON_OPEN + '</span>';
          var switchBtn = s.isActive
            ? ''
            : '<a class="store-switcher-icon-btn primary" href="/admin/store/' + encodeURIComponent(s.id) + '" title="Switch to this store" aria-label="Switch to this store">' + ICON_SWITCH + '</a>';
          return '<div class="' + cls + '" role="menuitem">'
            + '<div class="store-switcher-avatar">' + escH(initial) + '</div>'
            + '<div class="store-switcher-info">'
            +   '<div class="store-switcher-name"><span class="' + dotClass + '" title="' + dotTitle + '"></span>' + escH(s.name) + '</div>'
            +   '<div class="store-switcher-domain">' + domainHtml + '</div>'
            + '</div>'
            + openBtn
            + switchBtn
            + '</div>';
        }).join('');
        menu.innerHTML = rows;
      }

      btn.addEventListener('click', function(e){
        e.stopPropagation();
        if (menu.hidden) open(); else close();
      });
      document.addEventListener('click', function(e){
        if (menu.hidden) return;
        if (menu.contains(e.target) || e.target === btn || btn.contains(e.target)) return;
        close();
      });
      document.addEventListener('keydown', function(e){
        if (e.key === 'Escape' && !menu.hidden) close();
      });
    })();
  `
}

function renderDefaultAI(storeName: string): string {
  return `
    <div class="ai-welcome">
      <div class="ai-welcome-icon">${ICON_AI_LARGE}</div>
      <h3>Gbox AI Assistant</h3>
      <p>I help you manage <strong>${esc(storeName)}</strong>. Try asking:</p>
      <div class="ai-suggestions">
        <button class="ai-sug" data-ai-sug>Analyze today's sales</button>
        <button class="ai-sug" data-ai-sug>Which products should I restock?</button>
        <button class="ai-sug" data-ai-sug>Write a product description</button>
        <button class="ai-sug" data-ai-sug>Customer segment analysis</button>
        <button class="ai-sug" data-ai-sug>Research trending products</button>
        <button class="ai-sug" data-ai-sug>Store health check</button>
      </div>
    </div>`
}

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── NAVIGATION ─────────────────────────────────────────────────
// Shopify-exact sidebar order:
//   Home → Orders → Products → Customers → Content → Analytics →
//   Marketing → Discounts → (divider) → Online Store → Settings
function buildNav(
  base: string,
  activePage: string,
  _storeRole: string,
): string {
  const items: NavItem[] = [
    { id: 'home', icon: ICON_HOME, label: 'Home', href: base },
    { id: 'orders', icon: ICON_ORDERS, label: 'Orders', href: `${base}/orders`, children: [
      { label: 'Drafts', href: `${base}/orders/drafts` },
      { label: 'Abandoned checkouts', href: `${base}/orders/abandoned` },
    ]},
    // Fulfillment section intentionally omitted — Gbox centralizes fulfillment via Lenful (Phase F0).
    { id: 'products', icon: ICON_PRODUCTS, label: 'Products', href: `${base}/products`, children: [
      { label: 'Collections', href: `${base}/products/collections` },
      { label: 'Inventory', href: `${base}/products/inventory` },
      { label: 'Purchase orders', href: `${base}/products/purchase-orders` },
      { label: 'Transfers', href: `${base}/products/transfers` },
      { label: 'Gift cards', href: `${base}/products/gift-cards` },
      // Phase 10 PR4 — reviews had been orphaned in the sidebar even
      // though the moderation queue + settings pages were live. Putting
      // it under Products matches the Shopify reference layout (apps
      // → Reviews sit adjacent to the catalog) and gives sellers an
      // obvious entry point after PR3's profanity + notifications wiring.
      { label: 'Reviews', href: `${base}/products/reviews` },
    ]},
    { id: 'customers', icon: ICON_CUSTOMERS, label: 'Customers', href: `${base}/customers`, children: [
      { label: 'Segments', href: `${base}/customers/segments` },
    ]},
    { id: 'content', icon: ICON_CONTENT, label: 'Content', href: `${base}/content`, children: [
      { label: 'Metaobjects', href: `${base}/content/metaobjects` },
      { label: 'Files', href: `${base}/content/files` },
    ]},
    { id: 'analytics', icon: ICON_ANALYTICS, label: 'Analytics', href: `${base}/analytics`, children: [
      { label: 'Reports', href: `${base}/analytics/reports` },
      { label: 'Live View', href: `${base}/analytics/live` },
      { label: 'Traffic sources', href: `${base}/analytics/traffic` },
      { label: 'Conversion funnel', href: `${base}/analytics/funnel` },
      { label: 'UTM attribution', href: `${base}/analytics/attribution` },
      { label: 'Cohort retention', href: `${base}/analytics/cohort` },
      // Phase 14 PR4 — email open/click analytics (only marketing,
      // lifecycle, and reviews emails are tracked; transactional ones
      // never are).
      { label: 'Email analytics', href: `${base}/reports/email-analytics` },
    ]},
    { id: 'marketing', icon: ICON_MARKETING, label: 'Marketing', href: `${base}/marketing`, children: [
      { label: 'Campaigns', href: `${base}/marketing/campaigns` },
      { label: 'Automations', href: `${base}/marketing/automations` },
    ]},
    { id: 'markets', icon: ICON_MARKETING, label: 'Markets', href: `${base}/markets` },
    { id: 'discounts', icon: ICON_DISCOUNTS, label: 'Discounts', href: `${base}/discounts` },
    { id: 'divider', icon: '', label: '', href: '' },
    { id: 'online-store', icon: ICON_STORE, label: 'Online Store', href: `${base}/online-store`, children: [
      // 2026-04-26: Clone Pro retired from seller UI (god-admin-only
      // concierge tooling). The Library page survives as a tabbed view
      // of installed themes + curated design references — no clone UI.
      { label: 'Themes', href: `${base}/online-store/themes` },
      // Visual theme customizer entry-point. The handler resolves the
      // shop's main theme and 302s onward to /themes/:id/customize.
      // If the shop has no themes the handler bounces them into the
      // Library so they install Gbox Default first.
      { label: 'Theme editor', href: `${base}/online-store/theme-editor` },
      { label: 'Library', href: `${base}/online-store/library` },
      { label: 'Pages', href: `${base}/online-store/pages` },
      { label: 'Blog posts', href: `${base}/online-store/blog` },
      { label: 'Landing pages', href: `${base}/online-store/landing` },
      { label: 'Navigation', href: `${base}/online-store/navigation` },
      { label: 'Preferences', href: `${base}/online-store/preferences` },
      { label: 'Domains', href: `${base}/online-store/domains` },
      { label: 'Watermark', href: `${base}/online-store/watermark` },
      { label: 'Size charts', href: `${base}/online-store/size-charts` },
    ]},
    { id: 'settings', icon: ICON_SETTINGS, label: 'Settings', href: `${base}/settings`, children: [
      { label: 'General', href: `${base}/settings/general` },
      { label: 'Plan', href: `${base}/settings/plan` },
      { label: 'Payments', href: `${base}/settings/payments` },
      { label: 'Checkout', href: `${base}/settings/checkout` },
      { label: 'Shipping and delivery', href: `${base}/settings/shipping` },
      { label: 'Taxes and duties', href: `${base}/settings/taxes` },
      { label: 'Markets', href: `${base}/settings/markets` },
      // Domains moved to Online Store per Phase 2B sidebar re-org; see
      // CLAUDE-EXTENDED. Kept the settings hub card (settings.ts) pointing
      // at /online-store/domains so breadcrumbs still land users there.
      { label: 'Customer accounts', href: `${base}/settings/customer-accounts` },
      { label: 'Notifications', href: `${base}/settings/notifications` },
      // Phase 14 PR1.5 — full Shopify-class per-shop template editor
      // (95 template keys across 6 seller-visible categories). Separate
      // entry from "Notifications" because Notifications today is the
      // legacy free-text editor on the old `email_templates` table;
      // "Email templates" is the new registry+override system.
      { label: 'Email templates', href: `${base}/settings/email-templates` },
      // Phase 14 PR4.B — addresses blocked from future sends after a hard
      // bounce or spam complaint. Placed next to Email templates because
      // it's the same mental-model: how my store's outbound mail behaves.
      { label: 'Email suppressions', href: `${base}/settings/email-suppressions` },
      // Phase 14 PR6 commit 8 — narrow finance/fraud alerts surface.
      // Direct link here (in addition to the Settings hub card) because
      // when a merchant sees a "Refund issued" email too often, searching
      // the sidebar for "finance" is the intuitive reach — faster than
      // scrolling past 18 automations in the unified settings/automations
      // page.
      { label: 'Finance alerts', href: `${base}/settings/finance-alerts` },
      { label: 'Custom data', href: `${base}/settings/custom-data` },
      { label: 'Languages', href: `${base}/settings/languages` },
      { label: 'Policies', href: `${base}/settings/legal` },
      { label: 'Store activity log', href: `${base}/settings/activity` },
      { label: 'AI', href: `${base}/settings/ai` },
    ]},
  ]

  return items.map(item => {
    if (item.id === 'divider') return '<div class="nav-divider"></div>'
    const isActive = activePage === item.id || activePage.startsWith(item.id + '/')
    const hasKids = item.children && item.children.length > 0
    // Auto-mở group nếu đang ở 1 trang con của nó.
    const startOpen = hasKids && (isActive || item.children!.some(c => c.href.includes(activePage)))

    // Item có children: render như button toggle (data-nav-toggle="1") để JS
    // chặn navigation và toggle children. Item không children: anchor thông
    // thường như cũ.
    const itemAttrs = hasKids ? ' data-nav-toggle="1"' : ariaCurrent(isActive)
    let h = `<a href="${item.href}" class="nav-item${isActive ? ' active' : ''}${hasKids ? ' has-kids' : ''}${startOpen ? ' open' : ''}"${itemAttrs}>`
    h += `<span class="nav-icon">${item.icon}</span>`
    h += `<span class="nav-label">${item.label}</span>`
    if (hasKids) h += `<span class="nav-arrow">${ICON_CHEVRON_RIGHT}</span>`
    h += `</a>`

    if (hasKids) {
      h += `<div class="nav-children${startOpen ? ' open' : ''}">`
      for (const c of item.children!) {
        // Bug cũ: includes(activePage) → khi activePage='products', mọi child
        // href chứa '/products/...' đều true → toàn bộ children active. Phải
        // strict-match: href phải endsWith '/<activePage>' (activePage là slug
        // không slash, e.g. 'inventory', 'collections').
        const childActive = c.href.endsWith('/' + activePage)
        h += `<a href="${c.href}" class="nav-child"${ariaCurrent(childActive)}>${esc(c.label)}</a>`
      }
      h += `</div>`
    }
    return h
  }).join('\n')
}

interface NavItem {
  id: string
  icon: string
  label: string
  href: string
  children?: { label: string; href: string }[]
}

// ─── SVG ICONS ──────────────────────────────────────────────────
const ICON_HOME = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10l7-7 7 7M5 8v8a1 1 0 001 1h3v-4h2v4h3a1 1 0 001-1V8"/></svg>`
const ICON_ORDERS = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="14" height="14" rx="2"/><path d="M3 8h14M7 4V2M13 4V2"/></svg>`
const ICON_FULFILLMENTS = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="6" width="16" height="11" rx="2"/><path d="M14 6V4a4 4 0 00-8 0v2"/><path d="M7 11l2 2 4-4"/></svg>`
const ICON_PRODUCTS = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 2l3 3 3-3M4 5h12l-1 12H5L4 5z"/></svg>`
const ICON_CUSTOMERS = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="7" r="3"/><path d="M4 17c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>`
const ICON_ANALYTICS = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="10" width="3" height="7" rx="1"/><rect x="8.5" y="6" width="3" height="11" rx="1"/><rect x="14" y="3" width="3" height="14" rx="1"/></svg>`
const ICON_MARKETING = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10a7 7 0 0114 0M7 10a3 3 0 016 0M10 10v5"/></svg>`
const ICON_DISCOUNTS = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="1.5"/><circle cx="13" cy="13" r="1.5"/><path d="M5 15L15 5"/><rect x="2" y="2" width="16" height="16" rx="3"/></svg>`
const ICON_CONTENT = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h12a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z"/><path d="M7 8h6M7 11h4"/></svg>`
const ICON_STORE = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7l1.5-4h11L17 7M3 7v9a1 1 0 001 1h12a1 1 0 001-1V7M3 7h14"/><path d="M8 17v-5h4v5"/></svg>`
const ICON_SETTINGS = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="3"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4"/></svg>`
const ICON_SWITCH = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h12M4 13h12M8 4l-4 3 4 3M12 10l4 3-4 3"/></svg>`
const ICON_MENU = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h14M3 10h14M3 15h14"/></svg>`
const ICON_SEARCH = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`
const ICON_BELL = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2a5 5 0 00-5 5v3l-2 3h14l-2-3V7a5 5 0 00-5-5zM8 16a2 2 0 004 0"/></svg>`
const ICON_AI = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="7.5" cy="8.5" r="1"/><circle cx="12.5" cy="8.5" r="1"/><path d="M7 13c1.5 1 4.5 1 6 0"/></svg>`
const ICON_AI_LARGE = `<svg width="48" height="48" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="7.5" cy="8.5" r="1"/><circle cx="12.5" cy="8.5" r="1"/><path d="M7 13c1.5 1 4.5 1 6 0"/></svg>`
const ICON_SEND = `<svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor"><path d="M2.5 1.5l14 7.5-14 7.5 2-7.5-2-7.5z"/></svg>`
const ICON_THEME = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4"/></svg>`
const ICON_CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 4.5l3 3 3-3"/></svg>`
const ICON_CHEVRON_RIGHT = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 3l3 3-3 3"/></svg>`

// ─── STYLES ─────────────────────────────────────────────────────
// Exported (not just const) so the clone-pro dashboard UI unit tests
// can assert the presence of status/grade/gradient tokens without
// spinning up a real DOM. See seller-layout.test.ts.
export const SELLER_STYLES = `<style>
/* ========== THEME VARIABLES ========== */
:root, [data-theme="dark"] {
  color-scheme: dark;
  --s-bg:          #0f172a;
  --s-sidebar:     #0c1222;
  --s-sidebar-hover: #162035;
  --s-topbar:      #111827;
  --s-card:        #1e293b;
  --s-card-hover:  #263348;
  /* Alias: many older pages reference --s-surface instead of --s-card.
     Keep them pointing at the same token so the dropdown/stat-card/input
     backgrounds follow the theme in both dark AND light mode. Previously
     --s-surface was undefined and every consumer fell back to a hard-coded
     dark color, which silently black-boxed dropdowns on the light theme. */
  --s-surface:     var(--s-card);
  --s-hover:       var(--s-card-hover);
  --s-border:      #1e293b;
  --s-border-light:#334155;
  --s-accent:      #6366f1;
  --s-accent-hover:#818cf8;
  --s-accent-muted:#4f46e5;
  --s-text:        #e2e8f0;
  --s-text-muted:  #94a3b8;
  --s-text-dim:    #64748b;
  /* Alias: a handful of pages (purchase-orders, marketing, inventory, etc.)
     reference --s-text-primary / --s-text-secondary instead of --s-text /
     --s-text-muted. Previously these tokens were undefined, so the color
     property fell back to the initial value -- readable on the dark theme
     by accident (dark body text on dark bg washed to the browser default)
     but catastrophic in light mode where numbers and titles went invisible
     against the white card. Aliasing here keeps both themes in lockstep:
     var(--s-text) resolves lazily, so the [data-theme=light] override
     flows through without re-declaring the alias. */
  --s-text-primary:   var(--s-text);
  --s-text-secondary: var(--s-text-muted);
  --s-success:     #22c55e;
  --s-warning:     #f59e0b;
  --s-danger:      #ef4444;
  --s-info:        #3b82f6;
  --s-input-bg:    #0f172a;
  --s-input-border:#334155;
  --s-shadow:      0 4px 16px rgba(0,0,0,.3);

  /* Phase 2 Step 2.2: alias shared --god-* tokens to seller's --s-*
     tokens so the shared empty-state + skeleton CSS (which references
     --god-border, --god-surface, etc) tints correctly in both dark and
     light mode without duplicating rules. */
  --god-text:           var(--s-text);
  --god-text-secondary: var(--s-text-muted);
  --god-text-tertiary:  var(--s-text-dim);
  --god-border:         var(--s-border);
  --god-border-light:   var(--s-border-light);
  --god-accent:         var(--s-accent);
  --god-surface:        var(--s-card);
  --god-surface-alt:    var(--s-card-hover);
  --god-danger:         var(--s-danger);
  --god-warning:        var(--s-warning);

  /* --gx-* aliases — shop-collections / inventory / products pages render
     with these names. Without aliases, var(--gx-bg, #13161c) hardcodes black
     fallback → light theme có search input + dropdown đen sạm trên nền slate.
     Map vào --s-* để cả 2 mode chọn đúng giá trị. */
  --gx-bg:       var(--s-input-bg);
  --gx-card:     var(--s-card);
  --gx-surface:  var(--s-card);
  --gx-text:     var(--s-text);
  --gx-muted:    var(--s-text-muted);
  --gx-border:   var(--s-border);

  /* Legacy adminLayout compatibility — old pages reference bare --accent etc.
     Added 2026-04-26: --surface, --surface-alt, --surface-hover, --primary,
     --text-muted aliases. Reason: design-library.ts and clone-library.ts
     used these names with hex fallbacks like var(--surface, #fff), so
     when the alias was undefined the fallback fired and produced white
     cards / black buttons in dark mode. The aliases now resolve into
     the canonical --s-* tokens, so both modes inherit cleanly.  */
  --accent:        var(--s-accent);
  --accent-hover:  var(--s-accent-hover);
  --primary:       var(--s-accent);
  --primary-hover: var(--s-accent-hover);
  --text:          var(--s-text);
  --text-muted:    var(--s-text-muted);
  --text-secondary: var(--s-text-muted);
  --text-tertiary: var(--s-text-dim);
  --bg:            var(--s-bg);
  --surface:       var(--s-card);
  --surface-alt:   var(--s-card-hover);
  --surface-hover: var(--s-card-hover);
  --border:        var(--s-border);
  --border-light:  var(--s-border-light);
  --danger:        var(--s-danger);
  --warning:       var(--s-warning);
  --success:       var(--s-success);
  --info:          var(--s-info);

  /* Generic status / grade tokens — kept after clone-pro retirement
     because other components (e.g. order status badges, plan grades)
     consume the same semantics. */
  --status-queued:    #64748b;
  --status-running:   #3b82f6;
  --status-paused:    #f59e0b;
  --status-failed:    #ef4444;
  --status-succeeded: #10b981;
  --status-published: #94a3b8;
  --grade-a: #10b981;
  --grade-b: #10b981;
  --grade-c: #f59e0b;
  --grade-d: #f59e0b;
  --grade-f: #ef4444;
}

[data-theme="light"] {
  color-scheme: light;
  --s-bg:          #f1f5f9;
  --s-sidebar:     #1e1b4b;
  --s-sidebar-hover:#312e81;
  --s-topbar:      #ffffff;
  --s-card:        #ffffff;
  --s-card-hover:  #f8fafc;
  --s-border:      #e2e8f0;
  --s-border-light:#cbd5e1;
  --s-accent:      #6366f1;
  --s-accent-hover:#4f46e5;
  --s-accent-muted:#818cf8;
  --s-text:        #1e293b;
  --s-text-muted:  #64748b;
  --s-text-dim:    #94a3b8;
  --s-success:     #16a34a;
  --s-warning:     #d97706;
  --s-danger:      #dc2626;
  --s-info:        #2563eb;
  --s-input-bg:    #ffffff;
  --s-input-border:#cbd5e1;
  --s-shadow:      0 4px 16px rgba(0,0,0,.08);
}

/* ========== RESET ========== */
*,*::before,*::after { margin:0; padding:0; box-sizing:border-box; }
button, input, select, textarea { font: inherit; color: inherit; background: var(--s-card); border: 1px solid var(--s-border); }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: var(--s-bg);
  color: var(--s-text);
  display: flex;
  min-height: 100vh;
  font-size: 14px;
  line-height: 1.5;
  transition: background .25s ease, color .25s ease;
}
.topbar, .sidebar, .content-area, .card, .ai-panel {
  transition: background .25s ease, color .25s ease, border-color .25s ease;
}

/* ========== SIDEBAR ========== */
.sidebar {
  width: 240px;
  background: var(--s-sidebar);
  color: #e2e8f0;
  display: flex;
  flex-direction: column;
  position: fixed;
  top: 0; left: 0; bottom: 0;
  z-index: 100;
  transition: transform .2s ease;
  border-right: 1px solid rgba(255,255,255,.06);
}
.sidebar-header {
  padding: 12px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid rgba(255,255,255,.08);
  text-decoration: none; color: inherit;
  border-radius: 8px; margin: 8px 8px 0;
  transition: background .12s;
  background: transparent; border: none; width: calc(100% - 16px); cursor: pointer; font: inherit; text-align: left;
}
.sidebar-header:hover { background: rgba(255,255,255,.05); }
.sidebar-header[aria-expanded="true"] .sidebar-header-arrow { transform: rotate(180deg); }
.sidebar-header[aria-expanded="true"] { background: rgba(255,255,255,.06); }

/* Store switcher dropdown — sync palette với sidebar (luôn dark indigo trên
   cả 2 theme). Nếu dùng --s-card sẽ ra trắng trên light theme khó đọc. */
.store-switcher-menu {
  margin: 4px 8px 0;
  background: var(--s-sidebar);
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
  max-height: 420px;
  overflow-y: auto;
  z-index: 50;
}
.store-switcher-loading { padding: 14px; color: #94a3b8; font-size: 12px; text-align: center; }
.store-switcher-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  color: #e2e8f0; font-size: 13px;
  border-bottom: 1px solid rgba(255,255,255,.06);
}
.store-switcher-item:last-of-type { border-bottom: 0; }
.store-switcher-item.active { background: linear-gradient(90deg, rgba(99,102,241,.28) 0%, rgba(99,102,241,.06) 100%); box-shadow: inset 3px 0 0 #818cf8; }
.store-switcher-avatar {
  width: 28px; height: 28px; border-radius: 6px;
  background: linear-gradient(135deg, #22c55e, #16a34a);
  display: grid; place-items: center;
  font-weight: 700; font-size: 12px; color: #fff; flex-shrink: 0;
}
.store-switcher-info { flex: 1; min-width: 0; }
.store-switcher-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #f1f5f9; }
.store-switcher-item.active .store-switcher-name { color: #c7d2fe; font-weight: 600; }
.store-switcher-domain { font-size: 11px; color: #94a3b8; font-family: ui-monospace,Menlo,monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.store-switcher-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; margin-right: 7px; vertical-align: middle; }
.store-switcher-dot.online  { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,.55); }
.store-switcher-dot.offline { background: #ef4444; }
.store-switcher-icon-btn {
  width: 28px; height: 28px;
  display: grid; place-items: center;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,.15);
  background: rgba(255,255,255,.04);
  color: #e2e8f0;
  text-decoration: none;
  flex-shrink: 0;
  cursor: pointer;
  transition: .15s;
}
.store-switcher-icon-btn:hover { background: rgba(99,102,241,.20); border-color: rgba(129,140,248,.6); color: #fff; }
.store-switcher-icon-btn.disabled { opacity: .3; pointer-events: none; }
.store-switcher-icon-btn.primary { background: linear-gradient(180deg,#5b6dff,#4854e0); border-color: transparent; color: #fff; }
.store-switcher-icon-btn.primary:hover { background: linear-gradient(180deg,#6577ff,#5260e8); border-color: transparent; }
.store-switcher-footer {
  border-top: 1px solid rgba(255,255,255,.08);
  padding: 10px 12px;
  font-size: 12px;
}
.store-switcher-footer a { color: #818cf8; text-decoration: none; }
.store-switcher-footer a:hover { color: #a5b4fc; text-decoration: underline; }
.store-logo {
  width: 32px; height: 32px;
  background: linear-gradient(135deg, #22c55e, #16a34a);
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 14px; color: #fff; flex-shrink: 0;
}
.store-info { overflow: hidden; flex: 1; min-width: 0; }
.store-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #f1f5f9; }
.store-plan { font-size: 11px; color: #64748b; }
.sidebar-header-arrow { opacity: .4; flex-shrink: 0; }
.sidebar-nav { flex: 1; overflow-y: auto; padding: 8px 0; }
.sidebar-nav::-webkit-scrollbar { width: 4px; }
.sidebar-nav::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 4px; }
.sidebar-footer { border-top: 1px solid rgba(255,255,255,.08); padding: 8px 0; }

/* Shopify-style pill nav items with rounded corners */
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 12px; margin: 1px 8px; color: #cbd5e1;
  text-decoration: none; font-size: 13.5px; font-weight: 500;
  transition: all .12s ease; cursor: pointer; position: relative;
  border-radius: 8px; letter-spacing: -.01em;
}
.nav-item:hover { background: var(--s-sidebar-hover); color: #f1f5f9; }
.nav-item.active {
  background: linear-gradient(90deg, rgba(99,102,241,.38) 0%, rgba(99,102,241,.10) 100%);
  color: #ffffff; font-weight: 600; letter-spacing: -.005em;
  box-shadow: inset 0 0 0 1px rgba(129,140,248,.32);
}
.nav-item.active::before {
  content: ''; position: absolute; left: 0; top: 4px; bottom: 4px;
  width: 4px; background: linear-gradient(180deg, #a5b4fc, #6366f1);
  border-radius: 0 4px 4px 0;
  box-shadow: 0 0 12px rgba(129,140,248,.55);
}
.nav-icon { width: 20px; height: 20px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; opacity: .85; }
.nav-item.active .nav-icon { opacity: 1; color: #c7d2fe; }
.nav-label { flex: 1; }
.nav-arrow { opacity: .4; transition: opacity .15s, transform .15s ease; display: inline-flex; }
.nav-item:hover .nav-arrow { opacity: .7; }
.nav-item.has-kids.open .nav-arrow { transform: rotate(90deg); opacity: .9; }
.nav-children { display: none; padding: 2px 0 4px 20px; margin-left: 28px; border-left: 1px solid rgba(255,255,255,.06); }
.nav-children.open { display: block; }
.nav-child {
  display: block; padding: 5px 12px; color: #94a3b8;
  text-decoration: none; font-size: 13px; border-radius: 6px;
  transition: all .12s; font-weight: 400;
}
.nav-child:hover { color: #e2e8f0; background: rgba(255,255,255,.05); }
.nav-child[aria-current="page"] {
  color: #ffffff; font-weight: 600;
  background: rgba(99,102,241,.22);
  box-shadow: inset 0 0 0 1px rgba(129,140,248,.28);
}
.nav-divider { height: 1px; background: rgba(255,255,255,.06); margin: 8px 16px; }

/* ========== MAIN AREA ========== */
.main-area { flex: 1; margin-left: 240px; display: flex; flex-direction: column; min-height: 100vh; }

/* ========== TOP BAR ========== */
.topbar {
  height: 56px; background: var(--s-topbar);
  border-bottom: 1px solid var(--s-border);
  display: flex; align-items: center; padding: 0 16px; gap: 12px;
  position: sticky; top: 0; z-index: 50;
}
.topbar-toggle { display: none; background: none; border: none; cursor: pointer; padding: 8px; color: var(--s-text); }
/* Shopify-style centered search trigger */
.topbar-search {
  flex: 1; max-width: 580px; position: relative;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; margin: 0 auto;
  border: 1px solid var(--s-input-border); border-radius: 8px;
  background: var(--s-input-bg); cursor: pointer;
  transition: border-color .15s, background .15s;
}
.topbar-search:hover { border-color: var(--s-border-light); background: var(--s-card); }
.search-icon-wrap { color: var(--s-text-dim); display: flex; align-items: center; flex-shrink: 0; }
.search-placeholder { font-size: 13px; color: var(--s-text-dim); flex: 1; }
.search-shortcut {
  font-size: 11px; color: var(--s-text-dim); background: var(--s-bg);
  padding: 2px 6px; border-radius: 4px; border: 1px solid var(--s-border);
  font-family: monospace; white-space: nowrap;
}

.topbar-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.topbar-btn {
  width: 36px; height: 36px; border: none; background: none; border-radius: 8px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; color: var(--s-text-muted);
  position: relative; transition: all .15s;
}
.topbar-btn:hover { background: var(--s-card); color: var(--s-accent); }
.notif-dot {
  position: absolute; top: 4px; right: 4px; min-width: 16px; height: 16px;
  padding: 0 4px; background: var(--s-danger); border-radius: 8px;
  font-size: 10px; font-weight: 700; color: #fff; line-height: 16px;
  text-align: center; display: none; align-items: center; justify-content: center;
}

/* Notification Drawer */
.notif-drawer {
  position: absolute; top: 48px; right: 60px; width: 380px; max-height: 480px;
  background: var(--s-card); border: 1px solid var(--s-border-light);
  border-radius: 12px; box-shadow: var(--s-shadow); z-index: 200;
  display: flex; flex-direction: column; overflow: hidden;
}
.notif-drawer-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--s-border);
}
.notif-drawer-title { font-size: 14px; font-weight: 600; }
.notif-drawer-actions { display: flex; align-items: center; gap: 8px; }
/* "Mark all as read" button — low-key until unreadCount > 0, then the
   JS flips display:none back to inline. Keep the visual weight under
   the close ✕ so it reads as a secondary action. */
.notif-mark-all {
  background: none; border: none; color: var(--s-accent);
  font-size: 12px; font-weight: 500; cursor: pointer;
  padding: 2px 6px; border-radius: 4px; line-height: 1.3;
}
.notif-mark-all:hover { background: rgba(99,102,241,.08); text-decoration: underline; }
.notif-drawer-close {
  background: none; border: none; color: var(--s-text-dim); font-size: 20px;
  cursor: pointer; padding: 0 4px; line-height: 1;
}
.notif-drawer-close:hover { color: var(--s-text); }
.notif-drawer-body { flex: 1; overflow-y: auto; max-height: 360px; }
.notif-drawer-footer {
  padding: 10px 16px; border-top: 1px solid var(--s-border); text-align: center;
}
.notif-drawer-footer a { font-size: 12px; color: var(--s-accent); text-decoration: none; }
.notif-drawer-footer a:hover { text-decoration: underline; }
.notif-item {
  display: flex; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--s-border);
  transition: background .12s;
}
.notif-item:hover { background: rgba(99,102,241,.04); }
.notif-item:last-child { border-bottom: none; }
/* Unread row background so the "fresh" vs "already seen" distinction
   survives even after the bell badge has cleared. Kept subtle so the
   list doesn't look like a stoplight when there are many unread. */
.notif-item.unread { background: rgba(99,102,241,.06); }
.notif-item.unread .notif-item-text { font-weight: 600; }
.notif-item-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--s-accent);
  flex-shrink: 0; margin-top: 5px;
}
.notif-item-dot.read { background: var(--s-border-light); }
.notif-item-content { flex: 1; min-width: 0; }
.notif-item-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.notif-item-text { font-size: 13px; line-height: 1.4; }
/* "New" pill on unread rows — Thai asked for a thông-báo-mới marker
   that stays visible even after the bell badge clears. Tiny, high-
   contrast so screen-reader users still notice the difference between
   a fresh row and one already acknowledged. */
.notif-item-new {
  display: inline-block; font-size: 10px; font-weight: 700;
  line-height: 1; padding: 2px 6px; border-radius: 4px;
  background: var(--s-accent); color: #fff;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.notif-item-time { font-size: 11px; color: var(--s-text-dim); margin-top: 2px; }
.notif-loading { text-align: center; padding: 32px; color: var(--s-text-dim); font-size: 13px; }
.notif-empty { text-align: center; padding: 32px; color: var(--s-text-dim); font-size: 13px; }

.topbar-user { position: relative; cursor: pointer; }
.user-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--s-accent); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 14px;
}
.user-dropdown {
  display: none; position: absolute; right: 0; top: 42px;
  background: var(--s-card); border: 1px solid var(--s-border-light);
  border-radius: 12px; box-shadow: var(--s-shadow);
  min-width: 240px; z-index: 200; overflow: hidden;
}
.user-dropdown.open { display: block; }
.dd-header { padding: 14px 16px; }
.dd-name { font-weight: 600; font-size: 14px; }
.dd-email { font-size: 12px; color: var(--s-text-muted); }
.dd-divider { height: 1px; background: var(--s-border); }
.dd-item { display: block; padding: 10px 16px; font-size: 13px; color: var(--s-text); text-decoration: none; }
.dd-item:hover { background: var(--s-card-hover); }
.dd-danger { color: var(--s-danger) !important; }

.role-badge {
  display: inline-flex; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600;
}
.role-owner { background: rgba(99,102,241,.2); color: #a5b4fc; }
.role-admin { background: rgba(59,130,246,.2); color: #93c5fd; }
.role-staff { background: rgba(148,163,184,.2); color: #94a3b8; }

/* ========== CONTENT ========== */
.content-area { padding: 24px; flex: 1; transition: margin-right .25s; }
.content-area.with-ai { margin-right: 360px; }

/* ========== ONBOARDING RESUME-SETUP BANNER (Phase D, 2026-04-18) ========== */
.gbox-onboarding-banner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  margin: 0 0 20px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(99,102,241,0.18), rgba(59,130,246,0.14));
  border: 1px solid rgba(99,102,241,0.45);
  color: var(--s-text);
}
.gbox-onboarding-banner__body { flex: 1; min-width: 0; }
.gbox-onboarding-banner__title { display: block; font-size: 15px; margin-bottom: 2px; }
.gbox-onboarding-banner__copy { margin: 0; font-size: 13px; color: var(--s-text-muted); }
.gbox-onboarding-banner__actions {
  display: flex; align-items: center; gap: 10px; flex-shrink: 0;
}
.gbox-onboarding-banner__cta {
  display: inline-flex; align-items: center;
  padding: 8px 14px; border-radius: 8px;
  background: var(--s-accent, #6366f1); color: #fff;
  font-weight: 600; font-size: 13px;
  text-decoration: none;
  transition: filter .15s;
}
.gbox-onboarding-banner__cta:hover { filter: brightness(1.08); }
.gbox-onboarding-banner__dismiss-form { margin: 0; }
.gbox-onboarding-banner__dismiss {
  background: none; border: 1px solid transparent;
  color: var(--s-text-muted); font-size: 20px;
  line-height: 1; padding: 4px 8px; border-radius: 6px; cursor: pointer;
}
.gbox-onboarding-banner__dismiss:hover {
  color: var(--s-text); border-color: var(--s-border);
}

/* ========== AI PANEL ========== */
.ai-panel {
  width: 360px; position: fixed; top: 56px; right: 0; bottom: 0;
  background: var(--s-card); border-left: 1px solid var(--s-border);
  display: flex; flex-direction: column; z-index: 40;
  box-shadow: -4px 0 20px rgba(0,0,0,.15);
}
.ai-header {
  padding: 14px 16px; border-bottom: 1px solid var(--s-border);
  display: flex; align-items: center; justify-content: space-between;
}
.ai-title { font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 8px; color: var(--s-accent); }
.ai-close { background: none; border: none; font-size: 22px; cursor: pointer; color: var(--s-text-muted); padding: 4px; line-height: 1; }
.ai-close:hover { color: var(--s-text); }
.ai-body { flex: 1; overflow-y: auto; padding: 16px; }
.ai-body::-webkit-scrollbar { width: 4px; }
.ai-body::-webkit-scrollbar-thumb { background: var(--s-border-light); border-radius: 4px; }
.ai-input-area {
  padding: 12px 16px; border-top: 1px solid var(--s-border);
  display: flex; gap: 8px;
}
.ai-input-area input {
  flex: 1; padding: 10px 14px;
  border: 1px solid var(--s-input-border); border-radius: 8px;
  font-size: 13px; outline: none; background: var(--s-input-bg); color: var(--s-text);
}
.ai-input-area input:focus { border-color: var(--s-accent); }
.ai-input-area input::placeholder { color: var(--s-text-dim); }
.ai-send {
  width: 38px; height: 38px; background: var(--s-accent); color: #fff; border: none; border-radius: 8px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background .15s;
}
.ai-send:hover { background: var(--s-accent-hover); }

.ai-welcome { text-align: center; padding: 24px 0; }
.ai-welcome-icon { margin-bottom: 12px; color: var(--s-accent); }
.ai-welcome h3 { font-size: 16px; margin-bottom: 8px; }
.ai-welcome p { font-size: 13px; color: var(--s-text-muted); margin-bottom: 16px; }
.ai-suggestions { display: flex; flex-direction: column; gap: 6px; }
.ai-sug {
  padding: 10px 14px; border: 1px solid var(--s-border-light); border-radius: 8px;
  background: var(--s-card); cursor: pointer; font-size: 12px; text-align: left;
  color: var(--s-text); transition: all .15s;
}
.ai-sug:hover { border-color: var(--s-accent); background: rgba(99,102,241,.1); }

.ai-msg { margin-bottom: 12px; }
.ai-msg-user { text-align: right; }
.ai-msg-user .ai-bubble { background: var(--s-accent); color: #fff; }
.ai-msg-ai .ai-bubble { background: var(--s-card); color: var(--s-text); }
.ai-bubble { display: inline-block; padding: 10px 14px; border-radius: 12px; max-width: 90%; font-size: 13px; line-height: 1.5; text-align: left; }
.ai-bubble table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.ai-bubble th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--s-border-light); font-weight: 600; }
.ai-bubble td { padding: 4px 8px; border-bottom: 1px solid var(--s-border); }
.ai-typing { color: var(--s-accent); font-size: 12px; padding: 8px; }

/* ========== COMMON COMPONENTS ========== */
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
.page-title { font-size: 22px; font-weight: 700; }
.page-subtitle { font-size: 13px; color: var(--s-text-muted); margin-top: 2px; }

.card { background: var(--s-card); border-radius: 12px; border: 1px solid var(--s-border); overflow: hidden; }
.card-header {
  padding: 16px 20px; border-bottom: 1px solid var(--s-border);
  font-weight: 600; font-size: 14px;
  display: flex; align-items: center; justify-content: space-between;
}
.card-body { padding: 20px; }

.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
.stats-grid-6 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
.stat-card {
  background: var(--s-card); border-radius: 12px; border: 1px solid var(--s-border);
  padding: 16px 20px; transition: border-color .15s; display:block;
}
.stat-card:hover { border-color: var(--s-accent); }
.stat-label { font-size: 12px; color: var(--s-text-muted); margin-bottom: 6px; font-weight: 500; }
.stat-value { font-size: 24px; font-weight: 700; line-height: 1.2; }
.stat-change { font-size: 11px; margin-top: 6px; color: var(--s-text-dim); }
.stat-up { color: var(--s-success); }
.stat-down { color: var(--s-danger); }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
  text-decoration: none; cursor: pointer; border: 1px solid transparent;
  transition: all .15s;
}
.btn-primary { background: var(--s-accent); color: #fff; border-color: var(--s-accent); }
.btn-primary:hover { background: var(--s-accent-hover); }
.btn-outline { background: var(--s-card); color: var(--s-text); border-color: var(--s-border-light); }
.btn-outline:hover { background: var(--s-card-hover); border-color: var(--s-accent); }
.btn-danger { background: var(--s-danger); color: #fff; border-color: var(--s-danger); }
.btn-sm { padding: 6px 12px; font-size: 12px; }

/* Phase 10 PR4 — sr-only utility. Visually hides help text while keeping
   it in the a11y tree for screen readers (same pattern as Tailwind).
   Used by <span id="x_help" class="sr-only"> descriptions on checkboxes
   without a visible caption, e.g. review-settings profanity filter. */
.sr-only {
  position: absolute !important;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.badge { display: inline-flex; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.badge-success { background: rgba(34,197,94,.15); color: #4ade80; }
.badge-warning { background: rgba(245,158,11,.15); color: #fbbf24; }
.badge-danger { background: rgba(239,68,68,.15); color: #f87171; }
.badge-info { background: rgba(99,102,241,.15); color: #a5b4fc; }
.badge-neutral { background: rgba(148,163,184,.15); color: #94a3b8; }

[data-theme="light"] .badge-success { background: #dcfce7; color: #166534; }
[data-theme="light"] .badge-warning { background: #fef3c7; color: #92400e; }
[data-theme="light"] .badge-danger { background: #fee2e2; color: #991b1b; }
[data-theme="light"] .badge-info { background: #e0e7ff; color: #3730a3; }

/* TABLE */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; padding: 10px 16px; font-weight: 600;
  color: var(--s-text-muted); font-size: 12px;
  text-transform: uppercase; letter-spacing: .5px;
  border-bottom: 1px solid var(--s-border-light);
}
td { padding: 12px 16px; border-bottom: 1px solid var(--s-border); vertical-align: middle; }
tr:hover { background: rgba(99,102,241,.04); }

/* TABS */
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--s-border-light); margin-bottom: 20px; }
.tab {
  padding: 10px 16px; font-size: 13px; color: var(--s-text-muted);
  cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
  text-decoration: none; transition: all .15s;
}
.tab:hover { color: var(--s-text); }
.tab.active { color: var(--s-accent); border-bottom-color: var(--s-accent); font-weight: 600; }

/* FORM */
.form-group { margin-bottom: 16px; }
.form-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--s-text); }
.form-input, .form-select, .form-textarea {
  width: 100%; padding: 10px 14px;
  border: 1px solid var(--s-input-border); border-radius: 8px;
  font-size: 13px; background: var(--s-input-bg); color: var(--s-text);
  outline: none; transition: border-color .15s;
}
.form-input:focus, .form-select:focus, .form-textarea:focus { border-color: var(--s-accent); }
.form-textarea { min-height: 100px; resize: vertical; font-family: inherit; }
.form-help { font-size: 12px; color: var(--s-text-dim); margin-top: 4px; }

/* EMPTY STATE */
.empty-state { text-align: center; padding: 48px 24px; }
.empty-state-icon { font-size: 48px; margin-bottom: 12px; opacity: .6; }
.empty-state-title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
.empty-state-text { font-size: 13px; color: var(--s-text-muted); }

/* CHART */
.bar-chart { display: flex; align-items: flex-end; gap: 4px; height: 120px; padding-top: 8px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.bar-fill { width: 100%; background: var(--s-accent); border-radius: 4px 4px 0 0; min-height: 2px; transition: height .3s; }
.bar-label { font-size: 10px; color: var(--s-text-dim); }

/* PAGINATION */
.pagination { display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 20px; }
.pagination a, .pagination span {
  padding: 6px 12px; border-radius: 6px; font-size: 13px;
  text-decoration: none; color: var(--s-text-muted); border: 1px solid var(--s-border);
}
.pagination a:hover { background: var(--s-card-hover); color: var(--s-text); }
.pagination .active { background: var(--s-accent); color: #fff; border-color: var(--s-accent); }

/* RESPONSIVE */
@media (max-width: 1024px) {
  .sidebar { transform: translateX(-100%); }
  .sidebar.open { transform: translateX(0); box-shadow: 4px 0 24px rgba(0,0,0,.4); }
  .main-area { margin-left: 0; }
  .topbar-toggle { display: block; }
  .ai-panel { width: 100%; }
  .content-area.with-ai { margin-right: 0; }
}
@media (max-width: 1200px) {
  .stats-grid-6 { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 640px) {
  .stats-grid { grid-template-columns: 1fr 1fr; }
  .stats-grid-6 { grid-template-columns: 1fr 1fr; }
  .page-header { flex-direction: column; align-items: flex-start; }
  .content-area { padding: 16px; }
}
</style>`

// ─── SCRIPTS ────────────────────────────────────────────────────
function SELLER_SCRIPTS(storeSlug: string): string {
  return `<script>
// Navigate to accounts portal
function goAccounts(path) {
  var base = '${process.env.ACCOUNTS_BASE_URL || (process.env.NODE_ENV === "production" ? "https://accounts.gbox.co" : "http://" + "localhost:" + (process.env.ACCOUNTS_PORT || "4323"))}';
  window.location.href = base + path;
}

// User dropdown
document.getElementById('userMenu')?.addEventListener('click', function(e) {
  e.stopPropagation();
  document.getElementById('userDropdown')?.classList.toggle('open');
});
document.addEventListener('click', () => {
  document.getElementById('userDropdown')?.classList.remove('open');
});

// Theme toggle
function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  document.cookie = 'gbox_theme=' + next + ';path=/;max-age=31536000;SameSite=Lax';
  // Swap icons
  var sun = document.getElementById('themeIconSun');
  var moon = document.getElementById('themeIconMoon');
  if (sun) sun.style.display = next === 'dark' ? '' : 'none';
  if (moon) moon.style.display = next === 'light' ? '' : 'none';
}
document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);

// Setup Guide toggle (persisted via cookie)
function _setupCollapse() {
  var guide = document.getElementById('setupGuide');
  var body = document.getElementById('setupGuideBody');
  var btn = document.getElementById('setupToggleBtn');
  var badge = document.getElementById('setupWarnBadge');
  var doneBadge = document.getElementById('setupDoneBadge');
  var progress = document.getElementById('setupProgress');
  if (!guide || !body || !btn) return;
  var isDone = guide.getAttribute('data-done') === '1';
  guide.classList.add('collapsed');
  body.style.maxHeight = body.scrollHeight + 'px';
  requestAnimationFrame(function() { body.style.maxHeight = '0'; });
  btn.textContent = 'Show';
  if (isDone) {
    if (doneBadge) doneBadge.style.display = 'inline-flex';
    if (badge) badge.style.display = 'none';
  } else {
    if (badge) badge.style.display = 'inline-flex';
    if (doneBadge) doneBadge.style.display = 'none';
  }
  if (progress) progress.style.display = 'none';
  document.cookie = 'gbox_setup_hidden=1;path=/;max-age=31536000;SameSite=Lax';
}
function _setupExpand() {
  var guide = document.getElementById('setupGuide');
  var body = document.getElementById('setupGuideBody');
  var btn = document.getElementById('setupToggleBtn');
  var badge = document.getElementById('setupWarnBadge');
  var doneBadge = document.getElementById('setupDoneBadge');
  var progress = document.getElementById('setupProgress');
  if (!guide || !body || !btn) return;
  guide.classList.remove('collapsed');
  body.style.maxHeight = body.scrollHeight + 'px';
  setTimeout(function() { body.style.maxHeight = 'none'; }, 300);
  btn.textContent = 'Hide';
  if (badge) badge.style.display = 'none';
  if (doneBadge) doneBadge.style.display = 'none';
  if (progress) progress.style.display = '';
  document.cookie = 'gbox_setup_hidden=0;path=/;max-age=31536000;SameSite=Lax';
}
// Wire up: header click toggles, but when expanded only button hides
(function() {
  var guide = document.getElementById('setupGuide');
  var header = document.getElementById('setupGuideHeader');
  var btn = document.getElementById('setupToggleBtn');
  var body = document.getElementById('setupGuideBody');
  if (!guide || !header || !btn) return;

  // Button always toggles
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (guide.classList.contains('collapsed')) _setupExpand();
    else _setupCollapse();
  });

  // Header click: when collapsed -> expand; when expanded -> collapse
  header.addEventListener('click', function(e) {
    if (e.target === btn || btn.contains(e.target)) return;
    if (guide.classList.contains('collapsed')) _setupExpand();
    else _setupCollapse();
  });

  // Restore from cookie OR auto-collapse if all done
  var isDone = guide.getAttribute('data-done') === '1';
  var shouldCollapse = isDone || document.cookie.indexOf('gbox_setup_hidden=1') !== -1;
  if (shouldCollapse && body) {
    guide.classList.add('collapsed');
    body.style.maxHeight = '0';
    btn.textContent = 'Show';
    var badge = document.getElementById('setupWarnBadge');
    var doneBadge = document.getElementById('setupDoneBadge');
    var progress = document.getElementById('setupProgress');
    if (isDone) {
      if (doneBadge) doneBadge.style.display = 'inline-flex';
      if (badge) badge.style.display = 'none';
    } else {
      if (badge) badge.style.display = 'inline-flex';
      if (doneBadge) doneBadge.style.display = 'none';
    }
    if (progress) progress.style.display = 'none';
  }
})();

// Sidebar nav: parent click navigates to its index page. Khi đã ở chính
// page đó rồi thì click toggle children thay vì reload. Middle/Cmd/Ctrl
// click giữ hành vi mở tab mặc định của browser.
document.querySelectorAll('.nav-item.has-kids').forEach(function(a) {
  a.addEventListener('click', function(e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    var href = a.getAttribute('href') || '';
    // Already on this parent's index page → just toggle children, no reload
    if (href && window.location.pathname === href) {
      e.preventDefault();
      var siblings = a.nextElementSibling;
      a.classList.toggle('open');
      if (siblings && siblings.classList.contains('nav-children')) {
        siblings.classList.toggle('open');
      }
    }
    // Otherwise: let browser navigate to href as normal anchor
  });
});

// AI Panel
function toggleAI() {
  const panel = document.getElementById('aiPanel');
  const content = document.getElementById('contentArea');
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'flex' : 'none';
  content?.classList.toggle('with-ai', isHidden);
}
document.getElementById('aiToggle')?.addEventListener('click', toggleAI);
document.getElementById('aiCloseBtn')?.addEventListener('click', toggleAI);

// AI Input — Enter to send + Send button
document.getElementById('aiInput')?.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); sendAI(); }
});
document.getElementById('aiSendBtn')?.addEventListener('click', function() { sendAI(); });

// AI Suggestion buttons (event delegation — works for all pages)
document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-ai-sug]');
  if (btn) { askAI(btn.getAttribute('data-ai-sug') || btn.textContent); }
});

// AI Chat
async function askAI(text) {
  try {
    var input = document.getElementById('aiInput');
    if (input) input.value = text;
    await sendAI();
  } catch(e) { console.error('[GboxAI] askAI error:', e); }
}

async function sendAI() {
  var input = document.getElementById('aiInput');
  var body = document.getElementById('aiBody');
  var panel = document.getElementById('aiPanel');
  if (!input || !body || !panel) { console.warn('[GboxAI] Missing DOM elements'); return; }

  var text = input.value.trim();
  if (!text) return;

  if (panel.style.display === 'none') toggleAI();

  var welcome = body.querySelector('.ai-welcome');
  if (welcome) welcome.remove();

  // Append user message
  var userMsg = document.createElement('div');
  userMsg.className = 'ai-msg ai-msg-user';
  userMsg.innerHTML = '<div class="ai-bubble">' + escH(text) + '</div>';
  body.appendChild(userMsg);
  input.value = '';
  body.scrollTop = body.scrollHeight;

  // Show typing indicator
  var typing = document.createElement('div');
  typing.className = 'ai-typing';
  typing.id = 'aiTyping';
  typing.textContent = 'AI is thinking...';
  body.appendChild(typing);
  body.scrollTop = body.scrollHeight;

  try {
    var res = await fetch('/admin/store/${esc(storeSlug)}/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message: text, context: window.location.pathname })
    });
    var typingEl = document.getElementById('aiTyping');
    if (typingEl) typingEl.remove();

    if (!res.ok) {
      var errText = 'Server error (' + res.status + '). ';
      if (res.status === 401 || res.status === 302) errText += 'Session expired — please refresh the page.';
      else errText += 'Please try again.';
      var errDiv = document.createElement('div');
      errDiv.className = 'ai-msg ai-msg-ai';
      errDiv.innerHTML = '<div class="ai-bubble" style="color:var(--s-danger)">' + escH(errText) + '</div>';
      body.appendChild(errDiv);
      body.scrollTop = body.scrollHeight;
      return;
    }

    var contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      var badDiv = document.createElement('div');
      badDiv.className = 'ai-msg ai-msg-ai';
      badDiv.innerHTML = '<div class="ai-bubble" style="color:var(--s-danger)">Unexpected response. Session may have expired — please refresh.</div>';
      body.appendChild(badDiv);
      body.scrollTop = body.scrollHeight;
      return;
    }

    var data = await res.json();
    var aiMsg = document.createElement('div');
    aiMsg.className = 'ai-msg ai-msg-ai';
    aiMsg.innerHTML = '<div class="ai-bubble">' + (data.html || escH(data.text || 'Sorry, I could not process that.')) + '</div>';
    body.appendChild(aiMsg);
  } catch (err) {
    console.error('[GboxAI] sendAI error:', err);
    var typingEl2 = document.getElementById('aiTyping');
    if (typingEl2) typingEl2.remove();
    var errDiv2 = document.createElement('div');
    errDiv2.className = 'ai-msg ai-msg-ai';
    errDiv2.innerHTML = '<div class="ai-bubble" style="color:var(--s-danger)">Connection error. Please check your network and try again.</div>';
    body.appendChild(errDiv2);
  }
  body.scrollTop = body.scrollHeight;
}

function escH(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Ctrl+K — open command palette (handled by keyboard runtime script)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    // Command palette is opened by the keyboard runtime script
    var palette = document.getElementById('cmd-palette');
    if (palette) {
      palette.style.display = palette.style.display === 'none' ? 'flex' : 'none';
      var input = palette.querySelector('input');
      if (input) { input.value = ''; input.focus(); }
    }
  }
});

// ─── Notification Drawer ───────────────────────────────────────
var _notifOpen = false;
var _notifLoaded = false;

// ---------------------------------------------------------------
// Read/unread semantics (April 2026 fix)
// ---------------------------------------------------------------
// Before this fix the red bell badge never cleared — loadNotifications
// only READ from /notifications/recent, nothing ever told the server
// those rows had been seen, so unreadCount stayed positive forever.
//
// Now the drawer has two write paths:
//
//   - toggleNotifDrawer() on OPEN  → markAllSeen() fires immediately,
//     clearing the badge the moment the bell is clicked. The items
//     themselves still render with their PRE-mark read state (unread
//     rows get a "New" pill + bold text) so the seller can still
//     distinguish fresh items from older ones inside the drawer.
//
//   - #notifMarkAll button on CLICK → same markAllSeen() call, plus
//     a re-render so the in-drawer list updates to match.
//
// The endpoint at /notifications/mark-seen returns JSON
// ({ ok, marked, unreadCount:0 }), so we don't need a second
// /notifications/recent round-trip after the POST resolves.
function toggleNotifDrawer() {
  var drawer = document.getElementById('notifDrawer');
  if (!drawer) return;
  _notifOpen = !_notifOpen;
  drawer.style.display = _notifOpen ? 'flex' : 'none';
  if (_notifOpen) {
    if (!_notifLoaded) {
      loadNotifications();
    }
    // Fire-and-forget. markAllSeen clears the bell badge and flips
    // server-side state; it doesn't need to block the visual open.
    markAllSeen(false);
  }
}

// Wire up bell button & close button via addEventListener
document.getElementById('notifToggle')?.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleNotifDrawer();
});
document.getElementById('notifClose')?.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleNotifDrawer();
});

// Wire the explicit "Mark all as read" button — same markAllSeen call,
// but this path also re-renders the list so the in-drawer unread
// pills clear (auto-open fires markAllSeen silently so the pills
// stay visible as a visual receipt of what just got marked).
document.getElementById('notifMarkAll')?.addEventListener('click', function(e) {
  e.stopPropagation();
  markAllSeen(true);
});

// Close drawer when clicking outside
document.addEventListener('click', function(e) {
  var drawer = document.getElementById('notifDrawer');
  var toggle = document.getElementById('notifToggle');
  if (_notifOpen && drawer && !drawer.contains(e.target) && (!toggle || !toggle.contains(e.target))) {
    _notifOpen = false;
    drawer.style.display = 'none';
  }
});

async function loadNotifications() {
  var list = document.getElementById('notifList');
  if (!list) return;
  try {
    var res = await fetch('/admin/store/${esc(storeSlug)}/notifications/recent');
    if (!res.ok) throw new Error('Failed');
    var data = await res.json();
    _notifLoaded = true;
    if (data.items && data.items.length > 0) {
      list.innerHTML = data.items.map(function(item) {
        var unreadCls = item.read ? '' : ' unread';
        var newPill = item.read ? '' : '<span class="notif-item-new">New</span>';
        return '<div class="notif-item' + unreadCls + '">' +
          '<div class="notif-item-dot' + (item.read ? ' read' : '') + '"></div>' +
          '<div class="notif-item-content">' +
            '<div class="notif-item-header">' +
              '<span class="notif-item-text">' + escH(item.text) + '</span>' +
              newPill +
            '</div>' +
            (item.message ? '<div class="notif-item-text" style="font-size:12px;color:var(--s-text-dim);font-weight:normal">' + escH(item.message) + '</div>' : '') +
            '<div class="notif-item-time">' + escH(item.time) + '</div>' +
          '</div></div>';
      }).join('');
    } else {
      list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    }
    // Update bell badge with unread count
    var dot = document.getElementById('notifDot');
    var unread = data.unreadCount || 0;
    if (dot) {
      dot.style.display = unread > 0 ? 'flex' : 'none';
      dot.textContent = unread > 99 ? '99+' : String(unread);
    }
    // Reveal "Mark all as read" button only when there are unread
    // rows worth clearing. Keeps the header clean at zero-inbox.
    var markBtn = document.getElementById('notifMarkAll');
    if (markBtn) {
      markBtn.style.display = unread > 0 ? 'inline-block' : 'none';
    }
  } catch (err) {
    list.innerHTML = '<div class="notif-empty">Could not load notifications</div>';
  }
}

/**
 * POST /notifications/mark-seen — clears the server's unread flag for
 * every row in this shop, then optimistically zeroes out the bell
 * badge. Called automatically on drawer open (refreshList=false, the
 * in-drawer list keeps its visual "New" pills for a beat) and from
 * the explicit "Mark all as read" button (refreshList=true, which
 * re-fetches so pills and bolding disappear).
 *
 * Silent failure is fine — the next loadNotifications() will re-sync
 * the badge either way, and a transient 5xx shouldn't spook the
 * seller with a toast over a bell widget.
 */
async function markAllSeen(refreshList) {
  try {
    var res = await fetch('/admin/store/${esc(storeSlug)}/notifications/mark-seen', {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return;
    // Optimistic badge clear: the server will report unreadCount:0
    // but we don't actually need the JSON body to zero the dot.
    var dot = document.getElementById('notifDot');
    if (dot) {
      dot.style.display = 'none';
      dot.textContent = '0';
    }
    var markBtn = document.getElementById('notifMarkAll');
    if (markBtn) markBtn.style.display = 'none';
    if (refreshList) {
      // Re-render so the in-drawer rows drop their "New" pills and
      // bolding — matches the explicit gesture the user just made.
      _notifLoaded = false;
      loadNotifications();
    }
  } catch (err) { /* non-fatal — see JSDoc above */ }
}

// Auto-load on page ready to set the badge
setTimeout(function() { loadNotifications(); }, 800);

// ─── SSE Real-time Notifications ───────────────────────────────
// Previously this handler did two things wrong:
//   1. It set dot.style.display = 'block' but never touched dot.textContent,
//      so the unread *count* on the badge stayed stale until the user
//      refreshed the page (reported April 2026: "export xong không thấy
//      notification, F5 mới thấy").
//   2. It only prepended to the list if the drawer was already open
//      (_notifOpen). Since users almost never have the drawer open when
//      an event fires, the new notification was effectively invisible
//      until the next refresh.
// Fix: on every SSE push, just re-invoke loadNotifications() — it re-
// fetches count + list from /notifications/recent in one round-trip so
// the badge and drawer stay in sync. Tiny flash animation on the bell
// icon gives immediate visual feedback even when the drawer is closed.
(function() {
  var evtSrc;
  try {
    evtSrc = new EventSource('/admin/store/${esc(storeSlug)}/notifications/stream');
    evtSrc.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'connected') return;
        // Re-fetch recent notifications so both the badge count AND the
        // drawer list reflect the new row. loadNotifications is hoisted
        // from the enclosing scope above.
        if (typeof loadNotifications === 'function') {
          loadNotifications();
        }
        // Brief bell flash so the user notices even if the drawer is closed.
        var bellBtn = document.getElementById('notifToggle');
        if (bellBtn) {
          bellBtn.style.transition = 'transform .15s ease';
          bellBtn.style.transform = 'scale(1.15)';
          setTimeout(function() { bellBtn.style.transform = 'scale(1)'; }, 180);
        }
      } catch(err) {}
    };
    evtSrc.onerror = function() {
      // Reconnect silently — EventSource does this automatically
    };
  } catch(err) {}
})();
</script>`
}
