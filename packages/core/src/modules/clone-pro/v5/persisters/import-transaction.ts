/**
 * Clone Pro v5 — transactional import wrapper (phase ⑤ entry point)
 *
 * Wraps the entire persist stage (products + collections + pages + menus +
 * theme) inside a single SERIALIZABLE transaction via
 * `withSerializable` (Phase 15 PR1 — see `@gbox/core/modules/db/transaction`).
 * On successful completion the wrapper writes one `clone_checkpoints` row
 * with `phase='persist'` + `step='complete'` so the pipeline resumption
 * logic can skip this phase on restart. On any error the tx aborts cleanly
 * and the error propagates — no checkpoint is written.
 *
 * Test seam: callers can inject `_withSerializable` to swap the real runner
 * for a lightweight fake. Production call sites should omit it.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { withSerializable } from '@gbox/core/modules/db/transaction.js'

export interface ImportOpts {
  /**
   * Seam for unit tests — replaces the real SERIALIZABLE tx runner. Keep
   * the signature identical to `withSerializable` so real wiring just
   * omits the option.
   */
  readonly _withSerializable?: typeof withSerializable
}

export async function runCloneImport<T>(
  db: Kysely<Database>,
  jobId: string,
  fn: (tx: Kysely<Database>) => Promise<T>,
  opts: ImportOpts = {},
): Promise<T> {
  const runner = opts._withSerializable ?? withSerializable
  return runner(db, async (tx) => {
    const result = await fn(tx as unknown as Kysely<Database>)
    // Checkpoint is the last write in the tx — if fn threw, we never reach
    // here and the tx rolls back, so no half-completed run is recorded.
    await tx
      .insertInto('clone_checkpoints')
      .values({
        job_id: jobId,
        phase: 'persist',
        step: 'complete',
        state_json: {},
      })
      .execute()
    return result
  })
}
