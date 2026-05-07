/**
 * Clone Pro v4 — Phase 3 (Verification) barrel
 *
 * Public surface: the orchestrator, every individual check, and the
 * types. Tests consume the individual checks; the pipeline orchestrator
 * only ever calls `runVerification`.
 */

export { runVerification } from './orchestrator.js'
export type { RunVerificationInput } from './orchestrator.js'

export { runRouteCheck } from './route-check.js'
export type { RouteCheckInput } from './route-check.js'

export { runAssetCheck } from './asset-check.js'
export type { AssetCheckInput } from './asset-check.js'

export { runContentCheck } from './content-check.js'
export type { ContentCheckInput } from './content-check.js'

export { runDependencyCheck, extractUrls } from './dependency-check.js'
export type { DependencyCheckInput } from './dependency-check.js'

export { runCssMatchCheck } from './css-match.js'
export type { CssMatchInput } from './css-match.js'

export { buildVerificationReport } from './report.js'
export type { BuildReportInput } from './report.js'

export type {
  CheckCategory,
  CheckResult,
  Finding,
  Grade,
  Severity,
  VerificationReport,
} from './types.js'
