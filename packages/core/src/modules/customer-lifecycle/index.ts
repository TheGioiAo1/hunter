/**
 * Customer lifecycle — Phase 4 PR3 barrel export.
 *
 * Consumers import from `@gbox/core/modules/customer-lifecycle/index.js`
 * to reach both the pure classifier (for segment-builder UI and
 * inline-recompute paths) and the recompute service (for the cron
 * handler and the order-service write hook).
 */

export {
  classifyLifecycle,
  isLifecycleStage,
  LIFECYCLE_STAGES,
  LIFECYCLE_AT_RISK_DAYS,
  LIFECYCLE_CHURNED_DAYS,
  type LifecycleStage,
  type LifecycleSnapshot,
} from './classifier.js'

export {
  recomputeOneCustomerLifecycle,
  recomputeAllLifecycleStages,
} from './recompute.js'
