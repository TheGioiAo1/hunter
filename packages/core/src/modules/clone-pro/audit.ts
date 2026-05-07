/**
 * Phase 7 Step 7.6 — clone-pro audit log writer.
 *
 * Purpose:
 *   The God Admin dashboard answers "who cloned what, when, and how
 *   did it end" by scanning `audit_logs`. Every clone job writes TWO
 *   rows to that table:
 *
 *     `clone_pro.started`            — POST /start creates the job row
 *     `clone_pro.succeeded`          — runner reached clean success
 *     `clone_pro.succeeded_partial`  — succeeded with 1+ non-fatal stage failures
 *     `clone_pro.failed`             — pipeline threw / fatal stage crashed
 *
 *   `details` carries the structured context (job_id, source_url,
 *   scope, duration_ms, failed_stages, error_message) so auditors
 *   don't have to join through `storefront_clone_jobs` to reconstruct
 *   the story — the audit row stands alone.
 *
 * Design:
 *   - `resource_type` is always `'storefront_clone_job'` and
 *     `resource_id` is always the job uuid. Lets `SELECT * FROM
 *     audit_logs WHERE resource_id = ?` return the full timeline
 *     for a single job (start + terminal) in two rows.
 *   - `details` is JSON-stringified before insert. Kysely's JSONB
 *     column accepts both string and object, but stringifying here
 *     keeps the wire format explicit and aligns with every other
 *     call site in the codebase (see apps/store-admin products.ts
 *     and apps/god-admin/pages/*).
 *   - Write failures are SWALLOWED — losing an audit row is strictly
 *     preferable to failing an HTTP request or a BullMQ job because
 *     the audit insert hit a transient lock. The loss is logged via
 *     `console.error` so operators can spot it in the API logs.
 *   - All optional fields record `null` (not `undefined`) so the God
 *     Admin query doesn't have to distinguish "we didn't measure
 *     this" from "the caller forgot to pass it". Consistency first.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

/**
 * Context captured when POST /clone-pro/start creates a job row.
 *
 * `userId` is nullable because anonymous backfills + legacy enqueues
 * don't have a logged-in user attached. `canonicalDomain` is nullable
 * because URL canonicalisation may fail (non-http scheme, garbage
 * input, etc.) and an audit row is still more useful than no audit
 * row. `ipAddress` is optional — only the HTTP layer has it.
 */
export interface LogCloneStartedInput {
  readonly shopId: string
  readonly userId?: string | null
  readonly jobId: string
  readonly sourceUrl: string
  readonly canonicalDomain?: string | null
  readonly scope: Record<string, boolean>
  readonly ipAddress?: string | null
}

/**
 * Context captured when the runner writes the terminal job row.
 *
 * All measurement fields are optional because legacy pipelines may
 * not produce them — in that case we record `null`. The status
 * string drives the action column (`clone_pro.<status>`) and MUST
 * match one of the `StorefrontCloneJobStatus` terminal values.
 */
export interface LogCloneTerminalInput {
  readonly shopId: string
  readonly jobId: string
  readonly status: 'succeeded' | 'succeeded_partial' | 'failed'
  readonly durationMs?: number | null
  readonly productsImported?: number | null
  readonly pagesImported?: number | null
  readonly failedStages?: readonly string[] | null
  readonly errorMessage?: string | null
}

/**
 * Insert a `clone_pro.started` row into `audit_logs`.
 *
 * Best-effort: any DB error is logged via `console.error` and
 * swallowed. The HTTP handler must NOT fail POST /start because an
 * audit insert hit a transient lock — the job row itself already
 * persisted the ground-truth state.
 */
export async function logCloneStarted(
  db: Kysely<Database>,
  input: LogCloneStartedInput,
): Promise<void> {
  const details = {
    job_id: input.jobId,
    source_url: input.sourceUrl,
    canonical_domain: input.canonicalDomain ?? null,
    scope: input.scope,
  }
  try {
    await db
      .insertInto('audit_logs')
      .values({
        shop_id: input.shopId,
        user_id: input.userId ?? null,
        action: 'clone_pro.started',
        resource_type: 'storefront_clone_job',
        resource_id: input.jobId,
        details: JSON.stringify(details),
        ip_address: input.ipAddress ?? null,
      } as any)
      .execute()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[clone-pro audit] logCloneStarted insert failed:',
      (err as Error).message,
    )
  }
}

/**
 * Insert a `clone_pro.<status>` row into `audit_logs` at the runner's
 * terminal branch. Called from all three terminal paths (succeeded,
 * succeeded_partial, failed) so the God Admin has exactly one
 * terminal row per job regardless of outcome.
 *
 * Best-effort: swallows DB errors for the same reason as
 * `logCloneStarted` — an audit miss must never fail a BullMQ job.
 */
export async function logCloneTerminal(
  db: Kysely<Database>,
  input: LogCloneTerminalInput,
): Promise<void> {
  const details = {
    job_id: input.jobId,
    status: input.status,
    duration_ms: input.durationMs ?? null,
    products_imported: input.productsImported ?? null,
    pages_imported: input.pagesImported ?? null,
    failed_stages: input.failedStages ?? null,
    error_message: input.errorMessage ?? null,
  }
  try {
    await db
      .insertInto('audit_logs')
      .values({
        shop_id: input.shopId,
        user_id: null,
        action: `clone_pro.${input.status}`,
        resource_type: 'storefront_clone_job',
        resource_id: input.jobId,
        details: JSON.stringify(details),
        ip_address: null,
      } as any)
      .execute()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[clone-pro audit] logCloneTerminal insert failed:',
      (err as Error).message,
    )
  }
}
