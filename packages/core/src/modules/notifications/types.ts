/**
 * Gbox Platform — Notification Center Types (Phase 2 Step 2.11)
 *
 * Notifications differ from flash toasts (`@gbox/core/modules/ui/toast`)
 * in three ways that matter for the architecture:
 *
 *   1. Persistence.  Toasts live in a single-shot cookie and vanish
 *      after the next render. Notifications are stored per-user in
 *      a real store and survive navigation / page reload / logout.
 *   2. Reading state. Toasts are fire-and-forget. Notifications are
 *      marked read/unread so the bell icon can show an unread badge.
 *   3. Source.  Toasts are triggered by the user's OWN action ("saved",
 *      "deleted"). Notifications arrive asynchronously from other
 *      actors — another admin, a billing job, a security alert.
 *
 * Storage-agnostic by design: every service function takes a
 * `NotificationStore` instance, so tests use the in-memory store and
 * production uses whatever's hooked up (Postgres via Kysely, Redis,
 * etc.) without the service layer caring.
 */

/**
 * Severity / color of a notification. Mirrors the toast kinds so
 * designers can reuse the same icon/color palette.
 */
export type NotificationKind = 'info' | 'success' | 'warning' | 'danger'

/**
 * Top-level grouping for filtering the inbox. The category is stored
 * as a free string so vertical-specific notifications ("inventory",
 * "marketing") can join the enum later without a migration.
 */
export type NotificationCategory =
  | 'system'
  | 'billing'
  | 'security'
  | 'order'
  | 'inventory'
  | 'marketing'
  | 'team'
  | 'other'

/**
 * A single notification as stored and rendered. `createdAt` is an
 * ISO 8601 string so it's JSON-safe and sortable as-is.
 */
export interface Notification {
  /** Unique id — UUID from the store, not user-supplied. */
  id: string
  /** User the notification is addressed to. */
  userId: string
  /** Severity for styling. */
  kind: NotificationKind
  /** Group bucket for inbox filters. */
  category: NotificationCategory
  /** Short headline displayed in the drawer. */
  title: string
  /** Optional detail body. Plain text — no HTML. */
  message?: string
  /** Optional click-through URL. */
  link?: string
  /** True when the user has seen this row. */
  read: boolean
  /** ISO timestamp the notification was created. */
  createdAt: string
  /**
   * Optional shop scope. Set for store-admin-side notifications so
   * the god-admin inbox can filter by store.
   */
  shopId?: string | null
}

/**
 * Creation input — the store fills in `id`, `createdAt`, and `read`.
 */
export interface NewNotification {
  userId: string
  kind: NotificationKind
  category: NotificationCategory
  title: string
  message?: string
  link?: string
  shopId?: string | null
}

/**
 * Options for paginated inbox listing.
 */
export interface ListNotificationsOptions {
  /** Only return unread notifications. */
  unreadOnly?: boolean
  /** Filter by category. */
  category?: NotificationCategory
  /** Max results — clamps to [1, 100], defaults to 20. */
  limit?: number
  /** Skip N rows. Simple offset pagination — inbox is small. */
  offset?: number
}

/**
 * Summary counts for the topbar bell badge.
 */
export interface NotificationSummary {
  total: number
  unread: number
}

/**
 * Storage-agnostic interface. Implementations ship in
 * `./memory-store.ts` (for tests + early bring-up) and later in
 * a DB-backed module once the schema lands.
 */
export interface NotificationStore {
  create(input: NewNotification): Promise<Notification>
  list(
    userId: string,
    opts?: ListNotificationsOptions,
  ): Promise<Notification[]>
  get(id: string): Promise<Notification | null>
  markRead(id: string): Promise<boolean>
  markAllRead(userId: string): Promise<number>
  remove(id: string): Promise<boolean>
  summary(userId: string): Promise<NotificationSummary>
}
