# Phase 14 PR3 — Priority 2 Growth Emails + Shopify Flow Lite

**Status:** LOCKED (scope approved 2026-04-22 by owner).
**Branch:** `phase-14-pr3-priority2-growth-and-automations`
**Base:** `26a7a62` (tip of PR2).
**Depends on:** PR1 (foundation), PR1.5 (overrides + frequency cap), PR2
(15 Priority 1 emails wired to `sendTemplatedEmail` + seller preview iframe).

---

## 1. Why this PR exists

PR2 finished the **transactional** spine: every receipt, tracking, auth,
and merchant-alert email in the Priority 1 block now flows through
`sendTemplatedEmail()` with registry + transport + preferences +
delivery-log + idempotency. The preview iframe lets sellers tweak those
templates live.

PR3 finishes the **growth** spine and introduces the **automation
framework** that all marketing + lifecycle emails will ride on from
Phase 14 onward. Without PR3, sellers still have 18 marketing /
lifecycle / merchant-ops templates showing in their admin UI that don't
actually fire from anywhere — same "scaffold only" problem PR1 started
with, just pushed to the next tier.

This is also our chance to pay down the **Phase 8 abandoned-cart debt**:
that module has its own ad-hoc cron, its own `email-flows` renderer, and
lives under `/marketing/automations` in the admin. That worked when it
was the only "automation" in the platform. With 18 more marketing
emails coming in this PR and the rest of Priority 2 coming later, it's
time to unify behind one framework.

---

## 2. The 18 emails wired in PR3

Each row below is one commit. Event name + delay + conditions are
authoritative — this table is the spec the flow-catalog entries must
match. "Variables" lists the keys we resolve at send time; anything
already in `NAMED_SAMPLES` (see `apps/store-admin/src/lib/
email-preview.ts`) renders in the preview iframe without extra work.

### 2a. Marketing (6)

| # | Template key | Trigger event | Delay | Conditions | Notes |
|---|---|---|---|---|---|
| 1 | `campaign_promo` | `campaign.scheduled` | at `send_at` | campaign row `status='scheduled'` | Replaces direct `sendEmail` call inside `campaigns-cron.ts`. |
| 2 | `newsletter_broadcast` | `campaign.scheduled` | at `send_at` | campaign row `type='newsletter'` | Shares the trigger with #1; conditions disambiguate. |
| 3 | `flash_sale` | `campaign.scheduled` | at `send_at` | campaign row `type='flash_sale'` | Adds countdown variables. |
| 4 | `seasonal_promo` | `campaign.scheduled` | at `send_at` | campaign row `type='seasonal'` | — |
| 5 | `product_launch` | `product.published` | 0m | product row `first_published = true` AND shop has `product_launch_emails_enabled` | One-time fire per product per shop (idempotency key = `product_launch:{shopId}:{productId}`). |
| 6 | `back_in_stock` | `inventory.restocked` | 0m | customer has active back-in-stock subscription for that variant | Batch-safe: one email per subscriber, idempotency `back_in_stock:{subscriptionId}:{restockEventId}`. |

### 2b. Lifecycle (4)

| # | Template key | Trigger event | Delay | Conditions | Notes |
|---|---|---|---|---|---|
| 7 | `post_purchase_thank_you` | `order.fulfilled` | +24h | customer has consented + not unsubscribed | Purely sentimental — no offer. Separate from upsell (#13). |
| 8 | `customer_win_back` | scheduled scan (`customer.dormant_detected`) | — | `last_order_at < now()-90d` AND `last_order_at > now()-365d` AND ≥1 prior order | Runs from scheduler, not real-time. One-shot per window. |
| 9 | `first_order_milestone` | `order.paid` | +2h | customer row `total_orders = 1` | Idempotency = `first_order:{customerId}`. |
| 10 | `onboarding_day_1` | `customer.created` | +24h | customer has never placed an order | Shop-gated (disabled by default for accounts portal sign-ups). |

### 2c. Reviews (1)

| # | Template key | Trigger event | Delay | Conditions | Notes |
|---|---|---|---|---|---|
| 11 | `review_request` | `order.delivered` | +7d | shop review settings `review_request_enabled = true`; no review yet for any line item | Pairs with PR2-wired `review_approved` / `review_replied`. |

### 2d. Transactional growth-adjacent (3)

| # | Template key | Trigger event | Delay | Conditions | Notes |
|---|---|---|---|---|---|
| 12 | `abandoned_cart_reminder_2` | `checkout.abandoned` | +24h | enrolment still `pending`, not recovered | Second step of the Phase 8 recovery sequence. |
| 13 | `abandoned_cart_reminder_3` | `checkout.abandoned` | +72h | enrolment still `pending`, not recovered | Final step — optional discount variable. |
| 14 | `post_purchase_upsell` | `order.paid` | +30m | at least one line item with a curated upsell collection | Idempotency = `upsell:{orderId}`. |

### 2e. Merchant ops (1)

| # | Template key | Trigger event | Delay | Conditions | Notes |
|---|---|---|---|---|---|
| 15 | `low_stock_alert` | `inventory.threshold_crossed` | 0m | variant `stock_on_hand <= shop.low_stock_threshold`; cooldown 24h per variant | Cooldown prevents storm when someone restocks then depletes again. |

### 2f. Add-ons (3, approved 2026-04-22)

| # | Template key | Trigger event | Delay | Conditions | Notes |
|---|---|---|---|---|---|
| 16 | `fulfillment_out_for_delivery` | `fulfillment.out_for_delivery` | 0m | carrier webhook normalised status = `out_for_delivery` | Requires we add the status to the tracking-sync normaliser (small change, committed alongside). Updates `phase-14-deferred.md` line 67-76 to **CLOSED**. |
| 17 | `payment_failed_customer` | `payment.failed` | 0m | order row exists, not already refunded | Customer-facing. `payment_failed_merchant` stays deferred until Phase 12. |
| 18 | `high_value_order` | `order.paid` | 0m | order `total_price >= shop.high_value_threshold` (default $500) | Merchant-facing ops alert. |

**Total: 18 emails.**

---

## 3. Architecture — Shopify Flow Lite

Goal: one event bus, one catalog of flow definitions, one runner, one
scheduler. Event-driven (emitted from the call site that does the
work), declarative flows (catalog in code, row per shop in DB for
overrides), delay-capable (`automation_scheduled` queue with a 60s cron
tick).

```
  ┌──────────────────────┐     emit()      ┌──────────────────────┐
  │  Call site           │────────────────▶│  automation_events   │
  │  (orders.capture,    │                 │  (append-only log)   │
  │   fulfillment.ship,  │                 └──────────┬───────────┘
  │   campaigns.schedule │                            │
  │   …)                 │                            │
  └──────────────────────┘                            │
                                                      ▼
                                          ┌──────────────────────┐
                                          │  runner.dispatch()   │
                                          │  for each flow in    │
                                          │  catalog matching    │
                                          │  event.type:         │
                                          │                      │
                                          │  1. evaluate         │
                                          │     conditions       │
                                          │  2. if delay=0       │
                                          │     → sendTemplated  │
                                          │     Email NOW        │
                                          │  3. else → INSERT    │
                                          │     automation_      │
                                          │     scheduled row    │
                                          │     (fire_at)        │
                                          │  4. record run       │
                                          │     (automation_runs)│
                                          └──────────┬───────────┘
                                                     │
  ┌──────────────────────┐     60s cron     ┌────────▼───────────┐
  │  scheduler.tick()    │◀─────────────────│ automation_        │
  │  SELECT … WHERE      │                  │ scheduled          │
  │  fire_at <= NOW()    │                  │ (fire_at, status)  │
  │  AND status='pending'│                  └────────────────────┘
  │  FOR UPDATE SKIP     │
  │  LOCKED              │
  │  → sendTemplatedEmail│
  │  → mark 'sent' /     │
  │    'failed'          │
  └──────────────────────┘
```

### 3a. `packages/core/src/modules/automations/` (new)

| File | Responsibility |
|---|---|
| `events.ts` | `AutomationEvent` union type (one variant per trigger above), `emit(db, event)` that inserts into `automation_events` AND calls `runner.dispatch(event)` inline. Keeps the call-site ergonomic: `await emit(db, { type: 'order.paid', shopId, orderId, customerId })`. |
| `flow-catalog.ts` | In-code declarative catalog — each entry: `{ key, templateKey, trigger, delay, conditions[], variables(event, db) }`. No DB roundtrip to read catalog — the `automation_flows` table is an **override layer** (enabled/disabled, custom delay, custom conditions) same as the per-shop email-template override pattern from PR1.5. |
| `conditions.ts` | Condition AST + evaluator. Supports `{op: 'eq'/'gte'/'lte', field, value}` over the event payload + loaded shop/customer/order context. Pure-function, unit-testable. |
| `runner.ts` | `dispatch(db, event)` — resolves catalog entries for `event.type`, evaluates conditions, either sends now (delay=0) or schedules. Wraps `sendTemplatedEmail` so iron-rule-5 and preference checks still apply (free — those live in send.ts). |
| `scheduler.ts` | `tick(db)` — picks up to 500 pending rows with `fire_at <= NOW()`, `FOR UPDATE SKIP LOCKED` for safe concurrent runs, dispatches each via `sendTemplatedEmail`, marks sent/failed. Same budget pattern as abandoned-cart-cron. |

### 3b. Migration 085 — 4 new tables

```sql
-- Per-shop overrides of a catalog flow (enable/disable, tweak delay).
-- If no row exists for a shop+flowKey, catalog defaults apply.
CREATE TABLE automation_flows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  flow_key      TEXT NOT NULL,                    -- matches catalog key
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  delay_seconds INTEGER,                          -- NULL → use catalog default
  conditions    JSONB,                            -- NULL → use catalog default
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, flow_key)
);

-- Append-only audit of every emitted event (source of truth for runs).
CREATE TABLE automation_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                       -- 'order.paid' etc
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_automation_events_shop_type_created
  ON automation_events(shop_id, type, created_at DESC);

-- Delayed dispatch queue — the 60s scheduler eats from here.
CREATE TABLE automation_scheduled (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  flow_key        TEXT NOT NULL,
  event_id        UUID NOT NULL REFERENCES automation_events(id) ON DELETE CASCADE,
  fire_at         TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed|cancelled
  idempotency_key TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, idempotency_key)
);
CREATE INDEX idx_automation_scheduled_due
  ON automation_scheduled(status, fire_at)
  WHERE status = 'pending';

-- Run ledger — every flow execution attempt (success or skip).
CREATE TABLE automation_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  flow_key     TEXT NOT NULL,
  event_id     UUID NOT NULL REFERENCES automation_events(id) ON DELETE CASCADE,
  outcome      TEXT NOT NULL,                    -- sent|skipped_conditions|skipped_dedup|failed
  reason       TEXT,
  delivery_id  UUID REFERENCES email_deliveries(id) ON DELETE SET NULL,
  scheduled_id UUID REFERENCES automation_scheduled(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_automation_runs_shop_flow_created
  ON automation_runs(shop_id, flow_key, created_at DESC);
```

**Why 4 tables?** Separation of concerns — events (what happened),
scheduled (what's queued), runs (what we did about it), flows (what the
shop wants). Keeps audit clean: an event can trigger 0, 1, or many
flows; each flow produces exactly one run; a run may or may not have a
scheduled row. Same pattern as Shopify Flow's event/action/trigger
split.

---

## 4. Phase 8 abandoned-cart migration plan

**Current state (PR-landed in Phase 8 PR2):**

- Dedicated cron `dispatch_abandoned_cart_steps` ticks every 30 min.
- Enrolment table `abandoned_cart_enrollments` tracks per-checkout
  progress through steps 1/2/3.
- Admin UI at `/admin/store/:slug/marketing/automations/abandoned-cart`.
- Renderer is a hand-rolled `email-flows.ts` (Mustache-style) that
  pre-dates the `sendTemplatedEmail` pipeline.
- Template rows in DB but bypassed: the cron reads
  `shop_email_flow_configs` for subject/body, not
  `email_template_registry`.

**Target state (PR3 end):**

- `checkout.abandoned` emitted from the storefront checkout controller
  when it detects an eligible cart. The **existing detection logic
  stays** — we only replace the send pipeline and the UI entry point.
- Flow-catalog entries `abandoned_cart_reminder_1` / `_2` / `_3` wired
  (reminder_1 = wraps the existing `abandoned_cart_recovery` key that
  PR2 already moved to `sendTemplatedEmail`).
- Admin UI moves to `/admin/store/:slug/settings/automations` with
  per-flow toggle + delay override. Old URL serves a 301 redirect (one
  PR overlap — will remove in Phase 15).
- Feature flag **`AUTOMATION_FRAMEWORK_V2`** gates the new path. When
  OFF, the legacy cron keeps running and emits nothing; when ON, the
  legacy cron short-circuits and all sends route through the new
  runner. Default ON at deploy time, but one-line rollback via env.
- Data migration: **zero**. No backfill required — enrolment state
  (`abandoned_cart_enrollments`) stays the source of truth for "is
  this cart still open?"; we just stop reading `shop_email_flow_configs`
  for body/subject (those now come from `email_template_registry` via
  `resolveTemplate`).

**Deprecation timeline:**

| PR | State |
|---|---|
| PR3 (this) | Both paths live. Flag ON ships v2 by default; flag OFF is a 1-line rollback. 301 from old URL to new. |
| PR4 (optional, same phase) | Only if issues surface in canary. |
| Phase 15 PR1 | Remove legacy cron handler + `email-flows.ts` renderer + `shop_email_flow_configs` table. Update this doc to "closed". |

---

## 5. Events emitted in this PR

We emit from the **call site that does the work**, not from legacy
shims. Each line below is one instrumentation point — a single
`await emit(db, { type, ...payload })` inserted after the domain action
commits.

| Event type | Emit site | Triggers flows |
|---|---|---|
| `order.paid` | `orders/service.ts::markOrderPaid` | `first_order_milestone`, `post_purchase_upsell`, `high_value_order` |
| `order.fulfilled` | `fulfillment/service.ts::markShipped` | `post_purchase_thank_you` |
| `order.delivered` | `fulfillment/lenful/tracking-sync.ts` (existing `delivered` normalisation) | `review_request` |
| `fulfillment.out_for_delivery` | same tracking-sync (new status normalisation added this PR) | `fulfillment_out_for_delivery` |
| `payment.failed` | `payments/service.ts::recordPaymentFailure` | `payment_failed_customer` |
| `product.published` | `products/service.ts::publishProduct` | `product_launch` |
| `inventory.restocked` | `inventory/service.ts::adjustStock` (when stock goes 0 → >0) | `back_in_stock` |
| `inventory.threshold_crossed` | `inventory/service.ts::adjustStock` (when stock falls to/below threshold) | `low_stock_alert` |
| `customer.created` | `customers/service.ts::createCustomer` | `onboarding_day_1` |
| `customer.dormant_detected` | new scheduled scan in `scheduler.ts` (daily sweep) | `customer_win_back` |
| `campaign.scheduled` | `campaigns-cron.ts` (replaces inline `sendEmail`) | `campaign_promo`, `newsletter_broadcast`, `flash_sale`, `seasonal_promo` |
| `checkout.abandoned` | `storefront/checkout/service.ts::detectAbandonment` (factored out of the existing cron) | `abandoned_cart_reminder_1/2/3` |

---

## 6. Out of scope — Priority 2 templates NOT wired in PR3

The 43 Priority-2-marked templates in the registry minus the 18 above =
25 deferred. Owner-visible reasons why each waits:

### 6a. RMA (4) — needs Phase 15 Returns module

- `return_requested`, `return_approved`, `return_declined`,
  `return_received` — already tracked in `phase-14-deferred.md` §6-9.
  PR3 leaves that section as-is.

### 6b. Payments-deeper (7) — needs Phase 12 + chargeback module

- `order_paid` (auth-then-capture split only; phase-14-deferred §1)
- `payment_failed_merchant` (needs merchant notification prefs — pair
  with `payment_failed_customer` after customer-side validated)
- `refund_issued_merchant` (same — after merchant prefs land)
- `chargeback_opened`, `chargeback_won`, `chargeback_lost`,
  `high_risk_order` — all blocked on payments phase chargeback work
  (see MEMORY: `reminder_payment_chargebacks.md`).

### 6c. Loyalty (5) — needs loyalty module (not in Phase 14)

- `loyalty_points_earned`, `loyalty_tier_upgrade`, `vip_exclusive`,
  `birthday_discount`, `anniversary` — require a loyalty_balance
  table + accrual engine. Flagged for Phase 16+.

### 6d. Referral (2) — needs referral module (not in Phase 14)

- `referral_invite`, `referral_reward` — blocked on referral system
  build-out.

### 6e. Merchant ops deeper (3) — low-urgency, next email PR

- `first_time_customer_order` (nice-to-have; low ROI if `high_value_order`
  is already wired — revisit PR4).
- `staff_invited` — already covered by the staff module's own
  transactional path in Phase 9 PR4; needs reconciliation, not a new wire.
- `staff_new_device_login` — same.

### 6f. Pickup / BOPIS (1) — needs BOPIS phase

- `fulfillment_ready_for_pickup` — tracked in phase-14-deferred §3.

### 6g. Platform / god-admin (audience=god_admin, NEVER seller-visible) (3)

Flagged as Priority 2 by category but correctly filtered by Iron Rule 5:

- `platform_weekly_roundup`, `new_merchant_signup`, `daily_sales_digest`
  (this one is merchant-audience so NOT filtered — but it's a digest
  job, not a real-time trigger; better suited to a dedicated digest
  phase after the primitives settle).

### 6h. Legal / compliance (7) — needs compliance phase

- `gdpr_data_export_ready`, `gdpr_data_deletion_confirmed`,
  `tos_update`, `privacy_policy_update`, `cookie_consent_update`,
  `data_breach_notice`, `regulatory_disclosure` — all depend on a
  compliance module with legal-review sign-off; not a growth PR.

### 6i. Other (2)

- `order_edited` (needs Edit Order UI — phase-14-deferred §10).
- `order_invoice_sent` (needs invoice-reminder cron —
  phase-14-deferred §11).

---

## 7. Commit sequence

| # | Subject | Scope |
|---|---|---|
| 1 | `docs(pr3): scope + phase-8 migration plan + deferred updates` | this doc + updates to `phase-14-deferred.md` |
| 2 | `db(migration-085): automation framework tables` | 4 tables + indexes + smoke check |
| 3 | `automations(core): event bus + emit()` | `events.ts` + types + tests |
| 4 | `automations(core): flow-catalog + conditions evaluator` | `flow-catalog.ts` + `conditions.ts` + tests |
| 5 | `automations(core): runner + 60s scheduler` | `runner.ts` + `scheduler.ts` + cron wiring + tests |
| 6 | `automations(flow): campaign_promo + newsletter_broadcast + flash_sale + seasonal_promo` | 4 catalog entries + campaigns-cron refactor to emit |
| 7 | `automations(flow): product_launch` | catalog entry + products/service emit |
| 8 | `automations(flow): back_in_stock` | catalog entry + inventory/service emit |
| 9 | `automations(flow): post_purchase_thank_you` | catalog entry + fulfillment emit |
| 10 | `automations(flow): customer_win_back + daily dormant-scan` | catalog entry + scheduler sweep |
| 11 | `automations(flow): first_order_milestone + post_purchase_upsell + high_value_order` | 3 catalog entries on `order.paid` |
| 12 | `automations(flow): onboarding_day_1` | catalog entry + customer.created emit |
| 13 | `automations(flow): review_request` | catalog entry on `order.delivered` |
| 14 | `automations(flow): abandoned_cart_reminder_1/2/3 + phase 8 migration` | 3 catalog entries + storefront emit site + feature flag + 301 redirect |
| 15 | `automations(flow): low_stock_alert + cooldown` | catalog entry + inventory emit + 24h cooldown |
| 16 | `automations(flow): fulfillment_out_for_delivery + tracking-sync status add` | catalog entry + normaliser tweak |
| 17 | `automations(flow): payment_failed_customer` | catalog entry + payments emit site |
| 18 | `automations(ui): /settings/automations admin page` | list + per-flow toggle + 301 from legacy URL |
| 19 | `smoke(pr3): end-to-end on live DB + open PR` | `smoke-phase14-pr3.ts` + 40+ assertions |

Commit 6 wraps 4 emails into one natural unit (all share the
`campaign.scheduled` trigger) so the total commit count lands at ~19
even though we're wiring 18 emails.

---

## 8. Acceptance criteria

- [ ] All 4 new tables exist in DB after `npm run db:migrate`.
- [ ] `scripts/smoke-phase14-pr3.ts` passes on 192.168.1.13 `gbox_platform`
      with 40+ assertions covering:
      - [ ] migration 085 applied cleanly (no collision)
      - [ ] all 18 flow-catalog entries loadable
      - [ ] at least one end-to-end event → scheduled → sent cycle
      - [ ] dedupe on repeated emit (idempotency key)
      - [ ] preference opt-out blocks send (already in send.ts, verify
            the new pipe still honours it)
      - [ ] iron-rule-5: no `god_admin` audience template reachable via
            any new admin route
      - [ ] feature flag OFF: legacy abandoned-cart cron still runs,
            no automation_events rows created
      - [ ] feature flag ON: new cart emit fires, legacy cron is a no-op
- [ ] `docs/email-system/phase-14-deferred.md` updated: §4
      (`fulfillment_out_for_delivery`) moves to the "Closed" section
      with the PR3 commit hash.
- [ ] Seller-facing admin page at `/settings/automations` renders for a
      test shop with all 18 flows enabled, each with a preview link to
      the underlying email template.
- [ ] No new `console.log` leaks of internal paths / god-admin surface
      in any seller-visible response (Iron Rule 5).
- [ ] Coverage: ≥80% lines across `automations/` module per Vitest.
- [ ] PR description links to this doc + lists all 18 keys with commit
      shas.
