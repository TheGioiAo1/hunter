/**
 * Gbox Platform — support-notifications module (Phase 12.5 PR5).
 *
 * Public surface for every support-system notification pathway. Imported
 * by `support-sla/engine.ts` (breach dispatch), `cron/service.ts` (CSAT
 * prompt + retention sweep handlers), `support/service.ts` (new-message
 * + mention + assigned notifications), and the `/god-admin/support/*`
 * admin pages (preview preferences).
 *
 * Export groups:
 *
 *   - sender:          `sendSupportNotification`, `SendNotificationInput`,
 *                      `SendNotificationResult`.
 *   - preferences:     `getNotificationPreferences`, `pickChannels`,
 *                      `channelsForType`, `isInQuietHours`,
 *                      `DEFAULT_PREFERENCES`, `ResolvedPreferences`.
 *   - csat-auto-prompt `runCsatPrompts`, `CsatPromptResult`.
 *   - retention:       `runRetentionCleanup`, `RetentionRunResult`,
 *                      `RetentionMode`.
 */

export {
  sendSupportNotification,
} from './sender.ts'
export type {
  SendNotificationInput,
  SendNotificationResult,
} from './sender.ts'

export {
  getNotificationPreferences,
  pickChannels,
  channelsForType,
  isInQuietHours,
  DEFAULT_PREFERENCES,
} from './preferences.ts'
export type { ResolvedPreferences } from './preferences.ts'

export { runCsatPrompts } from './csat-auto-prompt.ts'
export type { CsatPromptResult, RunCsatPromptOpts } from './csat-auto-prompt.ts'

export { runRetentionCleanup } from './retention-cleanup.ts'
export type {
  RetentionMode,
  RetentionRunResult,
  RunRetentionOpts,
} from './retention-cleanup.ts'

export { runAutoCloseTick } from './auto-close.ts'
export type { AutoCloseResult, RunAutoCloseOpts } from './auto-close.ts'

export {
  seedSupportCronTasks,
  SUPPORT_CRON_HANDLERS,
} from './cron-seed.ts'
