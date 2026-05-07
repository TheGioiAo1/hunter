/**
 * Smoke test — buildPayPalSdkScriptTag()
 *
 * Verifies the BROWSER-side BN code injection (Step B of the
 * PayPal Partner audit). The server-side BN code was tested in commit
 * 0f9e62a; this test ensures the SDK <script> tag we hand the storefront
 * carries `data-partner-attribution-id="Gbox_Ecom"` and the correct
 * per-shop merchant_id query param.
 *
 * Cases:
 *   1. Shop with no PayPal onboarding → throws (caller falls back to Stripe)
 *   2. Shop with onboarding rows in shop_settings → returns a tag with:
 *        - data-partner-attribution-id="Gbox_Ecom"
 *        - merchant-id=<seller>
 *        - intent=capture
 *        - components=buttons,funding-eligibility
 *        - enable-funding=venmo
 *
 * Run:
 *   DATABASE_URL=postgres://... npx tsx tests/paypal-sdk-tag.test.ts
 */

import { createDb } from '../packages/db/src/index.js'
import { buildPayPalSdkScriptTag } from '../packages/core/src/modules/payments/paypal-partner/storefront-loader.js'

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}

async function main() {
  const db = createDb()
  const suffix = Math.random().toString(36).slice(2, 10)
  const slug = `sdktag-${suffix}`
  let shopId: string | undefined

  // Force PayPal env so config.ts doesn't throw at import time.
  const savedEnv = {
    PAYPAL_PARTNER_CLIENT_ID: process.env.PAYPAL_PARTNER_CLIENT_ID,
    PAYPAL_PARTNER_SECRET: process.env.PAYPAL_PARTNER_SECRET,
    PAYPAL_PARTNER_ID: process.env.PAYPAL_PARTNER_ID,
    PAYPAL_PARTNER_BN_CODE: process.env.PAYPAL_PARTNER_BN_CODE,
  }
  process.env.PAYPAL_PARTNER_CLIENT_ID = 'AQ_test_client_id_for_sdk_tag'
  process.env.PAYPAL_PARTNER_SECRET = 'EFsTestSecret'
  process.env.PAYPAL_PARTNER_ID = 'PARTNERTEST'
  process.env.PAYPAL_PARTNER_BN_CODE = 'Gbox_Ecom'

  try {
    const shop = await db
      .insertInto('shops')
      .values({
        name: `SDK Tag Test ${suffix}`,
        slug,
        email: `${slug}@test.local`,
        currency: 'USD',
        plan: 'basic',
        status: 'active',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    shopId = shop.id!

    // ============ Case 1 — no onboarding → throw ============
    let threw = false
    try {
      await buildPayPalSdkScriptTag(db, shopId, {})
    } catch (err: any) {
      threw = true
      assert(
        /not connected|merchant not connected|PayPal SDK unavailable/i.test(
          err.message,
        ),
        `wrong throw: ${err.message}`,
      )
    }
    assert(threw, 'should throw when shop has no onboarding')
    console.log('PASS 1/2 — no onboarding → throws (caller falls back)')

    // ============ Case 2 — onboarded ============
    // We can't really verify with PayPal without hitting the network,
    // so isMerchantReady() will call getMerchantIntegrationInfo. Mock fetch
    // around the call to return a merchant who is fully receivable.
    const onboardingRows = [
      {
        key: 'paypal_partner.paypal_merchant_id',
        value: JSON.stringify('SELLERMERCHANT123'),
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

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/oauth2/token')) {
        return new Response(
          JSON.stringify({ access_token: 'fake', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/v1/customer/partners/')) {
        return new Response(
          JSON.stringify({
            merchant_id: 'SELLERMERCHANT123',
            tracking_id: `gbox_shop_${shopId}`,
            payments_receivable: true,
            primary_email_confirmed: true,
            products: [{ name: 'PPCP_CUSTOM' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch

    let result
    try {
      result = await buildPayPalSdkScriptTag(db, shopId, {
        currency: 'USD',
        buyerCountry: 'US',
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    assert(
      result.bnCode === 'Gbox_Ecom',
      `bnCode wrong: ${result.bnCode}`,
    )
    assert(
      result.merchantId === 'SELLERMERCHANT123',
      `merchantId wrong: ${result.merchantId}`,
    )
    assert(
      result.scriptTag.includes('data-partner-attribution-id="Gbox_Ecom"'),
      'script tag missing data-partner-attribution-id',
    )
    assert(
      result.scriptTag.includes('merchant-id=SELLERMERCHANT123'),
      `script tag missing merchant-id; got: ${result.scriptTag}`,
    )
    assert(
      result.scriptTag.includes('intent=capture'),
      'script tag missing intent=capture',
    )
    assert(
      result.scriptTag.includes('enable-funding=venmo'),
      'script tag missing enable-funding=venmo',
    )
    assert(
      result.scriptTag.includes('components=buttons') &&
        result.scriptTag.includes('funding-eligibility'),
      'script tag missing components=buttons,funding-eligibility',
    )
    assert(
      result.scriptTag.includes('async') && result.scriptTag.includes('defer'),
      'script tag should be async + defer',
    )
    assert(
      result.scriptTag.includes(
        'client-id=AQ_test_client_id_for_sdk_tag',
      ),
      'script tag missing client-id from env',
    )
    console.log(
      'PASS 2/2 — onboarded shop → SDK tag with Gbox_Ecom + merchant_id + venmo',
    )

    console.log('\nALL PASSED — buildPayPalSdkScriptTag emits Gbox_Ecom on browser side')
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
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
    await db.destroy()
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
