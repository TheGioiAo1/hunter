# PHASE 4 — CUSTOMER CRM (Detailed Execution Plan)

**Date:** 2026-04-20
**Owner:** Thai Bui
**Parent roadmap:** `2026-04-20-phase-2-to-10-master-roadmap.md`
**Status:** 🟡 IN PROGRESS — PR1 scoped, implementation underway
**Est:** 4 PRs, ~7 working days, branch family `feat/phase-4-*`

---

## 0. TL;DR

Customer admin is **~40% there** — list/detail/edit/create + CSV-ready service
layer exist, but everything is single-layer. What's missing for Shopify-class
CRM:

1. **Structured notes timeline** (multi-entry, author-attributed, timestamped)
   — today there's a single free-text `customers.note` column.
2. **Tags chip editor** (inline add/remove) — today tags render but there's
   no UI to edit; the detail page even has a latent bug calling
   `customer.tags.split(',')` on a Postgres `text[]` column.
3. **Metafields on customers** — Phase 2 PR1 shipped the metafields service
   but customer detail never exposes it.
4. **Segments editor** (rule-based, live preview count).
5. **Lifecycle stage** (new / returning / at-risk / churned) + churn scoring.
6. **CSV import + export** — Shopify-parity migration path for merchants.

All independently shippable. PR1 focuses on the **foundational detail-page
depth** that every later PR builds on.

---

## 1. PRE-FLIGHT CONFIRMED (done in PR1 scoping session)

- ✅ Metafields service is stable (Phase 2 PR1 merged contract).
- ✅ Latest migration on `master` is 052 (`agent_sessions`). Phase 4 starts
  at 054 (leaving 053 for PR #15 thaibq admin seed that's already open —
  whichever lands first keeps 053, the other rebases).
- ✅ No open PR touches `apps/store-admin/src/pages/customers.ts` — safe
  to branch.
- ✅ `customers.tags` is `text[]` in schema (not a CSV string) — the
  detail page's `.split(',')` is a bug to fix en route.

---

## 2. PR BREAKDOWN

### PR 1 — Customer detail depth (notes timeline + tags editor) 🟡 THIS PR
**Branch:** `feat/phase-4-customer-notes`
**Est:** 1.5 days

**Deliverables:**
- Migration 054: `customer_notes` table (id, shop_id, customer_id, body,
  author_user_id, author_name_snapshot, created_at).
- Core service `packages/core/src/modules/customer-notes/service.ts`:
  `addNote` / `listNotes` / `deleteNote`, all shop-scoped.
- Customer detail page:
  - Replace static notes card with dynamic notes timeline (list + add form).
  - Preserve legacy `customers.note` as "Legacy note" read-only block.
  - Tags chip editor: inline add/remove, submits to POST .../tags.
  - Fix the `customer.tags.split(',')` bug (handle `string[]` correctly).
- Routes:
  - `POST /admin/store/:slug/customers/:id/notes` (add note)
  - `POST /admin/store/:slug/customers/:id/notes/:noteId/delete`
  - `POST /admin/store/:slug/customers/:id/tags` (update tags array)
- Tests:
  - Core service: add/list/delete + cross-shop rejection.
  - Route handlers: notes add/delete + tags update + cross-shop refusal.

**Acceptance:**
- Typecheck clean, vitest green.
- Adding a note on detail page appears instantly with author + timestamp.
- Tag chip editor adds/removes tags with no page reload (form-driven, not JS-heavy).
- Cross-shop note access returns 404 (fail-closed).

---

### PR 2 — Segments editor (rule builder + live preview) 🔴
**Branch:** `feat/phase-4-segments`
**Est:** 2 days

**Scope:**
- Migration: `customer_segments` table (id, shop_id, name, rules_json, updated_at).
- Rule tree schema: `{and|or, [{field, op, value}]}` matching Shopify's segment grammar subset.
- Admin page: segment editor with rule-row builder + "Preview count" button.
- Service: `evaluateSegment(db, shop, rules)` → SQL WHERE tree.
- Safe-list of fields: email, phone, country, tags, total_spent, orders_count, created_at.

---

### PR 3 — Lifecycle stage + churn scoring 🔴
**Branch:** `feat/phase-4-lifecycle`
**Est:** 1.5 days

**Scope:**
- Add `customers.lifecycle_stage` column (new/returning/at_risk/churned).
- Background recompute via existing cron framework (or on-order-update trigger).
- Thresholds: at_risk = no order in 60 days; churned = no order in 180 days;
  returning = >=2 orders.
- Detail page surfaces current stage + last activity.

---

### PR 4 — CSV import + export 🔴
**Branch:** `feat/phase-4-csv`
**Est:** 2 days

**Scope:**
- Export: `GET /admin/store/:slug/customers/export` → CSV stream.
  Columns Shopify-parity: First Name / Last Name / Email / Company / Address1 /
  Address2 / City / Province / ZIP / Country / Phone / Accepts Email Marketing /
  Tags / Note / Total Spent / Total Orders / Tax Exempt.
- Import: dry-run preview UI (identical pattern to Phase 2 PR3 product CSV).
- Upsert on email match within shop.

---

## 3. SEQUENCING

PR1 → PR2 → PR3 → PR4 strictly sequential (each PR adds columns/tables read
by later PRs' UI — e.g. PR3's lifecycle_stage will render on PR1's detail
page, PR4's export includes PR3's lifecycle_stage).

---

## 4. SERVER-2 SMOKE CHECKLIST (after PR1 merges)

Per `memory/smoke_test_runbook.md`, local Windows can't reach PG — run on
server 2 against `gbox_platform`:

1. Apply migration 054 (`pnpm -w migrate`).
2. Visit any customer detail page → notes card shows empty state.
3. Add a note → reloads with timestamped entry authored by current admin.
4. Add a tag via chip editor → persists on reload.
5. Delete a note → removes from list; verify audit_log row written.

---

**End of Phase 4 plan.** PR1 implementation starts now on branch
`feat/phase-4-customer-notes` off `master`.
