# Phase 02 — Sprint 2: Pipeline Integration + Bulk Import

**Date:** 2026-05-01 → 2026-05-04 (3 days)
**Priority:** HIGH — anh test data tại milestone này
**Branch:** `feat/v7-pr2-pipeline-integration`
**Depends on:** Sprint 1 merged

## Goal

Wire crawler v7 vào v6 pipeline. Replace Stage 4 (AI Sonnet bucket scrapers) bằng Stage 4
v7 (Lonspy bulk crawler). Giữ Stage 1-3 (discovery), 5-12 (asset + persist + verify + publish).

## Architecture

```
v6 pipeline existing → v7 modified:
- Stage 1-3: GIỮ NGUYÊN
- Stage 4: REPLACE (Lonspy bulk crawl thay AI Sonnet)
- Stage 4b: AI Sonnet fallback nếu Lonspy fail (platform = 'unknown' || quality <95%)
- Stage 5-12: GIỮ NGUYÊN (asset graph + S3 + persist + path rewrite + verify + grade + publish + finalize)
```

## Files to Create/Modify

```
packages/core/src/modules/clone-pro/v7/
├── stages/
│   └── stage4-lonspy-bulk.ts       # Mới: dispatch crawler v7
├── deps.ts                          # Mới: buildV7Deps factory
├── orchestrator.ts                  # Mới: copy v6 orchestrator + replace stage4
└── dto-mapper.ts                    # Mới: Row → ProductScrapedDto

packages/db/src/migrations/
├── 099_clone_jobs_v7_columns.ts    # ALTER storefront_clone_jobs
├── 100_clone_crawl_runs.ts         # NEW table log mỗi crawl
└── 103_re_clone_overwrite.ts       # OVERWRITE logic SQL function

packages/api-platform/src/routes/clone-pro/
└── start.ts                         # MODIFY: accept products_limit + crawl_strategy

scripts/
└── smoke-clone-pro-v7-pr2.ts       # Live smoke 200 products
```

## Tasks

- [ ] **2.1** Migration 099: ALTER `storefront_clone_jobs`
  ```sql
  ALTER TABLE storefront_clone_jobs
    ADD COLUMN products_limit INT NULL,
    ADD COLUMN crawl_strategy TEXT NOT NULL DEFAULT 'sample',
    ADD COLUMN clone_pro_version TEXT NOT NULL DEFAULT 'v7';
  ```
  Test: insert + select round-trip.
  Commit: `feat(v7-pr2): migration 099 — clone_jobs v7 columns`

- [ ] **2.2** Migration 100: `clone_crawl_runs` log table
  ```sql
  CREATE TABLE clone_crawl_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES storefront_clone_jobs(id),
    platform TEXT,
    config_used TEXT,
    rows_harvested INT,
    rows_failed INT,
    quality_score NUMERIC(3,2),
    duration_ms INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX idx_clone_crawl_runs_job ON clone_crawl_runs(job_id);
  ```
  Commit: `feat(v7-pr2): migration 100 — clone_crawl_runs metrics log`

- [ ] **2.3** Migration 103: OVERWRITE function
  ```sql
  CREATE OR REPLACE FUNCTION clone_pro_overwrite_products(p_shop_id UUID)
  RETURNS TABLE (deleted INT, archived INT) AS $$
  DECLARE v_archived INT; v_deleted INT;
  BEGIN
    UPDATE products SET archived = true, archived_at = NOW()
     WHERE shop_id = p_shop_id
       AND id IN (SELECT DISTINCT product_id FROM order_items WHERE order_id IN
                  (SELECT id FROM orders WHERE shop_id = p_shop_id));
    GET DIAGNOSTICS v_archived = ROW_COUNT;
    DELETE FROM products WHERE shop_id = p_shop_id AND archived IS NOT TRUE;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN QUERY SELECT v_deleted, v_archived;
  END;
  $$ LANGUAGE plpgsql;
  ```
  Test: insert products có/không order → call function → verify.
  Commit: `feat(v7-pr2): migration 103 — re-clone overwrite SQL function`

- [ ] **2.4** Stage 4 v7 (`stage4-lonspy-bulk.ts`)
  - Input: `{ jobId, sourceUrl, productsLimit, db, s3 }`
  - Logic:
    1. Call `crawlSite(sourceUrl, { products_limit })`
    2. Persist log row vào `clone_crawl_runs`
    3. Map `Row[]` → `ProductScrapedDto[]` qua `dto-mapper.ts`
    4. Quality gate: `(rows / urls_attempted) >= 0.95` else throw `QualityBelowThresholdError`
    5. Return DTOs cho Stage 5
  - Test: 5+ unit cases (success, partial fail, threshold breach, retry)
  - Commit: `feat(v7-pr2): stage4-lonspy-bulk — orchestrator + quality gate 95%`

- [ ] **2.5** DTO mapper (`dto-mapper.ts`)
  - Map `Row { Title, ImageUrls, Description, Price, OldPrice, Spin, ... }` →
    `ProductScrapedDto { handle, title, body_html, images: [{src, alt}], variants: [{...}], options: [{...}], price }`
  - Generate handle từ Title (slugify)
  - Parse variants từ Spin (split " × " hoặc detect Shopify variant format)
  - Test: 8+ cases mapping
  - Commit: `feat(v7-pr2): dto-mapper — Row → ProductScrapedDto + handle slugify`

- [ ] **2.6** v7 orchestrator + deps factory
  - `orchestrator.ts`: copy v6 `runCloneProV6`, replace Stage 4 dispatch với `stage4-lonspy-bulk`
  - `deps.ts`: `buildV7Deps(db)` factory wire crawler + DB + S3
  - Test: 10+ unit cases mock deps
  - Commit: `feat(v7-pr2): v7 orchestrator + deps factory`

- [ ] **2.7** API `POST /clone-pro/start` accept new fields
  - Update Zod schema: `products_limit: z.number().nullable().optional()`,
    `crawl_strategy: z.enum(['sample', 'full']).optional()`
  - Default products_limit = 200 nếu strategy='sample', null nếu 'full'
  - Persist vào `storefront_clone_jobs` row
  - Test: 5+ cases API validation
  - Commit: `feat(v7-pr2): API /clone-pro/start accept products_limit + crawl_strategy`

- [ ] **2.8** Worker integration: clone-worker route v7 nếu `CLONE_PRO_VERSION=v7`
  - File: `packages/clone-worker/src/index.ts` — branch v7 vs v6 theo env
  - Commit: `feat(v7-pr2): clone-worker route v7 với env flag`

- [ ] **2.9** Live smoke: bibliobloom 200 products
  - Script: `scripts/smoke-clone-pro-v7-pr2.ts`
  - Steps:
    1. Insert seller + shop best-store-v7 vào gbox_platform DB
    2. POST /clone-pro/start với url=bibliobloom.com, limit=200
    3. Wait 25 phút (worker process)
    4. Assert: products count ≥ 190 (95% of 200), variants ≥ 1 cho 70% products,
       images ≥ 3 cho 90% products, descriptions ≥ 200 chars cho 90% products
  - Commit: `test(v7-pr2): smoke 200 products bibliobloom live DB pass`

## Acceptance Criteria

- [ ] Migration 099, 100, 103 applied trên `gbox_platform` DB
- [ ] All unit tests pass (35+ test mới)
- [ ] Live smoke pass: 200 products bibliobloom với quality ≥ 95%
- [ ] best-store-v7.gbox.co render 200 products **với theme cũ** (theme builder Sprint 3+4)
- [ ] Anh test trực quan: data đầy đủ chưa (description, images, variants)

## Risk

- Stage 4 v7 quality gate <95% → fail toàn bộ job. Mitigation: log warning, dùng AI Sonnet
  fallback (Stage 4b — implement nếu thấy nhiều site fail)
- DB migration OVERWRITE lỡ delete sai data prod. Mitigation: smoke test trên isolated shop,
  add `dry_run` flag cho function

## Next: Sprint 3 — theme capture
