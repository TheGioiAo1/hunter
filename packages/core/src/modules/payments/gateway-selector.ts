/**
 * Payment gateway selector (Decision #3)
 *
 * Gbox is an official PayPal partner (gbox-paypal app migrated to
 * packages/core/src/modules/payments/paypal-partner/). PayPal is now
 * the strategic payment platform — Stripe is a *fallback only* for
 * shops whose owners have not yet completed PayPal onboarding or for
 * regions where PayPal is unavailable.
 *
 * This helper is the single source of truth for "which gateway does
 * this shop accept?". It is called by:
 *   - GET /api/store/:slug/checkout/gateways (public, storefront uses
 *     the result to decide which payment buttons to render)
 *   - completeCheckout validation (reject transactions on a gateway
 *     the shop did not opt into)
 *   - the merchant dashboard ("connect PayPal" CTA)
 *
 * The selector is DETERMINISTIC — it never calls PayPal or Stripe at
 * decision time. It only reads local state:
 *   1. shop_settings key `paypal_partner.paypal_connected` (true/false,
 *      written by processOnboardingCallback after a successful referral)
 *   2. environment: PAYPAL_PARTNER_CLIENT_ID set → PayPal available at all
 *   3. environment: STRIPE_SECRET_KEY set → Stripe available as fallback
 *
 * It does NOT hit the PayPal merchant-info API; that call is reserved
 * for `isMerchantReady` which is used before actually creating an
 * order and MAY be slow / rate-limited. The selector is cheap enough
 * to call on every storefront page load.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export type Gateway = 'paypal' | 'stripe' | 'manual'

export interface GatewayAvailability {
  /**
   * Gateway the storefront should default to. `null` when no gateway
   * is configured for this shop — the storefront should show a
   * "Payment unavailable, contact support" message.
   */
  preferred: Gateway | null
  /**
   * All gateways the shop has opted into. Order is significant: index
   * 0 is the one we'd render highlighted, 1 is the fallback, etc.
   */
  available: Gateway[]
  /**
   * Human-readable explanation for why `preferred` is what it is.
   * Useful for the merchant dashboard ("Your store uses PayPal" /
   * "Connect PayPal to take customer payments directly").
   */
  reason: string
  /**
   * True when the shop is running on the fallback Stripe path only,
   * meaning they haven't finished PayPal onboarding yet. The dashboard
   * uses this to nudge the owner toward connecting PayPal.
   */
  usingFallback: boolean
}

const MERCHANT_ID_KEY = 'paypal_partner.paypal_merchant_id'
const CONNECTED_KEY = 'paypal_partner.paypal_connected'

/**
 * Read a shop_settings value by key. shop_settings.value is a jsonb
 * column, so node-pg auto-decodes to a JS value. The paypal-partner
 * onboarding module historically calls JSON.stringify on its values
 * before insert, which the DB then parses into a proper jsonb value —
 * so on read we get back booleans/strings/objects, not raw text.
 *
 * This helper normalizes both cases so callers always see the final
 * JS value (or null if the row is missing).
 */
async function readSetting(
  db: Kysely<Database>,
  shopId: string,
  key: string,
): Promise<unknown | null> {
  const row = await db
    .selectFrom('shop_settings')
    .select('value')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()
  if (!row || row.value === null || row.value === undefined) return null
  // If jsonb decoded to a string that looks like JSON, parse it once
  // more (this happens when code JSON.stringify's a string before
  // inserting — it gets stored as a JSON string literal).
  if (typeof row.value === 'string') {
    try {
      return JSON.parse(row.value)
    } catch {
      return row.value
    }
  }
  return row.value
}

/**
 * Determine which payment gateway(s) a shop accepts, preferring PayPal.
 *
 * This is intentionally synchronous-ish (one DB round trip, no network
 * calls) so it's safe to invoke on every page render.
 */
export async function selectPaymentGateway(
  db: Kysely<Database>,
  shopId: string,
): Promise<GatewayAvailability> {
  const paypalEnvReady = Boolean(
    process.env.PAYPAL_PARTNER_CLIENT_ID &&
      process.env.PAYPAL_PARTNER_SECRET &&
      process.env.PAYPAL_PARTNER_ID,
  )
  const stripeEnvReady = Boolean(process.env.STRIPE_SECRET_KEY)

  // PayPal takes two checks: env must be configured AND the shop's owner
  // must have completed onboarding so we have a merchant_id to route
  // payments to.
  let paypalShopReady = false
  if (paypalEnvReady) {
    const merchantId = await readSetting(db, shopId, MERCHANT_ID_KEY)
    const connected = await readSetting(db, shopId, CONNECTED_KEY)
    // `connected` is written by processOnboardingCallback as a boolean.
    paypalShopReady = Boolean(merchantId) && connected === true
  }

  const available: Gateway[] = []
  if (paypalShopReady) available.push('paypal')
  if (stripeEnvReady) available.push('stripe')

  if (available.length === 0) {
    return {
      preferred: null,
      available: [],
      reason: paypalEnvReady
        ? 'Merchant has not connected PayPal and no fallback gateway is configured'
        : 'No payment gateway is configured on the Gbox Platform',
      usingFallback: false,
    }
  }

  const preferred = available[0] ?? null
  const usingFallback = preferred === 'stripe'

  let reason: string
  if (preferred === 'paypal') {
    reason = 'PayPal Partner account is connected and ready'
  } else if (preferred === 'stripe') {
    reason = paypalEnvReady
      ? 'PayPal not yet connected — falling back to Stripe. Connect PayPal to receive payments directly.'
      : 'Stripe (fallback gateway)'
  } else {
    reason = 'Unknown gateway state'
  }

  return { preferred, available, reason, usingFallback }
}
