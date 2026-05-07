/**
 * Clone Pro v7 — public barrel export.
 *
 * Sprint 2 Task 2.6. Mirrors the v6 barrel: orchestrator entry point,
 * production deps factory, plus the v7-specific Stage 4 helpers.
 * Internal stages stay inside their sub-folders; callers should not
 * import from `./stages/...` directly.
 */

export { runCloneProV7 } from './orchestrator.js'
export type { V7Deps, RunV7Input, RunV7Result } from './orchestrator.js'
export { buildV7Deps } from './deps.js'
export type { BuildV7DepsOptions } from './deps.js'
export { ThemeZipS3KeyResolver } from './theme-zip-resolver.js'
export {
  CloneProCostTracker,
  CostBudgetExceededError,
  CLAUDE_MODEL_PRICING,
  claudeCallCostUsd,
  resolveMaxBudgetUsd,
} from './cost-budget.js'
export {
  runStage4LonspyBulk,
  QualityBelowThresholdError,
  QUALITY_GATE_THRESHOLD,
} from './stages/stage4-lonspy-bulk.js'
export type { RunStage4Input, RunStage4Result } from './stages/stage4-lonspy-bulk.js'
export {
  rowToProductDto,
  collectionFromHandle,
  slugify,
  parseSpinIntoOptionsAndVariants,
  isProductRowComplete,
} from './dto-mapper.js'
