/**
 * Gbox Platform — Support staff presets + permission matrix.
 *
 * 3 presets (+ god-admin override) map onto the 22 permission scopes
 * that gate actions in the supporter.gbox.co portal and every mutation
 * in the `@gbox/core/modules/support` service layer.
 *
 * Source of truth: Phase 12.5 spec §10.7 (2026-04-22, locked). If the
 * matrix changes, update this file AND its test — the test asserts
 * every preset/scope pair, so a typo here fails CI loudly.
 *
 * Iron Rule 1: the four "shop data" scopes (orders / customers /
 * revenue / billing) are explicitly `false` for every preset except
 * `god_admin`. Keeping them enumerated makes the deny-list auditable
 * — a future change can't "forget" to lock them down.
 */

import type { SupportAgentPreset } from '@gbox/db/schema/tables.js'

/** All permission scopes gated by the supporter portal. */
export type SupportPermissionScope =
  | 'support:ticket:read'
  | 'support:ticket:reply'
  | 'support:ticket:internal_note'
  | 'support:ticket:claim'
  | 'support:ticket:assign_others'
  | 'support:ticket:priority_change'
  | 'support:ticket:status_change'
  | 'support:ticket:status_change_partial' // L1: open/pending only
  | 'support:ticket:merge'
  | 'support:ticket:delete_message'
  | 'support:canned_replies:manage'
  | 'support:audit:cross_shop'
  | 'support:audit:cross_shop_partial' // L2: assigned tickets only
  | 'support:analytics:self'
  | 'support:analytics:team'
  | 'support:ai:use'
  | 'support:ai:configure'
  | 'support:staff:invite'
  | 'support:staff:manage'
  | 'support:shop:orders_read'
  | 'support:shop:customers_read'
  | 'support:shop:revenue_read'
  | 'support:shop:billing_read'

/** Every scope in a single tuple — used by the test to catch typos. */
export const ALL_SCOPES: readonly SupportPermissionScope[] = [
  'support:ticket:read',
  'support:ticket:reply',
  'support:ticket:internal_note',
  'support:ticket:claim',
  'support:ticket:assign_others',
  'support:ticket:priority_change',
  'support:ticket:status_change',
  'support:ticket:status_change_partial',
  'support:ticket:merge',
  'support:ticket:delete_message',
  'support:canned_replies:manage',
  'support:audit:cross_shop',
  'support:audit:cross_shop_partial',
  'support:analytics:self',
  'support:analytics:team',
  'support:ai:use',
  'support:ai:configure',
  'support:staff:invite',
  'support:staff:manage',
  'support:shop:orders_read',
  'support:shop:customers_read',
  'support:shop:revenue_read',
  'support:shop:billing_read',
] as const

/** Maps every preset → scope → boolean. `true` = allowed. */
export const PERMISSION_MATRIX: Readonly<
  Record<SupportAgentPreset, Readonly<Record<SupportPermissionScope, boolean>>>
> = {
  // -------------------------------------------------------------
  // L1 — front-line triage. Reads + replies on any ticket, can
  // change status only within the `open → pending_*` cluster.
  // Explicitly denied: priority change, assigning others, merging
  // tickets, deleting messages, canned-reply management, team
  // analytics, AI config, staff management, and ALL shop data.
  // -------------------------------------------------------------
  l1_support: {
    'support:ticket:read': true,
    'support:ticket:reply': true,
    'support:ticket:internal_note': true,
    'support:ticket:claim': true,
    'support:ticket:assign_others': false,
    'support:ticket:priority_change': false,
    'support:ticket:status_change': false,
    'support:ticket:status_change_partial': true, // open/pending_* only
    'support:ticket:merge': false,
    'support:ticket:delete_message': false,
    'support:canned_replies:manage': false,
    'support:audit:cross_shop': false,
    'support:audit:cross_shop_partial': false,
    'support:analytics:self': true,
    'support:analytics:team': false,
    'support:ai:use': true,
    'support:ai:configure': false,
    'support:staff:invite': false,
    'support:staff:manage': false,
    'support:shop:orders_read': false,
    'support:shop:customers_read': false,
    'support:shop:revenue_read': false,
    'support:shop:billing_read': false,
  },
  // -------------------------------------------------------------
  // L2 — senior agent. Everything L1 has PLUS: assign others,
  // change priority, full status transitions, merge tickets, manage
  // canned replies. Cross-shop visibility is partial (only tickets
  // assigned to them, via `support:audit:cross_shop_partial`).
  // Still denied: message deletion, team analytics, AI config,
  // staff management, shop data.
  // -------------------------------------------------------------
  l2_support_senior: {
    'support:ticket:read': true,
    'support:ticket:reply': true,
    'support:ticket:internal_note': true,
    'support:ticket:claim': true,
    'support:ticket:assign_others': true,
    'support:ticket:priority_change': true,
    'support:ticket:status_change': true,
    'support:ticket:status_change_partial': true,
    'support:ticket:merge': true,
    'support:ticket:delete_message': false,
    'support:canned_replies:manage': true,
    'support:audit:cross_shop': false,
    'support:audit:cross_shop_partial': true,
    'support:analytics:self': true,
    'support:analytics:team': false,
    'support:ai:use': true,
    'support:ai:configure': false,
    'support:staff:invite': false,
    'support:staff:manage': false,
    'support:shop:orders_read': false,
    'support:shop:customers_read': false,
    'support:shop:revenue_read': false,
    'support:shop:billing_read': false,
  },
  // -------------------------------------------------------------
  // Lead — team manager. Inherits everything L2 has PLUS:
  // unrestricted cross-shop audit, message deletion, team analytics.
  // 2FA is MANDATORY at login (enforced in the auth middleware, not
  // the matrix). Still denied: AI config, staff invites/manage, shop
  // data — those are god-admin-only (Iron Rule 1 data minimization).
  // -------------------------------------------------------------
  lead_support: {
    'support:ticket:read': true,
    'support:ticket:reply': true,
    'support:ticket:internal_note': true,
    'support:ticket:claim': true,
    'support:ticket:assign_others': true,
    'support:ticket:priority_change': true,
    'support:ticket:status_change': true,
    'support:ticket:status_change_partial': true,
    'support:ticket:merge': true,
    'support:ticket:delete_message': true,
    'support:canned_replies:manage': true,
    'support:audit:cross_shop': true,
    'support:audit:cross_shop_partial': true,
    'support:analytics:self': true,
    'support:analytics:team': true,
    'support:ai:use': true,
    'support:ai:configure': false,
    'support:staff:invite': false,
    'support:staff:manage': false,
    'support:shop:orders_read': false,
    'support:shop:customers_read': false,
    'support:shop:revenue_read': false,
    'support:shop:billing_read': false,
  },
  // -------------------------------------------------------------
  // God admin — platform owner. Everything. The only preset that
  // can configure AI, invite/manage staff, and read shop data. 2FA
  // is mandatory by the auth middleware (not this matrix).
  // -------------------------------------------------------------
  god_admin: {
    'support:ticket:read': true,
    'support:ticket:reply': true,
    'support:ticket:internal_note': true,
    'support:ticket:claim': true,
    'support:ticket:assign_others': true,
    'support:ticket:priority_change': true,
    'support:ticket:status_change': true,
    'support:ticket:status_change_partial': true,
    'support:ticket:merge': true,
    'support:ticket:delete_message': true,
    'support:canned_replies:manage': true,
    'support:audit:cross_shop': true,
    'support:audit:cross_shop_partial': true,
    'support:analytics:self': true,
    'support:analytics:team': true,
    'support:ai:use': true,
    'support:ai:configure': true,
    'support:staff:invite': true,
    'support:staff:manage': true,
    'support:shop:orders_read': true,
    'support:shop:customers_read': true,
    'support:shop:revenue_read': true,
    'support:shop:billing_read': true,
  },
}

/** Display labels — shown on the staff-picker in the invite form. */
export const PRESET_LABEL: Readonly<Record<SupportAgentPreset, string>> = {
  l1_support: 'L1 Support',
  l2_support_senior: 'L2 Support (Senior)',
  lead_support: 'Lead Support',
  god_admin: 'God Admin', // iron-rule-5-ok: label rendered only in supporter-staff invite picker (agent-facing); seller UIs never consult PRESET_LABEL for god_admin
}

/**
 * 2FA gate — `true` means the login middleware MUST require a TOTP
 * code on every signin. `recommended` is advisory (log but don't
 * block). `optional` is no enforcement.
 *
 * Per spec §10.7 C5: Lead + god_admin are mandatory; L2 is
 * recommended; L1 is optional (but encouraged). The auth middleware
 * consults `twoFaMode()` below.
 */
export function twoFaMode(preset: SupportAgentPreset): 'optional' | 'recommended' | 'mandatory' {
  switch (preset) {
    case 'l1_support':
      return 'optional'
    case 'l2_support_senior':
      return 'recommended'
    case 'lead_support':
    case 'god_admin': // iron-rule-5-ok: role identifier switch branch, server-side 2FA-gate logic
      return 'mandatory'
  }
}
