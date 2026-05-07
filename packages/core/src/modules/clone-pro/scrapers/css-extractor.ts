/**
 * Clone Pro — Full CSS/Design Extractor
 *
 * Enhanced CSS extraction that goes beyond basic color/font detection.
 * Captures the complete visual identity of a website:
 *
 * - Color palette (via themes/cloner.ts)
 * - Typography + Google Fonts URLs
 * - Layout system (max-width, grid, spacing)
 * - Button styles (primary, secondary)
 * - Product card styles
 * - CSS custom properties (all --var: value pairs)
 * - Critical above-the-fold CSS
 *
 * Extends the existing design-extractor.ts with component-level extraction.
 */

import * as cheerio from 'cheerio'
import { safeFetch } from '../../clone-shopify/safe-fetch.js'
import {
  extractColorPalette,
  extractFontConfig,
  type ColorPalette,
  type FontConfig,
} from '../../themes/cloner.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ButtonStyle {
  readonly background: string
  readonly color: string
  readonly border: string
  readonly borderRadius: string
  readonly padding: string
  readonly fontSize: string
  readonly fontWeight: string
  readonly textTransform: string
}

export interface CardStyle {
  readonly background: string
  readonly border: string
  readonly borderRadius: string
  readonly boxShadow: string
  readonly padding: string
}

export interface ExtractedCSS {
  // Colors
  readonly palette: ColorPalette
  // Typography
  readonly fonts: FontConfig
  readonly google_fonts_urls: string[]
  // Layout
  readonly max_width: string
  readonly grid_columns: number
  readonly spacing_unit: string
  readonly border_radius: string
  // Components
  readonly button_styles: { primary: ButtonStyle; secondary: ButtonStyle }
  readonly card_styles: CardStyle
  // Custom properties
  readonly css_variables: Record<string, string>
  // Raw
  readonly critical_css: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CSS_FILES = 10
const CSS_FETCH_TIMEOUT = 15_000
const CSS_FETCH_MAX_BYTES = 2 * 1024 * 1024 // 2 MB

const DEFAULT_BUTTON: ButtonStyle = {
  background: '#000000',
  color: '#ffffff',
  border: 'none',
  borderRadius: '4px',
  padding: '12px 24px',
  fontSize: '14px',
  fontWeight: '600',
  textTransform: 'none',
}

const DEFAULT_CARD: CardStyle = {
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  boxShadow: 'none',
  padding: '16px',
}

// ---------------------------------------------------------------------------
// CSS file fetching
// ---------------------------------------------------------------------------

function extractCssLinkUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = []
  const re = /<link[^>]+rel\s*=\s*["']stylesheet["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const hrefMatch = m[0].match(/href\s*=\s*["']([^"']+)["']/i)
    if (hrefMatch?.[1]) {
      try {
        urls.push(new URL(hrefMatch[1], baseUrl).href)
      } catch { /* skip malformed */ }
    }
  }
  // Also check <link> with type="text/css"
  const re2 = /<link[^>]+type\s*=\s*["']text\/css["'][^>]*>/gi
  while ((m = re2.exec(html)) !== null) {
    const hrefMatch = m[0].match(/href\s*=\s*["']([^"']+)["']/i)
    if (hrefMatch?.[1]) {
      try {
        const url = new URL(hrefMatch[1], baseUrl).href
        if (!urls.includes(url)) urls.push(url)
      } catch { /* skip */ }
    }
  }
  return urls
}

function extractInlineStyles(html: string): string {
  const parts: string[] = []
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    parts.push(m[1])
  }
  return parts.join('\n')
}

async function fetchCssFiles(urls: string[]): Promise<string> {
  const results = await Promise.allSettled(
    urls.slice(0, MAX_CSS_FILES).map(async (url) => {
      const res = await safeFetch(url, {
        timeoutMs: CSS_FETCH_TIMEOUT,
        maxBytes: CSS_FETCH_MAX_BYTES,
        maxRedirects: 3,
      })
      return res.statusCode === 200 ? res.body.toString('utf-8') : ''
    }),
  )
  return results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
    .map((r) => r.value)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Google Fonts extraction
// ---------------------------------------------------------------------------

function extractGoogleFontsUrls(html: string, css: string): string[] {
  const urls = new Set<string>()

  // From HTML <link> tags
  const htmlRe = /href="(https:\/\/fonts\.googleapis\.com\/css2?\?[^"]+)"/gi
  let m: RegExpExecArray | null
  while ((m = htmlRe.exec(html)) !== null) {
    urls.add(m[1])
  }

  // From CSS @import
  const cssRe = /@import\s+url\(['"]?(https:\/\/fonts\.googleapis\.com\/css2?\?[^'")\s]+)['"]?\)/gi
  while ((m = cssRe.exec(css)) !== null) {
    urls.add(m[1])
  }

  return [...urls]
}

// ---------------------------------------------------------------------------
// CSS custom properties extraction
// ---------------------------------------------------------------------------

function extractCssVariables(css: string): Record<string, string> {
  const vars: Record<string, string> = {}
  // Strip CSS comments first
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /(--[\w-]+)\s*:\s*([^;}{]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[1].trim()
    const value = m[2].trim()
    if (value && !value.includes('var(')) {
      vars[name] = value
    }
  }
  return vars
}

// ---------------------------------------------------------------------------
// Layout detection
// ---------------------------------------------------------------------------

function extractMaxWidth(css: string): string {
  // Look for container max-width
  const patterns = [
    /\.container[^{]*\{[^}]*max-width:\s*([^;]+)/i,
    /\.wrapper[^{]*\{[^}]*max-width:\s*([^;]+)/i,
    /\.page-width[^{]*\{[^}]*max-width:\s*([^;]+)/i,
    /main[^{]*\{[^}]*max-width:\s*([^;]+)/i,
    /--page-width:\s*([^;]+)/i,
    /--container-width:\s*([^;]+)/i,
  ]
  for (const re of patterns) {
    const m = css.match(re)
    if (m) return m[1].trim()
  }
  return '1200px'
}

function extractGridColumns(css: string): number {
  const m = css.match(/grid-template-columns:\s*repeat\((\d+)/i)
  if (m) return parseInt(m[1], 10)
  // Detect from product grid class patterns
  const colMatch = css.match(/\.(?:product-grid|grid|products)[^{]*\{[^}]*grid-template-columns:\s*([^;]+)/i)
  if (colMatch) {
    const count = (colMatch[1].match(/\d+fr/g) || []).length
    if (count > 0) return count
  }
  return 4
}

function extractSpacingUnit(css: string): string {
  // Check CSS custom properties first
  const varMatch = css.match(/--(?:spacing|space|gap)(?:-base|-unit)?:\s*([^;]+)/i)
  if (varMatch) return varMatch[1].trim()
  // Common gap values
  const gapMatch = css.match(/(?:gap|row-gap):\s*(\d+(?:px|rem|em))/i)
  if (gapMatch) return gapMatch[1]
  return '1rem'
}

function extractDominantBorderRadius(css: string): string {
  // Check CSS custom properties
  const varMatch = css.match(/--(?:border-radius|radius)(?:-base)?:\s*([^;]+)/i)
  if (varMatch) return varMatch[1].trim()
  // Count occurrences of different border-radius values
  const counts = new Map<string, number>()
  const re = /border-radius:\s*(\d+(?:px|rem|em))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    const val = m[1]
    counts.set(val, (counts.get(val) || 0) + 1)
  }
  if (counts.size === 0) return '4px'
  // Return most common
  let best = '4px'
  let bestCount = 0
  for (const [val, count] of counts) {
    if (count > bestCount) {
      best = val
      bestCount = count
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Button style extraction
// ---------------------------------------------------------------------------

const BUTTON_SELECTORS_PRIMARY = [
  /\.btn-primary[^{]*\{([^}]+)\}/i,
  /\.button--primary[^{]*\{([^}]+)\}/i,
  /button\.primary[^{]*\{([^}]+)\}/i,
  /\.btn[^{-][^{]*\{([^}]+)\}/i,
  /button[^{]*\{([^}]+)\}/i,
  /\[type="submit"\][^{]*\{([^}]+)\}/i,
  /\.add-to-cart[^{]*\{([^}]+)\}/i,
  /\.shopify-payment-button[^{]*\{([^}]+)\}/i,
]

const BUTTON_SELECTORS_SECONDARY = [
  /\.btn-secondary[^{]*\{([^}]+)\}/i,
  /\.button--secondary[^{]*\{([^}]+)\}/i,
  /button\.secondary[^{]*\{([^}]+)\}/i,
  /\.btn-outline[^{]*\{([^}]+)\}/i,
  /\.button--outline[^{]*\{([^}]+)\}/i,
]

function extractButtonStyle(css: string, selectors: RegExp[]): ButtonStyle {
  for (const re of selectors) {
    const m = css.match(re)
    if (!m) continue
    const block = m[1]
    return {
      background: extractProp(block, 'background-color') || extractProp(block, 'background') || DEFAULT_BUTTON.background,
      color: extractProp(block, 'color') || DEFAULT_BUTTON.color,
      border: extractProp(block, 'border') || DEFAULT_BUTTON.border,
      borderRadius: extractProp(block, 'border-radius') || DEFAULT_BUTTON.borderRadius,
      padding: extractProp(block, 'padding') || DEFAULT_BUTTON.padding,
      fontSize: extractProp(block, 'font-size') || DEFAULT_BUTTON.fontSize,
      fontWeight: extractProp(block, 'font-weight') || DEFAULT_BUTTON.fontWeight,
      textTransform: extractProp(block, 'text-transform') || DEFAULT_BUTTON.textTransform,
    }
  }
  return { ...DEFAULT_BUTTON }
}

// ---------------------------------------------------------------------------
// Card/product card style extraction
// ---------------------------------------------------------------------------

const CARD_SELECTORS = [
  /\.product-card[^{]*\{([^}]+)\}/i,
  /\.card[^{-][^{]*\{([^}]+)\}/i,
  /\.grid-product[^{]*\{([^}]+)\}/i,
  /\.product-item[^{]*\{([^}]+)\}/i,
]

function extractCardStyle(css: string): CardStyle {
  for (const re of CARD_SELECTORS) {
    const m = css.match(re)
    if (!m) continue
    const block = m[1]
    return {
      background: extractProp(block, 'background-color') || extractProp(block, 'background') || DEFAULT_CARD.background,
      border: extractProp(block, 'border') || DEFAULT_CARD.border,
      borderRadius: extractProp(block, 'border-radius') || DEFAULT_CARD.borderRadius,
      boxShadow: extractProp(block, 'box-shadow') || DEFAULT_CARD.boxShadow,
      padding: extractProp(block, 'padding') || DEFAULT_CARD.padding,
    }
  }
  return { ...DEFAULT_CARD }
}

// ---------------------------------------------------------------------------
// CSS property extraction helper
// ---------------------------------------------------------------------------

function extractProp(cssBlock: string, property: string): string | null {
  const re = new RegExp(`${property}\\s*:\\s*([^;]+)`, 'i')
  const m = cssBlock.match(re)
  return m ? m[1].trim() : null
}

// ---------------------------------------------------------------------------
// Critical CSS generation
// ---------------------------------------------------------------------------

function generateCriticalCss(
  palette: ColorPalette,
  fonts: FontConfig,
  googleFonts: string[],
  cssVars: Record<string, string>,
  maxWidth: string,
  borderRadius: string,
  buttonPrimary: ButtonStyle,
  cardStyle: CardStyle,
): string {
  const lines: string[] = []

  // Google Fonts imports
  for (const url of googleFonts) {
    lines.push(`@import url('${url}');`)
  }

  // CSS custom properties (from source site)
  if (Object.keys(cssVars).length > 0) {
    lines.push(':root {')
    for (const [name, value] of Object.entries(cssVars).slice(0, 100)) {
      lines.push(`  ${name}: ${value};`)
    }
    lines.push('}')
  }

  // Gbox theme variables (normalized from extraction)
  lines.push(`
:root {
  --color-primary: ${palette.primary};
  --color-secondary: ${palette.secondary};
  --color-background: ${palette.background};
  --color-surface: ${palette.surface};
  --color-text: ${palette.text};
  --color-text-muted: ${palette.text_muted};
  --color-border: ${palette.border};
  --color-success: ${palette.success};
  --color-error: ${palette.error};
  --font-heading: ${fonts.heading_family};
  --font-body: ${fonts.body_family};
  --font-heading-weight: ${fonts.heading_weight};
  --font-body-weight: ${fonts.body_weight};
  --font-size-base: ${fonts.base_size};
  --line-height-base: ${fonts.line_height};
  --page-width: ${maxWidth};
  --border-radius: ${borderRadius};
}

body {
  font-family: ${fonts.body_family};
  font-weight: ${fonts.body_weight};
  font-size: ${fonts.base_size};
  line-height: ${fonts.line_height};
  color: ${palette.text};
  background-color: ${palette.background};
}

h1, h2, h3, h4, h5, h6 {
  font-family: ${fonts.heading_family};
  font-weight: ${fonts.heading_weight};
}

.btn, button, [type="submit"] {
  background-color: ${buttonPrimary.background};
  color: ${buttonPrimary.color};
  border: ${buttonPrimary.border};
  border-radius: ${buttonPrimary.borderRadius};
  padding: ${buttonPrimary.padding};
  font-size: ${buttonPrimary.fontSize};
  font-weight: ${buttonPrimary.fontWeight};
  text-transform: ${buttonPrimary.textTransform};
  cursor: pointer;
}

.product-card {
  background: ${cardStyle.background};
  border: ${cardStyle.border};
  border-radius: ${cardStyle.borderRadius};
  box-shadow: ${cardStyle.boxShadow};
  padding: ${cardStyle.padding};
}
`.trim())

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract comprehensive CSS/design data from a website.
 *
 * @param html - Full page HTML string
 * @param baseUrl - Website base URL (for resolving CSS file URLs)
 * @returns ExtractedCSS with palette, fonts, layout, components, variables, and critical CSS
 */
export async function extractFullCSS(html: string, baseUrl: string): Promise<ExtractedCSS> {
  // 1. Gather all CSS
  const inlineCss = extractInlineStyles(html)
  const cssLinks = extractCssLinkUrls(html, baseUrl)
  const externalCss = await fetchCssFiles(cssLinks)
  const allCss = inlineCss + '\n' + externalCss

  // 2. Extract components
  const palette = extractColorPalette(allCss)
  const fonts = extractFontConfig(allCss)
  const googleFonts = extractGoogleFontsUrls(html, allCss)
  const cssVars = extractCssVariables(allCss)
  const maxWidth = extractMaxWidth(allCss)
  const gridColumns = extractGridColumns(allCss)
  const spacingUnit = extractSpacingUnit(allCss)
  const borderRadius = extractDominantBorderRadius(allCss)
  const buttonPrimary = extractButtonStyle(allCss, BUTTON_SELECTORS_PRIMARY)
  const buttonSecondary = extractButtonStyle(allCss, BUTTON_SELECTORS_SECONDARY)
  const cardStyle = extractCardStyle(allCss)

  // 3. Generate critical CSS
  const criticalCss = generateCriticalCss(
    palette, fonts, googleFonts, cssVars,
    maxWidth, borderRadius, buttonPrimary, cardStyle,
  )

  return {
    palette,
    fonts,
    google_fonts_urls: googleFonts,
    max_width: maxWidth,
    grid_columns: gridColumns,
    spacing_unit: spacingUnit,
    border_radius: borderRadius,
    button_styles: { primary: buttonPrimary, secondary: buttonSecondary },
    card_styles: cardStyle,
    css_variables: cssVars,
    critical_css: criticalCss,
  }
}
