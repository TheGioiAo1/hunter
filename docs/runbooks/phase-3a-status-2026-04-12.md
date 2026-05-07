# Phase 3.A Storefront Cloner — 4-Hour Autonomous Run Report

**Date:** 2026-04-12
**Run duration:** ~4h autonomous (Thai offline)
**Branch:** `feat/phase-3-storefront-cloner` off `master`
**Head commit:** `11b7464` feat(phase-3): storefront cloner Phase 3.A — SSRF-safe crawl + product ingest + SSE

---

## TL;DR

Phase 3.A is shipped and committed. The cloner can take a public Shopify URL, queue a
job, crawl `/products.json`, upsert products into the shop's own catalog, and stream
stage progress to the admin UI via SSE. Products land as drafts so the merchant can
review before publishing. All 66 new tests are green and the core typecheck is clean.

You can resume Phase 3.B (theme ingest + sitemap walk) without any cleanup.

---

## What went out

### Clone_pro (Phase 1.D closeout)
- Commit `4393f10` on `Clone_pro/main`, pushed to `xaozayta/Clone_pro`.
- Level 2.5 visual editor primitives: section tree w/ SortableJS, inline edit,
  brand kit w/ k-means palette extraction, breakpoint toggle.
- Vitest: 103 / 103 passing (was 63 pre-1.D — added 40).

### gbox-platform Phase 3 design + plan
- `docs/superpowers/specs/2026-04-12-phase-3-storefront-cloner-design.md`
- `docs/superpowers/plans/2026-04-12-phase-3-storefront-cloner-plan.md`
- Commit `8a9b9d5` on `feat/phase-3-storefront-cloner`.
- 8 locked owner decisions baked into spec (pixels: all 4; storage: S3;
  domain: manual DNS + webhook; subdomain: `shopname.gbox.co`; AI: BYOK;
  re-clone: full overwrite; checkout scaffold in Phase 3, gated until
  Phase 4; Buy button: free-for-all → WhatsApp).

### gbox-platform Phase 3.A implementation
- Commit `11b7464` on `feat/phase-3-storefront-cloner`.
- 19 files, +3227 lines (all new — no deletions of existing logic).

#### New modules

| Path | Purpose |
|---|---|
| `packages/core/src/modules/clone-shopify/` | Promoted from Clone_pro. SSRF-safe fetcher (Node 20+ global fetch, no undici dep), `/products.json` paginator, nested sitemap walker. 48 tests. |
| `packages/core/src/modules/storefront-clone/job-store.ts` | Kysely CRUD for `storefront_clone_jobs`. Atomic stage append via `stages_json \|\| '[new]'::jsonb` server-side (no read-modify-write race with SSE poller). |
| `packages/core/src/modules/storefront-clone/persist-products.ts` | `CloneProductDTO[] → products + product_variants + product_options + product_images` upsert. Keyed on `(shop_id, source_external_id)`. Full-overwrite re-clone policy: existing row gets UPDATE + children wiped + re-inserted. New rows land as `status='draft'`. |
| `packages/core/src/modules/storefront-clone/run.ts` | Single-shot orchestrator. Transitions job `queued → running → succeeded \| failed`, appends stage entries, classifies errors. Products stage only in 3.A; theme/sitemap/media/seo/brand-kit stages are scaffolded for 3.B. |
| `apps/store-admin/src/pages/storefront-clone.ts` | Full HTTP layer: HTML page, POST start, GET JSON snapshot, GET SSE stream (1s poll, 10-minute max duration, replays initial stages_json on connect). |

#### Migration 012 — `storefront_clone_jobs` + Phase 4 scaffold + BYOK
- `storefront_clone_jobs` with `status` CHECK, `stages_json` JSONB array, `progress_pct`
  smallint, `result_json`, `error_code`, `error_message`, start/finish timestamps.
- `checkout_sessions` — empty Phase 4 hook target. Phase 3 never writes to it; the
  schema is in place so Phase 4 can start wiring without another migration.
- `shop_pixel_config` — BYTEA envelope columns (`meta_capi_token_encrypted`,
  `ga4_api_secret_encrypted`, `tiktok_access_token_encrypted`). Plaintext tokens
  never touch the DB — encryption happens in memory, plaintext gets wiped before
  the row is persisted.
- `products` columns: `source_external_id`, `source_url`, `clone_job_id`.
- Partial unique index `idx_products_source_external_id` on
  `(shop_id, source_external_id) WHERE source_external_id IS NOT NULL`. Manually-
  created products (NULL) coexist because PG treats NULLs as distinct.

#### HTTP routes (under `/admin/store/:slug/`)

| Method | Path | Handler |
|---|---|---|
| GET  | `/storefront-clone` | Landing page + recent-jobs table + SSE-wired console |
| POST | `/storefront-clone/start` | CSRF + `strictLimiter`, creates job, fires orchestrator, returns `{ job_id }` |
| GET  | `/storefront-clone/:jobId` | JSON snapshot (for polling fallback) |
| GET  | `/storefront-clone/:jobId/events` | SSE stream: `stage` + `status` events, auto-closes on terminal state |

---

## Quality gates

- **Vitest (core storefront-clone + clone-shopify):** 66 / 66 passing
- **Vitest (full core):** 2360 passing, 1 pre-existing failure in
  `checkout/handoff.test.ts` (unrelated — signature bit-flip test, existed before
  Phase 3)
- **tsc (packages/core):** clean
- **tsc (packages/db):** clean except 1 pre-existing error in
  `migrations/011_domain_verification.ts:45` (same pattern Thai has in trunk). Phase
  3.A's migration 012 uses `sql<SqlBool>` and passes typecheck.
- **tsc (apps/store-admin):** clean (pre-existing `rootDir` noise from repo-root
  test files, no real errors in store-admin src)

---

## 8 locked owner decisions — status

| # | Decision | Phase 3.A status |
|---|---|---|
| Q1 | All 4 pixels (Meta + GTM + GA4 + TikTok) | Schema shipped (`shop_pixel_config` BYTEA columns). Pixel manager UI → Phase 3.D |
| Q2 | S3 for media (reuse `packages/core/storage`) | Phase 3.B — product images still hold source URL |
| Q3 | Manual DNS + webhook verification (Option A) | Existing migration 011 reused. Automation → Phase 3.F |
| Q4 | `shopname.gbox.co` directly | No work needed — Host resolver already handles it |
| Q5 | BYOK for AI rewrite | AES-256-GCM envelope schema ready; AI rewrite module → Phase 3.B |
| Q6 | Full overwrite re-clone | ✅ Implemented in `persist-products.ts` |
| Q7 | Checkout scaffolded in Phase 3, gated until Phase 4 | ✅ `checkout_sessions` table + CHECK constraint shipped empty |
| Q8 | Free-for-all Buy button → WhatsApp | Theme work — Phase 3.C |

---

## What's NOT done (Phase 3.B–3.F pending)

These are still pending per plan:

- **3.B** — Theme ingest pipeline: crawl homepage via safeFetch, run the existing
  theme cloner over the fetched HTML, detect Shopify sections, write to
  `theme_assets`. Plus media pipeline (download images from source URLs into S3,
  rewrite `product_images.src`). Plus AI rewrite with BYOK gate.
- **3.C** — Storefront rendering of cloned content. Buy button → WhatsApp wiring.
- **3.D** — Admin UI for pixel config + SEO manager (title, meta description,
  OG image upload).
- **3.E** — Deploy pipeline (auto-provision `{shop}.gbox.co` nginx upstream).
- **3.F** — Custom domain flow (manual DNS instructions, TXT verify webhook,
  Let's Encrypt via acme-client, `nginx -s reload` trigger).

---

## Running the new code locally

```bash
# 1. Apply migrations (server 1 or your dev Postgres)
pnpm --filter @gbox/db db:migrate

# 2. Start store-admin
pnpm --filter @gbox/store-admin dev
# → http://192.168.1.13:4325/admin/store/<slug>/storefront-clone

# 3. Paste any public Shopify URL and hit "Start clone"
#    — the SSE console will stream stage progress in real time
```

Note: SSE streaming uses a 1s Postgres poll loop in Phase 3.A. Phase 3.B swaps this
for Redis pub/sub so we don't hammer the DB at scale.

---

## Known caveats for 3.B

1. **Orchestrator is fire-and-forget**: `postStorefrontCloneStart` calls
   `runStorefrontClone` without awaiting. That's intentional for Phase 3.A (no
   Redis dep) but it means if the Node process crashes mid-clone, the job row
   stays in `running` state forever. Phase 3.B should add a janitor cron that
   marks long-stalled running jobs as `failed`, AND/OR wrap the orchestrator
   in BullMQ.

2. **Images are still source URLs**: `product_images.src` holds the merchant's
   original Shopify CDN URL. Shopify CDN stays fast, but if the source merchant
   deletes the image we show a broken link. Phase 3.B media pipeline fixes
   this by downloading + uploading to our S3 + rewriting `src`.

3. **Slug collision handling is per-INSERT only**: `reserveUniqueSlug` tries up
   to 12 suffixes then falls back to a timestamp. If two clone jobs land on the
   same source at the same instant, the second one loses on the unique index and
   throws — which is fine because re-clone is full overwrite, the merchant can
   just re-run.

4. **Options naming is generic**: cloned products get "Option 1/2/3" as option
   names because the raw CloneProductDTO drops the names. If needed for Phase
   3.B we can extend the crawler DTO to carry `options: [{ name, position }]`.

---

## Files changed in this run

```
apps/store-admin/src/pages/storefront-clone.ts      new  +406
apps/store-admin/src/server.ts                      mod  +20
packages/core/src/modules/clone-shopify/            new  +1215 (8 files, 48 tests)
packages/core/src/modules/storefront-clone/         new  +1309 (6 files, 18 tests)
packages/db/src/migrations/012_storefront_cloner.ts new  +191
packages/db/src/migrations/run.ts                   mod  +4  (added 011 + 012 imports)
packages/db/src/schema/tables.ts                    mod  +82 (new table interfaces + product columns)
```

---

## Resume instructions for Phase 3.B

```bash
# Already on the right branch
cd E:/Gbox\ Platform\ vibecode/gbox-platform
git status    # should be clean
git log --oneline -5
# 11b7464 feat(phase-3): storefront cloner Phase 3.A ...
# 8a9b9d5 docs(phase-3): storefront cloner design spec + stage plan
# ...
```

Next command: start Phase 3.B.1 — theme ingest stage. The stage wiring pattern
is already in `run.ts` → `runProductStage`; copy-paste and swap the body for
`crawlShopifyTheme(...)` + theme-cloner wiring.
