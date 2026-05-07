/**
 * Clone Pro v4 — Phase 3 (Verification) Orchestrator
 *
 * Wires the five individual checks together, reads the persisted theme
 * assets from the database so every input is realistic (not "what Phase 2
 * claimed"), and emits a `VerificationReport`.
 *
 * Why re-read theme assets instead of trusting the in-memory output from
 * `ExecutionResult`? A verification pass is most useful when it can run
 * against the shipped state — i.e. what a storefront request will
 * actually render. That also makes the function resumable: we can verify
 * a prior clone any time, no Phase 2 context required beyond a shopId.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { DiscoveryResult } from '../pipeline-v4.js'
import type { ExecutionResult } from '../execution-v4.js'
import type {
  CheckCategory,
  CheckResult,
  VerificationReport,
} from './types.js'

import { runRouteCheck } from './route-check.js'
import { runAssetCheck } from './asset-check.js'
import { runContentCheck } from './content-check.js'
import { runDependencyCheck } from './dependency-check.js'
import { runCssMatchCheck } from './css-match.js'
import { buildVerificationReport } from './report.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunVerificationInput {
  readonly db: Kysely<Database>
  readonly shopId: string
  readonly sourceUrl?: string
  readonly discovery: DiscoveryResult
  readonly execution: ExecutionResult
  /**
   * Optional — when provided, we use these URLs for the per-tier
   * asset-coverage score instead of the flat downloaded/failed ratio.
   * Phase 2 builds this set as a side-effect of the asset downloader's
   * rewriteMap.
   */
  readonly downloadedAssetUrls?: ReadonlySet<string>
  /** Progress callback for UI streaming. */
  readonly onProgress?: (pct: number, message: string) => void
}

export async function runVerification(
  input: RunVerificationInput,
): Promise<VerificationReport> {
  const started = Date.now()
  input.onProgress?.(0, 'Verification: loading theme assets...')

  // ── Load persisted theme templates for this shop ─────────────────────
  const templates = await loadPersistedTemplates(input.db, input.shopId)
  const writtenKeys = Object.keys(templates)
  input.onProgress?.(20, `Verification: loaded ${writtenKeys.length} templates.`)

  const checks = {} as Record<CheckCategory, CheckResult>

  // ── 3.1 Route coverage ──────────────────────────────────────────────
  input.onProgress?.(30, 'Verification: checking route coverage...')
  checks.route = runRouteCheck({
    discovery: input.discovery,
    writtenTemplateKeys: writtenKeys,
  })

  // ── 3.2 Asset integrity ─────────────────────────────────────────────
  input.onProgress?.(45, 'Verification: checking asset integrity...')
  checks.asset = runAssetCheck({
    inventory: input.discovery.assets,
    stats: {
      assetsDownloaded: input.execution.assetsDownloaded,
      assetsFailed: input.execution.assetsFailed,
      totalAssetBytes: input.execution.totalAssetBytes,
    },
    downloadedUrls: input.downloadedAssetUrls,
  })

  // ── 3.3 Content completeness ────────────────────────────────────────
  input.onProgress?.(60, 'Verification: checking content completeness...')
  checks.content = await runContentCheck({
    db: input.db,
    shopId: input.shopId,
    discoveredPages: input.discovery.pages,
    executionStats: {
      pagesImported: input.execution.pagesImported,
      blogPostsImported: input.execution.blogPostsImported,
      collectionsImported: input.execution.collectionsImported,
    },
  })

  // ── 3.4 External dependency audit ───────────────────────────────────
  input.onProgress?.(75, 'Verification: auditing external dependencies...')
  checks.dependency = runDependencyCheck({
    templates,
    sourceOrigin: input.sourceUrl,
  })

  // ── 3.5 CSS class match score ───────────────────────────────────────
  input.onProgress?.(90, 'Verification: computing CSS class match score...')
  checks['css-match'] = runCssMatchCheck({
    templates: input.discovery.templates.templates,
    writtenTemplates: templates,
  })

  // ── 3.6 Final report ────────────────────────────────────────────────
  input.onProgress?.(98, 'Verification: compiling final report...')
  const report = buildVerificationReport({
    checks,
    durationMs: Date.now() - started,
    shopId: input.shopId,
    sourceUrl: input.sourceUrl,
  })
  input.onProgress?.(100, `Verification complete: grade ${report.grade} (${report.overallScore}/100).`)
  return report
}

// ---------------------------------------------------------------------------
// DB loader
// ---------------------------------------------------------------------------

/**
 * Read every text template asset for the shop's main theme. Binary
 * assets (fonts/images) are excluded — dependency/CSS-match checks only
 * care about template source.
 *
 * Returns an empty object if no theme exists for the shop (which still
 * lets verification run end-to-end — the findings will explain).
 */
async function loadPersistedTemplates(
  db: Kysely<Database>,
  shopId: string,
): Promise<Record<string, string>> {
  // Newest main theme wins if there are multiple.
  const theme = await db
    .selectFrom('themes')
    .select(['id'])
    .where('shop_id', '=', shopId)
    .where('role', '=', 'main')
    .orderBy('created_at desc')
    .executeTakeFirst()

  if (!theme) return {}

  const rows = await db
    .selectFrom('theme_assets')
    .select(['key', 'value'])
    .where('theme_id', '=', theme.id)
    .execute()

  const out: Record<string, string> = {}
  for (const row of rows) {
    if (row.value == null) continue
    // Skip binary assets — they're base64 blobs and we'd blow up parsing
    // them as HTML. Binaries are always under assets/, and we want to
    // only look at the Liquid side of the theme anyway.
    if (row.key.startsWith('assets/') && !row.key.endsWith('.css') && !row.key.endsWith('.js') && !row.key.endsWith('.liquid')) {
      continue
    }
    out[row.key] = row.value
  }
  return out
}
