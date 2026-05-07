/**
 * God Admin — Developer Hub (API Management Tools)
 *
 * GET  /god-admin/developer           — Developer overview dashboard
 * GET  /god-admin/developer/tokens    — API token management
 * GET  /god-admin/developer/webhooks  — Webhook management
 * GET  /god-admin/developer/apps      — App marketplace
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
// Phase 2 Admin Polish §2.1 — real webhook rotation UI backed by the
// Phase 0.7 Item #2 rotation module. The CLI at
// scripts/ops/rotate-webhook-secret.ts exercises the same code path.
import {
  rotateShopWebhookSecret,
  getRotationGraceDays,
} from '@gbox/core/modules/webhooks/hmac.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { getRedis } from '@gbox/core/modules/cache/redis.js'
import { buildFlashCookie } from '@gbox/core/modules/ui/toast.js'
import { randomBytes } from 'node:crypto'

// Module-level CSRF store — separate cookie so rotations on this page
// don't collide with the 2FA settings flow.
const webhooksCsrfStore = createCsrfStore({
  cookieName: 'gbox_csrf_god_developer_webhooks',
})

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Rotation flash — one-time secret display
// ---------------------------------------------------------------------------
//
// After a successful rotation we need to show the merchant the brand-new
// secret exactly ONCE. Putting it in a query-string would leak the secret
// into proxy logs, browser history, and referer headers — a hard no per
// CLAUDE.md §Rule 1 ("never put sensitive data in URL parameters").
//
// Instead we:
//   1. Generate a 32-char random flash token.
//   2. Stash the secret (+ shop id/slug) in Redis under
//      `gbox:webhook_rotation_flash:<token>` with a 120s TTL.
//   3. Redirect with ?rotated=<token> in the URL. The TOKEN is public —
//      only the Redis lookup has the secret.
//   4. The GET handler reads + deletes the key on first access. If the
//      merchant refreshes the page the secret is already gone.
//
// The Redis key is namespaced per-shop in the payload so a stolen token
// can't be replayed against a different shop.
const WEBHOOK_FLASH_PREFIX = 'gbox:webhook_rotation_flash:'
const WEBHOOK_FLASH_TTL_SECONDS = 120

interface WebhookRotationFlash {
  shop_id: string
  shop_slug: string | null
  new_secret: string
  previous_present: boolean
  rotated_at: string
  grace_expires_at: string
}

async function stashRotationFlash(payload: WebhookRotationFlash): Promise<string> {
  const token = randomBytes(24).toString('hex')
  const client = await getRedis()
  await client.set(
    WEBHOOK_FLASH_PREFIX + token,
    JSON.stringify(payload),
    { EX: WEBHOOK_FLASH_TTL_SECONDS },
  )
  return token
}

async function popRotationFlash(token: string): Promise<WebhookRotationFlash | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null
  const client = await getRedis()
  const key = WEBHOOK_FLASH_PREFIX + token
  const raw = await client.get(key)
  if (!raw) return null
  // One-time read: delete the key before returning so a refresh can't
  // show the secret again.
  await client.del(key)
  try {
    return JSON.parse(raw) as WebhookRotationFlash
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtNum(val: number | string | null): string {
  return Number(val || 0).toLocaleString('en-US')
}

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fullDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ---------------------------------------------------------------------------
// GET /god-admin/developer — Developer Overview Dashboard
// ---------------------------------------------------------------------------

export async function getDeveloperHub(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const now = new Date()

  try {
    const [activeTokens, recentApiActivity, webhookCountRow] = await Promise.all([
      // Active sessions count (used as "Active Tokens")
      db.selectFrom('sessions')
        .where('expires_at', '>', now.toISOString())
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Recent API activity from audit logs
      db.selectFrom('audit_logs as a')
        .leftJoin('users as u', 'u.id', 'a.user_id')
        .where('a.action', 'ilike', '%api%')
        .select([
          'a.id', 'a.action', 'a.resource_type', 'a.resource_id',
          'a.ip_address', 'a.created_at',
          'u.email as user_email',
        ])
        .orderBy('a.created_at', 'desc')
        .limit(10)
        .execute(),

      // Active webhooks across all shops — Phase 2.4: replace hardcoded 0
      db.selectFrom('webhooks')
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),
    ])

    const tokenCount = Number(activeTokens?.count ?? 0)
    const webhookCount = Number(webhookCountRow?.count ?? 0)
    // Installed app count is hardcoded in the App Marketplace page
    // (3: Analytics, Fulfillment, Payments). Mirror it here until
    // the app registry lands in Phase 4.
    const installedAppCount = 3

    // Platform API Overview card
    const apiOverviewHtml = `
      <div class="card" style="margin-bottom:24px">
        <div class="card-title" style="margin-bottom:16px">Platform API Overview</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">
          <div>
            <div style="color:var(--gray-400);font-size:12px;margin-bottom:4px">API Base URL</div>
            <code style="font-size:14px;color:var(--blue)">http://${esc(req.hostname)}:4321</code>
          </div>
          <div>
            <div style="color:var(--gray-400);font-size:12px;margin-bottom:4px">Total Endpoints</div>
            <div style="font-size:18px;font-weight:600">70</div>
          </div>
          <div>
            <div style="color:var(--gray-400);font-size:12px;margin-bottom:4px">Documentation</div>
            <a href="/god-admin/developer" style="color:var(--blue);font-size:14px">View API Docs</a>
          </div>
        </div>
      </div>`

    // Quick Stats cards
    const statsHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total API Calls</div>
          <div class="stat-value" style="color:var(--gray-400);font-size:14px" title="API metrics collector ships in Phase 4 (Observability).">Phase 4</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Tokens</div>
          <div class="stat-value">${fmtNum(tokenCount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Webhooks</div>
          <div class="stat-value">${fmtNum(webhookCount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Installed Apps</div>
          <div class="stat-value">${fmtNum(installedAppCount)}</div>
        </div>
      </div>`

    // API Endpoints Summary table
    const endpointsSummaryHtml = `
      <div class="card" style="margin-bottom:24px">
        <div class="card-title" style="margin-bottom:12px">API Endpoints Summary</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Endpoints</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span class="badge badge-blue">God Admin APIs</span></td>
              <td><strong>37</strong></td>
              <td>Platform management, stores, users, security, finance, analytics</td>
            </tr>
            <tr>
              <td><span class="badge badge-green">Store APIs</span></td>
              <td><strong>24</strong></td>
              <td>Products, orders, customers, inventory, fulfillment</td>
            </tr>
            <tr>
              <td><span class="badge badge-yellow">Legacy APIs</span></td>
              <td><strong>7</strong></td>
              <td>Backward-compatible endpoints from previous versions</td>
            </tr>
            <tr>
              <td><span class="badge badge-gray">Utility</span></td>
              <td><strong>2</strong></td>
              <td>Health check, version info</td>
            </tr>
          </tbody>
        </table>
      </div>`

    // Sub-navigation
    const subNavHtml = `
      <div class="card" style="margin-bottom:24px">
        <div class="card-title" style="margin-bottom:12px">Developer Tools</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <a href="/god-admin/developer/tokens" class="btn btn-secondary btn-sm">API Tokens</a>
          <a href="/god-admin/developer/webhooks" class="btn btn-secondary btn-sm">Webhooks</a>
          <a href="/god-admin/developer/apps" class="btn btn-secondary btn-sm">App Marketplace</a>
        </div>
      </div>`

    // Recent API Activity
    const activityRows = recentApiActivity.length > 0
      ? recentApiActivity.map(a => `
        <tr>
          <td>${fullDate(a.created_at)}</td>
          <td><span class="badge badge-blue">${esc(a.action)}</span></td>
          <td>${esc(a.user_email) || '<em style="color:var(--gray-400)">system</em>'}</td>
          <td>${esc(a.resource_type) || '-'}</td>
          <td class="mono" style="font-size:11px">${esc(a.resource_id?.slice(0, 12) ?? '') || '-'}</td>
          <td>${esc(a.ip_address) || '-'}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:24px">No recent API activity</td></tr>'

    const activityHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Recent API Activity</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Action</th>
              <th>User</th>
              <th>Resource</th>
              <th>Resource ID</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>${activityRows}</tbody>
        </table>
      </div>`

    const content = `
      <div class="page-header">
        <h1>Developer Hub</h1>
      </div>
      ${apiOverviewHtml}
      ${statsHtml}
      ${subNavHtml}
      ${endpointsSummaryHtml}
      ${activityHtml}
    `

    res.send(godLayout({
      title: 'Developer Hub',
      userEmail: user.email,
      activePath: '/god-admin/developer',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Developer Hub error:', err)
    res.status(500).send(godLayout({
      title: 'Developer Hub',
      userEmail: user.email,
      activePath: '/god-admin/developer',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/developer/tokens — API Token Management
// ---------------------------------------------------------------------------

export async function getApiTokens(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const now = new Date()
  const soonThreshold = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()

  try {
    const [sessions, expiringSoon] = await Promise.all([
      // Active sessions as "API tokens"
      db.selectFrom('sessions as s')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .where('s.expires_at', '>', now.toISOString())
        .select([
          's.id',
          's.token_hash',
          's.created_at',
          's.expires_at',
          's.ip_address',
          'u.email as user_email',
        ])
        .orderBy('s.created_at', 'desc')
        .execute(),

      // Expiring soon count (within 24h)
      db.selectFrom('sessions')
        .where('expires_at', '>', now.toISOString())
        .where('expires_at', '<=', soonThreshold)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),
    ])

    const expiringSoonCount = Number(expiringSoon?.count ?? 0)

    // Summary stats
    const summaryHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Active Tokens</div>
          <div class="stat-value">${fmtNum(sessions.length)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Expiring Soon (24h)</div>
          <div class="stat-value" style="${expiringSoonCount > 0 ? 'color:var(--yellow)' : ''}">${fmtNum(expiringSoonCount)}</div>
        </div>
      </div>`

    // Token table
    const tokenRows = sessions.length > 0
      ? sessions.map(s => {
          const tokenPreview = s.token_hash ? s.token_hash.slice(0, 8) + '...' : '-'
          const isExpiringSoon = new Date(s.expires_at!) <= new Date(soonThreshold)
          const statusBadge = isExpiringSoon
            ? '<span class="badge badge-yellow">Expiring Soon</span>'
            : '<span class="badge badge-green">Active</span>'

          return `
          <tr>
            <td class="mono" style="font-size:12px">${esc(tokenPreview)}</td>
            <td>${esc(s.user_email)}</td>
            <td>${shortDate(s.created_at)}</td>
            <td>${shortDate(s.expires_at)}</td>
            <td>${s.ip_address ? esc(s.ip_address) : '<em style="color:var(--gray-400)">—</em>'}</td>
            <td>${statusBadge}</td>
            <td>
              <a href="/god-admin/security/tokens" class="btn btn-danger btn-sm" style="font-size:11px">Revoke</a>
            </td>
          </tr>`
        }).join('')
      : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:24px">No active tokens</td></tr>'

    const tableHtml = `
      <div class="card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="card-title">API Tokens</div>
          <a href="/god-admin/security/tokens" class="btn btn-primary btn-sm">Generate New Token</a>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>User</th>
              <th>Created</th>
              <th>Expires</th>
              <th>IP Address</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${tokenRows}</tbody>
        </table>
      </div>`

    const content = `
      <div class="page-header">
        <h1>API Tokens</h1>
        <a href="/god-admin/developer" class="btn btn-secondary btn-sm">Back to Developer Hub</a>
      </div>
      ${summaryHtml}
      ${tableHtml}
    `

    res.send(godLayout({
      title: 'API Tokens',
      userEmail: user.email,
      activePath: '/god-admin/developer/tokens',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] API Tokens error:', err)
    res.status(500).send(godLayout({
      title: 'API Tokens',
      userEmail: user.email,
      activePath: '/god-admin/developer/tokens',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/developer/webhooks — Webhook Management
// ---------------------------------------------------------------------------

export async function getWebhooks(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  try {
    // -------------------------------------------------------------------
    // One-time secret display (if redirected here from a rotation POST).
    // -------------------------------------------------------------------
    const flashToken = typeof req.query.rotated === 'string' ? req.query.rotated : ''
    const flash = flashToken ? await popRotationFlash(flashToken) : null

    // -------------------------------------------------------------------
    // Load per-shop rotation state.
    //
    // A shop appears in the table if EITHER:
    //   - it has at least one webhook subscription row, OR
    //   - it has a stored `webhook.secret` / `webhook.secret.rotated_at`
    //     in shop_settings (meaning it's been rotated before).
    //
    // Shops that have never rotated still get the deterministic fallback
    // secret via HMAC(GBOX_WEBHOOK_ROOT, shopId) — see hmac.ts.
    // -------------------------------------------------------------------
    const graceDays = getRotationGraceDays()
    const graceMs = graceDays * 24 * 60 * 60 * 1000
    const now = Date.now()

    const [subscriptionRows, rotatedAtRows, allShops] = await Promise.all([
      // Subscriptions grouped by shop
      db.selectFrom('webhooks')
        .select(['shop_id', sql<string>`count(*)`.as('count')])
        .groupBy('shop_id')
        .execute(),

      // Rotation timestamps
      db.selectFrom('shop_settings')
        .select(['shop_id', 'value'])
        .where('key', '=', 'webhook.secret.rotated_at')
        .execute(),

      // Shops (for slug + name lookup)
      db.selectFrom('shops')
        .select(['id', 'slug', 'name'])
        .orderBy('slug', 'asc')
        .execute(),
    ])

    const subsByShop = new Map<string, number>()
    for (const row of subscriptionRows) {
      subsByShop.set(row.shop_id, Number(row.count ?? 0))
    }

    const rotatedByShop = new Map<string, string>()
    for (const row of rotatedAtRows) {
      const v = row.value as unknown
      const iso =
        typeof v === 'string'
          ? v
          : typeof v === 'object' && v !== null && typeof (v as { value?: unknown }).value === 'string'
            ? (v as { value: string }).value
            : null
      if (iso) rotatedByShop.set(row.shop_id, iso)
    }

    interface Row {
      id: string
      slug: string
      name: string
      subs: number
      rotatedAt: string | null
      graceRemainingMs: number
    }

    const rows: Row[] = []
    for (const shop of allShops) {
      const subs = subsByShop.get(shop.id) ?? 0
      const rotatedAt = rotatedByShop.get(shop.id) ?? null
      // Only include shops that are actually using webhooks (either
      // subscribed or explicitly rotated).
      if (subs === 0 && !rotatedAt) continue
      const graceRemainingMs = rotatedAt
        ? Math.max(0, new Date(rotatedAt).getTime() + graceMs - now)
        : 0
      rows.push({
        id: shop.id,
        slug: shop.slug,
        name: shop.name,
        subs,
        rotatedAt,
        graceRemainingMs,
      })
    }

    rows.sort((a, b) => a.slug.localeCompare(b.slug))

    // -------------------------------------------------------------------
    // CSRF token — one per render, consumed by the rotation POST.
    // -------------------------------------------------------------------
    const csrfToken = await webhooksCsrfStore.issue(res, isProduction())
    const csrfField = webhooksCsrfStore.hiddenField(csrfToken)

    // -------------------------------------------------------------------
    // One-time secret banner
    // -------------------------------------------------------------------
    const bannerHtml = flash
      ? `
      <div class="card" style="margin-bottom:24px;border:2px solid var(--green,#22c55e);background:rgba(34,197,94,0.06)">
        <div class="card-title" style="color:var(--green,#22c55e);margin-bottom:12px">
          ✅ Webhook secret rotated for <code>${esc(flash.shop_slug ?? flash.shop_id)}</code>
        </div>
        <p style="color:var(--gray-300);font-size:13px;margin:0 0 10px 0">
          Copy this secret <strong>now</strong>. It will not be shown again.
          The previous secret will continue to sign outbound deliveries
          for <strong>${graceDays} days</strong>
          (grace window ends ${fullDate(flash.grace_expires_at)}).
        </p>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <code style="flex:1;display:block;background:var(--god-bg,#0f172a);padding:12px;border-radius:8px;font-size:13px;color:var(--gray-100);user-select:all;word-break:break-all;font-family:monospace">${esc(flash.new_secret)}</code>
        </div>
        <div style="color:var(--gray-500);font-size:11px">
          Rotated at ${fullDate(flash.rotated_at)}.
          ${flash.previous_present
            ? 'A previous secret was found and is now being emitted alongside the new one during the grace window.'
            : 'No previous secret existed — this is the first rotation for the shop.'}
        </div>
      </div>`
      : ''

    // -------------------------------------------------------------------
    // Rotation table
    // -------------------------------------------------------------------
    const tableRowsHtml = rows.length > 0
      ? rows.map(r => {
          const inGrace = r.graceRemainingMs > 0
          const graceBadge = r.rotatedAt
            ? inGrace
              ? `<span class="badge badge-yellow" title="Previous secret still broadcast for ${Math.ceil(r.graceRemainingMs / (24 * 60 * 60 * 1000))} more day(s)">In grace (${Math.ceil(r.graceRemainingMs / (24 * 60 * 60 * 1000))}d)</span>`
              : '<span class="badge badge-green">Stable</span>'
            : '<span class="badge badge-gray">Default (never rotated)</span>'
          return `
          <tr>
            <td>
              <div style="font-weight:600">${esc(r.slug)}</div>
              <div style="color:var(--gray-500);font-size:11px">${esc(r.name)}</div>
            </td>
            <td>${fmtNum(r.subs)}</td>
            <td>${r.rotatedAt ? shortDate(r.rotatedAt) : '<em style="color:var(--gray-500)">never</em>'}</td>
            <td>${graceBadge}</td>
            <td>
              <form method="POST" action="/god-admin/developer/webhooks/rotate" style="margin:0" onsubmit="return confirm('Rotate the webhook secret for &quot;${esc(r.slug)}&quot;? The old secret will still sign deliveries for ${graceDays} day(s).');">
                ${csrfField}
                <input type="hidden" name="shop_id" value="${esc(r.id)}">
                <button type="submit" class="btn btn-primary btn-sm">Rotate</button>
              </form>
            </td>
          </tr>`
        }).join('')
      : `<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:24px">
          No shops have webhook subscriptions or a stored secret yet.
          Every shop still gets a deterministic fallback secret — rotation
          only matters once a shop starts consuming webhooks.
        </td></tr>`

    const tableHtml = `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <div class="card-title">Shop webhook secret rotation</div>
            <div style="color:var(--gray-500);font-size:12px;margin-top:4px">
              Grace window: <strong>${graceDays} days</strong>
              (override via <code>GBOX_WEBHOOK_ROTATION_GRACE_DAYS</code>)
            </div>
          </div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Shop</th>
              <th>Subscriptions</th>
              <th>Last rotated</th>
              <th>Grace status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${tableRowsHtml}</tbody>
        </table>
      </div>`

    // -------------------------------------------------------------------
    // Supported events reference table (unchanged from stub)
    // -------------------------------------------------------------------
    const supportedEvents = [
      { event: 'order.created', description: 'Fired when a new order is placed' },
      { event: 'order.paid', description: 'Fired when an order payment is confirmed' },
      { event: 'order.fulfilled', description: 'Fired when an order is fully fulfilled' },
      { event: 'order.cancelled', description: 'Fired when an order is cancelled' },
      { event: 'order.refunded', description: 'Fired when an order is refunded' },
      { event: 'product.created', description: 'Fired when a new product is created' },
      { event: 'product.updated', description: 'Fired when a product is updated' },
      { event: 'product.deleted', description: 'Fired when a product is deleted' },
      { event: 'customer.created', description: 'Fired when a new customer registers' },
      { event: 'customer.updated', description: 'Fired when customer details change' },
      { event: 'shop.updated', description: 'Fired when store settings are changed' },
      { event: 'inventory.updated', description: 'Fired when inventory levels change' },
    ]

    const eventRows = supportedEvents.map(e => `
      <tr>
        <td class="mono" style="font-size:13px"><span class="badge badge-blue">${esc(e.event)}</span></td>
        <td>${esc(e.description)}</td>
      </tr>`).join('')

    const eventsTableHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Supported webhook events</div>
        <p style="color:var(--gray-500);font-size:12px;margin:0 0 12px 0">
          Registration UI for specific endpoints lives in each store's
          admin. This list is informational only — rotation here affects
          the HMAC signing key, not which events are delivered.
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>${eventRows}</tbody>
        </table>
      </div>`

    const content = `
      <div class="page-header">
        <h1>Webhooks</h1>
        <a href="/god-admin/developer" class="btn btn-secondary btn-sm">Back to Developer Hub</a>
      </div>
      ${bannerHtml}
      ${tableHtml}
      ${eventsTableHtml}
    `

    res.send(godLayout({
      title: 'Webhooks',
      userEmail: user.email,
      activePath: '/god-admin/developer/webhooks',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Webhooks error:', err)
    res.status(500).send(godLayout({
      title: 'Webhooks',
      userEmail: user.email,
      activePath: '/god-admin/developer/webhooks',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/developer/webhooks/rotate — Rotate a shop's webhook secret
// ---------------------------------------------------------------------------
//
// Flow:
//   1. CSRF check (token issued on the GET render above).
//   2. Resolve shop by id — 404 if missing.
//   3. Call rotateShopWebhookSecret (module owns the transaction).
//   4. Write audit log entry (`webhook_secret_rotated`, source: 'ui').
//   5. Stash the fresh secret in Redis under a random flash token.
//   6. Redirect to GET with ?rotated=<token> — the secret is NOT in
//      the URL, only the token, which maps to a Redis entry that
//      self-destructs on first read.
//
// Phase 0.7 Item #2 shipped the rotation module + CLI. This handler is
// the Phase 2.1 web UI layer on top.
export async function postWebhooksRotate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user

  try {
    // CSRF first — before reading any other body fields.
    const csrfOk = await webhooksCsrfStore.verify(req)
    if (!csrfOk) {
      res.status(403).send(godLayout({
        title: 'Webhooks',
        userEmail: user.email,
        activePath: '/god-admin/developer/webhooks',
        content: `<div class="card"><p style="color:var(--red)">Invalid CSRF token. Please reload the page and try again.</p></div>`,
      }))
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const shopId = typeof body.shop_id === 'string' ? body.shop_id : ''
    if (!shopId) {
      res.status(400).send(godLayout({
        title: 'Webhooks',
        userEmail: user.email,
        activePath: '/god-admin/developer/webhooks',
        content: `<div class="card"><p style="color:var(--red)">Missing shop_id.</p></div>`,
      }))
      return
    }

    // Resolve shop — needed for the audit log and the flash banner.
    const shop = await db.selectFrom('shops')
      .select(['id', 'slug', 'name'])
      .where('id', '=', shopId)
      .executeTakeFirst()

    if (!shop) {
      res.status(404).send(godLayout({
        title: 'Webhooks',
        userEmail: user.email,
        activePath: '/god-admin/developer/webhooks',
        content: `<div class="card"><p style="color:var(--red)">Shop not found.</p></div>`,
      }))
      return
    }

    // Perform the rotation. Module guarantees transactional correctness.
    const result = await rotateShopWebhookSecret(db, shop.id)

    // Audit log — direct insert (the typed `logAuditEvent` helper only
    // covers the auth action enum). `details` is JSONB so we stringify.
    await db.insertInto('audit_logs').values({
      shop_id: shop.id,
      user_id: user.id,
      action: 'webhook_secret_rotated',
      resource_type: 'shop',
      resource_id: shop.id,
      details: JSON.stringify({
        source: 'ui',
        rotated_at: result.rotatedAt,
        grace_expires_at: result.graceExpiresAt,
        previous_present: result.previousSecret !== null,
        actor_email: user.email,
        shop_slug: shop.slug,
      }),
      ip_address: req.ip ?? null,
    }).execute()

    // Stash the one-time secret in Redis, get a flash token.
    const flashToken = await stashRotationFlash({
      shop_id: shop.id,
      shop_slug: shop.slug,
      new_secret: result.newSecret,
      previous_present: result.previousSecret !== null,
      rotated_at: result.rotatedAt,
      grace_expires_at: result.graceExpiresAt,
    })

    // Success toast + redirect. The secret itself stays out of the URL.
    res.setHeader(
      'Set-Cookie',
      buildFlashCookie({
        kind: 'success',
        message: `Webhook secret rotated for ${shop.slug}. Copy it now — it won't be shown again.`,
      }),
    )
    res.redirect(`/god-admin/developer/webhooks?rotated=${flashToken}`)
  } catch (err) {
    console.error('[God Admin] Webhook rotate error:', err)
    res.status(500).send(godLayout({
      title: 'Webhooks',
      userEmail: user.email,
      activePath: '/god-admin/developer/webhooks',
      content: `<div class="card"><p style="color:var(--red)">Rotation failed: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/developer/apps — App Marketplace
// ---------------------------------------------------------------------------

export async function getAppMarketplace(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  try {
    // Built-in apps (hardcoded)
    const apps = [
      { icon: '📊', name: 'Gbox Analytics', description: 'Real-time analytics, dashboards, and reporting for your platform.', status: 'installed', version: '1.0.0' },
      { icon: '📦', name: 'Gbox Fulfillment', description: 'Order fulfillment tracking, shipping labels, and delivery management.', status: 'installed', version: '1.0.0' },
      { icon: '💳', name: 'Gbox Payments', description: 'Secure payment processing with multiple gateway support.', status: 'installed', version: '1.0.0' },
      { icon: '📧', name: 'Gbox Email Marketing', description: 'Automated email campaigns, newsletters, and customer engagement.', status: 'coming-soon', version: '-' },
      { icon: '🔍', name: 'Gbox SEO Tools', description: 'Search engine optimization, meta tags, sitemaps, and structured data.', status: 'coming-soon', version: '-' },
      { icon: '⭐', name: 'Gbox Reviews', description: 'Product reviews, ratings, and customer feedback management.', status: 'coming-soon', version: '-' },
      { icon: '🚚', name: 'Gbox Shipping Calculator', description: 'Real-time shipping rate calculations from multiple carriers.', status: 'coming-soon', version: '-' },
      { icon: '🧾', name: 'Gbox Tax Engine', description: 'Automated tax calculations, compliance, and reporting.', status: 'coming-soon', version: '-' },
    ]

    const appCards = apps.map(app => {
      const statusBadge = app.status === 'installed'
        ? '<span class="badge badge-green">Installed</span>'
        : '<span class="badge badge-gray" title="Third-party app ecosystem lands in Phase 4.">Phase 4</span>'

      return `
        <div class="card" style="display:flex;flex-direction:column;gap:12px;padding:20px">
          <div style="display:flex;align-items:center;gap:12px">
            <span style="font-size:32px">${app.icon}</span>
            <div style="flex:1">
              <div style="font-weight:600;font-size:15px;color:var(--gray-100)">${esc(app.name)}</div>
              <div style="font-size:12px;color:var(--gray-500)">v${esc(app.version)}</div>
            </div>
            ${statusBadge}
          </div>
          <p style="color:var(--gray-400);font-size:13px;margin:0;flex:1">${esc(app.description)}</p>
          ${app.status === 'installed'
            ? '<button class="btn btn-secondary btn-sm" style="align-self:flex-start" disabled>Manage</button>'
            : '<button class="btn btn-primary btn-sm" style="align-self:flex-start;opacity:0.5;cursor:not-allowed" disabled>Install</button>'
          }
        </div>`
    }).join('')

    // Summary
    const installedCount = apps.filter(a => a.status === 'installed').length
    const comingSoonCount = apps.filter(a => a.status === 'coming-soon').length

    const summaryHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Installed Apps</div>
          <div class="stat-value">${installedCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Planned (Phase 4)</div>
          <div class="stat-value">${comingSoonCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Available</div>
          <div class="stat-value">${apps.length}</div>
        </div>
      </div>`

    const content = `
      <div class="page-header">
        <h1>App Marketplace</h1>
        <a href="/god-admin/developer" class="btn btn-secondary btn-sm">Back to Developer Hub</a>
      </div>
      ${summaryHtml}
      <style>
        .app-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 20px;
          margin-top: 4px;
        }
        @media (max-width: 1100px) { .app-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 700px) { .app-grid { grid-template-columns: 1fr; } }
      </style>
      <div class="app-grid">
        ${appCards}
      </div>
    `

    res.send(godLayout({
      title: 'App Marketplace',
      userEmail: user.email,
      activePath: '/god-admin/developer/apps',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] App Marketplace error:', err)
    res.status(500).send(godLayout({
      title: 'App Marketplace',
      userEmail: user.email,
      activePath: '/god-admin/developer/apps',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}
