/**
 * Audit log background export — Phase 2 Admin Polish §2.3
 *
 * The synchronous `?export=csv` path on /god-admin/security caps at
 * 10k rows (see `packages/core/src/modules/audit/export.ts`). Real
 * compliance audits occasionally need 100k+ rows which would lock a
 * request worker for ~30s and exceed express's default body timeout.
 *
 * This module implements a BullMQ-backed background job:
 *
 *   1. `enqueueAuditExport(...)` — the god-admin POST handler calls
 *      this. It creates a fresh UUID, writes a tracking row to Redis
 *      under `gbox:audit_export:<id>`, adds the job id to a per-user
 *      sorted set, and enqueues the BullMQ job.
 *
 *   2. `processAuditExportJob(...)` — runs inside the worker. Streams
 *      rows out of the DB in batches of 5,000, writes them to a CSV
 *      file in `AUDIT_EXPORT_DIR`, and updates the tracking row with
 *      `done` / `row_count` / `file_size_bytes` on success or
 *      `failed` / `error` on failure.
 *
 *   3. `getAuditExportMeta` / `listAuditExportsForUser` — read helpers
 *      used by the UI to render the "your pending + finished exports"
 *      list and to resolve a file path for the download handler.
 *
 *   4. `pruneExpiredAuditExports(...)` — deletes CSV files older than
 *      72h plus their Redis tracking rows. Wired into the existing
 *      audit-log prune cron.
 *
 * # Why Redis (and not a new `audit_exports` table)?
 *
 *  - Every admin surface that matters already has a live Redis
 *    connection (csrf-express, bullmq, cache).
 *  - Exports are ephemeral — 72h TTL, no long-term reporting needs,
 *    no foreign keys pointing at them. A Postgres table would mean a
 *    migration, a model, an explicit prune job, and a new source of
 *    schema drift for no functional win.
 *  - BullMQ already stores job state in Redis. Co-locating our
 *    tracking meta in the same database means a full export prune is
 *    one `DEL` + one `UNLINK` per job. Trivial to reason about.
 *
 * # File layout
 *
 *   AUDIT_EXPORT_DIR/<export_id>.csv   — the final file
 *   gbox:audit_export:<export_id>      — JSON meta (EX 72h)
 *   gbox:audit_exports:user:<user_id>  — sorted set of job ids
 *                                        scored by created_at_ms
 *
 * # Security
 *
 *  - Tracking meta is scoped to the god admin who queued it.
 *  - The download handler checks that `actor_user_id` on the meta
 *    matches `req.godAdmin!.user.id` before streaming the file.
 *  - Filenames are always `<uuid>.csv` — no user input ever touches
 *    the filesystem path. `AUDIT_EXPORT_DIR` is resolved once at
 *    module load and re-used.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { getRedis } from '../cache/redis.js'
import { auditExportQueue, type AuditExportJob } from '../queue/queues.js'
import { fetchAuditLogsForExport, rowsToCsv, type ExportRow } from './export.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Directory where finished CSV files live. Defaults to
 * `/var/tmp/gbox-audit-exports` on Linux — `/var/tmp` is preserved
 * across reboots on most distros (unlike `/tmp`) so an export that
 * finished right before a worker restart is still downloadable. On
 * Windows and test environments the default is `os.tmpdir()`-relative.
 *
 * Override via `GBOX_AUDIT_EXPORT_DIR`.
 */
export function getAuditExportDir(): string {
  const env = process.env.GBOX_AUDIT_EXPORT_DIR
  if (env) {
    return isAbsolute(env) ? env : resolve(env)
  }
  if (process.platform === 'win32') {
    return resolve(process.env.TEMP ?? process.env.TMP ?? '.', 'gbox-audit-exports')
  }
  return '/var/tmp/gbox-audit-exports'
}

/** Max rows a single background export may return. Keeps any one job bounded. */
export const AUDIT_EXPORT_HARD_CAP = 100_000

/** Rows per DB page when streaming. */
const EXPORT_BATCH_SIZE = 5_000

/** TTL applied to Redis meta entries. 72h matches the file-prune window. */
export const AUDIT_EXPORT_TTL_SECONDS = 72 * 60 * 60

// ---------------------------------------------------------------------------
// Tracking meta
// ---------------------------------------------------------------------------

export type AuditExportStatus = 'queued' | 'running' | 'done' | 'failed'

export interface AuditExportMeta {
  /** UUID, matches the CSV filename + Redis key suffix. */
  id: string
  status: AuditExportStatus
  actor_user_id: string
  actor_email: string | null
  filters: AuditExportJob['filters']
  row_limit: number
  /** Populated once the worker finishes. */
  row_count: number | null
  /** Populated once the worker finishes. `null` while running. */
  file_size_bytes: number | null
  /** Only set on failure. */
  error: string | null
  /** ISO timestamp of the enqueue. */
  created_at: string
  /** ISO timestamp of the done/failed transition. */
  finished_at: string | null
}

const META_KEY_PREFIX = 'gbox:audit_export:'
const USER_INDEX_PREFIX = 'gbox:audit_exports:user:'

function metaKey(id: string): string {
  return META_KEY_PREFIX + id
}

function userIndexKey(userId: string): string {
  return USER_INDEX_PREFIX + userId
}

async function writeMeta(meta: AuditExportMeta): Promise<void> {
  const client = await getRedis()
  await client.set(metaKey(meta.id), JSON.stringify(meta), {
    EX: AUDIT_EXPORT_TTL_SECONDS,
  })
}

export async function getAuditExportMeta(id: string): Promise<AuditExportMeta | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null
  const client = await getRedis()
  const raw = await client.get(metaKey(id))
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuditExportMeta
  } catch {
    return null
  }
}

/**
 * Return the N most recent exports queued by a given user. Reads the
 * per-user sorted set, scans tombstone entries (where the meta has
 * already TTL'd out but the sorted set hasn't been pruned yet) and
 * quietly drops them so the UI never sees a "deleted" half-state.
 */
export async function listAuditExportsForUser(
  userId: string,
  limit = 20,
): Promise<AuditExportMeta[]> {
  const client = await getRedis()
  // zrange with REV + LIMIT returns the highest-scored entries first.
  const ids = await client.zRange(userIndexKey(userId), 0, limit - 1, { REV: true })
  if (!ids || ids.length === 0) return []

  const out: AuditExportMeta[] = []
  const stale: string[] = []
  for (const id of ids) {
    const meta = await getAuditExportMeta(id)
    if (meta) {
      out.push(meta)
    } else {
      stale.push(id)
    }
  }
  // Best-effort cleanup of sorted-set entries whose meta has expired.
  if (stale.length > 0) {
    try {
      await client.zRem(userIndexKey(userId), stale)
    } catch {
      /* ignore — cosmetic */
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueAuditExportInput {
  actor_user_id: string
  actor_email: string | null
  filters: AuditExportJob['filters']
  /** Optional override; clamped to [1, AUDIT_EXPORT_HARD_CAP]. */
  row_limit?: number
}

/**
 * Enqueue a background audit export. Creates the Redis tracking row
 * transactionally with the per-user sorted-set entry so a crash
 * between the two cannot leave an orphan.
 *
 * Returns the fresh export id so the caller can redirect the user to
 * the "your exports" view highlighting the new row.
 */
export async function enqueueAuditExport(
  input: EnqueueAuditExportInput,
): Promise<string> {
  const id = randomUUID()
  const rowLimit = Math.min(
    Math.max(1, input.row_limit ?? AUDIT_EXPORT_HARD_CAP),
    AUDIT_EXPORT_HARD_CAP,
  )
  const now = new Date()
  const meta: AuditExportMeta = {
    id,
    status: 'queued',
    actor_user_id: input.actor_user_id,
    actor_email: input.actor_email,
    filters: input.filters,
    row_limit: rowLimit,
    row_count: null,
    file_size_bytes: null,
    error: null,
    created_at: now.toISOString(),
    finished_at: null,
  }

  // Write meta + index entry BEFORE enqueuing. If the BullMQ add()
  // throws, we leave a `queued` row that the user can see, and the
  // cron prune will reap it after 72h. Better than the reverse where
  // the job runs against a missing meta and has nowhere to write back.
  const client = await getRedis()
  await client.set(metaKey(id), JSON.stringify(meta), {
    EX: AUDIT_EXPORT_TTL_SECONDS,
  })
  await client.zAdd(userIndexKey(input.actor_user_id), {
    score: now.getTime(),
    value: id,
  })
  await client.expire(userIndexKey(input.actor_user_id), AUDIT_EXPORT_TTL_SECONDS)

  const jobData: AuditExportJob = {
    export_id: id,
    actor_user_id: input.actor_user_id,
    actor_email: input.actor_email,
    filters: input.filters,
    row_limit: rowLimit,
  }
  await auditExportQueue().add(`audit-export:${id}`, jobData, {
    // One attempt is enough — a failed export leaves a visible
    // `failed` row with the error message so the admin can re-queue.
    // Multiple retries would just pile on DB load for a query that's
    // already slow by construction.
    attempts: 1,
  })

  return id
}

// ---------------------------------------------------------------------------
// Worker handler
// ---------------------------------------------------------------------------

/**
 * Process a single audit-export job. Called from the BullMQ worker in
 * `packages/core/src/modules/queue/workers.ts`.
 *
 * The worker:
 *   1. Flips meta to `running`.
 *   2. Ensures the export dir exists.
 *   3. Streams rows in pages of EXPORT_BATCH_SIZE using `created_at`
 *      as the keyset cursor (matches the index-backed ORDER BY DESC
 *      in fetchAuditLogsForExport).
 *   4. Writes CSV header once, then row batches.
 *   5. Closes the file, `stat`s it for size, flips meta to `done`.
 *   6. On any throw, flips meta to `failed` + stores the error.
 *
 * Streaming via keyset pagination (rather than a single 100k SELECT)
 * keeps the memory footprint flat: one batch in RAM at a time.
 */
export async function processAuditExportJob(
  db: Kysely<Database>,
  job: AuditExportJob,
): Promise<void> {
  const existing = await getAuditExportMeta(job.export_id)
  if (!existing) {
    // Orphaned job (meta TTL'd out). Nothing to write back to — log
    // and bail so we don't stream 100k rows into a file nobody can
    // find.
    console.warn(`[audit-export] meta missing for job ${job.export_id}, skipping`)
    return
  }

  await writeMeta({ ...existing, status: 'running' })

  const dir = getAuditExportDir()
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${job.export_id}.csv`)

  let rowCount = 0
  let batchCount = 0
  const handle = createWriteStream(filePath, { encoding: 'utf8' })

  const writeChunk = (chunk: string): Promise<void> =>
    new Promise((resolvePromise, rejectPromise) => {
      handle.write(chunk, (err) => {
        if (err) rejectPromise(err)
        else resolvePromise()
      })
    })

  const closeFile = (): Promise<void> =>
    new Promise((resolvePromise) => handle.end(resolvePromise))

  try {
    // Paginate by created_at cursor. Because the upstream select
    // orders DESC the cursor is the `toIso` upper bound we move
    // further into the past on each page.
    let cursor: string | undefined = job.filters.toIso
    const remaining = () => Math.max(0, job.row_limit - rowCount)
    let firstBatch = true

    // Safety ceiling on iterations in case the query returns no rows
    // but the cursor doesn't advance.
    const MAX_BATCHES = Math.ceil(AUDIT_EXPORT_HARD_CAP / EXPORT_BATCH_SIZE) + 2

    while (remaining() > 0 && batchCount < MAX_BATCHES) {
      const batch: ExportRow[] = await fetchAuditLogsForExport(db, {
        ...job.filters,
        toIso: cursor,
        limit: Math.min(EXPORT_BATCH_SIZE, remaining()),
      })

      if (batch.length === 0) break

      if (firstBatch) {
        // Emit headers + first batch body.
        await writeChunk(rowsToCsv(batch))
        firstBatch = false
      } else {
        // Strip the header row from subsequent batches — rowsToCsv
        // always re-emits headers so we split on the first newline
        // and discard it.
        const csv = rowsToCsv(batch)
        const nl = csv.indexOf('\n')
        const body = nl >= 0 ? csv.slice(nl + 1) : csv
        if (body.length > 0) await writeChunk(body)
      }

      rowCount += batch.length
      batchCount += 1

      // If this was a short batch we're done.
      if (batch.length < EXPORT_BATCH_SIZE) break

      // Advance cursor: the rows come DESC so the last row has the
      // OLDEST timestamp in this batch. Use it as the upper bound
      // for the next page (strict less-than semantics already apply
      // to `toIso` in fetchAuditLogsForExport).
      const lastRow = batch[batch.length - 1]
      if (!lastRow?.created_at) break
      if (cursor === lastRow.created_at) break
      cursor = lastRow.created_at
    }

    await closeFile()

    const fileStat = await stat(filePath).catch(() => null)
    const meta: AuditExportMeta = {
      ...existing,
      status: 'done',
      row_count: rowCount,
      file_size_bytes: fileStat?.size ?? null,
      error: null,
      finished_at: new Date().toISOString(),
    }
    await writeMeta(meta)
  } catch (err) {
    try {
      await closeFile()
    } catch {
      /* ignore */
    }
    // Best-effort cleanup of the partial file.
    await unlink(filePath).catch(() => {})

    const meta: AuditExportMeta = {
      ...existing,
      status: 'failed',
      row_count: null,
      file_size_bytes: null,
      error: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    }
    await writeMeta(meta)
    // Re-throw so BullMQ marks the job as failed in its own logs.
    throw err
  }
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

/**
 * Walk the export dir and delete any CSV file older than 72h. Also
 * clears orphan Redis meta entries for files that are already gone.
 *
 * Called from the existing audit-log prune cron
 * (`scripts/ops/prune-audit-logs.ts`) so ops doesn't have to
 * remember a second schedule.
 *
 * Safe to call concurrently — `unlink` is idempotent on Linux.
 */
export async function pruneExpiredAuditExports(): Promise<{
  files_deleted: number
  bytes_reclaimed: number
}> {
  const dir = getAuditExportDir()
  let files: string[] = []
  try {
    files = await readdir(dir)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') return { files_deleted: 0, bytes_reclaimed: 0 }
    throw err
  }

  const cutoff = Date.now() - AUDIT_EXPORT_TTL_SECONDS * 1000
  let deleted = 0
  let bytes = 0

  for (const name of files) {
    if (!name.endsWith('.csv')) continue
    const full = join(dir, name)
    try {
      const st = await stat(full)
      if (st.mtimeMs < cutoff) {
        bytes += st.size
        await unlink(full)
        deleted += 1
      }
    } catch {
      /* ignore — file disappeared, was never there */
    }
  }

  return { files_deleted: deleted, bytes_reclaimed: bytes }
}
