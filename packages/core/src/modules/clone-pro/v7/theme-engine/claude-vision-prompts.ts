/**
 * Clone Pro v7 — Claude vision prompt templates
 *
 * The 5 prompts that turn a folder of screenshots into a `DesignTokens`
 * object. Stage 14 calls one describe-* prompt per page (with the
 * page's screenshot attached as a vision content block), collects the
 * partial JSON outputs, then calls `consolidateTokensPrompt(partials)`
 * to merge them into a single token set.
 *
 * Why split into 5 prompts instead of one mega-prompt?
 *   - Vision call cost scales with image size; one image per call keeps
 *     each call under 1MB → fast TTFT.
 *   - Per-page prompts can ask for the fields that page actually shows
 *     (the homepage doesn't have a product card; the PDP doesn't have a
 *     hero pattern), reducing hallucination on missing fields.
 *   - Easier to iterate on prompt quality — bibliobloom smoke can show
 *     us "PDP prompt is wrong" without re-prompting for the homepage.
 *
 * Anti-Inter rules (encoded across all describe-* prompts):
 *   - "Do not default to Inter, Roboto, or Poppins."
 *   - "If the typeface is serif, predict a SPECIFIC Google Font: Cormorant
 *     Garamond, Crimson Pro, EB Garamond, Lora, Playfair Display, etc."
 *   - "If unsure, list 3 candidates in order of likelihood."
 *
 * Output discipline:
 *   - "Return ONLY valid JSON. No prose, markdown fences, or explanation."
 *   - "Use exact hex codes (#aabbcc 6-digit lowercase or uppercase)."
 *   - "Sample colors from multiple regions of the screenshot."
 */

const ANTI_GENERIC_FONTS = `
TYPOGRAPHY RULES:
- Predict a SPECIFIC Google Font name. Do NOT default to Inter, Roboto, Poppins, Helvetica, or Arial.
- Look at letterforms carefully:
  * Serif with high contrast strokes → Cormorant Garamond, Playfair Display, EB Garamond
  * Serif with bookish feel → Crimson Pro, Lora, Source Serif Pro, PT Serif
  * Geometric sans → DM Sans, Plus Jakarta Sans, Sora, Manrope (NEVER Inter unless you are certain)
  * Humanist sans → Work Sans, Public Sans, Outfit
  * Display / unique → Fraunces, Recoleta, Authentic Sans, Migra, IBM Plex Serif
  * Monospace → JetBrains Mono, IBM Plex Mono, Fira Code
- If unsure, list 3 candidates in order of likelihood and pick the most likely.
- Provide the Google Font family name exactly as it appears on fonts.google.com.
- weights: list ALL distinct weights you see used (e.g. 400, 500, 700).
`.trim()

const COLOR_RULES = `
COLOR RULES:
- Use EXACT hex codes (6-digit, e.g. #3b2f2f or #3B2F2F). No approximations.
- Sample multiple regions: hero, body text, headers, buttons, footer.
- 'primary' = brand-defining color (often button bg or accent text).
- 'secondary' = next most prominent (often surface or panel bg).
- 'accent' = pop color (CTAs, highlights). Set null if site is mono-tonal.
- 'background' = main page bg.
- 'foreground' = main body text color.
- 'muted' = secondary text / dividers. Set null if not visible.
`.trim()

const JSON_DISCIPLINE = `
OUTPUT FORMAT:
- Return ONLY a single valid JSON object.
- No preamble, no markdown fences, no commentary, no explanation.
- All keys lowercase snake_case as specified.
- Numbers as numbers (not strings).
- Hex strings as strings.
`.trim()

export function describeHomepagePrompt(): string {
  return `You are analysing the homepage screenshot of an e-commerce site to extract design tokens.

Focus on:
- fonts (primary + secondary heading/body fonts visible in hero, headings, body)
- colors (background, foreground, primary, secondary, accent, muted)
- header (height, background color, variant — e.g. 'minimal', 'editorial', 'split', 'centered')
- hero_pattern ('fullbleed-image', 'split-text-image', 'video-bg', 'editorial', 'product-grid', 'overlay')
- aesthetic_score (0-10 — how polished/distinct is the design? 7+ if the site has clear point of view)
- style_keywords (3-6 single-word descriptors, e.g. 'editorial', 'warm', 'serif-typography', 'minimal', 'maximalist')

${ANTI_GENERIC_FONTS}

${COLOR_RULES}

${JSON_DISCIPLINE}

Schema (use null for unknown fields):
{
  "fonts": {
    "primary": { "family": "...", "google_font": "...", "weights": [400, 600] },
    "secondary": { "family": "...", "google_font": "...", "weights": [400] } | null
  },
  "colors": { "primary": "#...", "secondary": "#...", "accent": "#..." | null, "background": "#...", "foreground": "#...", "muted": "#..." | null },
  "header": { "height": 80, "background": "#...", "variant": "..." },
  "hero_pattern": "...",
  "aesthetic_score": 8.4,
  "style_keywords": ["editorial", "warm"]
}`
}

export function describePdpPrompt(): string {
  return `You are analysing a Product Detail Page (PDP) screenshot. Extract component-level tokens.

Focus on:
- product image gallery (aspect_ratio: '1:1', '3/4', '4/5', '16/9' as visible)
- product_card variant (this is for collection cards, but PDP layout often hints at it: 'minimal', 'editorial', 'classic', 'overlay', 'card')
- button (border_radius, padding_x, padding_y, variant: 'pill', 'rounded', 'square', 'sharp')
- typography hierarchy (font_size for product title, price, description)
- colors used in CTAs / Add-to-Cart

${ANTI_GENERIC_FONTS}

${COLOR_RULES}

${JSON_DISCIPLINE}

Schema:
{
  "fonts": { "primary": { ... } } | partial — only what's clearly visible,
  "colors": { ... partial — only buttons / accents seen on PDP },
  "components": {
    "product_card": { "aspect_ratio": "...", "border_radius": 8, "variant": "..." },
    "button": { "border_radius": 4, "padding_x": 24, "padding_y": 12, "variant": "..." }
  }
}`
}

export function describePlpPrompt(): string {
  return `You are analysing a Product Listing Page (PLP / collection grid) screenshot. Extract grid + card tokens.

Focus on:
- grid_columns (count visible columns: 2, 3, 4)
- container_max_width (estimate in px from card width × cols)
- product_card variant — examine card style: image-only ('minimal'), image+title+price ('classic'), full editorial layout ('editorial'), hover-overlay ('overlay')
- product_card aspect_ratio
- spacing between cards (estimate base_unit and scale)

${ANTI_GENERIC_FONTS}

${COLOR_RULES}

${JSON_DISCIPLINE}

Schema:
{
  "layout": { "container_max_width": 1240, "grid_columns": 3 },
  "components": {
    "product_card": { "aspect_ratio": "3/4", "border_radius": 0, "variant": "..." }
  },
  "spacing": { "base_unit": 8, "scale": [4, 8, 16, 24, 32] }
}`
}

export function describeGlobalPrompt(): string {
  return `You are analysing global / shared screenshot pieces (header + footer + nav drawer + cart drawer if visible). Extract sitewide tokens.

Focus on:
- navigation variant ('horizontal', 'mega-menu', 'drawer', 'minimal-icons', 'centered'), placement ('top', 'side', 'bottom', 'overlay')
- spacing system (base_unit + scale array of 5-7 values you see used)
- breakpoints — observe responsive behaviour to infer mobile/tablet/desktop/wide
- footer + nav typography
- overall colors used across chrome (header bg, footer bg, nav text)

${ANTI_GENERIC_FONTS}

${COLOR_RULES}

${JSON_DISCIPLINE}

Schema:
{
  "components": {
    "navigation": { "variant": "...", "placement": "..." }
  },
  "breakpoints": { "mobile": 480, "tablet": 768, "desktop": 1024, "wide": 1440 },
  "spacing": { "base_unit": 8, "scale": [4, 8, 16, 24, 32, 48, 64] }
}`
}

/** Static registry of describe-* prompts — does NOT include consolidate (function-of-input). */
export const PROMPT_REGISTRY = {
  describe_homepage: describeHomepagePrompt,
  describe_pdp: describePdpPrompt,
  describe_plp: describePlpPrompt,
  describe_global: describeGlobalPrompt,
} as const

export interface PartialTokenInput {
  source: string
  json: unknown
}

export function consolidateTokensPrompt(partials: PartialTokenInput[]): string {
  const partialsBlock = partials
    .map((p) => `=== from ${p.source} ===\n${JSON.stringify(p.json, null, 2)}`)
    .join('\n\n')

  return `You are consolidating partial design-token extractions from multiple page screenshots into a SINGLE valid DesignTokens JSON object.

Inputs (partial JSON from per-page Claude vision passes):

${partialsBlock || '(no partials — produce best-guess tokens for an editorial e-commerce site)'}

Rules for consolidation:
- When fields conflict across pages, prefer the value from the homepage (most representative of brand).
- For 'fonts.primary': pick the most consistent family across pages. Predict a SPECIFIC Google Font (NOT Inter unless certain).
- For 'colors': merge — the union of palettes must include the primary brand colors seen across pages.
- For 'components.product_card.variant': use PDP > PLP > home (PDP shows it most clearly).
- For 'spacing.scale': union and dedupe; keep ascending order.
- For 'aesthetic_score': average of per-page scores, weighted by homepage 2x.
- For 'style_keywords': union, dedupe, max 8 items.

Required output sections (ALL MUST be present):
- fonts (primary + secondary nullable)
- colors (primary, secondary, accent nullable, background, foreground, muted nullable)
- spacing (base_unit + scale)
- breakpoints (mobile, tablet, desktop, wide)
- components (header, product_card, button, navigation each with variant)
- layout (container_max_width, grid_columns, hero_pattern)
- style_keywords (array)
- aesthetic_score (0-10)

${ANTI_GENERIC_FONTS}

${COLOR_RULES}

${JSON_DISCIPLINE}

Return ONLY the consolidated JSON. No preamble, no markdown, no explanation.`
}
