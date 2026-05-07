/**
 * Clone Pro v4 — Section Mapper (Gbox Dawn)
 *
 * Public surface:
 *
 *   - `composeIndexJson(html, baseUrl)` — the one-shot entry point used
 *     by the pipeline executor. Takes a source homepage HTML and
 *     returns a Gbox-Dawn–shaped `templates/index.json`.
 *
 *   - `getSectionCatalog()` / `getSectionDef(id)` — catalog lookups for
 *     tests, CLI tooling, and admin-UI rendering of section schemas.
 *
 *   - `mainSectionForPageType(pageType)` — resolve a `main-*` section
 *     id for a DiscoveredPage.pageType. Used by the template-json
 *     emitters for pages other than the homepage.
 *
 *   - The four individual detector functions — exported for direct
 *     use in tests and for callers who want finer-grained control
 *     (e.g. pre-staging the detection for an admin preview step).
 */

export { composeIndexJson } from './compose-index-json.js'
export type {
  ComposeIndexJsonInput,
  ComposeIndexJsonResult,
} from './compose-index-json.js'

export {
  getSectionCatalog,
  getSectionDef,
  sectionsInBucket,
  mainSectionForPageType,
  assertCatalogMatchesBundle,
} from './catalog.js'

export { parseSectionSchema } from './schema-reader.js'

export {
  detectHero,
  detectFeaturedCollection,
  detectImageWithText,
  detectNewsletter,
  type DetectorContext,
  type DetectorFn,
} from './detectors/index.js'

export type {
  SectionId,
  SectionBucket,
  SettingType,
  SectionSetting,
  SectionSchema,
  SectionDef,
  SectionCatalog,
  DetectedSection,
  IndexJson,
  IndexJsonSection,
} from './types.js'
