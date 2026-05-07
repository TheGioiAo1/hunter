# GBOX PLATFORM — CLAUDE EXTENDED BRAIN

Overflow from CLAUDE.md. Contains detailed architecture maps, decision logs, and module inventories.

---

## Decision #1 — LiquidJS Theme Engine (COMPLETE)

**Goal:** Replace Nunjucks with a 100% Shopify-compatible LiquidJS engine.
**Status:** ✅ Complete — tagged `decision-1-complete`
**Date:** 2026-04-08 → 2026-04-09
**Test count:** 987 unit tests + 22 bundle smoke + 9 E2E HTTP smoke

### Engine Module Map

```
packages/core/src/modules/themes/engine/
├── liquid.ts                    — Engine factory (createLiquidEngine)
├── loader.ts                    — TemplateLoader interface + path helpers
├── pipeline.ts                  — renderPage / renderSections orchestrator
├── section-api.ts               — Section rendering + schema resolution
├── index.ts                     — Public re-exports
│
├── filters/
│   ├── string.ts                — 25+ Shopify string filters (upcase, truncate, md5, sha256…)
│   ├── url.ts                   — asset_url, img_url, stylesheet_tag, script_tag…
│   ├── i18n.ts                  — | t filter (wired to I18nService)
│   ├── money.ts                 — money, money_with_currency, money_without_trailing_zeros
│   ├── numeric.ts               — plus, minus, times, divided_by, modulo, abs, ceil, floor, round
│   ├── image.ts                 — image_tag, img_tag, image_url
│   └── form.ts                  — form_authenticity_token, csrf_meta_tags
│
├── tags/
│   ├── section.ts               — {% section 'name' %} → loads sections/<name>.liquid
│   ├── layout.ts                — {% layout 'name' %} → layout switching
│   ├── form.ts                  — {% form 'type', object %} → Shopify form tags
│   ├── paginate.ts              — {% paginate collection.products by N %}
│   └── meta-blocks.ts           — {{ content_for_header }}, {{ content_for_layout }}
│
├── json-template/
│   ├── parser.ts                — Parse JSON template format (sections + order)
│   ├── renderer.ts              — Render JSON templates through section pipeline
│   └── types.ts                 — JsonTemplate, JsonSection types
│
├── schema/
│   ├── parser.ts                — Parse {% schema %} JSON from section source
│   ├── resolver.ts              — Resolve t: refs in schema using locale dicts
│   └── types.ts                 — SectionSchema, SectionInstance, BlockInstance
│
├── theme-config/
│   ├── settings.ts              — ResolvedThemeSettings + resolution logic
│   ├── settings-loader.ts       — Load settings_schema.json + settings_data.json
│   ├── theme-locale.ts          — Load + merge theme locale files
│   └── index.ts                 — Re-exports
│
├── assets/
│   └── asset-url-builder.ts     — AssetUrlBuilder interface + DefaultAssetUrlBuilder
│
└── storefront/
    ├── router.ts                — 16-row Shopify route table + handleStorefrontRequest
    ├── types.ts                 — StorefrontRequestContext, StorefrontResponse, StorefrontHandlerOptions
    ├── datasource.ts            — StorefrontDataSource interface + MemoryDataSource
    ├── db-datasource.ts         — DbDataSource (PostgreSQL production adapter)
    ├── db-loader.ts             — DbLoader (loads templates from theme_assets table)
    ├── express-adapter.ts       — createExpressStorefrontHandler (Express middleware)
    ├── error-logger.ts          — RateLimitedErrorLogger + fingerprinting
    ├── locale.ts                — Accept-Language negotiation + URL prefix stripping
    ├── theme-config-loader.ts   — prepareThemeConfig (settings + schema locales)
    └── index.ts                 — Public re-exports
```

### Seed Theme (Gbox Dawn)

```
packages/core/src/modules/themes/seed/
├── gbox-dawn/                   — 56 Shopify Dawn-compatible theme files
│   ├── layout/                  — theme.liquid, password.liquid
│   ├── templates/               — 3 JSON + 13 Liquid (16 total)
│   ├── sections/                — 20 sections with {% schema %} blocks
│   ├── snippets/                — 9 reusable partials
│   ├── assets/                  — theme.css, theme.js, favicon.svg
│   ├── config/                  — settings_schema.json, settings_data.json
│   └── locales/                 — en.default.json, vi.json + schema variants
│
├── gbox-dawn-bundle.generated.ts — Build-time generated Map<key, {source, contentType}>
├── gbox-dawn-bundle.ts          — Public API (listGboxDawnAssets, getGboxDawnAsset…)
└── install.ts                   — installGboxDawnTheme (sequential upsert helper)
```

### Shop Provisioning

```
packages/core/src/modules/shops/
├── service.ts                   — createShop, getShop, listShops, updateShop, deleteShop
└── provision.ts                 — provisionShop (shop + theme + seed install orchestrator)
                                   ensureShopHasTheme (idempotent back-fill helper)
```

### Step Log

| Step | Description | Tests | Commit |
|------|-------------|-------|--------|
| 1.1–1.2 | LiquidJS integration, basic filters | — | (early commits) |
| 1.3 | TemplateLoader interface + StaticLoader | 20 | — |
| 1.4 | Engine factory (createLiquidEngine) | — | — |
| 1.5 | String filters (25+) | 48 | — |
| 1.6 | URL filters + asset_url | 56 | — |
| 1.7 | Money + numeric filters | — | — |
| 1.8 | Image filters | — | — |
| 1.9 | Form tag + form filters | — | — |
| 1.10 | Render pipeline (renderPage) | 57 | — |
| 1.11 | JSON template parser + renderer | 17 | — |
| 1.12 | Section schema parser + resolver | 44 | — |
| 1.13 | Section rendering API | 21 | — |
| 1.14 | Storefront router + Express adapter | 57+10 | — |
| 1.15 | Theme settings + locale loader | 37 | — |
| 1.16 | Large-asset R2 routing | 45 | dccf137 |
| 1.17 | Gbox Dawn seed + bundle + install | 25+22 | 2b6280e |
| 1.18 | provisionShop + migration 009 | 9 | 4bb64b1 |
| 1.19 | storefront-server.ts + DbLoader + DbDataSource | 21 | 6703dbb |
| 1.20 | E2E HTTP smoke (9 page types) | 9 | 6886c88 |
| 1.21 | Worker isomorphic compat | 39 | aef7f13 |
| 1.22 | Remove nunjucks dependency | 0 | 456f08e |
| 1.23 | Documentation + tag | 0 | (this commit) |

### Route Table (16 storefront routes)

| Pattern | Template | Drops |
|---------|----------|-------|
| `/` | index | shop, cart |
| `/products/:handle` | product | product |
| `/collections/:handle/:tag` | collection | collection, products (filtered) |
| `/collections/:handle` | collection | collection, products |
| `/collections` | list-collections | collections |
| `/blogs/:handle/tagged/:tag` | blog | blog, articles (filtered) |
| `/blogs/:handle/:article` | article | article, blog |
| `/blogs/:handle` | blog | blog, articles |
| `/search` | search | search results |
| `/cart` | cart | cart |
| `/account/login` | customers/login | — |
| `/policies/:handle` | page.policy | policy |
| `/pages/:handle` | page | page |
| `/pages/:handle.*` | page.\<handle\> | page |
| `/password` | password | — |
| `/gift_cards/:code` | gift_card | gift_card |

### Key Design Decisions

1. **Shopify-exact Liquid** — strictFilters:true, strictVariables:false, no auto-escape
2. **JSON + Liquid dual templates** — tries `.json` first, falls back to `.liquid`
3. **Framework-agnostic router** — pure `handleStorefrontRequest()` function, adapters for Express/Workers
4. **Build-time bundle** — seed theme compiled to static TypeScript Map (no fs at runtime)
5. **Sequential install** — ~60 files installed one-by-one (low connection-pool pressure)
6. **R2-aware** — assets >256KB auto-promoted to Cloudflare R2 via `objectStore` deps pattern
7. **Worker-compatible** — no fs/path/os imports; `node:crypto` allowed via `nodejs_compat`

---

## Online Store Rewrite (Phase 2B) — Locked Decisions (2026-04-16)

Owner approved plan during Phase 2A merchant-unblockers session. 5 sprints, target sidebar layout matches ShopBase:

```
Online Store
├── Design         ← clone-pro wizard + theme editor  (replaces "Themes")
├── Pages          ← existing
├── Blog Posts     ← existing
├── Landing Pages  ← NEW: drag-drop builder
├── Navigation     ← existing (Phase 2A)
├── Preferences    ← existing (expand)
├── Domains        ← promoted into Online Store (was under Settings)
├── Watermark      ← NEW: auto-dap-logo onto product images
└── Size Charts    ← NEW: backed by Lenful size-chart data
```

### Six locked decisions (owner: Thai, 2026-04-16)

1. **Clone Pro UX = one-click, autonomous**
   Seller gõ MỘT domain đầu vào → tool tự scan toàn bộ (images, sitemap, pages, policies, about, functions, text, description) → persist về Gbox → regenerate website giống 1:1 (theme + UI + flow) → tự động gán function buttons (thanh toán, sản phẩm, cart) vào Gbox modules tương ứng. Clone-pro module hiện ~50% done — cần hoàn thiện tiếp.

2. **Domain SSL = Cloudflare proxy only**
   KHÔNG dùng Let's Encrypt/certbot. Seller tự trỏ domain qua Cloudflare, Cloudflare xử lý SSL. Gbox chỉ cần verify DNS pointing đúng và accept connections trên cổng HTTP (port 80/443 phía server). KHÔNG cần `ssl-provisioner.ts`/`nginx-writer.ts` automation.

3. **Landing Pages = client-side React/Vue drag-drop**
   KHÔNG server-side render builder. Builder là SPA (Vue hoặc React) — mượt UX ưu tiên hơn SEO builder. Rendered output là static JSON → storefront SSR reads JSON và render HTML (SEO-friendly cuối cùng vẫn ổn).

4. **Watermark = retroactive only, no auto-apply**
   KHÔNG auto-watermark ảnh mới upload. Merchant upload logo + cấu hình position/opacity → click "Apply to existing products" → background job process all existing images. Không can thiệp vào pipeline upload mới.

5. **Size Charts = use Lenful's size chart data**
   Không tự build table editor từ đầu. Integrate với Lenful API → fetch size charts từ Lenful catalog → assign theo `products.lenful_product_id`. Cần Thai confirm Lenful API endpoint cho size chart khi tới Sprint 4.

6. **Infrastructure (pdf.34t.org port conflict):** Owner đã tự fix nginx config — Claude skip phần này.

### Sprint plan

| Sprint | Scope | Migration |
|---|---|---|
| **1** ✅ | Sidebar + `/online-store/design` route + wire `clone-pro` + legacy redirect `/storefront-clone` | — |
| **2** ✅ | Domains 2-tab UI (Shop / Custom) + DNS verify (Cloudflare NS detection) + primary/redirect toggle | 035 |
| **3** | Landing Pages: migration + SPA builder + storefront JSON renderer | 036 |
| **4** | Watermark (retroactive job) + Size Charts (Lenful integration) | 037, 038 |
| **5** | Preferences full (SEO/favicon/password/social/robots/sitemap) + E2E smoke + deploy | — |

### Integration points (tight-coupling rules)

- **Clone Pro** → writes to: products, collections, pages, blog_posts, menus, menu_items, themes, shop_settings, files
- **Landing Pages** → picker reuses product/collection picker components; tracking → shop_tracking_pixels
- **Navigation** → menu_items.resource_type/resource_id links to pages/landing/products/collections
- **Domains** → cloudflare-only verify via DNS lookup (no nginx write)
- **Watermark** → reads shop_settings.watermark_config; writes to files + products.images
- **Size Charts** → reads Lenful API (via existing lenful/client.ts); writes products.size_chart_id

---

## Clone Pro — Source-Site Tabs (Phase 2 + 3, shipped 2026-04-17)

**Goal:** Let merchants see and manage imported content grouped by the source site
it came from. Discarding a clone job removes every row it created.

**Phase 2 (products):** migration 041 added `products.clone_job_id` + `site_label` +
`canonical_domain` on `storefront_clone_jobs`. Admin products list renders a tab
strip: `All · Manual · <domain 1> · <domain 2> …` with overflow → ▼More after 5
tabs, pencil rename, orphan catch-all for pre-041 dangling FKs.

**Phase 3 (remaining content + discard):**
- Migration 042: adds `clone_job_id` (uuid, FK → storefront_clone_jobs ON DELETE
  SET NULL) + partial index `(shop_id, clone_job_id) WHERE clone_job_id IS NOT NULL`
  to `pages`, `blog_posts`, `collections`, `menus`. No backfill.
- `apps/store-admin/src/lib/source-tabs.ts` centralises the tab-strip, rename
  modal, source-filter query builder, orphan sweep, CSS, inline JS. Five admin
  pages consume it (DRY).
- Pages, Blog, Collections: full tab strip above list. Stats counters (Total /
  Published / Draft) now scope to the active source tab.
- Navigation admin: menus are singleton per slug (main-menu + footer) so the
  full tab strip doesn't fit. Instead: compact `Imported from <domain> ✏️`
  badge per menu card.
- Discard = DELETE cascade (`postCloneProDiscard`): ordered hard-delete across
  menu_items → menus → collection_products → collections → blog_posts → pages →
  products, all scoped by `(shop_id, clone_job_id)`. Counts flow into the audit-
  log message. try/catch so partial failure still lets `discarded_at` land.
- FK retrofitted only on the new 4 tables; products.clone_job_id keeps its
  orphan-safety handling from Phase 2.8 (deferred to Phase 5).

Commits: `4743541` (Phase 3 feature), `1ec2d83` (migration 042 DO-block fix).
Deployed to server 1 (192.168.1.13): migration ran, store-admin :4325 restarted
clean, all 5 admin routes return 302 redirect to login (auth working), no
post-restart errors. Thai to browser-verify.

---

## Clone Library — Phase 4 (shipped 2026-04-17)

**Goal (per Thai's Q1–Q6 plan):** Let sellers reuse the theme + product batch
produced by a paid clone across every store they own. Q1 pay-once / reusable.
Q2 inactive-copy option. Q3 theme picker at 2nd+ store creation. Q5 separate
sidebar entry. Q6 delete failed/partial cards.

### Schema (migration 043, applied Phase 4.1)
- `themes.source_clone_job_id` uuid NULL, FK → `storefront_clone_jobs` ON DELETE
  SET NULL. Stamped ONLY on the ORIGINAL theme (the one produced by the clone
  pipeline). Library copies never inherit this — ancestry stays one card per
  job, not one per re-clone.
- `themes.cloned_from_theme_id` uuid NULL, self-FK ON DELETE SET NULL. Stamped
  on every cross-shop Library re-clone. Points to the DIRECT parent, not the
  root of the chain.
- Two-phase stamping: `persistDynamicTheme` / `persistCloneTheme` insert the
  theme first; `stampThemeSourceJobId` runs a follow-up UPDATE. Non-fatal on
  failure (just a warning) so a stamp glitch doesn't roll back the whole
  clone job.
- `runner.ts` captures `cloneWebsite()`'s `themeId` result and writes it to
  `storefront_clone_jobs.theme_id` on success — enables the Library query to
  show the theme name per card without a second fetch.

### Services (`packages/core/src/modules/clone-pro/library/`)
- `theme-clone.ts` — `cloneThemeToShop(db, input)` copies one theme row +
  every `theme_assets` row to a target shop via `duplicateAsset` (R2-aware).
  Optional `activate: true` promotes via `setActiveTheme`. Throws
  `CloneLibraryError('THEME_NOT_FOUND')` when the source id is bogus.
  Sibling `findExistingClone(db, params)` returns the existing copy id so
  the UI can say "already applied" instead of silently duplicating.
- `product-clone.ts` — `cloneProductsToShop(db, input)` batches source
  products into the target shop as drafts. Whole batch wrapped in one
  transaction. Dedup via preloaded `cloned_from_product_id` → existing id
  Map (O(1) per source product). Copies variants (inventory reset to 0),
  options, images. Stamps `cloned_from_{product,shop}_id`; nulls
  `source_external_id`, `source_url`, `clone_job_id` because the push is
  NOT an external import and NOT tied to a clone job on the target side.
- `queries.ts` — `listLibraryCards(db, input)` read helper. Joins
  `storefront_clone_jobs` with `themes` (LEFT, so partial jobs still
  appear) and shops. Per-job content counts via scalar subqueries
  (`SELECT COUNT(*) FROM products WHERE clone_job_id = j.id`), each
  O(log n) thanks to the partial indexes from migrations 041+042. Status
  filter groups: completed = succeeded|published; failed = failed|cancelled;
  running = queued|running; all = no filter.

### UI (`apps/store-admin`)
- Sidebar: `Clone Library` entry under Online Store (per Q5), right after
  Clone Pro.
- `/admin/store/:slug/clone-library` page renders a grid of cards; each
  card shows host, status pill, source shop, age, theme name, 4-column
  counts (products / pages / posts / collections), and action buttons
  (Apply theme / Push products / Details / Delete) gated by card status +
  caller role.
- Modals: Apply-theme `<dialog>` with store dropdown + "Set as active"
  checkbox (default checked, per Q2 allow inactive copies). Push-products
  `<dialog>` with store dropdown excluding the source shop. Both ship a
  tiny vanilla-JS script that wires `data-cl-open` / `data-cl-close`
  buttons to `HTMLDialogElement.showModal()` / `.close()`.
- Status tabs: `?status=all|completed|failed|running` filter links across
  the top.

### Actions (`apps/store-admin/src/pages/clone-library/actions.ts`)
Three POST handlers registered in `server.ts`:
- `POST /clone-library/:jobId/apply-theme` — calls `cloneThemeToShop` with
  the form's `target_shop_id` + optional `activate=1`. 400 if no target,
  403 if caller isn't OWNER of the target, 404 if the job is outside the
  caller's shops, 409 if the job produced no theme.
- `POST /clone-library/:jobId/push-products` — calls `cloneProductsToShop`
  with `sourceProductIds=null` (push-all). 400 on source==target (defence
  in depth vs. a hand-crafted POST), 403 if admin-not-owner on target.
- `POST /clone-library/:jobId/delete` — soft-deletes the job by setting
  `discarded_at`. Safety check (Q6 + Phase 4.8): refuses with 409 if the
  job's theme OR any Library copy of it is `role='main'` on any shop the
  caller owns. Partial/failed jobs (no theme) delete unconditionally.

### Access control (Phase 4.6)
- Library is a SELLER-level concept, scoped to `getUserShops(db, userId)`,
  NOT to `req.store.id` (that'd pin the view to one shop). A user with
  3 shops sees clones from all 3.
- Mutations are OWNER-only on the relevant shop (target for
  apply/push, source for delete). An invited admin (level 3) sees Library
  cards but every action button either hides itself (UI filter) or
  returns 403 (server check). Staff (level 4) can't use any action.
- UI buttons and the dropdown options filter to owner-role shops, so
  sellers never see an option that would 403.

### Starter-theme picker at store creation (Phase 4.4.5)
- `apps/accounts/src/pages/create-store.ts` loads
  `listLibraryCards({statusFilter:'completed'})` during GET render; if
  the list is non-empty the form shows a
  `<select name="starter_theme_id">` block. First-time sellers (empty
  library) see no picker so the flow stays a 2-field form.
- POST handler runs `cloneThemeToShop({activate:true})` after the new
  shop + `user_shops` + `locations` + `shop_settings` rows are written.
  Wrapped in try/catch: a theme-copy failure doesn't roll back the
  freshly-created shop — the user lands with the default theme and can
  retry from `/clone-library` → Apply.
- Ownership is re-verified by looking the posted `starter_theme_id` up
  in `loadLibraryThemes(userId)` (which already runs through
  `getUserShops`). Tampering with the hidden id to reference another
  seller's theme silently falls through to the default.

### Tests (Phase 4.7)
- `queries.test.ts` — 12 cases: empty-shop short-circuit, status filter
  mapping, limit clamping to [1, 500], default 100, order-by created_at
  desc, `getLibraryJob` null paths + sample product enrichment.
- `theme-clone.test.ts` — 8 cases: THEME_NOT_FOUND, insert stamps
  `cloned_from_theme_id` not `source_clone_job_id`, newName override,
  asset-copy loop count, activate flag branch, findExistingClone happy +
  null paths.
- `product-clone.test.ts` — 4 cases: zero-source short-circuit (no txn),
  dedup match, ancestry fields stamped on fresh insert, single-transaction
  property.
- `actions.test.ts` (store-admin) — 13 cases covering the
  apply/push/delete access matrix (missing fields, wrong target, admin
  vs owner, job-not-found, theme-active safety, happy-path writes +
  redirects).
- Total new Phase 4 tests: **37**, all green.

### Key design choices
- **No cross-module dependency on storefront-clone's `reserveUniqueSlug`**:
  product-clone ships its own local slug helper (`reserveUniqueSlugLocal`).
  Keeps storefront-clone's internals private and avoids the Library
  depending on an import path the other module treats as implementation.
- **`discarded_at` instead of hard delete**: downstream theme copies
  reference the job via `source_clone_job_id` (ON DELETE SET NULL), but a
  NULL'd pointer loses the ancestry tooltip in the Library "applied from"
  block. Soft-delete preserves the trail.
- **No level-2 hard gate on GET**: invited admins can browse the Library
  so they can see what themes exist on the shops they manage. Only the
  POST mutation paths require owner-of-target / owner-of-source.

Commits: TBD (this chapter).

---

## Phase 6 — Analytics & Reports (shipped 2026-04-21)

**Goal:** Give merchants Shopify-class reports and give the God Admin a
cross-platform view, both reading from the `daily_metrics` rollup instead
of scanning `orders` on every request.

**PRs (all merged to master 2026-04-21):**
- PR #42 — PR1: daily metrics rollup cron + backfill CLI + tests
- PR #43 — PR2: inventory analytics (top sellers / dead / low / sell-through)
- PR #44 — PR3: customer behavior (top spenders / at-risk / new-vs-returning / lifecycle)
- PR #45 — PR4: rollup consistency (backfill helper + 400d retention + prune cron)
- PR #46 — PR5: god-admin platform-wide analytics

### PR1 — Daily metrics rollup cron + backfill (commit `202cf38`)

Wires the Phase 4.3.5 `daily_metrics` write path into the cron driver so
dashboards stop O(n)-scanning `orders`. Every subsequent PR reads from
the aggregate table.

- `packages/core/src/modules/cron/service.ts` — registers
  `rollup_daily_metrics` handler calling `rollupYesterdayAllShops(db)`.
  No circular risk (analytics never imports cron).
- `packages/core/src/modules/analytics/cron-register.ts` — new
  `seedAnalyticsCronTasks(db)`; idempotent on handler name (mirrors
  `lenful` cron-register pattern).
- `packages/core/src/modules/analytics/daily-metrics.ts` — extracted pure
  `summarizeMetrics(rows)` helper + `MetricsSummary` interface so the
  math is unit-testable without hitting the DB.
- `apps/platform-api/src/server.ts` — calls `seedAnalyticsCronTasks`
  alongside the existing boot-time rollup scheduler (dual path is safe;
  both converge on `ON CONFLICT DO UPDATE`).
- `scripts/ops/backfill-daily-metrics.ts` — CLI with
  `--days=N | --since/--until | --shop-id=UUID | --dry-run`; exposes
  `buildDateRange` for unit tests.
- `scripts/smoke-phase6-pr1.ts` — 10-section live smoke (schema,
  `rollupDay`, idempotency, active-only iteration, `getMetrics`,
  `summarizeMetrics` parity, `incrementToday`, `incrementVisitor`,
  seeder, `executeDueJobs` integration). Live-smoke green on server 2.

### PR2 — Inventory analytics (commit `f73ad2c`)

Four weekly-question reports: what's selling, what's stuck, what's
about to run out, how fast stock moves.

- `packages/core/src/modules/analytics/inventory-analytics.ts` (NEW):
  - `getTopSellers` — units sold + revenue + orders in range
  - `getDeadStock` — qty > 0, no sale in N days (default 90)
  - `getLowStock` — qty ≤ threshold (default 5)
  - `getSellThroughLeaders` — `sold / (sold + on_hand)`, ≥ `minSold`
  - Pure helpers: `computeSellThrough` (clamped [0,1]),
    `rankBySoldUnits` (units → revenue → id), `daysSince`,
    `periodToRange` (7d/30d/90d → ISO `since`/`until`)
- `inventory-analytics.test.ts` — **23 unit tests** across all four pure
  helpers edge-to-edge.
- `apps/store-admin/src/pages/inventory-analytics.ts` — Admin page at
  `/admin/store/:slug/reports/inventory`; four cards with period
  selector; empty states explain what populates each card. `db as any`
  cast sidesteps the duplicate-Kysely hazard documented in CLAUDE.md.
- Live smoke: **46/46 PASSED** (`scripts/smoke-phase6-pr2.ts`).

### PR3 — Customer behavior (commit `87eb90a`)

Who spends most, who's slipping away, are we growing or churning, how
healthy is the base. All queries accept an optional `segmentId` composed
through the existing `buildRuleWhere` primitive (no new SQL safelist).

- `packages/core/src/modules/analytics/customer-behavior.ts` (NEW):
  - `getTopSpenders` — ranked by `total_spent desc`, `minOrders` guard
  - `getAtRiskCustomers` — >60d since `last_order_at`, excludes churned
  - `getNewVsReturning` — partitions orders by prior-buy history
  - `getLifecycleBreakdown` — counts by `lifecycle_stage`
  - Pure helpers: `classifyRecency` (active/at_risk/dormant),
    `classifyFrequency` (none/one_time/occasional/loyal/vip),
    `computeReturningRate` (clamped [0,1])
- `customer-behavior.test.ts` — **17 unit tests** for the pure helpers.
- `apps/store-admin/src/pages/customer-behavior.ts` — Admin page at
  `/admin/store/:slug/reports/customer-behavior` with segment filter.
- `getSegment` validates the segment belongs to the shop (tamper-proof).
- Live smoke: **42/42 PASSED** (`scripts/smoke-phase6-pr3.ts`).

### PR4 — Rollup consistency + prune cron (commit `4d7d351`)

Closes two gaps discovered during PR2/PR3 QA: missing days in
`daily_metrics` (if the cron was ever down) and unbounded retention
(rollup table grows forever).

- `packages/core/src/modules/analytics/daily-metrics.ts`:
  - `findMissingDates(existing, since, until)` — pure helper
  - `backfillMissingDays(db, shopId, since, until)` — rolls up ONLY the
    gaps; idempotent on re-run
  - `computePruneCutoff(retainDays, now)` — pure helper
  - `pruneOldMetrics(db, { retainDays, shopId, now })` — deletes rows
    strictly older than cutoff; default **400 days** (YoY-safe)
- Cron: `prune_old_metrics` weekly handler seeded alongside
  `rollup_daily_metrics`; `ANALYTICS_METRICS_RETAIN_DAYS` env override.
- Hot-path fix: PayPal + Stripe capture sites were passing
  `parseFloat(total_price)` (number, not string) and omitting the
  required `currency` param to `incrementToday` — corrected to
  `String(total_price)` + `order.currency || 'USD'`.
- Tests: **15 new** (22 total in `daily-metrics.test.ts`) covering
  `findMissingDates` edges (empty, full, gaps, duplicates, timestamps,
  inverted span, single-day, month boundary).
- Live smoke green on server 2.

### PR5 — God-admin platform-wide analytics (commit `f6e4739`, `ca9ae48`)

Gives Thai a Shopify-Plus-style operator view: all shops at once,
period-over-period deltas, leaderboards, time series, and health
signals — read off `daily_metrics`, not `orders`.

- `packages/core/src/modules/analytics/platform.ts` (NEW, ~550 lines):
  - `getPlatformOverview` — aggregate counts + revenue + AOV + refunds
    for a range, with previous-period comparison baked in
  - `getShopLeaderboard` — top N shops by `revenue | orders | aov`,
    lateral join for per-shop subqueries (no n+1)
  - `getShopGrowth` — biggest movers between current vs previous window
  - `getPlatformTimeSeries` — daily orders/revenue/shops-active, read
    from `daily_metrics` so cost is O(days) not O(orders)
  - `getPlatformHealth` — zero-revenue shops, at-risk shops (≥ 30% drop),
    suspended count, new shops this period
  - Re-exports `DateRange`, `periodToRange` from `inventory-analytics.ts`
    to keep the period contract shared across merchant + platform reports
  - Pure helpers: `changePercent` (handles zero/NaN/Inf, 2-decimal
    rounded), `classifyDirection` (±5% flat window by default),
    `previousPeriod` (equal-span range immediately before input)
- `platform.test.ts` (NEW) — **22 unit tests**:
  10 × `changePercent` (zero, NaN, Infinity, negatives, large/small,
  2-decimal rounding), 5 × `classifyDirection` (default window, custom
  window, boundary), 7 × `previousPeriod` (7d/30d/90d, span equality,
  zero-duration).
- `apps/god-admin/src/pages/platform-analytics.ts` (NEW, ~420 lines):
  - Period selector (7d/30d/90d); fetches all 5 service functions in
    `Promise.all`
  - 6 overview stat cards (shops / customers / orders / revenue / AOV /
    refunds) with up/down/flat arrows derived from `classifyDirection`
  - Dual-bar time-series chart (blue orders, green revenue) with
    `shops_active` count per day
  - Top-10 shop leaderboard with status badges, drill-down to
    `/god-admin/stores/:id`
  - "Biggest movers" table with Δ% direction badges
  - Two health tables: zero-revenue shops, at-risk shops
  - `readThemeFromRequest(req)` for theme consistency; `db as any` for
    the Kysely dup-types workaround
- `apps/god-admin/src/server.ts` — route wired in Category A:
  `app.get('/god-admin/analytics/platform', ...)`; upstream god-auth
  middleware gates access (no inline auth check needed).
- `apps/god-admin/src/layouts/god-layout.ts`:
  - NAV_GROUPS[0].items (A. Overview) — inserted **Platform Analytics**
    between Real-time Metrics and System Health
  - GOD_COMMANDS — added `nav-platform-analytics` with keywords
    `platform / analytics / overview / revenue / shops / leaderboard /
    growth / health` for ⌘K palette
- `scripts/smoke-phase6-pr5.ts` (NEW, ~400 lines): seeds 3 disposable
  shops (WINNER +200%, LOSER -90%, DORMANT suspended), 4 customers,
  8 orders across current + previous 7-day windows, 7
  `daily_metrics` rows. 10 sections: pure helpers, overview,
  leaderboard (revenue + orders sort), growth, time series
  (YYYY-MM-DD date-format regression check), health (default + strict
  -95% threshold). Cleanup in `finally{}` via scoped `deleteFrom`.
- Live smoke: **51/51 PASSED** on server 2 against `gbox_platform`.
  Real-data observations from live run: platform had 17 shops, 91
  customers, ~$8.27 M revenue this period, **+211%** vs prev, 64 orders
  — confirms the service scales under real load and our disposable
  fixture was correctly classified despite mixing with production data.

### Key design choices (Phase 6)

- **Rollup-first, never hit `orders` in hot paths**: every report in
  this phase reads from `daily_metrics`. The only time `orders` is
  scanned is inside the nightly cron or a manual backfill CLI.
- **Period-over-period math in one place**: `changePercent` /
  `classifyDirection` / `previousPeriod` live in `platform.ts` but the
  contract is dead-simple so they can be promoted to a shared
  `analytics/period.ts` later without breaking callers.
- **`DateRange` is one type, shared everywhere**: merchant inventory
  report, merchant customer report, and god-admin platform report all
  consume the same `DateRange { since: ISOString; until: ISOString }`.
  `periodToRange` is the single entry point for `7d | 30d | 90d`.
- **Lateral joins, not n+1 loops**: `getShopLeaderboard` and
  `getShopGrowth` use lateral subqueries for per-shop aggregates. Both
  stay under 200 ms on a 17-shop platform.
- **Kysely dup-types workaround**: `db as any` in god-admin pages
  remains the accepted escape hatch (node_modules/kysely vs
  packages/db/node_modules/kysely collision). Documented once in
  CLAUDE.md; don't re-litigate per PR.

Commits on master:
- `202cf38` Phase 6 PR1 (#42)
- `f73ad2c` Phase 6 PR2 (#43)
- `87eb90a` Phase 6 PR3 (#44)
- `4d7d351` Phase 6 PR4 (#45)
- `f6e4739` + `ca9ae48` Phase 6 PR5 (#46)

---

## Phase 8 — Marketing (in progress, 2026-04-21)

PR1 and PR2 shipped earlier 2026-04-21 (commits `7195395`, `8d1b61a`; PRs
#52, #53). PR3 lands the full SEO stack — per-shop settings, head-tag
injection, a content scanner, and the admin surface that ties them
together.

### PR3 — SEO infrastructure (commit pending, PR pending)

**Ship scope:** migration 064, `packages/core/src/modules/seo/*` (settings
+ crawl-policy + head-injection + scan), admin SEO settings page, live
smoke, drain log.

**Data model — migration 064 (`064_shop_seo_settings.ts`):**
- Adds `shops.seo_settings JSONB NOT NULL DEFAULT '{}'::jsonb`
- Single-column add; no new tables, no new indexes. JSONB lets us evolve
  the shape without rolling another migration every time a merchant-
  configurable SEO knob is added.

**Service layer — `packages/core/src/modules/seo/`:**
- `seo-settings.ts` (`resolveShopSettings`, `setShopSettings`,
  `applyTitleTemplate`, `recordScanReport`, `DEFAULT_SEO_SETTINGS`).
  Settings blob: `meta_title_template`, `meta_description_default`,
  `og_image_url`, `twitter_handle`, `facebook_page_url`, `ga4_id`,
  `gtm_id`, `site_verification_google`, `robots_noindex`, plus
  `last_scan_at` / `last_scan_report` stamped by the scanner. Strict
  regex validation for analytics IDs — malformed values are dropped at
  the service boundary, not escaped into the page. `setShopSettings`
  preserves the scan fields when the caller passes `null` so a config
  save doesn't wipe the last scan report.
- `crawl-policy.ts` (`computeCrawlPolicy`, `getShopCrawlPolicy`). Shop
  status (suspended / closed) wins over merchant intent; merchant
  `robots_noindex` is only consulted for active shops.
- `head-injection.ts` (`buildHeadTags`, `buildBodyOpenTags`,
  `buildSeoHeadInjection`). Emits robots noindex, GA4 `gtag.js` pair,
  GTM head + body-open pair, Google site-verification meta. XSS
  defence: reject malformed IDs at the regex gate; never escape-and-
  emit (that's how script breakouts happen in tracking tags).
- `scan.ts` (`scanShop`, `analyseScan`, `ScanReport`, `SeoFetcher`).
  Regex-based HTML parser with bounded quantifiers (`{0,500}`,
  `{0,1000}`) to guard ReDoS. Issue codes: `missing-title`,
  `title-too-short`, `title-too-long`, `duplicate-title`,
  `missing-meta-description`, `meta-description-too-short`,
  `missing-h1`, `multiple-h1`, `missing-canonical`, `images-without-
  alt`. Score heuristic: 100 baseline, −8/error, −3/warning, −1/info,
  floor at 0. URL discovery (`buildScanUrls`) joins `shops` +
  `shop_domains` for the primary domain, walks 10 published products +
  10 published collections, caps at 30 URLs so the merchant's own
  origin never gets hammered by a stray scan.

**Admin surface — `apps/store-admin/src/pages/seo-settings.ts`:**
- Routes: `GET/POST /admin/store/:slug/marketing/seo/settings`,
  `POST /admin/store/:slug/marketing/seo/scan`.
- Three form cards: meta defaults / analytics & tracking / indexing
  toggle. Separate run-scan form so a scan never requires re-saving.
- Score-tinted score badge + issue cards grouped by severity + empty
  state. Flash messages via existing `notify` helper.
- **Iron rule 5 strict:** every error path says either "Please set a
  primary domain for your storefront before running a scan." or "The
  scan could not complete. Please try again or contact Gbox support."
  No god-admin surface is ever named in the seller UI. A regex
  audit (`/god[\s_-]?admin|\/god-admin\/|god_admin_/i`) asserts this
  invariant across render + save + scan surfaces.
- Older `getSeoManager` overview at `/marketing/seo` is preserved —
  that page inspects DB fields (product/collection-level SEO issues);
  this new page controls head-tag injection + runs live HTML scans.
  Two sibling surfaces, same menu section.

**Test counts:**
- `scan.test.ts` — 70 unit (extractors / `analyseScan` every issue code
  / score heuristic boundaries / `scanShop` IO boundary with `vi.fn()`
  stub fetchers).
- `seo-settings.test.ts` (admin page) — 15 unit covering form render,
  noindex checked state, empty + full scan cards, flash messages,
  setShopSettings round-trip, iron-rule-5 regex audit.
- Total new this PR: **85 unit tests** (`scan` + admin page).
- SEO module grand total (including pre-existing `seo-settings`,
  `crawl-policy`, `head-injection`, `meta-tags`, `json-ld`): **177
  unit tests passing.**
- Live smoke: **37/37 PASSED** on server 2 against `gbox_platform`
  (migration 064 applied, 4 shops seeded — active ×2, suspended,
  closed — end-to-end `scanShop → recordScanReport → resolveShopSettings`
  round-trip + cross-shop isolation + iron-rule-5 audit of persisted
  blobs, cleanup in `finally{}`).

**Key design choices (Phase 8 PR3):**
- **Regex HTML parser over cheerio/linkedom**: the scanner only looks
  at 5 tags (`<title>`, `<meta name=description>`, `<h1>`,
  `<link rel=canonical>`, `<img>`). Bounded quantifiers guard ReDoS.
  Adding a 2MB HTML-parser dep tree for this is not justified.
- **Reject, don't escape, analytics IDs**: GA4 / GTM / site verification
  values hit strict regex gates (`/^G-[A-Z0-9]{4,20}$/`,
  `/^GTM-[A-Z0-9]{4,10}$/`, `/^[A-Za-z0-9_-]{10,100}$/`). Malformed
  values are dropped at the service boundary. Escaping user-supplied
  JS into a tracking script is how you ship an XSS vector.
- **Scan URL cap = 30**: protects the merchant's own storefront origin
  from a runaway scanner. Cap enforced inside `scanShop` before fetches
  begin, not after.
- **Scan fields survive settings save**: `setShopSettings({..., last_
  scan_at: null, last_scan_report: null })` means "caller has nothing
  to say about scan state, preserve what's in the DB." Only
  `recordScanReport` ever writes those two fields. This keeps the
  admin form's submit handler simple — it doesn't need to know the
  scan exists.
- **Iron rule 5 is tested, not just asserted**: the admin page tests
  include a regex audit that walks every rendered HTML surface + every
  flash message emitted during save/scan failures. If a future change
  accidentally surfaces a god-admin path in a seller-facing string, CI
  fails before merge.

**Files (new):**
- `packages/db/src/migrations/064_shop_seo_settings.ts`
- `packages/core/src/modules/seo/seo-settings.ts` + `.test.ts`
- `packages/core/src/modules/seo/crawl-policy.ts` + `.test.ts`
- `packages/core/src/modules/seo/head-injection.ts` + `.test.ts`
- `packages/core/src/modules/seo/scan.ts` + `.test.ts`
- `apps/store-admin/src/pages/seo-settings.ts` + `.test.ts`
- `scripts/smoke-phase8-pr3.ts`

**Files (modified):**
- `packages/db/src/migrations/run.ts` (wire up 064)
- `packages/db/src/schema/tables.ts` (type `shops.seo_settings` as JSONB)
- `apps/store-admin/src/server.ts` (register 3 new routes)

Commits on master:
- `7195395` Phase 8 PR1 — campaigns service + cron + admin (#52)
- `8d1b61a` Phase 8 PR2 — abandoned-cart recovery (#53)
- `ee71dca` Phase 8 PR3 — SEO infrastructure (#54)
- `b7a4cd1` Phase 8 PR4 — reviews moderation + notifications polish (#55)

### Phase 8 PR4 — Reviews moderation + notifications polish (2026-04-21)

PR #55 (squash-merged as `b7a4cd1`). Wraps Phase 8 by fleshing out the two surfaces that had been
stubbed since Phase 4: public review submission from the storefront
and bucket-level notifications in the admin. Adds a pure-function
spam heuristic, merchant replies, bulk moderation, notification
categories + deep links, and a storefront review-write route with
rate limiting.

**Migration 065 — `065_reviews_reply_and_notifications_metadata.ts`:**
Idempotent `ALTER TABLE` migration. Adds to `product_reviews`:
`reply_body TEXT NULL`, `reply_author TEXT NULL`,
`replied_at TIMESTAMPTZ NULL`, `spam_score INTEGER NOT NULL DEFAULT 0`.
Adds to `notifications`: `category TEXT NULL`, `link TEXT NULL`, plus
`idx_notifications_shop_read_created (shop_id, read, created_at DESC)`
so the bell drawer's unread count stays cheap at scale. Full `down()`
reverses in column drop order.

**Reviews service — `packages/core/src/modules/reviews/service.ts`:**
- `computeSpamScore(body, email, rating) → 0..100` — pure, bounded
  regexes. Signals: URL count (+25 each, +80 at 3+), ALL-CAPS ratio
  (+15), short body (+20), spam keywords cap at +40, junk email
  domains (+10), 5-star with <10 chars body troll (+10). Clamped to
  100. ReDoS-safe — every regex bounded with `{0,50}` etc.
- `submitPublicReview(db, shopId, productId, input)` — runs
  `computeSpamScore`, picks `status=spam` when score ≥ 80 (threshold
  constant `SPAM_SCORE_THRESHOLD = 80`), otherwise `pending`. Persists
  the score on the row so the admin list can sort/filter later.
- `setReviewReply(db, reviewId, body, author)` — trims, nulls-clear
  all three columns atomically, stamps `replied_at` with ISO now.
- `bulkUpdateReviewStatus(db, shopId, ids[], status)` — shop-scoped
  (`WHERE shop_id = ? AND id IN (?)`), empty-array no-op, returns
  number of rows updated for the admin flash message.
- `extractReply(row)` — narrow `{body, author, repliedAt}` struct for
  the storefront JSON so we never leak columns the public doesn't own.

**Notifications service — `packages/core/src/modules/notifications/service.ts`:**
- 6 new types: `review_submitted|approved|rejected|deleted|replied|spam_flagged`.
- `NotificationCategory` union: 8 buckets — orders, inventory, customers,
  billing, reviews, marketing, system, other.
- `inferCategory(type)` — pure type→bucket mapping, falls back to `other`.
- `groupByCategory(rows)` — list → bucketed object; uses stored
  `category` first, falls back to `inferCategory(row.type)` for legacy
  NULL rows, sinks bogus categories into `other`.
- `createNotification()` stamps category (explicit || inferred) + link.
- `getNotifications()` accepts `category` — emits an OR clause that
  matches rows with explicit category OR legacy NULL-category rows
  whose type infers to the same bucket. Keeps the filter honest across
  the upgrade boundary.
- `typesForCategory(category)` exported so admin pages querying
  Kysely directly can reuse the inverse mapping.

**Storefront public review routes — `apps/storefront/src/middleware/reviews-routes.ts`:**
Express Router factory (`buildReviewsRoutes(deps)`):
- `GET /shops/:shopId/products/:productId/reviews` → narrow JSON list
  (omits `email`, `status`; includes merchant reply via `extractReply`)
- `POST /shops/:shopId/products/:productId/reviews` → 202 Accepted;
  **always returns `status='pending'` even when the heuristic flagged
  the submission as spam** — prevents bots from iteratively learning
  which copy triggers the filter (bot-feedback defence).
- Rate limits: 5 submits/minute per IP per product, 60 reads/minute.
  Fixed-window in-memory `Map<key, {count, resetAt}>`. Test-only
  `reset()` hook for deterministic rate-limit tests.
- Validation: rating 1–5 integer, body 3–5000 chars, author_name 1–120,
  UUID shape check on both path params (blunt 400 for malformed IDs).
- Accepts both `snake_case` and `camelCase` body fields.
- 500 responses use the neutral copy "Something went wrong. Please try
  again." (iron rule 5 — never leaks god-admin or internal paths).
- Mounted from `apps/storefront/src/app.ts` when `options.reviewsRoutes`
  is provided; production adapter bridges DB + notification emit.

**Admin reviews page — `apps/store-admin/src/pages/reviews.ts`:**
- New "Spam" filter tab with live count; `statusBadge()` renders
  `spam` as neutral (not danger) so the moderator can recover false
  positives without the red-alert vibe.
- Per-row checkbox column (references a hidden `<form id="bulk-form">`
  via the `form` attribute — keeps the rows valid inside `<tbody>`).
- Header row "select-all" checkbox with a 4-line onclick JS.
- Bulk-action toolbar above the table: Approve / Reject / Mark spam /
  Delete selected. Delete confirms via `window.confirm`.
- Inline reply block per row: purple-left-border card for existing
  reply, `<details>` summary for post/edit/clear. No JS needed — the
  `<details>` tag keeps the form tucked until the merchant clicks.
- Expanded body snippet (200 chars) for fast skim.
- `postReply(req, res, db)` — cross-tenant shop guard via
  `getReview` + `shop_id` match, maps `clear=1` form flag to
  `setReviewReply(…, null, null)`, emits `review_replied` notification.
- `postBulkAction(req, res, db)` — dispatches on `action` to
  `bulkUpdateReviewStatus` (approve/reject/spam) or sequential
  `deleteReview` (delete), shop-scoped per row. Empty selection and
  unknown actions are soft-fail redirects so non-JS browsers stay sane.

**Admin notifications page — `apps/store-admin/src/pages/notifications-admin.ts`:**
- Category tab row under the existing All/Unread tabs. 8 buckets, each
  with its count (count derived from a single `GROUP BY category`
  query so the tab bar doesn't fan out to 8 round-trips).
- Legacy-row fallback count: NULL-category rows are lumped into `other`
  for the tab-bar display. The actual filtered list (via
  `applyCategoryFilter`) uses the full type-based OR so the rows on
  screen are right even when the count is undercounted.
- Per-row category badge + "View" CTA when `link` is set. Link
  sanitisation: only accepts same-origin paths (starts with `/`,
  rejects `//`) — defence against an open-redirect in a future
  `notifications.link` insert that wasn't vetted.
- "Mark all as read" honours the active category when filtered —
  renames to "Mark 'reviews' as read" (e.g.) and only clears rows in
  that bucket. Unfiltered behaviour unchanged.
- Hidden `category` field posts back alongside CSRF so the server-side
  scope matches what the user saw.

**Test counts:**
- `moderation.test.ts` — 26 (every spam signal, threshold clamp,
  submitPublicReview routing, setReviewReply persist + clear,
  bulkUpdateReviewStatus empty-array + shop-scope, extractReply narrow
  shape).
- `categorization.test.ts` — 15 (every type → bucket, groupByCategory
  with/without explicit category, bogus → other, order preservation,
  createNotification stamps category + link + inferred fallback).
- `reviews-routes.test.ts` — 24 (parse validation, UUID shape check,
  GET 404/400/200-narrow/429/500-neutral, POST 202 happy + spam-
  redaction + 400 + 429 + 500 neutral, iron rule 5 regex audit).
- `reviews.handlers.test.ts` — 12 (admin postReply + postBulkAction,
  body-coercion, cross-tenant guard, iron rule 5).
- Total new this PR: **77 unit tests**.
- Grand total across touched modules (including pre-existing reviews +
  notifications): **128 unit tests passing.**
- Live smoke: **23/23 PASSED** on server 2 against `gbox_platform`
  (migration 065 applied, 2 shops + 2 products seeded, end-to-end
  submitPublicReview + setReviewReply + bulkUpdateReviewStatus +
  createNotification + groupByCategory + category filter + legacy-row
  fallback + iron-rule-5 audit, cleanup in `finally{}`).

**Key design choices (Phase 8 PR4):**
- **Spam status redacted from storefront**: the 202 response always
  reports `status='pending'`. Auto-spam flagging is admin-side only
  and never confirmed back to the submitter. Rationale: every error
  signal you return to a bot trains the next submission.
- **Score stored, not just status**: `spam_score` persists alongside
  `status` so admins can sort a grey-area queue without re-running
  the heuristic. Also lets a future re-train / manual retune re-bucket
  rows cheaply.
- **Legacy-row fallback at query time, not backfill**: rather than
  running an UPDATE over every pre-065 notifications row, the category
  filter emits an OR that matches `category = ?` OR
  `(category IS NULL AND type IN (...))`. Cheaper on production and
  keeps the upgrade idempotent even if migration 065 runs partially.
- **Bucket counts via single GROUP BY**: the admin tab bar needs 8
  counts. We do one aggregated query instead of 8 per-tab COUNTs.
  Trade-off: legacy-NULL rows are undercounted on the tab bar (they
  land in `other`) but show up correctly on the list when clicked.
- **Rate limit is per-IP + per-product**: not per-IP global. Stops a
  bot from sharding across many products to bypass the 5/min cap, and
  doesn't penalise a merchant legitimately leaving a bunch of reviews
  across their catalogue from the same office IP.
- **Iron rule 5 audited in code**: smoke assertion [23] dumps every
  text field on every seeded row and regex-checks for `god[_\s-]?admin`.
  Unit tests for admin handlers assert the same on redirect URLs.

**Files (new):**
- `packages/db/src/migrations/065_reviews_reply_and_notifications_metadata.ts`
- `packages/core/src/modules/reviews/moderation.test.ts`
- `packages/core/src/modules/notifications/categorization.test.ts`
- `apps/storefront/src/middleware/reviews-routes.ts` + `.test.ts`
- `apps/store-admin/src/pages/reviews.handlers.test.ts`
- `scripts/smoke-phase8-pr4.ts`

**Files (modified):**
- `packages/db/src/migrations/run.ts` (wire up 065)
- `packages/db/src/schema/tables.ts` (reply + spam_score, category + link)
- `packages/core/src/modules/reviews/service.ts` (spam heuristic,
  submitPublicReview, setReviewReply, bulkUpdateReviewStatus,
  extractReply, 'spam' status)
- `packages/core/src/modules/notifications/service.ts` (6 review types,
  NotificationCategory, inferCategory, groupByCategory,
  createNotification category+link, getNotifications category filter,
  typesForCategory exported)
- `apps/storefront/src/app.ts` (mount reviewsRoutes)
- `apps/store-admin/src/pages/reviews.ts` (Spam tab, checkboxes, bulk
  toolbar, reply block, postReply, postBulkAction)
- `apps/store-admin/src/pages/notifications-admin.ts` (category tabs,
  category filter in base query + counts, per-row badge + link, mark-
  all-read category scoping)
- `apps/store-admin/src/server.ts` (register 2 new reviews routes)
