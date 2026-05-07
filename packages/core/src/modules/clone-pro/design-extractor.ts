/**
 * Clone Pro — Design Extractor
 *
 * Extracts design tokens (colors, fonts, layout) from a website's
 * HTML + CSS. Works in two modes:
 *
 *   1. Rule-based (no AI) — regex parsing of CSS custom properties,
 *      inline styles, Google Fonts links, and structural patterns.
 *      Always available, fast, ~70% accuracy.
 *
 *   2. AI-enhanced — combines rule-based extraction with AI analysis
 *      of screenshots for higher accuracy layout detection.
 *      Requires user's AI API key.
 *
 * This module extends the existing themes/cloner.ts with richer
 * extraction (layout, sections, style classification) and AI support.
 */

import {
  extractColorPalette,
  extractFontConfig,
  extractSectionHints,
  type ColorPalette,
  type FontConfig,
  type SectionHint,
} from '../themes/cloner.js'
import type {
  ExtractedDesign,
  DetectedSection,
  DesignStyle,
} from './types.js'
import type { AIBridge } from './ai-bridge.js'

// ---------------------------------------------------------------------------
// Main Extractor
// ---------------------------------------------------------------------------

export interface DesignExtractorInput {
  readonly html: string
  readonly css?: string
  readonly url: string
  readonly screenshotBase64?: string
  readonly ai?: AIBridge
}

/**
 * Extract a complete design profile from a website's HTML/CSS.
 * Combines rule-based parsing with optional AI analysis.
 */
export async function extractDesign(input: DesignExtractorInput): Promise<ExtractedDesign> {
  const { html, css = '', url } = input
  const combinedCss = css + extractInlineStyles(html)

  // ── Rule-based extraction (always runs) ────────────────────────
  const palette = extractColorPalette(combinedCss)
  const fonts = extractFontConfig(combinedCss)
  const sectionHints = extractSectionHints(html)
  const googleFonts = extractGoogleFontsUrls(html)
  const layout = extractLayoutInfo(html, combinedCss)
  const style = classifyDesignStyle(palette, fonts, layout)

  // ── Convert section hints to DetectedSection ───────────────────
  let sections: DetectedSection[] = sectionHints.map((hint, i) => ({
    type: hint.type,
    position: i,
    estimatedHeight: 'auto',
    classes: [],
  }))

  // ── AI-enhanced extraction (when available) ────────────────────
  if (input.ai?.capabilities.sectionDetection && input.screenshotBase64) {
    try {
      const aiLayout = await input.ai.analyzeLayout(input.screenshotBase64, html)
      if (aiLayout.sections.length > 0 && aiLayout.confidence > 40) {
        // Merge AI sections with rule-based (AI takes precedence)
        sections = aiLayout.sections.map((s, i) => ({
          type: s.type,
          position: i,
          estimatedHeight: 'auto',
          classes: [],
          aiDescription: s.description,
        }))
      }
    } catch {
      // AI failure is non-fatal — keep rule-based results
    }
  } else if (input.ai?.capabilities.sectionDetection) {
    try {
      const aiSections = await input.ai.suggestSections(html)
      if (aiSections.length > 0) {
        sections = aiSections
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    palette: {
      primary: palette.primary,
      secondary: palette.secondary,
      accent: palette.primary, // Derive from primary if not available
      background: palette.background,
      surface: palette.surface,
      text: palette.text,
      textMuted: palette.text_muted,
      border: palette.border,
      success: palette.success,
      error: palette.error,
      warning: '#f59e0b', // Default amber
    },
    typography: {
      headingFamily: fonts.heading_family,
      bodyFamily: fonts.body_family,
      headingWeight: fonts.heading_weight,
      bodyWeight: fonts.body_weight,
      baseSize: fonts.base_size,
      lineHeight: fonts.line_height,
      googleFontsUrls: googleFonts,
    },
    layout,
    sections,
    style,
  }
}

// ---------------------------------------------------------------------------
// Google Fonts Extractor
// ---------------------------------------------------------------------------

function extractGoogleFontsUrls(html: string): string[] {
  const urls: string[] = []
  const regex = /href="(https:\/\/fonts\.googleapis\.com\/css2?\?[^"]+)"/gi
  let match
  while ((match = regex.exec(html)) !== null) {
    urls.push(match[1])
  }
  return urls
}

// ---------------------------------------------------------------------------
// Inline Styles Extractor
// ---------------------------------------------------------------------------

function extractInlineStyles(html: string): string {
  const styles: string[] = []
  const styleTagRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let match
  while ((match = styleTagRegex.exec(html)) !== null) {
    styles.push(match[1])
  }
  return styles.join('\n')
}

// ---------------------------------------------------------------------------
// Layout Extractor
// ---------------------------------------------------------------------------

interface LayoutInfo {
  maxWidth: string
  containerPadding: string
  sectionGap: string
  gridColumns: number
  hasAnnouncement: boolean
  hasStickyHeader: boolean
  hasHero: boolean
  hasMegaMenu: boolean
  footerColumns: number
}

function extractLayoutInfo(html: string, css: string): LayoutInfo {
  const lowerHtml = html.toLowerCase()
  const lowerCss = css.toLowerCase()

  // Max width detection
  let maxWidth = '1200px'
  const maxWidthMatch = lowerCss.match(/max-width:\s*(\d+(?:px|rem|em))/)
  if (maxWidthMatch) maxWidth = maxWidthMatch[1]

  // Container padding
  let containerPadding = '1rem'
  const paddingMatch = lowerCss.match(/\.container[^{]*\{[^}]*padding[^:]*:\s*([^;]+)/)
  if (paddingMatch) containerPadding = paddingMatch[1].trim()

  // Section gap
  let sectionGap = '2rem'
  const gapMatch = lowerCss.match(/(?:gap|margin-(?:top|bottom)):\s*(\d+(?:px|rem|em))/)
  if (gapMatch) sectionGap = gapMatch[1]

  // Grid columns detection
  let gridColumns = 4
  const gridMatch = lowerCss.match(/grid-template-columns:\s*repeat\((\d+)/)
  if (gridMatch) gridColumns = parseInt(gridMatch[1], 10)

  // Feature detection
  const hasAnnouncement = /announcement|marquee|top-bar|topbar/.test(lowerHtml)
  const hasStickyHeader = /position:\s*sticky|position:\s*fixed/.test(lowerCss) &&
    /header|nav/.test(lowerHtml)
  const hasHero = /hero|banner|slideshow|carousel/.test(lowerHtml)
  const hasMegaMenu = /mega-menu|megamenu|dropdown.*dropdown/.test(lowerHtml)

  // Footer columns
  let footerColumns = 4
  const footerMatch = lowerHtml.match(/<footer[\s\S]*?<\/footer>/i)
  if (footerMatch) {
    const colCount = (footerMatch[0].match(/<div|<section|<ul/gi) || []).length
    footerColumns = Math.min(Math.max(Math.round(colCount / 2), 1), 6)
  }

  return {
    maxWidth,
    containerPadding,
    sectionGap,
    gridColumns,
    hasAnnouncement,
    hasStickyHeader,
    hasHero,
    hasMegaMenu,
    footerColumns,
  }
}

// ---------------------------------------------------------------------------
// Design Style Classifier
// ---------------------------------------------------------------------------

function classifyDesignStyle(
  palette: ColorPalette,
  fonts: FontConfig,
  layout: LayoutInfo,
): DesignStyle {
  const bg = palette.background.toLowerCase()
  const primary = palette.primary.toLowerCase()
  const fontFamily = (fonts.heading_family + fonts.body_family).toLowerCase()

  // Dark background → could be luxury, modern, or brutalist
  const isDarkBg = isColorDark(bg)
  // Serif fonts → classic or editorial
  const hasSerif = /serif|georgia|times|playfair|merriweather|lora/i.test(fontFamily)
  // Mono fonts → brutalist or industrial
  const hasMono = /mono|courier|fira\s*code|jetbrains/i.test(fontFamily)
  // Rounded/playful fonts
  const hasRounded = /rounded|comic|fredoka|bubblegum|patrick/i.test(fontFamily)
  // High-contrast colors
  const highContrast = isDarkBg && !isColorDark(primary)

  if (hasMono) return 'brutalist'
  if (hasRounded) return 'playful'
  if (hasSerif && isDarkBg) return 'luxury'
  if (hasSerif) return 'editorial'
  if (isDarkBg && highContrast) return 'modern'
  if (isDarkBg) return 'industrial'
  if (/earth|brown|green|olive|sage|terracotta/i.test(primary)) return 'organic'
  if (/retro|vintage|nostalg/i.test(fontFamily)) return 'retro'
  if (layout.hasHero && !layout.hasAnnouncement) return 'minimal'

  return 'modern' // Default
}

function isColorDark(hex: string): boolean {
  const cleaned = hex.replace('#', '')
  if (cleaned.length < 6) return false
  const r = parseInt(cleaned.substring(0, 2), 16)
  const g = parseInt(cleaned.substring(2, 4), 16)
  const b = parseInt(cleaned.substring(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance < 0.5
}
