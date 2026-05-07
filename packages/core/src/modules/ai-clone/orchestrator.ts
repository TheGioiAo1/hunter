/**
 * Gbox Platform — AI Clone orchestrator
 * (Landing Page System Phase 2.4)
 *
 * The glue that runs the full clone pipeline end-to-end:
 *
 *   URL paste
 *     │
 *     ▼
 *   1. crawl()                  → HTML + combined CSS (from crawler.ts)
 *     │
 *     ▼
 *   2. buildCloneReport()       → deterministic palette/fonts/sections
 *                                  (from themes/cloner.ts)
 *     │
 *     ▼
 *   3. enhanceThemeSpec()       → Claude Opus 4.6 enrichment
 *                                  (from theme-spec.ts, via injected sender)
 *     │
 *     ▼
 *   4. generateBundleFromSpec() → customised ThemeBundleFiles + meta
 *                                  (from bundle-generator.ts)
 *     │
 *     ▼
 *   5. createTheme() + per-file updateThemeAsset()
 *                                → persisted in themes + theme_assets;
 *                                  large files promoted to R2/S3 via
 *                                  the injected objectStore.
 *     │
 *     ▼
 *   6. CloneOrchestratorResult  → themeId + summary the admin UI renders.
 *
 * Everything the orchestrator depends on is INJECTED — db, objectStore,
 * fetchImpl, aiSender, logger — so:
 *
 *   - the admin Express handler wires the real `createDb()`,
 *     `R2Store`, `globalThis.fetch`, `sendChat`, and a JSON logger;
 *   - tests wire an in-memory fake for each and verify the full
 *     pipeline without touching the network or a database.
 *
 * Fault tolerance:
 *
 *   - If the crawler returns empty HTML we stop BEFORE billing an
 *     Opus request. The caller gets `{ ok: false, code: 'crawl_failed' }`
 *     and can surface the warnings to the merchant.
 *
 *   - If Opus returns garbage the theme-spec parser falls back to
 *     CloneReport defaults — the pipeline still produces a valid
 *     theme, just less personalised. Warnings are propagated.
 *
 *   - If `updateThemeAsset` fails mid-loop we delete the half-built
 *     theme so the merchant's theme list doesn't have a zombie row.
 *     The error is returned, not thrown.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { buildCloneReport } from '../themes/cloner.js'
import {
  createTheme,
  deleteTheme,
  updateThemeAsset,
  type Theme,
} from '../themes/service.js'
import type { AssetStorageDeps } from '../themes/asset-storage.js'
import { crawl, type CrawlWarning } from './crawler.js'
import {
  enhanceThemeSpec,
  type AiSender,
  type ThemeSpec,
} from './theme-spec.js'
import {
  generateBundleFromSpec,
  type GenerateBundleResult,
} from './bundle-generator.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CloneOrchestratorLogger {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

const NOOP_LOGGER: CloneOrchestratorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface CloneOrchestratorOptions {
  /** Injected fetch for the crawler. */
  fetchImpl: typeof fetch
  /** Injected Opus sender (wraps `sendChat` in production). */
  aiSender: AiSender
  /** ObjectStore deps for large asset uploads (R2 / S3). */
  assetStorage?: AssetStorageDeps
  /** Crawler overrides. */
  maxResourceBytes?: number
  maxTotalBytes?: number
  maxStylesheets?: number
  /** AI sender overrides. */
  aiModel?: string
  aiMaxTokens?: number
  aiTemperature?: number
  /** Structured logger (info / warn / error). Default no-op. */
  logger?: CloneOrchestratorLogger
}

export interface CloneOrchestratorInput {
  /** Shop owner the theme will belong to. */
  shopId: string
  /** Merchant-supplied reference URL to clone. */
  url: string
  /** Optional merchant hint forwarded to Opus. */
  merchantHint?: string
}

export type CloneFailureCode =
  | 'invalid_url'
  | 'crawl_failed'
  | 'ai_request_failed'
  | 'generator_failed'
  | 'persist_failed'

export interface CloneOrchestratorFailure {
  ok: false
  code: CloneFailureCode
  message: string
  warnings: string[]
  /** Populated when we rolled back a half-built theme. */
  rolledBackThemeId?: string
}

export interface CloneOrchestratorSuccess {
  ok: true
  theme: Theme
  spec: ThemeSpec
  bundleResult: GenerateBundleResult
  crawlWarnings: CrawlWarning[]
  aiWarnings: string[]
  filesWritten: number
}

export type CloneOrchestratorResult =
  | CloneOrchestratorSuccess
  | CloneOrchestratorFailure

// ---------------------------------------------------------------------------
// runCloneOrchestrator — public entry point
// ---------------------------------------------------------------------------

export async function runCloneOrchestrator(
  db: Kysely<Database>,
  input: CloneOrchestratorInput,
  opts: CloneOrchestratorOptions,
): Promise<CloneOrchestratorResult> {
  const logger = opts.logger ?? NOOP_LOGGER
  const warnings: string[] = []

  // ----- 1. Crawl ---------------------------------------------------------

  let crawlResult
  try {
    crawlResult = await crawl(input.url, {
      fetchImpl: opts.fetchImpl,
      maxResourceBytes: opts.maxResourceBytes,
      maxTotalBytes: opts.maxTotalBytes,
      maxStylesheets: opts.maxStylesheets,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('clone.invalid_url', { url: input.url, message })
    return {
      ok: false,
      code: 'invalid_url',
      message,
      warnings,
    }
  }

  if (!crawlResult.html || crawlResult.html.length === 0) {
    logger.error('clone.crawl_failed', {
      url: input.url,
      warnings: crawlResult.warnings,
    })
    return {
      ok: false,
      code: 'crawl_failed',
      message: 'Unable to fetch the reference URL',
      warnings: crawlResult.warnings.map((w) => w.code),
    }
  }

  logger.info('clone.crawl.ok', {
    entryUrl: crawlResult.entryUrl,
    stylesheets: crawlResult.stylesheets.length,
    warnings: crawlResult.warnings.length,
  })

  // ----- 2. Pure CloneReport ---------------------------------------------

  const report = buildCloneReport(crawlResult.html, crawlResult.combinedCss)
  logger.info('clone.report.ok', {
    score: report.score,
    sections: report.sections.length,
  })

  // ----- 3. AI enhancement -----------------------------------------------

  let enhanced
  try {
    enhanced = await enhanceThemeSpec(
      {
        entryUrl: crawlResult.entryUrl,
        report,
        html: crawlResult.html,
        css: crawlResult.combinedCss,
        merchantHint: input.merchantHint,
      },
      {
        sender: opts.aiSender,
        model: opts.aiModel,
        maxTokens: opts.aiMaxTokens,
        temperature: opts.aiTemperature,
      },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('clone.ai_failed', { message })
    return {
      ok: false,
      code: 'ai_request_failed',
      message,
      warnings,
    }
  }

  warnings.push(...enhanced.warnings)
  logger.info('clone.ai.ok', {
    sections: enhanced.spec.sections.length,
    tags: enhanced.spec.tags.length,
    warnings: enhanced.warnings.length,
  })

  // ----- 4. Bundle generation --------------------------------------------

  let bundleResult
  try {
    bundleResult = generateBundleFromSpec({
      spec: enhanced.spec,
      sourceUrl: crawlResult.entryUrl,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('clone.generator_failed', { message })
    return {
      ok: false,
      code: 'generator_failed',
      message,
      warnings,
    }
  }

  warnings.push(...bundleResult.warnings)
  logger.info('clone.bundle.ok', {
    files: Object.keys(bundleResult.files).length,
    name: bundleResult.meta.name,
  })

  // ----- 5. Persist theme -------------------------------------------------

  let theme: Theme
  try {
    theme = await createTheme(db, input.shopId, {
      name: bundleResult.meta.name,
      role: 'unpublished',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('clone.create_theme_failed', { message })
    return {
      ok: false,
      code: 'persist_failed',
      message,
      warnings,
    }
  }

  let filesWritten = 0
  try {
    for (const [key, source] of Object.entries(bundleResult.files)) {
      const contentType = inferContentType(key)
      await updateThemeAsset(
        db,
        theme.id,
        key,
        source,
        contentType,
        opts.assetStorage ?? {},
      )
      filesWritten++
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('clone.persist_assets_failed', {
      themeId: theme.id,
      filesWritten,
      message,
    })
    // Roll back the half-built theme so it doesn't pollute the list.
    try {
      await deleteTheme(db, theme.id)
    } catch (rollbackErr) {
      logger.error('clone.rollback_failed', {
        themeId: theme.id,
        message:
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr),
      })
    }
    return {
      ok: false,
      code: 'persist_failed',
      message,
      warnings,
      rolledBackThemeId: theme.id,
    }
  }

  logger.info('clone.persist.ok', {
    themeId: theme.id,
    filesWritten,
  })

  return {
    ok: true,
    theme,
    spec: enhanced.spec,
    bundleResult,
    crawlWarnings: crawlResult.warnings,
    aiWarnings: enhanced.warnings,
    filesWritten,
  }
}

// ---------------------------------------------------------------------------
// Content type inference — used when persisting assets
// ---------------------------------------------------------------------------

function inferContentType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.liquid')) return 'text/x-liquid'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.css')) return 'text/css'
  if (lower.endsWith('.js')) return 'application/javascript'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'text/plain'
}
