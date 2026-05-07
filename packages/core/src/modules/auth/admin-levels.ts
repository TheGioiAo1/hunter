/**
 * Gbox Platform — Admin Level Hierarchy (Phase 0 Rule 2)
 *
 * Single source of truth for the 6-level admin hierarchy defined in
 * CLAUDE.md Rule 2. Every middleware / route that needs to gate on
 * "is this user at least a Store Admin?" calls `resolveAdminLevel()`
 * instead of re-implementing the rule.
 *
 * The raw database model already encodes this hierarchy in two fields,
 * so this module is a pure normalization layer (no DB writes, no
 * migration). The hierarchy collapses two orthogonal axes —
 * platform-role (`users.role` + `users.is_default_admin`) and
 * per-shop-role (`user_shops.role`) — into one ordinal enum:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Level 0  GOD_ADMIN                           │ users.is_default_admin=true
 *   │ Level 1  PLATFORM_ADMIN                      │ users.role='owner' (non-default) / 'admin'
 *   │ Level 2  STORE_OWNER                         │ user_shops.role='owner'
 *   │ Level 3  STORE_ADMIN                         │ user_shops.role='admin'
 *   │ Level 4  STORE_STAFF                         │ user_shops.role in ('staff','limited')
 *   │ Level 5  CUSTOMER                            │ (customer_auth module — not this file)
 *   └──────────────────────────────────────────────┘
 *
 * Lower number = more privileged. `hasAtLeastLevel(user, level)` is
 * the universal gate:
 *
 *   if (!hasAtLeastLevel(ctx, AdminLevel.STORE_ADMIN)) return 403
 *
 * The customer level (5) is excluded on purpose — customer auth lives
 * in a completely separate table + module. Callers that need to gate
 * on "is merchant" should use `isMerchant(user)`.
 *
 * Design notes (owner rule: "clone giống hệt shopify"):
 *   - Shopify uses a numeric StaffMemberPermission enum + an
 *     `isOwner` flag; we do the same shape here.
 *   - God Admin is the analog of the Shopify Plus "Organization Owner"
 *     — it trumps every per-store role and cannot be demoted.
 *   - The `limited` per-shop role maps to STAFF because Shopify's
 *     "limited staff" still sits at the same effective access level
 *     as staff — the difference is the permissions bitmap, not the
 *     role level.
 */

// ---------------------------------------------------------------------------
// Enum — ordinal so numeric comparisons work
// ---------------------------------------------------------------------------

export enum AdminLevel {
  GOD_ADMIN = 0,
  PLATFORM_ADMIN = 1,
  STORE_OWNER = 2,
  STORE_ADMIN = 3,
  STORE_STAFF = 4,
  CUSTOMER = 5,
}

/** Human-friendly name for logging / audit UIs. */
export const ADMIN_LEVEL_NAMES: Record<AdminLevel, string> = {
  [AdminLevel.GOD_ADMIN]: 'God Admin', // iron-rule-5-ok: label rendered only inside god-admin audit UI; seller UIs filter GOD_ADMIN entries before lookup
  [AdminLevel.PLATFORM_ADMIN]: 'Platform Admin',
  [AdminLevel.STORE_OWNER]: 'Store Owner',
  [AdminLevel.STORE_ADMIN]: 'Store Admin',
  [AdminLevel.STORE_STAFF]: 'Store Staff',
  [AdminLevel.CUSTOMER]: 'Customer',
}

// ---------------------------------------------------------------------------
// Input shape — everything the resolver needs in one object so callers
// don't have to know the exact DB column names.
// ---------------------------------------------------------------------------

export interface AdminLevelInput {
  /** users.role — 'owner' | 'admin' | 'staff' | other (future). */
  userRole: string | null | undefined
  /** users.is_default_admin — only true for the seeded God Admin row. */
  isDefaultAdmin: boolean | null | undefined
  /**
   * user_shops.role for the shop the request is scoped to, or null if
   * there is no shop context (e.g. accounts.gbox.co). Known values:
   * 'owner' | 'admin' | 'staff' | 'limited'.
   */
  shopRole?: string | null | undefined
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Compute the effective admin level for a user. The rule is
 * deterministic and case-insensitive:
 *
 *   1. `is_default_admin=true`                                  → GOD_ADMIN
 *   2. `users.role` is 'owner' or 'admin' (non-default)         → PLATFORM_ADMIN
 *   3. `user_shops.role='owner'`                                → STORE_OWNER
 *   4. `user_shops.role='admin'`                                → STORE_ADMIN
 *   5. `user_shops.role in ('staff','limited')`                 → STORE_STAFF
 *   6. everything else                                          → CUSTOMER
 *
 * Returns CUSTOMER (the lowest level) if `input` is empty or both
 * fields are nullish — this is the safest default (a route that
 * requires at least STORE_STAFF will refuse an empty session).
 */
export function resolveAdminLevel(input: AdminLevelInput): AdminLevel {
  // Guard: empty input → customer.
  if (!input) return AdminLevel.CUSTOMER

  // Step 1 — God Admin (highest). Cannot be overridden by any per-shop role.
  if (input.isDefaultAdmin === true) {
    return AdminLevel.GOD_ADMIN
  }

  const userRole = (input.userRole ?? '').toString().trim().toLowerCase()

  // Step 2 — Platform-level admin (non-default). Both 'owner' and 'admin'
  // at the top of the users table are platform admins when the user is
  // NOT scoped to a specific shop.
  if (userRole === 'owner' || userRole === 'admin') {
    // A platform admin who is ALSO browsing a specific shop keeps the
    // platform-admin level (they can do anything a store owner can).
    return AdminLevel.PLATFORM_ADMIN
  }

  // Step 3–5 — Per-shop role.
  const shopRole = (input.shopRole ?? '').toString().trim().toLowerCase()
  if (shopRole === 'owner') return AdminLevel.STORE_OWNER
  if (shopRole === 'admin') return AdminLevel.STORE_ADMIN
  if (shopRole === 'staff' || shopRole === 'limited') {
    return AdminLevel.STORE_STAFF
  }

  // Default — no merchant access at all.
  return AdminLevel.CUSTOMER
}

// ---------------------------------------------------------------------------
// Predicates — sugar around resolveAdminLevel
// ---------------------------------------------------------------------------

/**
 * True when the user has at least the privilege of `required`.
 * Remember: SMALLER level number = MORE privilege.
 *
 * Example:
 *   // Allow store staff and up.
 *   if (!hasAtLeastLevel(ctx, AdminLevel.STORE_STAFF)) return res.status(403).end()
 */
export function hasAtLeastLevel(
  input: AdminLevelInput,
  required: AdminLevel,
): boolean {
  const actual = resolveAdminLevel(input)
  return actual <= required
}

/**
 * True for any merchant role (God / Platform / Store Owner/Admin/Staff).
 * False for anonymous, customer, or malformed input. Use this when a
 * route should be accessible to any merchant tier but not to
 * customers.
 */
export function isMerchant(input: AdminLevelInput): boolean {
  const level = resolveAdminLevel(input)
  return level < AdminLevel.CUSTOMER
}

/**
 * True ONLY for the seeded default God Admin. Use this for routes
 * that must be locked to Thai specifically (platform billing,
 * danger-zone operations like deleting another admin, rotating the
 * master secret, etc.).
 */
export function isGodAdmin(input: AdminLevelInput): boolean {
  return resolveAdminLevel(input) === AdminLevel.GOD_ADMIN
}

/**
 * Humans-first label — used in session tooltips and audit logs.
 */
export function describeAdminLevel(input: AdminLevelInput): string {
  return ADMIN_LEVEL_NAMES[resolveAdminLevel(input)]
}
