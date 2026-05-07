/**
 * Store Admin — Automation flow settings (Phase 14 PR3 commit 7)
 *
 * Seller-facing control surface for the 18 declarative flows in
 * `@gbox/core/modules/automations/flow-catalog.ts`. Each flow gets:
 *
 *   • Enable / disable toggle (persisted as `automation_flows.enabled`).
 *     Off by default for individual flows only if the merchant explicitly
 *     toggles them off — a missing override row = use catalog default
 *     (enabled=true for every entry at launch).
 *
 *   • Delay override (minutes). Persisted as `automation_flows.
 *     delay_seconds` (stored seconds, entered minutes for ergonomics).
 *     NULL = "use catalog default". 0 = "dispatch inline".
 *
 *   • Recent runs panel — last 20 rows of `automation_runs` for this
 *     shop, with outcome badges (sent / skipped / failed). Gives the
 *     merchant a "is my automation actually firing?" check without
 *     grepping logs.
 *
 * Iron rule 5 compliance
 * ---------------------
 *   - Template key NEVER surfaced in the UI as a raw string beyond the
 *     flow label — templates are an internal concept.
 *   - Any error surface routes through a generic "Please contact Gbox
 *     support" path. No /god-admin/* leak, no feature-flag leak, no
 *     internal module name leak.
 *   - The `AUTOMATION_FRAMEWORK_V2` env flag is never mentioned in any
 *     user-visible string. The banner at the top says "Automations are
 *     currently paused for this store" when the flag is off, framed as
 *     a platform-side pause not a rollback mechanism.
 *
 * Route wiring
 * ------------
 *   GET  /admin/store/:slug/settings/automations
 *   POST /admin/store/:slug/settings/automations
 *
 * Legacy `/marketing/automations` and `/marketing/abandoned/settings`
 * both 301 here (see server.ts) — PR3 scope says the old abandoned-cart
 * page becomes a redirect so merchants don't bookmark a dying surface.
 *
 * CSRF: `req.csrfToken` populated by server-level middleware on every
 * GET. The single <form> wraps ALL per-flow inputs and POSTs them in
 * one go — matches the abandoned-cart settings UX.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'
import { logSellerAction } from '../middleware/store-auth.js'
// Barrel-style import: `@gbox/core`'s `./*` wildcard export maps to the
// src tree, so we name the index explicitly. Gives us FLOW_CATALOG,
// isAutomationFrameworkEnabled, FlowCatalogEntry from one line.
import {
  FLOW_CATALOG,
  isAutomationFrameworkEnabled,
  type FlowCatalogEntry,
} from '@gbox/core/modules/automations/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

/**
 * Human-friendly delay label, keyed off seconds the catalog entry
 * actually uses. "0 → Immediate", "3600 → 1 hour", "86400 → 1 day".
 */
function formatDelay(seconds: number): string {
  if (seconds <= 0) return 'Immediate'
  if (seconds < 60) return `${seconds} sec`
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  if (mins < 60 * 24) {
    const h = mins / 60
    return `${h === Math.floor(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`
  }
  const d = mins / (60 * 24)
  return `${d === Math.floor(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`
}

/**
 * Display groupings (mirrors scope doc §2 groups). Each flow's `key`
 * determines its group; unknown groups fall into "Other".
 */
function groupOf(entry: FlowCatalogEntry): string {
  const k = entry.key
  if (k.startsWith('campaign_') || k === 'newsletter_broadcast' ||
      k === 'flash_sale' || k === 'seasonal_promo' ||
      k === 'product_launch' || k === 'back_in_stock') return 'Marketing'
  if (k === 'post_purchase_thank_you' || k === 'customer_win_back' ||
      k === 'first_order_milestone' || k === 'onboarding_day_1') return 'Customer lifecycle'
  if (k === 'review_request') return 'Reviews'
  if (k.startsWith('abandoned_cart_') || k === 'post_purchase_upsell') return 'Cart & checkout'
  if (k === 'low_stock_alert') return 'Merchant operations'
  if (k === 'fulfillment_out_for_delivery' || k === 'payment_failed_customer' ||
      k === 'high_value_order') return 'Transactional'
  return 'Other'
}

const GROUP_ORDER = [
  'Marketing',
  'Customer lifecycle',
  'Reviews',
  'Cart & checkout',
  'Merchant operations',
  'Transactional',
  'Other',
] as const

// Per-shop effective row — catalog + optional override.
interface EffectiveFlow {
  catalog: FlowCatalogEntry
  enabled: boolean         // effective (override || catalog default TRUE)
  delaySeconds: number     // effective (override || catalog default)
  hasOverride: boolean     // for "reset to default" affordance
}

async function loadEffectiveFlows(
  db: Kysely<Database>,
  shopId: string,
): Promise<EffectiveFlow[]> {
  const overrides = await (db as any)
    .selectFrom('automation_flows')
    .select(['flow_key', 'enabled', 'delay_seconds'])
    .where('shop_id', '=', shopId)
    .execute()

  const byKey = new Map<string, { enabled: boolean; delay_seconds: number | null }>()
  for (const row of overrides) {
    byKey.set(row.flow_key, {
      enabled: row.enabled,
      delay_seconds: row.delay_seconds,
    })
  }

  return FLOW_CATALOG.map((catalog) => {
    const ov = byKey.get(catalog.key)
    return {
      catalog,
      enabled: ov ? ov.enabled : true,
      delaySeconds: ov?.delay_seconds ?? catalog.delaySeconds,
      hasOverride: ov != null,
    }
  })
}

async function loadRecentRuns(
  db: Kysely<Database>,
  shopId: string,
  limit = 20,
): Promise<Array<{
  id: string
  flow_key: string
  outcome: string
  reason: string | null
  created_at: string
}>> {
  const rows = await (db as any)
    .selectFrom('automation_runs')
    .select(['id', 'flow_key', 'outcome', 'reason', 'created_at'])
    .where('shop_id', '=', shopId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
  return rows.map((r: any) => ({
    id: String(r.id),
    flow_key: String(r.flow_key),
    outcome: String(r.outcome),
    reason: r.reason as string | null,
    created_at: typeof r.created_at === 'string'
      ? r.created_at
      : new Date(r.created_at as any).toISOString(),
  }))
}

/** Outcome → colored pill class + label. */
function outcomePill(outcome: string): { color: string; label: string } {
  switch (outcome) {
    case 'sent':
      return { color: 'var(--s-success)', label: 'Sent' }
    case 'skipped_conditions':
      return { color: 'var(--s-text-dim)', label: 'Skipped (conditions)' }
    case 'skipped_dedup':
      return { color: 'var(--s-text-dim)', label: 'Skipped (duplicate)' }
    case 'skipped_disabled':
      return { color: 'var(--s-warning)', label: 'Skipped (disabled)' }
    case 'failed':
      return { color: 'var(--s-danger, #ef4444)', label: 'Failed' }
    default:
      return { color: 'var(--s-text-dim)', label: esc(outcome) }
  }
}

function flowLabelByKey(key: string): string {
  const entry = FLOW_CATALOG.find((f) => f.key === key)
  return entry?.label ?? key
}

// ---------------------------------------------------------------------------
// GET /settings/automations
// ---------------------------------------------------------------------------

export async function getSettingsAutomations(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfToken = req.csrfToken || ''

  const [effective, recentRuns] = await Promise.all([
    loadEffectiveFlows(db, store.id),
    loadRecentRuns(db, store.id),
  ])

  const flagOn = isAutomationFrameworkEnabled()

  const ok = firstStr(req.query.ok) || ''
  const err = firstStr(req.query.err) || ''

  // Group flows for the UI.
  const byGroup = new Map<string, EffectiveFlow[]>()
  for (const ef of effective) {
    const g = groupOf(ef.catalog)
    const bucket = byGroup.get(g) ?? []
    bucket.push(ef)
    byGroup.set(g, bucket)
  }

  const groupSections = GROUP_ORDER
    .filter((g) => byGroup.has(g))
    .map((groupName) => {
      const flows = byGroup.get(groupName) ?? []
      const flowCards = flows.map((ef) => {
        const f = ef.catalog
        const minutes = Math.round(ef.delaySeconds / 60)
        const defaultMins = Math.round(f.delaySeconds / 60)
        return `
          <div class="card" style="margin-bottom:12px">
            <div class="card-body" style="padding:18px">
              <div style="display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:10px">
                <div style="flex:1">
                  <div style="font-weight:600;font-size:14px">${esc(f.label)}</div>
                  <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">${esc(f.description)}</div>
                  <div style="font-size:11px;color:var(--s-text-muted);margin-top:6px">
                    <span style="opacity:0.7">Trigger:</span> <code style="font-size:11px">${esc(f.trigger)}</code>
                    &nbsp;•&nbsp;
                    <span style="opacity:0.7">Default delay:</span> ${esc(formatDelay(f.delaySeconds))}
                    ${ef.hasOverride ? '&nbsp;•&nbsp;<span style="color:var(--s-warning)">Overridden</span>' : ''}
                  </div>
                </div>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">
                  <input type="checkbox"
                    name="flow_${esc(f.key)}_enabled"
                    value="1"
                    form="automations-form"
                    ${ef.enabled ? 'checked' : ''}
                    style="width:16px;height:16px;cursor:pointer" />
                  <span style="font-size:12px;font-weight:500">Enabled</span>
                </label>
              </div>
              <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end">
                <div>
                  <label style="display:block;font-size:12px;color:var(--s-text-dim);margin-bottom:4px">
                    Delay from trigger (minutes). Leave blank to use default (${defaultMins} min).
                  </label>
                  <input type="number"
                    name="flow_${esc(f.key)}_delay_minutes"
                    value="${ef.hasOverride ? minutes : ''}"
                    placeholder="${defaultMins}"
                    min="0"
                    max="${60 * 24 * 30}"
                    form="automations-form"
                    class="form-input"
                    style="width:100%" />
                </div>
                <div style="font-size:12px;color:var(--s-text-dim);padding-bottom:9px">
                  = ${esc(formatDelay(ef.delaySeconds))}
                </div>
              </div>
            </div>
          </div>
        `
      }).join('')

      return `
        <h3 style="font-size:14px;font-weight:600;margin:24px 0 10px 0">${esc(groupName)}</h3>
        ${flowCards}
      `
    })
    .join('')

  const runsRows = recentRuns.length === 0
    ? `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--s-text-dim);font-size:13px">No automation runs yet. Fire a qualifying event (paid order, published product, new customer) to see activity here.</td></tr>`
    : recentRuns.map((r) => {
        const pill = outcomePill(r.outcome)
        const when = new Date(r.created_at).toLocaleString()
        return `
          <tr>
            <td style="padding:8px 10px;font-size:12px">${esc(when)}</td>
            <td style="padding:8px 10px;font-size:12px">${esc(flowLabelByKey(r.flow_key))}</td>
            <td style="padding:8px 10px"><span style="color:${pill.color};font-size:12px;font-weight:500">${pill.label}</span></td>
            <td style="padding:8px 10px;font-size:11px;color:var(--s-text-dim)">${esc(r.reason ?? '')}</td>
          </tr>
        `
      }).join('')

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Automations</h1>
        <p class="page-subtitle">Control which emails send automatically when events happen in your store.</p>
      </div>
    </div>

    ${flagOn ? '' : `
      <div class="alert alert-warning" style="margin-bottom:16px">
        Automations are currently paused for this store. Please contact Gbox support if you expected these to be running.
      </div>
    `}

    ${ok ? `<div class="alert alert-success" style="margin-bottom:16px">${esc(decodeURIComponent(ok))}</div>` : ''}
    ${err ? `<div class="alert alert-error" style="margin-bottom:16px">${esc(decodeURIComponent(err))}</div>` : ''}

    <form id="automations-form"
      method="POST"
      action="${base}/settings/automations"
      style="margin-bottom:24px">
      ${csrfHiddenField(csrfToken)}

      <p style="font-size:12px;color:var(--s-text-dim);margin:0 0 16px 0">
        Each automation runs when a specific event happens (an order is paid, a product is
        published, a customer signs up, …). You can enable or disable each one and tweak the
        delay independently. Disabled automations will never fire for this store.
      </p>

      ${groupSections}

      <div style="display:flex;gap:10px;margin-top:20px">
        <button type="submit" class="btn btn-primary">Save all automations</button>
        <a href="${base}/settings" class="btn btn-outline">Cancel</a>
      </div>
    </form>

    <h3 style="font-size:14px;font-weight:600;margin:32px 0 10px 0">Recent activity</h3>
    <p style="font-size:12px;color:var(--s-text-dim);margin-bottom:12px">
      Last ${recentRuns.length} automation runs for this store. "Skipped" means the event
      fired but conditions didn't match — that's normal for most flows.
    </p>
    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--s-border);background:var(--s-surface-2)">
              <th style="padding:10px;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--s-text-dim);letter-spacing:.04em">When</th>
              <th style="padding:10px;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--s-text-dim);letter-spacing:.04em">Flow</th>
              <th style="padding:10px;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--s-text-dim);letter-spacing:.04em">Outcome</th>
              <th style="padding:10px;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--s-text-dim);letter-spacing:.04em">Reason</th>
            </tr>
          </thead>
          <tbody>
            ${runsRows}
          </tbody>
        </table>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Automations',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'settings',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /settings/automations
//
// Single-form submit: every flow's toggle + delay override is in the
// body at once. Strategy:
//
//   1. For each catalog entry, read `flow_<key>_enabled` + `flow_<key>_delay_minutes`
//      from the body.
//   2. If the row would match catalog defaults exactly (enabled=true,
//      delay_minutes blank) — DELETE the override row (if any). This
//      keeps `automation_flows` free of noise overrides.
//   3. Otherwise UPSERT on (shop_id, flow_key).
//
// Wrapped in a transaction so a partial failure rolls back. Audit +
// bell notification fire OUTSIDE the transaction.
// ---------------------------------------------------------------------------

export async function postSettingsAutomations(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  try {
    const body = req.body as Record<string, unknown>

    let changes = 0
    let deletes = 0

    await (db as any).transaction().execute(async (trx: any) => {
      for (const f of FLOW_CATALOG) {
        const enabledKey = `flow_${f.key}_enabled`
        const delayKey = `flow_${f.key}_delay_minutes`

        const enabled =
          body[enabledKey] === '1' ||
          body[enabledKey] === 'on' ||
          body[enabledKey] === true

        const rawDelay = body[delayKey]
        let delaySeconds: number | null = null // null = catalog default
        if (typeof rawDelay === 'string' && rawDelay.trim() !== '') {
          const mins = Number(rawDelay)
          if (Number.isFinite(mins)) {
            const clamped = Math.max(0, Math.min(60 * 24 * 30, Math.floor(mins)))
            delaySeconds = clamped * 60
          }
        }

        // Short-circuit when the form row matches catalog defaults: no
        // override row needed. This keeps the table lean and makes
        // "reset to defaults" just a matter of clearing the form input.
        const matchesDefaults = enabled === true && delaySeconds === null

        if (matchesDefaults) {
          const del = await trx
            .deleteFrom('automation_flows')
            .where('shop_id', '=', store.id)
            .where('flow_key', '=', f.key)
            .executeTakeFirst()
          if (del && Number((del as any).numDeletedRows ?? 0) > 0) deletes++
          continue
        }

        // UPSERT via Kysely's insert + onConflict pattern — (shop_id,
        // flow_key) has a UNIQUE constraint in migration 085.
        await trx
          .insertInto('automation_flows')
          .values({
            shop_id: store.id,
            flow_key: f.key,
            enabled,
            delay_seconds: delaySeconds,
            conditions: null,
          } as any)
          .onConflict((oc: any) =>
            oc.columns(['shop_id', 'flow_key']).doUpdateSet({
              enabled,
              delay_seconds: delaySeconds,
              updated_at: new Date().toISOString(),
            } as any),
          )
          .execute()
        changes++
      }
    })

    logSellerAction(db, req, 'update', 'settings', 'automations', {
      changes,
      deletes,
    }).catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'app_installed',
      title: 'Automation settings updated',
      message: `${changes} override${changes === 1 ? '' : 's'} saved, ${deletes} reverted to default. ${byActor(user)}`,
      resourceType: 'settings',
      resourceId: null,
    })

    const okMsg = encodeURIComponent(
      `Saved. ${changes} override${changes === 1 ? '' : 's'}, ${deletes} reset to default.`,
    )
    res.redirect(`${base}/settings/automations?ok=${okMsg}`)
  } catch (e) {
    // Iron rule 5: do not surface the module name or the flag. Log for
    // Thai, show a generic message to the merchant.
    console.error('[settings-automations] save failed:', e)
    const errMsg = encodeURIComponent(
      'Could not save automation settings. Please try again or contact Gbox support.',
    )
    res.redirect(`${base}/settings/automations?err=${errMsg}`)
  }
}
