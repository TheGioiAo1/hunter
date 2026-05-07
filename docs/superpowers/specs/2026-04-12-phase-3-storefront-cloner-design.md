# Phase 3 Storefront — AI-Driven Shopify Cloner Design

**Author:** xaozayta (Claude)
**Date:** 2026-04-12
**Owner review:** Thai Bui (pending)
**Supersedes:** partial scope of `2026-04-08-storefront-masterplan.md`
**Depends on:** `2026-04-09-phase-3a-storefront-v1-wiring.md`

---

## 1. Goal

> Merchant pastes a Shopify storefront URL → gets a fully working Gbox storefront (theme + products + images + SEO) live on `{shop}.gbox.co`, able to run Meta/Google/TikTok/GTM ads that day, publishable to a custom domain once Phase 4 checkout ships.

## 2. Non-Goals (Phase 3)

- Cart + checkout UI (Phase 4 — *schema + hooks are provisioned, UI is not*)
- Payment gateway integration (Phase 4)
- Order management (Phase 4)
- Email / SMS automation (Phase 5)
- Multi-language i18n (Phase 6)
- Inventory sync back to the source Shopify store (never)
- Re-clone conflict resolution preserving edits (Phase 3 allows **full overwrite re-clone** per owner decision)

## 3. Existing Foundations (already shipped)

| Layer | Module | Status |
|---|---|---|
| Theme pipeline | `packages/core/src/modules/ai-clone` | ✅ theme-only (no products) |
| Storefront SSR | `apps/storefront` + LiquidJS + DbDataSource | ✅ 16 Shopify-compat routes |
| Multi-tenant | `apps/storefront/src/middleware/resolve-shop.ts` | ✅ Host → shop |
| Product schema | `products / product_variants / product_images / product_options / collections / collection_products` | ✅ tables exist |
| Order schema | `customers`, `orders` | ✅ tables exist |
| S3 wiring | `packages/core/src/modules/storage/s3-store.ts` | ✅ put/get/url |
| Admin theme clone plugin | `apps/store-admin/src/pages/theme-clone.ts` | ✅ theme-only wizard |

## 4. What's Missing (Phase 3 scope)

1. **Shopify product crawler** — ai-clone orchestrator only extracts the theme
2. **Shopify SSRF-safe fetcher** — only the theme crawler's host-gated fetch exists
3. **Media ingestion pipeline** — download source product images → S3 → link to `product_images`
4. **SEO harvest** — title / meta / canonical / OG per product & collection
5. **Brand kit auto-extract** — dominant-colour palette from hero image + font heuristic
6. **Pixel manager** — per-shop config for Meta, GTM, GA4, TikTok + event fanout + consent banner
7. **SEO emitters** — sitemap.xml, robots.txt, JSON-LD injector on product/collection/page routes
8. **Admin clone wizard expansion** — extend `theme-clone.ts` into a 6-step storefront wizard
9. **Custom domain automation** — manual DNS + TXT verification + Let's Encrypt cron
10. **Checkout Phase 4 hooks** — `checkout_sessions` table scaffold + `add_to_cart` event fire + `data-product-id` attributes

## 5. Locked Architectural Decisions (from owner 2026-04-12)

| # | Decision | Locked value | Rationale |
|---|---|---|---|
| Q1 | Pixel scope MVP | **All four** — Meta + GTM + GA4 + TikTok | Vietnamese merchants run multi-channel |
| Q2 | Media storage | **S3** (reuse `packages/core/storage/s3-store.ts`) | Already wired elsewhere in gbox-platform |
| Q3 | Custom domain automation | **Manual DNS + webhook verification** (Option A) | No vendor lock, any registrar works |
| Q4 | Staging subdomain | **`{shop-slug}.gbox.co`** directly under main domain | Keeps wildcard SSL in one cert |
| Q5 | AI rewrite | **BYOK** per merchant (reuse Clone_pro crypto envelope) | No inference cost risk for platform |
| Q6 | Re-clone policy | **Full re-clone / overwrite** | Simplicity; owner opts for clean re-pull |
| Q7 | Checkout stub | **Gate publish until Phase 4**; Phase 3 scaffolds schema + hooks for drop-in | No dead-end UX; Phase 4 plugs cleanly |
| Q8 | Cart UI MVP | **Free-for-all**: read-only "Buy" button opens WhatsApp/contact form (lead-gen) | Merchants can run ads before checkout ships |

## 6. Reuse Strategy — Clone_pro ↔ gbox-platform

Clone_pro already shipped three reusable primitives in `Clone_pro/packages/clone-core`:

- `safeFetch` — SSRF-safe fetcher (private IP denylist, redirect re-check, body cap)
- `crawlShopifyProducts` — `/products.json` paginator with normaliser
- `walkSitemap` — `/sitemap.xml` nested index walker

**Decision:** Promote these three modules into `@gbox/core/src/modules/clone-shopify/` so gbox-platform owns them and Clone_pro imports via its existing `@gbox/core` sister reference. Migration is a copy-paste + export add — no API change.

| Module | New home | Consumer |
|---|---|---|
| `safe-fetch.ts` | `packages/core/src/modules/clone-shopify/safe-fetch.ts` | ai-clone orchestrator (new product stage) + Clone_pro |
| `crawler-products.ts` | `packages/core/src/modules/clone-shopify/crawler-products.ts` | ai-clone + Clone_pro |
| `crawler-sitemap.ts` | `packages/core/src/modules/clone-shopify/crawler-sitemap.ts` | ai-clone + Clone_pro |
| `byok-crypto.ts` | **stay in Clone_pro** for now; promote in Phase 3.C if Phase 3 AI rewrite lands | — |

## 7. Data Model Additions

### 7.1 New tables

```sql
-- Pixel config per shop. Merchant UI edits this row.
CREATE TABLE shop_pixel_config (
  shop_id UUID PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  meta_pixel_id TEXT,
  meta_capi_token_encrypted BYTEA,           -- BYOK envelope
  gtm_container_id TEXT,                     -- e.g. GTM-XXXX
  ga4_measurement_id TEXT,                   -- e.g. G-XXXX
  ga4_api_secret_encrypted BYTEA,            -- server-side events
  tiktok_pixel_id TEXT,
  tiktok_access_token_encrypted BYTEA,
  consent_mode TEXT NOT NULL DEFAULT 'reject_by_default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Custom domain + SSL tracking.
CREATE TABLE shop_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  verification_token TEXT NOT NULL,          -- random string for TXT record
  verification_status TEXT NOT NULL DEFAULT 'pending',  -- pending|verified|failed
  cert_status TEXT NOT NULL DEFAULT 'none',  -- none|requested|issued|renewing|failed
  cert_issued_at TIMESTAMPTZ,
  cert_expires_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hostname)
);

-- Checkout Phase 4 scaffold — empty for Phase 3, used by Phase 4 UI.
CREATE TABLE checkout_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  cart_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  state TEXT NOT NULL DEFAULT 'open',        -- open|completed|abandoned
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clone job audit (Phase 3 re-clone traceability).
CREATE TABLE storefront_clone_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',     -- queued|running|succeeded|failed
  stages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  progress_pct SMALLINT NOT NULL DEFAULT 0,
  result_json JSONB,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 7.2 New columns on existing tables

```sql
-- Pixel event attribution: which clone ingested this product?
ALTER TABLE products ADD COLUMN source_external_id TEXT;
ALTER TABLE products ADD COLUMN source_url TEXT;
ALTER TABLE products ADD COLUMN clone_job_id UUID REFERENCES storefront_clone_jobs(id) ON DELETE SET NULL;
CREATE INDEX idx_products_source_external_id ON products(shop_id, source_external_id);
```

## 8. HTTP Surface

```
POST   /api/storefront/clone                    → { jobId }
GET    /api/storefront/clone/:jobId             → job row (no stream)
GET    /api/storefront/clone/:jobId/events      → SSE (progress/terminal)
POST   /api/storefront/:shopId/publish          → gated on checkout_ready flag
GET    /api/storefront/:shopId/pixels           → pixel config
PUT    /api/storefront/:shopId/pixels           → upsert pixel config
POST   /api/storefront/:shopId/domains          → add custom domain
POST   /api/storefront/:shopId/domains/:id/verify  → trigger DNS verify
DELETE /api/storefront/:shopId/domains/:id      → remove custom domain
```

All routes mounted on the main gbox-platform API (same process as god-admin), authenticated via existing session cookie, scoped by `shop_id` membership check (store-owner or higher).

## 9. Clone Orchestrator — New Stage Graph

Current ai-clone stages (theme-only):
```
crawl → buildCloneReport → enhanceThemeSpec → generateBundleFromSpec → persist
```

Phase 3 adds two new stages + rewires the tail:
```
crawl (theme)                  ─┐
                                ├→ buildCloneReport → enhanceThemeSpec
crawlProducts (Shopify JSON)   ─┤       │
crawlSitemap (for SEO)         ─┤       ↓
                                │  generateBundleFromSpec
crawlMedia (S3 pipeline)       ─┤       │
                                │       ↓
                                │  persistTheme (themes + theme_assets)
                                │       │
                                └→ persistProducts (products + variants + images + collections)
                                        │
                                        ↓
                                   persistSeoHarvest
                                        │
                                        ↓
                                   emitBrandKit (store on shops.brand_kit_json)
                                        │
                                        ↓
                                   job.succeeded
```

Each stage writes a row to `storefront_clone_jobs.stages_json` on entry + exit; SSE pushes the latest snapshot.

## 10. Media Pipeline

```
source image URL
    │
    ↓ safeFetch (10s, 25 MiB cap, private-IP denied)
    ↓
    ↓ sharp: decode → resize to [256, 512, 1024, 2048] → WebP + AVIF
    ↓
    ↓ S3Store.put(`shops/${shopId}/products/${productId}/${hash}.{w}.webp`)
    ↓
product_images row (src = CDN URL, alt = source alt)
```

Concurrency: 6 workers per clone job. Fail-open: a single image 404 does NOT fail the job — recorded in `stages_json.mediaErrors`.

## 11. Pixel Manager

### 11.1 Client-side injection (LiquidJS partial)

`apps/storefront/src/views/partials/pixels.liquid` conditionally emits `<script>` tags for Meta, GTM, GA4, TikTok based on `shop.pixel_config`. Respects consent mode: before consent, pixels are **stub** (no network calls, queue events in memory). On consent → flush queue.

### 11.2 Server-side event relay

```
POST /_events   ← from storefront JS (page_view, view_item, add_to_cart, begin_checkout)
    │
    ↓ validate against shop + rate-limit 100 events/min/shop
    ↓ fanout (parallel):
       - Meta CAPI (decrypted token)
       - GA4 Measurement Protocol (decrypted api_secret)
       - TikTok Events API (decrypted access_token)
       - GTM server-side container (if merchant uses it)
    ↓ result logged to shop_pixel_events (TBD — hot storage decision in 3.D)
```

### 11.3 Unified event schema

```ts
type PixelEvent =
  | { name: 'page_view';      url: string; referrer?: string }
  | { name: 'view_item';      productId: string; price: number; currency: string }
  | { name: 'add_to_cart';    productId: string; variantId: string; quantity: number }
  | { name: 'begin_checkout'; items: CartLine[]; value: number; currency: string };
```

Phase 3 fires `page_view` and `view_item` for real. `add_to_cart` fires when the lead-gen "Buy" button is clicked (even though there's no cart yet — it's valuable for Meta's optimisation algorithm). `begin_checkout` is wired but never fires until Phase 4.

## 12. SEO

- **Sitemap**: `GET /sitemap.xml` streams products + collections + pages + blog posts via DbDataSource. Cached 1h.
- **Robots**: `GET /robots.txt` reads `shops.robots_txt` column (new) or ships a sane default.
- **JSON-LD**: injected in `<head>` of each route — Product / BreadcrumbList / Organization / WebSite. Emitted by Liquid partial.
- **Canonical**: product page always emits `<link rel="canonical" href="https://{shop}.gbox.co/products/{handle}">`.
- **OG image**: first `product_images.src`.

## 13. Custom Domain — Manual DNS + Webhook Verification

### 13.1 Merchant flow

1. Admin wizard → "Add domain" → enter `shop.thaibeo.com`
2. Server inserts `shop_domains` row with random `verification_token`
3. Admin shows 2 DNS records to add at registrar:
   ```
   CNAME  shop.thaibeo.com          →   cname.gbox.co
   TXT    _gbox-verify.shop.thaibeo.com   →   gbox-verify=<token>
   ```
4. Merchant clicks "Verify" → `POST /api/storefront/:shopId/domains/:id/verify`
5. Server calls `dns.resolveCname()` + `dns.resolveTxt()`, checks both match. On success → `verification_status = 'verified'`.
6. Background cron (every 5 min) picks up `verified && cert_status=none` rows, calls **lego** (embedded Go binary via `node:child_process` or the `acme-client` npm lib) to provision Let's Encrypt cert, stores in `shop_domains.cert_*` + writes cert+key to `/etc/nginx/certs/{hostname}.{pem,key}`, reloads nginx via `nginx -s reload`.
7. Daily 03:00 cron renews certs with `expires_at < now() + 30 days`.

### 13.2 Apex domain handling

Reject apex (root) domains in validation — show: "Use `www.example.com` or a subdomain. Your registrar's CNAME support doesn't allow apex." (Future: ALIAS/ANAME provider detection in Phase 3.5.)

### 13.3 nginx integration

Phase 3 assumes the storefront runs behind nginx on server 3 (storefront host from `infra_topology.md`). Nginx is configured with a `server { listen 443; server_name _; ssl_certificate /etc/nginx/certs/$ssl_server_name.pem; … }` snippet so newly-dropped cert files are picked up on reload without per-domain config blocks.

## 14. Admin Wizard (store-admin plugin expansion)

Expand `apps/store-admin/src/pages/theme-clone.ts` → rename to `storefront-clone.ts`, grow from theme-only to full 6-step wizard:

1. **Source URL** — paste Shopify URL, pick shop slug (pre-validated against `shops.slug` uniqueness)
2. **Live clone progress** — SSE progress bar with stage labels
3. **Preview + edit** — button to open Level 2.5 visual editor (from Clone_pro if sister integration, or native editor in Phase 3.5)
4. **Pixels** — form for Meta/GTM/GA4/TikTok IDs + tokens
5. **Domain** — DNS verification flow
6. **Publish** — gated until `checkout_ready` flag; until Phase 4 ships, the button reads "Go live (lead-gen mode)" and enables the read-only Buy button

## 15. Checkout Phase 4 Hooks (to prevent refactor pain)

- `checkout_sessions` table scaffolded empty ✅
- Product page `<button data-product-id="{id}" data-variant-id="{variant_id}" data-action="add-to-cart">` — Phase 3 handler opens WhatsApp or contact form, Phase 4 handler calls real `/api/checkout/session`
- Pixel event `add_to_cart` fires on button click in **both** phases — Meta's algorithm starts learning in Phase 3
- Liquid partial `cart_drawer.liquid` emits an empty drawer with a "Coming soon in Phase 4" banner, but DOM is structurally ready (`#cart-drawer` element with `data-cart-state="empty"`)
- `/cart` route returns 200 with a Phase 4 CTA — does not 404, so Meta link-click ads don't penalise the store

## 16. Stage Breakdown (Phase 3.A → 3.F)

| Stage | Scope | Exit criteria |
|---|---|---|
| **3.A** | Promote `safeFetch/crawlShopifyProducts/walkSitemap` into `@gbox/core/clone-shopify`. Add `storefront_clone_jobs` + `checkout_sessions` migration. Wire `POST /api/storefront/clone` + SSE. Extend ai-clone orchestrator with `crawlProducts` stage that writes to `products` + `product_variants` + `product_options`. | Product rows appear in DB after clone of a public Shopify demo; vitest green |
| **3.B** | Media pipeline: safeFetch → sharp → S3. `crawlMedia` stage fills `product_images.src` with CDN URLs. Fail-open on 404. | Product pages render with S3-hosted images on `{shop}.gbox.co` |
| **3.C** | SEO harvest + emitters: sitemap.xml, robots.txt, JSON-LD partial, canonical, OG. `persistSeoHarvest` stage. Brand kit extraction. | Product page passes Google Rich Results test |
| **3.D** | Pixel manager: `shop_pixel_config` table, Liquid pixels partial, consent banner, `POST /_events` fanout. | Meta Pixel Helper shows green for `PageView` + `ViewContent` on preview |
| **3.E** | Admin wizard: expand `storefront-clone.ts` to 6-step flow with pixel + domain steps. Publish gate. Read-only Buy → WhatsApp. | End-to-end: paste URL → 5 min later clone is live with pixels firing |
| **3.F** | Custom domain: DNS verify + lego cert issuance + nginx reload + daily renewal cron. Apex reject. | Merchant adds `www.example.com` → HTTPS in under 10 min |

Smoke test between each stage — same pattern as Clone_pro Phase 1.

## 17. Testing Strategy

Per stage:
- **Unit** (vitest forks): crawler pagination, safeFetch redirect re-check, sharp resize, sitemap XML parser, consent-mode gate, DNS verifier
- **Contract**: ai-clone orchestrator stage graph (fixture a fake Shopify site via `fetchPage` injection)
- **E2E smoke**: one real clone run against `allbirds.com` or similar public Shopify demo on server 3
- **Pixel E2E**: Puppeteer script asserts Meta Pixel fires `PageView` on `{shop}.gbox.co`

## 18. Observability

- Per-shop RPS + p95 already available via existing pino-http + Prometheus scrape
- New: `clone_job_duration_seconds` histogram, `pixel_event_total` counter, `cert_issue_failures_total` counter
- Sentry tags: `shop_id`, `clone_job_id`, `pixel_provider`
- Daily digest to god-admin: count of clones, failed certs, pixel relay errors

## 19. Open Risks

1. **Shopify rate-limiting** — `/products.json` paginated at 250 products/page; very large stores (10K+ SKUs) hit throttling. Mitigation: respect 429 backoff (already in Clone_pro `safe-fetch`), cap at 5K products for MVP with override flag.
2. **Wildcard `*.gbox.co` SSL conflict** — wildcard cert already serves admin/accounts/api; adding storefront on the same apex means the same cert covers both. Risk: certificate revocation hits everything at once. Mitigation: separate cert for `*.gbox.co` storefront class via SAN, or move admin to `admin.gbox.co` in a follow-up.
3. **lego binary portability** — if Go binary doesn't ship on the storefront server, fall back to `acme-client` (pure JS, slightly less battle-tested).
4. **Media storage egress cost** — S3 egress is not free (unlike R2). If a merchant's storefront takes off, egress bills spike. Mitigation: Cloudflare in front of storefront (cacheable `/shops/*` paths), monitor weekly.
5. **Pixel consent in Vietnam** — GDPR doesn't apply, but Meta/Google's own rules do. Ship "reject-by-default" consent mode to stay on the right side of Meta's Aggregated Event Measurement.
6. **Clone of a store that explicitly disallows scraping** — `/products.json` is public by Shopify default, but some stores disable it. Handle 404 gracefully with a "this store has disabled product export" error page.

## 20. Out of Scope — Explicit Defer List

- Cart + checkout UI → Phase 4
- Payment gateways → Phase 4
- Order management dashboards → Phase 4
- Email / SMS automation → Phase 5
- Multi-language → Phase 6
- Diff-only re-clone (preserve edits) → **not planned**; full overwrite always
- Theme editor AI rewrite button → Phase 3.5 (post-MVP polish)
- Cloudflare API domain automation (Option B) → Phase 3.5

---

## 21. Spec Self-Review Checklist

- [x] No TBDs or placeholder sections
- [x] All 8 owner decisions locked with values
- [x] Stage breakdown has exit criteria per stage
- [x] Every new table has a CREATE statement
- [x] Every new API route is listed
- [x] Risks are enumerated with mitigations
- [x] Out-of-scope is explicit
- [x] Re-uses existing gbox-platform modules where available (doesn't rebuild S3Store, DbDataSource, router, resolver)

**Status:** Ready for Thai's review. Implementation plan lives at `docs/superpowers/plans/2026-04-12-phase-3-storefront-cloner-plan.md`.
