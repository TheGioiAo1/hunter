/**
 * Gbox Platform — Permission Catalog (Phase 7.2)
 *
 * The 6-level admin hierarchy in `./admin-levels.ts` answers "how
 * privileged is this user". This file answers the more useful
 * question: "is this user allowed to perform action X?".
 *
 * Each route still calls `requireLevel()` to enforce a baseline
 * (any merchant tier, any platform tier, etc.), but for the
 * actions that demand a higher bar than the route default it
 * calls `canPerform(ctx, 'shop.delete')` and gets a single boolean
 * back. The catalog below is the ONE place that knows what action
 * needs what level — no scattered `if (level <= 2)` checks.
 *
 * Why a typed string-keyed catalog and not an enum?
 *
 *   - String keys are stable in audit logs and DB rows. If we want
 *     to record "Thai performed shop.delete on shop_42", we need
 *     a stable string identifier, not an enum value that changes
 *     when the file is reordered.
 *   - The `Permission` literal-union type still gives us full IDE
 *     autocomplete + compile-time typo detection.
 *   - Adding a new permission is one line in the PERMISSIONS const.
 *
 * Naming convention:
 *
 *   <scope>.<verb_object>      e.g. shop.invite_staff
 *
 * Scopes:
 *   platform.*  — only the platform tier (god/platform admin) can do these
 *   shop.*      — scoped to a single shop (gated via shopRole)
 *
 * Verbs use snake_case to match SQL audit log conventions and the
 * existing `users.role` enum strings.
 */

import {
  AdminLevel,
  resolveAdminLevel,
  type AdminLevelInput,
} from './admin-levels.js'

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * The full permission catalog. Each entry is the MINIMUM admin level
 * (i.e. lowest level number = highest privilege) required to perform
 * the action. Smaller numbers = more restricted.
 *
 * Order is by scope then alphabetical within each scope. Keep it that
 * way for grep'ability.
 */
export const PERMISSIONS = {
  // ── Platform-tier actions ─────────────────────────────────────────
  // These are only available to people on the platform staff payroll
  // — Thai (god admin) or anyone he promoted to platform admin.

  /** Create another platform-level admin (god admin only). */
  'platform.create_admin': AdminLevel.GOD_ADMIN,
  /** Delete a shop platform-wide (god admin only — destructive). */
  'platform.delete_shop': AdminLevel.GOD_ADMIN,
  /** Edit Stripe/PayPal accounts, plan SKUs, etc. (god admin only). */
  'platform.manage_billing': AdminLevel.GOD_ADMIN,
  /** Rotate platform-wide secrets (god admin only). */
  'platform.rotate_secrets': AdminLevel.GOD_ADMIN,
  /** Read every shop's data (platform admin and up). */
  'platform.view_all_shops': AdminLevel.PLATFORM_ADMIN,
  /** Read the audit log across all shops (platform admin and up). */
  'platform.view_audit_log': AdminLevel.PLATFORM_ADMIN,
  /** Suspend a merchant's shop (platform admin and up). */
  'platform.suspend_shop': AdminLevel.PLATFORM_ADMIN,

  // ── Shop-fatal actions ────────────────────────────────────────────
  // Owner-only because they end the shop or transfer it.

  /** Permanently delete this shop. */
  'shop.delete': AdminLevel.STORE_OWNER,
  /** Transfer ownership of this shop to another user. */
  'shop.transfer_ownership': AdminLevel.STORE_OWNER,
  /** Manage Stripe/PayPal connect for this shop. */
  'shop.manage_billing': AdminLevel.STORE_OWNER,
  /** Cancel a paid plan for this shop. */
  'shop.cancel_subscription': AdminLevel.STORE_OWNER,

  // ── Structural shop actions ───────────────────────────────────────
  // Admin tier — invites, domains, themes, integrations.

  /** Invite a new staff member to this shop. */
  'shop.invite_staff': AdminLevel.STORE_ADMIN,
  /** Remove a staff member from this shop. */
  'shop.remove_staff': AdminLevel.STORE_ADMIN,
  /** Add or remove a custom domain for this shop. */
  'shop.manage_domain': AdminLevel.STORE_ADMIN,
  /** Publish (or roll back) a theme. */
  'shop.publish_theme': AdminLevel.STORE_ADMIN,
  /** Connect a third-party app / OAuth integration. */
  'shop.manage_integrations': AdminLevel.STORE_ADMIN,
  /** Edit shop tax + shipping configuration. */
  'shop.edit_settings': AdminLevel.STORE_ADMIN,

  // ── Routine shop actions ──────────────────────────────────────────
  // Staff tier — the daily-driver permissions.

  /** Read the order list. */
  'shop.view_orders': AdminLevel.STORE_STAFF,
  /** Read the customer list. */
  'shop.view_customers': AdminLevel.STORE_STAFF,
  /** Mark an order as fulfilled, edit shipping. */
  'shop.fulfill_order': AdminLevel.STORE_STAFF,
  /** Refund (within the staff refund cap — owner approval beyond it). */
  'shop.refund_order': AdminLevel.STORE_STAFF,
  /** CRUD on products + variants. */
  'shop.manage_products': AdminLevel.STORE_STAFF,
  /** CRUD on collections. */
  'shop.manage_collections': AdminLevel.STORE_STAFF,
  /** CRUD on inventory levels. */
  'shop.manage_inventory': AdminLevel.STORE_STAFF,
  /** CRUD on discount codes. */
  'shop.manage_discounts': AdminLevel.STORE_STAFF,
  /** Edit page/blog content (NOT theme files — that's STORE_ADMIN). */
  'shop.edit_content': AdminLevel.STORE_STAFF,
} as const satisfies Record<string, AdminLevel>

/** Type-safe permission key. Autocompleted everywhere `Permission` appears. */
export type Permission = keyof typeof PERMISSIONS

// ---------------------------------------------------------------------------
// permissionMinLevel
// ---------------------------------------------------------------------------

/**
 * Returns the minimum admin level required for `permission`. Throws
 * with a loud error on an unknown name — that catches typos at the
 * route-wire-up boundary instead of failing-open at runtime.
 */
export function permissionMinLevel(permission: Permission): AdminLevel {
  const level = PERMISSIONS[permission]
  if (level === undefined) {
    throw new Error(
      `permissionMinLevel: unknown permission "${permission}". ` +
        `Did you forget to add it to PERMISSIONS in permissions.ts?`,
    )
  }
  return level
}

// ---------------------------------------------------------------------------
// canPerform
// ---------------------------------------------------------------------------

/**
 * True when the caller's effective admin level is at least the
 * minimum required by `permission`. Use this inside route handlers
 * for action-level checks beyond the baseline that `requireLevel()`
 * already enforced.
 *
 *   if (!canPerform(req.auth!, 'shop.delete')) {
 *     return res.status(403).json({ error: 'forbidden' })
 *   }
 *
 * For middleware-level enforcement, use `requirePermission()` from
 * `./require-permission.ts`.
 */
export function canPerform(
  ctx: AdminLevelInput,
  permission: Permission,
): boolean {
  const required = permissionMinLevel(permission)
  const actual = resolveAdminLevel(ctx)
  return actual <= required
}
