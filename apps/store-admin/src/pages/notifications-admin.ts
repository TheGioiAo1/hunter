/**
 * Store Admin — Notifications Center
 *
 * Full-page notification management: list, mark read, mark all read.
 * Shows: type icon, title, message, timestamp, read/unread badge.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  typesForCategory,
  type NotificationCategory,
} from '@gbox/core/modules/notifications/service.js'

// ---------------------------------------------------------------------------
// Category filter — the 8 buckets inferCategory uses. Kept local so the
// UI file can drive its own label + query-slug + order decisions without
// reaching back into the service.
// ---------------------------------------------------------------------------
const CATEGORY_TABS: Array<{ slug: NotificationCategory; label: string }> = [
  { slug: 'orders',    label: 'Orders' },
  { slug: 'inventory', label: 'Inventory' },
  { slug: 'customers', label: 'Customers' },
  { slug: 'billing',   label: 'Billing' },
  { slug: 'reviews',   label: 'Reviews' },
  { slug: 'marketing', label: 'Marketing' },
  { slug: 'system',    label: 'System' },
  { slug: 'other',     label: 'Other' },
]
const CATEGORY_SLUGS = new Set<string>(CATEGORY_TABS.map((t) => t.slug))

/**
 * Build a SQL WHERE fragment that restricts a notifications query to a
 * single category. Handles the legacy-row fallback the same way
 * `getNotifications` in the service does: rows with a non-null
 * `category` column match directly, rows with NULL category match via
 * `type IN (...)`. `other` has no legacy types so for that bucket we
 * just check `category = 'other'` (pre-065 rows never show up because
 * they weren't explicitly tagged, which is fine — admins who care can
 * re-tag them manually).
 */
function applyCategoryFilter<T>(query: any, category: NotificationCategory): any {
  const typeMatches = typesForCategory(category)
  return query.where((eb: any) => {
    if (typeMatches.length === 0) {
      return eb('category', '=', category)
    }
    return eb.or([
      eb('category', '=', category),
      eb.and([
        eb('category', 'is', null),
        eb('type', 'in', typeMatches),
      ]),
    ])
  })
}

// ─── GET: Notification List ────────────────────────────────────

export async function getNotifications(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1)
  const perPage = 30
  const offset = (page - 1) * perPage
  const filter = (req.query.filter as string || '').trim() // 'unread' | ''
  const categoryRaw = (req.query.category as string || '').trim()
  const category: NotificationCategory | '' = CATEGORY_SLUGS.has(categoryRaw)
    ? (categoryRaw as NotificationCategory)
    : ''
  const marked = req.query.marked === '1'

  // Build the base query once (shop scope + read/category filters), then
  // branch it into three concurrent queries: the page of rows, the
  // filtered count for that view, and the global-unread counter that
  // drives the header badge (always shop-scoped, never category-scoped).
  let baseQuery: any = db.selectFrom('notifications').where('shop_id', '=', store.id)
  if (filter === 'unread') baseQuery = baseQuery.where('read', '=', false)
  if (category) baseQuery = applyCategoryFilter(baseQuery, category)

  const [notifications, totalResult, unreadResult, categoryCountRows] = await Promise.all([
    baseQuery
      .select([
        'id', 'type', 'title', 'message', 'read',
        'resource_type', 'resource_id', 'created_at',
        'category', 'link',
      ])
      .orderBy('created_at', 'desc')
      .limit(perPage)
      .offset(offset)
      .execute(),

    baseQuery
      .select(db.fn.count('id').as('count'))
      .executeTakeFirst(),

    db.selectFrom('notifications')
      .select(db.fn.count('id').as('count'))
      .where('shop_id', '=', store.id)
      .where('read', '=', false)
      .executeTakeFirst(),

    // Per-category counts for the tab row. One query per tab would
    // produce 8 round-trips, so we do a GROUP BY and stitch the result
    // into a Map<category, count>. The read/unread filter applies here
    // too so the counts on the tab bar match what the user will see
    // when they click through.
    (() => {
      let q: any = db
        .selectFrom('notifications')
        .select(['category', db.fn.count('id').as('count')])
        .where('shop_id', '=', store.id)
      if (filter === 'unread') q = q.where('read', '=', false)
      return q.groupBy('category').execute()
    })(),
  ])

  const totalCount = Number(totalResult?.count ?? 0)
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))
  const unreadCount = Number(unreadResult?.count ?? 0)

  // Build Map<category, count>. Rows with NULL category are collapsed
  // into their inferred bucket via a second pass so pre-065 rows still
  // show up on the right tab. This is a small client-side pass over
  // the aggregated rows — worst case 8 categories + 1 null row.
  const categoryCounts = new Map<NotificationCategory, number>()
  for (const tab of CATEGORY_TABS) categoryCounts.set(tab.slug, 0)
  for (const row of categoryCountRows as any[]) {
    const c = row.category as NotificationCategory | null
    const n = Number(row.count ?? 0)
    if (c && categoryCounts.has(c)) {
      categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + n)
    } else if (!c) {
      // NULL category — we'd need to know the types to split this by
      // bucket. Aggregating per-type is one more query we'd rather not
      // do on every page load, so for the tab-count display we lump
      // legacy rows into "other". The tab bar under-counts the legacy
      // buckets slightly but the filtered list itself (which uses
      // `applyCategoryFilter` with the legacy OR) shows the right rows.
      categoryCounts.set('other', (categoryCounts.get('other') ?? 0) + n)
    }
  }

  const csrfField = csrfHiddenField(req.csrfToken!)

  const typeIcon = (type: string): string => {
    switch (type) {
      case 'order': return '&#128230;'
      case 'product': return '&#128230;'
      case 'customer': return '&#128100;'
      case 'payment': return '&#128176;'
      case 'shipping': return '&#128666;'
      case 'alert': return '&#9888;'
      case 'info': return '&#8505;'
      case 'success': return '&#9989;'
      default: return '&#128276;'
    }
  }

  // Query-string bits that have to be preserved when building other
  // links on this page (pagination, tab switches). Filter + category
  // are orthogonal; the user can have both set at once.
  const qsParts: string[] = []
  if (filter) qsParts.push(`filter=${encodeURIComponent(filter)}`)
  if (category) qsParts.push(`category=${encodeURIComponent(category)}`)
  const qsSuffix = qsParts.length ? `&${qsParts.join('&')}` : ''

  // Build category tab row. "All categories" tab first, then one tab
  // per bucket with its count (0-count tabs stay visible so sellers
  // can see at a glance that a bucket is currently empty).
  const allCategoriesQs = filter ? `?filter=${encodeURIComponent(filter)}` : ''
  const categoryTabs = [
    `<a href="${base}/notifications${allCategoriesQs}"
        class="btn btn-sm ${!category ? 'btn-primary' : 'btn-outline'}"
        style="text-decoration:none">All categories</a>`,
    ...CATEGORY_TABS.map((tab) => {
      const count = categoryCounts.get(tab.slug) ?? 0
      const qs = `?category=${encodeURIComponent(tab.slug)}${filter ? `&filter=${encodeURIComponent(filter)}` : ''}`
      const active = category === tab.slug
      return `<a href="${base}/notifications${qs}"
        class="btn btn-sm ${active ? 'btn-primary' : 'btn-outline'}"
        style="text-decoration:none">${esc(tab.label)} (${count})</a>`
    }),
  ].join('')

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Notifications</h1>
        <p class="page-subtitle">${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}</p>
      </div>
      <div style="display:flex;gap:8px">
        ${unreadCount > 0 ? `
          <form method="POST" action="${base}/notifications/mark-all-read" style="display:inline">
            ${csrfField}
            ${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
            <button type="submit" class="btn btn-outline btn-sm">${category ? `Mark "${esc(category)}" as read` : 'Mark all as read'}</button>
          </form>
        ` : ''}
      </div>
    </div>

    ${marked ? `
      <div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-success);font-size:13px">
        Notifications marked as read.
      </div>
    ` : ''}

    <!-- READ STATE TABS -->
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <a href="${base}/notifications${category ? `?category=${encodeURIComponent(category)}` : ''}"
         class="btn btn-sm ${!filter ? 'btn-primary' : 'btn-outline'}"
         style="text-decoration:none">All (${totalCount})</a>
      <a href="${base}/notifications?filter=unread${category ? `&category=${encodeURIComponent(category)}` : ''}"
         class="btn btn-sm ${filter === 'unread' ? 'btn-primary' : 'btn-outline'}"
         style="text-decoration:none">Unread (${unreadCount})</a>
    </div>

    <!-- CATEGORY TABS -->
    <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">
      ${categoryTabs}
    </div>

    <!-- NOTIFICATION LIST -->
    <div class="card">
      <div class="card-header">
        <span>Notifications</span>
        <span style="font-size:12px;color:var(--s-text-dim)">${totalCount} total</span>
      </div>
      <div class="card-body" style="padding:0">
        ${notifications.length > 0 ? `
          <div style="display:flex;flex-direction:column">
            ${notifications.map((n: any) => {
              const ts = new Date(n.created_at as string)
              const timeStr = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              const isUnread = !n.read
              // Category badge — prefer the stored category, fall back
              // to the (still accurate) inferred one for legacy rows.
              const cat = (n.category as string | null) || ''
              // Deep-link to the resource when the notification carries
              // a link (Phase 8 PR4). We only accept same-origin paths
              // starting with a single slash as a defence against an
              // open-redirect if the link column ever gets populated
              // with something untrusted.
              const safeLink = typeof n.link === 'string' && n.link.startsWith('/') && !n.link.startsWith('//')
                ? n.link
                : ''
              return `
                <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid var(--s-border);${isUnread ? 'background:rgba(99,102,241,.06)' : ''}">
                  <div style="font-size:20px;flex-shrink:0;width:32px;text-align:center;margin-top:2px">${typeIcon(n.type)}</div>
                  <div style="flex:1;min-width:0">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap">
                      <span style="font-weight:${isUnread ? '700' : '500'};font-size:14px;color:var(--s-text)">${esc(n.title)}</span>
                      ${isUnread ? '<span class="badge badge-info" style="font-size:10px">New</span>' : ''}
                      <span class="badge badge-neutral" style="font-size:10px">${esc(n.type)}</span>
                      ${cat ? `<span class="badge badge-neutral" style="font-size:10px;opacity:.7">${esc(cat)}</span>` : ''}
                    </div>
                    ${n.message ? `<div style="font-size:13px;color:var(--s-text-dim);margin-bottom:4px">${esc(n.message)}</div>` : ''}
                    <div style="font-size:11px;color:var(--s-text-muted)">${timeStr}${n.resource_type ? ` &middot; ${esc(n.resource_type)}` : ''}</div>
                  </div>
                  <div style="display:flex;gap:6px;flex-shrink:0;align-items:center">
                    ${safeLink ? `<a href="${esc(safeLink)}" class="btn btn-outline btn-sm" style="font-size:11px;text-decoration:none">View</a>` : ''}
                    ${isUnread ? `
                      <form method="POST" action="${base}/notifications/mark-read">
                        ${csrfField}
                        <input type="hidden" name="notification_id" value="${esc(n.id)}">
                        <button type="submit" class="btn btn-outline btn-sm" style="font-size:11px" title="Mark as read">&#10003;</button>
                      </form>
                    ` : ''}
                  </div>
                </div>
              `
            }).join('')}
          </div>

          ${totalPages > 1 ? `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--s-border);font-size:13px;color:var(--s-text-dim)">
              <span>Page ${page} of ${totalPages}</span>
              <div style="display:flex;gap:4px">
                ${page > 1
                  ? `<a href="${base}/notifications?page=${page - 1}${qsSuffix}" class="btn btn-outline btn-sm">&laquo; Previous</a>`
                  : `<span class="btn btn-outline btn-sm" style="opacity:0.4;pointer-events:none">&laquo; Previous</span>`}
                ${page < totalPages
                  ? `<a href="${base}/notifications?page=${page + 1}${qsSuffix}" class="btn btn-outline btn-sm">Next &raquo;</a>`
                  : `<span class="btn btn-outline btn-sm" style="opacity:0.4;pointer-events:none">Next &raquo;</span>`}
              </div>
            </div>
          ` : ''}
        ` : `
          <div style="text-align:center;padding:40px;color:var(--s-text-dim)">
            <div style="font-size:32px;margin-bottom:12px">&#128276;</div>
            <div style="font-weight:600;margin-bottom:4px">${filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}</div>
            <div style="font-size:13px">${filter === 'unread' ? 'You are all caught up.' : 'Notifications will appear here when events occur in your store.'}</div>
          </div>
        `}
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Notifications',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'notifications',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── POST: Mark single notification as read ────────────────────

export async function postMarkRead(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const { notification_id } = req.body

  if (notification_id) {
    await db.updateTable('notifications')
      .set({ read: true })
      .where('id', '=', notification_id)
      .where('shop_id', '=', store.id)
      .execute()
  }

  res.redirect(`${base}/notifications?marked=1`)
}

// ─── POST: Mark all notifications as read ──────────────────────
//
// Honours the active category filter — if the request came from a
// filtered tab (e.g. category=reviews), only rows in that bucket get
// marked. Keeps the action scoped to what the user can actually see,
// which is what most sellers expect when they click "Mark all as
// read" on a filtered view (otherwise the button becomes a foot-gun
// that silently touches every other bucket). Unfiltered behaviour
// (no ?category=…) is unchanged: it marks everything as before.
export async function postMarkAllRead(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const categoryRaw = ((req.body?.category as string) || (req.query.category as string) || '').trim()
  const category: NotificationCategory | '' = CATEGORY_SLUGS.has(categoryRaw)
    ? (categoryRaw as NotificationCategory)
    : ''

  let q: any = db.updateTable('notifications')
    .set({ read: true })
    .where('shop_id', '=', store.id)
    .where('read', '=', false)
  if (category) q = applyCategoryFilter(q, category)
  await q.execute()

  const redirectQs = category ? `?marked=1&category=${encodeURIComponent(category)}` : '?marked=1'
  res.redirect(`${base}/notifications${redirectQs}`)
}

// ─── POST: Mark all as seen (JSON, for the topbar bell drawer) ─
//
// The seller's bell drawer needs to mark all unread notifications as
// read without navigating away. `postMarkAllRead` above 302s back to
// /notifications?marked=1 — perfect for a form POST on the full
// inbox page, useless for an AJAX call from the header.
//
// This handler does the same shop-scoped update and returns JSON so
// the drawer script can optimistically zero out the red badge the
// moment the user clicks the bell. Contract:
//
//   Request:  POST /admin/store/:slug/notifications/mark-seen
//             (session cookie only — CSRF is skipped at the
//             middleware layer; SameSite=Lax on the session cookie +
//             a storeAuth gate upstream block cross-origin abuse.)
//
//   Response: 200 { ok: true, marked: <number>, unreadCount: 0 }
//             401 { ok: false, error: 'unauthorized' } if no session
//
// We report `marked` (rows updated) separately from `unreadCount`
// (always 0 immediately after) so a future "You caught up on N
// notifications" toast can read the count without a second query.
export async function postMarkAllSeen(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store
  if (!store) {
    res.status(401).json({ ok: false, error: 'unauthorized' })
    return
  }

  try {
    const result = await db.updateTable('notifications')
      .set({ read: true })
      .where('shop_id', '=', store.id)
      .where('read', '=', false)
      .execute()

    // Kysely's update returns an array of UpdateResult; the first row
    // carries numUpdatedRows as a bigint. Convert to a plain number so
    // JSON.stringify doesn't choke (BigInt is not JSON-serializable by
    // default and would throw on res.json()).
    const raw = Array.isArray(result) ? (result[0] as any) : (result as any)
    const marked = Number(raw?.numUpdatedRows ?? 0)

    res.json({ ok: true, marked, unreadCount: 0 })
  } catch (err: any) {
    console.error('[notifications.markSeen] update failed:', err?.message)
    res.status(500).json({ ok: false, error: 'server_error' })
  }
}
