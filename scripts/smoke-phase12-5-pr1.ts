/**
 * Gbox Platform — Phase 12.5 PR1 smoke
 *
 * Exercises the pure surface of the support module end-to-end:
 *
 *   [1..3]   AES-256-GCM encrypt/decrypt roundtrip + rotation
 *   [4..5]   safe-message Iron rule 5 enforcement (leak-terms regex)
 *   [6..8]   canned-reply render + warnings for unknown tokens
 *   [9..11]  SLA deadline math: payment 2h 24/7 + non-payment 4h BH
 *   [12..13] SLA breached check pins current arithmetic
 *   [14..15] Rate-limit window math (floor to bucket, resetsAt = +windowMs)
 *   [16..18] Validators reject missing / over-length inputs
 *   [19..21] State machine edges match spec
 *   [22..23] Module barrel exports the full public surface
 *
 * Runs offline — no DB, no HTTP, no cron. Safe to run on any box with
 * a recent Node.
 *
 *   npx tsx scripts/smoke-phase12-5-pr1.ts
 */

import {
  ALLOWED_TRANSITIONS,
  DEFAULT_SLA_CONFIG,
  LEAK_TERMS_REGEX,
  SAFE_MESSAGE_EN,
  SAFE_MESSAGE_VI,
  SUPPORT_RATE_LIMITS,
  SupportError,
  assertSellerSafe,
  computeSlaDeadlines,
  computeWindow,
  decryptMessage,
  encryptMessage,
  generateMessageKey,
  isSlaBreached,
  parseMessageKey,
  renderCannedReply,
  rotateMessage,
  safeMessage,
  validateAddMessage,
  validateCreateTicket,
} from '@gbox/core/modules/support/index.js'

type AssertFn = (label: string, ok: boolean, detail?: string) => void

function makeAsserter(): {
  assert: AssertFn
  summary: () => { total: number; passed: number }
} {
  let total = 0
  let passed = 0
  const assert: AssertFn = (label, ok, detail) => {
    total++
    if (ok) {
      passed++
      console.log(`  OK   [${total}] ${label}`)
    } else {
      console.error(`  FAIL [${total}] ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }
  return {
    assert,
    summary: () => ({ total, passed }),
  }
}

function ict(y: number, m: number, d: number, h: number, min: number): Date {
  return new Date(Date.UTC(y, m - 1, d, h - 7, min))
}

async function main() {
  console.log('=== Phase 12.5 PR1 smoke — support module core ===\n')
  const { assert, summary } = makeAsserter()

  // ---------------------------------------------------------------------------
  // [1..3] Encrypt/decrypt roundtrip + rotation
  // ---------------------------------------------------------------------------
  console.log('[1..3] AES-256-GCM crypto surface')
  {
    const hex = generateMessageKey()
    const key = parseMessageKey(hex)
    const plaintext =
      'Hi Gbox, đơn hàng #1234 bị treo ở bước thanh toán 🎯. Xin vui lòng kiểm tra.'
    const enc = encryptMessage(plaintext, key)
    assert(
      '[1] encrypt produces 12-byte IV + 16-byte tag + version=1',
      enc.iv.length === 12 && enc.tag.length === 16 && enc.keyVersion === 1,
      `iv=${enc.iv.length} tag=${enc.tag.length} v=${enc.keyVersion}`,
    )
    const roundtrip = decryptMessage(enc, key)
    assert(
      '[2] decrypt roundtrip matches plaintext (UTF-8 + emoji preserved)',
      roundtrip === plaintext,
    )

    const newKey = parseMessageKey(generateMessageKey())
    const rotated = rotateMessage(enc, key, newKey, 2)
    const recovered = decryptMessage(rotated, newKey)
    assert(
      '[3] rotateMessage decrypts under v1 key + re-encrypts under v2 key',
      recovered === plaintext && rotated.keyVersion === 2,
    )
  }

  // ---------------------------------------------------------------------------
  // [4..5] Iron rule 5 — seller-facing messages never leak god-admin
  // ---------------------------------------------------------------------------
  console.log('\n[4..5] safe-message Iron rule 5 enforcement')
  {
    const res = safeMessage(new Error('god admin denied this'))
    assert(
      '[4] safeMessage EN default matches canonical + hides raw diagnostic',
      res.safe === SAFE_MESSAGE_EN &&
        res.safe === 'Please contact Gbox support.' &&
        res.diagnostic === 'god admin denied this',
    )

    const leakSamples = [
      'god admin only',
      '/god-admin/feature',
      'supporter.gbox.co',
      'FEATURE_FLAG_SUPPORT_V2',
      '$env.SUPPORT_MESSAGE_ENCRYPTION_KEY',
    ]
    const allFlagged = leakSamples.every((s) => LEAK_TERMS_REGEX.test(s))
    const cleanPasses = assertSellerSafe(SAFE_MESSAGE_VI)
    assert(
      '[5] LEAK_TERMS_REGEX catches 5 common leaks; canonical VI passes assertSellerSafe',
      allFlagged && cleanPasses,
    )
  }

  // ---------------------------------------------------------------------------
  // [6..8] Canned reply render
  // ---------------------------------------------------------------------------
  console.log('\n[6..8] renderCannedReply')
  {
    const ctx = {
      seller: { display_name: 'Thai' },
      shop: { name: 'My Shop' },
      ticket: { subject: 'Refund' },
    }
    const ok = renderCannedReply(
      'Hi {{seller.display_name}} about "{{ticket.subject}}" at {{shop.name}}.',
      ctx,
    )
    assert(
      '[6] all 3 tokens resolved + no warnings',
      ok.body === 'Hi Thai about "Refund" at My Shop.' && ok.warnings.length === 0,
    )

    const ci = renderCannedReply('Hi {{Seller.Display_Name}}', ctx)
    assert(
      '[7] tokens are case-insensitive',
      ci.body === 'Hi Thai' && ci.warnings.length === 0,
    )

    const unknown = renderCannedReply('Hi {{unknown.thing}} {{seller.missing}}', ctx)
    assert(
      '[8] unknown object + missing value → token left intact, warnings emitted',
      unknown.body === 'Hi {{unknown.thing}} {{seller.missing}}' &&
        unknown.warnings.length === 2,
    )
  }

  // ---------------------------------------------------------------------------
  // [9..11] SLA deadline math
  // ---------------------------------------------------------------------------
  console.log('\n[9..11] computeSlaDeadlines (hybrid: payment 24/7 vs BH)')
  {
    // Payment ticket opened Wed 23:00 ICT → first-response 2h later, no BH.
    const paymentOpen = ict(2026, 4, 22, 23, 0)
    const payment = computeSlaDeadlines({
      category: 'payment',
      openedAt: paymentOpen,
    })
    const firstExpected = new Date(
      paymentOpen.getTime() + DEFAULT_SLA_CONFIG.paymentFirstResponseMinutes * 60_000,
    ).toISOString()
    assert(
      '[9] payment 2h first-response runs on wall clock (no BH deferral)',
      payment.firstResponseAt === firstExpected,
    )

    // Non-payment opened Wed 10:00 ICT (inside BH) → +4h = Wed 14:00 ICT.
    const shippingOpen = ict(2026, 4, 22, 10, 0)
    const shipping = computeSlaDeadlines({
      category: 'technical',
      openedAt: shippingOpen,
    })
    assert(
      '[10] non-payment inside BH: 4h budget burns cleanly → Wed 14:00 ICT',
      shipping.firstResponseAt === ict(2026, 4, 22, 14, 0).toISOString(),
    )

    // Non-payment opened Sat 10:00 ICT → deadline rolls to Monday + budget.
    const weekendOpen = ict(2026, 4, 18, 10, 0)
    const weekend = computeSlaDeadlines({
      category: 'technical',
      openedAt: weekendOpen,
    })
    assert(
      '[11] non-payment on Saturday: 4h budget rolls to Mon 12:00 ICT',
      weekend.firstResponseAt === ict(2026, 4, 20, 12, 0).toISOString(),
    )
  }

  // ---------------------------------------------------------------------------
  // [12..13] SLA breached arithmetic
  // ---------------------------------------------------------------------------
  console.log('\n[12..13] isSlaBreached')
  {
    assert(
      '[12] not breached 1min before deadline',
      isSlaBreached({
        deadlineAt: '2026-04-22T10:00:00.000Z',
        pausedTotalMs: 0,
        pausedAt: null,
        now: new Date('2026-04-22T09:59:00.000Z'),
      }) === false,
    )
    assert(
      '[13] breached 1min after deadline',
      isSlaBreached({
        deadlineAt: '2026-04-22T10:00:00.000Z',
        pausedTotalMs: 0,
        pausedAt: null,
        now: new Date('2026-04-22T10:01:00.000Z'),
      }) === true,
    )
  }

  // ---------------------------------------------------------------------------
  // [14..15] Rate-limit window math
  // ---------------------------------------------------------------------------
  console.log('\n[14..15] rate-limit math + catalog')
  {
    const hour = 60 * 60 * 1000
    const w = computeWindow(
      { windowMs: hour },
      new Date('2026-04-22T10:37:42.123Z'),
    )
    assert(
      '[14] 10:37 → bucket 10:00 + resetsAt 11:00 (1h window)',
      w.windowStart.toISOString() === '2026-04-22T10:00:00.000Z' &&
        w.resetsAt.toISOString() === '2026-04-22T11:00:00.000Z',
    )
    assert(
      '[15] spec caps locked: create=10/hr per shop, post=60/hr per user',
      SUPPORT_RATE_LIMITS.CREATE_TICKET.maxHits === 10 &&
        SUPPORT_RATE_LIMITS.CREATE_TICKET.scopeType === 'shop' &&
        SUPPORT_RATE_LIMITS.POST_MESSAGE.maxHits === 60 &&
        SUPPORT_RATE_LIMITS.POST_MESSAGE.scopeType === 'user',
    )
  }

  // ---------------------------------------------------------------------------
  // [16..18] Validation helpers
  // ---------------------------------------------------------------------------
  console.log('\n[16..18] validators')
  {
    try {
      validateCreateTicket({
        shopId: '',
        openerUserId: '',
        category: 'payment',
        subject: '',
        body: '',
      })
      assert('[16] validateCreateTicket threw on empty payload', false)
    } catch (err) {
      const msg = err instanceof SupportError ? err.message : ''
      assert(
        '[16] validateCreateTicket throws SupportError collecting every failure',
        err instanceof SupportError &&
          err.code === 'INVALID_INPUT' &&
          msg.includes('shopId') &&
          msg.includes('subject') &&
          msg.includes('body'),
        err instanceof SupportError ? err.message : String(err),
      )
    }

    try {
      validateCreateTicket({
        shopId: 's',
        openerUserId: 'u',
        category: 'payment',
        subject: 'x'.repeat(121),
        body: 'ok',
      })
      assert('[17] validateCreateTicket threw on long subject', false)
    } catch (err) {
      assert(
        '[17] validateCreateTicket rejects subject > 120 chars',
        err instanceof SupportError && /subject too long/.test(err.message),
      )
    }

    try {
      validateAddMessage({
        ticketId: 't',
        senderType: 'agent',
        senderUserId: 'u',
        body: 'hi',
        mentionedUserIds: ['u2'],
      })
      assert('[18] validateAddMessage threw on non-note mentions', false)
    } catch (err) {
      assert(
        '[18] validateAddMessage rejects mentions on non-internal-note',
        err instanceof SupportError && /mentions only allowed/.test(err.message),
      )
    }
  }

  // ---------------------------------------------------------------------------
  // [19..21] State machine edges
  // ---------------------------------------------------------------------------
  console.log('\n[19..21] ALLOWED_TRANSITIONS state machine')
  {
    assert(
      '[19] open → can go to pending_agent / pending_seller / resolved / closed / merged',
      (['pending_agent', 'pending_seller', 'resolved', 'closed', 'merged'] as const).every(
        (s) => ALLOWED_TRANSITIONS.open.includes(s),
      ) && !ALLOWED_TRANSITIONS.open.includes('open'),
    )
    assert(
      '[20] closed → only reopen to open',
      ALLOWED_TRANSITIONS.closed.length === 1 && ALLOWED_TRANSITIONS.closed[0] === 'open',
    )
    assert(
      '[21] merged is terminal (no outbound edges)',
      ALLOWED_TRANSITIONS.merged.length === 0,
    )
  }

  // ---------------------------------------------------------------------------
  // [22..23] Barrel export completeness
  // ---------------------------------------------------------------------------
  console.log('\n[22..23] barrel exports')
  {
    const expected = [
      encryptMessage,
      decryptMessage,
      generateMessageKey,
      parseMessageKey,
      rotateMessage,
      computeSlaDeadlines,
      isSlaBreached,
      computeWindow,
      renderCannedReply,
      safeMessage,
      assertSellerSafe,
      validateCreateTicket,
      validateAddMessage,
    ]
    assert(
      '[22] every expected export is a function',
      expected.every((f) => typeof f === 'function'),
    )
    assert(
      '[23] constants + catalogs exported',
      typeof SAFE_MESSAGE_EN === 'string' &&
        typeof SAFE_MESSAGE_VI === 'string' &&
        LEAK_TERMS_REGEX instanceof RegExp &&
        SUPPORT_RATE_LIMITS.CREATE_TICKET !== undefined &&
        ALLOWED_TRANSITIONS.open.length > 0,
    )
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const { total, passed } = summary()
  console.log(`\n=== ${passed}/${total} checks passed ===`)
  if (passed !== total) process.exit(1)
}

main().catch((err) => {
  console.error('smoke crashed:', err)
  process.exit(1)
})
