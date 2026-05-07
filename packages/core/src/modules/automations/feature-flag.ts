/**
 * Gbox Platform — AUTOMATION_FRAMEWORK_V2 feature flag (Phase 14 PR3)
 *
 * The new event-driven automation framework lands alongside the Phase 8
 * abandoned-cart legacy path. Flipping between them cleanly requires a
 * single kill switch so rollback is instant if the smoke fails in
 * production.
 *
 * Contract:
 *
 *   - Flag OFF (default): every new `emit()` call site is a no-op. Legacy
 *     paths (Phase 8 abandoned-cart `dispatchStep`, transactional
 *     Priority 1 email shims) continue running exactly as before PR3.
 *   - Flag ON: emit() fires → runner → delayed queue / inline send. The
 *     Phase 8 legacy `dispatchStep` short-circuits with a
 *     `skipped_framework_v2` reason so the same email never sends twice
 *     for enrolments created while the flag was ON.
 *
 * Environment variable:
 *
 *     AUTOMATION_FRAMEWORK_V2=1   // turn on
 *     AUTOMATION_FRAMEWORK_V2=0   // turn off (default)
 *
 * We deliberately avoid a per-shop DB-backed flag for PR3. A single
 * env var keeps the rollback story unambiguous — `unset` and restart,
 * no data migration needed. Per-shop opt-in is a Phase 15 concern when
 * we roll the framework past beta.
 *
 * Iron rule 5: the flag is server-side only. NEVER expose it to any
 * seller-facing surface (admin UI, storefront, accounts portal); it's
 * a platform-ops toggle.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { AutomationEvent } from './events.js'
import { emit } from './events.js'

/**
 * Flag predicate. Reads the env var at CALL TIME (not import time) so
 * tests can flip it between cases via `process.env.AUTOMATION_FRAMEWORK_V2
 * = '1'` without reloading the module.
 */
export function isAutomationFrameworkEnabled(): boolean {
  return process.env.AUTOMATION_FRAMEWORK_V2 === '1'
}

/**
 * Fire-and-forget emit helper. Wraps `emit()` with:
 *   1. The feature-flag gate — no-op when OFF.
 *   2. A defensive try/catch — automation emit MUST NEVER break the
 *      caller's business operation (e.g. an `order.paid` transaction
 *      row must commit even if emit throws a FK error).
 *
 * Use this at every PR3 call site. Exactly one line at the call site:
 *
 *     await emitIfEnabled(db, { type: 'order.paid', shopId, … })
 *
 * Returns `true` iff the flag was on AND emit() succeeded (i.e. an
 * event row landed). Tests can assert this. Production callers can
 * ignore the return value.
 */
export async function emitIfEnabled(
  db: Kysely<Database>,
  event: AutomationEvent,
): Promise<boolean> {
  if (!isAutomationFrameworkEnabled()) return false
  try {
    await emit(db, event)
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[automations] emitIfEnabled failed', {
      type: event.type,
      shopId: event.shopId,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
