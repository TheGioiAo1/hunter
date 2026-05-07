/**
 * Gbox Platform — In-memory Notification Store (Phase 2 Step 2.11)
 *
 * Implements `NotificationStore` with a plain Map keyed by id. Used
 * by tests and by early bring-up before the DB schema lands.
 *
 * Semantics intentionally match the target Postgres implementation:
 *   - list() returns newest-first by createdAt
 *   - markRead is idempotent (marking an already-read row succeeds)
 *   - summary() reads total + unread in one pass
 *
 * Not thread-safe (we're in Node with a single event loop, so the
 * distinction doesn't apply inside a request lifecycle).
 */

import type {
  Notification,
  NotificationStore,
  NewNotification,
  ListNotificationsOptions,
  NotificationSummary,
} from './types.js'

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

let idCounter = 0

function generateId(): string {
  idCounter += 1
  return `notif_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

// ---------------------------------------------------------------------------
// MemoryNotificationStore
// ---------------------------------------------------------------------------

export class MemoryNotificationStore implements NotificationStore {
  private readonly rows = new Map<string, Notification>()

  /** Primarily for tests — wipes the store. */
  clear(): void {
    this.rows.clear()
  }

  async create(input: NewNotification): Promise<Notification> {
    const row: Notification = {
      id: generateId(),
      userId: input.userId,
      kind: input.kind,
      category: input.category,
      title: input.title,
      message: input.message,
      link: input.link,
      shopId: input.shopId ?? null,
      read: false,
      createdAt: new Date().toISOString(),
    }
    this.rows.set(row.id, row)
    return row
  }

  async list(
    userId: string,
    opts: ListNotificationsOptions = {},
  ): Promise<Notification[]> {
    const unreadOnly = opts.unreadOnly === true
    const category = opts.category
    const limit = clampLimit(opts.limit ?? 20)
    const offset = Math.max(0, Math.floor(opts.offset ?? 0))

    const matches: Notification[] = []
    for (const row of this.rows.values()) {
      if (row.userId !== userId) continue
      if (unreadOnly && row.read) continue
      if (category && row.category !== category) continue
      matches.push(row)
    }
    // Newest first.
    matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return matches.slice(offset, offset + limit)
  }

  async get(id: string): Promise<Notification | null> {
    return this.rows.get(id) ?? null
  }

  async markRead(id: string): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row) return false
    if (row.read) return true // idempotent
    row.read = true
    return true
  }

  async markAllRead(userId: string): Promise<number> {
    let n = 0
    for (const row of this.rows.values()) {
      if (row.userId === userId && !row.read) {
        row.read = true
        n += 1
      }
    }
    return n
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id)
  }

  async summary(userId: string): Promise<NotificationSummary> {
    let total = 0
    let unread = 0
    for (const row of this.rows.values()) {
      if (row.userId !== userId) continue
      total += 1
      if (!row.read) unread += 1
    }
    return { total, unread }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 20
  return Math.max(1, Math.min(100, Math.floor(value)))
}
