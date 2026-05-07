/**
 * Gbox Platform — AI Clone theme-spec enhancer
 * (Landing Page System Phase 2.2)
 *
 * Takes the deterministic `CloneReport` from `themes/cloner.ts`
 * plus the raw HTML/CSS the crawler captured, sends them to
 * Claude Opus 4.6, and parses the response into a fully-typed
 * `ThemeSpec`. The ThemeSpec is the intermediate representation
 * the Liquid bundle generator consumes — it's explicitly richer
 * than a CloneReport because Opus can see things the regex
 * cloner can't: typography hierarchy, layout intent, brand
 * voice, suggested section copy, recommended imagery prompts.
 *
 * Why a separate module from `themes/cloner.ts`?
 *
 *   - `cloner.ts` is pure, deterministic, and unit-tested
 *     against fixed strings. No network, no API costs, no
 *     flakiness. Ships everywhere.
 *
 *   - `theme-spec.ts` is the opposite: it calls Opus 4.6, so
 *     it pays latency + money per invocation and the output is
 *     only loosely reproducible. We want both layers to exist
 *     so the admin can preview cloner output instantly, then
 *     ask for the AI pass when the merchant clicks "Enhance
 *     with AI".
 *
 * Design notes:
 *
 *   1. **Injectable sender.** The module never imports
 *      `@anthropic-ai/sdk` directly — it takes an `AiSender`
 *      function whose signature matches `sendChat`. Tests pass
 *      a stub that returns canned JSON; production wires
 *      `sendChat` from `ai/client.ts`.
 *
 *   2. **Forgiving parser.** Opus sometimes returns Markdown
 *      fences around JSON (```json ... ```). The parser
 *      strips fences, finds the outermost `{...}`, validates
 *      shape, and fills every missing key with defaults from
 *      the CloneReport. Merchant never sees a crash because
 *      the model emitted chatty prose before its JSON.
 *
 *   3. **Bounded input.** We only send the first N KB of HTML
 *      and a curated CSS excerpt (custom props + body + h1-h6
 *      rules). Full pages are too big for the context window
 *      and most of the noise is unrelated to design anyway.
 *
 *   4. **Deterministic shape.** Every field in `ThemeSpec` has
 *      a default so the generator downstream can assume "this
 *      field always exists". No optional chains in the
 *      generator makes the template output consistent.
 *
 *   5. **Low temperature.** We default to 0.2 — high enough to
 *      let Opus make taste calls on typography and copy but
 *      low enough that the same URL + same CloneReport produce
 *      broadly similar specs run to run.
 */

import type {
  ColorPalette,
  FontConfig,
  CloneReport,
} from '../themes/cloner.js'
import { DEFAULT_FONT_CONFIG } from '../themes/cloner.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Section blueprint for the generator. `type` matches the
 * canonical Gbox section catalogue (`header`, `hero`,
 * `featured-products`, `testimonials`, `newsletter`, `cta`,
 * `faq`, `image-with-text`, `collection-list`, `footer`).
 * Unknown types from the AI are discarded during parsing.
 */
export interface ThemeSectionSpec {
  type: ThemeSectionType
  /** Title / headline copy for the section. Short. */
  heading: string
  /** Sub-headline or lede. Optional but always present as ''. */
  subheading: string
  /** One-liner CTA label, e.g. 'Shop now'. */
  ctaLabel: string
  /**
   * Optional imagery guidance for the merchant to commission /
   * upload. Plain English, e.g. "wide-angle studio shot of a
   * single running shoe on white". Always present as ''.
   */
  imageHint: string
}

export type ThemeSectionType =
  | 'header'
  | 'nav'
  | 'hero'
  | 'featured-products'
  | 'collection-list'
  | 'image-with-text'
  | 'testimonials'
  | 'newsletter'
  | 'cta'
  | 'faq'
  | 'footer'

const VALID_SECTION_TYPES: readonly ThemeSectionType[] = [
  'header',
  'nav',
  'hero',
  'featured-products',
  'collection-list',
  'image-with-text',
  'testimonials',
  'newsletter',
  'cta',
  'faq',
  'footer',
] as const

export interface ThemeBrand {
  /** Brand name as Opus understood it from the page. */
  name: string
  /** One-sentence tagline. */
  tagline: string
  /** Short paragraph describing the voice / audience. */
  voice: string
}

export interface ThemeSpec {
  /** Brand block for the storefront. */
  brand: ThemeBrand
  /** Finalised colour palette (may differ from CloneReport). */
  palette: ColorPalette
  /** Finalised type config. */
  fonts: FontConfig
  /**
   * Ordered section list. The generator emits Liquid in this
   * order on the homepage. Guaranteed non-empty after parsing
   * — if Opus returned nothing we backfill from the CloneReport
   * or a minimal default layout (header / hero / featured /
   * footer).
   */
  sections: ThemeSectionSpec[]
  /**
   * Search keywords / tags for the theme library. The admin
   * saves these alongside the theme metadata so merchants can
   * find "dark minimal fashion" etc. later. Normalised to
   * lowercase, deduped.
   */
  tags: string[]
  /**
   * Short (one or two sentence) theme description to show in
   * the library card.
   */
  description: string
}

export interface AiSenderOptions {
  systemPrompt: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  model?: string
  maxTokens?: number
  temperature?: number
}
export interface AiSenderResult {
  text: string
}
export type AiSender = (opts: AiSenderOptions) => Promise<AiSenderResult>

export interface EnhanceOptions {
  /**
   * AI sender. Production wires `sendChat` from `ai/client.ts`;
   * tests pass a stub.
   */
  sender: AiSender
  /**
   * Optional model override. Defaults to whatever the sender
   * uses (Opus 4.6 via DEFAULT_AI_MODEL).
   */
  model?: string
  /**
   * Max tokens for the response. Default 3000 — enough for a
   * full section list with copy plus tags and description.
   */
  maxTokens?: number
  /** Sampling temperature. Default 0.2. */
  temperature?: number
  /**
   * Hard cap on HTML snippet sent to Opus. Default 20 KB.
   * Everything past the cap is dropped — Opus only needs the
   * landmark tags and inline text to infer intent.
   */
  maxHtmlBytes?: number
  /**
   * Hard cap on CSS snippet sent to Opus. Default 10 KB.
   */
  maxCssBytes?: number
}

export interface EnhanceInput {
  /** The merchant-supplied entry URL (for context in the prompt). */
  entryUrl: string
  /** The pure CloneReport computed by `themes/cloner.ts`. */
  report: CloneReport
  /** Raw HTML from the crawl. */
  html: string
  /** Combined CSS from the crawl. */
  css: string
  /**
   * Optional merchant-supplied note. "Make it more playful",
   * "Target Gen-Z", "Emphasise sustainability". Gets included
   * verbatim in the user message.
   */
  merchantHint?: string
}

export interface EnhanceResult {
  spec: ThemeSpec
  /**
   * Raw response text from Opus. Stored by the orchestrator for
   * audit / debugging without having to replay the call.
   */
  raw: string
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Defaults + backfills
// ---------------------------------------------------------------------------

const DEFAULT_SECTION_ORDER: ThemeSectionType[] = [
  'header',
  'hero',
  'featured-products',
  'image-with-text',
  'testimonials',
  'newsletter',
  'footer',
]

function emptySection(type: ThemeSectionType): ThemeSectionSpec {
  return {
    type,
    heading: '',
    subheading: '',
    ctaLabel: '',
    imageHint: '',
  }
}

function defaultThemeSpec(report: CloneReport, entryUrl: string): ThemeSpec {
  return {
    brand: {
      name: hostFromUrl(entryUrl),
      tagline: '',
      voice: '',
    },
    palette: report.palette,
    fonts: report.fonts,
    sections: DEFAULT_SECTION_ORDER.map(emptySection),
    tags: [],
    description: '',
  }
}

function hostFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return 'Untitled Store'
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Gbox Theme Cloner — an expert e-commerce designer who turns a reference website into a Gbox storefront theme specification.

Your input:
  - An entry URL and the raw HTML + CSS captured from it.
  - A deterministic CloneReport with an extracted colour palette, font config, and section hints.

Your output:
  - A single JSON object matching the ThemeSpec schema below. NO prose, NO markdown fences, NO explanation outside the JSON.

ThemeSpec schema:
{
  "brand": {
    "name": string,           // Brand name inferred from the page (title, logo alt, nav)
    "tagline": string,        // Short marketing tagline, <= 10 words
    "voice": string           // 1-2 sentences describing the tone (playful, luxury, gritty, …)
  },
  "palette": {
    "primary": "#rrggbb",
    "secondary": "#rrggbb",
    "background": "#rrggbb",
    "surface": "#rrggbb",
    "text": "#rrggbb",
    "text_muted": "#rrggbb",
    "border": "#rrggbb",
    "success": "#rrggbb",
    "error": "#rrggbb"
  },
  "fonts": {
    "heading_family": string,   // CSS font-family value with fallbacks
    "body_family": string,
    "heading_weight": string,
    "body_weight": string,
    "base_size": string,        // e.g. "16px"
    "line_height": string       // e.g. "1.5"
  },
  "sections": [
    {
      "type": "header" | "nav" | "hero" | "featured-products" | "collection-list" | "image-with-text" | "testimonials" | "newsletter" | "cta" | "faq" | "footer",
      "heading": string,
      "subheading": string,
      "ctaLabel": string,
      "imageHint": string     // Plain-English image brief for the merchant
    }
    // ordered as they should appear on the homepage
  ],
  "tags": [ string ],           // 4-8 lowercase search tags, e.g. "minimalist", "sustainable", "fashion", "dark-mode"
  "description": string         // 1-2 sentence theme library description
}

Rules:
  - Start with the CloneReport palette as ground truth. Only adjust a colour if the raw CSS clearly suggests the report was wrong.
  - Section order must be realistic for the brand: header first, footer last, exactly one hero near the top.
  - Never invent URLs, product names, prices, or review quotes — write copy that could fit any storefront for that brand.
  - Every section MUST have a heading, subheading, ctaLabel, and imageHint (use an empty string "" where not applicable).
  - Output ONLY the JSON object. No \`\`\`json fences, no preamble.`

function buildUserMessage(input: EnhanceInput, maxHtml: number, maxCss: number): string {
  const trimmedHtml = trimToBytes(input.html, maxHtml)
  const trimmedCss = trimToBytes(input.css, maxCss)
  const hint = input.merchantHint?.trim()
    ? `Merchant hint: ${input.merchantHint.trim()}\n\n`
    : ''

  return (
    `${hint}Entry URL: ${input.entryUrl}\n\n` +
    `CloneReport (pure extractor):\n` +
    `${JSON.stringify(
      {
        palette: input.report.palette,
        fonts: input.report.fonts,
        sections: input.report.sections.map((s) => s.type),
        score: input.report.score,
      },
      null,
      2,
    )}\n\n` +
    `Raw HTML (trimmed to ${maxHtml} bytes):\n` +
    '```html\n' +
    trimmedHtml +
    '\n```\n\n' +
    `Raw CSS (trimmed to ${maxCss} bytes):\n` +
    '```css\n' +
    trimmedCss +
    '\n```\n\n' +
    `Return the ThemeSpec JSON now.`
  )
}

function trimToBytes(s: string, maxBytes: number): string {
  if (!s) return ''
  // Cheap approximation — JS strings are UTF-16 internally but the
  // prompt is sent as UTF-8 JSON. For Latin text 1 char ≈ 1 byte.
  // For heavily multibyte content we'd underestimate, which only
  // means we send slightly less than budget — acceptable.
  if (s.length <= maxBytes) return s
  return s.slice(0, maxBytes)
}

// ---------------------------------------------------------------------------
// enhanceThemeSpec — the public entry point
// ---------------------------------------------------------------------------

const DEFAULT_MAX_HTML_BYTES = 20_000
const DEFAULT_MAX_CSS_BYTES = 10_000
const DEFAULT_MAX_TOKENS = 3000
const DEFAULT_TEMPERATURE = 0.2

export async function enhanceThemeSpec(
  input: EnhanceInput,
  opts: EnhanceOptions,
): Promise<EnhanceResult> {
  const maxHtml = opts.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES
  const maxCss = opts.maxCssBytes ?? DEFAULT_MAX_CSS_BYTES

  const userMessage = buildUserMessage(input, maxHtml, maxCss)

  const response = await opts.sender({
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    model: opts.model,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
  })

  const parsed = parseThemeSpecResponse(response.text, input.report, input.entryUrl)

  return {
    spec: parsed.spec,
    raw: response.text,
    warnings: parsed.warnings,
  }
}

// ---------------------------------------------------------------------------
// Response parser — forgiving
// ---------------------------------------------------------------------------

interface ParseResult {
  spec: ThemeSpec
  warnings: string[]
}

export function parseThemeSpecResponse(
  raw: string,
  report: CloneReport,
  entryUrl: string,
): ParseResult {
  const warnings: string[] = []
  const fallback = defaultThemeSpec(report, entryUrl)

  const jsonText = extractJsonBlob(raw)
  if (!jsonText) {
    warnings.push('ai_no_json: response contained no JSON object')
    return { spec: fallback, warnings }
  }

  let obj: any
  try {
    obj = JSON.parse(jsonText)
  } catch (err) {
    warnings.push(
      `ai_json_parse_failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { spec: fallback, warnings }
  }

  if (!obj || typeof obj !== 'object') {
    warnings.push('ai_json_not_object')
    return { spec: fallback, warnings }
  }

  const spec: ThemeSpec = {
    brand: parseBrand(obj.brand, fallback.brand),
    palette: parsePalette(obj.palette, fallback.palette, warnings),
    fonts: parseFonts(obj.fonts, fallback.fonts, warnings),
    sections: parseSections(obj.sections, warnings),
    tags: parseTags(obj.tags),
    description: typeof obj.description === 'string' ? obj.description.trim() : '',
  }

  return { spec, warnings }
}

/**
 * Pull the outermost `{ ... }` JSON blob out of a model response.
 * Tolerates ```json fences, leading prose, trailing commentary.
 */
function extractJsonBlob(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  // Strip ```json ... ``` fences if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const pool = fenced?.[1] ?? raw
  // Find the first `{` and walk to the matching `}` with depth counting.
  const start = pool.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < pool.length; i++) {
    const ch = pool[i]!
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return pool.slice(start, i + 1)
      }
    }
  }
  return null
}

function parseBrand(raw: any, fallback: ThemeBrand): ThemeBrand {
  if (!raw || typeof raw !== 'object') return fallback
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallback.name,
    tagline: typeof raw.tagline === 'string' ? raw.tagline.trim() : '',
    voice: typeof raw.voice === 'string' ? raw.voice.trim() : '',
  }
}

function parsePalette(
  raw: any,
  fallback: ColorPalette,
  warnings: string[],
): ColorPalette {
  if (!raw || typeof raw !== 'object') {
    warnings.push('ai_palette_missing')
    return fallback
  }
  const pick = (key: keyof ColorPalette): string => {
    const v = raw[key]
    if (typeof v !== 'string') return fallback[key]
    const hex = normaliseHex(v)
    return hex ?? fallback[key]
  }
  return {
    primary: pick('primary'),
    secondary: pick('secondary'),
    background: pick('background'),
    surface: pick('surface'),
    text: pick('text'),
    text_muted: pick('text_muted'),
    border: pick('border'),
    success: pick('success'),
    error: pick('error'),
  }
}

function parseFonts(raw: any, fallback: FontConfig, warnings: string[]): FontConfig {
  if (!raw || typeof raw !== 'object') {
    warnings.push('ai_fonts_missing')
    return fallback
  }
  const pick = (key: keyof FontConfig): string => {
    const v = raw[key]
    if (typeof v !== 'string' || !v.trim()) return fallback[key]
    return v.trim()
  }
  return {
    heading_family: pick('heading_family'),
    body_family: pick('body_family'),
    heading_weight: pick('heading_weight'),
    body_weight: pick('body_weight'),
    base_size: pick('base_size'),
    line_height: pick('line_height'),
  } satisfies FontConfig
}

function parseSections(raw: any, warnings: string[]): ThemeSectionSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    warnings.push('ai_sections_missing_or_empty')
    return DEFAULT_SECTION_ORDER.map(emptySection)
  }
  const out: ThemeSectionSpec[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const type = typeof entry.type === 'string' ? entry.type.trim() : ''
    if (!VALID_SECTION_TYPES.includes(type as ThemeSectionType)) continue
    out.push({
      type: type as ThemeSectionType,
      heading: typeof entry.heading === 'string' ? entry.heading.trim() : '',
      subheading:
        typeof entry.subheading === 'string' ? entry.subheading.trim() : '',
      ctaLabel:
        typeof entry.ctaLabel === 'string' ? entry.ctaLabel.trim() : '',
      imageHint:
        typeof entry.imageHint === 'string' ? entry.imageHint.trim() : '',
    })
  }
  if (out.length === 0) {
    warnings.push('ai_sections_all_invalid')
    return DEFAULT_SECTION_ORDER.map(emptySection)
  }
  // Guarantee header first / footer last if the AI forgot them.
  const hasHeader = out.some((s) => s.type === 'header')
  const hasFooter = out.some((s) => s.type === 'footer')
  if (!hasHeader) out.unshift(emptySection('header'))
  if (!hasFooter) out.push(emptySection('footer'))
  return out
}

function parseTags(raw: any): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const norm = entry.trim().toLowerCase()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
    if (out.length >= 12) break
  }
  return out
}

function normaliseHex(raw: string): string | null {
  const v = raw.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  if (short) {
    return `#${short[1]!}${short[1]!}${short[2]!}${short[2]!}${short[3]!}${short[3]!}`
  }
  const long = /^#([0-9a-f]{6})$/.exec(v)
  if (long) return `#${long[1]!}`
  return null
}

// Re-export DEFAULT_FONT_CONFIG so downstream callers don't need two imports
// when wiring defaults.
export { DEFAULT_FONT_CONFIG }
