/**
 * Integration smoke test — payment gateway selector (Decision #3).
 *
 * Verifies that selectPaymentGateway() picks PayPal whenever a shop's
 * owner has completed partner onboarding, and falls back to Stripe
 * otherwise. Uses real Postgres (PRINCIPLES.md P22) — seeds a shop +
 * writes rows into shop_settings, then asserts on the selector output
 * under different env-var permutations.
 *
 * Why not mock env + db? Because the real bug we want to catch is
 * "jsonb value wasn't parsed correctly" or "env flag is checked at
 * import time", which only reproduces against real node-pg + real
 * process.env at call time.
 *
 * Run:
 *   DATABASE_URL=postgres://... npx tsx tests/gateway-selector.test.ts
 */

import { createDb } from '../packages/db/src/index.js'
import { selectPaymentGateway } from '../packages/core/src/modules/payments/gateway-selector.js'

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}

/** Stash + restore a single env var so the test is hermetic. */
function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k]
    if (overrides[k] === undefined) delete process.env[k]
    else process.env[k] = overrides[k]!
  }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

async function main() {
  const db = createDb()
  const suffix = Math.random().toString(36).slice(2, 10)
  const slug = `gwselect-${suffix}`
  let shopId: string | undefined

  try {
    // ---- Seed a shop ----
    const shop = await db
      .insertInto('shops')
      .values({
        name: `Gateway Selector Test ${suffix}`,
        slug,
        email: `${slug}@test.local`,
        currency: 'USD',
        plan: 'basic',
        status: 'active',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    shopId = shop.id!

    // ================================================================
    // Case 1 — no env, no onboarding: selector returns no gateway.
    // ================================================================
    await withEnv(
      {
        PAYPAL_PARTNER_CLIENT_ID: undefined,
        PAYPAL_PARTNER_SECRET: undefined,
        PAYPAL_PARTNER_ID: undefined,
        STRIPE_SECRET_KEY: undefined,
      },
      async () => {
        const result = await selectPaymentGateway(db, shopId!)
        assert(result.preferred === null, 'no gateway preferred')
        assert(result.available.length === 0, 'no gateways available')
        assert(result.usingFallback === false, 'not a fallback (empty)')
      },
    )
    console.log('PASS 1/5 — no env / no onboarding → no gateway')

    // ================================================================
    // Case 2 — only Stripe env, no PayPal env: Stripe wins as fallback.
    // ================================================================
    await withEnv(
      {
        PAYPAL_PARTNER_CLIENT_ID: undefined,
        PAYPAL_PARTNER_SECRET: undefined,
        PAYPAL_PARTNER_ID: undefined,
        STRIPE_SECRET_KEY: 'sk_test_fake_for_selector',
      },
      async () => {
        const result = await selectPaymentGateway(db, shopId!)
        assert(result.preferred === 'stripe', 'stripe preferred as fallback')
        assert(
          result.available.length === 1 && result.available[0] === 'stripe',
          'only stripe available',
        )
        assert(result.usingFallback === true, 'usingFallback=true')
      },
    )
    console.log('PASS 2/5 — stripe-only env → stripe (fallback)')

    // ================================================================
    // Case 3 — PayPal env set BUT no onboarding row yet: still Stripe.
    //          (This is the most common post-signup state.)
    // ================================================================
    await withEnv(
      {
        PAYPAL_PARTNER_CLIENT_ID: 'client_test',
        PAYPAL_PARTNER_SECRET: 'secret_test',
        PAYPAL_PARTNER_ID: 'partner_test',
        STRIPE_SECRET_KEY: 'sk_test_fake',
      },
      async () => {
        const result = await selectPaymentGateway(db, shopId!)
        assert(
          result.preferred === 'stripe',
          `expected stripe fallback pre-onboarding, got ${result.preferred}`,
        )
        assert(result.usingFallback === true, 'usingFallback=true')
        assert(
          result.available.includes('stripe'),
          'stripe in available list',
        )
        assert(
          !result.available.includes('paypal'),
          'paypal NOT in available list (not onboarded)',
        )
      },
    )
    console.log('PASS 3/5 — paypal env but no onboarding → stripe fallback')

    // ================================================================
    // Case 4 — simulate a completed onboarding by writing the same
    //          shop_settings rows processOnboardingCallback would write.
    //          Selector must now prefer PayPal.
    // ================================================================
    const onboardingRows: Array<{ key: string; value: string }> = [
      {
        key: 'paypal_partner.paypal_merchant_id',
        value: JSON.stringify('MERCH123'),
      },
      {
        key: 'paypal_partner.paypal_connected',
        value: JSON.stringify(true),
      },
    ]
    for (const r of onboardingRows) {
      await db
        .insertInto('shop_settings')
        .values({ shop_id: shopId!, key: r.key, value: r.value } as any)
        .onConflict((oc) =>
          oc.columns(['shop_id', 'key']).doUpdateSet({
            value: r.value,
            updated_at: new Date().toISOString(),
          } as any),
        )
        .execute()
    }

    await withEnv(
      {
        PAYPAL_PARTNER_CLIENT_ID: 'client_test',
        PAYPAL_PARTNER_SECRET: 'secret_test',
        PAYPAL_PARTNER_ID: 'partner_test',
        STRIPE_SECRET_KEY: 'sk_test_fake',
      },
      async () => {
        const result = await selectPaymentGateway(db, shopId!)
        assert(
          result.preferred === 'paypal',
          `expected paypal after onboarding, got ${result.preferred}`,
        )
        assert(result.usingFallback === false, 'not fallback once connected')
        // PayPal first, Stripe second (fallback order preserved)
        assert(
          result.available[0] === 'paypal' && result.available[1] === 'stripe',
          `available order wrong: ${JSON.stringify(result.available)}`,
        )
        assert(
          /PayPal Partner account/i.test(result.reason),
          `reason should mention PayPal Partner, got: ${result.reason}`,
        )
      },
    )
    console.log('PASS 4/5 — onboarded → paypal preferred, stripe fallback')

    // ================================================================
    // Case 5 — onboarded shop but Stripe env REMOVED: PayPal is the
    //          only gateway, not a fallback.
    // ================================================================
    await withEnv(
      {
        PAYPAL_PARTNER_CLIENT_ID: 'client_test',
        PAYPAL_PARTNER_SECRET: 'secret_test',
        PAYPAL_PARTNER_ID: 'partner_test',
        STRIPE_SECRET_KEY: undefined,
      },
      async () => {
        const result = await selectPaymentGateway(db, shopId!)
        assert(result.preferred === 'paypal', 'paypal preferred')
        assert(
          result.available.length === 1 && result.available[0] === 'paypal',
          'only paypal available',
        )
      },
    )
    console.log('PASS 5/5 — onboarded + no Stripe env → paypal only')

    console.log('\nALL PASSED — gateway selector prefers PayPal per Decision #3')
  } finally {
    if (shopId) {
      await db
        .deleteFrom('shop_settings')
        .where('shop_id', '=', shopId)
        .execute()
        .catch(() => {})
      await db
        .deleteFrom('shops')
        .where('id', '=', shopId)
        .execute()
        .catch(() => {})
    }
    await db.destroy()
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
