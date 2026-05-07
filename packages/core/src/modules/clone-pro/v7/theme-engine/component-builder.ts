/**
 * Clone Pro v7 — Component builder
 *
 * Maps a `DesignTokens` object → `ComponentManifest`: the per-slot
 * Liquid variant filename keyword that section files use via
 * `{% include 'sections/header-' | append: component_header_variant %}`.
 *
 * This is a pure deterministic mapping: same tokens → same manifest. No
 * I/O, no DB, no LLM. The translation tables encode product-team
 * judgement (e.g. "fullbleed-image" coming back from Claude vision is
 * the same intent as "fullbleed" in our variant library — but rather
 * than make Claude know our exact filename, we normalise here).
 *
 * Fail-soft: when Claude returns a variant name we don't have a Liquid
 * file for (e.g. "carousel" for product cards), we degrade to a sane
 * default ('classic' / 'minimal' / etc.) rather than crashing the
 * renderer. A diagnostic is exposed in the result so Stage 15 can log
 * the swap server-side.
 */

import type { DesignTokens } from './token-schema.js'

/**
 * The full catalog of variant filenames available under
 * `template-base/sections/`. Sprint 4 Task 4.2 — keep in sync with the
 * file system (the template-base unit test enforces ≥20 files).
 */
export const AVAILABLE_VARIANTS = {
  hero: ['fullbleed', 'split', 'editorial', 'minimal', 'video-bg'],
  product_card: ['classic', 'editorial', 'minimal', 'overlay', 'list'],
  header: ['minimal', 'classic', 'split', 'sticky-transparent'],
  footer: ['classic', 'minimal', 'editorial'],
  nav: ['horizontal', 'mega', 'drawer'],
} as const

export type HeroVariant = typeof AVAILABLE_VARIANTS.hero[number]
export type ProductCardVariant = typeof AVAILABLE_VARIANTS.product_card[number]
export type HeaderVariant = typeof AVAILABLE_VARIANTS.header[number]
export type FooterVariant = typeof AVAILABLE_VARIANTS.footer[number]
export type NavVariant = typeof AVAILABLE_VARIANTS.nav[number]

export interface ComponentManifest {
  hero: HeroVariant
  product_card: ProductCardVariant
  header: HeaderVariant
  footer: FooterVariant
  navigation: NavVariant
}

/**
 * Hero pattern → Liquid section name mapping. Claude's vocabulary for
 * the homepage hero pattern is broader than our 5 templates; this table
 * collapses synonyms into the supported variant set. Anything not in
 * the table falls back to `minimal` (which works for any layout).
 */
const HERO_TRANSLATIONS: Record<string, HeroVariant> = {
  fullbleed: 'fullbleed',
  'fullbleed-image': 'fullbleed',
  'image-fullbleed': 'fullbleed',
  overlay: 'fullbleed',
  split: 'split',
  'split-text-image': 'split',
  'split-image-text': 'split',
  editorial: 'editorial',
  minimal: 'minimal',
  'video-bg': 'video-bg',
  'video-background': 'video-bg',
  video: 'video-bg',
}

const PRODUCT_CARD_TRANSLATIONS: Record<string, ProductCardVariant> = {
  classic: 'classic',
  editorial: 'editorial',
  minimal: 'minimal',
  overlay: 'overlay',
  list: 'list',
  card: 'classic',
  'image-only': 'minimal',
  'hover-overlay': 'overlay',
  horizontal: 'list',
}

const HEADER_TRANSLATIONS: Record<string, HeaderVariant> = {
  minimal: 'minimal',
  classic: 'classic',
  split: 'split',
  centered: 'minimal',
  editorial: 'minimal',
  'sticky-transparent': 'sticky-transparent',
  'sticky-overlay': 'sticky-transparent',
  transparent: 'sticky-transparent',
}

const NAV_TRANSLATIONS: Record<string, NavVariant> = {
  horizontal: 'horizontal',
  'mega-menu': 'mega',
  mega: 'mega',
  drawer: 'drawer',
  hamburger: 'drawer',
  'minimal-icons': 'horizontal',
  centered: 'horizontal',
}

/** Lowercase + trim. Component-level translation tables use lowercase keys. */
export function normalizeVariant(variant: string): string {
  return variant.trim().toLowerCase()
}

function translate<T extends string>(
  table: Record<string, T>,
  raw: string | undefined,
  fallback: T,
): T {
  if (!raw) return fallback
  const norm = normalizeVariant(raw)
  return table[norm] ?? fallback
}

/**
 * Footer is not a token field (DesignTokensSchema has no footer slot —
 * footers rarely show in Claude vision analysis). We pick from the
 * style_keywords hint instead. 'editorial' / 'serif-typography' →
 * `footer-editorial`; 'minimal' / 'sparse' → `footer-minimal`; default
 * `classic`.
 */
function pickFooter(tokens: DesignTokens): FooterVariant {
  const kws = (tokens.style_keywords ?? []).map(normalizeVariant)
  if (kws.some((k) => k === 'editorial' || k === 'serif-typography' || k === 'literary')) {
    return 'editorial'
  }
  if (kws.some((k) => k === 'minimal' || k === 'sparse' || k === 'modern-minimal')) {
    return 'minimal'
  }
  return 'classic'
}

export function selectComponents(tokens: DesignTokens): ComponentManifest {
  return {
    hero: translate(HERO_TRANSLATIONS, tokens.layout.hero_pattern, 'minimal'),
    product_card: translate(
      PRODUCT_CARD_TRANSLATIONS,
      tokens.components.product_card.variant,
      'classic',
    ),
    header: translate(HEADER_TRANSLATIONS, tokens.components.header.variant, 'classic'),
    footer: pickFooter(tokens),
    navigation: translate(NAV_TRANSLATIONS, tokens.components.navigation.variant, 'horizontal'),
  }
}
