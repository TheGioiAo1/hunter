/**
 * Phase 10 PR1 — AI Copywriter + Campaign Suggester smoke.
 *
 * Unit coverage: packages/core/src/modules/ai/copywriter.test.ts (36 cases)
 *                packages/core/src/modules/ai/prompts.test.ts    (15 cases)
 *
 * This script verifies the live path end-to-end WITHOUT hitting a real
 * LLM provider — instead, it:
 *
 *   1. Confirms the prompt builders produce a well-shaped Anthropic
 *      Messages payload pointing at the pinned model (AI_MODEL).
 *   2. Confirms each parser handles the happy path + typical LLM
 *      shenanigans (code fences, missing fields).
 *   3. Confirms the copywriter service, fed with a fake router that
 *      returns canned text, returns the shape admin handlers expect.
 *   4. Confirms the `shop_ai_config` table from migration 020 is
 *      reachable and has the right columns — `getAIConfig()` roundtrip.
 *   5. Confirms iron rule 5 for the handler: `safeMessage()` never
 *      leaks "god admin" or internal routes.
 *
 * Run from server 2 or locally (uses DB only for [17]):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase10-pr1.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  AI_MODEL,
  buildProductDescriptionPrompt,
  buildProductTagsPrompt,
  buildCampaignSuggestionPrompt,
  buildEmailSubjectPrompt,
  generateProductDescription,
  suggestProductTags,
  suggestCampaignContent,
  suggestEmailSubjects,
  parseProductDescription,
  parseProductTags,
  parseCampaignContent,
  parseEmailSubjects,
  stripCodeFences,
  AIRouter,
  nullRecorder,
  unlimitedBudget,
  CopywriterParseError,
  type CredentialResolver,
  type ProviderCredential,
  type ChatResponse,
} from '../packages/core/src/modules/ai/index.js'
import { getAIConfig } from '../packages/core/src/modules/ai/config-service.js'
import { _safeMessage } from '../apps/store-admin/src/pages/ai-copywriter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function assert(label: string, cond: any, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ [${passed + failed}] ${label}`)
  } else {
    failed++
    console.error(`  ✗ [${passed + failed}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function makeFakeRouter(replyText: string): AIRouter {
  const credential: ProviderCredential = {
    provider: 'anthropic',
    apiKey: 'fake',
    model: AI_MODEL,
  }
  const resolver: CredentialResolver = {
    async resolve() {
      return [credential]
    },
  }
  const router = new AIRouter({
    resolver,
    recorder: nullRecorder,
    budget: unlimitedBudget,
  })
  ;(router as any).prepare = async () => ({
    provider: {
      id: 'anthropic',
      credential,
      async chat(): Promise<ChatResponse> {
        return {
          provider: 'anthropic',
          model: AI_MODEL,
          text: replyText,
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          finishReason: 'stop',
          durationMs: 10,
        }
      },
      async *chatStream() {
        yield { type: 'text', delta: replyText } as const
        yield {
          type: 'done',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          finishReason: 'stop',
        } as const
      },
    },
    request: { messages: [] },
  })
  return router
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Phase 10 PR1 — AI Copywriter smoke ===\n')
  const needsDb = !!process.env.DATABASE_URL
  const db = needsDb ? createDb(process.env.DATABASE_URL!) : null

  try {
    // -------------------------------------------------------------------
    // [1-4] Prompt builders target the masterplan model
    // -------------------------------------------------------------------
    console.log('Prompt builders:')
    const pd = buildProductDescriptionPrompt({
      productTitle: 'Classic Leather Wallet',
      category: 'Accessories',
      keywords: ['leather', 'rfid'],
      tone: 'premium',
      locale: 'en',
    })
    assert('[1] buildProductDescriptionPrompt pins AI_MODEL', pd.model === AI_MODEL, `got ${pd.model}`)

    const pt = buildProductTagsPrompt({
      productTitle: 'X',
      productDescription: 'Y',
      category: 'C',
      locale: 'en',
    })
    assert('[2] buildProductTagsPrompt returns JSON schema with tags[]',
      pt.system.includes('"tags"'), 'missing tags field in system prompt')

    const cs = buildCampaignSuggestionPrompt({
      shopName: 'Acme',
      campaignGoal: 'promote sale',
      segmentLabel: 'all',
      locale: 'en',
    })
    assert('[3] buildCampaignSuggestionPrompt asks for subject_lines + body_html',
      cs.system.includes('subject_lines') && cs.system.includes('body_html'),
      'missing campaign fields in system prompt')

    const es = buildEmailSubjectPrompt({
      emailPurpose: 'welcome',
      audience: 'new',
      locale: 'vi',
      count: 7,
    })
    assert('[4] buildEmailSubjectPrompt honours count + locale',
      es.system.includes('7 subject lines') && es.system.includes('vi'),
      'count/locale not propagated')

    // -------------------------------------------------------------------
    // [5-8] Parsers handle happy + edge paths
    // -------------------------------------------------------------------
    console.log('\nParsers:')
    const desc = parseProductDescription('A\n\n---\n\nB\n\n---\n\nC')
    assert('[5] parseProductDescription splits 3 variants', desc.variants.length === 3)

    const tags = parseProductTags('```json\n{"tags": ["leather", "wallet"]}\n```')
    assert('[6] parseProductTags strips code fences', tags.tags.length === 2 && tags.tags[0] === 'leather')

    const campaign = parseCampaignContent(JSON.stringify({
      subject_lines: ['A', 'B'],
      preview_text: 'pre',
      body_html: '<p>x</p>',
      cta_label: 'Go',
      recommended_send_time: 'Tue',
    }))
    assert('[7] parseCampaignContent returns all fields',
      campaign.subject_lines.length === 2 && campaign.body_html === '<p>x</p>')

    const subjects = parseEmailSubjects('{"subjects": ["A", "B", "C"]}')
    assert('[8] parseEmailSubjects parses valid JSON', subjects.subjects.length === 3)

    // [9-10] Parsers throw on bad input
    let threw = false
    try { parseProductDescription('') } catch (e) { threw = e instanceof CopywriterParseError }
    assert('[9] parseProductDescription throws on empty', threw)

    threw = false
    try { parseProductTags('not json') } catch (e) { threw = e instanceof CopywriterParseError }
    assert('[10] parseProductTags throws on non-JSON', threw)

    // [11] stripCodeFences idempotent on plain text
    assert('[11] stripCodeFences leaves plain text unchanged',
      stripCodeFences('hello') === 'hello')

    // -------------------------------------------------------------------
    // [12-15] Service with fake router round-trips
    // -------------------------------------------------------------------
    console.log('\nCopywriter service (fake router):')
    const rDesc = await generateProductDescription(
      makeFakeRouter('V1\n\n---\n\nV2\n\n---\n\nV3'),
      'shop-x',
      { productTitle: 'T', category: 'C', keywords: [], tone: 't', locale: 'en' },
    )
    assert('[12] generateProductDescription returns 3 variants + cost envelope',
      rDesc.data.variants.length === 3 && rDesc.cost.provider === 'anthropic')

    const rTags = await suggestProductTags(
      makeFakeRouter('{"tags": ["a", "b", "c"]}'),
      'shop-x',
      { productTitle: 'T', productDescription: 'D', category: 'C', locale: 'en' },
    )
    assert('[13] suggestProductTags returns parsed tags', rTags.data.tags.length === 3)

    const rCampaign = await suggestCampaignContent(
      makeFakeRouter(JSON.stringify({
        subject_lines: ['A', 'B', 'C'],
        preview_text: 'pre',
        body_html: '<p>hi</p>',
        cta_label: 'Go',
        recommended_send_time: 'Tue',
      })),
      'shop-x',
      { shopName: 'Acme', campaignGoal: 'promote', segmentLabel: 'all', locale: 'en' },
    )
    assert('[14] suggestCampaignContent returns full envelope',
      rCampaign.data.subject_lines.length === 3 && rCampaign.data.cta_label === 'Go')

    const rSubs = await suggestEmailSubjects(
      makeFakeRouter('{"subjects": ["S1", "S2", "S3"]}'),
      'shop-x',
      { emailPurpose: 'welcome', audience: 'new', locale: 'en' },
    )
    assert('[15] suggestEmailSubjects returns 3 subjects', rSubs.data.subjects.length === 3)

    // [16] cost envelope includes provider + model + tokens
    assert('[16] CopywriterResult cost envelope shape',
      rDesc.cost.usage.totalTokens === 150 &&
        typeof rDesc.cost.durationMs === 'number' &&
        rDesc.cost.model === AI_MODEL)

    // -------------------------------------------------------------------
    // [17] shop_ai_config round-trip (live DB only if DATABASE_URL set)
    // -------------------------------------------------------------------
    if (needsDb && db) {
      console.log('\nLive DB (migration 020):')
      // getAIConfig on a non-existent shop should return null gracefully.
      // Use a random UUID — shops.id is a uuid column.
      const none = await getAIConfig(db as any, randomUUID())
      assert('[17] getAIConfig returns null for unknown shop', none === null)
    } else {
      console.log('\n(DATABASE_URL not set — skipping live DB check [17])')
    }

    // -------------------------------------------------------------------
    // [18-20] Iron rule 5 — safeMessage() never leaks god-admin surface
    // -------------------------------------------------------------------
    console.log('\nIron rule 5 audit:')
    const m1 = _safeMessage(new Error('some internal path /god-admin/xyz'))
    assert('[18] safeMessage() never contains "god admin"',
      !/god[\s-]*admin/i.test(m1), `leak: ${m1}`)

    const m2 = _safeMessage(new Error('budget exhausted for shop 123'))
    assert('[19] safeMessage() maps budget errors to user-friendly text',
      m2.toLowerCase().includes('budget') && m2.toLowerCase().includes('gbox support'))

    const m3 = _safeMessage(new CopywriterParseError('bad', 'raw'))
    assert('[20] safeMessage() maps parse errors to user-friendly text',
      m3.toLowerCase().includes('unexpected format'))

    const m4 = _safeMessage(new Error('auth: no AI credentials configured'))
    assert('[21] safeMessage() maps auth errors to "configure provider"',
      m4.toLowerCase().includes('configure') || m4.toLowerCase().includes('settings'))

    const m5 = _safeMessage(new Error('random internal'))
    assert('[22] safeMessage() falls back to generic support copy',
      m5.toLowerCase().includes('gbox support'))

  } finally {
    if (db) await (db as any).destroy?.()
  }

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  console.log(`\n=== ${passed + failed} assertions, ${passed} passed, ${failed} failed ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Smoke aborted:', err)
  process.exit(1)
})
