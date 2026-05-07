# Phase 3 Storefront — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-04-12-phase-3-storefront-cloner-design.md`
**Date:** 2026-04-12
**Target duration:** 6 working days across 6 stages (3.A → 3.F)
**Branch strategy:** one feature branch per stage, merged to `main` after smoke test passes

---

## Stage 3.A — Product ingest + HTTP endpoint

**Branch:** `feat/phase-3a-storefront-cloner-products`
**Duration:** 1 day

### 3.A.1 — Promote Clone_pro primitives into @gbox/core

- [ ] Create `packages/core/src/modules/clone-shopify/` directory
- [ ] Copy `Clone_pro/packages/clone-core/src/safe-fetch.ts` → `packages/core/src/modules/clone-shopify/safe-fetch.ts`
- [ ] Copy `crawler-products.ts` → same dir
- [ ] Copy `crawler-sitemap.ts` → same dir
- [ ] Create `packages/core/src/modules/clone-shopify/index.ts` exporting all three
- [ ] Copy corresponding `.test.ts` files (48 tests total) and verify they pass in gbox-platform's vitest config
- [ ] Update `packages/core/src/index.ts` to re-export the new module
- [ ] **Verification:** `pnpm -w test packages/core` → 48+ new tests green

### 3.A.2 — Migration: new tables

- [ ] Create `packages/db/src/migrations/XXX_phase_3_storefront.ts`
- [ ] Tables: `storefront_clone_jobs`, `checkout_sessions`, `shop_domains`, `shop_pixel_config`
- [ ] Columns added: `products.source_external_id`, `products.source_url`, `products.clone_job_id`
- [ ] Index: `idx_products_source_external_id`
- [ ] Run migration locally against `gbox_platform_test` DB
- [ ] **Verification:** migration reversible via `down()`, schema matches spec §7

### 3.A.3 — Clone job service

- [ ] New file `packages/core/src/modules/storefront-clone/job-store.ts`
  - `createStorefrontCloneJob(db, { shopId, sourceUrl, createdBy })`
  - `getStorefrontCloneJob(db, jobId)`
  - `updateStorefrontCloneJob(db, jobId, patch)`
  - `appendCloneStage(db, jobId, stage)` — pushes into `stages_json` array
- [ ] Tests: CRUD + optimistic stage append concurrency

### 3.A.4 — Extend ai-clone orchestrator with product stage

- [ ] In `packages/core/src/modules/ai-clone/orchestrator.ts`, add a new optional stage after theme persist:
  ```ts
  if (options.cloneProducts) {
    const products = await crawlShopifyProducts(options.sourceUrl, { maxProducts: 5000 });
    await persistProducts(db, { shopId, products, cloneJobId });
  }
  ```
- [ ] `persistProducts` helper in `packages/core/src/modules/storefront-clone/persist-products.ts`:
  - Map `ShopifyProductRaw` → `products` row + `product_variants` rows + `product_options` rows + `product_images` rows (with source URL, no S3 yet — that's 3.B)
  - Use `INSERT ... ON CONFLICT (shop_id, source_external_id) DO UPDATE SET ...` for full re-clone overwrite
- [ ] Tests: map one fixture product, assert all joined rows inserted

### 3.A.5 — HTTP endpoint + SSE

- [ ] New router in `packages/core/src/modules/storefront-clone/http.ts`:
  - `POST /api/storefront/clone` → creates job + fires orchestrator via `void runCloneOrchestrator(...).catch(...)` (in-process for MVP; BullMQ in 3.E if needed)
  - `GET /api/storefront/clone/:jobId` → returns row
  - `GET /api/storefront/clone/:jobId/events` → SSE polling job row every 1s until terminal
- [ ] Mount router in `apps/api/src/app.ts` (or wherever the platform API lives)
- [ ] Auth: `requireStoreOwner()` middleware (already exists)
- [ ] Tests: 401 without auth, 400 on invalid URL, 202 on success + job row created

### 3.A.6 — Smoke test on server 3

- [ ] Deploy feature branch to storefront server (`pm2 reload` after `pnpm build`)
- [ ] Run end-to-end: `POST /api/storefront/clone` with a real public Shopify URL (e.g., `https://allbirds.com`)
- [ ] Verify products appear in DB with correct counts
- [ ] Verify `/products/{handle}` renders on `{shop}.gbox.co` (images broken until 3.B, text + prices work)
- [ ] **Exit criteria:** smoke test green → merge 3.A → start 3.B

---

## Stage 3.B — Media pipeline (S3 + sharp)

**Branch:** `feat/phase-3b-media-pipeline`
**Duration:** 1 day

### 3.B.1 — Media downloader

- [ ] New `packages/core/src/modules/storefront-clone/media-ingest.ts`
  - `ingestProductImages(db, { shopId, productId, sourceImages, s3Store }): Promise<IngestResult>`
  - Concurrency cap: 6 workers (`Promise.all` with chunks)
  - Each image: `safeFetch(url)` → `sharp(buffer)` → resize [256, 512, 1024, 2048] → encode to WebP + AVIF
  - Upload: `S3Store.put('shops/${shopId}/products/${productId}/${hash}.{w}.{fmt}', buffer)`
  - Update `product_images.src` with the 1024 WebP CDN URL; full srcset JSON in `product_images.srcset_json` (new column)
- [ ] Fail-open: individual image errors logged to `stages_json.mediaErrors[]`, job continues
- [ ] Tests: mock safeFetch + S3Store, assert 4 sizes × 2 formats = 8 uploads per image

### 3.B.2 — Migration: srcset column

- [ ] `ALTER TABLE product_images ADD COLUMN srcset_json JSONB DEFAULT '{}'::jsonb`

### 3.B.3 — Wire into orchestrator

- [ ] Add `crawlMedia` stage after `persistProducts` in orchestrator
- [ ] Stage reports progress per-image (N/total) via `appendCloneStage`

### 3.B.4 — Storefront srcset rendering

- [ ] Update product Liquid partial to emit `<img src=... srcset=... sizes=...>` when `product.images[0].srcset_json` present

### 3.B.5 — Smoke test

- [ ] Re-clone `allbirds.com` on server 3
- [ ] `/products/{handle}` shows images from S3 CDN, no broken links
- [ ] **Exit criteria:** Lighthouse performance > 80 on a cold product page load

---

## Stage 3.C — SEO + brand kit

**Branch:** `feat/phase-3c-seo-brand-kit`
**Duration:** 1 day

### 3.C.1 — SEO harvest during crawl

- [ ] Extend `crawlShopifyProducts` normaliser to capture `seo.title`, `seo.description` from Shopify JSON
- [ ] Persist to new `products.seo_title`, `products.seo_description` columns (migration)

### 3.C.2 — sitemap.xml

- [ ] `apps/storefront/src/routes/sitemap.ts` — streams products + collections + pages + blog posts
- [ ] Cache 1h via simple in-memory Map keyed by shopId
- [ ] Mount in storefront router before the `/{*splat}` catchall

### 3.C.3 — robots.txt

- [ ] `apps/storefront/src/routes/robots.ts` — reads `shops.robots_txt` column (new) or default
- [ ] Migration: `ALTER TABLE shops ADD COLUMN robots_txt TEXT`

### 3.C.4 — JSON-LD partial

- [ ] `apps/storefront/src/views/partials/json-ld.liquid` — Product, BreadcrumbList, Organization, WebSite
- [ ] Include in `<head>` of product, collection, and layout templates

### 3.C.5 — Brand kit extraction

- [ ] Promote `extractPalette` from `Clone_pro/packages/clone-editor/src/brand-kit.ts` into `packages/core/src/modules/storefront-clone/brand-kit-extractor.ts`
- [ ] `emitBrandKit` stage: fetch hero image bytes → sharp decode → pixel array → `extractPalette(3)` → persist to `shops.brand_kit_json` (new column)
- [ ] Migration: `ALTER TABLE shops ADD COLUMN brand_kit_json JSONB`

### 3.C.6 — Smoke test

- [ ] Clone a real site, run Google Rich Results test on a product page
- [ ] Verify sitemap.xml parses in a validator
- [ ] **Exit criteria:** Rich Results shows "Valid" for Product schema

---

## Stage 3.D — Pixel manager + consent

**Branch:** `feat/phase-3d-pixel-manager`
**Duration:** 1.5 days

### 3.D.1 — Pixel config CRUD

- [ ] `packages/core/src/modules/storefront-clone/pixel-service.ts`
  - `getPixelConfig(db, shopId)`
  - `upsertPixelConfig(db, shopId, patch, kek)` — encrypts tokens via BYOK envelope
- [ ] Promote `byok-crypto.ts` from Clone_pro into `packages/core/src/modules/storefront-clone/crypto.ts`
- [ ] Tests: encrypt/decrypt round-trip, tamper detection

### 3.D.2 — Pixel Liquid partial

- [ ] `apps/storefront/src/views/partials/pixels.liquid`
- [ ] Emits `<script>` for Meta, GTM, GA4, TikTok conditionally on config presence
- [ ] Respects `window.__cpConsent` — before consent, events are queued in memory

### 3.D.3 — Consent banner

- [ ] `apps/storefront/src/views/partials/consent-banner.liquid`
- [ ] Pure HTML + inline script, no framework. Reject-by-default per spec.
- [ ] On accept → set `localStorage.cp_consent = 'accepted'` → flush queued events → load pixel scripts

### 3.D.4 — Server-side event relay

- [ ] `POST /_events` route on storefront
- [ ] Rate limit: 100/min/shop via existing platform rate-limit middleware
- [ ] Fanout in parallel (`Promise.allSettled`): Meta CAPI, GA4 MP, TikTok Events API
- [ ] Log failures to pino with `shop_id`, `provider`, `error_code`

### 3.D.5 — Event wiring on pages

- [ ] On product page: fire `view_item` on page load
- [ ] On "Buy" button click: fire `add_to_cart` + open WhatsApp link
- [ ] `page_view` fires on every route via the shared layout partial

### 3.D.6 — Smoke test

- [ ] Install Meta Pixel Helper in Chrome
- [ ] Clone a store with a real Meta Pixel ID set, visit a product page
- [ ] **Exit criteria:** Pixel Helper shows green `PageView` + `ViewContent`

---

## Stage 3.E — Admin wizard expansion

**Branch:** `feat/phase-3e-admin-wizard`
**Duration:** 1 day

### 3.E.1 — Rename + expand store-admin plugin

- [ ] `apps/store-admin/src/pages/theme-clone.ts` → `storefront-clone.ts`
- [ ] Step 1: source URL form (reuse existing UI)
- [ ] Step 2: SSE progress bar (reuse Clone_pro wizard.js as template — copy + adapt)
- [ ] Step 3: preview link to `{shop}.gbox.co` + "open editor" button (editor lands in Phase 3.5)
- [ ] Step 4: pixel form (4 providers, token fields encrypted via BYOK)
- [ ] Step 5: domain form (enter hostname → show DNS records → verify button)
- [ ] Step 6: publish button (gated on checkout_ready, reads "Go live (lead-gen)" until Phase 4)

### 3.E.2 — Lead-gen Buy button wiring

- [ ] `apps/storefront/src/views/partials/buy-button.liquid`
- [ ] Config: `shop.lead_gen_whatsapp_number` (new column) or `shop.lead_gen_contact_url`
- [ ] Click → fire `add_to_cart` pixel event → `window.open('https://wa.me/...?text=...')`

### 3.E.3 — Smoke test

- [ ] End-to-end: paste URL → wizard → verified in under 5 minutes on staging
- [ ] Click Buy button on a product → WhatsApp opens → Pixel Helper shows `AddToCart`

---

## Stage 3.F — Custom domain + SSL

**Branch:** `feat/phase-3f-custom-domain-ssl`
**Duration:** 1.5 days

### 3.F.1 — DNS verification service

- [ ] `packages/core/src/modules/storefront-clone/domain-verify.ts`
- [ ] `verifyDomain(hostname, expectedToken)`: uses `dns.resolveCname` + `dns.resolveTxt`, returns boolean
- [ ] Reject apex domains (hostname without a subdomain label)
- [ ] Tests: mock DNS resolver, assert CNAME+TXT match logic

### 3.F.2 — Let's Encrypt issuer

- [ ] `packages/core/src/modules/storefront-clone/cert-issuer.ts`
- [ ] Uses `acme-client` npm (pure JS, no Go binary dependency)
- [ ] HTTP-01 challenge via well-known path served by storefront
- [ ] Writes `.pem` + `.key` to `/etc/nginx/certs/{hostname}.{pem,key}` (path configurable)
- [ ] Calls `nginx -t && nginx -s reload` via `child_process.execFile`

### 3.F.3 — Cron jobs

- [ ] 5-min cron: pick up `verified && cert_status='none'` → issue cert
- [ ] Daily 03:00 cron: pick up `cert_expires_at < now() + 30 days` → renew
- [ ] Both crons logged to `storefront_clone_jobs` audit table for traceability

### 3.F.4 — Nginx config (server 3)

- [ ] Runbook update: `docs/runbooks/phase-3-storefront-deploy.md`
- [ ] Nginx server block: `server { listen 443 ssl; server_name _; ssl_certificate /etc/nginx/certs/$ssl_server_name.pem; include /etc/nginx/sites-available/storefront-proxy.conf; }`
- [ ] SNI-based cert lookup from filesystem, no per-domain server block needed

### 3.F.5 — Smoke test

- [ ] On server 3, add a real test domain (e.g., `clone-test.gbox.co` if Thai provides one)
- [ ] Full flow: wizard → DNS setup → wait 2 min → cert issued → HTTPS works
- [ ] **Exit criteria:** `curl https://{testdomain}` returns 200 with valid cert

---

## Verification gates (between stages)

Between every stage:

1. `pnpm -w typecheck` — must be clean
2. `pnpm -w test` — must be fully green (no skipped)
3. Deploy feature branch to storefront server
4. Run stage-specific smoke test
5. Merge to `main` only after smoke passes

## Dependencies + risks

- Stage 3.A blocks everything — must ship first
- Stage 3.B depends on 3.A (product rows must exist before media ingest)
- Stage 3.C depends on 3.A
- Stage 3.D is independent of 3.B/3.C — can run in parallel if headcount allows
- Stage 3.E depends on 3.A + 3.D (wizard needs both clone flow and pixel config)
- Stage 3.F is independent of everything except 3.E (wizard needs the domain UI)

## Out-of-scope follow-ups (Phase 3.5 / 4)

- Cart + checkout UI
- Cloudflare API automation for custom domains (Option B)
- Level 2.5 visual editor port from Clone_pro into store-admin
- AI rewrite button for product descriptions (BYOK path)
- Multi-region S3 + CDN edge
- Preserve-edit re-clone policy
