/**
 * Gbox Platform — Theme cloner extractors (Stage 3G.3)
 *
 * Pure analysis helpers that turn a merchant-supplied HTML + CSS
 * string into a `CloneReport` — the offline / deterministic layer
 * that sits underneath Module G in the storefront masterplan
 * (§8 Theme Cloner).
 *
 * The live crawl ("fetch nike.com over HTTP, render it in a
 * headless browser, snapshot the DOM") is entrypoint glue that
 * belongs in the admin API — NOT here. This module is a pure
 * transform:
 *
 *   (html: string, css: string) → { palette, fonts, sections, … }
 *
 * Which means every extractor can be unit-tested with a fixed
 * string and no network / no browser / no Claude.
 *
 * Design rules:
 *
 *   1. **Tolerant parser.** Merchants paste real-world markup.
 *      We use regexes instead of a full DOM parser so a missing
 *      closing tag can't crash the cloner — every extractor
 *      degrades gracefully to the default palette / font config.
 *   2. **Deterministic output.** The same input MUST yield the
 *      same output byte-for-byte so the "similarity score" is
 *      reviewable at PR time and the tests stay stable.
 *   3. **No external deps.** `cloner.ts` stays in the pure core
 *      layer — it can't import `happy-dom`, `cheerio`, or
 *      `postcss` because those bloat the Workers bundle (Stage 6).
 *   4. **Security.** Nothing here evaluates the HTML/CSS; we only
 *      read it. No `new Function()`, no `eval`, no style
 *      application.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColorPalette {
  primary: string
  secondary: string
  background: string
  surface: string
  text: string
  text_muted: string
  border: string
  success: string
  error: string
}

export interface FontConfig {
  heading_family: string
  body_family: string
  heading_weight: string
  body_weight: string
  base_size: string
  line_height: string
}

export interface SectionHint {
  /**
   * Canonical section type. Matches the Gbox section catalogue
   * (`header`, `nav`, `hero`, `main`, `footer`, `featured-products`,
   * `testimonials`, `newsletter`, …). Unknown classes are not
   * emitted — we only report section types the rest of the
   * platform knows how to map.
   */
  type: string
  /**
   * Zero-based index of the source character range where the hint
   * was found. Useful for telling "the first hero" from "the third
   * hero" when a page has multiple.
   */
  offset: number
}

export interface CloneReport {
  palette: ColorPalette
  fonts: FontConfig
  sections: SectionHint[]
  /**
   * Similarity score out of 100. Currently derived from "how many
   * of the canonical things did we recognise?" — explicitly a
   * heuristic, not a fidelity metric. Pinned by tests so a future
   * refactor can't silently rescale it.
   */
  score: number
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Fallback palette used when the CSS supplies nothing recognisable.
 * Loosely modelled on Gbox's own brand for a calm starting point.
 */
const DEFAULT_PALETTE: ColorPalette = {
  primary: '#2563eb',
  secondary: '#0ea5e9',
  background: '#ffffff',
  surface: '#f8fafc',
  text: '#111827',
  text_muted: '#6b7280',
  border: '#e5e7eb',
  success: '#10b981',
  error: '#ef4444',
}

export const DEFAULT_FONT_CONFIG: FontConfig = {
  heading_family: `'Inter', system-ui, sans-serif`,
  body_family: `'Inter', system-ui, sans-serif`,
  heading_weight: '700',
  body_weight: '400',
  base_size: '16px',
  line_height: '1.5',
}

/**
 * Class / tag names that map to canonical Gbox section types.
 * Extend cautiously — every entry here becomes a public surface
 * area for the cloner.
 */
const SECTION_CLASS_MAP: Record<string, string> = {
  hero: 'hero',
  'hero-banner': 'hero',
  banner: 'hero',
  'featured-products': 'featured-products',
  'product-grid': 'featured-products',
  'product-list': 'featured-products',
  testimonials: 'testimonials',
  reviews: 'testimonials',
  newsletter: 'newsletter',
  subscribe: 'newsletter',
  cta: 'cta',
  faq: 'faq',
  'image-with-text': 'image-with-text',
  collection: 'collection-list',
  'collection-list': 'collection-list',
}

const SEMANTIC_TAGS: Array<{ tag: string; type: string }> = [
  { tag: 'header', type: 'header' },
  { tag: 'nav', type: 'nav' },
  { tag: 'main', type: 'main' },
  { tag: 'footer', type: 'footer' },
]

// ---------------------------------------------------------------------------
// extractColorPalette
// ---------------------------------------------------------------------------

export function extractColorPalette(css: string): ColorPalette {
  const palette: ColorPalette = { ...DEFAULT_PALETTE }
  if (typeof css !== 'string' || css.length === 0) return palette

  const cleaned = stripComments(css)

  // 1. Pull named CSS custom properties first. They carry the most
  //    semantic information.
  const customProps = new Map<string, string>()
  const customPropRe = /--([a-zA-Z0-9-_]+)\s*:\s*([^;}{]+)/g
  let m: RegExpExecArray | null
  while ((m = customPropRe.exec(cleaned)) !== null) {
    const name = m[1]!.toLowerCase()
    const raw = m[2]!.trim()
    const hex = normaliseColor(raw)
    if (hex) customProps.set(name, hex)
  }

  applyCustomProp(palette, 'primary', customProps, [
    'color-primary',
    'primary',
    'brand',
    'brand-primary',
  ])
  applyCustomProp(palette, 'secondary', customProps, [
    'color-secondary',
    'secondary',
    'brand-secondary',
    'accent',
  ])
  applyCustomProp(palette, 'background', customProps, [
    'color-bg',
    'color-background',
    'bg',
    'background',
  ])
  applyCustomProp(palette, 'surface', customProps, [
    'color-surface',
    'surface',
    'card',
    'color-card',
  ])
  applyCustomProp(palette, 'text', customProps, [
    'color-text',
    'text',
    'foreground',
    'fg',
  ])
  applyCustomProp(palette, 'text_muted', customProps, [
    'color-text-muted',
    'text-muted',
    'muted',
    'color-muted',
  ])
  applyCustomProp(palette, 'border', customProps, [
    'color-border',
    'border',
    'divider',
    'color-divider',
  ])
  applyCustomProp(palette, 'success', customProps, [
    'color-success',
    'success',
    'ok',
  ])
  applyCustomProp(palette, 'error', customProps, [
    'color-error',
    'error',
    'danger',
    'warning-critical',
  ])

  // 2. Fall back to body / h1 declarations when custom props are
  //    missing for a key.
  if (!customProps.has('color-primary') && !customProps.has('primary')) {
    const bg = findFirstDeclaration(cleaned, 'background')
    if (bg) palette.primary = bg
  }

  if (!customProps.has('color-text') && !customProps.has('text')) {
    const color = findFirstDeclaration(cleaned, 'color')
    if (color) palette.text = color
  }

  return palette
}

function applyCustomProp(
  palette: ColorPalette,
  key: keyof ColorPalette,
  props: Map<string, string>,
  candidates: string[],
): void {
  for (const name of candidates) {
    const value = props.get(name)
    if (value) {
      palette[key] = value
      return
    }
  }
}

// ---------------------------------------------------------------------------
// extractFontConfig
// ---------------------------------------------------------------------------

export function extractFontConfig(css: string): FontConfig {
  const cfg: FontConfig = { ...DEFAULT_FONT_CONFIG }
  if (typeof css !== 'string' || css.length === 0) return cfg

  const cleaned = stripComments(css)

  const bodyBlock = findSelectorBlock(cleaned, /\bbody\b/)
  const headingBlock =
    findSelectorBlock(cleaned, /\bh1(?:\s*,|\s*\{)/) ??
    findSelectorBlock(cleaned, /\bh1\s*,\s*h2/)

  const bodyFamily = bodyBlock ? matchDeclaration(bodyBlock, 'font-family') : null
  const bodySize = bodyBlock ? matchDeclaration(bodyBlock, 'font-size') : null
  const bodyLineHeight = bodyBlock
    ? matchDeclaration(bodyBlock, 'line-height')
    : null
  const bodyWeight = bodyBlock ? matchDeclaration(bodyBlock, 'font-weight') : null

  const headingFamily = headingBlock
    ? matchDeclaration(headingBlock, 'font-family')
    : null
  const headingWeight = headingBlock
    ? matchDeclaration(headingBlock, 'font-weight')
    : null

  if (bodyFamily) cfg.body_family = normaliseFontFamily(bodyFamily)
  if (bodySize) cfg.base_size = bodySize.trim()
  if (bodyLineHeight) cfg.line_height = bodyLineHeight.trim()
  if (bodyWeight) cfg.body_weight = bodyWeight.trim()

  if (headingFamily) {
    cfg.heading_family = normaliseFontFamily(headingFamily)
  } else if (bodyFamily) {
    // When only the body defines a family, use it for headings too.
    cfg.heading_family = normaliseFontFamily(bodyFamily)
  }
  if (headingWeight) cfg.heading_weight = headingWeight.trim()

  return cfg
}

// ---------------------------------------------------------------------------
// extractSectionHints
// ---------------------------------------------------------------------------

export function extractSectionHints(html: string): SectionHint[] {
  if (typeof html !== 'string' || html.length === 0) return []

  // Strip <script> and <style> before scanning so their inner
  // text can't spoof a section landmark.
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')

  const hints: SectionHint[] = []

  // 1. Semantic tags.
  for (const { tag, type } of SEMANTIC_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(cleaned)) !== null) {
      hints.push({ type, offset: m.index })
    }
  }

  // 2. Section classes.
  const classRe = /<section\b[^>]*class\s*=\s*"([^"]+)"[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = classRe.exec(cleaned)) !== null) {
    const classNames = m[1]!.toLowerCase().split(/\s+/)
    for (const cn of classNames) {
      const canonical = SECTION_CLASS_MAP[cn]
      if (canonical) {
        hints.push({ type: canonical, offset: m.index })
      }
    }
  }

  // Sort by offset so two runs on the same input produce the same
  // ordering — important for the determinism test.
  hints.sort((a, b) => a.offset - b.offset)
  return hints
}

// ---------------------------------------------------------------------------
// buildCloneReport
// ---------------------------------------------------------------------------

export function buildCloneReport(html: string, css: string): CloneReport {
  const palette = extractColorPalette(css)
  const fonts = extractFontConfig(css)
  const sections = extractSectionHints(html)

  const warnings: string[] = []
  if (!html || html.length === 0) warnings.push('No HTML supplied — sections left empty')
  if (!css || css.length === 0) warnings.push('No CSS supplied — palette + fonts defaulted')
  if (sections.length === 0 && html.length > 0) {
    warnings.push('No recognised section landmarks found in HTML')
  }

  // Similarity score: 20 points for a non-default palette, 20 for
  // non-default fonts, 60 for found sections (capped at 6). The
  // exact shape is pinned by tests so a refactor can't drift it.
  let score = 0
  if (!sameColorPalette(palette, DEFAULT_PALETTE)) score += 20
  if (!sameFontConfig(fonts, DEFAULT_FONT_CONFIG)) score += 20
  score += Math.min(sections.length, 6) * 10
  if (score > 100) score = 100

  return { palette, fonts, sections, score, warnings }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function findFirstDeclaration(css: string, prop: string): string | null {
  const re = new RegExp(`\\b${prop}\\s*:\\s*([^;}{]+)`, 'i')
  const m = re.exec(css)
  if (!m) return null
  return normaliseColor(m[1]!.trim())
}

function findSelectorBlock(css: string, selectorRe: RegExp): string | null {
  // Find the first occurrence of the selector and return the `{…}`
  // block that follows it. Tolerant: if the block never closes we
  // return what's available up to end-of-string.
  const match = selectorRe.exec(css)
  if (!match) return null
  const start = css.indexOf('{', match.index)
  if (start === -1) return null
  const end = css.indexOf('}', start + 1)
  if (end === -1) return css.slice(start + 1)
  return css.slice(start + 1, end)
}

function matchDeclaration(block: string, prop: string): string | null {
  const re = new RegExp(`\\b${prop}\\s*:\\s*([^;}{]+)`, 'i')
  const m = re.exec(block)
  if (!m) return null
  return m[1]!.trim()
}

function normaliseFontFamily(raw: string): string {
  return raw
    .replace(/!important/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Turn a raw color literal (`#abc`, `#aabbcc`, `rgb(1,2,3)`,
 * `rgba(1,2,3,0.5)`) into a canonical `#rrggbb` lowercased string.
 * Returns `null` when the input doesn't match any known form.
 */
function normaliseColor(raw: string): string | null {
  const v = raw.trim().toLowerCase()

  // #rgb
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (shortHex) {
    return `#${shortHex[1]!}${shortHex[1]!}${shortHex[2]!}${shortHex[2]!}${shortHex[3]!}${shortHex[3]!}`
  }

  // #rrggbb
  const longHex = /^#([0-9a-f]{6})$/i.exec(v)
  if (longHex) return `#${longHex[1]!}`

  // rgb() / rgba()
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v)
  if (rgb) {
    const r = clamp255(Number(rgb[1]))
    const g = clamp255(Number(rgb[2]))
    const b = clamp255(Number(rgb[3]))
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  }

  return null
}

function clamp255(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 255) return 255
  return Math.round(n)
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0')
}

function sameColorPalette(a: ColorPalette, b: ColorPalette): boolean {
  return (
    a.primary === b.primary &&
    a.secondary === b.secondary &&
    a.background === b.background &&
    a.surface === b.surface &&
    a.text === b.text &&
    a.text_muted === b.text_muted &&
    a.border === b.border &&
    a.success === b.success &&
    a.error === b.error
  )
}

function sameFontConfig(a: FontConfig, b: FontConfig): boolean {
  return (
    a.heading_family === b.heading_family &&
    a.body_family === b.body_family &&
    a.heading_weight === b.heading_weight &&
    a.body_weight === b.body_weight &&
    a.base_size === b.base_size &&
    a.line_height === b.line_height
  )
}
