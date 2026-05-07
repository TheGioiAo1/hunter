/**
 * Gbox Platform — @gbox/core/modules/automations public surface
 *
 * Shopify Flow lite. Phase 14 PR3 surface. Consumers:
 *
 *   - Feature code (orders/service.ts, fulfillment/service.ts,
 *     payments/service.ts, …): `import { emit } from
 *     '@gbox/core/modules/automations'` — one line per call site,
 *     zero additional plumbing.
 *
 *   - Cron wiring (packages/core/src/cron/driver.ts): `import { tick,
 *     dormantSweep, AUTOMATION_SCHEDULER_HANDLERS } from
 *     '@gbox/core/modules/automations'` — register the two handlers
 *     with the driver.
 *
 *   - Admin UI (apps/store-admin/src/pages/automations.ts):
 *     `import { FLOW_CATALOG, getFlow } from
 *     '@gbox/core/modules/automations'` — render the list + per-flow
 *     detail.
 *
 *   - Smoke (scripts/smoke-phase14-pr3.ts): imports everything for
 *     end-to-end assertions.
 */

export * from './events.js'
export * from './conditions.js'
export * from './flow-catalog.js'
export * from './runner.js'
export * from './scheduler.js'
export * from './feature-flag.js'
