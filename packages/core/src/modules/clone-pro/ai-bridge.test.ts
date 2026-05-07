/**
 * Clone Pro — ai-bridge migration tests
 *
 * The bridge was refactored (Stage 3G.3) from three hand-rolled
 * HTTP clients to a thin adapter over `modules/ai/`. These tests
 * pin the backward-compatibility contract so callers that depend
 * on the bridge keep working:
 *
 *   - `createAIBridge(undefined)` returns a NoOpBridge.
 *   - `createAIBridge({provider: 'none', ...})` returns a NoOpBridge.
 *   - `createAIBridge({provider: 'openai' | 'anthropic' | 'google', ...})`
 *     returns a live bridge whose `.provider` matches the config.
 *   - NoOpBridge returns empty results for every method (never throws).
 *   - The capabilities shape matches what design-extractor.ts reads.
 *
 * We deliberately do NOT exercise the live provider HTTP — that's
 * covered by `modules/ai/router.test.ts` and the provider adapters
 * directly. Here we verify the bridge layer faithfully translates
 * to the new runtime.
 */
import { describe, it, expect } from 'vitest'
import { createAIBridge, AIBridgeError } from './ai-bridge.js'

describe('createAIBridge — factory dispatch', () => {
  it('returns a NoOpBridge when config is undefined', () => {
    const bridge = createAIBridge(undefined)
    expect(bridge.provider).toBe('none')
    expect(bridge.capabilities.layoutAnalysis).toBe(false)
  })

  it('returns a NoOpBridge when provider is "none"', () => {
    const bridge = createAIBridge({ provider: 'none', apiKey: '' })
    expect(bridge.provider).toBe('none')
    expect(bridge.capabilities.sectionDetection).toBe(false)
  })

  it('returns a live bridge for openai', () => {
    const bridge = createAIBridge({ provider: 'openai', apiKey: 'sk-test' })
    expect(bridge.provider).toBe('openai')
    expect(bridge.capabilities.layoutAnalysis).toBe(true)
    expect(bridge.capabilities.imageAltText).toBe(true)
    expect(bridge.capabilities.contentRewriting).toBe(true)
    expect(bridge.capabilities.seoOptimization).toBe(true)
    expect(bridge.capabilities.sectionDetection).toBe(true)
  })

  it('returns a live bridge for anthropic', () => {
    const bridge = createAIBridge({ provider: 'anthropic', apiKey: 'sk-ant-test' })
    expect(bridge.provider).toBe('anthropic')
    expect(bridge.capabilities.layoutAnalysis).toBe(true)
  })

  it('returns a live bridge for google', () => {
    const bridge = createAIBridge({ provider: 'google', apiKey: 'AIzaTest' })
    expect(bridge.provider).toBe('google')
    expect(bridge.capabilities.layoutAnalysis).toBe(true)
  })
})

describe('NoOpBridge — behaviour under all six bridge methods', () => {
  const noop = createAIBridge(undefined)

  it('analyzeLayout returns empty analysis, never throws', async () => {
    const result = await noop.analyzeLayout('', '')
    expect(result.sections).toEqual([])
    expect(result.confidence).toBe(0)
    expect(result.designNotes).toBe('')
    expect(result.suggestedSections).toEqual([])
  })

  it('analyzeContent returns empty analysis', async () => {
    const result = await noop.analyzeContent('<html></html>', 'https://example.com')
    expect(result.targetAudience).toBe('')
    expect(result.brandVoice).toBe('')
    expect(result.valueProps).toEqual([])
    expect(result.suggestions).toEqual([])
  })

  it('generateAltText returns empty string', async () => {
    const alt = await noop.generateAltText('https://img.example/cat.jpg')
    expect(alt).toBe('')
  })

  it('suggestSections returns empty list', async () => {
    const sections = await noop.suggestSections('<html></html>')
    expect(sections).toEqual([])
  })

  it('rewriteContent passes through untouched', async () => {
    const original = 'The original product description.'
    const out = await noop.rewriteContent(original, { tone: 'professional' })
    expect(out).toBe(original)
  })

  it('generateSeoMeta returns pass-through with fallback title', async () => {
    const meta = await noop.generateSeoMeta('Home Page', 'Body content')
    expect(meta.title).toBe('Home Page')
    expect(meta.ogTitle).toBe('Home Page')
    expect(meta.description).toBe('')
    expect(meta.keywords).toEqual([])
  })
})

describe('AIBridgeError', () => {
  it('is a named Error subclass', () => {
    const err = new AIBridgeError('oops')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AIBridgeError')
    expect(err.message).toBe('oops')
  })
})

describe('RouterBackedBridge — HTTP error translation', () => {
  // We exercise the live bridge by pointing it at an unreachable
  // base URL. Any network error from the underlying provider should
  // surface as an `AIBridgeError` (wrapped `AIError`), never as a
  // raw `TypeError`/`fetch failed`.

  // Providers live at ports we know nothing listens on. The provider
  // layer converts any network failure to `AIError('unknown' | 'transient', ...)`;
  // the bridge catches `AIError` and wraps to `AIBridgeError`.
  const UNREACHABLE = 'http://127.0.0.1:1' // reserved/unbound port

  it('wraps provider network failures in AIBridgeError for OpenAI', async () => {
    const bridge = createAIBridge({
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: UNREACHABLE,
    })
    await expect(
      bridge.analyzeContent('<html></html>', 'https://example.com'),
    ).rejects.toBeInstanceOf(AIBridgeError)
  }, 10_000)

  it('wraps provider network failures in AIBridgeError for Anthropic', async () => {
    const bridge = createAIBridge({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: UNREACHABLE,
    })
    await expect(
      bridge.analyzeContent('<html></html>', 'https://example.com'),
    ).rejects.toBeInstanceOf(AIBridgeError)
  }, 10_000)

  it('wraps provider network failures in AIBridgeError for Google', async () => {
    const bridge = createAIBridge({
      provider: 'google',
      apiKey: 'AIzaTest',
      baseUrl: UNREACHABLE,
    })
    await expect(
      bridge.analyzeContent('<html></html>', 'https://example.com'),
    ).rejects.toBeInstanceOf(AIBridgeError)
  }, 10_000)
})
