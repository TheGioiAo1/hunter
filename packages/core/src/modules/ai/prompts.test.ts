/**
 * Gbox Platform — AI prompt builder tests (Stage 3G.2)
 *
 * The prompt builders are pure functions that turn narrow,
 * validated TypeScript inputs into Anthropic Messages API request
 * payloads. They are the deterministic / unit-testable floor of the
 * AI Expert system — the actual HTTP call lives one layer up in the
 * entrypoint, so admin tests can stub the HTTP fetch and still
 * exercise every field of the request body.
 *
 * These tests pin:
 *
 *   • Every builder targets the model documented in the masterplan
 *     (`claude-sonnet-4-20250514`).
 *   • The system prompt sets hard guardrails (locale, brand voice,
 *     no hallucinated pricing, JSON-only output when applicable).
 *   • User input is interpolated into the user turn verbatim BUT
 *     wrapped in delimiters so a prompt-injection attempt can't
 *     escape the merchant context.
 *   • Oversized merchant input is truncated to a known cap so a
 *     paste-of-a-book doesn't blow the token budget.
 *   • Every builder returns `max_tokens`, `temperature`, and the
 *     `model` field so the HTTP layer doesn't have to supply
 *     defaults.
 */

import { describe, it, expect } from 'vitest'
import {
  AI_MODEL,
  MAX_MERCHANT_INPUT_CHARS,
  buildProductDescriptionPrompt,
  buildSeoMetaPrompt,
  buildThemeClonePrompt,
  buildAnalyticsInsightPrompt,
  truncateForPrompt,
} from './prompts.js'

// ---------------------------------------------------------------------------
// Product description
// ---------------------------------------------------------------------------

describe('buildProductDescriptionPrompt', () => {
  it('targets the masterplan Claude model with sensible defaults', () => {
    const req = buildProductDescriptionPrompt({
      productTitle: 'Classic Leather Wallet',
      category: 'Accessories',
      keywords: ['leather', 'rfid', 'mens'],
      tone: 'premium',
      locale: 'en',
    })
    expect(req.model).toBe(AI_MODEL)
    expect(req.max_tokens).toBeGreaterThan(0)
    expect(req.max_tokens).toBeLessThanOrEqual(1024)
    expect(req.temperature).toBeGreaterThanOrEqual(0)
    expect(req.temperature).toBeLessThanOrEqual(1)
  })

  it('encodes merchant-supplied fields into the user turn inside delimiters', () => {
    const req = buildProductDescriptionPrompt({
      productTitle: 'Classic Leather Wallet',
      category: 'Accessories',
      keywords: ['leather', 'rfid'],
      tone: 'premium',
      locale: 'en',
    })
    expect(req.messages).toHaveLength(1)
    const userText = req.messages[0]!.content
    expect(req.messages[0]!.role).toBe('user')
    expect(userText).toContain('<product_title>Classic Leather Wallet</product_title>')
    expect(userText).toContain('<category>Accessories</category>')
    expect(userText).toContain('<keywords>leather, rfid</keywords>')
    expect(userText).toContain('<tone>premium</tone>')
  })

  it('system prompt sets guardrails about invented facts and target locale', () => {
    const req = buildProductDescriptionPrompt({
      productTitle: 'Test',
      category: 'Misc',
      keywords: [],
      tone: 'neutral',
      locale: 'vi',
    })
    expect(req.system.toLowerCase()).toContain('do not invent')
    expect(req.system).toContain('vi')
  })

  it('truncates oversized merchant input to MAX_MERCHANT_INPUT_CHARS', () => {
    const bigTitle = 'A'.repeat(MAX_MERCHANT_INPUT_CHARS + 5000)
    const req = buildProductDescriptionPrompt({
      productTitle: bigTitle,
      category: 'Misc',
      keywords: [],
      tone: 'neutral',
      locale: 'en',
    })
    const userText = req.messages[0]!.content
    // The whole prompt must not exceed a generous upper bound —
    // this is the sanity check for the truncation step.
    expect(userText.length).toBeLessThan(MAX_MERCHANT_INPUT_CHARS + 2000)
    // And it must end with the truncation marker so the reviewer
    // knows the content was clipped.
    expect(userText).toContain('…[truncated]')
  })
})

// ---------------------------------------------------------------------------
// SEO meta
// ---------------------------------------------------------------------------

describe('buildSeoMetaPrompt', () => {
  it('asks the model for JSON output so the caller can parse it', () => {
    const req = buildSeoMetaPrompt({
      pageTitle: 'Blue Cotton T-Shirt',
      pageBodySummary: 'A lightweight cotton tee in five sizes.',
      targetKeywords: ['cotton tee', 'blue shirt'],
      locale: 'en',
    })
    expect(req.system).toContain('JSON')
    expect(req.system).toContain('title')
    expect(req.system).toContain('meta_description')
    expect(req.system).toContain('slug')
  })

  it('keeps keyword list in the user turn even when empty', () => {
    const req = buildSeoMetaPrompt({
      pageTitle: 'About Us',
      pageBodySummary: 'Our story.',
      targetKeywords: [],
      locale: 'en',
    })
    const userText = req.messages[0]!.content
    expect(userText).toContain('<target_keywords></target_keywords>')
  })

  it('passes through locale to the system prompt', () => {
    const req = buildSeoMetaPrompt({
      pageTitle: 'Test',
      pageBodySummary: 'Body',
      targetKeywords: [],
      locale: 'vi',
    })
    expect(req.system).toContain('vi')
  })
})

// ---------------------------------------------------------------------------
// Theme clone
// ---------------------------------------------------------------------------

describe('buildThemeClonePrompt', () => {
  it('instructs the model to output ColorPalette + FontConfig JSON only', () => {
    const req = buildThemeClonePrompt({
      sourceUrl: 'https://nike.com',
      htmlSnippet: '<html><head></head><body></body></html>',
      cssSnippet: ':root { --brand: #ff0000 }',
    })
    expect(req.system).toContain('JSON')
    expect(req.system).toContain('ColorPalette')
    expect(req.system).toContain('FontConfig')
    expect(req.system.toLowerCase()).toContain('do not copy')
  })

  it('encodes source url + snippets into delimited blocks', () => {
    const req = buildThemeClonePrompt({
      sourceUrl: 'https://example.com',
      htmlSnippet: '<nav>Home</nav>',
      cssSnippet: 'body { color: red }',
    })
    const text = req.messages[0]!.content
    expect(text).toContain('<source_url>https://example.com</source_url>')
    expect(text).toContain('<html_snippet>\n<nav>Home</nav>\n</html_snippet>')
    expect(text).toContain('<css_snippet>\nbody { color: red }\n</css_snippet>')
  })

  it('truncates huge HTML/CSS snippets so we never blow the context window', () => {
    const bigCss = 'a{}'.repeat(MAX_MERCHANT_INPUT_CHARS)
    const req = buildThemeClonePrompt({
      sourceUrl: 'https://example.com',
      htmlSnippet: '<html></html>',
      cssSnippet: bigCss,
    })
    const text = req.messages[0]!.content
    expect(text).toContain('…[truncated]')
    // The overall user turn must stay comfortably under a quarter
    // million characters even with two snippets + boilerplate.
    expect(text.length).toBeLessThan(MAX_MERCHANT_INPUT_CHARS * 3)
  })
})

// ---------------------------------------------------------------------------
// Analytics insight
// ---------------------------------------------------------------------------

describe('buildAnalyticsInsightPrompt', () => {
  it('asks for a plain-language recommendation grounded in the provided metrics', () => {
    const req = buildAnalyticsInsightPrompt({
      question: 'Why did conversion drop last week?',
      metrics: [
        { label: 'sessions', value: 12_300 },
        { label: 'orders', value: 312 },
        { label: 'conversion_rate', value: '2.54%' },
      ],
      locale: 'en',
    })
    const text = req.messages[0]!.content
    expect(text).toContain('<question>Why did conversion drop last week?</question>')
    expect(text).toContain('<metric label="sessions">12300</metric>')
    expect(text).toContain('<metric label="orders">312</metric>')
    expect(text).toContain('<metric label="conversion_rate">2.54%</metric>')
    expect(req.system.toLowerCase()).toContain('do not invent')
  })

  it('accepts an empty metric list and still produces a valid request', () => {
    const req = buildAnalyticsInsightPrompt({
      question: 'How am I doing?',
      metrics: [],
      locale: 'en',
    })
    expect(req.model).toBe(AI_MODEL)
    expect(req.messages[0]!.content).toContain('<metrics></metrics>')
  })
})

// ---------------------------------------------------------------------------
// truncateForPrompt
// ---------------------------------------------------------------------------

describe('truncateForPrompt', () => {
  it('returns short inputs unchanged', () => {
    expect(truncateForPrompt('hello', 1000)).toBe('hello')
  })

  it('clips oversized inputs and appends the truncation marker', () => {
    const out = truncateForPrompt('x'.repeat(5000), 1000)
    expect(out.length).toBeLessThanOrEqual(1000 + '…[truncated]'.length)
    expect(out.endsWith('…[truncated]')).toBe(true)
  })

  it('handles non-string input defensively', () => {
    // truncateForPrompt accepts `unknown`; these probes verify the
    // runtime guard returns '' for non-strings without needing a
    // ts-expect-error suppression.
    expect(truncateForPrompt(12345, 1000)).toBe('')
    expect(truncateForPrompt(null, 1000)).toBe('')
  })
})
