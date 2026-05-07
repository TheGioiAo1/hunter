/**
 * Copywriter service unit tests (Phase 10 PR1).
 *
 * Pins:
 *  - Prompt builders produce well-shaped Anthropic Messages requests.
 *  - Parsers handle happy path + typical LLM shenanigans (code fences,
 *    stray commentary, missing fields).
 *  - Router integration is exercised via a fake in-memory router that
 *    returns canned text, so no real network I/O.
 */

import { describe, it, expect } from 'vitest'
import {
  buildProductTagsPrompt,
  buildCampaignSuggestionPrompt,
  buildEmailSubjectPrompt,
  AI_MODEL,
} from './prompts.js'
import {
  parseProductDescription,
  parseProductTags,
  parseCampaignContent,
  parseEmailSubjects,
  stripCodeFences,
  generateProductDescription,
  suggestProductTags,
  suggestCampaignContent,
  suggestEmailSubjects,
  CopywriterParseError,
} from './copywriter.js'
import { AIRouter, nullRecorder, unlimitedBudget, type CredentialResolver } from './router.js'
import type { ChatResponse, ProviderCredential } from './types.js'

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

describe('buildProductTagsPrompt', () => {
  it('pins the masterplan model + short max_tokens for tags', () => {
    const req = buildProductTagsPrompt({
      productTitle: 'Classic Leather Wallet',
      productDescription: 'Handstitched bifold in full-grain leather.',
      category: 'Accessories',
      locale: 'en',
    })
    expect(req.model).toBe(AI_MODEL)
    expect(req.max_tokens).toBeLessThanOrEqual(500)
  })

  it('asks for JSON with a tags[] field', () => {
    const req = buildProductTagsPrompt({
      productTitle: 'Test',
      productDescription: 'Test',
      category: 'Misc',
      locale: 'en',
    })
    expect(req.system).toContain('JSON')
    expect(req.system).toContain('tags')
  })

  it('passes through locale to the system prompt', () => {
    const req = buildProductTagsPrompt({
      productTitle: 'Test',
      productDescription: 'Test',
      category: 'Misc',
      locale: 'vi',
    })
    expect(req.system).toContain('vi')
  })

  it('respects maxTags override within bounds', () => {
    const req = buildProductTagsPrompt({
      productTitle: 'Test',
      productDescription: 'Test',
      category: 'Misc',
      locale: 'en',
      maxTags: 5,
    })
    expect(req.system).toContain('5 product tags')
  })

  it('clamps maxTags to [3, 20]', () => {
    const lowReq = buildProductTagsPrompt({
      productTitle: 'Test',
      productDescription: 'Test',
      category: 'Misc',
      locale: 'en',
      maxTags: 1,
    })
    expect(lowReq.system).toContain('3 product tags')

    const highReq = buildProductTagsPrompt({
      productTitle: 'Test',
      productDescription: 'Test',
      category: 'Misc',
      locale: 'en',
      maxTags: 100,
    })
    expect(highReq.system).toContain('20 product tags')
  })
})

describe('buildCampaignSuggestionPrompt', () => {
  it('includes shop name, audience, goal in the system prompt', () => {
    const req = buildCampaignSuggestionPrompt({
      shopName: 'Acme Store',
      campaignGoal: 'recover abandoned carts',
      segmentLabel: 'abandoned_carts',
      incentive: '10% off',
      locale: 'en',
    })
    expect(req.system).toContain('Acme Store')
    expect(req.system).toContain('abandoned_carts')
    expect(req.system).toContain('recover abandoned carts')
  })

  it('asks for JSON with subject_lines + body_html + cta_label fields', () => {
    const req = buildCampaignSuggestionPrompt({
      shopName: 'Acme',
      campaignGoal: 'promote sale',
      segmentLabel: 'all_subscribers',
      locale: 'en',
    })
    expect(req.system).toContain('subject_lines')
    expect(req.system).toContain('body_html')
    expect(req.system).toContain('cta_label')
  })

  it('user turn wraps incentive in delimiters even when empty', () => {
    const req = buildCampaignSuggestionPrompt({
      shopName: 'Acme',
      campaignGoal: 'x',
      segmentLabel: 's',
      locale: 'en',
    })
    const userText = req.messages[0]!.content
    expect(userText).toContain('<incentive></incentive>')
  })
})

describe('buildEmailSubjectPrompt', () => {
  it('generates the requested count, clamped to [3, 10]', () => {
    const low = buildEmailSubjectPrompt({
      emailPurpose: 'welcome',
      audience: 'new_subscribers',
      locale: 'en',
      count: 1,
    })
    expect(low.system).toContain('3 subject lines')

    const high = buildEmailSubjectPrompt({
      emailPurpose: 'welcome',
      audience: 'new_subscribers',
      locale: 'en',
      count: 25,
    })
    expect(high.system).toContain('10 subject lines')
  })

  it('asks for JSON with subjects[] field', () => {
    const req = buildEmailSubjectPrompt({
      emailPurpose: 'weekly newsletter',
      audience: 'all',
      locale: 'en',
    })
    expect(req.system).toContain('JSON')
    expect(req.system).toContain('subjects')
  })
})

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('parseProductDescription', () => {
  it('splits on --- separator', () => {
    const raw = `Variant one text.

---

Variant two text.

---

Variant three text.`
    const out = parseProductDescription(raw)
    expect(out.variants).toHaveLength(3)
    expect(out.variants[0]).toContain('Variant one')
    expect(out.variants[2]).toContain('Variant three')
  })

  it('accepts a single variant when LLM only returns one', () => {
    const raw = 'Only one variant returned.'
    const out = parseProductDescription(raw)
    expect(out.variants).toHaveLength(1)
  })

  it('caps at 3 variants even if the LLM returns more', () => {
    const raw = ['A', 'B', 'C', 'D', 'E'].join('\n\n---\n\n')
    const out = parseProductDescription(raw)
    expect(out.variants).toHaveLength(3)
  })

  it('throws CopywriterParseError on empty input', () => {
    expect(() => parseProductDescription('')).toThrow(CopywriterParseError)
    expect(() => parseProductDescription('   ')).toThrow(CopywriterParseError)
  })
})

describe('parseProductTags', () => {
  it('extracts tags from valid JSON', () => {
    const raw = '{"tags": ["leather", "wallet", "mens", "rfid"]}'
    const out = parseProductTags(raw)
    expect(out.tags).toEqual(['leather', 'wallet', 'mens', 'rfid'])
  })

  it('handles ```json fenced output', () => {
    const raw = '```json\n{"tags": ["a", "b"]}\n```'
    const out = parseProductTags(raw)
    expect(out.tags).toEqual(['a', 'b'])
  })

  it('filters out non-string items', () => {
    const raw = '{"tags": ["ok", 42, null, "also-ok"]}'
    const out = parseProductTags(raw)
    expect(out.tags).toEqual(['ok', 'also-ok'])
  })

  it('caps at 20 tags', () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${i}`)
    const raw = JSON.stringify({ tags: many })
    const out = parseProductTags(raw)
    expect(out.tags).toHaveLength(20)
  })

  it('throws on non-JSON', () => {
    expect(() => parseProductTags('not json')).toThrow(CopywriterParseError)
  })

  it('throws when tags field is missing', () => {
    expect(() => parseProductTags('{}')).toThrow(CopywriterParseError)
  })
})

describe('parseCampaignContent', () => {
  const sample = JSON.stringify({
    subject_lines: ['Subject A', 'Subject B', 'Subject C'],
    preview_text: 'preheader',
    body_html: '<p>Hi</p>',
    cta_label: 'Shop now',
    recommended_send_time: 'Tuesday 10:00',
  })

  it('parses all fields from valid JSON', () => {
    const out = parseCampaignContent(sample)
    expect(out.subject_lines).toHaveLength(3)
    expect(out.preview_text).toBe('preheader')
    expect(out.body_html).toContain('<p>Hi</p>')
    expect(out.cta_label).toBe('Shop now')
    expect(out.recommended_send_time).toBe('Tuesday 10:00')
  })

  it('handles fenced output', () => {
    const raw = '```json\n' + sample + '\n```'
    const out = parseCampaignContent(raw)
    expect(out.subject_lines).toHaveLength(3)
  })

  it('defaults missing fields to safe values', () => {
    const raw = JSON.stringify({ subject_lines: ['only this'] })
    const out = parseCampaignContent(raw)
    expect(out.preview_text).toBe('')
    expect(out.body_html).toBe('')
    expect(out.cta_label).toBe('Shop now')
  })

  it('throws when no subject_lines', () => {
    expect(() =>
      parseCampaignContent('{"subject_lines": []}'),
    ).toThrow(CopywriterParseError)
    expect(() =>
      parseCampaignContent('{"body_html": "x"}'),
    ).toThrow(CopywriterParseError)
  })
})

describe('parseEmailSubjects', () => {
  it('parses valid JSON', () => {
    const raw = '{"subjects": ["Line 1", "Line 2", "Line 3"]}'
    const out = parseEmailSubjects(raw)
    expect(out.subjects).toHaveLength(3)
  })

  it('throws on missing subjects', () => {
    expect(() => parseEmailSubjects('{}')).toThrow(CopywriterParseError)
  })

  it('throws on empty subjects after filtering', () => {
    expect(() => parseEmailSubjects('{"subjects": ["", "  "]}')).toThrow(
      CopywriterParseError,
    )
  })
})

describe('stripCodeFences', () => {
  it('removes ```json blocks', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('removes bare ``` blocks', () => {
    expect(stripCodeFences('```\nhello\n```')).toBe('hello')
  })
  it('leaves plain text alone', () => {
    expect(stripCodeFences('just a string')).toBe('just a string')
  })
  it('handles non-string gracefully', () => {
    expect(stripCodeFences(null as unknown as string)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Router integration (fake router)
// ---------------------------------------------------------------------------

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
  const router = new AIRouter({ resolver, recorder: nullRecorder, budget: unlimitedBudget })

  // Monkey-patch the router to return our canned response instead of
  // actually instantiating a provider. We cast to any and override the
  // `prepare` method via a thin subclass.
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

describe('generateProductDescription (integration)', () => {
  it('returns parsed variants + cost envelope', async () => {
    const raw = 'First variant.\n\n---\n\nSecond variant.\n\n---\n\nThird variant.'
    const router = makeFakeRouter(raw)
    const result = await generateProductDescription(router, 'shop-1', {
      productTitle: 'T',
      category: 'C',
      keywords: [],
      tone: 'neutral',
      locale: 'en',
    })
    expect(result.data.variants).toHaveLength(3)
    expect(result.cost.provider).toBe('anthropic')
    expect(result.cost.usage.totalTokens).toBe(150)
    expect(result.rawText).toBe(raw)
  })

  it('bubbles parse errors when LLM returns empty', async () => {
    const router = makeFakeRouter('')
    await expect(
      generateProductDescription(router, 'shop-1', {
        productTitle: 'T',
        category: 'C',
        keywords: [],
        tone: 'neutral',
        locale: 'en',
      }),
    ).rejects.toThrow(CopywriterParseError)
  })
})

describe('suggestProductTags (integration)', () => {
  it('returns parsed tags', async () => {
    const router = makeFakeRouter('{"tags": ["leather", "wallet"]}')
    const result = await suggestProductTags(router, 'shop-1', {
      productTitle: 'T',
      productDescription: 'D',
      category: 'C',
      locale: 'en',
    })
    expect(result.data.tags).toEqual(['leather', 'wallet'])
  })
})

describe('suggestCampaignContent (integration)', () => {
  it('returns parsed campaign', async () => {
    const raw = JSON.stringify({
      subject_lines: ['A', 'B', 'C'],
      preview_text: 'pre',
      body_html: '<p>Hello</p>',
      cta_label: 'Shop',
      recommended_send_time: 'Tue 10:00',
    })
    const router = makeFakeRouter(raw)
    const result = await suggestCampaignContent(router, 'shop-1', {
      shopName: 'Acme',
      campaignGoal: 'promote',
      segmentLabel: 'all',
      locale: 'en',
    })
    expect(result.data.subject_lines).toHaveLength(3)
    expect(result.data.body_html).toContain('<p>Hello</p>')
  })
})

describe('suggestEmailSubjects (integration)', () => {
  it('returns parsed subjects', async () => {
    const router = makeFakeRouter('{"subjects": ["Line 1", "Line 2", "Line 3"]}')
    const result = await suggestEmailSubjects(router, 'shop-1', {
      emailPurpose: 'welcome',
      audience: 'new',
      locale: 'en',
    })
    expect(result.data.subjects).toHaveLength(3)
  })
})
