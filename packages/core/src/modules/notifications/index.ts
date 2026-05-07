/**
 * Gbox Platform — Notifications Module (Phase 2 Step 2.11)
 *
 * Barrel for the notification center stack. Consumers go through this
 * single entry point so swapping the in-memory store for a DB-backed
 * one later is a one-line change.
 */

export type {
  Notification,
  NewNotification,
  NotificationKind,
  NotificationCategory,
  NotificationStore,
  NotificationSummary,
  ListNotificationsOptions,
} from './types.js'

export { MemoryNotificationStore } from './memory-store.js'
