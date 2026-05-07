/**
 * Gbox Platform — Staff permission catalog.
 *
 * Phase 9 / PR4. Every permission is a `{resource}:{action}` string
 * stored as-is in `user_shops.permissions_computed`. The catalog below
 * is the single source of truth — the admin UI reads it to render
 * the permission grid, middleware reads it to validate incoming
 * requests, and the role templates below are composed from the same
 * keys so "Admin" is never out of sync with "all permissions".
 *
 * Design notes
 * ------------
 * - Resources map 1:1 to top-level admin nav entries (Shopify parity).
 * - Actions are deliberately coarse (`view` / `manage`) because the
 *   admin UI doesn't meaningfully distinguish create/update/delete at
 *   the middleware layer. A handful of specialty actions exist where
 *   the UX demands them (`orders:refund`, `settings:billing`).
 * - Role templates are closed catalogs, but each staff row may carry
 *   a `permissions` override list; the resolver below unions them
 *   (template ∪ overrides) and subtracts any template-only keys the
 *   override explicitly removes via `-{key}` prefix.
 */

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface PermissionDef {
  key: string
  resource: string
  action: string
  label: string
  description: string
}

export const PERMISSION_CATALOG: readonly PermissionDef[] = Object.freeze([
  // --- Home / dashboard ---------------------------------------------------
  {
    key: 'home:view',
    resource: 'home',
    action: 'view',
    label: 'View dashboard',
    description: 'See the admin home page and summary widgets.',
  },

  // --- Orders -------------------------------------------------------------
  {
    key: 'orders:view',
    resource: 'orders',
    action: 'view',
    label: 'View orders',
    description: 'See the orders list and individual order pages.',
  },
  {
    key: 'orders:manage',
    resource: 'orders',
    action: 'manage',
    label: 'Manage orders',
    description: 'Create, edit, fulfill, cancel, or archive orders.',
  },
  {
    key: 'orders:refund',
    resource: 'orders',
    action: 'refund',
    label: 'Refund orders',
    description: 'Issue refunds and process return requests.',
  },
  {
    key: 'draft_orders:manage',
    resource: 'draft_orders',
    action: 'manage',
    label: 'Manage draft orders',
    description: 'Create, update, and convert draft orders.',
  },

  // --- Products + inventory ----------------------------------------------
  {
    key: 'products:view',
    resource: 'products',
    action: 'view',
    label: 'View products',
    description: 'Browse the product catalog.',
  },
  {
    key: 'products:manage',
    resource: 'products',
    action: 'manage',
    label: 'Manage products',
    description: 'Create, edit, duplicate, archive products and variants.',
  },
  {
    key: 'inventory:manage',
    resource: 'inventory',
    action: 'manage',
    label: 'Manage inventory',
    description: 'Adjust stock levels and manage locations.',
  },
  {
    key: 'collections:manage',
    resource: 'collections',
    action: 'manage',
    label: 'Manage collections',
    description: 'Create and edit smart / manual collections.',
  },
  {
    key: 'gift_cards:manage',
    resource: 'gift_cards',
    action: 'manage',
    label: 'Manage gift cards',
    description: 'Issue, disable, and view gift card balances.',
  },

  // --- Customers + marketing ---------------------------------------------
  {
    key: 'customers:view',
    resource: 'customers',
    action: 'view',
    label: 'View customers',
    description: 'See customer list and individual profiles.',
  },
  {
    key: 'customers:manage',
    resource: 'customers',
    action: 'manage',
    label: 'Manage customers',
    description: 'Edit profiles, tags, and segment memberships.',
  },
  {
    key: 'marketing:manage',
    resource: 'marketing',
    action: 'manage',
    label: 'Manage marketing',
    description: 'Campaigns, abandoned-cart recovery, automations.',
  },
  {
    key: 'discounts:manage',
    resource: 'discounts',
    action: 'manage',
    label: 'Manage discounts',
    description: 'Create, edit, and delete discount codes + automatic rules.',
  },

  // --- Analytics ----------------------------------------------------------
  {
    key: 'analytics:view',
    resource: 'analytics',
    action: 'view',
    label: 'View analytics',
    description: 'Access reports, dashboards, and exports.',
  },

  // --- Content / online store --------------------------------------------
  {
    key: 'content:manage',
    resource: 'content',
    action: 'manage',
    label: 'Manage online store',
    description: 'Pages, blog posts, menus, themes, files.',
  },
  {
    key: 'themes:manage',
    resource: 'themes',
    action: 'manage',
    label: 'Manage themes',
    description: 'Edit theme code, install + publish themes.',
  },

  // --- Shipping / tax / markets ------------------------------------------
  {
    key: 'shipping:manage',
    resource: 'shipping',
    action: 'manage',
    label: 'Manage shipping',
    description: 'Zones, carrier credentials, rates.',
  },
  {
    key: 'tax:manage',
    resource: 'tax',
    action: 'manage',
    label: 'Manage tax',
    description: 'Registrations, rates, nexus configuration.',
  },
  {
    key: 'markets:manage',
    resource: 'markets',
    action: 'manage',
    label: 'Manage markets',
    description: 'Country grouping, presentment currency per region.',
  },

  // --- Settings subdivisions ---------------------------------------------
  {
    key: 'settings:general',
    resource: 'settings',
    action: 'general',
    label: 'General settings',
    description: 'Shop info, units, timezone, order format.',
  },
  {
    key: 'settings:staff',
    resource: 'settings',
    action: 'staff',
    label: 'Manage staff',
    description: 'Invite staff, edit roles + permissions, remove staff.',
  },
  {
    key: 'settings:billing',
    resource: 'settings',
    action: 'billing',
    label: 'Billing',
    description: 'View invoices + manage subscription plan.',
  },
  {
    key: 'settings:security',
    resource: 'settings',
    action: 'security',
    label: 'Security settings',
    description: 'Two-factor, IP allowlist, sign-in history.',
  },
  {
    key: 'settings:alerts',
    resource: 'settings',
    action: 'alerts',
    label: 'Alert preferences',
    description: 'Choose which events email you and which appear in-app.',
  },
  {
    key: 'settings:apps',
    resource: 'settings',
    action: 'apps',
    label: 'Manage apps',
    description: 'Install, configure, and remove third-party apps.',
  },

  // --- Email (Phase 14 PR7 — email hardening) ----------------------------
  //
  // Prior to PR7 the email template editor, suppression list, analytics
  // report, and finance-alerts panel had zero permission checks — any
  // `staff` could edit templates or unsuppress addresses. These 5 keys
  // seal that gap (`email:view` for read surfaces, `email:manage_*` for
  // the three write surfaces, `email:send_test` for the test-send button).
  //
  // Admin gets all 5 (via filter in ADMIN_TEMPLATE); staff gets `view`
  // only; limited gets nothing. Owner bypass via the role-check
  // shortcut in `staffHasPermission`.
  {
    key: 'email:view',
    resource: 'email',
    action: 'view',
    label: 'View email settings',
    description: 'See email templates list, analytics, and suppression list.',
  },
  {
    key: 'email:manage_templates',
    resource: 'email',
    action: 'manage_templates',
    label: 'Edit email templates',
    description:
      'Save template overrides (subject, HTML body, plain-text body) and reset to defaults.',
  },
  {
    key: 'email:manage_suppression',
    resource: 'email',
    action: 'manage_suppression',
    label: 'Manage email suppression list',
    description: 'Unsuppress bounced or complained email addresses.',
  },
  {
    key: 'email:manage_alerts',
    resource: 'email',
    action: 'manage_alerts',
    label: 'Manage finance alerts',
    description:
      'Toggle finance email alerts (refunds, failed payments, fraud flags, out-of-stock).',
  },
  {
    key: 'email:send_test',
    resource: 'email',
    action: 'send_test',
    label: 'Send test email',
    description:
      'Send a rendered template to the signed-in user\u2019s email address for preview.',
  },
] as const)

export const PERMISSION_KEYS = Object.freeze(
  PERMISSION_CATALOG.map((p) => p.key),
)

/**
 * A permission key is valid iff it appears in the catalog.
 */
export function isValidPermissionKey(key: unknown): key is string {
  return typeof key === 'string' && (PERMISSION_KEYS as readonly string[]).includes(key)
}

// ---------------------------------------------------------------------------
// Role templates
// ---------------------------------------------------------------------------

/**
 * Built-in roles. `owner` is reserved for the shop creator and has
 * implicit all-permissions; it's never stored as a custom permission
 * list. `admin` and `staff` are the two invitable templates. `limited`
 * is an override of `staff` that only keeps the permissions the
 * inviter explicitly selected.
 */
export type StaffRole = 'owner' | 'admin' | 'staff' | 'limited'

export const STAFF_ROLES: readonly StaffRole[] = ['owner', 'admin', 'staff', 'limited']

export function isValidStaffRole(role: unknown): role is StaffRole {
  return typeof role === 'string' && (STAFF_ROLES as readonly string[]).includes(role)
}

/**
 * Admins get everything except billing (which is owner-only by default,
 * although the owner may grant it to an admin explicitly via the
 * override list).
 */
const ADMIN_TEMPLATE: readonly string[] = Object.freeze(
  PERMISSION_KEYS.filter((k) => k !== 'settings:billing'),
)

/**
 * Default staff template — can see/manage day-to-day operations but
 * no settings or analytics exports. Inviter can extend via overrides.
 *
 * PR7: adds `email:view` so staff can see email analytics + template
 * list (read-only). Staff do NOT get edit/suppression/alerts/send-test
 * by default — those require admin or an explicit override.
 */
const STAFF_TEMPLATE: readonly string[] = Object.freeze([
  'home:view',
  'orders:view',
  'orders:manage',
  'products:view',
  'products:manage',
  'inventory:manage',
  'customers:view',
  'customers:manage',
  'collections:manage',
  'gift_cards:manage',
  'content:manage',
  'email:view',
])

const LIMITED_TEMPLATE: readonly string[] = Object.freeze(['home:view'])

/**
 * Template for each role. `owner` is handled specially by
 * `resolvePermissions` (returns *all* keys) since the owner is the
 * sole row in `user_shops` with `role='owner'`.
 */
const ROLE_TEMPLATES: Record<Exclude<StaffRole, 'owner'>, readonly string[]> = {
  admin: ADMIN_TEMPLATE,
  staff: STAFF_TEMPLATE,
  limited: LIMITED_TEMPLATE,
}

/**
 * Resolve the effective permission list for a staff row.
 *
 *   - owner        → every key in the catalog
 *   - admin/staff/limited → template for the role, union with
 *     override keys (plain key = add), minus any `-key` overrides
 *     that explicitly remove template keys.
 *
 * Overrides that don't appear in the catalog are silently dropped so a
 * stale DB row doesn't leak an unknown permission. The return value is
 * de-duplicated and sorted for stable comparison.
 */
export function resolvePermissions(
  role: StaffRole,
  overrides: readonly string[] | null | undefined,
): string[] {
  if (role === 'owner') {
    return [...PERMISSION_KEYS].sort()
  }
  const template = ROLE_TEMPLATES[role] ?? []
  const granted = new Set<string>(template)
  for (const raw of overrides ?? []) {
    if (typeof raw !== 'string') continue
    if (raw.startsWith('-')) {
      const k = raw.slice(1)
      if (isValidPermissionKey(k)) granted.delete(k)
    } else if (isValidPermissionKey(raw)) {
      granted.add(raw)
    }
  }
  return Array.from(granted).sort()
}

/**
 * Fast O(1) permission check. Accepts the resolved-permissions array
 * (from `user_shops.permissions_computed`) and the required key.
 * The `'owner'` role shortcut is honoured: if `role='owner'` we
 * auto-allow without consulting the array.
 */
export function staffHasPermission(
  role: StaffRole | string | null | undefined,
  resolved: readonly string[] | null | undefined,
  required: string,
): boolean {
  if (role === 'owner') return true
  if (!resolved || resolved.length === 0) return false
  return resolved.includes(required)
}

/**
 * Filter a candidate permission list down to the keys that are valid
 * in the catalog. Used when sanitising input before persisting.
 */
export function sanitisePermissionList(
  input: readonly unknown[] | null | undefined,
): string[] {
  if (!Array.isArray(input)) return []
  const out = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('-')) {
      if (isValidPermissionKey(trimmed.slice(1))) out.add(trimmed)
    } else if (isValidPermissionKey(trimmed)) {
      out.add(trimmed)
    }
  }
  return Array.from(out).sort()
}

/**
 * Return the permissions for a role template (without overrides).
 * Useful for the admin UI when showing "default permissions for
 * staff role".
 */
export function permissionsForRole(role: StaffRole): string[] {
  if (role === 'owner') return [...PERMISSION_KEYS].sort()
  return [...(ROLE_TEMPLATES[role] ?? [])].sort()
}
