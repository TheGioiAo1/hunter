/**
 * Clone Pro v6 — public barrel export
 *
 * Only the orchestrator entry point, public DTOs, and the production
 * dependency factory are re-exported. Internal stage implementations
 * and AI helpers stay inside their own sub-modules; callers should
 * not import from them directly.
 */

export { runCloneProV6 } from './orchestrator.js'
export type { V6Deps, RunV6Input, RunV6Result } from './orchestrator.js'
export { buildV6Deps } from './deps.js'
