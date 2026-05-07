/**
 * Clone Pro v4 — Gbox Dawn section mapper types
 *
 * The "section mapper" bridges two worlds:
 *
 *   - INPUT: a source site's homepage HTML (arbitrary markup).
 *   - OUTPUT: a Shopify-style `templates/index.json` that composes Gbox
 *     Dawn's canonical 20 sections to reproduce the source layout.
 *
 * Why these 20? Gbox Dawn is the first-party theme we ship. Keeping the
 * clone output pinned to Dawn's schema means a cloned site slots straight
 * into the storefront renderer without custom section code, and merchants
 * can edit every section via the standard theme editor.
 *
 * There are three buckets of sections:
 *
 *   1. `chrome` — header + footer. Always one of each per page; handled
 *      by `homepage-cloner` already (we don't redo that work here).
 *
 *   2. `main` — the 14 `main-*` sections that bind 1:1 to a page type
 *      (`main-product`, `main-collection`, `main-404`, …). These are
 *      placed automatically by the template filename convention; the
 *      mapper only knows *which one* goes with which page type.
 *
 *   3. `composable` — the 4 sections that appear in *varying orders and
 *      combinations* on a homepage (`hero`, `featured-collection`,
 *      `image-with-text`, `newsletter`). These are the only sections
 *      that require real semantic HTML analysis.
 *
 * The catalog (see `catalog.ts`) is the single source of truth. Detectors
 * are wired in `detectors/`; the composer is `compose-index-json.ts`.
 */

// ---------------------------------------------------------------------------
// Canonical section identifiers
// ---------------------------------------------------------------------------

/**
 * The 20 Gbox Dawn sections. Keep this list in lockstep with the files
 * under `packages/core/src/modules/themes/seed/gbox-dawn/sections/` —
 * the generator script validates filename ↔ SectionId parity on build.
 */
export type SectionId =
  // Chrome (2)
  | 'header'
  | 'footer'
  // Composable homepage sections (4)
  | 'hero'
  | 'featured-collection'
  | 'image-with-text'
  | 'newsletter'
  // Page-main sections (14)
  | 'main-404'
  | 'main-account'
  | 'main-article'
  | 'main-blog'
  | 'main-cart'
  | 'main-collection'
  | 'main-gift-card'
  | 'main-list-collections'
  | 'main-login'
  | 'main-page'
  | 'main-password'
  | 'main-policy'
  | 'main-product'
  | 'main-search'

/** Which of the three buckets a section belongs to. */
export type SectionBucket = 'chrome' | 'composable' | 'main'

// ---------------------------------------------------------------------------
// Section schema (read from `{% schema %}` inside each .liquid)
// ---------------------------------------------------------------------------

/** Supported Shopify-section setting input types we care about. */
export type SettingType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'range'
  | 'checkbox'
  | 'url'
  | 'color'
  | 'image_picker'
  | 'collection'
  | 'product'
  | 'page'
  | 'blog'
  | 'select'
  | 'radio'
  | 'font_picker'
  | 'richtext'
  | 'html'
  | 'link_list'

export interface SectionSetting {
  readonly type: SettingType
  readonly id: string
  readonly label?: string
  /** Default value as declared in the schema. */
  readonly default?: string | number | boolean
  readonly min?: number
  readonly max?: number
  readonly step?: number
}

export interface SectionSchema {
  readonly name: string
  readonly settings: readonly SectionSetting[]
  /** Presets are advisory only — we never emit them in index.json. */
  readonly presets?: readonly { readonly name: string; readonly category?: string }[]
}

/**
 * A single catalog entry — one per Liquid file under `sections/`. Describes
 * what the section is, which bucket it lives in, and (for composables)
 * what page types it's eligible to appear on.
 */
export interface SectionDef {
  readonly id: SectionId
  readonly bucket: SectionBucket
  /** Schema parsed from the seed Liquid. */
  readonly schema: SectionSchema
  /**
   * For main-* sections: the DiscoveredPage.pageType this section renders.
   * Undefined for chrome + composables.
   */
  readonly pageType?: string
}

export type SectionCatalog = Readonly<Record<SectionId, SectionDef>>

// ---------------------------------------------------------------------------
// Detector result
// ---------------------------------------------------------------------------

/**
 * What a detector returns when it successfully matches a chunk of homepage
 * HTML to one of the composable sections. The `settings` object mirrors
 * the section's schema (keys = setting.id); unknown keys are dropped by
 * the composer, but missing keys fall back to the schema default.
 */
export interface DetectedSection {
  readonly id: SectionId
  /** 0-based index into the homepage's top-level children — used to preserve ordering. */
  readonly position: number
  /** Settings extracted from the source HTML. */
  readonly settings: Readonly<Record<string, string | number | boolean>>
  /** Raw HTML snippet that produced the match — useful for debugging/logs. */
  readonly sourceSnippet?: string
}

// ---------------------------------------------------------------------------
// Composer output (a.k.a. Shopify `templates/index.json`)
// ---------------------------------------------------------------------------

export interface IndexJsonSection {
  readonly type: string
  readonly settings: Readonly<Record<string, string | number | boolean>>
}

export interface IndexJson {
  readonly sections: Readonly<Record<string, IndexJsonSection>>
  readonly order: readonly string[]
}
