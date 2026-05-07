# GBOX PLATFORM — PHASE 2→10 MASTER ROADMAP

**Date:** 2026-04-20
**Owner:** Thai Bui
**Status:** 🟡 DRAFT — awaiting owner sign-off before Phase 2 execution
**Supersedes:** nothing. Consolidates + sequences existing plans.

---

## 1. EXECUTIVE SUMMARY

### Why this doc exists

Three authoritative plans already exist but use **incompatible numbering**:

| Plan | Uses | Scope |
|---|---|---|
| `2026-04-07-seller-dashboard-plan.md` | Phase **1-11** (numbers) | Merchant admin UI surface |
| `2026-04-12-shopify-parity-roadmap.md` | Phases **A-H** (letters) | API + schema parity |
| `2026-04-13-orders-system-masterplan.md` | Phases **A-G** (letters) | Orders-specific deep dive |

Thai asked for "Phase 2→10". That **naturally maps to seller-dashboard's Phase 2-10** because those are the numbers, and that plan is the most customer-facing sequence. This doc:

1. Adopts seller-dashboard's Phase 1-11 numbering as the spine.
2. Layers in the already-DONE work from Shopify-parity + orders-masterplan so we don't redo it.
3. Adds **three platform-level "Infrastructure Tracks" (I-a, I-b, I-c)** that run parallel to some phases — for checkout engine, payment engine, theme engine — because those are too deep to fit inside an "admin UI" phase.

### Honest completion estimate (after deep dive)

- **Previous self-estimate:** ~15-20% vs. Shopify (conservative).
- **Actual:** ~**30-35%** — Orders Sprint 1-6 done, Shopify parity A-E done, admin pages shell exists for most surfaces.
- **Still missing:** storefront theme engine V2, checkout V2 (accelerated, guest, local methods), real payment gateway integrations, shipping rates API, tax auto-calc, multi-currency runtime (schema exists, runtime doesn't), apps marketplace, POS, B2B, email marketing.

### Ship philosophy

- **One PR = 1-2 days of work, independently reviewable, independently deployable.**
- **No phase blocks another if they don't share a file.** We'll parallel-track when safe.
- **After each PR:** typecheck ✅, vitest ✅, Thai reviews, merge, smoke test on server 1.
- **After each phase:** update `CLAUDE.md` phase marker, close the master checklist, open next phase's detailed plan.

---

## 2. RECONCILED ROADMAP (PHASE 2-10 + INFRA TRACKS)

Legend: ✅ DONE · 🟡 IN PROGRESS · 🔴 NOT STARTED · 🟦 INFRA (runs parallel)

### Phase 2 — Products Power-Up 🟡 (THIS PHASE)
**Scope:** Polish existing products admin + add metafields + variants editor + bulk ops + media library.
**Est:** 5 PRs, ~10 days.
**Why now:** products is the heart of any storefront. Already has basic CRUD; needs Shopify-parity depth.

- Current: `apps/store-admin/src/pages/products.ts`, `collections.ts`, `inventory.ts` exist (74 admin pages total, no "Coming Soon" left).
- Blockers: metafields schema partially exists (migration 006), runtime API partially exists — needs UI integration.
- Detailed plan: `2026-04-20-phase-2-detailed-plan.md` (separate file, 4-6 PRs).

### Phase 3 — Orders Full Lifecycle ✅ (90% DONE)
**Scope:** Order list/detail/edit/fulfill/refund/return/import/export.
**Evidence:** Orders masterplan Sprints 1-6 marked `HOAN THANH`.
**Remaining:** Sprint 7-8 (risk analytics, saved views, automations) — roll into Phase 8.

**Decision:** Skip Phase 3 as a standalone. Mark DONE in `CLAUDE.md`. Leave Sprint 7-8 items as Phase 8 (Marketing) line-items because they depend on event streams we'll build there.

### Phase 4 — Customer CRM 🔴
**Scope:** Customer detail page depth, segments, lifecycle tracking, churn scoring, notes/tags/timeline.
**Est:** 4 PRs, ~7 days.
**Current:** `customers.ts`, `customer-segments.ts` exist as shell. DB schema mostly there (migration 007 customer_auth + core shop).
**Depends on:** Phase 2 metafields (for customer custom data).

### Phase 5 — Discounts & Promotions 🔴
**Scope:** Code/automatic discounts, percentage/fixed/BOGO/free-shipping, combinations, usage limits, customer eligibility.
**Est:** 3 PRs, ~6 days.
**Current:** `discounts.ts`, `gift-cards.ts` exist. Schema: migration 016 (gift_cards). Core discount schema unclear — audit in Phase 5 PR1.
**Depends on:** checkout runtime for applying — can ship admin-side standalone, runtime application lands in **Infra Track I-a (Checkout V2)**.

### Phase 6 — Analytics & Reports 🔴
**Scope:** Real-time dashboards, sales/inventory/customer/marketing reports, funnel, cohort.
**Est:** 4 PRs, ~8 days.
**Current:** `analytics.ts`, `order-analytics.ts`, `analytics-measurement.ts`, `live-view.ts` exist (pages done), real aggregation likely thin.
**Depends on:** `order_events` event source (Phase 4-hardening spec locked this). Also needs Phase 4 customer segments.

### Phase 7 — Online Store (admin side) 🔴
**Scope:** Theme admin (list/install/customize), pages CMS, blog, navigation, domains, files.
**Est:** 5 PRs, ~10 days.
**Current:** `theme-editor.ts`, `visual-editor.ts`, `pages.ts`, `blog.ts`, `navigation.ts` exist.
**Coupling:** Phase 7 admin UI + **Infra Track I-b (Theme Engine V2)** → the admin page *calls* theme-engine APIs. Ship admin-side with stub backends, let I-b replace the backend behind the same contract.

### Phase 8 — Marketing 🔴
**Scope:** Campaigns, abandoned cart emails, SEO, reviews, notifications.
**Est:** 4 PRs, ~8 days.
**Current:** `marketing.ts`, `campaigns.ts`, `reviews.ts`, `notifications-admin.ts` exist as shells.
**Depends on:** email/SMS sending infra (build minimal in Phase 8 PR1; full delivery flows in Phase 11).

### Phase 9 — Shipping, Tax, Settings, Staff 🟡 (partially DONE)
**Scope:** Shipping zones/rates/carriers, tax settings, shop settings, staff/permissions.
**Est:** 4 PRs, ~7 days.
**Current:** `shipping-settings.ts`, `payment-settings.ts`, `markets-settings.ts` exist. Lenful 3PL integration (migrations 030-031) shipped.
**Depends on:** **Infra Track I-c (Payment & Shipping engines)** for runtime.
**Note:** NOT the "AI Agent" phase — that was separately numbered as Phase 9-the-AI-sidecar in the old informal numbering. Renamed from `phase-9-pair-programmer` to `ops-9-agent-sidecar` in the roadmap going forward to free up the number for this Shipping/Settings phase.

### Phase 10 — AI Agent for Sellers + Gift Cards + Reviews + Polish 🔴
**Scope:** Seller-facing AI assistant (product copywriter, campaign suggester), gift card system polish, review moderation UI, cross-cutting polish.
**Est:** 4 PRs, ~8 days.
**Current:** `ai-settings.ts`, `gift-cards.ts`, `reviews.ts` shells exist. AI config per-shop (migration 020) shipped.
**Depends on:** Phase 2 (product data), Phase 4 (customer data), Phase 6 (analytics for campaign suggestions).

### Phase 11 — Deploy Gates + Test + QA (already partly in place)
**Scope:** Staging → Blue-Green → Prod swap orchestration + full test matrix.
**Est:** 2 PRs, ~4 days.
**Current:** Blue-green swap (PR 7), smoke E2E (PR 9), staging Terraform (stuck — PR #16 waiting on dedicated CF zone per MEMORY `staging_tf_blocker.md`).

---

## 3. INFRASTRUCTURE TRACKS (parallel to admin phases)

These are the **deep engine rewrites** Shopify does in-house. They don't fit as "admin UI" phases. They run parallel.

### Infra Track I-a — Checkout V2 Engine 🔴
**Runs parallel to:** Phase 5 (discounts apply at checkout).
**Scope:** Multi-step checkout (contact → shipping → payment → review), guest checkout, accelerated (Shop Pay-equivalent stub, Apple/Google Pay), idempotency keys (locked in Phase 4 hardening), 3DS.
**Est:** 8-10 PRs, ~20 days.
**Current storefront middleware** (`apps/storefront/src/middleware/checkout-routes.ts`) is basic — needs full state machine.
**Blocker for:** Phase 9 (tax runtime), Infra I-c (payment runtime).

### Infra Track I-b — Theme Engine V2 🔴
**Runs parallel to:** Phase 7 (online store admin).
**Scope:** Liquid-clone templating (decision 1: liquidjs, locked), sections/blocks architecture, theme asset pipeline, theme customizer preview, theme migrations.
**Est:** 6-8 PRs, ~16 days.
**Storefront today:** Express middleware renders but no theme engine V2. `packages/core/src/modules/themes/bundle.ts` exists (tested in PR #14).

### Infra Track I-c — Payment & Shipping Engine 🔴
**Runs parallel to:** Phase 9 (settings UI).
**Scope:**
- **Payments:** Stripe, PayPal, VNPay, MoMo, ZaloPay, cash-on-delivery. Fraud gate (ipqualityscore + custom rules). Chargebacks (deferred; memory note `reminder_payment_chargebacks.md` — revisit here).
- **Shipping:** GHN, GHTK, Viettel Post, J&T, Ninja Van (VN) + DHL/FedEx/UPS (int'l). Rate API. Label generation. Tracking webhooks.
- **Tax:** VN VAT bands, int'l tax via Avalara-equivalent (build in-house v1).
**Est:** 10-12 PRs, ~25 days.

### Infra Track I-d — Apps Marketplace (future, after Phase 10)
**Scope:** OAuth apps, webhook billing API, App Bridge-equivalent iframe SDK, app install/uninstall flow.
**Est:** 6 PRs, ~12 days.
**Not in the Phase 2-10 scope** — document here for completeness, execute after Phase 11.

---

## 4. EXECUTION STRATEGY

### Strict vs. parallel

**Recommendation: Hybrid.**

```
                  Month 1        Month 2        Month 3        Month 4
Admin phases:     Phase 2 ──▶    Phase 4 ──▶   Phase 6 ──▶    Phase 8 ──▶ Phase 10 ──▶
                  Phase 3 ✅     Phase 5 ──▶   Phase 7 ──▶    Phase 9 ──▶
Infra tracks:                    I-a Checkout  I-b Themes      I-c Pay/Ship
                                 ═══════════▶  ═══════════▶   ═════════════▶
```

- **Phases 2 → 4 → 5 strictly sequential** (each builds on the prior data model).
- **Phase 6 parallel with 5** — analytics depends on data shape of orders+customers, both already done.
- **Phase 7 + Infra I-b run together** — admin UI is the frontend to the engine.
- **Phase 9 + Infra I-c run together** — same reason.
- **Phase 10 last** — it's the integration polish phase.

**But we won't actually run 3 things in parallel manually.** Thai's constraint: "ko theo kịp". So the **actual serial order we'll execute** is:

1. **Phase 2** (now)
2. **Phase 3 close-out** (mark DONE in docs; no code)
3. **Phase 4**
4. **Phase 5** (admin side only — runtime deferred)
5. **Infra I-a PR1-PR3** (checkout skeleton to unblock Phase 5 runtime + Phase 9)
6. **Phase 6**
7. **Phase 7 + Infra I-b interleaved** (PR by PR)
8. **Phase 8**
9. **Phase 9 + Infra I-c interleaved**
10. **Phase 10**
11. **Phase 11 (ship prep)**

Estimate to fully complete Phase 2-11: **~100 PRs, ~4-5 months solo full-time**, or ~3 months with limited parallel.

### Review cadence (respects "ôm đồm quá")

- **Every PR:** Thai reviews diff + acceptance checklist before merge.
- **Every phase close:** Thai gets 1-page status report, signs off before next phase starts.
- **Weekly:** Thai gets progress digest (phase % complete, blockers, next 3 PRs).

---

## 5. RISKS & MITIGATIONS

| Risk | Mitigation |
|---|---|
| Numbering collision with seller-dashboard-plan | This doc is the authoritative reconciliation. Edit seller-dashboard-plan header to point here. |
| Infra tracks stall admin phases | Ship admin phases with stub backends behind interface; infra track swaps implementation. |
| Schema drift (multi-currency locked in Phase 4 hardening but runtime not wired) | Phase 2 PR1 audits DB vs. Phase 4 hardening decisions, logs gaps as follow-up tasks. |
| Staging Terraform blocked (MEMORY) | Don't block on it. Continue dev on server 1 (`thaibeotit.com`). Revisit when dedicated CF zone. |
| Test coverage drops as surface grows | Every PR must include vitest. Weekly coverage check — flag regressions. |
| Thai loses track across 100 PRs | Weekly digest + phase-close reports. One `CLAUDE.md` "CURRENT PHASE" line kept fresh. |
| Scope creep (Shopify has 20 years of features) | YAGNI: only build what a real merchant asks for. Chargebacks, POS, B2B remain in backlog until a merchant needs them. |

---

## 6. DELIVERABLES CHECKLIST (this doc = just the start)

- [x] Master roadmap (this file)
- [ ] Phase 2 detailed plan: `2026-04-20-phase-2-detailed-plan.md`
- [ ] Update `CLAUDE.md` "Current Phase" line → "PHASE 2: Products Power-Up"
- [ ] Update seller-dashboard-plan.md header → "superseded by roadmap 2026-04-20 for sequencing"
- [ ] Each subsequent phase: its own `2026-MM-DD-phase-N-detailed-plan.md` before execution.

---

## 7. OWNER APPROVAL GATE

**Before I touch code for Phase 2, Thai must confirm:**

1. ☐ Phase numbering above matches what you want (seller-dashboard Phase 2-11 = this doc's Phase 2-11).
2. ☐ You accept Phase 3 as "already done, mark it closed" (with Sprint 7-8 deferred to Phase 8).
3. ☐ You accept the 3 infra tracks (I-a/b/c) running parallel to admin phases.
4. ☐ You accept the execution order in §4 ("actual serial order").
5. ☐ You accept ~100 PRs / ~4-5 months to reach Phase 11 complete.

**If yes → green-light Phase 2 detailed plan + start execution.**
**If any No → we revise this doc first.**

---

## 8. APPENDIX — PHASE CROSS-REFERENCE TABLE

| This doc | Old seller-dashboard-plan | Shopify-parity-roadmap | Orders-masterplan |
|---|---|---|---|
| Phase 2 Products | Phase 2 (B1-B5) | Phase A.11, B, C (DONE API) | — |
| Phase 3 Orders | Phase 3 (C1-C6) | Phase A.11, E (DONE) | Sprints 1-6 ✅ |
| Phase 4 Customer CRM | Phase 4 (D1-D6) | Phase A.12, A.13 | — |
| Phase 5 Discounts | Phase 5 (E1-E5) | Phase A.12, B.3 | — |
| Phase 6 Analytics | Phase 6 (G1-G6) | — | Sprint 8 (risk) |
| Phase 7 Online Store | Phase 7 (H1-H6) | Phase C, D | — |
| Phase 8 Marketing | Phase 8 (F1-F5) | — | — |
| Phase 9 Ship/Tax/Set | Phase 9 (I/J/K) | Phase A.6, A.10, G.1 | — |
| Phase 10 AI + Polish | Phase 10 (L + polish) | — | — |
| Phase 11 Deploy/QA | Phase 11 | Phase H | — |
| Infra I-a Checkout | — | Phase E.2 | — |
| Infra I-b Themes | — (scope in H1-H6) | — | — |
| Infra I-c Pay/Ship | — (scope in I/J) | Phase A.6 | Sprint 5 importers done |

---

**End of master roadmap.** Next artifact: `2026-04-20-phase-2-detailed-plan.md`.
