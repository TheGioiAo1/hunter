import type { Transaction } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export interface SnapshotInput {
  table: keyof Database
  shopId: string
  rowId: string
  snapshot: Record<string, unknown>
}

/**
 * Writes the immutable clone-time snapshot to a bucket row.
 *
 * Called once per row immediately after INSERT so the original scraped
 * state is preserved for the Theme Editor revert path (Phase 22).
 *
 * L17 mandate: clone_snapshot is written at clone time and NEVER updated
 * by subsequent re-clones or editor saves — it is the baseline.
 */
export async function writeCloneSnapshot(
  trx: Transaction<Database>,
  input: SnapshotInput,
): Promise<void> {
  await (trx as any).updateTable(input.table)
    .set({ clone_snapshot: JSON.stringify(input.snapshot) })
    .where('shop_id', '=', input.shopId)
    .where('id', '=', input.rowId)
    .execute()
}

/**
 * Returns true when a bucket row should be overwritten by a re-clone.
 *
 * A row is safe to overwrite when its source is 'clone' (the original
 * clone-written value) or null/undefined (legacy rows pre-migration 097).
 * Rows with source='edited' or source='manual' represent seller changes and
 * MUST be preserved — the re-clone skips them entirely.
 */
export function shouldOverwriteOnReclone(row: { source?: 'clone' | 'edited' | 'manual' | null | undefined }): boolean {
  return !row.source || row.source === 'clone'
}
