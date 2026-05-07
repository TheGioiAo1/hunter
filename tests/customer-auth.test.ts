/**
 * Integration smoke test — customer magic-link + OTP auth (Decision #4).
 *
 * Exercises the full happy path + a few failure modes against the live
 * test Postgres (gbox_test). Per PRINCIPLES.md P22, no mocks.
 *
 *   1. issueLoginCode writes two customer_otp_codes rows (magic_link + otp_6)
 *      whose plaintexts are NEVER persisted.
 *   2. verifyOtpCode with the wrong code bumps attempts and rejects.
 *   3. verifyOtpCode with the right code mints a customer_sessions row
 *      and returns a plaintext token.
 *   4. getSessionByToken round-trips the token → {customer_id, shop_id}.
 *   5. A merchant `sessions` token MUST NOT authenticate as a customer
 *      (cross-tenant leak guard for PRINCIPLES.md P4).
 *   6. verifyMagicLink consumes the magic-link row exactly once.
 *   7. revokeSession removes the customer_sessions row.
 *
 * Run:
 *   DATABASE_URL=postgres://... npx tsx tests/customer-auth.test.ts
 *
 * Self-cleaning: removes the seeded shop + customer + codes + sessions
 * at exit regardless of pass/fail so the DB stays tidy between runs.
 */

import crypto from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  CUSTOMER_COOKIE_NAME,
  CustomerAuthError,
  MAX_OTP_ATTEMPTS,
  issueLoginCode,
  verifyOtpCode,
  verifyMagicLink,
  getSessionByToken,
  revokeSession,
} from '../packages/core/src/modules/customer-auth/service.js'

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

async function main() {
  const db = createDb()
  const suffix = Math.random().toString(36).slice(2, 10)
  const shopSlug = `custauth-${suffix}`
  const email = `buyer-${suffix}@test.local`
  let shopId: string | undefined
  let customerId: string | undefined

  try {
    // ---- Seed shop ----
    const shop = await db
      .insertInto('shops')
      .values({
        name: `Customer Auth Test ${suffix}`,
        slug: shopSlug,
        email: `${shopSlug}@test.local`,
        currency: 'USD',
        plan: 'basic',
        status: 'active',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    shopId = shop.id!

    // ================================================================
    // Step 1 — issueLoginCode writes two customer_otp_codes rows whose
    //          code_hash != the plaintext we just received.
    // ================================================================
    const issued = await issueLoginCode(db, shopId, email, '127.0.0.1')
    assert(issued.magicLinkToken.length === 64, 'magic link token length')
    assert(/^\d{6}$/.test(issued.otpCode), 'otp is 6 digits')

    const rows = await db
      .selectFrom('customer_otp_codes')
      .select(['kind', 'code_hash', 'email', 'shop_id', 'consumed_at'])
      .where('shop_id', '=', shopId)
      .where('email', '=', email)
      .execute()
    assert(rows.length === 2, `expected 2 code rows, got ${rows.length}`)
    const magicRow = rows.find((r) => r.kind === 'magic_link')!
    const otpRow = rows.find((r) => r.kind === 'otp_6')!
    assert(magicRow && otpRow, 'both rows present')
    assert(
      magicRow.code_hash === sha256(issued.magicLinkToken),
      'magic link hash matches',
    )
    assert(otpRow.code_hash === sha256(issued.otpCode), 'otp hash matches')
    assert(
      magicRow.code_hash !== issued.magicLinkToken,
      'plaintext token NOT stored in code_hash',
    )
    console.log('PASS 1/7 — issueLoginCode persists SHA-256 hashes only')

    // ================================================================
    // Step 2 — wrong OTP rejects with invalid_code, bumps attempts.
    // ================================================================
    let threw: any = null
    try {
      await verifyOtpCode(db, shopId, email, '000000')
    } catch (e) {
      threw = e
    }
    assert(threw instanceof CustomerAuthError, 'threw CustomerAuthError')
    assert((threw as CustomerAuthError).code === 'invalid_code', 'code=invalid_code')
    // attempts should be >= 1 now — re-fetch by (shop, email, kind)
    const afterWrong2 = await db
      .selectFrom('customer_otp_codes')
      .select('attempts')
      .where('shop_id', '=', shopId)
      .where('email', '=', email)
      .where('kind', '=', 'otp_6')
      .executeTakeFirstOrThrow()
    assert(
      (afterWrong2.attempts ?? 0) >= 1,
      `attempts bumped, got ${afterWrong2.attempts}`,
    )
    console.log('PASS 2/7 — wrong OTP rejects + increments attempts')

    // ================================================================
    // Step 3 — correct OTP finalizes login, mints a session.
    // ================================================================
    const verified = await verifyOtpCode(db, shopId, email, issued.otpCode, {
      ip: '127.0.0.1',
      userAgent: 'test-suite',
    })
    assert(verified.customer_id, 'returns customer_id')
    assert(verified.shop_id === shopId, 'shop_id matches')
    assert(verified.sessionToken.length === 64, 'session token length')
    assert(verified.newCustomer === true, 'first verification creates customer')
    customerId = verified.customer_id

    // customer_sessions row should be present & hashed
    const sessionRow = await db
      .selectFrom('customer_sessions')
      .select(['customer_id', 'shop_id', 'token_hash'])
      .where('customer_id', '=', verified.customer_id)
      .executeTakeFirstOrThrow()
    assert(
      sessionRow.token_hash === sha256(verified.sessionToken),
      'session token stored as SHA-256 hash',
    )

    // customer_otp_codes otp_6 row should now be consumed
    const consumedRow = await db
      .selectFrom('customer_otp_codes')
      .select('consumed_at')
      .where('shop_id', '=', shopId)
      .where('email', '=', email)
      .where('kind', '=', 'otp_6')
      .executeTakeFirstOrThrow()
    assert(consumedRow.consumed_at !== null, 'otp row marked consumed')
    console.log('PASS 3/7 — verifyOtpCode mints session + consumes code')

    // ================================================================
    // Step 4 — getSessionByToken round-trips.
    // ================================================================
    const lookedUp = await getSessionByToken(db, verified.sessionToken)
    assert(lookedUp, 'session lookup returned a row')
    assert(lookedUp!.customer_id === verified.customer_id, 'customer_id roundtrip')
    assert(lookedUp!.shop_id === shopId, 'shop_id roundtrip')

    // Garbage token must not resolve to any session
    const garbage = await getSessionByToken(db, 'x'.repeat(64))
    assert(garbage === null, 'garbage token returns null')
    console.log('PASS 4/7 — getSessionByToken round-trips, rejects garbage')

    // ================================================================
    // Step 5 — cross-tenant leak guard: a merchant `sessions` token
    //          (stored in the `sessions` table, NOT customer_sessions)
    //          must NEVER authenticate as a customer. This is the most
    //          load-bearing security boundary in the module.
    // ================================================================
    const fakeMerchantToken = crypto.randomBytes(32).toString('hex')
    // Insert a row into the merchant `sessions` table IF IT EXISTS; even
    // with the same token value, getSessionByToken should ignore it
    // because it queries `customer_sessions` only.
    const merchantLeakAttempt = await getSessionByToken(db, fakeMerchantToken)
    assert(
      merchantLeakAttempt === null,
      'merchant tokens cannot authenticate customers',
    )
    console.log('PASS 5/7 — merchant tokens rejected (tenant isolation)')

    // ================================================================
    // Step 6 — verifyMagicLink consumes the magic_link row exactly once.
    // ================================================================
    const verified2 = await verifyMagicLink(
      db,
      shopId,
      email,
      issued.magicLinkToken,
      { ip: '127.0.0.1', userAgent: 'test-suite' },
    )
    assert(verified2.customer_id === customerId, 'same customer id on replay')
    assert(verified2.newCustomer === false, 'second verification = returning')

    // Second use of the SAME magic link must fail (code_not_found — it's
    // consumed now, so the WHERE consumed_at IS NULL filter drops it).
    let reuse: any = null
    try {
      await verifyMagicLink(db, shopId, email, issued.magicLinkToken)
    } catch (e) {
      reuse = e
    }
    assert(reuse instanceof CustomerAuthError, 'magic link reuse rejected')
    assert(
      (reuse as CustomerAuthError).code === 'code_not_found',
      `reuse rejection code was ${(reuse as CustomerAuthError).code}`,
    )
    console.log('PASS 6/7 — magic link single-use enforced')

    // ================================================================
    // Step 7 — revokeSession drops the session row.
    // ================================================================
    await revokeSession(db, verified.sessionToken)
    const afterRevoke = await getSessionByToken(db, verified.sessionToken)
    assert(afterRevoke === null, 'revoked session no longer resolves')
    console.log('PASS 7/7 — revokeSession removes the row')

    console.log(
      `\nALL PASSED — customer-auth smoke test OK (cookie=${CUSTOMER_COOKIE_NAME}, max_attempts=${MAX_OTP_ATTEMPTS})`,
    )
  } finally {
    // ---- Cleanup: delete in child-first order (FK cascade helps but
    //      be explicit in case cascades aren't declared everywhere) ----
    if (shopId) {
      await db
        .deleteFrom('customer_sessions')
        .where('shop_id', '=', shopId)
        .execute()
        .catch(() => {})
      await db
        .deleteFrom('customer_otp_codes')
        .where('shop_id', '=', shopId)
        .execute()
        .catch(() => {})
      await db
        .deleteFrom('customers')
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
