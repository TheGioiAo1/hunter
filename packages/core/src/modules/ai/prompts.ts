/**
 * Gbox Platform — AI prompt builders (Stage 3G.2)
 *
 * Pure functions that turn narrow TypeScript inputs into
 * Anthropic Messages API request payloads. They are the
 * deterministic / unit-testable floor of the AI Expert system
 * described in `docs/superpowers/specs/2026-04-08-storefront-masterplan.md`
 * §7 (Module F: AI Expert System).
 *
 * What lives here:
 *
 *   • `buildProductDescriptionPrompt`   — Content Expert #1
 *   • `buildSeoMetaPrompt`              — Content Expert #2
 *   • `buildThemeClonePrompt`           — Technical Expert #16 / Module G
 *   • `buildAnalyticsInsightPrompt`     — Business Expert #11 / #8
 *
 * What does NOT live here:
 *
 *   • HTTP. We return a JSON-shaped request object, not a fetch
 *     call. The admin-API entrypoint binds `fetch` + API key.
 *   • Retries, streaming, rate limiting. Entrypoint concerns.
 *   • Response parsing. The caller owns the response parse + UI
 *     glue because different surfaces (product editor vs theme
 *     clone preview) want different things out of the same call.
 *
 * Why "build a request object" instead of "call fetch"?
 *
 *   Pure functions are the only thing we can test without
 *   standing up a mock Anthropic server. Pinning the exact system
 *   prompt text, the exact max_tokens, and the exact user-turn
 *   wrapping is what makes the AI pipeline reproducible — if a
 *   future change drifts a guardrail, the test turns red before
 *   the prompt ships.
 *
 * Prompt-injection posture:
 *
 *   Merchant input is ALWAYS wrapped in an XML-style tag inside
 *   the user turn (`<product_title>…</product_title>`), never
 *   concatenated straight into the system prompt. The system
 *   prompt is the only place we set behavioural rules, and it
 *   never echoes merchant content.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Pinned Claude model. Documented in the masterplan (Module F
 * §7.1 diagram). Callers can override downstream by rewriting
 * `.model` before sending, but every test in this repo pins this
 * value so a silent model swap is caught at review time.
 */
export const AI_MODEL = 'claude-sonnet-4-20250514'

/**
 * Maximum merchant-supplied characters allowed into a single
 * prompt field. Anything longer is truncated with a trailing
 * `…[truncated]` marker so the model knows the content was clipped.
 *
 * 24_000 characters ≈ 6_000 tokens at English/UTF-8 rates. That
 * leaves headroom for the system prompt, the boilerplate, and the
 * model's own reply inside the 200k context window without ever
 * getting close to the cap.
 */
export const MAX_MERCHANT_INPUT_CHARS = 24_000

const TRUNCATION_MARKER = '…[truncated]'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * A single message in Anthropic's Messages API. We only ever build
 * `user` turns — the `assistant` side comes back over the wire.
 */
export interface PromptMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * The shape of an Anthropic Messages API request. Intentionally a
 * subset of what the real endpoint accepts — every field is
 * required by the builder, and the caller can add optional fields
 * (stream, metadata, stop_sequences) later without breaking type
 * consumers.
 */
export interface AiPromptRequest {
  model: string
  system: string
  messages: PromptMessage[]
  max_tokens: number
  temperature: number
}

// ---------------------------------------------------------------------------
// Product description
// ---------------------------------------------------------------------------

export interface ProductDescriptionPromptInput {
  /** Human-facing product title. Required. */
  productTitle: string
  /** Category (e.g. "Accessories", "Shoes"). */
  category: string
  /** Optional SEO / feature keywords to lean into. */
  keywords: string[]
  /**
   * Tonal hint. Free-form string; we forward it verbatim so the
   * caller can A/B-test wording without a new release.
   */
  tone: string
  /**
   * BCP-47 locale the generated copy should be written in. The
   * AI is told to respect this — do NOT rely on the merchant's
   * dashboard language, pass it explicitly.
   */
  locale: string
}

export function buildProductDescriptionPrompt(
  input: ProductDescriptionPromptInput,
): AiPromptRequest {
  const title = truncateForPrompt(input.productTitle, MAX_MERCHANT_INPUT_CHARS)
  const category = truncateForPrompt(input.category, 200)
  const tone = truncateForPrompt(input.tone, 100)
  const keywords = Array.isArray(input.keywords)
    ? input.keywords.map((k) => truncateForPrompt(k, 100)).filter(Boolean)
    : []
  const locale = normaliseLocale(input.locale)

  const system =
    `You are Gbox Content Expert — an e-commerce copywriter.\n` +
    `Target locale: ${locale}. Write ALL output in this language.\n` +
    `Do not invent product facts, materials, sizes, or prices that the ` +
    `merchant did not supply. When unsure, use neutral, benefit-led ` +
    `language grounded in the title and category.\n` +
    `Return exactly three description variants separated by a line of ` +
    `"---", each 60-120 words, SEO-friendly, and keyword-integrated.\n` +
    `Do not output markdown headings, emojis, or calls to the merchant ` +
    `— just the three descriptions.`

  const userParts = [
    `<product_title>${title}</product_title>`,
    `<category>${category}</category>`,
    `<keywords>${keywords.join(', ')}</keywords>`,
    `<tone>${tone}</tone>`,
  ]

  return {
    model: AI_MODEL,
    system,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    max_tokens: 900,
    temperature: 0.7,
  }
}

// ---------------------------------------------------------------------------
// SEO meta
// ---------------------------------------------------------------------------

export interface SeoMetaPromptInput {
  pageTitle: string
  pageBodySummary: string
  targetKeywords: string[]
  locale: string
}

export function buildSeoMetaPrompt(input: SeoMetaPromptInput): AiPromptRequest {
  const title = truncateForPrompt(input.pageTitle, 400)
  const summary = truncateForPrompt(input.pageBodySummary, 4_000)
  const keywords = Array.isArray(input.targetKeywords)
    ? input.targetKeywords.map((k) => truncateForPrompt(k, 100)).filter(Boolean)
    : []
  const locale = normaliseLocale(input.locale)

  const system =
    `You are Gbox Content Expert — an SEO specialist.\n` +
    `Target locale: ${locale}. Write ALL output in this language.\n` +
    `Respond with valid JSON matching exactly this schema:\n` +
    `{\n` +
    `  "title": string,            // 50-60 chars, includes primary keyword\n` +
    `  "meta_description": string, // 140-160 chars, benefit-led CTA\n` +
    `  "slug": string,             // kebab-case, ASCII only, max 60 chars\n` +
    `  "keywords": string[]        // 3-8 SEO keywords\n` +
    `}\n` +
    `Do not include markdown fences, commentary, or extra fields. ` +
    `Do not invent facts not present in the page body summary.`

  const userParts = [
    `<page_title>${title}</page_title>`,
    `<page_body_summary>\n${summary}\n</page_body_summary>`,
    `<target_keywords>${keywords.join(', ')}</target_keywords>`,
  ]

  return {
    model: AI_MODEL,
    system,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    max_tokens: 400,
    temperature: 0.3,
  }
}

// ---------------------------------------------------------------------------
// Theme clone
// ---------------------------------------------------------------------------

export interface ThemeClonePromptInput {
  /** Source URL the merchant pasted in the cloner form. */
  sourceUrl: string
  /** HTML snippet — typically the `<head>` + hero section only. */
  htmlSnippet: string
  /** Compiled + minified CSS (or a rule subset). */
  cssSnippet: string
}

export function buildThemeClonePrompt(
  input: ThemeClonePromptInput,
): AiPromptRequest {
  const sourceUrl = truncateForPrompt(input.sourceUrl, 500)
  const html = truncateForPrompt(input.htmlSnippet, MAX_MERCHANT_INPUT_CHARS)
  const css = truncateForPrompt(input.cssSnippet, MAX_MERCHANT_INPUT_CHARS)

  const system =
    `You are Gbox Technical Expert — a theme design analyst.\n` +
    `Analyse the supplied HTML/CSS and extract the design tokens.\n` +
    `Respond with valid JSON matching exactly this schema:\n` +
    `{\n` +
    `  "ColorPalette": {\n` +
    `    "primary": "#RRGGBB", "secondary": "#RRGGBB",\n` +
    `    "background": "#RRGGBB", "surface": "#RRGGBB",\n` +
    `    "text": "#RRGGBB", "text_muted": "#RRGGBB",\n` +
    `    "border": "#RRGGBB",\n` +
    `    "success": "#RRGGBB", "error": "#RRGGBB"\n` +
    `  },\n` +
    `  "FontConfig": {\n` +
    `    "heading_family": string, "body_family": string,\n` +
    `    "heading_weight": string, "body_weight": string,\n` +
    `    "base_size": string, "line_height": string\n` +
    `  },\n` +
    `  "layout_notes": string[],\n` +
    `  "warnings": string[]\n` +
    `}\n` +
    `Do not copy content, images, or trademarked logos — only the ` +
    `design tokens (colours, fonts, spacing). Do not include markdown ` +
    `fences or commentary.`

  const userParts = [
    `<source_url>${sourceUrl}</source_url>`,
    `<html_snippet>\n${html}\n</html_snippet>`,
    `<css_snippet>\n${css}\n</css_snippet>`,
  ]

  return {
    model: AI_MODEL,
    system,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    max_tokens: 1024,
    temperature: 0.2,
  }
}

// ---------------------------------------------------------------------------
// Analytics insight
// ---------------------------------------------------------------------------

export interface AnalyticsMetric {
  label: string
  value: string | number
}

export interface AnalyticsInsightPromptInput {
  question: string
  metrics: AnalyticsMetric[]
  locale: string
}

export function buildAnalyticsInsightPrompt(
  input: AnalyticsInsightPromptInput,
): AiPromptRequest {
  const question = truncateForPrompt(input.question, 2_000)
  const metrics = Array.isArray(input.metrics) ? input.metrics : []
  const locale = normaliseLocale(input.locale)

  const system =
    `You are Gbox Business Expert — an e-commerce analyst.\n` +
    `Target locale: ${locale}. Write ALL output in this language.\n` +
    `Do not invent metrics beyond those provided. Cite the metric ` +
    `labels verbatim when you reference them. Keep the response under ` +
    `150 words and end with a single concrete next-step recommendation.`

  const metricXml = metrics
    .map((m) => {
      const label = truncateForPrompt(m.label, 80)
      const value = truncateForPrompt(String(m.value), 200)
      return `  <metric label="${label}">${value}</metric>`
    })
    .join('\n')

  const metricsBlock =
    metrics.length === 0
      ? `<metrics></metrics>`
      : `<metrics>\n${metricXml}\n</metrics>`

  const userParts = [
    `<question>${question}</question>`,
    metricsBlock,
  ]

  return {
    model: AI_MODEL,
    system,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    max_tokens: 500,
    temperature: 0.4,
  }
}

// ---------------------------------------------------------------------------
// Product tag suggestions (Phase 10 PR1 — Content Expert add-on)
// ---------------------------------------------------------------------------

export interface ProductTagsPromptInput {
  productTitle: string
  productDescription: string
  category: string
  locale: string
  /** Cap on suggestions returned. Default 8. */
  maxTags?: number
}

export function buildProductTagsPrompt(
  input: ProductTagsPromptInput,
): AiPromptRequest {
  const title = truncateForPrompt(input.productTitle, 400)
  const desc = truncateForPrompt(input.productDescription, 4_000)
  const category = truncateForPrompt(input.category, 200)
  const locale = normaliseLocale(input.locale)
  const max = Math.min(Math.max(Math.floor(input.maxTags ?? 8), 3), 20)

  const system =
    `You are Gbox Content Expert — an e-commerce merchandiser.\n` +
    `Target locale: ${locale}. Write ALL tag labels in this language.\n` +
    `Suggest ${max} product tags a shopper would actually type into a ` +
    `search box. Respond with valid JSON matching exactly this schema:\n` +
    `{\n` +
    `  "tags": string[]    // ${max} tags, each 1-3 words, lower-case, no emojis\n` +
    `}\n` +
    `Do not include markdown fences, commentary, or extra fields. ` +
    `Do not invent facts not present in the title/description.`

  const userParts = [
    `<product_title>${title}</product_title>`,
    `<product_description>\n${desc}\n</product_description>`,
    `<category>${category}</category>`,
  ]

  return {
    model: AI_MODEL,
    system,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    max_tokens: 300,
    temperature: 0.3,
  }
}

// ---------------------------------------------------------------------------
// Campaign content suggestion (Phase 10 PR1 — Marketing Expert)
// ---------------------------------------------------------------------------

export interface CampaignSuggestionPromptInput {
  shopName: string
  campaignGoal: string
  /** e.g. "all_subscribers", "repeat_customers", "abandoned_carts" */
  segmentLabel: string
  /** Optional incentive hint. "10% off", "free shipping", etc. */
  incentive?: string
  locale: string
}

export function buildCampaignSuggestionPrompt(
  input: CampaignSuggestionPromptInput,
): AiPromptRequest {
  const shopName = truncateForPrompt(input.shopName, 200)
  const goal = truncateForPrompt(input.campaignGoal, 2_000)
  const segment = truncateForPrompt(input.segmentLabel, 100)
  const incentive = truncateForPrompt(input.incentive ?? '', 200)
  const locale = normaliseLocale(input.locale)

  const system =
    `You are Gbox Marketing Expert — an email campaign copywriter.\n` +
    `Target locale: ${locale}. Write ALL output in this language.\n` +
    `Shop name: ${shopName}. Audience: ${segment}. Goal: ${goal}.\n` +
    `Respond with valid JSON matching exactly this schema:\n` +
    `{\n` +
    `  "subject_lines": string[],      // 3 subject lines, 30-60 chars each\n` +
    `  "preview_text": string,         // 80-140 chars preheader\n` +
    `  "body_html": string,            // 200-400 word HTML body (use <p>, <strong>, <a>)\n` +
    `  "cta_label": string,            // 3-5 word CTA button text\n` +
    `  "recommended_send_time": string // e.g. "Tuesday 10:00 local"\n` +
    `}\n` +
    `Do not include markdown fences or commentary. Do not invent product ` +
    `names, prices, or dates. Use the provided incentive verbatim when mentioned.`

  const userParts = [
    `<shop_name>${shopName}</shop_name>`,
    `<audience_segment>${segment}</audience_segment>`,
    `<campaign_goal>${goal}</campaign_goal>`,
    `<incentive>${incentive}</incentive>`,
  ]

  return {
    model: AI_MODEL,
    system,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    max_tokens: 1200,
    temperature: 0.6,
  }
}

// ---------------------------------------------------------------------------
// Email subject line brainstorm (Phase 10 PR1)
// ---------------------------------------------------------------------------

export interface EmailSubjectPromptInput {
  emailPurpose: string
  audience: string
  locale: string
  count?: number
}

export function buildEmailSubjectPrompt(
  input: EmailSubjectPromptInput,
): AiPromptRequest {
  const purpose = truncateForPrompt(input.emailPurpose, 1_000)
  const audience = truncateForPrompt(input.audience, 200)
  const locale = normaliseLocale(input.locale)
  const count = Math.min(Math.max(Math.floor(input.count ?? 5), 3), 10)

  const system =
    `You are Gbox Marketing Expert — a subject-line specialist.\n` +
    `Target locale: ${locale}. Write ALL subject lines in this language.\n` +
    `Generate ${count} subject lines for the email described below. ` +
    `Vary the tone: one urgent, one benefit-led, one curiosity-led, ` +
    `the rest your call. Each line 30-60 chars, no emojis in output.\n` +
    `Respond with valid JSON matching exactly this schema:\n` +
    `{\n` +
    `  "subjects": string[]    // ${count} lines, 30-60 chars each\n` +
    `}\n` +
    `Do not include markdown fences or commentary.`

  const userParts = [
    `<email_purpose>${purpose}</email_purpose>`,
    `<audience>${audience}</audience>`,
  ]

  return {
    model: AI_MODEL,
    system,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    max_tokens: 400,
    temperature: 0.7,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clip a merchant-supplied string to `max` characters. Returns an
 * empty string for non-string input (number, null, undefined) so
 * the downstream builders never crash on a bad shape.
 *
 * When the string is clipped, the truncation marker is appended so
 * the model knows the content was cut — that prevents it from
 * confidently claiming the ending of a document it never saw.
 */
export function truncateForPrompt(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  if (value.length <= max) return value
  return value.slice(0, max) + TRUNCATION_MARKER
}

function normaliseLocale(locale: unknown): string {
  if (typeof locale !== 'string' || locale.length === 0) return 'en'
  // Keep only BCP-47-safe chars; strip anything weird a merchant
  // might paste in.
  return locale.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20) || 'en'
}
