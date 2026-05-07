/**
 * Clone Pro — AI Bridge (BYOK — Bring Your Own Key)
 *
 * Unified interface for AI providers used by the clone-pro pipeline.
 * Historically this file owned its own HTTP code per provider; that
 * implementation lived here for ~4 months and taught us that "one
 * provider per class" duplicates too much logic (auth, retry, streaming,
 * cost, fallback).
 *
 * As of Stage 3G.3, the bridge is a **thin translation layer** over
 * the shared AI runtime at `modules/ai/`:
 *
 *    createAIBridge(config)  ─►  RouterBackedBridge  ─►  AIRouter
 *                                                         │
 *                                                         ▼
 *                                   providers/{anthropic, openai, google}
 *
 * What this buys us (for free):
 *
 *   - Automatic fallback across providers the shop has configured.
 *     Currently clone-pro only wires one provider, but when the
 *     pipeline migrates to resolving credentials from `shop_ai_config`,
 *     a flaky Anthropic call will silently fall through to Google.
 *
 *   - Streaming. The legacy bridge was JSON-only. The router exposes
 *     a `chatStream` that Sprint B.5 will plumb into the admin UI.
 *
 *   - Cost tracking. Every call the router handles produces a
 *     `CostRecord`; clone-pro doesn't consume that yet, but when
 *     `settings > AI usage` ships it's already wired.
 *
 *   - One place to maintain the SSE + request shape for each provider.
 *
 * What we deliberately kept:
 *
 *   - The `AIBridge` public interface. Callers (pipeline.ts,
 *     design-extractor.ts) are unchanged. Legacy `AIProviderConfig`
 *     still works; we map it to the new `ProviderCredential` shape
 *     internally.
 *
 *   - The rule-based fallback (`NoOpBridge`) — there are real code
 *     paths that pass `provider: 'none'` and expect graceful empty
 *     returns, never a thrown error.
 *
 *   - The JSON-extraction parsers (`parseLayoutAnalysis`, …) — they
 *     tolerate markdown fences and surrounding prose, which the
 *     underlying models still sometimes emit.
 *
 * Security:
 *
 *   - API keys are passed through to the router verbatim; they are
 *     decrypted upstream by `modules/ai/config-service.ts` and never
 *     logged. No caching in this file.
 */

import type {
  AIProviderConfig,
  AICapabilities,
  AILayoutAnalysis,
  AIContentAnalysis,
  DetectedSection,
} from './types.js'
import {
  AIError,
  AIRouter,
  DEFAULT_MODELS,
  nullRecorder,
  type ChatMessage,
  type ChatContentBlock,
  type CredentialResolver,
  type ProviderCredential,
} from '../ai/index.js'

// ---------------------------------------------------------------------------
// AI Bridge Interface (unchanged — backward compatible)
// ---------------------------------------------------------------------------

export interface AIBridge {
  readonly provider: AIProviderConfig['provider']
  readonly capabilities: AICapabilities
  analyzeLayout(screenshotBase64: string, html?: string): Promise<AILayoutAnalysis>
  analyzeContent(html: string, url: string): Promise<AIContentAnalysis>
  generateAltText(imageUrl: string, context?: string): Promise<string>
  suggestSections(html: string): Promise<DetectedSection[]>
  rewriteContent(content: string, options: ContentRewriteOptions): Promise<string>
  generateSeoMeta(pageTitle: string, pageContent: string): Promise<SeoMeta>
}

export interface ContentRewriteOptions {
  readonly locale?: string
  readonly tone?: 'professional' | 'casual' | 'luxury' | 'playful'
  readonly purpose?: string
}

export interface SeoMeta {
  readonly title: string
  readonly description: string
  readonly keywords: readonly string[]
  readonly ogTitle: string
  readonly ogDescription: string
}

// ---------------------------------------------------------------------------
// Factory (unchanged signature)
// ---------------------------------------------------------------------------

/**
 * Create an AI bridge instance from provider config.
 * Returns a NoOpBridge when provider is 'none' or config is missing.
 *
 * The concrete bridge for live providers is `RouterBackedBridge`, a
 * thin adapter over `AIRouter`. It gives clone-pro automatic fallback
 * and cost tracking without changing any caller code.
 */
export function createAIBridge(config?: AIProviderConfig): AIBridge {
  if (!config || config.provider === 'none') {
    return new NoOpBridge()
  }

  // Legacy `AIProvider` union (`openai|anthropic|google|none`) is a
  // subset of the runtime's `AIProviderId`. Groq is not reachable via
  // this legacy factory — new call sites should build an `AIRouter`
  // directly to opt into Groq.
  if (config.provider === 'openai' || config.provider === 'anthropic' || config.provider === 'google') {
    return new RouterBackedBridge(config)
  }

  return new NoOpBridge()
}

// ---------------------------------------------------------------------------
// No-Op Bridge (Rule-based fallback — no AI needed)
// ---------------------------------------------------------------------------

class NoOpBridge implements AIBridge {
  readonly provider = 'none' as const
  readonly capabilities: AICapabilities = {
    layoutAnalysis: false,
    imageAltText: false,
    contentRewriting: false,
    seoOptimization: false,
    sectionDetection: false,
  }

  async analyzeLayout(): Promise<AILayoutAnalysis> {
    return { sections: [], designNotes: '', suggestedSections: [], confidence: 0 }
  }

  async analyzeContent(): Promise<AIContentAnalysis> {
    return { targetAudience: '', brandVoice: '', valueProps: [], suggestions: [] }
  }

  async generateAltText(): Promise<string> {
    return ''
  }

  async suggestSections(): Promise<DetectedSection[]> {
    return []
  }

  async rewriteContent(content: string): Promise<string> {
    return content // Pass-through
  }

  async generateSeoMeta(pageTitle: string): Promise<SeoMeta> {
    return {
      title: pageTitle,
      description: '',
      keywords: [],
      ogTitle: pageTitle,
      ogDescription: '',
    }
  }
}

// ---------------------------------------------------------------------------
// Router-backed Bridge (one class for all live providers)
// ---------------------------------------------------------------------------

/**
 * Resolver that always returns the single credential clone-pro was
 * given. The router's fallback chain is a no-op in this mode — there's
 * only one key — but the machinery around it (cost tracking, budget
 * check, SSE) still applies.
 */
class SingleCredentialResolver implements CredentialResolver {
  constructor(private readonly credential: ProviderCredential) {}
  async resolve(): Promise<readonly ProviderCredential[]> {
    return [this.credential]
  }
}

/**
 * The live AI bridge. Delegates every call to `AIRouter` while keeping
 * the shop-facing `AIBridge` contract.
 *
 * Notes
 * -----
 *
 *   - `shopId` is hard-coded to `"clone-pro"` for now. When clone-pro
 *     is reworked to read credentials from `shop_ai_config` directly,
 *     it will carry the real shop id and the bridge can drop this
 *     adapter altogether.
 *
 *   - Router errors (`AIError`) are wrapped back into `AIBridgeError`
 *     so existing `try { … } catch (e: AIBridgeError)` blocks in the
 *     pipeline keep working.
 */
class RouterBackedBridge implements AIBridge {
  readonly provider: AIProviderConfig['provider']
  readonly capabilities: AICapabilities = {
    layoutAnalysis: true,
    imageAltText: true,
    contentRewriting: true,
    seoOptimization: true,
    sectionDetection: true,
  }

  private readonly router: AIRouter
  private readonly defaultMaxTokens: number
  private readonly temperature: number

  constructor(config: AIProviderConfig) {
    this.provider = config.provider
    this.defaultMaxTokens = config.maxTokens ?? 2000
    this.temperature = config.temperature ?? 0.3

    const credential: ProviderCredential = {
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODELS[config.provider],
      baseUrl: config.baseUrl,
    }

    this.router = new AIRouter({
      resolver: new SingleCredentialResolver(credential),
      recorder: nullRecorder,
    })
  }

  // ── Internal ───────────────────────────────────────────────────

  private async chat(
    messages: ChatMessage[],
    options?: { maxTokens?: number; purpose?: string },
  ): Promise<string> {
    try {
      const response = await this.router.chat({
        shopId: 'clone-pro',
        purpose: options?.purpose ?? 'clone',
        request: {
          messages,
          maxTokens: options?.maxTokens ?? this.defaultMaxTokens,
          temperature: this.temperature,
        },
      })
      return response.text
    } catch (err) {
      if (err instanceof AIError) {
        throw new AIBridgeError(
          `${err.provider ?? this.provider} ${err.kind}: ${err.message}`,
        )
      }
      throw err
    }
  }

  // ── Public bridge methods ──────────────────────────────────────

  async analyzeLayout(screenshotBase64: string, html?: string): Promise<AILayoutAnalysis> {
    const prompt = buildLayoutPrompt(html)
    const imageBlock: ChatContentBlock = {
      type: 'image',
      mediaType: 'image/png',
      base64: screenshotBase64,
    }
    const text = await this.chat(
      [
        {
          role: 'user',
          content: [imageBlock, { type: 'text', text: prompt }],
        },
      ],
      { maxTokens: 3000, purpose: 'clone_layout' },
    )
    return parseLayoutAnalysis(text)
  }

  async analyzeContent(html: string, url: string): Promise<AIContentAnalysis> {
    const prompt = buildContentPrompt(html, url)
    const text = await this.chat(
      [{ role: 'user', content: prompt }],
      { purpose: 'clone_content_analysis' },
    )
    return parseContentAnalysis(text)
  }

  async generateAltText(imageUrl: string, context?: string): Promise<string> {
    const ctx = context?.trim()
    const prompt = ctx
      ? `Generate a concise, descriptive alt text (max 125 chars) for this image: ${imageUrl}. Context: this image is associated with "${ctx}". Return only the alt text, no quotes or explanation.`
      : `Generate a concise, descriptive alt text (max 125 chars) for this image: ${imageUrl}. Return only the alt text, no quotes or explanation.`
    const text = await this.chat(
      [{ role: 'user', content: prompt }],
      { maxTokens: 100, purpose: 'clone_alt_text' },
    )
    return text.trim()
  }

  async suggestSections(html: string): Promise<DetectedSection[]> {
    const prompt = buildSectionDetectionPrompt(html)
    const text = await this.chat(
      [{ role: 'user', content: prompt }],
      { purpose: 'clone_sections' },
    )
    return parseSectionSuggestions(text)
  }

  async rewriteContent(content: string, options: ContentRewriteOptions): Promise<string> {
    const prompt = buildRewritePrompt(content, options)
    const text = await this.chat(
      [{ role: 'user', content: prompt }],
      { purpose: 'clone_rewrite' },
    )
    return text.trim()
  }

  async generateSeoMeta(pageTitle: string, pageContent: string): Promise<SeoMeta> {
    const prompt = buildSeoPrompt(pageTitle, pageContent)
    const text = await this.chat(
      [{ role: 'user', content: prompt }],
      { purpose: 'clone_seo' },
    )
    return parseSeoMeta(text, pageTitle)
  }
}

// ---------------------------------------------------------------------------
// Shared Prompt Builders (unchanged from pre-migration — they work well
// enough today; Sprint B will move these into `modules/ai/prompts.ts`
// once the XML streaming protocol is wired in).
// ---------------------------------------------------------------------------

function buildLayoutPrompt(html?: string): string {
  return `Analyze this website screenshot and identify all distinct sections/blocks on the page.

For each section, provide:
- type: one of [header, announcement, hero, featured-products, collection-list, testimonials, newsletter, image-with-text, rich-text, video, gallery, faq, contact, footer, blog-posts, brand-logos, countdown, map, custom]
- description: brief description of the section content
- position: order from top (0-based)

Also provide:
- designNotes: overall design style assessment (2-3 sentences)
- suggestedSections: which Gbox template sections would best recreate this design

Respond in valid JSON format:
{
  "sections": [{"type": "...", "description": "...", "position": 0}],
  "designNotes": "...",
  "suggestedSections": ["header", "hero", ...],
  "confidence": 85
}
${html ? `\nHTML structure hint (first 2000 chars):\n${html.substring(0, 2000)}` : ''}`
}

function buildContentPrompt(html: string, url: string): string {
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 3000)

  return `Analyze this website content from ${url} and provide:
1. targetAudience: Who is this site targeting? (1 sentence)
2. brandVoice: What tone/voice does the brand use? (1-2 words)
3. valueProps: List 3-5 key value propositions
4. suggestions: 2-3 improvement suggestions

Content: "${textContent}"

Respond in valid JSON:
{"targetAudience":"...","brandVoice":"...","valueProps":["..."],"suggestions":["..."]}`
}

function buildSectionDetectionPrompt(html: string): string {
  return `Analyze this HTML and identify the page sections in order of appearance.
For each section, provide: type, position (0-based), estimatedHeight, key CSS classes.

Section types: header, announcement, hero, featured-products, collection-list,
testimonials, newsletter, image-with-text, rich-text, video, gallery, faq,
contact, footer, blog-posts, brand-logos, countdown, map, custom

HTML (first 5000 chars):
${html.substring(0, 5000)}

Respond as JSON array:
[{"type":"header","position":0,"estimatedHeight":"80px","classes":["site-header"]}]`
}

function buildRewritePrompt(content: string, options: ContentRewriteOptions): string {
  let prompt = `Rewrite the following content`
  if (options.locale) prompt += ` in ${options.locale}`
  if (options.tone) prompt += ` with a ${options.tone} tone`
  if (options.purpose) prompt += ` for ${options.purpose}`
  prompt += `. Keep the meaning but make it original and engaging. Return only the rewritten text.\n\n${content}`
  return prompt
}

function buildSeoPrompt(pageTitle: string, pageContent: string): string {
  return `Generate SEO meta tags for a page titled "${pageTitle}".

Page content (first 1000 chars): "${pageContent.substring(0, 1000)}"

Respond in JSON:
{"title":"...max 60 chars","description":"...max 155 chars","keywords":["..."],"ogTitle":"...","ogDescription":"...max 200 chars"}`
}

// ---------------------------------------------------------------------------
// Response Parsers (fault-tolerant — unchanged)
// ---------------------------------------------------------------------------

function parseLayoutAnalysis(text: string): AILayoutAnalysis {
  try {
    const json = extractJson(text)
    if (json) {
      return {
        sections: Array.isArray(json.sections) ? json.sections : [],
        designNotes: json.designNotes ?? '',
        suggestedSections: Array.isArray(json.suggestedSections) ? json.suggestedSections : [],
        confidence: typeof json.confidence === 'number' ? json.confidence : 50,
      }
    }
  } catch { /* fall through */ }
  return { sections: [], designNotes: text.substring(0, 200), suggestedSections: [], confidence: 0 }
}

function parseContentAnalysis(text: string): AIContentAnalysis {
  try {
    const json = extractJson(text)
    if (json) {
      return {
        targetAudience: json.targetAudience ?? '',
        brandVoice: json.brandVoice ?? '',
        valueProps: Array.isArray(json.valueProps) ? json.valueProps : [],
        suggestions: Array.isArray(json.suggestions) ? json.suggestions : [],
      }
    }
  } catch { /* fall through */ }
  return { targetAudience: '', brandVoice: '', valueProps: [], suggestions: [] }
}

function parseSectionSuggestions(text: string): DetectedSection[] {
  try {
    const json = extractJson(text)
    if (Array.isArray(json)) {
      return json.map((s: any, i: number) => ({
        type: s.type ?? 'custom',
        position: s.position ?? i,
        estimatedHeight: s.estimatedHeight ?? 'auto',
        classes: Array.isArray(s.classes) ? s.classes : [],
        aiDescription: s.description,
      }))
    }
  } catch { /* fall through */ }
  return []
}

function parseSeoMeta(text: string, fallbackTitle: string): SeoMeta {
  try {
    const json = extractJson(text)
    if (json) {
      return {
        title: json.title ?? fallbackTitle,
        description: json.description ?? '',
        keywords: Array.isArray(json.keywords) ? json.keywords : [],
        ogTitle: json.ogTitle ?? json.title ?? fallbackTitle,
        ogDescription: json.ogDescription ?? json.description ?? '',
      }
    }
  } catch { /* fall through */ }
  return { title: fallbackTitle, description: '', keywords: [], ogTitle: fallbackTitle, ogDescription: '' }
}

/**
 * Extract JSON from an AI response that may contain markdown fences
 * or surrounding text.
 */
function extractJson(text: string): any {
  // Try direct parse first
  try {
    return JSON.parse(text)
  } catch { /* continue */ }

  // Try extracting from ```json ... ``` blocks
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim())
    } catch { /* continue */ }
  }

  // Try finding first { or [ and parsing from there
  const firstBrace = text.indexOf('{')
  const firstBracket = text.indexOf('[')
  const start = Math.min(
    firstBrace >= 0 ? firstBrace : Infinity,
    firstBracket >= 0 ? firstBracket : Infinity,
  )
  if (start < Infinity) {
    const isArray = text[start] === '['
    const end = isArray ? text.lastIndexOf(']') : text.lastIndexOf('}')
    if (end > start) {
      try {
        return JSON.parse(text.substring(start, end + 1))
      } catch { /* give up */ }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class AIBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIBridgeError'
  }
}
