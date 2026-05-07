# Clone Pro v7 — Bulk Catalog Migration + Theme Builder Spec

**Date locked:** 2026-04-26
**Owner:** Thai Bui
**Status:** LOCKED — ready for plan + implementation

## 1. Mục tiêu

Một lệnh duy nhất, không thao tác tay:

```
INPUT:  POST /clone-pro/start { url, products_limit?, ... }
              ↓
OUTPUT: best-store.gbox.co render với
        - Theme visual 1:1 với source (Stage 13-16, screenshot-driven)
        - Catalog đầy đủ products + variants + collections + pages
          (Stage 4 Lonspy bulk crawl, không bỏ sót)
        - Mọi asset trên S3, mọi data trong Postgres, auto-published
```

**Khác biệt với v6:** v6 chỉ extract title + 1 image cho Hydrogen 2.0 (AI Sonnet không
parse được không có JSON-LD). v7 dùng Lonspy XPath engine — battle-tested với 24
platform configs sẵn — lấy ĐẦY ĐỦ catalog.

## 2. 6 Quyết định LOCKED (Thai 2026-04-26)

| # | Quyết định | Giá trị |
|---|----------|--------|
| Q1 | Crawl scope | Seller chọn `products_limit` khi paste URL. `null` = all. Default = 200 (sample). Threshold pass = ≥95% products có đủ image+description |
| Q2 | Concurrency | Safe mode: 5 concurrent + delay 2000ms + retry 3 lần exponential backoff |
| Q3 | Variants | Không giới hạn — crawl toàn bộ variants (size × color × style × ...) |
| Q4 | Re-clone | OVERWRITE — không preserve `source='edited'`. Soft-delete cũ + insert mới. Exception: products có orders → mark `archived=true` |
| Q5 | Sprint priority | Chạy thẳng 1 mạch 6 sprint (5 chính + 1 god-admin limits), không pause giữa milestone |
| Q6 | God Admin caps | God Admin có quyền set 3 caps platform-wide: max products per job, max products per shop, max concurrent jobs. Seller request vượt cap → API tự động cap về max + log warning. Cap mặc định: 5000/50000/3. |

## 3. Pipeline Architecture — 16 Stage

```
┌─ DISCOVERY (giữ v6) ───────────────────────────────────────┐
│ Stage 1: Sitemap fetch + parse (clone_url_queue)          │
│ Stage 2: Platform detect (auto: Shopify/Hydrogen/WP/BC/SB)│
│ Stage 3: Playwright render + cache (clone_render_cache)   │
└────────────────────────────────────────────────────────────┘
┌─ BULK CRAWL ⭐ NEW (v7 core) ───────────────────────────────┐
│ Stage 4: Lonspy bulk crawl                                │
│   4.1 Load XPath config theo platform                     │
│   4.2 Listing crawl: harvest ALL product URLs (paginate)  │
│   4.3 Detail crawl: 5 concurrent + 2000ms delay           │
│        → Title, full description HTML, ALL images,        │
│          ALL variants, options, prices, tags, breadcrumb  │
│   4.4 Apply products_limit nếu seller set                 │
│   4.5 Quality gate: ≥95% rows có đủ image+description     │
│   4.6 AI Sonnet fallback nếu Lonspy fail (config sai)     │
└────────────────────────────────────────────────────────────┘
┌─ ASSET PIPELINE (giữ v6) ──────────────────────────────────┐
│ Stage 5: Asset graph build                                 │
│ Stage 6: Parallel S3 download (sha1 keys)                 │
│ Stage 7: Bucket persisters (14 buckets, L17 schema)       │
│ Stage 8: Path rewriter (S3 URLs trong content)            │
└────────────────────────────────────────────────────────────┘
┌─ THEME BUILDER ⭐ NEW (kit screenshot-driven) ──────────────┐
│ Stage 13: Screenshot capture                              │
│   - 5 page core (home/PLP/PDP/cart/page)                  │
│   - Desktop + mobile viewport                             │
│   - Lưu s3://shop/theme/screenshots/source/               │
│ Stage 14: Design token extract (Claude vision)            │
│   - Fonts (Google Fonts predict đúng tên)                 │
│   - Color palette (hex codes)                             │
│   - Spacing scale + breakpoints                           │
│   - Component patterns (card/button/nav)                  │
│   - Lưu shop_theme_tokens table + S3 manifest             │
│ Stage 15: Theme generator                                 │
│   - Liquid templates (compatible Gbox storefront)         │
│   - Token-applier inject design tokens                    │
│   - Component-builder chọn variant theo screenshot        │
│   - Output theme_files table + theme.zip lên S3           │
│ Stage 16: Visual verify                                   │
│   - Chụp clone deployed → Claude vision so sánh source    │
│   - Score ≥ 7/10 mới pass                                 │
│   - <7 → retry Stage 15 với feedback (max 3 lần)          │
└────────────────────────────────────────────────────────────┘
┌─ FINALIZE (giữ v6) ────────────────────────────────────────┐
│ Stage 9: Verification (cardinality + reachability)        │
│ Stage 10: Grade composite 40/30/20/10                     │
│ Stage 11: Auto-publish per-row visibility                 │
│ Stage 12: Finalize + audit log                            │
└────────────────────────────────────────────────────────────┘
```

## 4. S3 Layout — Source of truth

```
gbox-clone-storage/<seller_uuid>/<shop_id>/
├── assets/<sha1>.<ext>            # images, fonts (đã có v6)
├── theme/                          # ⭐ NEW
│   ├── manifest.json              # theme metadata
│   ├── design-tokens.json         # extracted tokens
│   ├── screenshots/source/*.png   # originals
│   ├── screenshots/clone/*.png    # captured of clone
│   ├── components/                # generated components
│   ├── templates/                 # Liquid: home/product/collection/page/cart
│   ├── styles/                    # CSS modules
│   └── theme.zip                  # bundle deploy
└── data/<job_id>/result.json      # audit trail
```

## 5. Database Schema — Mới + Mở rộng

### 5.1 Migrations mới (số 099-103, latest committed = 098)

- **099_clone_jobs_v7_columns**: ALTER `storefront_clone_jobs` ADD `products_limit INT NULL`,
  `crawl_strategy TEXT DEFAULT 'sample'`, `clone_pro_version TEXT DEFAULT 'v7'`
- **100_clone_crawl_runs**: TABLE log mỗi lần crawl Lonspy với platform detect, config used,
  rows harvested, quality score
- **101_theme_files**: ALTER ADD `theme_id UUID`, `version INT DEFAULT 1`, `is_active BOOLEAN`
  (theme_files đã có từ v6, mở rộng cho versioning)
- **102_shop_theme_tokens_v7**: ALTER ADD `screenshots_s3_keys JSONB`, `extracted_by TEXT`
  ('claude_vision'), `score NUMERIC(3,1)`
- **103_re_clone_overwrite**: TRIGGER hỗ trợ overwrite — soft-delete products có orders thay
  vì DELETE

### 5.2 Re-clone OVERWRITE logic (Q4)

```sql
-- Trong stage 7 persister, trước khi insert:
BEGIN;
  -- products có orders → archive
  UPDATE products SET archived = true, archived_at = NOW()
   WHERE shop_id = $1
     AND id IN (SELECT product_id FROM order_items WHERE shop_id = $1);
  -- products không có orders → hard delete
  DELETE FROM products WHERE shop_id = $1 AND archived IS NOT TRUE;
  -- Insert fresh từ crawl mới
  INSERT INTO products ... (crawled data);
COMMIT;
```

## 6. API Surface

### 6.1 Start clone (mới)

```
POST /clone-pro/start
{
  "url": "https://bibliobloom.com",
  "products_limit": 200,           // NEW: null = all (capped to god-admin max), default 200
  "crawl_strategy": "sample"       // NEW: 'sample' | 'full'
}
→ 200 {
    ok, job_id,
    estimated: { products: 200, cost_usd: 0.84, duration_min: 25 },
    cap_applied: { requested: null, capped_to: 5000, reason: 'god_admin_max_per_job' }  // nếu bị cap
  }
→ 409 { error: 'ai_required', cta: '/admin/store/<slug>/settings/ai' }
→ 429 { error: 'limit_exceeded', message: 'Please contact Gbox support' }  // Iron Rule 5: không leak chi tiết cap
```

### 6.3 God Admin caps (Q6)

3 platform settings mới (extend existing `PLATFORM_SETTING_DEFS`):
- `clone_pro_max_products_per_job` (number, default 5000)
- `clone_pro_max_products_per_shop` (number, default 50000) — cumulative cap qua các lần re-clone
- `clone_pro_max_concurrent_jobs` (number, default 3) — platform-wide

UI tự động xuất hiện trong god-admin platform settings page (theo design hiện tại của
`PLATFORM_SETTING_DEFS` — append là đủ).

### 6.2 Extend (crawl thêm) — mới

```
POST /clone-pro/extend
{
  "shop_id": "xxx",
  "additional_products": 500       // crawl thêm 500 products mới
}
→ 200 { ok, extend_job_id, estimated }
```

## 7. Acceptance Criteria

### 7.1 Sprint 1 (Lonspy core port)
- `npx clone-pro-crawl --url=bibliobloom.com --limit=10 --config=shopify-hydrogen` ra
  JSON với 10 products đầy đủ ≥3 images mỗi product, description ≥200 chars
- 50+ unit tests pass
- Live smoke: bibliobloom homepage → 10 products full data

### 7.2 Sprint 2 (Pipeline integration)
- `POST /clone-pro/start { url, products_limit: 200 }` chạy 25 phút → 200 products
  trong DB với full description, all images, all variants
- best-store.gbox.co render 200 products với theme cũ (chưa cần theme mới)
- Anh test trực quan: data đầy đủ chưa

### 7.3 Sprint 3+4 (Theme builder)
- Stage 14 trả về design-tokens.json đúng font (Google Fonts đoán đúng tên,
  không default Inter)
- Stage 15 generate theme.zip + theme_files rows
- Stage 16 visual diff score ≥ 7/10 (sau tối đa 3 retry)

### 7.4 Sprint 5 (Storefront E2E)
- 1 lệnh `POST /clone-pro/start { url: bibliobloom.com }` → 30 phút sau
  best-store.gbox.co LIVE: theme 1:1 + 1100+ products full
- Anh đối chiếu visual side-by-side với bibliobloom.com → confirm 1:1

## 8. Iron Rule 5 (giữ từ Phase 21)

Mọi error path → `safeMessage(err).safe` → `"Please contact Gbox support."`
Seller-facing UI không leak god-admin path / internal config.

Stage 8 grep gate: `rg -c '<source-host>' templates/ + content/` MUST = 0.

## 9. Re-clone semantics OVERWRITE (Q4)

Trái với v6 (giữ `source='edited'`), v7:
- Re-clone = hoàn toàn replace data products/collections/pages từ source
- Products có orders: mark `archived=true` thay vì DELETE (giữ FK integrity)
- Theme tokens: replace toàn bộ (không có concept "edited" theme)
- Diff report: trả về `{deleted, archived, inserted}` count cho seller xem

## 10. Tech Stack v7

- **Crawler**: cheerio + xpath-html (port HtmlAgilityPack), got (HTTP),
  playwright (Chromium emulator — đã có v6)
- **Concurrency**: p-limit 5 concurrent, p-retry 3 attempts exponential backoff
- **AI**: Claude Sonnet (fallback Lonspy fail) + Claude Vision (design tokens)
- **Theme engine**: Liquid (LiquidJS) — compatible Gbox storefront DbLoader
- **DB**: Kysely + Postgres (giữ v6)
- **S3**: AWS SDK v3 (đã có v6)

## 11. Sprint Roadmap

| Sprint | Days | Branch | Deliverable |
|--------|------|--------|-------------|
| 1 | 5 | `feat/v7-pr1-lonspy-core` | Port crawler + 24 configs + 50 unit tests |
| 2 | 3 | `feat/v7-pr2-pipeline-integration` | Stage 4 v7 + DTO mapper + bulk import + smoke |
| **2b** | **1** | `feat/v7-pr2b-god-admin-limits` | **God admin 3 caps + API enforcement (Q6)** |
| 3 | 3 | `feat/v7-pr3-theme-capture-tokens` | Stage 13 + 14 + design tokens table |
| 4 | 5 | `feat/v7-pr4-theme-generator` | Stage 15 + 16 + Liquid templates + verify loop |
| 5 | 2 | `feat/v7-pr5-storefront-e2e` | DbLoader refactor + live E2E + runbook |

**Total: 19 ngày work / 6 PR / từng PR ship + smoke pass mới merge.**

Sprint 2b standalone, có thể chạy parallel với Sprint 1+3 (không overlap files).

## 12. Risks (đã flag với Thai)

| Risk | Mitigation |
|------|-----------|
| Hydrogen 2.0 XPath khác Shopify-classic | Sprint 1.7 tạo `shopify-hydrogen.json` riêng + AI fallback |
| Cloudflare ban khi crawl 1000+ products | Q2 safe mode 5 concurrent + 2000ms delay + browser UA + retry-backoff |
| Claude vision miss font/color → theme lệch | Sprint 4 retry loop max 3 với feedback từ Claude |
| Generic theme generator → "không 1:1" | Sprint 4.3 component library 20+ variants, AI chọn theo screenshot |
| Storefront DbLoader refactor break shops cũ | Feature flag `THEME_LOADER_VERSION`, rollback dễ |
| 18 ngày dài | Q5: chạy 1 mạch, 5 PR ship liên tục, anh test sau Sprint 2 (ngày 8) đã có data |

## 13. Open questions (chờ implementation surface)

- (sẽ update khi triển khai Sprint 1)
