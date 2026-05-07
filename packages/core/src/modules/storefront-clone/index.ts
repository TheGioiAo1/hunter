/**
 * storefront-clone — Phase 3 storefront cloner module.
 *
 * Thin orchestrator layer on top of `@gbox/core/clone-shopify`. The
 * crawler primitives stay DB-free; this module owns the DB writes
 * (products + clone job audit trail).
 *
 * Scope in Phase 3.A:
 *   - job-store.ts       CRUD for `storefront_clone_jobs`
 *   - persist-products   DTO → products/variants/options/images upsert
 *   - run.ts             single-shot pipeline runner (products stage only)
 *
 * Later phases append stages: theme, sitemap, media, seo, brand_kit.
 *
 * NOTE (2026-04-16, migration 034): the old singleton
 *   `shop_pixel_config` table + `pixel-service.ts` + `event-relay.ts`
 * were dropped. Multi-pixel tracking now lives in
 *   `@gbox/core/modules/tracking/*` with a row-per-pixel schema
 * (`shop_tracking_pixels`, `tracking_events_log`,
 * `tracking_event_dedupe`). Import from there instead.
 */

export {
  createStorefrontCloneJob,
  getStorefrontCloneJob,
  listStorefrontCloneJobs,
  updateStorefrontCloneJob,
  appendCloneJobStage,
  readStages,
  type StorefrontCloneJobRow,
  type StorefrontCloneJobStatus,
  type CreateCloneJobInput,
  type UpdateCloneJobInput,
} from './job-store.js';

export {
  persistCloneProducts,
  safeSlug,
  normalisePrice,
  type PersistProductsInput,
  type PersistProductsResult,
} from './persist-products.js';

export {
  runStorefrontClone,
  type RunStorefrontCloneInput,
  type RunStorefrontCloneResult,
} from './run.js';

export {
  ingestProductImages,
  MediaIngestImageError,
  type MediaIngestInput,
  type MediaIngestResult,
  type MediaIngestError,
  type SrcsetJson,
} from './media-ingest.js';

export {
  extractAndPersistBrandKit,
  extractInlineStyles,
  extractCssLinks,
  type BrandKitData,
  type ExtractBrandKitInput,
} from './brand-kit-extractor.js';

export { canonicalDomainFromUrl } from './canonical-domain.js';
