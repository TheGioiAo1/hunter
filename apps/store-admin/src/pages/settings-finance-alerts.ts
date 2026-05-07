/**
 * Store Admin — Finance alerts (Phase 14 PR6 commit 8)
 *
 * Dedicated control surface for the merchant-audience finance + fraud
 * automation flows the platform ships in PR6. Conceptually a narrow
 * slice of `/settings/automations`, but pulled onto its own page so:
 *
 *   • Merchants looking for "turn off the fraud email" don't have to
 *     scroll past 18 marketing/lifecycle toggles to find it.
 *   • The 5 Phase 12 deferred payout/chargeback entries get a clean
 *     "Coming with payouts" affordance without polluting the main
 *     automations page with disabled rows.
 *   • Future finance-only settings (payout cadence, risk threshold
 *     tuning) have a natural home.
 *
 * Scope: the 10 PR6 flow-catalog finance entries. 5 wired (live toggles,
 * persisted to `automation_flows`). 5 deferred (payout×3, chargeback×2)
 * rendered as disabled rows with a badge.
 *
 * Persistence re-uses the SAME `automation_flows` table as
 * `settings-automations.ts` (no new schema). The unified automations
 * page is the source of truth; this page is a focused alternate view
 * onto the same rows.
 *
 * Iron rule 5 compliance
 * ---------------------
 *   - "Coming with payouts" badge wording never references Phase 12,
 *     Stripe Connect, or any internal feature-flag name.
 *   - Error path routes through a generic "Please contact Gbox support"
 *     message. No module name, no god-admin leak.
 *   - Kill-switch banner uses the same seller-safe phrasing as
 *     settings-automations.ts ("currently paused for this store").
 *
 * Route wiring
 * ------------
 *   GET  /admin/store/:slug/settings/finance-alerts
 *   POST /admin/store/:slug/settings/finance-alerts
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'
import { logSellerAction } from '../middleware/store-auth.js'
import {
  FLOW_CATALOG,
  isAutomationFrameworkEnabled,
  type FlowCatalogEntry,
} from '@gbox/core/modules/automations/index.js'

// ---------------------------------------------------------------------------
// Scope — the exact 10 catalog keys this page owns.
//
// Hand-maintained rather than pattern-matched because the finance bucket
// is defined by product intent ("merchant-audience finance + fraud"),
// not by a key prefix. `payment_failed_customer` ALSO has "payment_
// failed" in the name but belongs on the Transactional tab of
// /settings/automations — so a prefix match would be wrong.
// ---------------------------------------------------------------------------

/** 5 keys whose emit sites exist today (PR6 wired these). */
const FINANCE_WIRED: readonly string[] = [
  'refund_issued_merchant',
  'payment_failed_merchant',
  'high_risk_order',
  'out_of_stock_alert',
  'first_time_customer_order',
] as const

/**
 * 5 keys whose catalog entries exist but have no emit site. Phase 12
 * (Stripe Connect payouts + dispute webhook) lights them up. Rendered
 * as disabled rows with a "Coming with payouts" badge — seller-safe
 * copy, no internal phase/feature naming.
 */
const FINANCE_DEFERRED: readonly string[] = [
  'payout_scheduled',
  'payout_completed',
  'payout_failed',
  'chargeback_opened',
  'chargeback_lost',
] as const

const FINANCE_KEYS: ReadonlySet<string> = new Set([
  ...FINANCE_WIRED,
  ...FINANCE_DEFERRED,
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

/** Human-readable delay. "0 → Immediate", "3600 → 1 hour", etc. */
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

interface EffectiveFlow {
  catalog: FlowCatalogEntry
  enabled: boolean       // effective (override || catalog default TRUE)
  delaySeconds: number   // effective (override || catalog default)
  hasOverride: boolean   // for "reset to default" affordance
  deferred: boolean      // true for the 5 Phase 12 entries
}

async function loadFinanceFlows(
  db: Kysely<Database>,
  shopId: string,
): Promise<EffectiveFlow[]> {
  const overrides = await (db as any)
    .selectFrom('automation_flows')
    .select(['flow_key', 'enabled', 'delay_seconds'])
    .where('shop_id', '=', shopId)
    .where('flow_key', 'in', [...FINANCE_KEYS])
    .execute()

  const byKey = new Map<string, { enabled: boolean; delay_seconds: number | null }>()
  for (const row of overrides) {
    byKey.set(row.flow_key, {
      enabled: row.enabled,
      delay_seconds: row.delay_seconds,
    })
  }

  const rows: EffectiveFlow[] = []
  for (const catalog of FLOW_CATALOG) {
    if (!FINANCE_KEYS.has(catalog.key)) continue
    const ov = byKey.get(catalog.key)
    rows.push({
      catalog,
      enabled: ov ? ov.enabled : true,
      delaySeconds: ov?.delay_seconds ?? catalog.delaySeconds,
      hasOverride: ov != null,
      deferred: FINANCE_DEFERRED.includes(catalog.key),
    })
  }
  return rows
}

async function loadRecentFinanceRuns(
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
    .where('flow_key', 'in', [...FINANCE_WIRED])
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
// GET /settings/finance-alerts
// ---------------------------------------------------------------------------

export async function getSettingsFinanceAlerts(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfToken = req.csrfToken || ''

  // API mode (no local DB): build flows from catalog defaults (enabled=true, delay from catalog),
  // runs = []. UI still renders all wired/deferred cards but overrides cannot be saved.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let financeFlows: EffectiveFlow[] = []
  let recentRuns: Array<{ id: string; flow_key: string; outcome: string; reason: string | null; created_at: string }> = []

  if (hasDb) {
    try {
      ;[financeFlows, recentRuns] = await Promise.all([
        loadFinanceFlows(db, store.id),
        loadRecentFinanceRuns(db, store.id),
      ])
    } catch (e: any) {
      console.warn('[settings-finance-alerts] DB read failed:', e?.message)
    }
  }
  if (financeFlows.length === 0) {
    financeFlows = FLOW_CATALOG.filter(f => FINANCE_KEYS.has(f.key)).map(catalog => ({
      catalog,
      enabled: true,
      delaySeconds: catalog.delaySeconds,
      hasOverride: false,
      deferred: FINANCE_DEFERRED.includes(catalog.key),
    }))
  }

  const flagOn = isAutomationFrameworkEnabled()

  const ok = firstStr(req.query.ok) || ''
  const err = firstStr(req.query.err) || ''

  const wiredCards = financeFlows
    .filter((ef) => !ef.deferred)
    .map((ef) => {
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
                  form="finance-alerts-form"
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
                  form="finance-alerts-form"
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
    })
    .join('')

  const deferredCards = financeFlows
    .filter((ef) => ef.deferred)
    .map((ef) => {
      const f = ef.catalog
      return `
        <div class="card" style="margin-bottom:12px;opacity:0.72">
          <div class="card-body" style="padding:18px">
            <div style="display:flex;align-items:start;justify-content:space-between;gap:16px">
              <div style="flex:1">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <div style="font-weight:600;font-size:14px">${esc(f.label)}</div>
                  <span style="display:inline-block;background:var(--s-surface-2);border:1px solid var(--s-border);border-radius:999px;padding:2px 8px;font-size:10px;font-weight:600;color:var(--s-text-dim);text-transform:uppercase;letter-spacing:0.04em">Coming with payouts</span>
                </div>
                <div style="font-size:12px;color:var(--s-text-dim)">${esc(f.description)}</div>
                <div style="font-size:11px;color:var(--s-text-muted);margin-top:6px">
                  Will turn on automatically once payouts are live for your store. No action required.
                </div>
              </div>
              <label style="display:flex;align-items:center;gap:8px;user-select:none;cursor:not-allowed">
                <input type="checkbox" disabled style="width:16px;height:16px;cursor:not-allowed;opacity:0.5" />
                <span style="font-size:12px;font-weight:500;color:var(--s-text-dim)">Not yet</span>
              </label>
            </div>
          </div>
        </div>
      `
    })
    .join('')

  const runsRows = recentRuns.length === 0
    ? `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--s-text-dim);font-size:13px">No finance alerts have fired yet. A refund, failed payment, out-of-stock variant, or flagged order will show up here.</td></tr>`
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
        <h1 class="page-title">Finance alerts</h1>
        <p class="page-subtitle">Email alerts for refunds, failed payments, fraud flags, inventory, and payouts.</p>
      </div>
    </div>

    ${flagOn ? '' : `
      <div class="alert alert-warning" style="margin-bottom:16px">
        Finance alerts are currently paused for this store. Please contact Gbox support if you expected these to be running.
      </div>
    `}

    ${ok ? `<div class="alert alert-success" style="margin-bottom:16px">${esc(decodeURIComponent(ok))}</div>` : ''}
    ${err ? `<div class="alert alert-error" style="margin-bottom:16px">${esc(decodeURIComponent(err))}</div>` : ''}

    <form id="finance-alerts-form"
      method="POST"
      action="${base}/settings/finance-alerts"
      style="margin-bottom:24px">
      ${csrfHiddenField(csrfToken)}

      <h3 style="font-size:14px;font-weight:600;margin:8px 0 8px 0">Live alerts</h3>
      <p style="font-size:12px;color:var(--s-text-dim);margin:0 0 16px 0">
        These send automatically when the matching event happens on your store. Disable any of
        them if they're noisier than useful — you can re-enable at any time.
      </p>
      ${wiredCards}

      <div style="display:flex;gap:10px;margin-top:20px">
        <button type="submit" class="btn btn-primary">Save alert settings</button>
        <a href="${base}/settings" class="btn btn-outline">Cancel</a>
      </div>
    </form>

    <h3 style="font-size:14px;font-weight:600;margin:32px 0 8px 0">Payouts &amp; disputes</h3>
    <p style="font-size:12px;color:var(--s-text-dim);margin:0 0 16px 0">
      These alerts turn on automatically once payouts are live for your store — you don't need
      to do anything. Listed here so you know what to expect.
    </p>
    ${deferredCards}

    <h3 style="font-size:14px;font-weight:600;margin:32px 0 10px 0">Recent finance alerts</h3>
    <p style="font-size:12px;color:var(--s-text-dim);margin-bottom:12px">
      Last ${recentRuns.length} finance alert run${recentRuns.length === 1 ? '' : 's'} for this store.
      "Skipped (duplicate)" means the same alert already fired recently and was suppressed — that's expected.
    </p>
    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--s-border);background:var(--s-surface-2)">
              <th style="padding:10px;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--s-text-dim);letter-spacing:.04em">When</th>
              <th style="padding:10px;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--s-text-dim);letter-spacing:.04em">Alert</th>
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
    title: 'Finance alerts',
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
// POST /settings/finance-alerts
//
// Same UPSERT / delete-on-defaults pattern as settings-automations.ts.
// Scope limited to the 5 WIRED keys — deferred keys have no form inputs
// so they can't be touched from this page. If someone POSTs a deferred
// key by hand we ignore it (belt + suspenders: still-in-FINANCE_WIRED
// guard below).
// ---------------------------------------------------------------------------

export async function postSettingsFinanceAlerts(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  // API mode (no local DB): no BE endpoint for automation_flows → show banner.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    res.redirect(`${base}/settings/finance-alerts?err=${encodeURIComponent('Saving flow overrides requires local DB or a BE endpoint - not supported in API mode.')}`)
    return
  }

  try {
    const body = req.body as Record<string, unknown>

    let changes = 0
    let deletes = 0

    await (db as any).transaction().execute(async (trx: any) => {
      for (const f of FLOW_CATALOG) {
        if (!FINANCE_WIRED.includes(f.key)) continue

        const enabledKey = `flow_${f.key}_enabled`
        const delayKey = `flow_${f.key}_delay_minutes`

        const enabled =
          body[enabledKey] === '1' ||
          body[enabledKey] === 'on' ||
          body[enabledKey] === true

        const rawDelay = body[delayKey]
        let delaySeconds: number | null = null
        if (typeof rawDelay === 'string' && rawDelay.trim() !== '') {
          const mins = Number(rawDelay)
          if (Number.isFinite(mins)) {
            const clamped = Math.max(0, Math.min(60 * 24 * 30, Math.floor(mins)))
            delaySeconds = clamped * 60
          }
        }

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

    logSellerAction(db, req, 'update', 'settings', 'finance-alerts', {
      changes,
      deletes,
    }).catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'app_installed',
      title: 'Finance alerts updated',
      message: `${changes} override${changes === 1 ? '' : 's'} saved, ${deletes} reverted to default. ${byActor(user)}`,
      resourceType: 'settings',
      resourceId: null,
    })

    const okMsg = encodeURIComponent(
      `Saved. ${changes} override${changes === 1 ? '' : 's'}, ${deletes} reset to default.`,
    )
    res.redirect(`${base}/settings/finance-alerts?ok=${okMsg}`)
  } catch (e) {
    console.error('[settings-finance-alerts] save failed:', e)
    const errMsg = encodeURIComponent(
      'Could not save finance alert settings. Please try again or contact Gbox support.',
    )
    res.redirect(`${base}/settings/finance-alerts?err=${errMsg}`)
  }
}
