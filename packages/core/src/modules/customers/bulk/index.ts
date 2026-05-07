/**
 * Customer bulk-action engine — public API.
 *
 * Only exports the entry-point + types; the per-action helpers stay
 * module-private so the call surface is a single function and a
 * discriminated union.
 */

export { applyBulkAction } from './engine.js'
export type { BulkAction, BulkResult, LifecycleStage } from './engine.js'
