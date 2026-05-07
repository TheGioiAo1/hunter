/**
 * Store Admin — Abandoned Cart Settings (Phase 8 PR2)
 *
 * Seller-facing control surface for the abandoned-cart recovery flow:
 *
 *   • Master enable toggle (kill-switch — turns off enrolment AND the
 *     cron driver for this shop).
 *   • `min_abandoned_minutes` threshold — how long a checkout must sit
 *     untouched before the first step fires.
 *   • Per-step enable + delay override — one card per step from
 *     FLOW_DEFINITIONS.abandoned_cart so merchants can dial in the
 *     cadence (e.g. "skip the 10% discount email, fire the last-call at
 *     24h instead of 72h").
 *   • Recovery-rate card (powered by `computeRecoveryStats`) so
 *     merchants can see the whole flow's effectiveness in the last
 *     30 days without leaving this page.
 *   • "Send recovery now" POST — bypasses delay gating for a single
 *     enrolment when merchants want to nudge a specific checkout that
 *     clearly isn't going to complete on its own.
 *
 * Iron rule 5: no god-admin mentions in any error path — SMTP issues
 * surface as "Please contact Gbox support" with zero leak of the
 * internal configuration surface.
 *
 * Route wiring lives in server.ts under the `/admin/store/:slug/marketing/
 * abandoned/settings` prefix. CSRF is centralised — `req.csrfToken` is
 * populated on every GET by the server-level middleware.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'
import { logSellerAction } from '../middleware/store-auth.js'
import {
  DEFAULT_ABANDONED_CART_SETTINGS,
  computeRecoveryStats,
  dispatchStep,
  getEnrollment,
  getEnrollmentByCheckout,
  resolveSettings,
  selectPendingStep,
  setShopSettings,
  type AbandonedCartSettings,
} from '@gbox/core/modules/marketing/abandoned-cart.js'
import {
  FLOW_DEFINITIONS,
  type EmailFlowStep,
} from '@gbox/core/modules/marketing/email-flows.js'
import { sendEmail } from '@gbox/core/modules/email/service.js'
import { dispatchAbandonedCartTick, buildRenderVars } from '@gbox/core/modules/marketing/abandoned-cart-cron.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

/**
 * Human-friendly label for each flow step id. Keeps the settings UI
 * readable without pushing naming responsibility onto the shared
 * email-flows.ts module (which lives in @gbox/core and doesn't know
 * about seller-facing copy).
 */
function stepLabel(stepId: string): string {
  const labels: Record<string, string> = {
    cart_1_reminder: 'Reminder email',
    cart_2_discount: 'Discount nudge',
    cart_3_last_call: 'Last-call email',
  }
  return labels[stepId] ?? stepId
}

/**
 * Describe each step's default purpose so non-marketing merchants know
 * what they're toggling off. Kept terse — the subject/body preview is
 * a better "what does this actually say" surface (future enhancement).
 */
function stepDescription(stepId: string): string {
  const desc: Record<string, string> = {
    cart_1_reminder:
      'Gentle "you left this behind" nudge, no discount. High open rate.',
    cart_2_discount:
      'Offers a discount code to convert hesitant shoppers. Merchant-supplied code.',
    cart_3_last_call:
      'Final reminder before giving up on the cart. Creates urgency.',
  }
  return desc[stepId] ?? ''
}

/**
 * Format minutes into a human-readable cadence string for the input
 * helper text. "60 → 1 hour", "1440 → 1 day", etc.
 */
function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 60 * 24) {
    const h = minutes / 60
    return `${h === Math.floor(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`
  }
  const d = minutes / (60 * 24)
  return `${d === Math.floor(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// GET /marketing/abandoned/settings
// ---------------------------------------------------------------------------

export async function getAbandonedCartSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfToken = req.csrfToken || ''

  // Load persisted settings + recovery stats in parallel.
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString()
  // Cross-package Kysely type drift — see CLAUDE-EXTENDED.md § "Kysely
  // cross-package mismatch". `db as any` at the callsite is the sanctioned
  // workaround until the packages share a single Kysely install.
  const [settings, stats] = await Promise.all([
    resolveSettings(db as any, store.id),
    computeRecoveryStats(db as any, store.id, thirtyDaysAgo),
  ])

  // Flash messages via ?ok= and ?err= query strings. We deliberately
  // don't rely on a session-based flash middleware because (a) half the
  // store-admin pages already pattern-match ?ok=, (b) it avoids another
  // moving part in the Redis session store.
  const ok = firstStr(req.query.ok) || ''
  const err = firstStr(req.query.err) || ''

  const rate = (stats.rate * 100).toFixed(1)
  const rateColor =
    stats.rate >= 0.15
      ? 'var(--s-success)'
      : stats.rate >= 0.05
        ? 'var(--s-warning)'
        : 'var(--s-danger, #ef4444)'

  // Build per-step cards. We iterate the canonical FLOW_DEFINITIONS so
  // new steps show up automatically if we grow the flow later.
  const stepCards = FLOW_DEFINITIONS.abandoned_cart.steps
    .map((step) => {
      const override = settings.step_overrides[step.id] ?? {
        enabled: true,
        delay_minutes: step.delayMinutes,
      }
      const defaultOverride = DEFAULT_ABANDONED_CART_SETTINGS.step_overrides[step.id]!
      return `
        <div class="card" style="margin-bottom:12px">
          <div class="card-body" style="padding:18px">
            <div style="display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:10px">
              <div style="flex:1">
                <div style="font-weight:600;font-size:14px">${esc(stepLabel(step.id))}</div>
                <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">${esc(stepDescription(step.id))}</div>
                <div style="font-size:11px;color:var(--s-text-muted);margin-top:6px">
                  <span style="opacity:0.7">Default:</span> ${esc(formatDelay(defaultOverride.delay_minutes))} after cart abandon
                </div>
              </div>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">
                <input type="checkbox"
                  name="step_${esc(step.id)}_enabled"
                  value="1"
                  form="abandoned-cart-settings-form"
                  ${override.enabled ? 'checked' : ''}
                  style="width:16px;height:16px;cursor:pointer" />
                <span style="font-size:12px;font-weight:500">Enabled</span>
              </label>
            </div>
            <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end">
              <div>
                <label style="display:block;font-size:12px;color:var(--s-text-dim);margin-bottom:4px">
                  Delay from cart abandon (minutes)
                </label>
                <input type="number"
                  name="step_${esc(step.id)}_delay"
                  value="${override.delay_minutes}"
                  min="0"
                  max="${60 * 24 * 30}"
                  form="abandoned-cart-settings-form"
                  class="form-input"
                  style="width:100%" />
              </div>
              <div style="font-size:12px;color:var(--s-text-dim);padding-bottom:9px">
                = ${esc(formatDelay(override.delay_minutes))}
              </div>
            </div>
          </div>
        </div>
      `
    })
    .join('')

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/marketing/abandoned" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Abandoned carts
        </a>
        <h1 class="page-title">Recovery flow settings</h1>
        <p class="page-subtitle">Control the abandoned-cart recovery emails for <strong>${esc(store.name)}</strong>.</p>
      </div>
    </div>

    ${ok ? `<div class="alert alert-success" style="margin-bottom:16px">${esc(decodeURIComponent(ok))}</div>` : ''}
    ${err ? `<div class="alert alert-error" style="margin-bottom:16px">${esc(decodeURIComponent(err))}</div>` : ''}

    <!-- RECOVERY STATS (last 30d) -->
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card">
        <div class="stat-value">${stats.enrolled}</div>
        <div class="stat-label">Enrolments (30d)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--s-success)">${stats.recovered}</div>
        <div class="stat-label">Recovered (30d)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:${rateColor}">${rate}%</div>
        <div class="stat-label">Recovery rate (30d)</div>
      </div>
    </div>

    <form id="abandoned-cart-settings-form"
      method="POST"
      action="${base}/marketing/abandoned/settings"
      style="margin-bottom:24px">
      ${csrfHiddenField(csrfToken)}

      <!-- MASTER TOGGLE -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-body" style="padding:18px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
            <div>
              <div style="font-weight:600;font-size:14px">Abandoned-cart recovery</div>
              <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">
                When off, no new enrolments are created and no steps are sent for this shop.
                Existing enrolments stay in the database.
              </div>
            </div>
            <label style="position:relative;width:44px;height:24px;cursor:pointer;flex-shrink:0">
              <input type="checkbox" name="enabled" value="1" ${settings.enabled ? 'checked' : ''} style="opacity:0;width:0;height:0;position:absolute" />
              <div style="position:absolute;inset:0;border-radius:12px;background:${settings.enabled ? 'rgba(34,197,94,.8)' : 'var(--s-border)'};transition:background .2s">
                <div style="position:absolute;top:2px;${settings.enabled ? 'right:2px' : 'left:2px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:all .2s"></div>
              </div>
            </label>
          </div>
        </div>
      </div>

      <!-- ABANDON THRESHOLD -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-body" style="padding:18px">
          <label style="display:block;font-weight:600;font-size:14px;margin-bottom:6px">
            Abandon threshold
          </label>
          <div style="font-size:12px;color:var(--s-text-dim);margin-bottom:10px">
            How long a checkout must sit untouched before it's eligible for enrolment.
            Lower = more aggressive (may feel like spam), higher = miss late cart completions.
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <input type="number"
              name="min_abandoned_minutes"
              value="${settings.min_abandoned_minutes}"
              min="10"
              max="${60 * 24 * 7}"
              class="form-input"
              style="max-width:140px" />
            <span style="font-size:13px;color:var(--s-text-dim)">minutes
              (= ${esc(formatDelay(settings.min_abandoned_minutes))})</span>
          </div>
        </div>
      </div>

      <h3 style="font-size:14px;font-weight:600;margin:20px 0 8px 0">Recovery steps</h3>
      <p style="font-size:12px;color:var(--s-text-dim);margin-bottom:12px">
        Each step fires once per enrolment, in order. Delays are measured from the moment
        the cart was first marked abandoned — not from the previous email.
      </p>
      ${stepCards}

      <div style="display:flex;gap:10px;margin-top:20px">
        <button type="submit" class="btn btn-primary">Save changes</button>
        <a href="${base}/marketing/abandoned" class="btn btn-outline">Cancel</a>
      </div>
    </form>
  `

  res.send(sellerLayout({
    title: 'Recovery flow settings',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'marketing',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /marketing/abandoned/settings
// ---------------------------------------------------------------------------

export async function postAbandonedCartSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  try {
    const body = req.body as Record<string, unknown>

    // Master toggle: checkbox → 'on'/'1' when checked, missing when unchecked.
    const enabled = body.enabled === '1' || body.enabled === 'on' || body.enabled === true

    // Abandon threshold — parse + clamp sensible bounds so a slip of the
    // finger can't produce "recover carts after 10 years".
    const rawThreshold = Number(body.min_abandoned_minutes ?? 60)
    const minAbandonedMinutes = Number.isFinite(rawThreshold)
      ? Math.max(10, Math.min(60 * 24 * 7, Math.floor(rawThreshold)))
      : 60

    // Per-step overrides — every step from FLOW_DEFINITIONS gets
    // picked up even if the form was rendered off an older definition.
    const stepOverrides: Record<string, { enabled: boolean; delay_minutes: number }> = {}
    for (const step of FLOW_DEFINITIONS.abandoned_cart.steps) {
      const enabledKey = `step_${step.id}_enabled`
      const delayKey = `step_${step.id}_delay`
      const stepEnabled =
        body[enabledKey] === '1' ||
        body[enabledKey] === 'on' ||
        body[enabledKey] === true
      const rawDelay = Number(body[delayKey] ?? step.delayMinutes)
      const delayMinutes = Number.isFinite(rawDelay)
        ? Math.max(0, Math.min(60 * 24 * 30, Math.floor(rawDelay)))
        : step.delayMinutes
      stepOverrides[step.id] = { enabled: stepEnabled, delay_minutes: delayMinutes }
    }

    const settings: AbandonedCartSettings = {
      enabled,
      min_abandoned_minutes: minAbandonedMinutes,
      step_overrides: stepOverrides,
    }

    await setShopSettings(db as any, store.id, settings)

    // Fire-and-forget audit + bell notification.
    logSellerAction(db, req, 'update', 'settings', 'abandoned_cart_settings', {
      enabled,
      min_abandoned_minutes: minAbandonedMinutes,
    }).catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'app_installed',
      title: 'Abandoned-cart recovery settings updated',
      message: byActor(user),
      resourceType: 'settings',
      resourceId: null,
    })

    const okMsg = encodeURIComponent('Recovery flow settings saved.')
    res.redirect(`${base}/marketing/abandoned/settings?ok=${okMsg}`)
  } catch (e) {
    console.error('[abandoned-cart-settings] save failed:', e)
    const errMsg = encodeURIComponent(
      'Failed to save settings. Please try again or contact Gbox support.',
    )
    res.redirect(`${base}/marketing/abandoned/settings?err=${errMsg}`)
  }
}

// ---------------------------------------------------------------------------
// POST /marketing/abandoned/:enrollmentId/send-now
//
// Bypasses the delay gate and forces the NEXT pending step for a
// specific enrolment. Useful when a merchant wants to nudge a single
// checkout ahead of schedule, or to test that SMTP is wired up without
// waiting 30 minutes for the cron driver to pick it up.
//
// Step selection still respects recovered_at / unsubscribed_at — those
// two aren't overridable from this button.
// ---------------------------------------------------------------------------

export async function postAbandonedCartSendNow(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const enrollmentId = String(req.params.enrollmentId || '')

  if (!enrollmentId) {
    const errMsg = encodeURIComponent('Enrolment not found.')
    res.redirect(`${base}/marketing/abandoned?err=${errMsg}`)
    return
  }

  try {
    const enrollment = await getEnrollment(db as any, store.id, enrollmentId)
    if (!enrollment) {
      const errMsg = encodeURIComponent('Enrolment not found.')
      res.redirect(`${base}/marketing/abandoned?err=${errMsg}`)
      return
    }

    if (enrollment.recovered_at) {
      const errMsg = encodeURIComponent('This cart has already been recovered.')
      res.redirect(`${base}/marketing/abandoned?err=${errMsg}`)
      return
    }
    if (enrollment.unsubscribed_at) {
      const errMsg = encodeURIComponent('This shopper has unsubscribed.')
      res.redirect(`${base}/marketing/abandoned?err=${errMsg}`)
      return
    }

    const settings = await resolveSettings(db as any, store.id)

    // Find the next step that hasn't been sent yet — bypass the delay
    // gate by selecting from the ENABLED effective steps directly.
    const effectiveSteps: EmailFlowStep[] = FLOW_DEFINITIONS.abandoned_cart.steps
      .filter((s) => settings.step_overrides[s.id]?.enabled !== false)
      .map((s) => {
        const o = settings.step_overrides[s.id]
        return o ? { ...s, delayMinutes: o.delay_minutes } : s
      })

    let nextStep: EmailFlowStep | null = null
    if (!enrollment.last_sent_step_id) {
      nextStep = effectiveSteps[0] ?? null
    } else {
      const lastIdx = effectiveSteps.findIndex(
        (s) => s.id === enrollment.last_sent_step_id,
      )
      nextStep = effectiveSteps[lastIdx + 1] ?? null
    }

    if (!nextStep) {
      const errMsg = encodeURIComponent(
        'No more recovery steps to send for this enrolment.',
      )
      res.redirect(`${base}/marketing/abandoned?err=${errMsg}`)
      return
    }

    // Load shop metadata + customer for render vars.
    const shopRow = await (db as any)
      .selectFrom('shops')
      .leftJoin('shop_domains', 'shop_domains.id', 'shops.primary_domain_id')
      .where('shops.id', '=', store.id)
      .select([
        'shops.name as name',
        'shops.slug as slug',
        'shop_domains.domain as primary_domain',
      ])
      .executeTakeFirst()
    const shopMeta = shopRow
      ? {
          name: shopRow.name as string,
          slug: shopRow.slug as string,
          primaryDomain: (shopRow.primary_domain as string | null) ?? null,
        }
      : { name: store.name, slug: store.slug, primaryDomain: null }

    let customer: { first_name: string | null; email: string } | null = null
    if (enrollment.customer_id) {
      const crow = await (db as any)
        .selectFrom('customers')
        .where('id', '=', enrollment.customer_id)
        .select(['first_name', 'email'])
        .executeTakeFirst()
      if (crow) {
        customer = {
          first_name: crow.first_name ?? null,
          email: crow.email ?? enrollment.email,
        }
      }
    }

    const vars = buildRenderVars({
      shop: shopMeta,
      customer,
      email: enrollment.email,
      enrollment: {
        unsubscribe_token: enrollment.unsubscribe_token,
        checkout_id: enrollment.checkout_id,
      },
      discountCode: null,
      platformBaseUrl: process.env.PLATFORM_BASE_URL ?? null,
    })

    const outcome = await dispatchStep(
      db as any,
      store.id,
      enrollment.id,
      nextStep,
      async (to, rendered) => {
        const id = await sendEmail({
          to,
          subject: rendered.subject,
          html: rendered.body,
        })
        return typeof id === 'string' ? id : null
      },
      vars,
    )

    if (outcome.ok) {
      logSellerAction(db, req, 'send', 'abandoned_cart_step', enrollment.id, {
        step_id: nextStep.id,
      }).catch(() => {})

      notify(db, {
        shopId: store.id,
        userId: user.id,
        type: 'app_installed',
        title: `Recovery email sent (${stepLabel(nextStep.id)})`,
        message: `To ${enrollment.email} • ${byActor(user)}`,
        resourceType: 'abandoned_cart_enrollment',
        resourceId: enrollment.id,
      })
      const okMsg = encodeURIComponent(
        `Sent "${stepLabel(nextStep.id)}" to ${enrollment.email}.`,
      )
      res.redirect(`${base}/marketing/abandoned?ok=${okMsg}`)
      return
    }

    // Iron rule 5: do NOT leak the SMTP plumbing to sellers. Whatever
    // the underlying error, we show a clean, non-technical message.
    let userMessage = 'Could not send this email. Please try again.'
    if (outcome.error === 'smtp_unconfigured') {
      userMessage =
        'Email delivery is not set up for this store. Please contact Gbox support.'
    } else if (outcome.error === 'send_failed') {
      userMessage =
        'The recovery email could not be delivered. The address may be invalid.'
    } else if (outcome.error === 'disabled') {
      userMessage =
        'Abandoned-cart recovery is disabled. Enable it in settings first.'
    } else if (outcome.error === 'recovered') {
      userMessage = 'This cart has already been recovered.'
    } else if (outcome.error === 'unsubscribed') {
      userMessage = 'This shopper has unsubscribed.'
    }

    const errMsg = encodeURIComponent(userMessage)
    res.redirect(`${base}/marketing/abandoned?err=${errMsg}`)
  } catch (e) {
    console.error('[abandoned-cart-settings] send-now failed:', e)
    const errMsg = encodeURIComponent(
      'Could not send this email. Please contact Gbox support.',
    )
    res.redirect(`${base}/marketing/abandoned?err=${errMsg}`)
  }
}

// ---------------------------------------------------------------------------
// POST /marketing/abandoned/run-tick
//
// Convenience button: fire a synchronous tick for THIS shop only. The
// cron driver also calls `dispatchAbandonedCartTick(db)` unfiltered,
// but that runs every 30 min. This button is how merchants say "run
// the flow NOW so I can see it work" without rebooting the cron.
//
// Safety: there is no way to over-send from this endpoint because
// `dispatchStep` still enforces delay gating and the 500-per-tick
// MAX_SENDS_PER_TICK budget.
// ---------------------------------------------------------------------------

export async function postAbandonedCartRunTick(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  try {
    const result = await dispatchAbandonedCartTick(db as any)

    logSellerAction(db, req, 'run', 'abandoned_cart_tick', store.id, {
      shopsScanned: result.shopsScanned,
      enrolled: result.enrolled,
      sent: result.sent,
      bounced: result.bounced,
    }).catch(() => {})

    // Was this shop's SMTP broken during the tick? Surface that
    // specifically — otherwise just show the aggregate counters.
    if (result.smtpUnconfiguredShops.includes(store.id)) {
      const errMsg = encodeURIComponent(
        'Email delivery is not set up for this store. Please contact Gbox support.',
      )
      res.redirect(`${base}/marketing/abandoned?err=${errMsg}`)
      return
    }

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'app_installed',
      title: 'Abandoned-cart tick run',
      message: `Enrolled ${result.enrolled}, sent ${result.sent}, bounced ${result.bounced}.`,
      resourceType: 'abandoned_cart_tick',
      resourceId: null,
    })

    const okMsg = encodeURIComponent(
      `Tick complete: enrolled ${result.enrolled}, sent ${result.sent}, bounced ${result.bounced}.`,
    )
    res.redirect(`${base}/marketing/abandoned?ok=${okMsg}`)
  } catch (e) {
    console.error('[abandoned-cart-settings] run-tick failed:', e)
    const errMsg = encodeURIComponent(
      'Could not run the recovery tick. Please contact Gbox support.',
    )
    res.redirect(`${base}/marketing/abandoned?err=${errMsg}`)
  }
}

// Re-export the lookup helper so the abandoned-checkouts.ts list page
// can show whether a given checkout is enrolled in the recovery flow
// without having to import from the core package directly.
export { getEnrollmentByCheckout }
