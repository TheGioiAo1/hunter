/**
 * Gbox Platform — Abandoned Cart Cron Handler (Phase 8 PR2)
 *
 * Every 30 min the driver ticks `dispatch_abandoned_cart_steps`:
 *
 *   1. Find every active shop (status='active').
 *   2. For each shop, use the service to detect eligible open
 *      checkouts + enroll them (ON CONFLICT DO NOTHING → idempotent).
 *   3. Scan existing enrolments that are still pending (not recovered,
 *      not unsubscribed), compute nextStepDue given the shop's
 *      settings, and dispatch due steps.
 *   4. Each send calls sendEmail from email/service.ts; SMTP errors
 *      are classified — a missing SMTP_HOST short-circuits further
 *      dispatch for THIS shop (other shops still run). Per-enrolment
 *      bounces are recorded on the enrolment row and don't stop the
 *      driver.
 *
 * Tick budget: cap at MAX_SENDS_PER_TICK across all shops so one busy
 * shop doesn't starve the others.
 *
 * Variables passed to the renderer:
 *   {{customer_name}}   — best-effort from first_name/email
 *   {{store_name}}      — shops.name
 *   {{cart_url}}        — storefront recovery URL (best-effort — we
 *                         format from shops.slug + checkout id)
 *   {{discount_code}}   — blank until merchants can attach discount
 *                         codes to the flow (Phase 10 polish)
 *   {{unsubscribe_url}} — /unsubscribe/<token> on the platform host
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { sendEmail } from '../email/service.js'
import {
  detectEligibleCarts,
  dispatchStep,
  enrollCart,
  resolveSettings,
  selectPendingStep,
  type AbandonedCartEnrollmentRow,
  type EmailSender,
} from './abandoned-cart.js'
import type { EmailRenderVars } from './email-flows.js'

const MAX_SENDS_PER_TICK = 500
const MAX_SHOPS_PER_TICK = 200

export const ABANDONED_CART_CRON_HANDLERS = {
  DISPATCH_ABANDONED_CART_STEPS: 'dispatch_abandoned_cart_steps',
} as const

export interface TickResult {
  shopsScanned: number
  enrolled: number
  sent: number
  bounced: number
  smtpUnconfiguredShops: string[]
}

/**
 * Build the email sender the service expects. We wrap `sendEmail` so
 * the service file can stay side-effect-free.
 */
function makeSender(): EmailSender {
  return async (to, rendered) => {
    const id = await sendEmail({
      to,
      subject: rendered.subject,
      html: rendered.body,
    })
    return typeof id === 'string' ? id : null
  }
}

/**
 * Compose the Mustache-style render variables for a single enrolment.
 * Kept pure so unit tests can verify without touching the DB.
 */
export function buildRenderVars(input: {
  shop: { name: string; slug: string; primaryDomain: string | null }
  customer: { first_name: string | null; email: string } | null
  email: string
  enrollment: Pick<AbandonedCartEnrollmentRow, 'unsubscribe_token' | 'checkout_id'>
  discountCode: string | null
  platformBaseUrl: string | null
}): EmailRenderVars {
  const {
    shop,
    customer,
    email,
    enrollment,
    discountCode,
    platformBaseUrl,
  } = input

  const customerName =
    (customer?.first_name && customer.first_name.trim()) ||
    (email.split('@')[0] ?? 'friend')

  const baseStorefront = shop.primaryDomain
    ? `https://${shop.primaryDomain}`
    : `https://${shop.slug}.gbox.co`
  const cartUrl = `${baseStorefront}/checkout/resume/${enrollment.checkout_id}`

  const unsubUrl = `${platformBaseUrl ?? 'https://accounts.gbox.co'}/unsubscribe/${enrollment.unsubscribe_token}`

  return {
    customer_name: customerName,
    store_name: shop.name,
    cart_url: cartUrl,
    discount_code: discountCode ?? '',
    unsubscribe_url: unsubUrl,
  }
}

async function loadShop(
  db: Kysely<Database>,
  shopId: string,
): Promise<{ name: string; slug: string; primaryDomain: string | null } | null> {
  const row = await (db as any)
    .selectFrom('shops')
    .leftJoin('shop_domains', 'shop_domains.id', 'shops.primary_domain_id')
    .where('shops.id', '=', shopId)
    .select([
      'shops.name as name',
      'shops.slug as slug',
      'shop_domains.domain as primary_domain',
    ])
    .executeTakeFirst()
  if (!row) return null
  return {
    name: row.name,
    slug: row.slug,
    primaryDomain: row.primary_domain ?? null,
  }
}

async function loadCustomer(
  db: Kysely<Database>,
  customerId: string | null,
): Promise<{ first_name: string | null; email: string } | null> {
  if (!customerId) return null
  const row = await (db as any)
    .selectFrom('customers')
    .where('id', '=', customerId)
    .select(['first_name', 'email'])
    .executeTakeFirst()
  return row ? { first_name: row.first_name ?? null, email: row.email ?? '' } : null
}

/**
 * Drive one tick. Returns aggregated counts — useful for the cron
 * dashboard AND for the unit tests.
 */
export async function dispatchAbandonedCartTick(
  db: Kysely<Database>,
  now: Date = new Date(),
  options: { sender?: EmailSender; platformBaseUrl?: string | null } = {},
): Promise<TickResult> {
  const sender = options.sender ?? makeSender()
  const platformBaseUrl = options.platformBaseUrl ?? process.env.PLATFORM_BASE_URL ?? null

  const activeShops = await (db as any)
    .selectFrom('shops')
    .where('status', '=', 'active')
    .select(['id'])
    .limit(MAX_SHOPS_PER_TICK)
    .execute()

  const result: TickResult = {
    shopsScanned: activeShops.length,
    enrolled: 0,
    sent: 0,
    bounced: 0,
    smtpUnconfiguredShops: [],
  }

  for (const shop of activeShops) {
    if (result.sent + result.bounced >= MAX_SENDS_PER_TICK) break

    const shopId: string = shop.id
    const settings = await resolveSettings(db, shopId)
    if (!settings.enabled) continue

    // --- Phase 1: detect + enroll newly eligible carts -------------------
    const eligible = await detectEligibleCarts(db, shopId, {
      minAbandonedMinutes: settings.min_abandoned_minutes,
    })
    for (const cart of eligible) {
      const res = await enrollCart(db, shopId, {
        id: cart.id,
        customer_id: cart.customer_id,
        email: cart.email,
      })
      if (res.ok && res.created) result.enrolled++
    }

    // --- Phase 2: dispatch due steps -------------------------------------
    const pendingEnrollments = await (db as any)
      .selectFrom('abandoned_cart_enrollments')
      .where('shop_id', '=', shopId)
      .where('recovered_at', 'is', null)
      .where('unsubscribed_at', 'is', null)
      .selectAll()
      .limit(1000)
      .execute()

    const shopMeta = await loadShop(db, shopId)
    if (!shopMeta) continue

    let smtpBroken = false
    for (const enrollment of pendingEnrollments) {
      if (result.sent + result.bounced >= MAX_SENDS_PER_TICK) break
      if (smtpBroken) break

      const step = selectPendingStep(
        {
          enrolled_at: enrollment.enrolled_at,
          last_sent_step_id: enrollment.last_sent_step_id ?? null,
          recovered_at: enrollment.recovered_at ?? null,
          unsubscribed_at: enrollment.unsubscribed_at ?? null,
        },
        settings,
        now,
      )
      if (!step) continue

      const customer = await loadCustomer(db, enrollment.customer_id)
      const vars = buildRenderVars({
        shop: shopMeta,
        customer,
        email: enrollment.email,
        enrollment: {
          unsubscribe_token: enrollment.unsubscribe_token,
          checkout_id: enrollment.checkout_id,
        },
        discountCode: null,
        platformBaseUrl,
      })

      const outcome = await dispatchStep(
        db,
        shopId,
        enrollment.id,
        step,
        sender,
        vars,
      )
      if (outcome.ok) {
        result.sent++
      } else if (outcome.error === 'smtp_unconfigured') {
        smtpBroken = true
        if (!result.smtpUnconfiguredShops.includes(shopId)) {
          result.smtpUnconfiguredShops.push(shopId)
        }
      } else if (outcome.error === 'send_failed') {
        result.bounced++
      }
      // 'recovered' / 'unsubscribed' / 'not_found' are silent no-ops.
    }
  }

  return result
}

/**
 * Idempotent seed for the cron_tasks row. Called alongside the other
 * marketing seeds at boot.
 */
export async function seedAbandonedCartCronTasks(
  db: Kysely<Database>,
): Promise<{ inserted: number; existing: number }> {
  const seeds: ReadonlyArray<{ name: string; schedule: string; handler: string }> = [
    {
      name: 'Dispatch abandoned-cart recovery steps',
      schedule: '*/30 * * * *',
      handler: ABANDONED_CART_CRON_HANDLERS.DISPATCH_ABANDONED_CART_STEPS,
    },
  ]

  let inserted = 0
  let existing = 0

  for (const seed of seeds) {
    const row = await db
      .selectFrom('cron_tasks')
      .select(['id'])
      .where('handler', '=', seed.handler)
      .executeTakeFirst()
    if (row) {
      existing++
      continue
    }
    await db
      .insertInto('cron_tasks')
      .values({
        name: seed.name,
        schedule: seed.schedule,
        handler: seed.handler,
        next_run_at: new Date().toISOString(),
        status: 'active',
      } as any)
      .execute()
    inserted++
  }

  return { inserted, existing }
}
