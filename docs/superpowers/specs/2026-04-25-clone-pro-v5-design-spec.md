# Clone Pro v5 — Design Spec

> **Status:** locked 2026-04-25 by Thai
> **Scope:** Full rewrite of Clone Pro pipeline execution + verification layers. v4 UI + queue + DB preserved; v5 replaces stub internals with real end-to-end flow.
> **Target:** Clone any Shopify-class storefront 1:1 + crawl 100% catalog, map every scraped element to the correct Gbox bucket, produce a preview URL and grade A/B before publish.

---

## 1. Goals (pass/fail for v5 complete)

1. **Clone 1:1 fidelity** — visual diff ≥85% (pixel delta), route-check pass ≥95% across imported URLs.
2. **Full catalog crawl** — 100% products (no SKU dropped), with variants / options / images / descriptions.
3. **Correct bucket mapping** — every scraped element lands in exactly one Gbox table; no orphans, no mis-categorisation. Hard guardrails enforced at the scraper layer.
4. **Preview before publish** — every clone lands at `<jobId>.clone-preview.gbox.local` for seller approval; publish promotes to primary domain.
5. **Idempotent re-clone** — re-running on the same source URL diffs against the previous import and upserts; never duplicates.
6. **Transaction-safe import** — inject failure mid-import → full rollback, no orphan rows.
7. **Robots.txt + rate limit enforced** — polite fetch, per-shop concurrency cap, Disallow respected.

## 2. Non-goals (explicitly excluded from v5)

- Vision-based design extraction (deferred to v6 — cost $1/clone + 60s latency not justified for MVP).
- Shopify Plus checkout extensions (platform-specific, outside scraping scope).
- Real-time sync / ongoing mirror of source (v5 is one-shot clone; refresh = re-clone).
- Paid asset rehoming (stock photos with licensing — flagged but not downloaded).

## 3. Locked architectural decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Shopify-first MVP in PR1 | 80% of real clone targets are on Shopify; `/products.json` public, no auth |
| D2 | Playwright (not Cheerio-only) for generic HTML in PR2 | SPA / React sites fail Cheerio-only extraction |
| D3 | Vision model = DEFER to v6+ | Cost + latency not justified for MVP |
| D4 | `runInSerializable` wrap all persistence (reuse Phase 15 PR1 helper) | All-or-nothing; rollback on failure |
| D5 | Content-addressed storage `media/<sha1>.<ext>` — local fs first, R2 when `R2_BUCKET` env set | Auto-dedup; immutable cache keys |
| D6 | Preview subdomain `<jobId>.clone-preview.gbox.local`, 7-day TTL | Reduce friction; build confidence |
| D7 | Robots.txt + rate limit enforced at worker level | Legal + ethical; avoid DDoS on source |
| D8 | Checkpoint-based resume via `clone_checkpoints(job_id, phase, step, state_json)` | Granular resume, replaces stage-boundary |
| D9 | Free tier = preview-only 7 days | Acquisition funnel without shipping two SKUs |
| D10 | Idempotent re-clone — unique partial index on `(shop_id, source_host)` where `status='current'` | Cannot duplicate catalog |
| D11 | Export `DESIGN.md` alongside `theme_config.json` | Leverages awesome-claude-design ecosystem; enables future redesign feature |

## 4. System architecture

```
          ┌──────────────────────────────────────────────────────────────┐
          │                    CLONE PRO v5 PIPELINE                     │
          └──────────────────────────────────────────────────────────────┘

Input: source_url, shop_id, scope flags {products, pages, blog, theme}
│
├─► ① DETECT PLATFORM (new in v5)
│     ├─ HEAD + probe /products.json?limit=1  → Shopify
│     ├─ probe wp-json/wc/v3 → WooCommerce  (PR2)
│     └─ fallback → Generic HTML            (PR2)
│
├─► ② DISCOVER (polite crawl, respects robots.txt)
│     ├─ sitemap.xml fetch + parse
│     ├─ collect page URLs by pattern
│     └─ write job stage: "discovery complete — N pages, M products"
│
├─► ③ SCRAPE (platform-specific, parallel-safe)
│     ├─ shopifyProductsScraper(source_url) → Product[]
│     ├─ shopifyCollectionsScraper(source_url) → Collection[]
│     ├─ sitemapPagesScraper(sitemap) → Page[]
│     ├─ menuParser(homepage_html) → MenuTree
│     └─ themeTokensExtractor(homepage_html + computed_css) → ThemeTokens
│
├─► ④ VALIDATE (bucket guardrails — R3)
│     ├─ every Product has handle + title + ≥1 image
│     ├─ every Collection has handle + ≥1 product reference
│     ├─ every Page has URL + title + body
│     ├─ menu item URL resolves to imported resource OR flagged "broken"
│     └─ reject invalid → log warning, skip (no orphan row)
│
├─► ⑤ PERSIST (inside runInSerializable txn)
│     ├─ upsert theme_config from tokens
│     ├─ upsert products + variants + images + options
│     ├─ upsert collections + collection_products pivot
│     ├─ upsert pages
│     ├─ upsert menus + menu_items
│     └─ write clone_checkpoint(phase='persist', step='done')
│
├─► ⑥ ASSET REHOST (PR3 — deferred stub in PR1)
│     ├─ download image URLs → SHA1 → local fs / R2
│     └─ rewrite product_images.url to content-addressed path
│
├─► ⑦ PREVIEW MOUNT
│     ├─ register <jobId>.clone-preview.gbox.local in cloned_previews table
│     ├─ 7-day TTL
│     └─ write clone_checkpoint(phase='preview', step='done')
│
├─► ⑧ VERIFY + GRADE
│     ├─ route-check: HEAD every imported URL via preview subdomain
│     ├─ CSS extraction %: tokens found / expected
│     ├─ product completeness %: imported / discovered
│     └─ weighted grade: A (≥90) / B (≥75) / C (≥60) / D (≥45) / F (<45)
│
└─► ⑨ JOB COMPLETE
      ├─ storefront_clone_jobs.status = 'succeeded'
      ├─ storefront_clone_jobs.grade = ...
      ├─ emit notification (email preference-aware)
      └─ UI surfaces "Publish" or "Discard" buttons
```

## 5. Element mapping matrix (R3 guardrails — critical)

| Source | Gbox table(s) | Extraction method | Anti-mix rule |
|---|---|---|---|
| Product | `products`, `product_variants`, `product_images`, `product_options` | Shopify: `/products.json?page=N`; Generic: schema.org `Product` JSON-LD | Must originate from `/products/<handle>` URL or have `itemtype="schema.org/Product"` |
| Collection | `collections`, `collection_products` | Shopify: `/collections.json` + per-handle `/collections/<h>/products.json`; Generic: URL pattern `/collections/*` | Collection with 0 products → skip (not imported) |
| Static page | `pages` | sitemap filter: `/pages/*`, `/about`, `/contact`, `/faq`, `/terms`, `/privacy`, `/shipping`, `/returns` | Reject URLs starting with `/products/`, `/collections/`, `/blogs/`, `/cart`, `/checkout`, `/account` |
| Blog post | `blog_posts`, `blogs` | Shopify: `/blogs/<h>.atom`; Generic: `<article itemtype="schema.org/Article">` | Requires `<article>` wrapper OR RSS feed entry; reject bare `<div class="post">` without microdata |
| Menu | `menus`, `menu_items` (hierarchy: `depth`, `position`, `parent_id`) | Parse `<nav>`, `<header role=banner>` — anchor tree | URL must resolve to imported resource; unresolved → marked `broken=true`, not linked |
| Theme tokens | `theme_config` (JSONB) | CSS custom properties + hero section computed styles | Extract: primary color, secondary color, body font, heading font, spacing base, border radius |
| Theme sections | `theme_sections` (Liquid) | PR4 scope — deferred from PR1 | PR1 uses Gbox default theme + token override |
| Media assets | `media_assets` + storage bucket | Download → SHA1 → `media/<sha1>.<ext>` | PR3 scope — PR1 keeps original URLs (flag as external) |

**Unmatched element handling:** If a scraped resource doesn't satisfy any rule, log a warning to `storefront_clone_jobs.stages_json` with `{type: 'skip', reason: '<why>', source_url: <url>}`. Never create a "generic" or "other" row.

## 6. Data model changes

### 6.1 New migration: `091_clone_checkpoints.ts`

```sql
CREATE TABLE clone_checkpoints (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES storefront_clone_jobs(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL,     -- 'detect' | 'discover' | 'scrape' | 'validate' | 'persist' | 'asset_rehost' | 'preview' | 'verify'
  step        TEXT NOT NULL,     -- free-form subphase identifier
  state_json  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- resumable state (e.g., pagination cursor, last URL)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (phase IN ('detect','discover','scrape','validate','persist','asset_rehost','preview','verify'))
);

CREATE INDEX idx_clone_checkpoints_job_phase ON clone_checkpoints (job_id, phase, created_at DESC);
```

### 6.2 Schema additions

```sql
-- Idempotent re-clone guard
CREATE UNIQUE INDEX idx_clone_jobs_shop_source_current
  ON storefront_clone_jobs (shop_id, (config_json->>'source_host'))
  WHERE status NOT IN ('failed','cancelled','discarded');

-- Preview subdomain registry
CREATE TABLE cloned_previews (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               UUID NOT NULL REFERENCES storefront_clone_jobs(id) ON DELETE CASCADE,
  subdomain            TEXT NOT NULL UNIQUE,
  expires_at           TIMESTAMPTZ NOT NULL,
  approved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 6.3 `storefront_clone_jobs` column additions (via 091 migration)

- `platform`: TEXT — detected platform (`shopify` | `woocommerce` | `generic` | `unknown`)
- `source_host`: TEXT GENERATED (extracted from source_url) — for uniqueness constraint
- `checkpoint_id`: UUID — current checkpoint (fast resume lookup)
- `preview_url`: TEXT — populated after phase ⑦
- `design_md`: TEXT — exported DESIGN.md content (D11)

## 7. Integration with awesome-claude-design (D11)

After phase ⑤ (persist theme_config), v5 generates a `DESIGN.md` file following the awesome-claude-design format:

```markdown
# <Shop Name> Design System

## Brand voice
<inferred from H1/hero copy>

## Tokens
### Color
- primary: #<hex>
- secondary: #<hex>
- background: #<hex>
- text: #<hex>

### Typography
- heading: <font-family>, <weight>
- body: <font-family>, <weight>
- scale: 12/14/16/18/24/32/48

### Spacing
base: <px>  (4/8/16/24/48/80)

## Components
### Button
- radius: <px>
- shadow: <css>
- height: <px>

### Card
...
```

This file is stored in `storefront_clone_jobs.design_md` AND exposed as download link in the preview UI. Sellers can:

1. Download `DESIGN.md` → upload to [Claude Design](https://claude.ai/design) → get alternate design systems → download revised `DESIGN.md` → re-import to Gbox as theme override.
2. Browse the pre-loaded awesome-claude-design presets (mirrored at `xaozayta/awesome-claude-design`) → pick one → apply as theme override on the cloned store.

This feature is scoped to PR4+ (not PR1), but the `design_md` column and generation hook land in PR1 for forward compatibility.

## 8. Preview subdomain mechanics

- Wildcard DNS `*.clone-preview.gbox.local` (dev) / `*.clone-preview.gbox.app` (prod) routes to a preview server.
- Preview server renders `shop_id = <lookup from subdomain>` using cloned data — reuses Gbox storefront renderer, no separate pipeline.
- TTL: 7 days from job completion. Background sweeper (cron every 6h) marks expired previews and frees the subdomain.
- On seller "Publish" action:
  - primary domain binding transferred (tenant domain update)
  - preview subdomain deregistered
  - `storefront_clone_jobs.published_at = now()`

## 9. Verification grading

Grade is a weighted composite:

| Metric | Weight | Threshold A | Threshold B |
|---|---|---|---|
| Route-check pass rate | 40% | ≥95% | ≥85% |
| Product completeness (imported / discovered) | 25% | ≥98% | ≥90% |
| CSS token extraction (tokens found / tokens expected) | 15% | ≥80% | ≥60% |
| Page body content non-empty | 10% | ≥95% | ≥80% |
| Menu link resolution (non-broken) | 10% | ≥90% | ≥75% |

**Grade bands:** A = score ≥90 · B = ≥75 · C = ≥60 · D = ≥45 · F = <45.

A failing grade (D/F) does NOT prevent publish — seller can override — but the UI shows warnings and suggests specific fixes per failing metric.

## 10. Rate limiting + robots.txt

- `polite-fetch.ts` (existing) MUST be called for every HTTP request in v5. Enforces:
  - max 5 requests/sec per source host (configurable per-shop via `CLONE_RATE_LIMIT_RPS`)
  - respects `Retry-After` response header
- `robots-guard.ts` (existing) MUST be called once at job start. Parses robots.txt, respects `Disallow` + `Crawl-delay`. If source explicitly disallows bots on `/products/*` or `/collections/*`, the job fails with error code `ROBOTS_DISALLOWED` and surfaces a seller-safe message ("This site does not permit automated cloning").
- Per-shop worker concurrency: max 2 clones in flight (reuses Phase 7 throttle mechanism).

## 11. Security + Iron Rule 5

- All error paths route through `safeMessage()` → "Please contact Gbox support." never leak platform detection results, scraper internals, or grade failure reasons to seller UI.
- `clone_checkpoints.state_json` may contain source URL fragments — never exposed to UI; god-admin surface only.
- `DESIGN.md` export is seller-visible — sanitised to strip any source-host identifying strings beyond brand name.
- Preview subdomain isolates cloned data per shop; no cross-tenant leak.

## 12. PR breakdown (roadmap)

| PR | Scope | Effort | Ship target |
|---|---|---|---|
| **PR1** (this plan) | Shopify-native end-to-end MVP: detect + discover + scrape + validate + persist + basic verify + grade. Checkpoint + idempotency infra. | 2500 LOC + 1200 LOC tests | Week 1-2 |
| PR2 | Generic HTML fallback: Playwright crawler + schema.org extractor + RSS blog parser | 1800 LOC | Week 3-4 |
| PR3 | Asset rehost: download → SHA1 → R2/local; CSS AST rewrite | 1200 LOC | Week 5 |
| PR4 | Theme generation: HTML → Liquid section converter; DESIGN.md-driven redesign mode | 2200 LOC | Week 6-7 |
| PR5 | Verification polish: visual diff (Playwright screenshot compare), Lighthouse integration, grade algorithm tuning | 1000 LOC | Week 8 |

**PR1 defines the skeleton that PR2-5 extend.** New platform scrapers drop in beside `shopify-*.ts`; asset rehost hooks into phase ⑥ stub; verification metrics expand in phase ⑧.

## 13. Success criteria for PR1 (test plan)

### Integration test target: a real Shopify store
Pick `https://www.allbirds.com` (public, well-structured, ~200 SKUs) as canonical test target.

**Pass conditions:**
- `npx tsx scripts/smoke-phase19-pr1.ts` → 8+ assertions pass (offline using mocks)
- Manual end-to-end test on dev box:
  - Enqueue clone job with source_url=allbirds.com
  - Job completes in <10 minutes
  - ≥95% products imported (verified by product count vs /products.json count)
  - 100% collections + pivot
  - All main nav links resolve
  - ≥80% of /pages/* URLs imported
  - Preview URL accessible, renders homepage
  - Grade ≥ B
- `npm test`: 0 new failures, 0 new tsc errors on clone-pro/v5/**
- Transaction rollback test: inject DB fail mid-persist → no partial rows, job marked failed with error_code, `stages_json` has complete trace

### Unit coverage target
- ≥40 unit tests across scrapers / persisters / verifier / grader
- ≥90% line coverage on v5 module files

## 14. Open questions → locked for PR1

All locked per D1-D11. No open questions at PR1 scope. Any ambiguity during implementation defers to PR2+ (e.g., Generic HTML corner cases, vision-based extraction).

---

## Appendix A: v5 module file layout

```
packages/core/src/modules/clone-pro/v5/
├── pipeline.ts                     # phases ① → ⑨ orchestrator
├── platform-detect.ts              # phase ① — Shopify/Woo/Generic
├── index.ts                        # barrel, registerAllV5()
├── types.ts                        # shared types (Product, Collection, Page, MenuTree, ThemeTokens)
│
├── scrapers/
│   ├── shopify-products.ts         # /products.json paginator
│   ├── shopify-collections.ts      # /collections.json + per-handle
│   ├── sitemap-pages.ts            # sitemap.xml filter
│   ├── menu-parser.ts              # <nav> anchor tree
│   ├── theme-tokens.ts             # CSS AST → tokens
│   └── *.test.ts
│
├── validate/
│   ├── guardrails.ts               # R3 rules enforcement
│   └── guardrails.test.ts
│
├── persisters/
│   ├── import-transaction.ts       # runInSerializable wrap
│   ├── products-persist.ts
│   ├── collections-persist.ts
│   ├── pages-persist.ts
│   ├── menus-persist.ts
│   ├── theme-persist.ts
│   └── *.test.ts
│
├── verify/
│   ├── route-check.ts              # HEAD every URL
│   └── route-check.test.ts
│
├── design-md-export.ts             # D11 — generate DESIGN.md from theme tokens
├── design-md-export.test.ts
│
├── grader.ts                       # weighted composite → A-F
└── grader.test.ts

packages/db/src/migrations/
└── 091_clone_checkpoints.ts

scripts/
└── smoke-phase19-pr1.ts
```

## Appendix B: sample `DESIGN.md` output structure

See `E:/Gbox Platform vibecode/clone-refs/awesome-claude-design/` for reference files. v5 output follows the [getdesign.md](https://getdesign.md/what-is-design-md) format so seller can drop directly into Claude Design without edits.

---

**Locked by Thai 2026-04-25. Ready for plan file + implementation.**
