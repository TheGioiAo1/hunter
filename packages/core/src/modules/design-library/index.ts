/**
 * Design Library — public surface (Phase D1).
 *
 * Ship types and the read/write helpers consumers need; the CLI
 * (scripts/seed-design-library.ts) and future UI routes import from
 * here rather than poking each sub-module directly.
 */

export {
  DESIGN_LIBRARY_CATEGORIES,
  DESIGN_LIBRARY_CATEGORY_LABELS,
  type CloneDesignInput,
  type DesignLibraryCard,
  type DesignLibraryCategory,
  type DesignLibraryEntry,
  type DesignLibrarySource,
  type DesignLibraryStorageTier,
  type SeedDesignInput,
} from './types.js'

export {
  countSeedEntries,
  countSeedEntriesByCategory,
  getEntryById,
  getEntryBySlug,
  listFeaturedSeeds,
  listGallery,
  listMyClones,
  type GetEntryBySlugInput,
  type ListFeaturedSeedsInput,
  type ListGalleryInput,
  type ListMyClonesInput,
} from './queries.js'

export { deleteCloneEntry, insertCloneEntry, upsertSeedEntry } from './upsert.js'

export {
  BRAND_CATEGORY_MAP,
  KNOWN_BRAND_SLUGS,
  categoryFor,
} from './category-map.js'

export { extractTitleAndSummary, prettifySlug } from './parse-design-md.js'

// ── Phase D2 — clone emit helpers ──────────────────────────────────
// The clone-pro pipeline imports these from the module root so its
// emit hook (see `pipeline.ts :: emitDesignLibraryEntry`) doesn't
// need to reach into sub-files.
export {
  serializeCloneDesign,
  type SerializeCloneDesignInput,
  type SerializeCloneDesignResult,
} from './serialize-design-md.js'

export { deriveCloneSlug, sanitizeHostname } from './clone-slug.js'

export {
  emitCloneEntry,
  type CloneEmitInput,
  type EmitCloneEntryResult,
} from './emit-pipeline.js'
