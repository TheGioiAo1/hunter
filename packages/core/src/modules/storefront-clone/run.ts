/**
 * Gbox Platform — Storefront Clone Orchestrator
 *
 * Runs a full clone pipeline end-to-end. Phase 3.A scope is the
 * product ingestion stage only; later phases plug in theme, sitemap,
 * media, SEO, and brand-kit stages by appending stage runners to
 * `STAGE_PIPELINE` below.
 *
 * Contract:
 *
 *   - One call → one `storefront_clone_jobs` row transitions from
 *     `queued` → `running` → `succeeded | failed`.
 *   - Each stage appends a `CloneJobStageEntry` to `stages_json`
 *     with start/finish timestamps so the SSE stream has a timeline.
 *   - If any stage throws, the whole job is marked `failed` with the
 *     originating stage in `error_code`.
 *   - The orchestrator does NOT catch its own throw — callers are
 *     expected to `await runStorefrontClone(...)` and treat thrown
 *     errors as "the DB row already holds the failure detail".
 *
 * Why a plain async function and not a BullMQ worker?
 *   Phase 3.A ships the primitive. BullMQ wrapping is Phase 3.B so
 *   we can stand up the HTTP endpoint + unit tests today without a
 *   Redis dependency. The orchestrator is deliberately side-effect
 *   free apart from DB writes, so swapping it into a worker later
 *   is a one-liner.
 */

import type { Kysely } from 'kysely';
import type { Database, CloneJobStageEntry } from '@gbox/db/schema/tables.js';
import {
  crawlShopifyProducts,
  ShopifyCrawlError,
  type ShopifyCrawlOptions,
  type CloneProductDTO,
} from '../clone-shopify/index.js';
import {
  appendCloneJobStage,
  updateStorefrontCloneJob,
  type StorefrontCloneJobRow,
} from './job-store.js';
import { persistCloneProducts, type PersistProductsResult } from './persist-products.js';
import { ingestProductImages, type MediaIngestResult } from './media-ingest.js';
import { extractAndPersistBrandKit, type BrandKitData } from './brand-kit-extractor.js';
import type { ObjectStore } from '../storage/interface.js';

export interface RunStorefrontCloneInput {
  readonly shopId: string;
  readonly jobId: string;
  readonly sourceUrl: string;
  /**
   * Optional injection point for tests: replace the crawler with
   * an in-memory fixture so we don't touch the network.
   */
  readonly crawlerOverride?: (
    baseUrl: string,
    options: ShopifyCrawlOptions,
  ) => Promise<readonly CloneProductDTO[]>;
  /**
   * Cap applied to both the crawler and the DB write phase.
   */
  readonly maxProducts?: number;
  /**
   * Phase 3.B: object store for media ingestion. When provided,
   * the orchestrator runs the `media` stage after `products`. When
   * absent, media ingestion is skipped (Phase 3.A behavior).
   */
  readonly objectStore?: ObjectStore | null;
  /**
   * Phase 3.B: test injection for media ingest — replaces the real
   * ingest function so tests don't need safeFetch + S3.
   */
  readonly mediaIngestOverride?: (
    db: Kysely<Database>,
    input: Parameters<typeof ingestProductImages>[1],
  ) => Promise<MediaIngestResult>;
  /**
   * Phase 3.C: when true, extract brand kit (palette + fonts) from
   * source storefront CSS. Default: true when sourceUrl is provided.
   */
  readonly extractBrandKit?: boolean;
  /**
   * Phase 3.C: test injection for brand kit — replaces the real
   * extraction so tests don't need safeFetch.
   */
  readonly brandKitOverride?: (
    db: Kysely<Database>,
    input: { sourceUrl: string; shopId: string },
  ) => Promise<BrandKitData>;
}

export interface RunStorefrontCloneResult {
  readonly jobId: string;
  readonly productsInserted: number;
  readonly productsUpdated: number;
  readonly variantsWritten: number;
  readonly imagesWritten: number;
  readonly mediaIngested?: number;
  readonly mediaFailed?: number;
}

const DEFAULT_MAX_PRODUCTS = 2000;

/** Stage → progress_pct mapping. See spec § Progress table. */
const STAGE_PROGRESS: Record<string, number> = {
  products: 45,
  media: 80,
  brand_kit: 95,
  // theme: 15, sitemap: 60, seo: 90,
};

export async function runStorefrontClone(
  db: Kysely<Database>,
  input: RunStorefrontCloneInput,
): Promise<RunStorefrontCloneResult> {
  // Transition queued → running.
  await updateStorefrontCloneJob(db, input.jobId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    progressPct: 0,
  });

  try {
    // ── Stage: products ────────────────────────────────────────────
    const stageResult = await runProductStage(db, input);

    // ── Stage: media (Phase 3.B) ──────────────────────────────────
    let mediaResult: MediaIngestResult | null = null;
    if (input.objectStore) {
      mediaResult = await runMediaStage(db, input);
    }

    // ── Stage: brand_kit (Phase 3.C) ──────────────────────────────
    if (input.extractBrandKit !== false) {
      await runBrandKitStage(db, input);
    }

    // Success — close the job out.
    const resultPayload: Record<string, unknown> = {
      products: {
        inserted: stageResult.inserted,
        updated: stageResult.updated,
        variants: stageResult.variantsWritten,
        images: stageResult.imagesWritten,
      },
    };
    if (mediaResult) {
      resultPayload.media = {
        total: mediaResult.total,
        succeeded: mediaResult.succeeded,
        failed: mediaResult.failed,
        skipped: mediaResult.skipped,
      };
    }

    const finalRow = await updateStorefrontCloneJob(db, input.jobId, {
      status: 'succeeded',
      progressPct: 100,
      finishedAt: new Date().toISOString(),
      resultJson: resultPayload,
    });

    return {
      jobId: finalRow.id,
      productsInserted: stageResult.inserted,
      productsUpdated: stageResult.updated,
      variantsWritten: stageResult.variantsWritten,
      imagesWritten: stageResult.imagesWritten,
      mediaIngested: mediaResult?.succeeded,
      mediaFailed: mediaResult?.failed,
    };
  } catch (err) {
    const { code, message } = classifyError(err);
    await updateStorefrontCloneJob(db, input.jobId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorCode: code,
      errorMessage: message,
    });
    throw err;
  }
}

async function runProductStage(
  db: Kysely<Database>,
  input: RunStorefrontCloneInput,
): Promise<PersistProductsResult> {
  const startedAt = new Date().toISOString();
  const stageName = 'products';
  await appendStage(db, input.jobId, {
    stage: stageName,
    status: 'running',
    started_at: startedAt,
    finished_at: null,
  });

  try {
    const maxProducts = input.maxProducts ?? DEFAULT_MAX_PRODUCTS;
    const crawler = input.crawlerOverride ?? crawlShopifyProducts;
    const products = await crawler(input.sourceUrl, { maxProducts });

    const persisted = await persistCloneProducts(db, {
      shopId: input.shopId,
      cloneJobId: input.jobId,
      sourceBaseUrl: input.sourceUrl,
      products,
    });

    await appendStage(db, input.jobId, {
      stage: stageName,
      status: 'succeeded',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      count: persisted.inserted + persisted.updated,
      message: `${persisted.inserted} inserted, ${persisted.updated} updated`,
    });

    await updateStorefrontCloneJob(db, input.jobId, {
      progressPct: STAGE_PROGRESS[stageName] ?? 50,
    });

    return persisted;
  } catch (err) {
    const { code, message } = classifyError(err);
    await appendStage(db, input.jobId, {
      stage: stageName,
      status: 'failed',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error_code: code,
      message,
    });
    throw err;
  }
}

async function runBrandKitStage(
  db: Kysely<Database>,
  input: RunStorefrontCloneInput,
): Promise<BrandKitData> {
  const startedAt = new Date().toISOString();
  const stageName = 'brand_kit';
  await appendStage(db, input.jobId, {
    stage: stageName,
    status: 'running',
    started_at: startedAt,
    finished_at: null,
  });

  try {
    const extractFn = input.brandKitOverride ?? extractAndPersistBrandKit;
    const result = await extractFn(db, {
      sourceUrl: input.sourceUrl,
      shopId: input.shopId,
    });

    await appendStage(db, input.jobId, {
      stage: stageName,
      status: 'succeeded',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      message: `palette: ${result.palette.primary}, font: ${result.fonts.heading_family.split(',')[0]}`,
    });

    await updateStorefrontCloneJob(db, input.jobId, {
      progressPct: STAGE_PROGRESS[stageName] ?? 95,
    });

    return result;
  } catch (err) {
    // Brand kit extraction is non-fatal — log and continue.
    const { code, message } = classifyError(err);
    await appendStage(db, input.jobId, {
      stage: stageName,
      status: 'failed',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error_code: code,
      message: `Non-fatal: ${message}`,
    });

    // Return a default brand kit so the job doesn't fail.
    const { extractColorPalette, extractFontConfig } = await import('../themes/cloner.js');
    return {
      palette: extractColorPalette(''),
      fonts: extractFontConfig(''),
      sourceUrl: input.sourceUrl,
      extractedAt: new Date().toISOString(),
    };
  }
}

async function runMediaStage(
  db: Kysely<Database>,
  input: RunStorefrontCloneInput,
): Promise<MediaIngestResult> {
  const startedAt = new Date().toISOString();
  const stageName = 'media';
  await appendStage(db, input.jobId, {
    stage: stageName,
    status: 'running',
    started_at: startedAt,
    finished_at: null,
  });

  try {
    const ingestFn = input.mediaIngestOverride ?? ingestProductImages;
    const result = await ingestFn(db, {
      shopId: input.shopId,
      cloneJobId: input.jobId,
      objectStore: input.objectStore!,
      onlyCloneJobId: input.jobId,
      onProgress: (done, total) => {
        // Update progress proportionally within the media band (45..80).
        const mediaPct = total > 0 ? Math.round(45 + (done / total) * 35) : 45;
        void updateStorefrontCloneJob(db, input.jobId, {
          progressPct: mediaPct,
        });
      },
    });

    const msg =
      `${result.succeeded} uploaded, ${result.failed} failed, ${result.skipped} skipped` +
      (result.errors.length > 0
        ? ` — first error: ${result.errors[0]!.message}`
        : '');

    await appendStage(db, input.jobId, {
      stage: stageName,
      status: result.failed > 0 && result.succeeded === 0 ? 'failed' : 'succeeded',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      count: result.succeeded,
      message: msg,
    });

    await updateStorefrontCloneJob(db, input.jobId, {
      progressPct: STAGE_PROGRESS[stageName] ?? 80,
    });

    // Media failures are non-fatal (fail-open) — only throw if ALL images
    // failed. Partial failures are logged in stages_json.
    if (result.succeeded === 0 && result.total > 0) {
      throw new Error(
        `Media ingest: all ${result.total} images failed. ` +
          `First error: ${result.errors[0]?.message ?? 'unknown'}`,
      );
    }

    return result;
  } catch (err) {
    const { code, message } = classifyError(err);
    await appendStage(db, input.jobId, {
      stage: stageName,
      status: 'failed',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error_code: code,
      message,
    });
    throw err;
  }
}

async function appendStage(
  db: Kysely<Database>,
  jobId: string,
  entry: CloneJobStageEntry,
): Promise<StorefrontCloneJobRow> {
  return appendCloneJobStage(db, jobId, entry);
}

function classifyError(err: unknown): { code: string; message: string } {
  if (err instanceof ShopifyCrawlError) {
    return { code: `crawl_${err.code}`, message: err.message };
  }
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return {
      code: String((err as { code: string }).code),
      message: (err as { message?: string }).message ?? 'Unknown error',
    };
  }
  if (err instanceof Error) {
    return { code: 'unknown', message: err.message };
  }
  return { code: 'unknown', message: String(err) };
}
