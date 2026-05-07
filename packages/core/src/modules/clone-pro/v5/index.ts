/**
 * Clone Pro v5 — public barrel export.
 *
 * Only the entry points and public DTOs are re-exported. Internal
 * helpers (scrapers, validators, persisters) stay inside their own
 * modules; callers should not import from them directly.
 */

export { runCloneProV5 } from './pipeline.js'
export type { PipelineDeps, PipelineResult } from './pipeline.js'
export type {
  Platform,
  ScrapedProduct,
  ScrapedCollection,
  ScrapedPage,
  MenuTree,
  MenuNode,
  ThemeTokens,
  GradeResult,
  PipelineContext,
} from './types.js'
export { detectPlatform } from './platform-detect.js'
export { gradeClone } from './grader.js'
export { exportDesignMd } from './design-md-export.js'
