/**
 * Gbox Platform — Abandoned Cart Service (Phase 8 PR2)
 *
 * Drives automated recovery emails for shoppers who left a checkout
 * session `open` for longer than the merchant's threshold (default 1h).
 *
 * Lifecycle:
 *
 *   checkout_sessions.state='open' stale > N minutes
 *            │
 *            ▼
 *     detectEligibleCarts(db, shop, N) ─► enrollCart(db, ...)
 *            │                                    │
 *            │ (idempotent — UNIQUE checkout_id)  ▼
 *            └───────► abandoned_cart_enrollments row
 *                             │
 *                             ▼ (every 30 min cron)
 *                     selectPendingStep(enrollment, now, settings)
 *                             │
 *                             ▼
 *                     dispatchStep(db, sendEmail, enrollment, step)
 *                             │
 *                             ▼
 *                     markStepSent(db, id, stepId)
 *                             │
 *                             ▼
 *                   (future ticks resume from last_sent_step_id until
 *                    flow exhausted OR recovered_at OR unsubscribed_at)
 *
 * Short-circuits:
 *   • `recovered_at` set when matching `checkout_sessions.state` flips
 *     to `completed` (orders service hook calls `markRecovered`).
 *   • `unsubscribed_at` set when the customer hits `/unsubscribe/:token`.
 *
 * Tenancy: every mutating entry point takes `shopId` and cross-shop
 * access returns `null` or `{ ok:false, error:'not_found' }`. The
 * public unsubscribe lookup is token-based (32 hex chars, unique across
 * the whole table) so it works without a shop scope.
 */

import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  emitIfEnabled,
  isAutomationFrameworkEnabled,
} from '../automations/feature-flag.js'
import {
  FLOW_DEFINITIONS,
  renderEmailStep,
  type EmailFlowStep,
  type EmailRenderVars,
  type RenderedEmail,
} from './email-flows.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AbandonedCartEnrollmentRow {
  id: string
  shop_id: string
  checkout_id: string
  customer_id: string | null
  email: string
  enrolled_at: string
  last_sent_step_id: string | null
  last_sent_at: string | null
  recovered_at: string | null
  unsubscribed_at: string | null
  unsubscribe_token: string
  error: string | null
  created_at: string
  updated_at: string
}

/**
 * Effective settings after merging the merchant's overrides onto the
 * defaults. `step_overrides` is keyed by `EmailFlowStep.id`; any
 * missing key falls through to the FLOW_DEFINITIONS delay.
 */
export interface AbandonedCartSettings {
  enabled: boolean
  min_abandoned_minutes: number
  step_overrides: Record<string, { enabled: boolean; delay_minutes: number }>
}

export interface EligibleCart {
  id: string
  shop_id: string
  customer_id: string | null
  email: string
  updated_at: string
  cart_json: unknown
}

export interface DetectFilter {
  /** If provided, only consider carts this many minutes stale or more.
   *  Defaults to the shop's `min_abandoned_minutes` setting. */
  minAbandonedMinutes?: number
  /** Cap rows returned per tick to avoid runaway inserts. Default 500. */
  limit?: number
}

export type EnrollResult =
  | { ok: true; enrollment: AbandonedCartEnrollmentRow; created: boolean }
  | { ok: false; error: EnrollError }

export type EnrollError =
  | 'email_required'
  | 'checkout_not_found'
  | 'already_recovered'

export type DispatchStepResult =
  | { ok: true; stepId: string; messageId: string | null }
  | { ok: false; error: DispatchError; stepId?: string }

export type DispatchError =
  | 'no_step_due'
  | 'not_found'
  | 'recovered'
  | 'unsubscribed'
  | 'disabled'
  | 'send_failed'
  | 'smtp_unconfigured'
  // PR3 migration: when AUTOMATION_FRAMEWORK_V2=1, the new event-driven
  // runner owns abandoned-cart reminder sends. Legacy dispatchStep()
  // short-circuits with this reason so the cron driver can log without
  // emitting SMTP activity — double-send guard.
  | 'skipped_framework_v2'

// ---------------------------------------------------------------------------
// Defaults & settings merge
// ---------------------------------------------------------------------------

/**
 * Baseline settings the platform ships with. Overridden per-shop via
 * `shops.abandoned_cart_settings` jsonb (migration 063).
 */
export const DEFAULT_ABANDONED_CART_SETTINGS: AbandonedCartSettings = {
  enabled: true,
  min_abandoned_minutes: 60,
  step_overrides: Object.fromEntries(
    FLOW_DEFINITIONS.abandoned_cart.steps.map((s) => [
      s.id,
      { enabled: true, delay_minutes: s.delayMinutes },
    ]),
  ),
}

/**
 * Pure merge of raw jsonb → effective settings. Used by both the
 * service and the admin page so they stay in lock-step. Unknown keys
 * in `raw` are ignored; missing keys fall through to defaults.
 */
export function mergeSettings(
  raw: unknown,
): AbandonedCartSettings {
  const out: AbandonedCartSettings = {
    enabled: DEFAULT_ABANDONED_CART_SETTINGS.enabled,
    min_abandoned_minutes: DEFAULT_ABANDONED_CART_SETTINGS.min_abandoned_minutes,
    step_overrides: { ...DEFAULT_ABANDONED_CART_SETTINGS.step_overrides },
  }
  if (!raw || typeof raw !== 'object') return out

  const r = raw as Record<string, unknown>
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.min_abandoned_minutes === 'number' && r.min_abandoned_minutes > 0) {
    out.min_abandoned_minutes = Math.floor(r.min_abandoned_minutes)
  }
  if (r.step_overrides && typeof r.step_overrides === 'object') {
    const so = r.step_overrides as Record<string, unknown>
    for (const step of FLOW_DEFINITIONS.abandoned_cart.steps) {
      const override = so[step.id]
      if (override && typeof override === 'object') {
        const o = override as Record<string, unknown>
        const existing = out.step_overrides[step.id]!
        out.step_overrides[step.id] = {
          enabled: typeof o.enabled === 'boolean' ? o.enabled : existing.enabled,
          delay_minutes:
            typeof o.delay_minutes === 'number' && o.delay_minutes >= 0
              ? Math.floor(o.delay_minutes)
              : existing.delay_minutes,
        }
      }
    }
  }
  return out
}

export async function resolveSettings(
  db: Kysely<Database>,
  shopId: string,
): Promise<AbandonedCartSettings> {
  const row = await (db as any)
    .selectFrom('shops')
    .where('id', '=', shopId)
    .select('abandoned_cart_settings')
    .executeTakeFirst()
  return mergeSettings(row?.abandoned_cart_settings)
}

/**
 * Overwrite persisted settings for a shop. Caller is responsible for
 * tenancy (this only writes; reads happen via resolveSettings).
 */
export async function setShopSettings(
  db: Kysely<Database>,
  shopId: string,
  settings: AbandonedCartSettings,
): Promise<AbandonedCartSettings> {
  await (db as any)
    .updateTable('shops')
    .set({
      abandoned_cart_settings: JSON.stringify(settings),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', shopId)
    .execute()
  return settings
}

// ---------------------------------------------------------------------------
// Step selection (pure)
// ---------------------------------------------------------------------------

/**
 * Given an enrolment, the merchant's effective settings, and the
 * current time, returns the next step that should fire — or null when
 * nothing is due (flow exhausted, step disabled, delay not yet
 * elapsed, enrolment already recovered / unsubscribed).
 *
 * This is a pure function: it does NOT talk to the DB and takes no
 * side effects. The cron driver uses it to decide whether to send.
 */
export function selectPendingStep(
  enrollment: Pick<
    AbandonedCartEnrollmentRow,
    'enrolled_at' | 'last_sent_step_id' | 'recovered_at' | 'unsubscribed_at'
  >,
  settings: AbandonedCartSettings,
  now: Date,
): EmailFlowStep | null {
  if (!settings.enabled) return null
  if (enrollment.recovered_at) return null
  if (enrollment.unsubscribed_at) return null

  // Apply per-step delay overrides by cloning the flow steps with
  // overridden delays (and filtering disabled steps out of the
  // candidate list). We intentionally preserve step order so
  // nextStepDue's "last sent" pointer still lines up.
  const effectiveSteps: EmailFlowStep[] = FLOW_DEFINITIONS.abandoned_cart.steps
    .filter((s) => {
      const o = settings.step_overrides[s.id]
      return o ? o.enabled : true
    })
    .map((s) => {
      const o = settings.step_overrides[s.id]
      return o ? { ...s, delayMinutes: o.delay_minutes } : s
    })

  if (effectiveSteps.length === 0) return null

  // Compute elapsed minutes since enrolment. We operate on the
  // OVERRIDDEN step list so merchant delay tweaks take effect
  // immediately (no need to wait for the cron driver to reload).
  const enrolledAt = new Date(enrollment.enrolled_at)
  const elapsedMinutes =
    (now.getTime() - enrolledAt.getTime()) / 60_000
  if (elapsedMinutes < 0) return null

  // If the merchant has disabled a step that was previously sent, the
  // lastSentStepId won't appear in effectiveSteps. Treat that as
  // "pointer not in list" → start from the beginning of the filtered
  // list — easier to reason about than silently skipping.
  const lastIdx = enrollment.last_sent_step_id
    ? effectiveSteps.findIndex((s) => s.id === enrollment.last_sent_step_id)
    : -1

  for (let i = lastIdx + 1; i < effectiveSteps.length; i++) {
    const step = effectiveSteps[i]!
    if (elapsedMinutes >= step.delayMinutes) return step
    // Steps are monotonically delayed within the effective list; the
    // first un-due step means all later ones are also un-due.
    return null
  }
  return null
}

// ---------------------------------------------------------------------------
// Detect + enrol
// ---------------------------------------------------------------------------

/**
 * Finds checkout_sessions that are:
 *   • `state='open'`
 *   • not already enrolled (LEFT JOIN IS NULL)
 *   • older than `minAbandonedMinutes` (minutes)
 *   • have an email (we need a destination)
 *
 * The JOIN to `customers` is LEFT so we still pick up guest checkouts,
 * provided the checkout row itself has an email field (storefront may
 * collect it pre-auth). If the checkout has no email and no customer,
 * the row is skipped — no point enrolling a cart we can't reach.
 */
export async function detectEligibleCarts(
  db: Kysely<Database>,
  shopId: string,
  filter: DetectFilter = {},
): Promise<EligibleCart[]> {
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000)
  const settings = await resolveSettings(db, shopId)
  if (!settings.enabled) return []

  const minMinutes = filter.minAbandonedMinutes ?? settings.min_abandoned_minutes
  const cutoff = new Date(Date.now() - minMinutes * 60_000).toISOString()

  // Pull candidate open checkouts + left-join enrolments; filter
  // rows already enrolled in-memory so we keep the SQL portable
  // across test stubs.
  const candidates = await (db as any)
    .selectFrom('checkout_sessions as cs')
    .leftJoin('abandoned_cart_enrollments as ace', 'ace.checkout_id', 'cs.id')
    .leftJoin('customers as c', 'c.id', 'cs.customer_id')
    .where('cs.shop_id', '=', shopId)
    .where('cs.state', '=', 'open')
    .where('cs.updated_at', '<=', cutoff)
    .where('ace.id', 'is', null)
    .select([
      'cs.id as id',
      'cs.shop_id as shop_id',
      'cs.customer_id as customer_id',
      'cs.updated_at as updated_at',
      'cs.cart_json as cart_json',
      'c.email as customer_email',
      'c.accepts_marketing as accepts_marketing',
    ])
    .orderBy('cs.updated_at', 'asc')
    .limit(limit)
    .execute()

  const out: EligibleCart[] = []
  for (const r of candidates) {
    const email = (r.customer_email ?? '').trim()
    if (!email) continue
    // Respect customer-level marketing opt-out even for recovery.
    // A "legitimate interest" defence might allow it in some regions
    // but the safer default is skip — the customer can still recover
    // the cart via their own path.
    if (r.accepts_marketing === false) continue
    out.push({
      id: r.id,
      shop_id: r.shop_id,
      customer_id: r.customer_id,
      email,
      updated_at:
        typeof r.updated_at === 'string'
          ? r.updated_at
          : new Date(r.updated_at).toISOString(),
      cart_json: r.cart_json,
    })
  }
  return out
}

/**
 * Inserts or no-ops an enrolment row. UNIQUE(checkout_id) makes
 * re-runs safe; on conflict we reload and return the existing row
 * with `created=false`.
 */
export async function enrollCart(
  db: Kysely<Database>,
  shopId: string,
  cart: Pick<EligibleCart, 'id' | 'customer_id' | 'email'>,
  opts: { enrolled_at?: Date } = {},
): Promise<EnrollResult> {
  const email = (cart.email ?? '').trim()
  if (!email) return { ok: false, error: 'email_required' }

  const token = randomBytes(16).toString('hex')
  const enrolledAt = (opts.enrolled_at ?? new Date()).toISOString()

  const inserted = await (db as any)
    .insertInto('abandoned_cart_enrollments')
    .values({
      shop_id: shopId,
      checkout_id: cart.id,
      customer_id: cart.customer_id ?? null,
      email,
      enrolled_at: enrolledAt,
      unsubscribe_token: token,
    })
    .onConflict((oc: any) => oc.column('checkout_id').doNothing())
    .returningAll()
    .executeTakeFirst()

  if (inserted) {
    // --- PR3 automation emit (Phase 8 migration) ---------------------
    // Emit `checkout.abandoned` on every NEW enrolment. The new
    // framework's three catalog entries (abandoned_cart_reminder_1/2/3)
    // enqueue at +1h / +24h / +72h respectively. Legacy dispatchStep()
    // short-circuits below when the flag is on — no double-send.
    await emitIfEnabled(db, {
      type: 'checkout.abandoned',
      shopId,
      checkoutId: cart.id,
      customerEmail: email,
      customerId: (cart.customer_id as string | null) ?? null,
      abandonedAt: new Date(enrolledAt),
    })
    return { ok: true, enrollment: coerce(inserted), created: true }
  }

  // Already enrolled — reload + return.
  const existing = await (db as any)
    .selectFrom('abandoned_cart_enrollments')
    .where('checkout_id', '=', cart.id)
    .where('shop_id', '=', shopId)
    .selectAll()
    .executeTakeFirst()
  if (!existing) return { ok: false, error: 'checkout_not_found' }
  return { ok: true, enrollment: coerce(existing), created: false }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface EmailSender {
  (to: string, rendered: RenderedEmail): Promise<string | null>
}

/**
 * Renders the step, calls the injected sender (the cron driver passes
 * `email/service.ts::sendEmail`), and stamps `last_sent_step_id` on
 * success. On sender failure, records the error on the enrolment row
 * and returns `send_failed`. The caller decides whether to retry.
 *
 * Tenancy: pulls the enrolment fresh to ensure it still matches the
 * expected shopId.
 */
export async function dispatchStep(
  db: Kysely<Database>,
  shopId: string,
  enrollmentId: string,
  step: EmailFlowStep,
  sender: EmailSender,
  vars: EmailRenderVars = {},
): Promise<DispatchStepResult> {
  // --- PR3 migration: flag-gated short-circuit -------------------------
  // When AUTOMATION_FRAMEWORK_V2=1, the new event-driven runner is the
  // single source of truth for abandoned-cart reminders. Short-circuit
  // here so the Phase 8 cron's call into dispatchStep becomes a no-op
  // (no SMTP, no row mutation), preventing double-sends for enrolments
  // that now also have automation_scheduled queue rows.
  //
  // We keep this as an `ok: false` response so the cron driver's
  // existing error accounting still fires (it was already built to
  // tolerate per-step failures).
  if (isAutomationFrameworkEnabled()) {
    return { ok: false, error: 'skipped_framework_v2', stepId: step.id }
  }

  const enrollment = await (db as any)
    .selectFrom('abandoned_cart_enrollments')
    .where('id', '=', enrollmentId)
    .where('shop_id', '=', shopId)
    .selectAll()
    .executeTakeFirst()
  if (!enrollment) return { ok: false, error: 'not_found' }
  if (enrollment.recovered_at) return { ok: false, error: 'recovered' }
  if (enrollment.unsubscribed_at) return { ok: false, error: 'unsubscribed' }

  const rendered = renderEmailStep(step, vars)

  let messageId: string | null = null
  try {
    messageId = await sender(enrollment.email, rendered)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await (db as any)
      .updateTable('abandoned_cart_enrollments')
      .set({ error: msg.slice(0, 500), updated_at: new Date().toISOString() })
      .where('id', '=', enrollmentId)
      .execute()
    // Distinguish the SMTP-missing case so the cron driver can
    // surface a single seller-facing banner instead of N per-recipient
    // errors. Keep the string stable — `campaigns-cron.ts` uses the
    // same sentinel.
    if (/SMTP.*not configured|SMTP_HOST/i.test(msg)) {
      return { ok: false, error: 'smtp_unconfigured', stepId: step.id }
    }
    return { ok: false, error: 'send_failed', stepId: step.id }
  }

  await (db as any)
    .updateTable('abandoned_cart_enrollments')
    .set({
      last_sent_step_id: step.id,
      last_sent_at: new Date().toISOString(),
      error: null,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', enrollmentId)
    .execute()

  return { ok: true, stepId: step.id, messageId }
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/**
 * Called by the orders service when a checkout transitions to
 * `completed`. Stamps `recovered_at` on every enrolment for that
 * checkout. Safe to call more than once — sets to NOW() only if
 * currently NULL. Returns the number of enrolments flipped.
 */
export async function markRecovered(
  db: Kysely<Database>,
  checkoutId: string,
): Promise<number> {
  const res = await (db as any)
    .updateTable('abandoned_cart_enrollments')
    .set({
      recovered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where('checkout_id', '=', checkoutId)
    .where('recovered_at', 'is', null)
    .execute()
  const first = Array.isArray(res) ? res[0] : res
  return Number(first?.numUpdatedRows ?? first?.numChangedRows ?? 0)
}

/**
 * Public unsubscribe endpoint lookup. Flips `unsubscribed_at` if the
 * token matches an active enrolment. Returns `true` on a fresh
 * unsubscribe, `false` if already unsubscribed or token invalid (we
 * conflate these two intentionally so a probe can't enumerate valid
 * tokens).
 */
export async function unsubscribeByToken(
  db: Kysely<Database>,
  token: string,
): Promise<{ ok: true; enrollment: AbandonedCartEnrollmentRow } | { ok: false }> {
  if (!token || token.length !== 32) return { ok: false }
  const existing = await (db as any)
    .selectFrom('abandoned_cart_enrollments')
    .where('unsubscribe_token', '=', token)
    .selectAll()
    .executeTakeFirst()
  if (!existing) return { ok: false }
  if (existing.unsubscribed_at) {
    return { ok: true, enrollment: coerce(existing) }
  }
  const updated = await (db as any)
    .updateTable('abandoned_cart_enrollments')
    .set({
      unsubscribed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where('unsubscribe_token', '=', token)
    .returningAll()
    .executeTakeFirstOrThrow()
  return { ok: true, enrollment: coerce(updated) }
}

/**
 * Find a single enrolment by id + shop for admin views.
 */
export async function getEnrollment(
  db: Kysely<Database>,
  shopId: string,
  id: string,
): Promise<AbandonedCartEnrollmentRow | null> {
  const row = await (db as any)
    .selectFrom('abandoned_cart_enrollments')
    .where('id', '=', id)
    .where('shop_id', '=', shopId)
    .selectAll()
    .executeTakeFirst()
  return row ? coerce(row) : null
}

export async function getEnrollmentByCheckout(
  db: Kysely<Database>,
  shopId: string,
  checkoutId: string,
): Promise<AbandonedCartEnrollmentRow | null> {
  const row = await (db as any)
    .selectFrom('abandoned_cart_enrollments')
    .where('checkout_id', '=', checkoutId)
    .where('shop_id', '=', shopId)
    .selectAll()
    .executeTakeFirst()
  return row ? coerce(row) : null
}

// ---------------------------------------------------------------------------
// Stats for admin (recovery rate)
// ---------------------------------------------------------------------------

export interface RecoveryStats {
  /** Total enrolments in window. */
  enrolled: number
  /** Enrolments with recovered_at set. */
  recovered: number
  /** recovered / enrolled (0..1), 0 when enrolled=0. */
  rate: number
}

export async function computeRecoveryStats(
  db: Kysely<Database>,
  shopId: string,
  sinceIso?: string,
): Promise<RecoveryStats> {
  let enrolledQ = (db as any)
    .selectFrom('abandoned_cart_enrollments')
    .where('shop_id', '=', shopId)
  let recoveredQ = (db as any)
    .selectFrom('abandoned_cart_enrollments')
    .where('shop_id', '=', shopId)
    .where('recovered_at', 'is not', null)
  if (sinceIso) {
    enrolledQ = enrolledQ.where('enrolled_at', '>=', sinceIso)
    recoveredQ = recoveredQ.where('enrolled_at', '>=', sinceIso)
  }
  const [enrolledR, recoveredR] = await Promise.all([
    enrolledQ.select((eb: any) => eb.fn.count('id').as('count')).executeTakeFirst(),
    recoveredQ.select((eb: any) => eb.fn.count('id').as('count')).executeTakeFirst(),
  ])
  const enrolled = Number(enrolledR?.count ?? 0)
  const recovered = Number(recoveredR?.count ?? 0)
  return {
    enrolled,
    recovered,
    rate: enrolled === 0 ? 0 : recovered / enrolled,
  }
}

// ---------------------------------------------------------------------------
// Internal: row coercion
// ---------------------------------------------------------------------------

function coerce(r: any): AbandonedCartEnrollmentRow {
  const toIso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null
    if (typeof v === 'string') return v
    if (v instanceof Date) return v.toISOString()
    return String(v)
  }
  return {
    id: r.id,
    shop_id: r.shop_id,
    checkout_id: r.checkout_id,
    customer_id: r.customer_id ?? null,
    email: r.email,
    enrolled_at: toIso(r.enrolled_at) ?? new Date().toISOString(),
    last_sent_step_id: r.last_sent_step_id ?? null,
    last_sent_at: toIso(r.last_sent_at),
    recovered_at: toIso(r.recovered_at),
    unsubscribed_at: toIso(r.unsubscribed_at),
    unsubscribe_token: r.unsubscribe_token,
    error: r.error ?? null,
    created_at: toIso(r.created_at) ?? new Date().toISOString(),
    updated_at: toIso(r.updated_at) ?? new Date().toISOString(),
  }
}
