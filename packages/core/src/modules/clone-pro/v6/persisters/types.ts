import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

/**
 * Input shape for every BucketPersister.persist() call.
 *
 * Generic over the DTO type so each bucket (products, collections, pages, …)
 * can enforce its own scraped-data contract at compile time.
 *
 * L17: dtos are the raw scraped payloads from Stage 4. The persister is
 * responsible for checking shouldOverwriteOnReclone() before upsert and
 * calling writeCloneSnapshot() after insert.
 */
export interface PersistInput<DTO> {
  db: Kysely<Database>
  shopId: string
  jobId: string
  dtos: DTO[]
}

/**
 * Result shape returned by every BucketPersister.persist() call.
 *
 * Counters are used by the orchestrator to build the final job summary
 * and detect silent-failure modes (e.g. 0 inserted / 0 updated when
 * many DTOs were passed in — suggests a schema mismatch).
 *
 * errors entries are non-fatal — the persister continues past individual
 * row failures (fail-tolerance). Fatal errors (e.g. DB unreachable) are
 * thrown and propagate to the orchestrator.
 */
export interface PersistResult {
  inserted: number
  updated: number
  skippedEdited: number
  errors: { sourceHandle: string; reason: string }[]
}

/**
 * Contract every v6 bucket persister must satisfy.
 *
 * bucketName is a human-readable label used in logs and job summaries.
 * It should match the Stage 4 classification label (e.g. 'products',
 * 'collections', 'pages') for traceability.
 *
 * persist() runs inside a withSerializable() transaction provided by
 * the orchestrator. The trx is the Kysely<Database> instance scoped to
 * that transaction — persister implementations must use it exclusively
 * (never open a nested transaction).
 */
export interface BucketPersister<DTO> {
  bucketName: string
  persist(input: PersistInput<DTO>): Promise<PersistResult>
}
