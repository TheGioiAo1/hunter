/**
 * Design Library — clone-pro emit hook (Phase D2).
 *
 * Writes a `design_library_entries` row with `source='clone'` every
 * time a clone-pro pipeline run completes successfully. The D4
 * gallery reads those rows for the "My Clones" tab.
 *
 * Why this lives in design-library (not clone-pro):
 * --------------------------------------------------
 * The hook is a design-library feature — it knows how to build the
 * slug, serialize the markdown, and map extraction output to the
 * gallery row. clone-pro's pipeline.ts imports this as a one-liner
 * and stays focused on the clone pipeline itself.
 *
 * Why it takes a bag of fields instead of CloneProConfig:
 * -------------------------------------------------------
 * We DELIBERATELY don't import CloneProConfig here. The design-library
 * module already depends on the `ExtractedDesign` type from clone-pro
 * (necessary for the serializer), and we want to keep that coupling
 * one-way — clone-pro pushes data in; design-library never reaches
 * back to pull clone-pro internals.
 *
 * Failure semantics:
 * ------------------
 * Errors from `serializeCloneDesign` + `insertCloneEntry` are CAUGHT
 * and LOGGED, never rethrown. The clone itself already succeeded by
 * the time this hook fires, and the gallery is a secondary surface.
 * A duplicate-slug conflict (partial unique index
 * `idx_design_library_clone_slug`) is the most likely trip — that's
 * an expected idempotency signal when the pipeline retries a
 * completed job, not a user-facing bug.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ExtractedDesign } from '../clone-pro/types.js'
import { deriveCloneSlug } from './clone-slug.js'
import { serializeCloneDesign } from './serialize-design-md.js'
import { insertCloneEntry } from './upsert.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CloneEmitInput {
  /**
   * Design tokens extracted by the clone-pro `extract_design` stage.
   * `undefined` means the stage was skipped or non-fatally failed —
   * in that case we skip the emit entirely rather than stamp a stub
   * row (the gallery card would be useless without palette + layout
   * data).
   */
  readonly design: ExtractedDesign | undefined
  /** The URL the merchant cloned. */
  readonly sourceUrl: string
  /** Shop that owns this clone (FK into `shops.id`). */
  readonly shopId: string
  /**
   * `storefront_clone_jobs.id`. Production runner.ts always sets it.
   * When undefined we skip the emit — it means the caller bypassed
   * the job-row machinery (test harness, internal tool) and doesn't
   * want gallery rows.
   */
  readonly jobId: string | undefined
  /**
   * Theme produced by the `generate_theme` stage. Stored as
   * `source_theme_id` on the gallery row so the D4 "Apply" action
   * knows which theme to clone into a new store.
   */
  readonly themeId: string | undefined
}

/**
 * Best-effort write of a `design_library_entries` row for a completed
 * clone. Returns `{emitted: true, slug}` on success, `{emitted: false,
 * reason}` on skip. Errors from the DB write are caught and logged —
 * callers should treat this as fire-and-forget.
 */
export async function emitCloneEntry(
  db: Kysely<Database>,
  input: CloneEmitInput,
): Promise<EmitCloneEntryResult> {
  if (!input.design) {
    const reason = 'design-not-extracted'
    console.log(`[design-library] skipping emit — ${reason}`)
    return { emitted: false, reason }
  }
  if (!input.jobId) {
    const reason = 'no-job-id'
    console.log(`[design-library] skipping emit — ${reason}`)
    return { emitted: false, reason }
  }

  const slug = deriveCloneSlug(input.sourceUrl, input.jobId)
  try {
    const { designMd, title, summary } = serializeCloneDesign({
      design: input.design,
      sourceUrl: input.sourceUrl,
    })
    await insertCloneEntry(db, {
      slug,
      shopId: input.shopId,
      title,
      summary,
      designMd,
      // D3 renders + persists the HTML preview files asynchronously so
      // clone latency isn't bloated by a 200 KB preview blob. The
      // gallery card renders from DESIGN.md until D3 fills these in.
      previewHtml: null,
      previewDarkHtml: null,
      sourceThemeId: input.themeId ?? null,
      sourceCloneJobId: input.jobId,
    })
    console.log(
      `[design-library] emitted clone entry slug=${slug} shop=${input.shopId}`,
    )
    return { emitted: true, slug }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(
      `[design-library] emit failed (non-fatal) for shop=${input.shopId} ` +
        `jobId=${input.jobId} slug=${slug}: ${message}`,
    )
    return { emitted: false, reason: 'insert-failed', error: message }
  }
}

export type EmitCloneEntryResult =
  | { readonly emitted: true; readonly slug: string }
  | {
      readonly emitted: false
      readonly reason: 'design-not-extracted' | 'no-job-id' | 'insert-failed'
      readonly error?: string
    }
