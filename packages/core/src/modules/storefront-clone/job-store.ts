/**
 * Gbox Platform — Storefront Clone Job Store
 *
 * Thin CRUD wrapper over the `storefront_clone_jobs` table. The
 * orchestrator (`run.ts`) appends stage entries as each pipeline
 * step completes; the HTTP layer polls / streams the same rows
 * back to the client via SSE.
 *
 * Design notes:
 *
 *   - `stages_json` is an append-only array. Each entry is one
 *     pipeline stage (theme, products, sitemap, media, seo,
 *     brand_kit). We never mutate past entries, only push new ones.
 *     This makes the SSE replay trivial: clients get the full list
 *     on connect, then listen for new tail entries.
 *
 *   - `progress_pct` is derived from stage completion: theme=15,
 *     products=45, sitemap=60, media=80, seo=90, brand_kit=100.
 *     The orchestrator writes this directly so the client doesn't
 *     need to compute it.
 *
 *   - `result_json` is populated ONLY when the job transitions to
 *     `succeeded`. On failure, `error_code` + `error_message` are
 *     set instead.
 *
 *   - The job store is DB-only. It never touches Redis, S3, or
 *     the crawler. Callers own the orchestration.
 */

import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  Database,
  StorefrontCloneJobTable,
  CloneJobStageEntry,
} from '@gbox/db/schema/tables.js';
import { canonicalDomainFromUrl } from './canonical-domain.js';

export type StorefrontCloneJobRow = Selectable<StorefrontCloneJobTable>;

export type StorefrontCloneJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  /**
   * Phase 7 Step 7.5 — pipeline reached the end but at least one
   * non-fatal stage (see pipeline.ts `NON_FATAL_STAGES`) captured a
   * failure into `stages_json`. Treated as a soft-success by the UI
   * (job is done, content is in the DB) but the bell-icon fires a
   * `clone_pro_partial` notification so the merchant knows some data
   * may be missing. DB-wise this is still a terminal state — no more
   * transitions happen after it lands.
   */
  | 'succeeded_partial'
  | 'failed'
  | 'cancelled';

export interface CreateCloneJobInput {
  readonly shopId: string;
  readonly sourceUrl: string;
  readonly createdBy?: string | null;
}

export interface UpdateCloneJobInput {
  readonly status?: StorefrontCloneJobStatus;
  readonly progressPct?: number;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly resultJson?: unknown;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  /**
   * Live human-readable string the SSE endpoint emits as `message`
   * events. Written on every runner `onProgress` tick. See migration
   * 037 for rationale (dedicated column vs. stages_json blow-up).
   */
  readonly currentMessage?: string | null;
  // Dashboard UI columns (migration 038). Written by the runner as it
  // transitions between phases so the detail page's stepper + phase
  // hero reflect reality. Without these, the UI stays stuck at
  // "phase 0" even when the job has succeeded.
  readonly currentPhase?: number | null;
  readonly phaseProgressPct?: number | null;
  readonly substep?: string | null;
  readonly grade?: string | null;
  readonly score?: number | null;
  readonly pageCount?: number | null;
  readonly publishedAt?: string | null;
  /**
   * Phase 4.1 — Clone Library: id of the theme row this job produced.
   * Lets the Library render "one card per job" with the theme preview
   * attached. Written exactly once, by the runner, after the pipeline
   * returns its ClonePipelineResult.
   */
  readonly themeId?: string | null;
  /**
   * Phase 19 PR1 (Clone Pro v5) — mounted preview subdomain URL. Set
   * once by the v5 wired-runner after phase ⑦ (preview mount).
   * Dedicated column (migration 038) so list views can surface the URL
   * without parsing `result_json`.
   */
  readonly previewUrl?: string | null;
  /**
   * Phase 19 PR1 (Clone Pro v5) — serialised DESIGN.md export. Stored
   * on the job row so admins can download the awesome-claude-design
   * compatible markdown without replaying the pipeline.
   */
  readonly designMd?: string | null;
}

/**
 * Insert a new clone job row in `queued` state. Returns the full row.
 *
 * `canonical_domain` is computed from `input.sourceUrl` and stamped on
 * the row so the Phase-6 UNIQUE index (`idx_clone_jobs_shop_domain_active`
 * from migration 045) has a value to dedupe on. Previously this column
 * was only backfilled by migration 041 — new rows landed with NULL and
 * escaped the domain dedupe constraint entirely.
 *
 * If the URL is unparseable or uses a non-http(s) scheme the helper
 * returns null and we persist NULL. The partial UNIQUE index is
 * `WHERE canonical_domain IS NOT NULL` so these legacy-shape rows stay
 * exempt from the dedupe rule.
 */
export async function createStorefrontCloneJob(
  db: Kysely<Database>,
  input: CreateCloneJobInput,
): Promise<StorefrontCloneJobRow> {
  const canonicalDomain = canonicalDomainFromUrl(input.sourceUrl);
  const row = await db
    .insertInto('storefront_clone_jobs')
    .values({
      shop_id: input.shopId,
      source_url: input.sourceUrl,
      created_by: input.createdBy ?? null,
      // status, stages_json, progress_pct, created_at all have DB defaults
      stages_json: JSON.stringify([]),
      // canonical_domain (migration 041) — stamped here so the Phase 6
      // UNIQUE index has a dedupe value on every new row. Pre-041
      // installs that didn't have the column will error; we cast
      // through `as any` to keep the insert compiling against older
      // type rolls while staying safe at runtime.
      ...(canonicalDomain ? { canonical_domain: canonicalDomain } : {}),
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as StorefrontCloneJobRow;
}

/**
 * Fetch a single job by id scoped to a shop. Returns null if not
 * found (keeps the HTTP layer free of 404 try/catch boilerplate).
 */
export async function getStorefrontCloneJob(
  db: Kysely<Database>,
  params: { readonly shopId: string; readonly jobId: string },
): Promise<StorefrontCloneJobRow | null> {
  const row = await db
    .selectFrom('storefront_clone_jobs')
    .selectAll()
    .where('id', '=', params.jobId)
    .where('shop_id', '=', params.shopId)
    .executeTakeFirst();
  return (row ?? null) as StorefrontCloneJobRow | null;
}

/**
 * List recent jobs for a shop, newest first. Used by the admin UI
 * to show the clone history panel.
 */
export async function listStorefrontCloneJobs(
  db: Kysely<Database>,
  params: { readonly shopId: string; readonly limit?: number },
): Promise<readonly StorefrontCloneJobRow[]> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const rows = await db
    .selectFrom('storefront_clone_jobs')
    .selectAll()
    .where('shop_id', '=', params.shopId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  return rows as readonly StorefrontCloneJobRow[];
}

/**
 * Patch-style update. Only fields present in `patch` are written.
 * Callers typically use this to transition state: queued → running
 * → succeeded/failed.
 */
export async function updateStorefrontCloneJob(
  db: Kysely<Database>,
  jobId: string,
  patch: UpdateCloneJobInput,
): Promise<StorefrontCloneJobRow> {
  const values: Record<string, unknown> = {};
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.progressPct !== undefined) {
    values.progress_pct = clampProgress(patch.progressPct);
  }
  if (patch.startedAt !== undefined) values.started_at = patch.startedAt;
  if (patch.finishedAt !== undefined) values.finished_at = patch.finishedAt;
  if (patch.resultJson !== undefined) {
    values.result_json =
      patch.resultJson === null ? null : JSON.stringify(patch.resultJson);
  }
  if (patch.errorCode !== undefined) values.error_code = patch.errorCode;
  if (patch.errorMessage !== undefined) values.error_message = patch.errorMessage;
  if (patch.currentMessage !== undefined) values.current_message = patch.currentMessage;
  if (patch.currentPhase !== undefined) values.current_phase = patch.currentPhase;
  if (patch.phaseProgressPct !== undefined) {
    values.phase_progress_pct = clampProgress(patch.phaseProgressPct ?? 0);
  }
  if (patch.substep !== undefined) values.substep = patch.substep;
  if (patch.grade !== undefined) values.grade = patch.grade;
  if (patch.score !== undefined) values.score = patch.score;
  if (patch.pageCount !== undefined) values.page_count = patch.pageCount;
  if (patch.publishedAt !== undefined) values.published_at = patch.publishedAt;
  if (patch.themeId !== undefined) values.theme_id = patch.themeId;
  if (patch.previewUrl !== undefined) values.preview_url = patch.previewUrl;
  if (patch.designMd !== undefined) values.design_md = patch.designMd;

  if (Object.keys(values).length === 0) {
    // No-op update — return the current row rather than issuing an
    // empty SQL UPDATE (which some drivers reject).
    const current = await db
      .selectFrom('storefront_clone_jobs')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    return current as StorefrontCloneJobRow;
  }

  const row = await db
    .updateTable('storefront_clone_jobs')
    .set(values)
    .where('id', '=', jobId)
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as StorefrontCloneJobRow;
}

/**
 * Append a stage entry to `stages_json` atomically.
 *
 * Postgres JSONB can do `stages_json || '[new]'::jsonb` server-side,
 * which is safer than read-modify-write because it doesn't race with
 * the SSE poller. We build the raw SQL fragment through Kysely's sql
 * helper so the values stay parameterised.
 */
export async function appendCloneJobStage(
  db: Kysely<Database>,
  jobId: string,
  stage: CloneJobStageEntry,
): Promise<StorefrontCloneJobRow> {
  const stageJson = JSON.stringify([stage]);
  const row = await db
    .updateTable('storefront_clone_jobs')
    .set({
      // stages_json is typed as JsonB — we cast via raw sql to concat.
      stages_json: sql`stages_json || ${stageJson}::jsonb` as never,
    })
    .where('id', '=', jobId)
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as StorefrontCloneJobRow;
}

/**
 * Read-only helper: parse the `stages_json` column into typed entries.
 * Handles the case where the DB driver returns a string vs already
 * a parsed object (pg + Kysely default to parsing JSONB automatically,
 * but some transport layers — e.g. MSSQL-in-dev or replay fixtures —
 * return it as a string).
 */
export function readStages(
  row: Pick<StorefrontCloneJobRow, 'stages_json'>,
): readonly CloneJobStageEntry[] {
  const raw = row.stages_json as unknown;
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as readonly CloneJobStageEntry[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function clampProgress(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return Math.round(pct);
}
