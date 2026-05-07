# PHASE 2 — PRODUCTS POWER-UP (Detailed Execution Plan)

**Date:** 2026-04-20
**Owner:** Thai Bui
**Parent roadmap:** `2026-04-20-phase-2-to-10-master-roadmap.md`
**Status:** 🟡 DRAFT — awaiting sign-off before PR1 starts
**Est:** 6 PRs, ~10-12 working days, all on branch family `feat/phase-2-*`

---

## 0. TL;DR

Products admin is **80% there** — what exists is production-quality (CRUD, variants, collections, smart rules, bulk status ops, media grid, inline edit). What it lacks is the **Shopify-depth polish**:

1. **Metafields UI** (Phase 4 spec calls this "critical, merchants WILL hack it into description if we skip") — service exists, UI doesn't.
2. **CSV export + import** — zero today; blocks merchant migration from Shopify.
3. **Variant deep fields** — HS code, country of origin, gift card flag, inventory policy, continue selling when OOS — not in schema.
4. **Multi-location inventory UI** — schema ready (`inventory_levels` table), admin still single-shop-wide.
5. **SEO fields** on product + collection — stored via metafields, needs UI.
6. **Bulk edit modal** — bulk status ops exist, bulk field changes (add tag, adjust price %) don't.

All are shippable in isolation. Below is the PR sequence.

---

## 1. PRE-FLIGHT AUDIT (before PR1)

Before any PR merges, I must confirm:

- [ ] `packages/core/src/modules/metafields/service.ts` exports `setMetafield / getMetafield / listMetafields / deleteMetafield` (signatures stable — nobody will refactor mid-phase).
- [ ] Migration 006 `metafields` table matches the Phase 4 hardening spec: unique `(shop_id, owner_type, owner_id, namespace, key)`, `value jsonb`, `value_type varchar`.
- [ ] `inventory_levels` table exists + has `location_id, variant_id, available` columns.
- [ ] No open PR touches `products.ts` (I'll block if someone's mid-change).

Audit runs in **30 min tops**. Logged as comment on this doc.

---

## 2. PR BREAKDOWN

Each PR is **independently reviewable + deployable**. If Thai rejects one, the next can still ship (only PR1 blocks PR2 logically).

### PR 1 — Metafields REST API + Admin UI
**Branch:** `feat/phase-2-metafields`
**Est:** 2-3 days
**Merge blocks:** PR2 (import/export) optionally benefits; PR5 (variant fields) independent
**Depends on:** nothing

**Why this first:** Phase 4 spec says merchants will corrupt data models without this. Every downstream phase (customer CRM, orders custom attrs, app ecosystem) needs metafields working end-to-end.

**Scope:**
1. REST API (Shopify-compatible paths):
   - `GET  /api/2026-04/products/:id/metafields` — list
   - `POST /api/2026-04/products/:id/metafields` — create
   - `PUT  /api/2026-04/metafields/:id` — update
   - `DELETE /api/2026-04/metafields/:id` — delete
   - Same 4 routes for `/variants/:id/`, `/collections/:id/`, `/customers/:id/`, `/orders/:id/`, `/shop/`
   - All JWT-auth, shop-context scoped (Phase 4 `req.shop` middleware)
2. Admin UI on product detail:
   - Right sidebar card **"Custom data"** (below "Organization")
   - Shows list: `namespace.key` + truncated value (40 char) + edit/delete icons
   - "Add custom field" button → modal with: namespace (text), key (text), value (textarea — JSON toggle), value_type (select: single_line_text_field / multi_line_text_field / number_integer / number_decimal / boolean / json / date / date_time / url), description (text, optional)
   - Validation: namespace 3-255 alnum+hyphen+underscore, key 3-64 same, value parsed per type
   - XHR POST → JSON response (same pattern as variant inline edit)
3. Admin UI on collection detail: same card, same endpoints but `owner_type='collection'`
4. Admin UI on variant row: small "📎 0" badge link → opens modal pre-scoped to variant
5. Tests:
   - Unit: metafields service validation edge cases (namespace too short, key special chars, JSON type parses)
   - Route: CRUD round-trip under shop-context middleware (no cross-shop leak)
   - Admin handler: POST creates with current `req.shopId`, rejects foreign-shop owner

**Files touched:**
- `packages/core/src/modules/metafields/service.ts` — ensure signatures, tighten validation (+~50 lines if needed)
- `apps/gbox-platform-api/src/routes/metafields.ts` — NEW (~180 lines)
- `apps/store-admin/src/pages/products.ts` — +Custom data card render + modal handlers (~250 lines)
- `apps/store-admin/src/pages/collections.ts` — same pattern (~180 lines)
- Test files for each

**Acceptance criteria:**
- [ ] Merchant on Gbox admin can add `seo.title = "Red Widget 2026"` to a product, reload, see it persisted.
- [ ] Same `seo.title` key cannot collide between products (unique index respected).
- [ ] Foreign shop attempting `PUT /metafields/:id` on other shop's metafield → 404.
- [ ] `tsc --noEmit` clean, all tests pass.
- [ ] 1 screenshot attached to PR: product detail with 2 metafields rendered.

---

### PR 2 — Product CSV Export
**Branch:** `feat/phase-2-csv-export`
**Est:** 1 day
**Merge blocks:** nothing
**Depends on:** nothing (metafields export as extra columns if PR1 merged, else skipped)

**Why now:** low risk, high merchant value, unblocks migration-in from Shopify.

**Scope:**
1. New route `GET /api/2026-04/products/export.csv?status=active&q=term` — streams CSV with Shopify-compatible columns:
   - `Handle, Title, Body (HTML), Vendor, Product Category, Type, Tags, Published, Option1 Name, Option1 Value, Option2 Name, Option2 Value, Option3 Name, Option3 Value, Variant SKU, Variant Grams, Variant Inventory Tracker, Variant Inventory Qty, Variant Inventory Policy, Variant Fulfillment Service, Variant Price, Variant Compare At Price, Variant Requires Shipping, Variant Taxable, Variant Barcode, Image Src, Image Position, Image Alt Text, Gift Card, SEO Title, SEO Description, Status`
   - UTF-8 BOM for Excel compatibility (see orders-masterplan Sprint 4 pattern, already done there)
   - One row per variant (Shopify format: first variant has product fields, subsequent variants have empty product fields)
2. Admin UI: "Export" button in products.ts listing topbar — downloads `products-YYYYMMDD.csv`
3. Reuse pattern from `apps/store-admin/src/pages/orders-export.ts` (already shipped in orders masterplan Sprint 4).

**Files touched:**
- `apps/gbox-platform-api/src/routes/products-export.ts` — NEW (~120 lines)
- `apps/store-admin/src/pages/products.ts` — add Export button + handler (~25 lines)
- Test: round-trip export → parse → count rows matches count in DB

**Acceptance criteria:**
- [ ] Export 100 products → CSV has 100 variants (or more if multi-variant), opens in Excel with no encoding artifacts.
- [ ] Headers match Shopify's column names exactly (so import-back works).
- [ ] Respects search + status filters (same as bulk ops scope).

---

### PR 3 — Product CSV Import (async job + progress UI)
**Branch:** `feat/phase-2-csv-import`
**Est:** 2 days
**Merge blocks:** nothing
**Depends on:** PR2 merged (export headers define import format)

**Scope:**
1. New table `product_import_jobs` (migration 054):
   - `id uuid PK, shop_id uuid FK, filename text, total_rows int, processed_rows int, succeeded int, failed int, status ('queued'|'running'|'done'|'failed'), error_log jsonb (array of {row, field, message}), created_at, started_at, finished_at`
2. Route `POST /api/2026-04/products/import` — multipart upload (use existing `multer` setup from order import if present, else add)
3. Worker loop (same in-process async pattern as orders import — see `apps/store-admin/src/pages/orders-import.ts`):
   - Parse CSV row-by-row
   - Detect handle collision → UPDATE or SKIP (merchant choice via form flag)
   - Create/update product → create variants (group by handle) → attach images (URL-based, no file upload in v1)
   - On error: log to `error_log`, continue
4. Admin UI:
   - New page `/admin/products/import` (or modal on listing): dropzone + options (on collision: skip | update), "Start import" button
   - Progress banner: `processed 124 / 850 · 3 failed` with auto-refresh every 2s
   - Error log tab: table of failed rows with download link for "errors.csv"
5. Tests:
   - Unit: CSV parser handles quoted fields, embedded commas, newlines
   - Integration: upload 50-row CSV → polls job to done → 50 products exist
   - Error: upload row with invalid SKU format → job completes with 1 failure logged, other 49 saved

**Files touched:**
- `packages/db/src/migrations/054_product_import_jobs.ts` — NEW
- `apps/gbox-platform-api/src/routes/products-import.ts` — NEW (~250 lines)
- `apps/store-admin/src/pages/products-import.ts` — NEW (~200 lines)
- `apps/store-admin/src/server.ts` — register route
- Test suite

**Acceptance criteria:**
- [ ] Import CSV exported from a real Shopify shop → products materialize 1:1 in Gbox.
- [ ] 5000-row import finishes < 90s on server 1.
- [ ] Failed rows don't abort the job; merchant can download errors.csv.

---

### PR 4 — Variant Deep Fields (schema + admin UI)
**Branch:** `feat/phase-2-variant-deep-fields`
**Est:** 2 days
**Merge blocks:** nothing
**Depends on:** nothing

**Scope:**
1. Migration 055 adds to `product_variants`:
   - `inventory_policy varchar(16) DEFAULT 'deny' CHECK (inventory_policy IN ('deny','continue'))`
   - `harmonized_system_code varchar(32)` (HS code, nullable)
   - `country_of_origin varchar(2)` (ISO-3166-1 alpha-2, nullable)
   - `is_gift_card boolean DEFAULT false` (on product, not variant — actually migration goes on `products`)
2. Admin UI adds to variant row edit:
   - "Inventory policy" dropdown (deny selling when out of stock / continue selling)
   - "HS code" text field (with tooltip link to customs.gov.vn)
   - "Country of origin" dropdown (top 20 VN trading partners first, rest alphabetical)
3. On product detail sidebar:
   - "This is a gift card" checkbox (marks product → variants get special handling in checkout V2)
4. CSV export (PR2) adds these columns; CSV import (PR3) reads them.
5. Tests: schema migration + rollback; variant update API accepts new fields; CSV round-trip preserves them.

**Files touched:**
- `packages/db/src/migrations/055_variant_deep_fields.ts` — NEW
- `apps/store-admin/src/pages/products.ts` — ~80 lines added to variant table render + postProductVariantUpdate handler
- `apps/gbox-platform-api/src/routes/variants.ts` (or wherever variant update lives) — add fields to validator
- Test suite

**Acceptance criteria:**
- [ ] Migration up + down work clean.
- [ ] Merchant can set HS code on 5 variants, reload, see preserved.
- [ ] CSV export (PR2) now includes new columns; import (PR3) reads them.

---

### PR 5 — Multi-Location Inventory UI
**Branch:** `feat/phase-2-multi-location-inventory`
**Est:** 2 days
**Merge blocks:** nothing
**Depends on:** migrations 001 `locations` + `inventory_levels` tables (already exist)

**Scope:**
1. Verify `locations` table exists (from migration 001). If not, add migration 056.
2. New admin page `/admin/settings/locations` — list/create/edit locations (name, address, is_fulfillment_center boolean, active boolean).
3. Refactor `inventory.ts`:
   - Add location selector pill-bar at top ("All locations" + one chip per location)
   - Stock column becomes per-location breakdown: `Location A: 12 · Location B: 3`
   - Adjust button → modal with location dropdown
4. Variant detail on product page: small "Inventory" card shows per-location breakdown, inline adjust.
5. Fallback: if shop has only 1 location (the seeded "Default" one), UI collapses to current single-location view — zero UX change for merchants who don't opt in.
6. Tests:
   - Create 2 locations, adjust stock on each, see both in merchant UI.
   - Single-location shops see no UI change.

**Files touched:**
- `packages/db/src/migrations/056_*.ts` — only if `locations` not already present (audit first)
- `apps/store-admin/src/pages/inventory.ts` — significant rewrite (~300 lines)
- `apps/store-admin/src/pages/locations.ts` — NEW (~250 lines)
- `apps/store-admin/src/pages/products.ts` — add per-location inventory card (~60 lines)
- Test suite

**Acceptance criteria:**
- [ ] New shops default to "Default Warehouse" location — no UX regression.
- [ ] Shop with 2 locations: merchant can move 5 units from Loc A to Loc B via adjust UI (2 clicks).
- [ ] Inventory list filter by location works.

---

### PR 6 — Bulk Edit Modal + SEO Metafield Shortcut
**Branch:** `feat/phase-2-bulk-edit`
**Est:** 1.5 days
**Merge blocks:** nothing
**Depends on:** PR1 merged (for SEO shortcut)

**Scope:**
1. Extend product bulk action bar: add "Edit" action → opens modal.
2. Modal form (tabs):
   - **Tags:** add tag(s), remove tag(s)
   - **Pricing:** increase/decrease price by X% or $Y, compare-at same
   - **Collections:** add to / remove from collection (multi-select)
   - **Status:** already exists, move here for consistency
   - **Custom field:** set `namespace.key = value` on all selected (PR1 dependency)
3. Preview pane: "This will update 47 products. Are you sure?" + sample-of-3 table.
4. SEO shortcut on product detail: pre-filled metafield modal for `seo.title` + `seo.description` + `seo.handle` (one-click instead of "Add custom field" dance).
5. Tests:
   - Select 10 products, add tag "bulk-test", verify all 10 have tag.
   - Adjust price +10%, verify new prices (floor rounding rule).

**Files touched:**
- `apps/store-admin/src/pages/products.ts` — bulk edit modal (~250 lines)
- `apps/gbox-platform-api/src/routes/products-bulk.ts` — new `bulk/edit` endpoint (~150 lines)
- `apps/store-admin/src/pages/products.ts` — SEO shortcut card on detail (~40 lines)
- Test suite

**Acceptance criteria:**
- [ ] Bulk tag-add on 100 products completes < 3s.
- [ ] Modal preview shows correct sample.
- [ ] SEO shortcut creates `seo.title` metafield, visible in Custom Data card after save.

---

## 3. ORDER OF EXECUTION

```
PR1 Metafields API+UI    ──▶ PR6 Bulk Edit + SEO shortcut
                          ╲
                           ╲─▶ PR2 CSV Export ──▶ PR3 CSV Import
PR4 Variant Deep Fields  ──╱       (PR4 adds columns PR2 exports)
PR5 Multi-Location       (standalone)
```

**Serial ship:** PR1 → PR2 → PR4 → PR3 → PR5 → PR6
(PR4 before PR3 because CSV import needs the new columns to exist; PR4 before PR2 same reason)

Realistic calendar (solo, ~5h/day effective):
- Day 1-2: PR1 (metafields)
- Day 3: PR2 (CSV export)
- Day 4-5: PR4 (variant deep fields + migration)
- Day 6-7: PR3 (CSV import)
- Day 8-9: PR5 (multi-location)
- Day 10-11: PR6 (bulk edit + SEO shortcut)
- Day 12: phase-close review + update CLAUDE.md

---

## 4. OUT OF SCOPE (defer to later phases)

- **3D model media** → Phase 7 (Online Store) or defer indefinitely (low demand for VN merchants)
- **Video storage/CDN** → Infra Track I-b (theme engine has asset pipeline)
- **Channel publishing** (sales channels beyond online store) → Phase 8 (Marketing) or Infra I-d (apps marketplace)
- **Shipping profile** per product → Phase 9 (Shipping)
- **Delete with undo** → Phase 10 (polish) — needs soft-delete schema audit across all tables
- **Product duplicate deep clone** (already done minimal; Shopify's is richer w/ media copy) → Phase 10
- **AI product copywriter** → Phase 10 (seller AI)

---

## 5. RISK REGISTER

| Risk | Impact | Mitigation |
|---|---|---|
| Metafield service exists but has untested edge cases | Medium | PR1 includes 20+ unit tests on validation before touching UI |
| CSV import of 50k-row file OOM on VPS | High | Stream parser (csv-parser lib), chunk 1000 rows, flush to DB, clear buffer |
| Multi-location UI regression for single-loc merchants | Medium | Feature flag fallback: if `locations.count = 1` skip UI rework |
| Migration 054/055/056 conflict with master branch | High | Audit `_migrations` table on server 1 before numbering (lesson from PR #10) |
| Bulk edit modal too powerful → merchant nukes 1000 products | High | Preview step required; "Are you sure?" confirm; server-side cap at 500 per call |
| Phase 4 metafields schema doesn't match service | Medium | Pre-flight audit (§1) catches this before PR1 starts |

---

## 6. DEFINITION OF "PHASE 2 DONE"

- [ ] All 6 PRs merged to master
- [ ] Smoke test on server 1 (thaibeotit.com admin): create product with 3 variants + 2 metafields + 2 locations + export CSV + re-import → byte-identical round-trip
- [ ] `CLAUDE.md` "Current Phase" → "PHASE 3 CLOSED (already done), moving to PHASE 4: Customer CRM"
- [ ] Phase 2 status report to Thai: what shipped, what was deferred, any surprises
- [ ] `2026-04-20-phase-2-detailed-plan.md` updated with completion checkmarks
- [ ] 1 screencast (30s) demonstrating: merchant adds metafield, exports CSV, imports into a second shop, verifies field preserved → proof of end-to-end.

---

## 7. ROLLBACK PLAN

If **any PR causes prod regression** after merge:
1. Revert the merge commit (NOT rebase — preserve history per Iron Rule).
2. Re-deploy prior build via PM2.
3. If DB migration shipped: `npm run migrate:down` for that specific migration — verify idempotent before re-shipping fix.
4. Report to Thai within 30 min of detection.

All schema migrations in Phase 2 (054, 055, 056 if needed) **must be reversible** — down() tested in PR.

---

## 8. SIGN-OFF GATE

Thai, before I touch code for PR1, please confirm:

1. ☐ Approach: 6 PRs in the order above
2. ☐ Scope: metafields UI FIRST (Phase 4 hardening said it's critical)
3. ☐ Out-of-scope list (§4) is acceptable
4. ☐ Migration numbering 054 / 055 / (056?) is ok — or should I audit prod `_migrations` first and renumber?
5. ☐ Green-light to start PR1

**If yes on all → I start PR1 next turn.**
**If any No → we revise this doc.**

---

**End of Phase 2 detailed plan.**
