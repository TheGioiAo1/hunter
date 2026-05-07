/**
 * Clone Pro v4 — Gbox Dawn section catalog
 *
 * Builds the `SECTION_CATALOG` — 20 entries, one per section file shipped
 * in `seed/gbox-dawn/sections/`. Each entry records the section's id,
 * bucket (chrome/composable/main), parsed schema, and (for main-*
 * sections) the DiscoveredPage.pageType it maps to.
 *
 * The catalog is built lazily the first time it's read. We don't eagerly
 * parse 20 schemas on module import because:
 *   - Tests that touch individual detectors don't need every schema.
 *   - The generated bundle pulls in the full Dawn seed — lazy init lets
 *     us trim tree-shaking a bit.
 *
 * If Gbox Dawn ever ships a new section, the catalog's reference list
 * needs a new entry — the `assertCatalogMatchesBundle` helper is called
 * by `catalog.test.ts` to catch drift in CI.
 */

import { getGboxDawnAsset, listGboxDawnAssets } from '../../themes/seed/gbox-dawn-bundle.js'
import { parseSectionSchema } from './schema-reader.js'
import type { SectionBucket, SectionCatalog, SectionDef, SectionId } from './types.js'

// ---------------------------------------------------------------------------
// Reference list — the canonical 20 sections + their bucket + pageType binding
// ---------------------------------------------------------------------------

interface CatalogReferenceEntry {
  readonly id: SectionId
  readonly bucket: SectionBucket
  /** Only set for main-* bindings. */
  readonly pageType?: string
}

/**
 * Source-of-truth list. Order matches the ordering we want when emitting
 * index.json (composable sections first, then chrome, then mains).
 */
const CATALOG_REFERENCES: readonly CatalogReferenceEntry[] = [
  // Chrome
  { id: 'header', bucket: 'chrome' },
  { id: 'footer', bucket: 'chrome' },
  // Composable (homepage)
  { id: 'hero', bucket: 'composable' },
  { id: 'featured-collection', bucket: 'composable' },
  { id: 'image-with-text', bucket: 'composable' },
  { id: 'newsletter', bucket: 'composable' },
  // Page-main sections
  { id: 'main-404', bucket: 'main', pageType: '404' },
  { id: 'main-account', bucket: 'main', pageType: 'account' },
  { id: 'main-article', bucket: 'main', pageType: 'blog-post' },
  { id: 'main-blog', bucket: 'main', pageType: 'blog' },
  { id: 'main-cart', bucket: 'main', pageType: 'cart' },
  { id: 'main-collection', bucket: 'main', pageType: 'collection' },
  { id: 'main-gift-card', bucket: 'main', pageType: 'gift_card' },
  { id: 'main-list-collections', bucket: 'main', pageType: 'list-collections' },
  { id: 'main-login', bucket: 'main', pageType: 'login' },
  { id: 'main-page', bucket: 'main', pageType: 'page' },
  { id: 'main-password', bucket: 'main', pageType: 'password' },
  { id: 'main-policy', bucket: 'main', pageType: 'policy' },
  { id: 'main-product', bucket: 'main', pageType: 'product' },
  { id: 'main-search', bucket: 'main', pageType: 'search' },
]

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

let cachedCatalog: SectionCatalog | null = null

/**
 * Return the full catalog. Caches the result after first call — the
 * schemas never change at runtime (seed is a build-time bundle).
 */
export function getSectionCatalog(): SectionCatalog {
  if (cachedCatalog) return cachedCatalog
  const entries = {} as Record<SectionId, SectionDef>
  for (const ref of CATALOG_REFERENCES) {
    const assetKey = `sections/${ref.id}.liquid`
    const asset = getGboxDawnAsset(assetKey)
    if (!asset) {
      throw new Error(
        `[section-mapper] Gbox Dawn bundle is missing '${assetKey}'. ` +
          'Regenerate the bundle via scripts/generate-gbox-dawn-bundle.ts.',
      )
    }
    const schema = parseSectionSchema(asset.source)
    entries[ref.id] = {
      id: ref.id,
      bucket: ref.bucket,
      schema,
      pageType: ref.pageType,
    }
  }
  cachedCatalog = entries as SectionCatalog
  return cachedCatalog
}

/** Convenience: get a single section by id (throws on unknown id). */
export function getSectionDef(id: SectionId): SectionDef {
  const catalog = getSectionCatalog()
  const def = catalog[id]
  if (!def) throw new Error(`[section-mapper] Unknown section id: ${id}`)
  return def
}

/** All section ids of a given bucket, in catalog (reference) order. */
export function sectionsInBucket(bucket: SectionBucket): readonly SectionId[] {
  return CATALOG_REFERENCES.filter((r) => r.bucket === bucket).map((r) => r.id)
}

/** Find the main-* section that matches a DiscoveredPage.pageType. */
export function mainSectionForPageType(pageType: string): SectionId | null {
  const ref = CATALOG_REFERENCES.find(
    (r) => r.bucket === 'main' && r.pageType === pageType,
  )
  return ref ? ref.id : null
}

// ---------------------------------------------------------------------------
// CI-style self-test — catches bundle drift
// ---------------------------------------------------------------------------

/**
 * Asserts that every `sections/*.liquid` entry in the Gbox Dawn bundle
 * is represented in `CATALOG_REFERENCES`, and vice-versa. Used by the
 * catalog test to guard against drift when a new section file is added
 * without updating this reference list.
 */
export function assertCatalogMatchesBundle(): void {
  const bundleIds = listGboxDawnAssets()
    .filter((a) => a.key.startsWith('sections/') && a.key.endsWith('.liquid'))
    .map((a) => a.key.replace(/^sections\//, '').replace(/\.liquid$/, ''))
    .sort()

  const catalogIds = CATALOG_REFERENCES.map((r) => r.id).sort()

  const bundleExtras = bundleIds.filter((id) => !catalogIds.includes(id as SectionId))
  const catalogExtras = catalogIds.filter((id) => !bundleIds.includes(id))

  if (bundleExtras.length > 0 || catalogExtras.length > 0) {
    throw new Error(
      `[section-mapper] Catalog / bundle drift:\n` +
        `  bundle has no entry for: ${catalogExtras.join(', ') || '(none)'}\n` +
        `  catalog has no entry for: ${bundleExtras.join(', ') || '(none)'}`,
    )
  }
}
