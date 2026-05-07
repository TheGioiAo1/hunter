/**
 * Gbox Platform — support-sla module (Phase 12.5 PR5).
 *
 * Public surface for the SLA cron + escalation rules. Imported by the
 * `cron/service.ts` handler and the `/god-admin/support/tickets` admin
 * dashboard (dry-run preview of who'd be escalated).
 *
 * Export groups:
 *
 *   - business-hours: `isInsideBusinessHours`, `nextBusinessHoursStart`,
 *                     `DEFAULT_BUSINESS_HOURS`, `BusinessHours`.
 *   - escalation:     `decideEscalation`, `bumpPriority`, `PRIORITY_ORDER`,
 *                     `BreachRecord`, `EscalationDecision`, `BreachType`.
 *   - engine:         `tickSla`, `scanForBreaches`, `applyEscalation`,
 *                     `resolveCurrentLead`, `TickResult`.
 */

export {
  DEFAULT_BUSINESS_HOURS,
  isInsideBusinessHours,
  nextBusinessHoursStart,
} from './business-hours.ts'
export type { BusinessHours } from './business-hours.ts'

export {
  bumpPriority,
  decideEscalation,
  PRIORITY_ORDER,
} from './escalation.ts'
export type {
  BreachRecord,
  BreachType,
  EscalationDecision,
} from './escalation.ts'

export {
  tickSla,
  scanForBreaches,
  applyEscalation,
  resolveCurrentLead,
} from './engine.ts'
export type { TickResult } from './engine.ts'
