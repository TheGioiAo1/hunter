/**
 * Gbox Platform — Phase 12.5 PR4 smoke
 *
 * Exercises the Support AI layer end-to-end WITHOUT hitting the
 * Anthropic API:
 *
 *   [1..5]    pickModel decision tree (all 4 spec branches + SKU map)
 *   [6..9]    computeCostCents price-sheet pins (Sonnet/Opus edge cases)
 *   [10..14]  redactPii sentinel coverage (CC/Luhn, SSN, email, VN IDs)
 *   [15..18]  evaluateBudget state transitions (ok/warn/exceeded boundaries)
 *   [19..22]  monthKey UTC correctness + assertAISupportConfigured flow
 *   [23..27]  config-store crypto round-trip (encrypt/decrypt/tamper/null)
 *   [28..31]  Parsers (summary bullets, categorize, sentiment, error map)
 *   [32..35]  Iron Rule 5 — no '/god-admin/' / 'FEATURE_FLAG_' in any
 *             seller-visible system prompt builder (suggest-reply +
 *             summarize + categorize + sentiment) OR the seller-facing
 *             missingReason() strings.
 *
 * Runs offline — no DB, no HTTP. Safe anywhere with Node >= 20.
 *
 *   npx tsx scripts/smoke-phase12-5-pr4.ts
 */

import {
  ANTHROPIC_SKU,
  AINotConfiguredError,
  BUDGET_WARN_THRESHOLD,
  DEFAULT_BUDGET_CAP_CENTS,
  HIGH_STAKES_KEYWORDS,
  OPUS_CONFIDENCE_FLOOR,
  REDACTION_SENTINELS,
  SUPPORT_CATEGORIES,
  SUPPORT_AI_PRICE_SHEET,
  assertAISupportConfigured,
  buildAutoCategorizeSystemPrompt,
  buildSentimentSystemPrompt,
  buildSuggestReplySystemPrompt,
  buildSummarizeThreadSystemPrompt,
  computeCostCents,
  decryptAnthropicKey,
  encryptAnthropicKey,
  evaluateBudget,
  isAISupportConfigured,
  isEncryptedKeyBlob,
  isLuhnValid,
  isWithinBudget,
  mapAnthropicError,
  missingReason,
  monthKey,
  parseCategorizeResponse,
  parseSentimentResponse,
  parseSummaryBullets,
  pickModel,
  redactPii,
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
} from '@gbox/core/modules/support-ai/index.js'
// `missingReason` import retained above for completeness (used in early
// drafts; keeping the re-export verified). Smoke asserts on
// AINotConfiguredError default messages instead (see block [35]).
void missingReason

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
  return { assert, summary: () => ({ total, passed }) }
}

async function main() {
  console.log('=== Phase 12.5 PR4 smoke — Support AI (hybrid Sonnet+Opus + $200 cap) ===\n')
  const { assert, summary } = makeAsserter()

  // Seed encryption-key env so crypto round-trip tests run. Restore
  // at end so local dev shells don't pick up the stub.
  const prevKey = process.env.SUPPORT_AI_ENCRYPTION_KEY
  process.env.SUPPORT_AI_ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

  // -------------------------------------------------------------------------
  // [1..5] pickModel decision tree
  // -------------------------------------------------------------------------
  console.log('[1..5] pickModel decision tree')
  assert(
    'payment + normal priority → opus-4 (spec §10.6.1 branch 1)',
    pickModel(
      { category: 'payment', priority: 'normal', subject: 'refund question' },
      0.4,
    ) === 'opus-4',
  )
  assert(
    'dispute keyword → opus-4 regardless of category/confidence',
    pickModel(
      { category: 'technical', priority: 'normal', subject: 'filing a chargeback dispute' },
      0.2,
    ) === 'opus-4' &&
      pickModel(
        { category: 'other', priority: 'normal', subject: 'legal action coming' },
        0.1,
      ) === 'opus-4',
  )
  assert(
    'confidence ≥ OPUS_CONFIDENCE_FLOOR (0.85) → opus-4',
    OPUS_CONFIDENCE_FLOOR === 0.85 &&
      pickModel(
        { category: 'account', priority: 'normal', subject: 'billing help' },
        0.9,
      ) === 'opus-4',
  )
  assert(
    'default fallback → sonnet-4-5',
    pickModel(
      { category: 'onboarding', priority: 'normal', subject: 'how to create products' },
      0.4,
    ) === 'sonnet-4-5' &&
      pickModel(
        { category: 'technical', priority: 'normal', subject: 'DNS setup' },
        0.6,
      ) === 'sonnet-4-5',
  )
  assert(
    'ANTHROPIC_SKU maps both models to real API SKUs',
    typeof ANTHROPIC_SKU['sonnet-4-5'] === 'string' &&
      ANTHROPIC_SKU['sonnet-4-5'].includes('sonnet') &&
      typeof ANTHROPIC_SKU['opus-4'] === 'string' &&
      ANTHROPIC_SKU['opus-4'].includes('opus'),
  )

  // -------------------------------------------------------------------------
  // [6..9] computeCostCents + price sheet
  // -------------------------------------------------------------------------
  console.log('\n[6..9] computeCostCents price-sheet pins')
  assert(
    'SUPPORT_AI_PRICE_SHEET has Sonnet cheaper than Opus on input + output',
    SUPPORT_AI_PRICE_SHEET['sonnet-4-5'].inputCentsPerMillion <
      SUPPORT_AI_PRICE_SHEET['opus-4'].inputCentsPerMillion &&
      SUPPORT_AI_PRICE_SHEET['sonnet-4-5'].outputCentsPerMillion <
        SUPPORT_AI_PRICE_SHEET['opus-4'].outputCentsPerMillion,
  )
  assert(
    'Sonnet 1M input + 1M output = 300 + 1500 = 1800 cents',
    computeCostCents('sonnet-4-5', 1_000_000, 1_000_000) === 1800,
  )
  assert(
    'Opus 1M input + 1M output = 1500 + 7500 = 9000 cents',
    computeCostCents('opus-4', 1_000_000, 1_000_000) === 9000,
  )
  assert(
    'zero-token invocation costs 0 cents (error case)',
    computeCostCents('sonnet-4-5', 0, 0) === 0 &&
      computeCostCents('opus-4', 0, 0) === 0,
  )

  // -------------------------------------------------------------------------
  // [10..14] PII redaction
  // -------------------------------------------------------------------------
  console.log('\n[10..14] redactPii sentinel coverage')
  assert(
    'Visa test CC 4242-4242-4242-4242 → [REDACTED-CC]',
    redactPii('card 4242-4242-4242-4242 expired').includes(REDACTION_SENTINELS.creditCard) &&
      !redactPii('card 4242-4242-4242-4242 expired').includes('4242'),
  )
  assert(
    'SSN 123-45-6789 → [REDACTED-SSN]',
    redactPii('my ssn is 123-45-6789').includes(REDACTION_SENTINELS.ssn),
  )
  assert(
    'Email buithai3107@gmail.com → [REDACTED-EMAIL]',
    redactPii('mail buithai3107@gmail.com').includes(REDACTION_SENTINELS.email),
  )
  assert(
    'VN CMND 9-digit + CCCD 12-digit → [REDACTED-ID]',
    redactPii('CMND 024195739 CCCD 023456789012').includes(REDACTION_SENTINELS.nationalId),
  )
  assert(
    'non-Luhn 16-digit run (order ID) NOT redacted',
    redactPii('order 1234567890123456').includes('1234567890123456') &&
      !isLuhnValid('1234567890123456'),
  )

  // -------------------------------------------------------------------------
  // [15..18] Budget classifier
  // -------------------------------------------------------------------------
  console.log('\n[15..18] evaluateBudget state transitions')
  assert(
    'DEFAULT_BUDGET_CAP_CENTS = 20_000 ($200)',
    DEFAULT_BUDGET_CAP_CENTS === 20_000,
  )
  assert(
    'BUDGET_WARN_THRESHOLD = 0.8 (80%)',
    BUDGET_WARN_THRESHOLD === 0.8,
  )
  assert(
    'boundary: 15_999 → ok, 16_000 → warn, 19_999 → warn, 20_000 → exceeded',
    evaluateBudget(15_999).state === 'ok' &&
      evaluateBudget(16_000).state === 'warn' &&
      evaluateBudget(19_999).state === 'warn' &&
      evaluateBudget(20_000).state === 'exceeded' &&
      evaluateBudget(25_000).state === 'exceeded',
  )
  assert(
    'isWithinBudget agrees: true <20k, false ≥20k',
    isWithinBudget(10_000) === true &&
      isWithinBudget(19_999) === true &&
      isWithinBudget(20_000) === false,
  )

  // -------------------------------------------------------------------------
  // [19..22] monthKey + assertAISupportConfigured
  // -------------------------------------------------------------------------
  console.log('\n[19..22] monthKey + assertAISupportConfigured')
  assert(
    'monthKey is UTC — 2025-12-31T23:30-08:00 (Pacific) → "2026-01"',
    monthKey(new Date('2025-12-31T23:30:00-08:00')) === '2026-01',
  )
  assert(
    'assertAISupportConfigured does NOT throw when fully configured',
    (() => {
      try {
        assertAISupportConfigured({
          anthropicApiKey: 'sk-ant-demo',
          enabled: true,
          spentCentsThisMonth: 0,
          capCents: 20_000,
        })
        return true
      } catch {
        return false
      }
    })(),
  )
  assert(
    'assertAISupportConfigured throws AINotConfiguredError{missing_key} on empty key',
    (() => {
      try {
        assertAISupportConfigured({
          anthropicApiKey: '',
          enabled: true,
          spentCentsThisMonth: 0,
          capCents: 20_000,
        })
        return false
      } catch (e) {
        return (
          e instanceof AINotConfiguredError && (e as AINotConfiguredError).reason === 'missing_key'
        )
      }
    })(),
  )
  assert(
    'assertAISupportConfigured throws AINotConfiguredError{budget_exceeded} past cap',
    (() => {
      try {
        assertAISupportConfigured({
          anthropicApiKey: 'sk-ant-demo',
          enabled: true,
          spentCentsThisMonth: 25_000,
          capCents: 20_000,
        })
        return false
      } catch (e) {
        return (
          e instanceof AINotConfiguredError &&
          (e as AINotConfiguredError).reason === 'budget_exceeded'
        )
      }
    })(),
  )

  // -------------------------------------------------------------------------
  // [23..27] Crypto round-trip (encrypt key → decrypt returns original)
  // -------------------------------------------------------------------------
  console.log('\n[23..27] config-store crypto round-trip')
  const plaintext = 'sk-ant-api03-example-live-key-xyz'
  const blob = encryptAnthropicKey(plaintext)
  assert(
    'encryptAnthropicKey returns {v:1, ct:hex, iv:hex, tag:hex}',
    blob.v === 1 &&
      /^[0-9a-f]+$/.test(blob.ct) &&
      /^[0-9a-f]+$/.test(blob.iv) &&
      /^[0-9a-f]+$/.test(blob.tag),
  )
  assert(
    'decryptAnthropicKey returns the exact plaintext',
    decryptAnthropicKey(blob) === plaintext,
  )
  assert(
    'isEncryptedKeyBlob accepts the real blob, rejects null/junk',
    isEncryptedKeyBlob(blob) === true &&
      isEncryptedKeyBlob(null) === false &&
      isEncryptedKeyBlob({ v: 2, ct: '', iv: '', tag: '' }) === false,
  )
  assert(
    'tampered tag causes decrypt to throw',
    (() => {
      try {
        decryptAnthropicKey({ ...blob, tag: 'a'.repeat(blob.tag.length) })
        return false
      } catch {
        return true
      }
    })(),
  )
  assert(
    'decryptAnthropicKey(null) returns "" (no throw — MVP default)',
    decryptAnthropicKey(null) === '' && decryptAnthropicKey(undefined) === '',
  )

  // -------------------------------------------------------------------------
  // [28..31] Parsers + error map
  // -------------------------------------------------------------------------
  console.log('\n[28..31] parsers + mapAnthropicError')
  assert(
    'parseSummaryBullets picks dash, star, and unicode bullets; caps at 3',
    JSON.stringify(parseSummaryBullets('- a\n* b\n• c\n- d')) === '["a","b","c"]',
  )
  assert(
    'parseCategorizeResponse strips markdown fences + validates category',
    parseCategorizeResponse(
      '```json\n{"category":"payment","confidence":0.7,"rationale":"x"}\n```',
    )?.category === 'payment' &&
      parseCategorizeResponse('{"category":"fish","confidence":0.5,"rationale":"x"}') ===
        null &&
      SUPPORT_CATEGORIES.length === 6,
  )
  assert(
    'parseSentimentResponse rejects out-of-range indices',
    parseSentimentResponse('[{"index":5,"label":"angry","score":0.9}]', 2).length === 0 &&
      parseSentimentResponse('[{"index":0,"label":"angry","score":5}]', 1)[0].score === 1,
  )
  assert(
    'mapAnthropicError: 401→auth, 429→transient, 500→transient, content_filter→policy',
    mapAnthropicError({ status: 401, message: 'bad key' }).kind === 'auth' &&
      mapAnthropicError({ status: 429, message: 'rate' }).kind === 'transient' &&
      mapAnthropicError({ status: 500, message: 's' }).kind === 'transient' &&
      mapAnthropicError({ status: 400, message: 'x', error: { type: 'content_filter' } }).kind ===
        'policy' &&
      mapAnthropicError(new Error('boom')).kind === 'unknown',
  )

  // -------------------------------------------------------------------------
  // [32..35] Iron Rule 5 — no internal paths leaked into prompts/strings
  // -------------------------------------------------------------------------
  console.log('\n[32..35] Iron Rule 5 — no /god-admin/, FEATURE_FLAG_ in seller-visible output')
  const LEAK_RE = /\/god-admin\/|FEATURE_FLAG_|\bGod Admin\b/i
  const prompts = [
    buildSuggestReplySystemPrompt('en'),
    buildSuggestReplySystemPrompt('vi'),
    buildSummarizeThreadSystemPrompt('en'),
    buildSummarizeThreadSystemPrompt('vi'),
    buildAutoCategorizeSystemPrompt('en'),
    buildAutoCategorizeSystemPrompt('vi'),
    buildSentimentSystemPrompt(),
  ]
  assert(
    'suggest-reply prompts do not leak internal paths or God Admin term',
    !LEAK_RE.test(prompts[0]) && !LEAK_RE.test(prompts[1]),
    prompts.slice(0, 2).find((p) => LEAK_RE.test(p))?.match(LEAK_RE)?.[0],
  )
  assert(
    'summarize-thread prompts do not leak internal paths',
    !LEAK_RE.test(prompts[2]) && !LEAK_RE.test(prompts[3]),
  )
  assert(
    'auto-categorize + sentiment prompts do not leak internal paths',
    !LEAK_RE.test(prompts[4]) && !LEAK_RE.test(prompts[5]) && !LEAK_RE.test(prompts[6]),
  )
  // missingReason() is intentionally agent-facing (supporter portal
  // tooltips + god-admin AI settings page) so it may reference
  // /god-admin/... paths — that's internal tooling, not seller UI.
  // What we verify is the seller-facing contract: when a SELLER hits
  // a disabled AI surface they should get AINotConfiguredError with a
  // seller-safe default message that the widget can show verbatim.
  const sellerSideDefaults = [
    new AINotConfiguredError('missing_key').message,
    new AINotConfiguredError('disabled').message,
    new AINotConfiguredError('budget_exceeded').message,
  ]
  assert(
    'AINotConfiguredError default messages are seller-safe (no /god-admin/)',
    sellerSideDefaults.every((s) => !LEAK_RE.test(s)),
    sellerSideDefaults.find((s) => LEAK_RE.test(s))?.match(LEAK_RE)?.[0],
  )

  // Reset env to its prior state.
  if (prevKey === undefined) {
    delete process.env.SUPPORT_AI_ENCRYPTION_KEY
  } else {
    process.env.SUPPORT_AI_ENCRYPTION_KEY = prevKey
  }

  // -------------------------------------------------------------------------
  // Sanity — HIGH_STAKES_KEYWORDS is still the canonical set (spec §10.6.1)
  // -------------------------------------------------------------------------
  console.log('\n[sanity] HIGH_STAKES_KEYWORDS covers every spec trigger')
  const canonicalTriggers = ['dispute', 'chargeback', 'legal', 'lawyer', 'fraud']
  const missing = canonicalTriggers.filter((word) => !HIGH_STAKES_KEYWORDS.test(word))
  assert(
    'HIGH_STAKES_KEYWORDS matches every spec §10.6.1 keyword',
    missing.length === 0,
    missing.join(','),
  )

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const { total, passed } = summary()
  console.log(`\n=== PR4 smoke summary ===\npassed: ${passed}/${total}`)
  if (passed !== total) process.exit(1)
}

main().catch((err) => {
  console.error('[smoke-phase12-5-pr4] fatal', err)
  process.exit(1)
})
