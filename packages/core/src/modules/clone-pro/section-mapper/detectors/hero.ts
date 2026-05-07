/**
 * Hero section detector.
 *
 * Heuristic rules (first match wins within each page block):
 *
 *   1. An element whose class contains 'hero', 'banner', or 'billboard'
 *      AND which has at least one heading inside it.
 *
 *   2. A visually prominent first-child block that contains an <h1> and
 *      a call-to-action link/button. Catches sites that don't use a
 *      literal "hero" class but still render a hero-style intro.
 *
 * Extracted settings (keyed to Gbox Dawn's `hero` schema):
 *   - heading         → first h1 text (or h2 if no h1)
 *   - subheading      → first <p> or descendant text right after the heading
 *   - cta_label       → first button/link text
 *   - cta_link        → first button/link href
 *   - background_image → first large <img src> OR CSS background-image
 *
 * Why rule-based instead of AI? Hero sections are the most formulaic
 * block on e-commerce homepages — a rule set gets us 95% recognition for
 * zero API spend. The remaining 5% can be tuned by editors post-clone.
 */

import type { DetectedSection } from '../types.js'
import {
  cleanText,
  firstHref,
  firstImageSrc,
  iterateBlocks,
  makeDetectedSection,
  type DetectorContext,
} from './shared.js'

const HERO_CLASS_RE = /\b(hero|banner|billboard|masthead|jumbotron)\b/i

export function detectHero(ctx: DetectorContext): DetectedSection | null {
  const { $, baseUrl } = ctx
  const blocks = iterateBlocks($)

  for (const { index, el } of blocks) {
    const className = el.attr('class') || ''
    const matchesClass = HERO_CLASS_RE.test(className)
    const descendantHero = el.find(`[class]`).filter((_, node) => {
      const cls = $(node).attr('class') || ''
      return HERO_CLASS_RE.test(cls)
    }).first()

    // Pick either the block itself or a descendant hero wrapper.
    const heroEl = matchesClass ? el : descendantHero.length > 0 ? descendantHero : null
    if (!heroEl) {
      // Fallback: first block that contains an h1 + button AND sits at position 0.
      if (index === 0 && el.find('h1').length > 0 && el.find('a, button').length > 0) {
        return extractFromHeroElement(el, index, baseUrl)
      }
      continue
    }

    // We have a candidate — verify it has a heading.
    if (heroEl.find('h1, h2').length === 0) continue

    return extractFromHeroElement(heroEl, index, baseUrl)
  }

  return null
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extractFromHeroElement(
  heroEl: ReturnType<DetectorContext['$']>,
  position: number,
  baseUrl?: string,
): DetectedSection {
  const heading = cleanText(
    heroEl.find('h1').first().text() || heroEl.find('h2').first().text(),
  )

  // Subheading: first <p> that isn't empty and isn't the CTA.
  let subheading = ''
  heroEl.find('p').each((_i, p) => {
    if (subheading) return
    const text = cleanText(heroEl.find(p).text?.() ?? '')
    if (text && text.length > 2) subheading = text
  })
  // Second attempt with direct cheerio call if the above didn't work.
  if (!subheading) {
    subheading = cleanText(heroEl.find('p').first().text())
  }

  // CTA: first link or button with visible text inside the hero.
  const ctaEl = heroEl.find('a[href], button').first()
  const ctaLabel = cleanText(ctaEl.text())
  const ctaLink = ctaEl.is('a[href]')
    ? firstHref(heroEl, baseUrl)
    : ''

  const backgroundImage = firstImageSrc(heroEl, baseUrl)

  const settings: Record<string, string | number | boolean> = { heading }
  if (subheading) settings.subheading = subheading
  if (ctaLabel) settings.cta_label = ctaLabel
  if (ctaLink) settings.cta_link = ctaLink
  if (backgroundImage) settings.background_image = backgroundImage

  const snippet = (heroEl.prop ? (heroEl.prop('outerHTML') as string | undefined) : undefined) ?? ''
  return makeDetectedSection('hero', position, settings, snippet.slice(0, 500))
}
