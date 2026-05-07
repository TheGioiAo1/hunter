/**
 * God Admin — Enterprise Layout (Dark + Light)
 *
 * Phase 2 Step 2.1 upgrade:
 *   - Was: dark-only with hard-coded `--god-*` tokens.
 *   - Now: dark AND light themes via `[data-theme="dark|light"]`
 *     CSS variable scopes. Theme choice is persisted in the
 *     `gbox_theme` cookie (see `@gbox/core/modules/ui/theme.ts`) and
 *     read server-side so the correct theme arrives on first paint
 *     — no FOUC.
 *
 * 260px sidebar + 56px topbar + content area.
 * Navigation grouped by category (A-K).
 * Responsive: sidebar collapses on mobile.
 *
 * Triết lý: "clone giống hệt Shopify" — persistent theme toggle
 * matches Shopify admin. "power-ful hơn Shopify nhờ Claude" — uses
 * the same shared `@gbox/core/ui` module as store-admin so the two
 * surfaces stay visually in lock-step.
 */

import type { Theme } from '../../../../packages/core/src/modules/ui/theme.js'
import {
  readThemeFromRequest,
  themeInitScript,
  themeToggleScriptBody,
  themeToggleButton,
  themeToggleButtonCss,
} from '../../../../packages/core/src/modules/ui/theme.js'
import { gboxLogo } from '../../../../packages/core/src/modules/ui/logo.js'
import { emptyStateCss } from '../../../../packages/core/src/modules/ui/empty-state.js'
import { skeletonCss } from '../../../../packages/core/src/modules/ui/skeleton.js'
import {
  flashContainerHtml,
  toastRuntimeScriptBody,
  toastCss,
} from '../../../../packages/core/src/modules/ui/toast.js'
import {
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
} from '../../../../packages/core/src/modules/ui/keyboard.js'
import { activityTimelineCss } from '../../../../packages/core/src/modules/ui/activity-timeline.js'
import { modal } from '../../../../packages/core/src/modules/ui/modal.js'
import {
  skipToMainLink,
  ariaCurrent,
  a11yCss,
  liveRegionHtml,
} from '../../../../packages/core/src/modules/ui/a11y.js'
import { formFieldCss } from '../../../../packages/core/src/modules/ui/form-field.js'
import {
  notificationCenterCss,
  notificationCenterScriptBody,
} from '../../../../packages/core/src/modules/ui/notification-center.js'
import { errorPageCss } from '../../../../packages/core/src/modules/ui/error-page.js'

// Re-export the helper so route handlers can call
// `godLayout.readTheme(req)` without knowing the import path.
export { readThemeFromRequest }

export interface GodLayoutOptions {
  title: string
  /** Current user email for the top bar */
  userEmail: string
  /** Current user name (optional) */
  userName?: string
  /** Whether current user is the Default God Admin */
  isDefaultAdmin?: boolean
  /** Active navigation path (e.g., '/god-admin/stores') */
  activePath: string
  /** Page content HTML */
  content: string
  /**
   * Current theme. If omitted, defaults to `dark` — but route handlers
   * SHOULD pass this in by calling `readThemeFromRequest(req)` so the
   * first paint matches the user's saved preference. Missing this is
   * not a crash, just a brief flash of dark before the init script
   * corrects it.
   */
  theme?: Theme
}

// ---------------------------------------------------------------------------
// Sidebar Navigation Structure
// ---------------------------------------------------------------------------

interface NavItem {
  label: string
  href: string
  badge?: string
}

interface NavGroup {
  id: string
  label: string
  icon: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    items: [
      { label: 'Dashboard', href: '/god-admin' },
      { label: 'Real-time Metrics', href: '/god-admin/metrics' },
      { label: 'Platform Analytics', href: '/god-admin/analytics/platform' },
      { label: 'System Health', href: '/god-admin/health-check' },
      { label: 'Alerts', href: '/god-admin/alerts' },
      { label: 'Activity Feed', href: '/god-admin/activity' },
    ],
  },
  {
    id: 'stores',
    label: 'Stores',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    items: [
      { label: 'All Stores', href: '/god-admin/stores' },
    ],
  },
  {
    id: 'users',
    label: 'Users',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    items: [
      { label: 'All Users', href: '/god-admin/users' },
      { label: 'Customers', href: '/god-admin/customers' },
    ],
  },
  {
    id: 'orders',
    label: 'Orders',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
    items: [
      { label: 'All Orders', href: '/god-admin/orders' },
      { label: 'Order Analytics', href: '/god-admin/orders/analytics' },
    ],
  },
  {
    id: 'fulfillment',
    label: 'Fulfillment',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13" rx="2"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    items: [
      { label: 'Fulfillment Center', href: '/god-admin/fulfillments' },
      { label: 'Lenful Queue', href: '/god-admin/fulfillments/lenful-queue' },
      { label: 'Lenful Catalog', href: '/god-admin/fulfillments/catalog' },
      { label: 'Lenful Designs', href: '/god-admin/fulfillments/designs' },
      { label: 'Lenful Routing', href: '/god-admin/fulfillments/routing' },
      { label: 'Lenful Wallet', href: '/god-admin/fulfillments/wallet' },
      { label: 'Lenful API Log', href: '/god-admin/fulfillments/api-log' },
      { label: 'Lenful Credentials', href: '/god-admin/fulfillments/credentials' },
      { label: 'Legacy Gbox Master', href: '/god-admin/integrations/gbox-legacy' },
      { label: 'Refund Requests', href: '/god-admin/refund-requests' },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    items: [
      { label: 'Financial Overview', href: '/god-admin/finance' },
      { label: 'Transaction Log', href: '/god-admin/finance/transactions' },
      { label: 'Plan Requests', href: '/god-admin/plan-requests' },
    ],
  },
  {
    id: 'staff-ai',
    label: 'Staff & AI',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93"/><path d="M8.56 2.75a4 4 0 0 0-1.5 6.87"/><circle cx="12" cy="14" r="3"/><path d="M3 21v-1a7 7 0 0 1 7-7h4a7 7 0 0 1 7 7v1"/></svg>',
    items: [
      { label: 'Staff Management', href: '/god-admin/staff' },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    items: [
      { label: 'Audit & Security', href: '/god-admin/security' },
      { label: 'Login History', href: '/god-admin/security/logins' },
      { label: 'Suspicious Activity', href: '/god-admin/security/suspicious' },
      { label: 'Session Tokens', href: '/god-admin/security/tokens' },
      { label: 'My Two-Factor Auth', href: '/god-admin/settings/2fa' },
      { label: 'IP Allowlist', href: '/god-admin/settings/ip-allowlist' },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    items: [
      { label: 'Pages & Blogs', href: '/god-admin/content' },
    ],
  },
  {
    id: 'platform',
    label: 'Platform',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    items: [
      { label: 'Platform Config', href: '/god-admin/config' },
      // Phase 12.5 PR4 — Anthropic integration + budget for support AI.
      { label: 'Support AI', href: '/god-admin/settings/ai' },
      // Phase 14 PR1 — Shopify-class email system (95-template registry +
      // deliveries + opt-out + live send tests). God-admin-only because
      // it surfaces the platform-scope (god_admin audience) rows too.
      { label: 'Email Center', href: '/god-admin/email' },
      // Phase 14 PR6 — 9 god-admin-audience alerts (incident / churn /
      // fraud / etc). Recipient editing + test-send + manual policy-
      // violation trigger.
      { label: 'Platform Alerts', href: '/god-admin/platform-alerts' },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    items: [
      { label: 'Clone Jobs', href: '/god-admin/clone-jobs' },
    ],
  },
  {
    id: 'developer',
    label: 'Developer',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    items: [
      { label: 'API Tokens', href: '/god-admin/developer/tokens' },
      { label: 'Webhooks', href: '/god-admin/developer/webhooks' },
    ],
  },
  {
    // Phase 9.2 PR-3 — pair-programmer surface (Default God Admin only;
    // route handlers still enforce that). Kept at the bottom of the nav
    // because it is an internal tool, not a customer-facing category.
    id: 'agent',
    label: 'AI Agent',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="4"/></svg>',
    items: [
      { label: 'Chat', href: '/god-admin/agent/chat' },
      { label: 'Sessions', href: '/god-admin/agent/sessions' },
      { label: 'Health', href: '/god-admin/agent/health' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Phase 2 Step 2.6 — Command Palette + Keyboard Shortcuts
// ---------------------------------------------------------------------------
//
// One source of truth drives both the Cmd+K palette and the ? cheatsheet.
// Commands flow from the same nav groups above plus a few high-traffic
// god-admin shortcuts (create admin, platform config, logout). Per Iron
// Rule #2 these only render inside god-admin pages — store-admin has its
// own list in seller-layout.ts.

const GOD_COMMANDS: CommandItem[] = [
  // Navigation — mirrors NAV_GROUPS plus a couple of extras.
  { id: 'nav-dashboard', label: 'Dashboard', href: '/god-admin', group: 'Navigation', shortcut: 'g d', keywords: ['home', 'overview'] },
  { id: 'nav-metrics', label: 'Real-time Metrics', href: '/god-admin/metrics', group: 'Navigation', keywords: ['live', 'analytics'] },
  { id: 'nav-platform-analytics', label: 'Platform Analytics', href: '/god-admin/analytics/platform', group: 'Navigation', keywords: ['platform', 'analytics', 'overview', 'revenue', 'shops', 'leaderboard', 'growth', 'health'] },
  { id: 'nav-health', label: 'System Health', href: '/god-admin/health-check', group: 'Navigation', keywords: ['status', 'uptime'] },
  { id: 'nav-alerts', label: 'Alerts', href: '/god-admin/alerts', group: 'Navigation' },
  { id: 'nav-activity', label: 'Activity Feed', href: '/god-admin/activity', group: 'Navigation', keywords: ['audit', 'events'] },
  { id: 'nav-stores', label: 'Stores', href: '/god-admin/stores', group: 'Navigation', shortcut: 'g s', keywords: ['merchants', 'shops'] },
  { id: 'nav-users', label: 'Users', href: '/god-admin/users', group: 'Navigation', shortcut: 'g u', keywords: ['accounts', 'people'] },
  { id: 'nav-customers', label: 'Customers', href: '/god-admin/customers', group: 'Navigation', shortcut: 'g b', keywords: ['shoppers', 'buyers', 'clients'] },
  { id: 'nav-orders', label: 'Orders', href: '/god-admin/orders', group: 'Navigation', shortcut: 'g o' },
  { id: 'nav-fulfillments', label: 'Fulfillment Center', href: '/god-admin/fulfillments', group: 'Navigation', keywords: ['shipping'] },
  { id: 'nav-lenful-queue', label: 'Lenful Queue', href: '/god-admin/fulfillments/lenful-queue', group: 'Navigation', keywords: ['lenful', 'push', 'pod'] },
  { id: 'nav-lenful-catalog', label: 'Lenful Catalog', href: '/god-admin/fulfillments/catalog', group: 'Navigation', keywords: ['mapping', 'product', 'sku', 'lenful'] },
  { id: 'nav-lenful-designs', label: 'Lenful Designs', href: '/god-admin/fulfillments/designs', group: 'Navigation', keywords: ['design', 'artwork', 'lenful'] },
  { id: 'nav-lenful-routing', label: 'Lenful Routing', href: '/god-admin/fulfillments/routing', group: 'Navigation', keywords: ['rules', 'auto-push', 'lenful'] },
  { id: 'nav-lenful-wallet', label: 'Lenful Wallet', href: '/god-admin/fulfillments/wallet', group: 'Navigation', keywords: ['balance', 'funds', 'lenful'] },
  { id: 'nav-lenful-apilog', label: 'Lenful API Log', href: '/god-admin/fulfillments/api-log', group: 'Navigation', keywords: ['log', 'debug', 'lenful'] },
  { id: 'nav-lenful-creds', label: 'Lenful Credentials', href: '/god-admin/fulfillments/credentials', group: 'Navigation', keywords: ['lenful', 'api', 'token'] },
  { id: 'nav-legacy-gbox', label: 'Legacy Gbox Master', href: '/god-admin/integrations/gbox-legacy', group: 'Navigation', keywords: ['legacy', 'gbox', 'master', 'api-product', 'integration'] },
  { id: 'nav-refunds', label: 'Refund Requests', href: '/god-admin/refund-requests', group: 'Navigation', keywords: ['returns'] },
  { id: 'nav-finance', label: 'Financial Overview', href: '/god-admin/finance', group: 'Navigation', shortcut: 'g f', keywords: ['money', 'revenue', 'billing'] },
  { id: 'nav-transactions', label: 'Transaction Log', href: '/god-admin/finance/transactions', group: 'Navigation' },
  { id: 'nav-staff', label: 'Staff Management', href: '/god-admin/staff', group: 'Navigation' },
  { id: 'nav-security', label: 'Audit & Security', href: '/god-admin/security', group: 'Navigation', keywords: ['logs', 'suspicious'] },
  { id: 'nav-logins', label: 'Login History', href: '/god-admin/security/logins', group: 'Navigation' },
  { id: 'nav-suspicious', label: 'Suspicious Activity', href: '/god-admin/security/suspicious', group: 'Navigation' },
  { id: 'nav-sessions', label: 'Session Tokens', href: '/god-admin/security/tokens', group: 'Navigation' },
  { id: 'nav-2fa', label: 'My Two-Factor Auth', href: '/god-admin/settings/2fa', group: 'Navigation', keywords: ['2fa', 'totp', 'mfa', 'authenticator', 'security'] },
  { id: 'nav-ip-allowlist', label: 'IP Allowlist', href: '/god-admin/settings/ip-allowlist', group: 'Navigation', keywords: ['ip', 'allowlist', 'cidr', 'firewall', 'security', 'lockdown'] },
  { id: 'nav-content', label: 'Pages & Blogs', href: '/god-admin/content', group: 'Navigation', keywords: ['cms'] },
  { id: 'nav-config', label: 'Platform Config', href: '/god-admin/config', group: 'Navigation', shortcut: 'g c', keywords: ['settings', 'preferences'] },
  { id: 'nav-support-ai', label: 'Support AI', href: '/god-admin/settings/ai', group: 'Navigation', keywords: ['anthropic', 'claude', 'budget', 'ai', 'sonnet', 'opus', 'suggest', 'summarize'] },
  { id: 'nav-email', label: 'Email Center', href: '/god-admin/email', group: 'Navigation', keywords: ['email', 'templates', 'delivery', 'send', 'smtp', 'gmail', 'unsubscribe', 'preferences', 'registry'] },
  { id: 'nav-platform-alerts', label: 'Platform Alerts', href: '/god-admin/platform-alerts', group: 'Navigation', keywords: ['alerts', 'platform', 'incident', 'churn', 'fraud', 'policy', 'integration', 'digest', 'roundup', 'dedup', 'recipients'] },
  { id: 'nav-tokens', label: 'API Tokens', href: '/god-admin/developer/tokens', group: 'Navigation', keywords: ['keys', 'developer'] },
  { id: 'nav-webhooks', label: 'Webhooks', href: '/god-admin/developer/webhooks', group: 'Navigation' },

  // AI Agent (Default God Admin only — handlers enforce access).
  { id: 'nav-agent-chat', label: 'Agent Chat', href: '/god-admin/agent/chat', group: 'AI Agent', shortcut: 'g a', keywords: ['pair programmer', 'claude', 'assistant', 'ai'] },
  { id: 'nav-agent-sessions', label: 'Agent Sessions', href: '/god-admin/agent/sessions', group: 'AI Agent', keywords: ['history', 'replay', 'claude'] },
  { id: 'nav-agent-health', label: 'Agent Health', href: '/god-admin/agent/health', group: 'AI Agent', keywords: ['sidecar', 'circuit breaker', 'killswitch', 'uptime'] },

  // Admin actions — only visible to Default God Admin but still
  // cheap to list here; route handlers enforce access.
  { id: 'act-admin-list', label: 'God Admin List', href: '/god-admin/admins', group: 'Admins', keywords: ['users', 'team'] },
  { id: 'act-admin-create', label: 'Create Admin', href: '/god-admin/admins/create', group: 'Admins', keywords: ['invite', 'new'] },

  // Session / account.
  { id: 'act-logout', label: 'Log out', href: '/god-admin/logout', group: 'Account', keywords: ['sign out', 'quit'] },
]

const GOD_SHORTCUTS: KeyboardShortcut[] = [
  { keys: '⌘ K', description: 'Open command palette', group: 'General' },
  { keys: 'Ctrl K', description: 'Open command palette (Windows/Linux)', group: 'General' },
  { keys: '?', description: 'Show keyboard shortcuts', group: 'General' },
  { keys: 'Esc', description: 'Close palette or modal', group: 'General' },

  { keys: 'g d', description: 'Go to Dashboard', group: 'Navigation' },
  { keys: 'g s', description: 'Go to Stores', group: 'Navigation' },
  { keys: 'g u', description: 'Go to Users', group: 'Navigation' },
  { keys: 'g o', description: 'Go to Orders', group: 'Navigation' },
  { keys: 'g f', description: 'Go to Finance', group: 'Navigation' },
  { keys: 'g b', description: 'Go to Customers (buyers)', group: 'Navigation' },
  { keys: 'g c', description: 'Go to Platform Config', group: 'Navigation' },
  { keys: 'g a', description: 'Go to AI Agent Chat', group: 'Navigation' },

  { keys: '↑', description: 'Move selection up (palette)', group: 'Palette' },
  { keys: '↓', description: 'Move selection down (palette)', group: 'Palette' },
  { keys: 'Enter', description: 'Select current result', group: 'Palette' },
]

const GOD_GO_BINDINGS: Record<string, string> = {
  d: '/god-admin',
  s: '/god-admin/stores',
  u: '/god-admin/users',
  b: '/god-admin/customers',
  o: '/god-admin/orders',
  f: '/god-admin/finance',
  c: '/god-admin/config',
  a: '/god-admin/agent/chat',
}

// ---------------------------------------------------------------------------
// Layout Renderer
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderNavItem(item: NavItem, activePath: string): string {
  const isActive = activePath === item.href ||
    (item.href !== '/god-admin' && activePath.startsWith(item.href))
  const activeClass = isActive ? ' nav-item-active' : ''
  const badgeHtml = item.badge ? `<span class="nav-badge">${item.badge}</span>` : ''

  return `<a href="${item.href}" class="nav-item${activeClass}"${ariaCurrent(isActive)}>${item.label}${badgeHtml}</a>`
}

function renderAdminsSection(activePath: string): string {
  const isActive = activePath.startsWith('/god-admin/admins')
  const openAttr = isActive ? ' open' : ''
  const listActive = activePath === '/god-admin/admins' ? ' nav-item-active' : ''
  const createActive = activePath === '/god-admin/admins/create' ? ' nav-item-active' : ''

  return `
    <div style="border-top: 1px solid var(--god-border-light); margin-top: 8px; padding-top: 4px;">
      <details class="nav-group"${openAttr}>
        <summary class="nav-group-header" style="color: #f97316;">
          <span class="nav-group-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15l-2-2m0 0l-2 2m2-2v6m8-8a4 4 0 1 0-8 0 4 4 0 0 0 8 0z"/><path d="M3 21v-2a4 4 0 0 1 4-4h4"/><circle cx="12" cy="7" r="4"/></svg></span>
          <span class="nav-group-label">Admins</span>
          <svg class="nav-chevron" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </summary>
        <div class="nav-group-items">
          <a href="/god-admin/admins" class="nav-item${listActive}"${ariaCurrent(listActive !== '')}>God Admin List</a>
          <a href="/god-admin/admins/create" class="nav-item${createActive}"${ariaCurrent(createActive !== '')}>Create Admin</a>
        </div>
      </details>
    </div>`
}

function renderNavGroups(activePath: string): string {
  return NAV_GROUPS.map(group => {
    const isGroupActive = group.items.some(item =>
      activePath === item.href ||
      (item.href !== '/god-admin' && activePath.startsWith(item.href))
    )
    const openAttr = isGroupActive ? ' open' : ''

    const itemsHtml = group.items.map(item => renderNavItem(item, activePath)).join('')

    return `
      <details class="nav-group"${openAttr}>
        <summary class="nav-group-header">
          <span class="nav-group-icon" aria-hidden="true">${group.icon}</span>
          <span class="nav-group-label">${group.label}</span>
          <svg class="nav-chevron" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </summary>
        <div class="nav-group-items">
          ${itemsHtml}
        </div>
      </details>`
  }).join('')
}

export function godLayout(opts: GodLayoutOptions): string {
  const { title, userEmail, userName, isDefaultAdmin, activePath, content } = opts
  const theme: Theme = opts.theme ?? 'dark'
  const sidebarNav = renderNavGroups(activePath)
  const adminsNav = isDefaultAdmin ? renderAdminsSection(activePath) : ''
  const displayName = userName ? escapeHtml(userName) : escapeHtml(userEmail)
  const adminBadge = isDefaultAdmin
    ? '<span class="user-role-badge default">Default Admin</span>'
    : '<span class="user-role-badge">God Admin</span>'

  // Phase 2 Step 2.1 — shared brand mark. Swap `variant: 'combined'`
  // to 'mark' if you want the square without the "gbox" wordmark.
  const brandMark = gboxLogo({
    variant: 'combined',
    size: 28,
    idSuffix: 'god-topbar',
  })

  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Gbox God Admin</title>
  ${themeInitScript()}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --sidebar-w: 260px;
      --topbar-h: 56px;
    }

    /* ================================================================
       Dark theme tokens (default) — scoped to [data-theme="dark"] so
       light mode can override via the [data-theme="light"] block below.
       The ":root, [data-theme=dark]" combo means the tokens still
       apply before JS has a chance to set data-theme, matching the
       pre-Phase-2 dark-only behavior.
       ================================================================ */
    :root,
    [data-theme="dark"] {
      --god-bg: #0f172a;
      --god-bg-elevated: #1e293b;
      --god-bg-hover: #334155;
      --god-sidebar: #0c1222;
      --god-sidebar-hover: #1a2540;
      --god-topbar: #111827;
      --god-border: #1e293b;
      --god-border-light: #334155;
      --god-accent: #3b82f6;
      --god-accent-hover: #2563eb;
      --god-accent-bg: rgba(59, 130, 246, 0.12);

      /* Text */
      --god-text: #e2e8f0;
      --god-text-secondary: #94a3b8;
      --god-text-muted: #64748b;
      --god-text-dim: #475569;

      /* Status */
      --green: #22c55e;
      --green-bg: rgba(34, 197, 94, 0.12);
      --yellow: #eab308;
      --yellow-bg: rgba(234, 179, 8, 0.12);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.12);
      --blue: #3b82f6;
      --blue-bg: rgba(59, 130, 246, 0.12);

      /* Shared UI helpers (consumed by themeToggleButtonCss) */
      --gbox-accent: var(--god-accent);
    }

    /* ================================================================
       Light theme tokens — applied when [data-theme="light"] is set
       on <html> by the flicker-prevent script or the toggle button.
       Every value here mirrors a dark-theme counterpart above, so
       adding a new dark token without a light override would just
       cascade the dark value (and be obvious on first paint).
       ================================================================ */
    [data-theme="light"] {
      --god-bg: #f8fafc;
      --god-bg-elevated: #ffffff;
      --god-bg-hover: #f1f5f9;
      --god-sidebar: #ffffff;
      --god-sidebar-hover: #f1f5f9;
      --god-topbar: #ffffff;
      --god-border: #e2e8f0;
      --god-border-light: #cbd5e1;
      --god-accent: #2563eb;
      --god-accent-hover: #1d4ed8;
      --god-accent-bg: rgba(37, 99, 235, 0.08);

      --god-text: #0f172a;
      --god-text-secondary: #334155;
      --god-text-muted: #64748b;
      --god-text-dim: #94a3b8;

      --green: #16a34a;
      --green-bg: rgba(22, 163, 74, 0.10);
      --yellow: #ca8a04;
      --yellow-bg: rgba(202, 138, 4, 0.10);
      --red: #dc2626;
      --red-bg: rgba(220, 38, 38, 0.10);
      --blue: #2563eb;
      --blue-bg: rgba(37, 99, 235, 0.10);

      --gbox-accent: var(--god-accent);
    }

    ${themeToggleButtonCss()}
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

    /* Light theme needs subtle shadows on the sidebar + topbar because
       the background colors are close — without borders/shadows the
       sidebar would visually merge into the content area. */
    [data-theme="light"] .sidebar {
      box-shadow: 1px 0 0 var(--god-border);
    }
    [data-theme="light"] .topbar {
      box-shadow: 0 1px 0 var(--god-border);
    }
    [data-theme="light"] .nav-item-active {
      background: var(--god-accent-bg);
      color: var(--god-accent);
    }
    [data-theme="light"] .nav-group-header {
      color: var(--god-text-secondary);
    }
    [data-theme="light"] .sidebar-logo,
    [data-theme="light"] .topbar-title {
      color: var(--god-text);
    }
    [data-theme="light"] .topbar-user-name {
      color: var(--god-text-secondary);
    }
    [data-theme="light"] .data-table tbody tr:hover {
      background: rgba(37, 99, 235, 0.04);
    }
    [data-theme="light"] .user-role-badge.default {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.12), rgba(249, 115, 22, 0.12));
      color: #b45309;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--god-bg);
      color: var(--god-text);
      min-height: 100vh;
    }

    /* Sidebar */
    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      width: var(--sidebar-w);
      height: 100vh;
      background: var(--god-sidebar);
      border-right: 1px solid var(--god-border);
      color: var(--god-text-secondary);
      overflow-y: auto;
      z-index: 100;
      transition: transform 0.25s ease;
    }

    .sidebar::-webkit-scrollbar { width: 4px; }
    .sidebar::-webkit-scrollbar-track { background: transparent; }
    .sidebar::-webkit-scrollbar-thumb { background: var(--god-border-light); border-radius: 4px; }

    .sidebar-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--god-border);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .sidebar-logo {
      display: inline-flex;
      align-items: center;
      color: #ffffff;
    }

    .sidebar-logo .gbox-logo-combined,
    .sidebar-logo svg {
      display: inline-flex;
      align-items: center;
    }

    .god-badge {
      background: linear-gradient(135deg, #ef4444, #f97316);
      color: #fff;
      font-size: 9px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .sidebar-nav { padding: 8px 0; }

    /* Nav Groups */
    .nav-group {
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }

    .nav-group summary { list-style: none; }
    .nav-group summary::-webkit-details-marker { display: none; }

    .nav-group-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 20px;
      cursor: pointer;
      color: var(--god-text-muted);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: color 0.15s;
      user-select: none;
    }

    .nav-group-header:hover { color: var(--god-text-secondary); }

    .nav-group-icon { display: flex; align-items: center; flex-shrink: 0; }
    .nav-group-label { flex: 1; }

    .nav-chevron { transition: transform 0.2s; flex-shrink: 0; }
    .nav-group[open] .nav-chevron { transform: rotate(180deg); }

    .nav-group-items { padding: 0 0 6px 0; }

    .nav-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 20px 8px 48px;
      color: var(--god-text-muted);
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      transition: color 0.15s, background 0.15s;
      border-left: 3px solid transparent;
    }

    .nav-item:hover {
      color: var(--god-text);
      background: var(--god-sidebar-hover);
    }

    .nav-item-active {
      color: #ffffff;
      background: var(--god-accent-bg);
      border-left-color: var(--god-accent);
    }

    .nav-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--god-border-light);
      color: var(--god-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Topbar */
    .topbar {
      position: fixed;
      top: 0;
      left: var(--sidebar-w);
      right: 0;
      height: var(--topbar-h);
      background: var(--god-topbar);
      border-bottom: 1px solid var(--god-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      z-index: 90;
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .topbar-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--god-text);
    }

    .topbar-right {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .topbar-user {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .topbar-user-name {
      font-size: 13px;
      color: var(--god-text-secondary);
      font-weight: 500;
    }

    .user-role-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--blue-bg);
      color: var(--blue);
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .user-role-badge.default {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.15), rgba(249, 115, 22, 0.15));
      color: #f97316;
    }

    .topbar-logout {
      font-size: 13px;
      color: var(--red);
      text-decoration: none;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 6px;
      transition: background 0.15s;
    }

    .topbar-logout:hover { background: var(--red-bg); }

    .hamburger {
      display: none;
      background: none;
      border: none;
      color: var(--god-text-secondary);
      cursor: pointer;
      padding: 4px;
    }

    /* Main Content */
    .main {
      margin-left: var(--sidebar-w);
      margin-top: var(--topbar-h);
      padding: 24px;
      min-height: calc(100vh - var(--topbar-h));
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--god-bg-elevated);
      border: 1px solid var(--god-border);
      border-radius: 12px;
      padding: 20px;
    }

    .stat-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--god-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--god-text);
      line-height: 1.2;
    }

    .stat-change { font-size: 12px; font-weight: 600; margin-top: 4px; }
    .stat-change.up { color: var(--green); }
    .stat-change.down { color: var(--red); }

    .section-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--god-text);
      margin-bottom: 16px;
    }

    /* Cards */
    .card {
      background: var(--god-bg-elevated);
      border: 1px solid var(--god-border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .card-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--god-text);
    }

    /* Tables */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .data-table th {
      text-align: left;
      padding: 10px 12px;
      font-weight: 600;
      color: var(--god-text-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--god-border-light);
      white-space: nowrap;
    }

    .data-table td {
      padding: 10px 12px;
      color: var(--god-text-secondary);
      border-bottom: 1px solid var(--god-border);
      vertical-align: middle;
    }

    .data-table tbody tr:hover {
      background: rgba(59, 130, 246, 0.04);
    }

    .data-table a {
      color: var(--god-accent);
      text-decoration: none;
      font-weight: 500;
    }

    .data-table a:hover { text-decoration: underline; }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      white-space: nowrap;
    }

    .badge-green { background: var(--green-bg); color: var(--green); }
    .badge-yellow { background: var(--yellow-bg); color: var(--yellow); }
    .badge-red { background: var(--red-bg); color: var(--red); }
    .badge-blue { background: var(--blue-bg); color: var(--blue); }
    .badge-gray { background: rgba(100, 116, 139, 0.12); color: var(--god-text-muted); }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      text-decoration: none;
      gap: 6px;
    }

    .btn:active { transform: scale(0.98); }

    .btn-primary { background: var(--god-accent); color: #ffffff; }
    .btn-primary:hover { background: var(--god-accent-hover); }

    .btn-danger { background: var(--red); color: #ffffff; }
    .btn-danger:hover { background: #dc2626; }

    .btn-secondary {
      background: var(--god-bg-hover);
      color: var(--god-text-secondary);
      border: 1px solid var(--god-border-light);
    }
    .btn-secondary:hover { background: var(--god-border-light); }

    .btn-sm { padding: 5px 10px; font-size: 12px; }

    /* Search & Filters */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .search-input {
      padding: 8px 14px;
      border: 1.5px solid var(--god-border-light);
      border-radius: 8px;
      font-size: 13px;
      font-family: inherit;
      background: var(--god-bg);
      color: var(--god-text);
      min-width: 240px;
      outline: none;
      transition: border-color 0.15s;
    }

    .search-input:focus { border-color: var(--god-accent); }
    .search-input::placeholder { color: var(--god-text-dim); }

    .filter-select {
      padding: 8px 12px;
      border: 1.5px solid var(--god-border-light);
      border-radius: 8px;
      font-size: 13px;
      font-family: inherit;
      background: var(--god-bg);
      color: var(--god-text-secondary);
      outline: none;
      cursor: pointer;
    }

    .filter-select:focus { border-color: var(--god-accent); }

    /* Info row */
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid var(--god-border);
      font-size: 14px;
    }

    .info-row:last-child { border-bottom: none; }
    .info-label { color: var(--god-text-muted); font-weight: 500; }
    .info-value { color: var(--god-text); font-weight: 600; }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--god-text-muted);
    }

    .empty-state-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.5; }
    .empty-state-text { font-size: 15px; }

    /* Action buttons group */
    .action-group { display: flex; gap: 8px; flex-wrap: wrap; }

    /* Page header */
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }

    .page-header h1 {
      font-size: 22px;
      font-weight: 700;
      color: var(--god-text);
    }

    /* Two-column layout */
    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }

    @media (max-width: 900px) {
      .two-col { grid-template-columns: 1fr; }
    }

    /* Mono text */
    .mono {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 12px;
      color: var(--god-text-muted);
    }

    /* Responsive */
    @media (max-width: 768px) {
      .sidebar { transform: translateX(-100%); }
      .sidebar.open { transform: translateX(0); }
      .topbar { left: 0; }
      .main { margin-left: 0; }
      .hamburger { display: block; }
      .stats-grid { grid-template-columns: 1fr 1fr; }
      .toolbar { flex-direction: column; align-items: stretch; }
      .search-input { min-width: 100%; }
      .data-table { display: block; overflow-x: auto; }
    }

    @media (max-width: 480px) {
      .stats-grid { grid-template-columns: 1fr; }
    }

    /* Overlay for mobile sidebar */
    .sidebar-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: rgba(0,0,0,0.6);
      z-index: 99;
    }

    .sidebar-overlay.active { display: block; }
  </style>
</head>
<body>
  <!-- Phase 2 Step 2.8: WCAG 2.4.1 Skip to main content — the very
       first focusable element, jumps past sidebar/topbar to <main>. -->
  ${skipToMainLink('main-content')}

  <!-- Phase 2 Admin Polish section 2.5: global aria-live region.
       Pages can write to the #gbox-announce element via
       textContent = '...' to make assistive tech announce form
       errors, undo states, etc. Toasts already carry their own
       aria-live so they do not need this. -->
  ${liveRegionHtml('gbox-announce', 'polite')}

  <!-- Sidebar Overlay (mobile) -->
  <div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>

  <!-- Sidebar -->
  <aside class="sidebar" id="sidebar" aria-label="God admin sidebar">
    <div class="sidebar-header">
      <div class="sidebar-logo">${brandMark}</div>
      <span class="god-badge">GOD ADMIN</span>
    </div>
    <nav class="sidebar-nav" aria-label="Primary navigation">
      ${sidebarNav}
      ${adminsNav}
    </nav>
  </aside>

  <!-- Top Bar -->
  <header class="topbar">
    <div class="topbar-left">
      <button class="hamburger" onclick="toggleSidebar()" aria-label="Toggle navigation menu" aria-controls="sidebar">
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      <span class="topbar-title">${escapeHtml(title)}</span>
    </div>
    <div class="topbar-right">
      ${themeToggleButton({ theme })}
      <div class="topbar-user">
        <span class="topbar-user-name">${displayName}</span>
        ${adminBadge}
      </div>
      <a href="/god-admin/logout" class="topbar-logout">Logout</a>
    </div>
  </header>

  <!-- Main Content -->
  <main class="main" id="main-content" tabindex="-1">
    ${content}
  </main>

  <!-- Phase 2 Step 2.3: toast container (consumed by the runtime
       script below; server-side pages can also set a gbox_flash
       cookie via buildFlashCookie() to pop a toast on the next render). -->
  ${flashContainerHtml()}

  <!-- Phase 2 Step 2.6: command palette (Cmd+K) and keyboard
       shortcuts cheatsheet (?). Both are hidden by default; the
       runtime below wires the keybindings. -->
  ${commandPaletteHtml({ placeholder: 'Jump to a page, setting, or action...' })}
  ${modal({
    id: 'gboxShortcutsModal',
    title: 'Keyboard shortcuts',
    description: 'Press ⌘K / Ctrl+K to open the command palette.',
    body: keyboardShortcutsHtml(GOD_SHORTCUTS),
    actions: [{ label: 'Close', kind: 'primary', close: true }],
  })}

  <script>
    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarOverlay').classList.toggle('active');
    }
    function closeSidebar() {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarOverlay').classList.remove('active');
    }
    ${themeToggleScriptBody()}
    ${toastRuntimeScriptBody()}
    ${modalRuntimeScriptBody()}
    ${bulkRuntimeScriptBody()}
    ${keyboardRuntimeScriptBody({
      commands: GOD_COMMANDS,
      shortcutsModalId: 'gboxShortcutsModal',
      goToBindings: GOD_GO_BINDINGS,
    })}
    ${notificationCenterScriptBody()}
  </script>
</body>
</html>`
}
