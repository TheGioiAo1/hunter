/**
 * Clone Pro v7 — Production dependency factory.
 *
 * Sprint 2 Task 2.6 (+ Sprint 5 follow-up wiring).
 *
 * `buildV7Deps(db)` wires real implementations of the v6 stages 1-3 + 5-10 + 12
 * (DRY) plus the v7-only overrides into a `V7Deps` object ready for
 * `runCloneProV7`. The v6 `buildV6Deps` is the source of truth for the
 * unchanged stages; we override the four v7-specific slots:
 *
 *   • Stage 4   — `runStage4Lonspy` (Lonspy XPath bulk crawler)
 *   • Stage 7   — `runPersisters` reroutes the products bucket to
 *                 `productsPersisterV7` (OVERWRITE re-clone semantics
 *                 via migration 103). Other buckets keep v6 behaviour.
 *   • Stage 11  — `autoPublish` reroutes through `runStage11V7` so the
 *                 successful publish ALSO deploys the rendered theme.zip
 *                 onto Server 3 + flips `theme_loader_version=v2`.
 *
 * Iron Rule 5: this module never composes seller-facing strings.
 * Worker logs (console.warn) are the only side channel; the orchestrator
 * + worker scrub diagnostics through `safeMessage()` at the seller
 * boundary.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { buildV6Deps } from '../v6/deps.js'
import { runPersisters as runV6Persisters } from '../v6/stages/stage7-persisters.js'
import { collectionsPersister } from '../v6/persisters/collections.js'
import { pagesPersister } from '../v6/persisters/pages.js'
import { blogPostsPersister } from '../v6/persisters/blog-posts.js'
import { menusPersister } from '../v6/persisters/menus.js'
import { themeTokensPersister } from '../v6/persisters/theme-tokens.js'
import { themeFilesPersister } from '../v6/persisters/theme-files.js'
import { urlRedirectsPersister } from '../v6/persisters/url-redirects.js'
import { genericMediaPersister } from '../v6/persisters/generic-media.js'
import { runStage4LonspyBulk } from './stages/stage4-lonspy-bulk.js'
import { productsPersisterV7 } from './persisters/products-persister.js'
import { runStage11V7 } from './stages/stage11-auto-publish.js'
import { CloneProCostTracker } from './cost-budget.js'
import { defaultDeployTheme } from './theme-deploy/default-deploy-theme.js'
import type { V7Deps } from './orchestrator.js'

/**
 * Optional injection points the worker layer can supply to swap in real
 * S3/SSH/Anthropic implementations without bleeding those concerns into
 * the orchestrator.
 *
 *   • `themeZipS3KeyResolver` — invoked by the v7 Stage 11 wrapper at
 *     publish time. If it returns a non-null key, the wrapper deploys
 *     theme.zip onto Server 3 and flips `theme_loader_version=v2`. The
 *     worker writes to this resolver after Stage 15 finishes; otherwise
 *     it stays null and Stage 11 publishes the catalog without a
 *     v7-generated theme (fallback to the shop's pre-clone theme).
 *   • `deployTheme` — defaults to a no-op shim. The worker swaps in a
 *     real `bash scripts/deploy-theme-v7.sh` SSH bridge for production.
 */
export interface BuildV7DepsOptions {
  themeZipS3KeyResolver?: (input: { jobId: string; shopId: string }) => string | null
  deployTheme?: (input: { shopId: string; themeZipS3Key: string }) => Promise<void>
  /**
   * Optional pre-constructed cost tracker. If absent, `buildV7Deps`
   * creates a default tracker that reads `MAX_CLONE_PRO_V7_USD`. The
   * worker passes the same instance to Stage 14 + Stage 16 invocations
   * (those run outside the orchestrator's 12-stage pipeline) so all
   * AI spend rolls up to one budget per job.
   */
  tracker?: CloneProCostTracker
}

/**
 * Build the V7 dependency bundle for a single clone job.
 *
 * Stage 4 substitution: instead of v6's `dispatchScrapers` (AI Sonnet
 * bucket scrapers), we provide `runStage4Lonspy` which dispatches the
 * Lonspy XPath bulk crawler + persists `clone_crawl_runs` audit row +
 * enforces the 0.95 quality gate.
 */
export function buildV7Deps(
  db: Kysely<Database>,
  options: BuildV7DepsOptions = {},
): V7Deps {
  // Reuse the v6 deps for stages 1-3 + 5-12 (DRY). The v6 deps shape is
  // a superset of what v7 needs — we just don't expose `dispatchScrapers`
  // (replaced by `runStage4Lonspy`).
  const v6 = buildV6Deps(db)

  // Reuse caller-supplied tracker so the worker can persist final
  // tracker.getSpentUsd() into clone_crawl_runs.cost_usd at finalize.
  const tracker = options.tracker ?? new CloneProCostTracker()

  return {
    db,
    tracker,

    // ── Stage 1-3 (v6 unchanged) ────────────────────────────────────
    discoverUrls: v6.discoverUrls,
    classifyUrls: v6.classifyUrls,
    renderUrls: v6.renderUrls,

    // ── Stage 4 (v7-only — Lonspy bulk crawl) ───────────────────────
    runStage4Lonspy: ({ jobId, sourceUrl, productsLimit }) =>
      runStage4LonspyBulk({
        jobId,
        sourceUrl,
        productsLimit,
        db,
      }),

    // ── Stage 5-6 (v6 unchanged) ────────────────────────────────────
    buildAssetGraph: v6.buildAssetGraph,
    downloadAssets: v6.downloadAssets,

    // ── Stage 7 (v7 override — products via productsPersisterV7) ───
    // Reroute only the products bucket to the OVERWRITE-aware v7
    // persister; the other buckets keep their v6 behaviour. Migration
    // 103 + Sprint 5 Task 5.6: re-clone replaces the catalog, doesn't
    // patch it.
    runPersisters: ({ shopId, jobId, dtos }) =>
      runV6Persisters({
        db,
        shopId,
        jobId,
        dtos,
        registry: {
          products: productsPersisterV7,
          collections: collectionsPersister,
          pages: pagesPersister,
          blogPosts: blogPostsPersister,
          menus: menusPersister,
          themeTokens: themeTokensPersister,
          themeFiles: themeFilesPersister,
          urlRedirects: urlRedirectsPersister,
          genericMedia: genericMediaPersister,
        },
      }),

    // ── Stage 8-10 (v6 unchanged) ───────────────────────────────────
    applyRewriter: v6.applyRewriter,
    verifyNoLeaks: v6.verifyNoLeaks,
    runVerification: v6.runVerification,
    computeGrade: v6.computeGrade,

    // ── Stage 11 (v7 override — wraps v6 publish + deploys theme) ───
    // Sprint 5 Task 5.3: after the v6 publish flips status='published',
    // we also deploy theme.zip to Server 3 and flip theme_loader_version
    // to 'v2'. The v6 `autoPublish` is reused as the inner publish
    // primitive; the v7 wrapper adds the two side-effects when the
    // worker has supplied a `themeZipS3KeyResolver` that returns
    // non-null (i.e. Stage 15 already produced a theme bundle).
    autoPublish: ({ jobId, shopId, gradeLetter }) => {
      const themeZipS3Key =
        options.themeZipS3KeyResolver?.({ jobId, shopId }) ?? null
      return runStage11V7({
        jobId,
        shopId,
        gradeLetter,
        themeZipS3Key,
        runV6Publish: v6.autoPublish,
        deployTheme: options.deployTheme ?? defaultDeployTheme,
        flipThemeLoaderVersion: defaultFlipThemeLoaderVersion(db),
      }).then((r) => ({ published: r.published, reason: r.reason }))
    },

    // ── Stage 12 (v6 unchanged) ─────────────────────────────────────
    finalize: v6.finalize,

    // ── Progress + stage emitters (v6 unchanged) ────────────────────
    emitProgress: v6.emitProgress,
    emitStage: v6.emitStage,
  }
}

// ---------------------------------------------------------------------------
// Stage 11 v7 default sub-dep wiring
// ---------------------------------------------------------------------------

/**
 * Default `theme_loader_version` flip — UPSERTs the row into
 * `shop_settings(shop_id, key='theme_loader_version', value=<version>)`.
 * The storefront DbLoader v2 reads this on next request to switch
 * between v1 (legacy theme_assets) and v2 (theme_files). Failures
 * propagate so `runStage11V7` can surface them as warnings.
 */
function defaultFlipThemeLoaderVersion(db: Kysely<Database>) {
  return async (input: { shopId: string; version: 'v1' | 'v2' }): Promise<void> => {
    await (db as any)
      .insertInto('shop_settings')
      .values({
        shop_id: input.shopId,
        key: 'theme_loader_version',
        value: JSON.stringify(input.version),
      })
      .onConflict((oc: any) =>
        oc.columns(['shop_id', 'key']).doUpdateSet({
          value: JSON.stringify(input.version),
          updated_at: new Date().toISOString(),
        }),
      )
      .execute()
  }
}
