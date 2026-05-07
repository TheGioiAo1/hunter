/**
 * Gbox Platform — Activity Audit Trail (Phase 2 Step 2.7)
 *
 * Shared types for the generalized activity service. This replaces
 * the auth-only AuditAction union in modules/auth/audit.ts with a
 * full platform-wide taxonomy that covers:
 *
 *   - Authentication (signup, login, password, session)
 *   - Store lifecycle (created, suspended, deleted)
 *   - User mgmt (admin invited, role changed, suspended)
 *   - Catalog mutations (product created, variant updated, deleted)
 *   - Order flow (placed, paid, fulfilled, refunded, cancelled)
 *   - Customer mgmt (created, tagged, exported)
 *   - Finance (payout, refund issued)
 *   - Platform settings (config changed, feature flag toggled)
 *   - Generic "admin action" fallback
 *
 * Why a typed union? So TypeScript catches typos and the admin UI can
 * pick an icon/color per action without a giant switch.
 *
 * Why not enum? TS enums don't serialize cleanly and can't be easily
 * extended at runtime — string union literals are compatible with
 * both DB text columns and a frontend fuzzy filter.
 */

// ---------------------------------------------------------------------------
// Action taxonomy
// ---------------------------------------------------------------------------

export type AuthAction =
  | 'signup_started'
  | 'signup_otp_sent'
  | 'signup_otp_verified'
  | 'signup_completed'
  | 'login_success'
  | 'login_failed'
  | 'login_locked'
  | 'logout'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'password_changed'
  | 'session_revoked'
  | 'all_sessions_revoked'
  | 'otp_failed'
  | 'otp_expired'
  | 'otp_locked'

export type StoreAction =
  | 'store_created'
  | 'store_updated'
  | 'store_suspended'
  | 'store_reactivated'
  | 'store_deleted'
  | 'store_plan_changed'
  | 'store_domain_added'
  | 'store_domain_removed'

export type UserAction =
  | 'user_created'
  | 'user_updated'
  | 'user_suspended'
  | 'user_reactivated'
  | 'user_deleted'
  | 'user_role_changed'
  | 'admin_invited'
  | 'admin_promoted'
  | 'admin_demoted'

export type CatalogAction =
  | 'product_created'
  | 'product_updated'
  | 'product_deleted'
  | 'product_published'
  | 'product_unpublished'
  | 'variant_created'
  | 'variant_updated'
  | 'variant_deleted'
  | 'inventory_adjusted'
  | 'collection_created'
  | 'collection_updated'
  | 'collection_deleted'

export type OrderAction =
  | 'order_placed'
  | 'order_paid'
  | 'order_fulfilled'
  | 'order_shipped'
  | 'order_delivered'
  | 'order_cancelled'
  | 'order_refunded'
  | 'order_partially_refunded'
  | 'order_updated'
  | 'order_note_added'

export type CustomerAction =
  | 'customer_created'
  | 'customer_updated'
  | 'customer_deleted'
  | 'customer_tagged'
  | 'customer_untagged'
  | 'customer_exported'
  | 'customer_marked_spam'

export type FinanceAction =
  | 'payout_created'
  | 'payout_completed'
  | 'payout_failed'
  | 'refund_issued'
  | 'refund_approved'
  | 'refund_rejected'
  | 'dispute_opened'
  | 'dispute_won'
  | 'dispute_lost'

export type PlatformAction =
  | 'platform_config_changed'
  | 'feature_flag_toggled'
  | 'maintenance_mode_enabled'
  | 'maintenance_mode_disabled'

export type ActivityAction =
  | AuthAction
  | StoreAction
  | UserAction
  | CatalogAction
  | OrderAction
  | CustomerAction
  | FinanceAction
  | PlatformAction
  | 'admin_action' // generic fallback

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

/**
 * The kinds of resources the activity trail tracks. The `audit_logs`
 * table has `resource_type` as a free-text column, but this union lets
 * callers pass a typed value and get a link rendered in the timeline.
 */
export type ActivityResourceType =
  | 'auth'
  | 'shop'
  | 'user'
  | 'product'
  | 'variant'
  | 'collection'
  | 'order'
  | 'customer'
  | 'payout'
  | 'refund'
  | 'dispute'
  | 'platform_setting'
  | 'session'

// ---------------------------------------------------------------------------
// Core record types
// ---------------------------------------------------------------------------

/**
 * The input to `recordActivity()`. Everything except `action` is
 * optional — the caller supplies what's known.
 */
export interface RecordActivityInput {
  action: ActivityAction
  /** User who performed the action. null for anonymous or system. */
  actorUserId?: string | null
  /** Shop the action targets. null for platform-level actions. */
  shopId?: string | null
  resourceType?: ActivityResourceType | null
  resourceId?: string | null
  /** Arbitrary structured data. Serialized as jsonb. */
  details?: Record<string, unknown> | null
  /** Actor IP. Optional but recommended for security events. */
  ip?: string | null
}

/**
 * A row read back from the activity service. Joined with `users` to
 * get actor email when available.
 */
export interface ActivityRecord {
  id: string
  action: ActivityAction | string
  actorUserId: string | null
  /**
   * Actor display string. Typically the email; falls back to 'system'
   * when actorUserId is null, or 'deleted user' when the user was
   * removed but the log entry survived (ON DELETE SET NULL).
   */
  actorLabel: string
  shopId: string | null
  resourceType: string | null
  resourceId: string | null
  details: Record<string, unknown> | null
  ipAddress: string | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// Query shape
// ---------------------------------------------------------------------------

export interface ListActivityOptions {
  /** Filter by shop. Pass null for platform-level-only events. */
  shopId?: string | null
  /** Filter by actor. */
  actorUserId?: string | null
  /** Filter by resource (requires both type + id). */
  resourceType?: ActivityResourceType | string
  resourceId?: string
  /** Filter by action name(s). */
  actions?: readonly (ActivityAction | string)[]
  /** ISO timestamp lower bound (inclusive). */
  since?: string
  /** ISO timestamp upper bound (inclusive). */
  until?: string
  /** Cursor from a previous page (opaque string). */
  cursor?: string | null
  /** Page size (clamped to DEFAULT_PAGE_SIZES). */
  pageSize?: number
  /** 'next' (default) or 'prev'. */
  direction?: 'next' | 'prev'
}

// ---------------------------------------------------------------------------
// Action categorization (for UI badges)
// ---------------------------------------------------------------------------

export type ActivityCategory = 'success' | 'danger' | 'warning' | 'info'

/**
 * Categorize an action into one of four badge colors. This is used by
 * the shared activity-timeline UI component to pick a dot color and a
 * badge shade without the caller having to hard-code anything.
 *
 * The matcher is substring-based so it works for both the typed
 * ActivityAction union AND legacy free-text audit_logs rows.
 */
export function categorizeAction(action: string): ActivityCategory {
  const a = action.toLowerCase()

  // Failure / destructive → red.
  if (
    a.includes('fail') ||
    a.includes('delete') ||
    a.includes('suspend') ||
    a.includes('disable') ||
    a.includes('ban') ||
    a.includes('reject') ||
    a.includes('revoke') ||
    a.includes('locked') ||
    a.includes('cancel') ||
    a.includes('lost')
  ) {
    return 'danger'
  }

  // Success / positive → green.
  if (
    a.includes('create') ||
    a.includes('login_success') ||
    a.includes('enable') ||
    a.includes('activate') ||
    a.includes('register') ||
    a.includes('signup') ||
    a.includes('approve') ||
    a.includes('verify') ||
    a.includes('paid') ||
    a.includes('fulfilled') ||
    a.includes('shipped') ||
    a.includes('delivered') ||
    a.includes('completed') ||
    a.includes('won') ||
    a.includes('promoted')
  ) {
    return 'success'
  }

  // Mutation / caution → amber.
  if (
    a.includes('update') ||
    a.includes('edit') ||
    a.includes('modify') ||
    a.includes('change') ||
    a.includes('reset') ||
    a.includes('patch') ||
    a.includes('adjust') ||
    a.includes('refund') ||
    a.includes('demoted')
  ) {
    return 'warning'
  }

  return 'info'
}

/**
 * Turn an action name into a human-readable label.
 * `order_partially_refunded` → `Order partially refunded`
 */
export function humanizeAction(action: string): string {
  if (!action) return ''
  const words = action.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
