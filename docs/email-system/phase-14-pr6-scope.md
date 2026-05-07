# Phase 14 PR6 — Priority 3 ops: platform alerts + finance events

**Status:** LOCKED (scope approved 2026-04-22 by owner; autonomous
continuation of the Phase 14 thread).
**Branch:** `phase-14-pr6-priority3-ops`
**Base:** tip of `phase-14-pr5-gdpr-privacy-pack` (PR #79 stacked).
**Depends on:** PR1 (email foundation), PR2 (seller preview iframe),
PR3 (automation framework — `automation_events` / `flow-catalog` /
runner + scheduler), PR4 (tracking), PR4.B (suppression + bounce
webhooks), PR5 (consent ledger + privacy requests — we emit
`consent_events` on several platform alerts for auditability).

---

## 1. Why this PR exists

PR1–PR5 shipped the **customer** + **seller** email surfaces end-to-end:
transactional receipts, growth lifecycle, review requests, GDPR flows,
marketing automations. 75 of the 95 registry templates are now wired.

**What's still scaffold-only**: the **operational** tier. Two audiences:

- **Platform alerts** (9 templates, `audience='god_admin'`) — the
  @gbox.co mailbox is the recipient. These fire when the PLATFORM
  itself has an event worth a human's attention (5xx spike, merchant
  signup, integration health degradation, weekly KPI roundup). Today
  they live in the registry but nothing triggers them; ops watches
  console logs + push-log instead, which is how incidents get missed.
- **Finance / ops alerts** (11 templates, merchant audience) — payouts,
  chargebacks, refund logs, high-risk order fraud flags, out-of-stock
  alerts, daily sales digest. Today the merchant sees these in the
  admin UI only (or not at all — some are computed live with no
  history). Email gives them a push surface + a record in the
  deliveries log.

PR6 closes both. After PR6, every registry template marked
`priority ≤ 3` will either be `implemented: true` (13 wired today) or
`implemented: false with a clear Phase 12 dependency` (7 finance rows
that need the payouts/chargebacks schema to land first — catalog is in
place but no substrate yet).

The remaining scaffolds are priority 4 (advanced) or priority 2 that
need a dedicated feature phase (return_*, magic_link, etc). Those stay
in `phase-14-deferred.md`.

---

## 2. Scope

### 2a. In scope — 20 templates wired

#### Platform (9) — `audience='god_admin'`, direct `shopId: null` sends

All 9 go through a new module `@gbox/core/modules/platform-alerts/` that
wraps `sendTemplatedEmail({ shopId: null, to: <recipient> })`. Recipient
lookup lives in the new `platform_alert_recipients` table — one row per
alert type, mapping to a god-admin mailbox (`alerts@gbox.co` by default).

De-dup + cooldowns: every alert write hits `platform_alert_deliveries`
first. `(alert_type, dedup_key)` is UNIQUE within a window (default
60s for incident, 24h for digest) so a burst of errors doesn't email
ops 500 times.

| # | Template key | Trigger | Wiring | Iron-rule-5 gate |
|---|---|---|---|---|
| 1 | `new_merchant_signup` | Shop created in accounts portal | `postCreateStore()` → `emitNewMerchantSignup({ shop })` | send.ts audience check + god-admin-mailbox-only recipient |
| 2 | `platform_incident_alert` | Uncaught exception / unhandled rejection | `installProcessErrorHandlers()` wrapper fires at severity=critical | 60s dedup on `err.message_hash` |
| 3 | `platform_daily_digest` | 06:00 UTC daily cron | `scripts/ops/run-platform-daily-digest.ts` | UNIQUE on `dedup_key=date:YYYY-MM-DD` |
| 4 | `platform_churn_alert` | Shop state transition to `suspended`/`closed` | hook in existing shop-lifecycle admin action | 24h cooldown per shop |
| 5 | `platform_fraud_review` | New cron scans high-risk order clusters | `scripts/ops/run-platform-fraud-review.ts` — Phase 4.7 `risk_score` sum | 24h per shop |
| 6 | `platform_policy_violation` | God-admin reports action | direct helper `emitPolicyViolation({ shopId, reason })` | per-shop cooldown 24h |
| 7 | `platform_billing_failure` | **Phase 12 dep** — Gbox subscription charge failed | catalog + emitter only; no trigger wired until Phase 12 lands subscription billing | — |
| 8 | `platform_integration_down` | Integration health >5m error rate >10% | `push-log.ts` wrapper on integration calls; runs emit from existing health check | 5m dedup on `integration_name` |
| 9 | `platform_weekly_roundup` | Monday 07:00 UTC weekly cron | `scripts/ops/run-platform-weekly-roundup.ts` | UNIQUE on `dedup_key=week:YYYY-WW` |

#### Finance / ops (11) — merchant audience, via flow catalog

6 fire against the existing event bus + emit real substrate today.
5 are catalog-only until Phase 12 payments ships payout/chargeback
schemas. All 11 get flow-catalog entries so merchants can toggle
`active` from `/settings/automations` and Phase 12 wiring is drop-in.

| # | Template key | Event | Wired today? | Notes |
|---|---|---|---|---|
| 10 | `refund_issued_merchant` | `refund.issued` (new) | ✅ wired | Emits from `packages/core/src/modules/refunds/service.ts::approveRefund` (exists since Phase 4). |
| 11 | `payment_failed_merchant` | `payment.failed` (existing) | ✅ wired | Same event as PR3's `payment_failed_customer` — different audience. Runner handles fan-out. |
| 12 | `high_risk_order` | `order.high_risk` (new) | ✅ wired | Emitted in `orders/service.ts::markOrderPaid` when `risk_score >= shop.high_risk_threshold` (default 75). |
| 13 | `out_of_stock_alert` | `inventory.out_of_stock` (new) | ✅ wired | Emitted when inventory decrement takes `on_hand: 0`. Mirrors `low_stock_alert` from PR3 but at zero. |
| 14 | `daily_sales_digest` | daily cron (not event-driven) | ✅ wired | `scripts/ops/run-merchant-daily-digest.ts` — one email per shop with yesterday's totals. |
| 15 | `first_time_customer_order` | `order.paid` existing event | ✅ wired | Condition: `event.totalOrdersForCustomer === 1` AND `event.customerId` not null. Differs from `first_order_milestone` (PR3 — 2h delay, customer-audience) — this is 0-delay merchant-audience. |
| 16 | `payout_scheduled` | `payout.scheduled` (new, deferred) | ⏳ Phase 12 | Catalog + event type defined; no emitter today. |
| 17 | `payout_completed` | `payout.completed` (new, deferred) | ⏳ Phase 12 | Same. |
| 18 | `payout_failed` | `payout.failed` (new, deferred) | ⏳ Phase 12 | Same. |
| 19 | `chargeback_opened` | `chargeback.opened` (new, deferred) | ⏳ Phase 12 | Same. |
| 20 | `chargeback_lost` | `chargeback.lost` (new, deferred) | ⏳ Phase 12 | Same. Chargeback_won is priority 3 but we drop it for PR6 (Shopify doesn't email — "positive news via admin UI is enough"). |

### 2b. Out of scope (deferred)

| Deferred | Goes to | Why |
|----------|---------|-----|
| `chargeback_won` email | Phase 12 PR2 | Merchants see the win in admin UI; extra email is noise. Template stays scaffold with explicit note. |
| Real payout + chargeback emitters | Phase 12 | Needs `payouts` + `dispute_cases` tables. PR6 lays the event types + catalog so Phase 12 is drop-in. |
| Platform alert admin UI (recipient management via god-admin app) | PR6 ships a minimal page | Fully-featured alert routing (per-severity escalation, on-call rotations, PagerDuty integration) stays Phase 15+. |
| Platform alert retries on SMTP failure | Phase 15+ | `sendTemplatedEmail` already writes `status='failed'` to `email_deliveries`; a retry worker is a separate concern. |
| Severity escalation (Slack/PagerDuty) | Phase 15+ | Email is the first rail; multi-channel is a v2 concern. |
| Per-merchant override of finance alert recipients | Phase 15+ | Today: alerts go to the shop owner's email (existing `shops.owner_user_id → users.email` lookup). Phase 15 adds per-category overrides. |

---

## 3. Design

### 3a. Schema (migration 089)

```sql
-- 3a.1  Recipient lookup for platform alerts (god_admin audience)
CREATE TABLE platform_alert_recipients (
  alert_type TEXT PRIMARY KEY CHECK (alert_type IN (
    'new_merchant_signup',
    'platform_incident_alert',
    'platform_daily_digest',
    'platform_churn_alert',
    'platform_fraud_review',
    'platform_policy_violation',
    'platform_billing_failure',
    'platform_integration_down',
    'platform_weekly_roundup'
  )),
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed one row per alert_type pointing to alerts@gbox.co (can be
-- overridden per alert_type from the god-admin UI).

-- 3a.2  De-dup + cooldown ledger
CREATE TABLE platform_alert_deliveries (
  id BIGSERIAL PRIMARY KEY,
  alert_type TEXT NOT NULL,
  dedup_key TEXT NOT NULL,         -- e.g. 'date:2026-04-22', 'shop:<uuid>', sha256(err_msg)
  email_delivery_id BIGINT NULL REFERENCES email_deliveries(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,          -- alert-specific context for audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup: one row per (alert_type, dedup_key) globally. Callers that
-- want to force-send a duplicate must use a differentiated dedup_key
-- (e.g. append a uuid). Partial UNIQUE: allows NULL collision if we
-- ever decide some alerts can't dedup.
CREATE UNIQUE INDEX idx_platform_alert_deliveries_dedup
  ON platform_alert_deliveries(alert_type, dedup_key);

CREATE INDEX idx_platform_alert_deliveries_recent
  ON platform_alert_deliveries(alert_type, created_at DESC);
```

No destructive changes; no new columns on existing tables. Zero impact
on the rest of the platform.

### 3b. Core module — `packages/core/src/modules/platform-alerts/`

```
platform-alerts/
  index.ts                    # barrel re-exports
  send.ts                     # one `sendPlatformAlert(db, { type, variables, dedup_key })` entry point
  recipients.ts               # getRecipientFor(type) with env fallback
  dedup.ts                    # checkAndRecordDedup() — atomic INSERT on the UNIQUE index
  emitters/
    incident.ts               # emitIncident({ severity, title, runbookUrl })
    integration-down.ts       # emitIntegrationDown({ integrationName, errorRate, statusPage })
    merchant-signup.ts        # emitNewMerchantSignup({ shopId, ownerEmail })
    churn.ts                  # emitChurnAlert({ shopId, reason })
    fraud-review.ts           # emitFraudReview({ shopId, heuristic, evidenceUrl })
    policy-violation.ts       # emitPolicyViolation({ shopId, reason })
    billing-failure.ts        # emitBillingFailure({ shopId, amount, reason })  ← Phase 12 dep, exported but never called today
```

Every helper ultimately calls `sendPlatformAlert()` which:

1. Resolves recipient via `platform_alert_recipients`.
2. Hits `platform_alert_deliveries` with `INSERT ... ON CONFLICT DO NOTHING` on `(alert_type, dedup_key)`. If no row inserted → dedup hit → return `{ sent: false, reason: 'deduped' }`.
3. Calls `sendTemplatedEmail({ shopId: null, to: recipient, templateKey, variables })`.
4. Updates the dedup row with `email_delivery_id`.

All emitters accept an optional `dbOverride` param so tests can pass a
stub + force-cleanup.

### 3c. Flow catalog additions

Extend `packages/core/src/modules/automations/flow-catalog.ts` with
the 6 merchant-audience finance flows that have event substrate today +
5 catalog-only entries for Phase 12-dep flows (5 because we drop
`chargeback_won` per 2b).

New event types in `automations/events.ts`:

```ts
// Finance (Phase 12-dep)
| { type: 'payout.scheduled'; shopId: string; payoutId: string; amount: number; currency: string; expectedAt: Date; occurredAt?: Date }
| { type: 'payout.completed'; shopId: string; payoutId: string; amount: number; currency: string; bankLast4: string; occurredAt?: Date }
| { type: 'payout.failed'; shopId: string; payoutId: string; amount: number; failureReason: string; occurredAt?: Date }
| { type: 'chargeback.opened'; shopId: string; orderId: string; amount: number; reason: string; occurredAt?: Date }
| { type: 'chargeback.lost'; shopId: string; orderId: string; amount: number; occurredAt?: Date }

// Refunds (Phase 4 substrate)
| { type: 'refund.issued'; shopId: string; orderId: string; refundId: string; amount: number; currency: string; occurredAt?: Date }

// Risk / fraud (new on top of existing order.paid flow)
| { type: 'order.high_risk'; shopId: string; orderId: string; riskScore: number; customerId: string | null; occurredAt?: Date }

// Inventory — new threshold=0 variant
| { type: 'inventory.out_of_stock'; shopId: string; variantId: string; previousOnHand: number; occurredAt?: Date }
```

### 3d. Wiring map (13 triggers)

| Template key | Caller / cron file | Insertion point |
|---|---|---|
| `new_merchant_signup` | `apps/accounts/src/pages/create-store.ts::postCreateStore` | After successful `shops` insert, before redirect |
| `platform_incident_alert` | `packages/core/src/modules/logging/logger.ts::installProcessErrorHandlers` | Inside `uncaughtException` handler (severity=critical) |
| `platform_daily_digest` | `scripts/ops/run-platform-daily-digest.ts` (new) | Cron — 06:00 UTC |
| `platform_churn_alert` | `apps/god-admin/src/pages/admins.ts` or shop lifecycle | On `shops.status` transition to `closed`/`suspended` |
| `platform_fraud_review` | `scripts/ops/run-platform-fraud-review.ts` (new) | Cron — 03:00 UTC; scans `orders` for risk spikes |
| `platform_policy_violation` | Direct helper — called from god-admin action handler | Out-of-band |
| `platform_integration_down` | `packages/core/src/modules/integrations/health.ts` (new) | Called by existing integration wrappers on sustained error |
| `platform_weekly_roundup` | `scripts/ops/run-platform-weekly-roundup.ts` (new) | Cron — Mon 07:00 UTC |
| `refund_issued_merchant` | `packages/core/src/modules/refunds/service.ts` (existing) | After refund row approved |
| `payment_failed_merchant` | Existing `payment.failed` event | Fan-out to both templates |
| `high_risk_order` | `packages/core/src/modules/orders/service.ts::markOrderPaid` | Re-emit as `order.high_risk` when threshold crossed |
| `out_of_stock_alert` | `packages/core/src/modules/inventory/service.ts` (existing decrement hook) | Emit `inventory.out_of_stock` when `on_hand: 0` |
| `first_time_customer_order` | Existing `order.paid` event, new flow entry | Condition `totalOrdersForCustomer === 1` |
| `daily_sales_digest` | `scripts/ops/run-merchant-daily-digest.ts` (new) | Cron — 06:05 UTC per shop |

### 3e. God-admin UI — `/god-admin/platform-alerts`

**IMPORTANT Iron rule 5:** this page lives ONLY on the god-admin app
(apps/god-admin). The store-admin app (merchant-facing) NEVER links to
it, mentions it in any string, or surfaces any of the 9 platform
templates in its UI. `getMerchantVisibleTemplates()` remains the single
choke-point; PR6 does not touch it.

Page features:
- Table: one row per alert type.
  - Alert name + description.
  - Recipient email (inline-editable).
  - Enabled toggle.
  - Last delivery (from `platform_alert_deliveries`).
  - Test-send button (fires a synthetic alert with `dedup_key='test:<ts>'`).
- Flash banner on save.
- Server-side role check: admin must be god_admin (existing
  `requireGodAdmin` middleware).

### 3f. Merchant UI — `/admin/store/:slug/settings/finance-alerts`

New settings page under the existing "Alerts" hub (from Phase 9 PR4).
Toggle row per finance template with audience=merchant:
- refund_issued_merchant
- payment_failed_merchant
- high_risk_order
- out_of_stock_alert
- daily_sales_digest
- first_time_customer_order
- (5 Phase-12-dep deferred with "Enable once Gbox Payments launches" chip — disabled)

Uses existing `automation_flows` table — one row per (shop, flow_key)
with `active` + `delay_seconds` + `conditions`. No new DB work.

---

## 4. File structure

### 4a. New files

```
docs/email-system/phase-14-pr6-scope.md                  # this file

packages/db/src/migrations/
  089_platform_alerts.ts                                 # 2 tables, 2 indexes, seed row per alert_type

packages/core/src/modules/platform-alerts/
  index.ts
  send.ts
  recipients.ts
  dedup.ts
  emitters/incident.ts
  emitters/integration-down.ts
  emitters/merchant-signup.ts
  emitters/churn.ts
  emitters/fraud-review.ts
  emitters/policy-violation.ts
  emitters/billing-failure.ts

packages/core/test/
  platform-alerts-send.test.ts
  platform-alerts-emitters.test.ts

scripts/ops/
  run-platform-daily-digest.ts
  run-platform-weekly-roundup.ts
  run-platform-fraud-review.ts
  run-merchant-daily-digest.ts

apps/god-admin/src/pages/
  platform-alerts.ts

apps/store-admin/src/pages/
  finance-alerts-settings.ts

scripts/
  smoke-phase14-pr6.ts                                   # end-to-end live-DB smoke
```

### 4b. Modified files

```
packages/db/src/migrations/run.ts                         # register 089
packages/core/src/modules/email/index.ts                  # re-export platform-alerts barrel
packages/core/src/modules/email/registry.ts               # 20 templates: flip implemented:true + polish bodyHtml/bodyText for the 13 wired ones
packages/core/src/modules/automations/events.ts           # 8 new event types
packages/core/src/modules/automations/flow-catalog.ts     # 11 new entries
packages/core/src/modules/automations/runner.ts           # no changes expected (runner is catalog-agnostic)
packages/core/src/modules/logging/logger.ts               # installProcessErrorHandlers emits incident alert
packages/core/src/modules/refunds/service.ts              # emit refund.issued after approve
packages/core/src/modules/orders/service.ts               # emit order.high_risk alongside order.paid when risk_score >= threshold
packages/core/src/modules/inventory/service.ts            # emit inventory.out_of_stock when on_hand drops to 0
apps/accounts/src/pages/create-store.ts                   # fire emitNewMerchantSignup after successful create
apps/god-admin/src/server.ts                              # mount /god-admin/platform-alerts
apps/store-admin/src/server.ts                            # mount /settings/finance-alerts
apps/store-admin/src/pages/settings.ts                    # hub card → finance-alerts
apps/store-admin/src/layouts/seller-layout.ts             # sidebar entry + palette
scripts/ops/smoke-baseline.json                           # smoke-phase14-pr6 entry
docs/email-system/phase-14-deferred.md                    # strike wired items; add Phase 12 deferred section
scripts/seed-email-registry.ts                            # re-seed after implemented flag flip (no schema change)
```

---

## 5. Env vars

| Name | Purpose | Default |
|------|---------|---------|
| `PLATFORM_ALERTS_ENABLED` | Master kill-switch for all 9 god-admin alerts | `1` (on) |
| `PLATFORM_ALERTS_DEFAULT_RECIPIENT` | Fallback recipient if `platform_alert_recipients` row missing | `alerts@gbox.co` |
| `PLATFORM_INCIDENT_DEDUP_WINDOW_SECONDS` | Cooldown on identical error bursts | `60` |
| `PLATFORM_DIGEST_ENABLED` | Separate kill-switch for daily/weekly cron | `1` |
| `MERCHANT_DIGEST_ENABLED` | Separate kill-switch for per-shop daily digest | `1` |
| `HIGH_RISK_ORDER_THRESHOLD` | `order.risk_score` at or above → emit alert | `75` |

---

## 6. Rollout

1. Ship migration 089 on dev → verify 2 tables + 2 indexes + 9 seed rows.
2. Wire 13 emitter/cron triggers + deploy with `PLATFORM_ALERTS_ENABLED=0`.
3. Flip to `PLATFORM_ALERTS_ENABLED=1` after smoke run passes on server 2.
4. Add 2 new pm2 cron entries: `run-platform-daily-digest` (06:00 UTC),
   `run-platform-weekly-roundup` (Mon 07:00), `run-platform-fraud-review`
   (03:00 UTC), `run-merchant-daily-digest` (06:05 UTC).
5. Verify the god-admin page shows all 9 rows with seeded recipient.
6. Owner sign-off → merge stacked on PR #79.

---

## 7. Success criteria

- ✅ Migration 089 applies cleanly; 2 tables + 2 indexes + 9 seed rows.
- ✅ `npm test` green on Windows (unit tests for send.ts + dedup.ts + recipients.ts + at least 3 emitter helpers).
- ✅ 35+ smoke assertions pass on live `gbox_platform` DB.
- ✅ All 9 platform alerts dedup on repeat fire within window (no inbox floods).
- ✅ The 6 merchant-audience flows fire via the existing runner; 5 deferred flows appear in catalog but never fire without the Phase 12 emit.
- ✅ Iron Rule 5 scan: zero mentions of "god admin" / "god_admin" / "/god-admin/" in any PR6 store-admin / storefront / accounts response body.
- ✅ `getMerchantVisibleTemplates()` still returns 20 new rows filtered out → 0 of the 9 platform templates appear in merchant settings API.
- ✅ Registry `implemented: true` count increases by 13 (20 total covered, 7 kept `false` with WIRED_PR6_DEFERRED comments pointing at Phase 12).

---

## 8. Open questions (locked 2026-04-22)

| # | Question | Answer |
|---|----------|--------|
| 1 | Finance alert recipient: shop owner or per-category override? | **Shop owner** (existing `shops.owner_user_id` → users.email). Per-category override deferred to Phase 15. |
| 2 | Daily digest: single email per shop or per-staff-member? | **Per shop** (one email; simpler; merchant can fan-out via inbox rules). |
| 3 | Deferred finance emails (payouts, chargebacks) — ship catalog now or wait for Phase 12? | **Ship catalog now** (flow-catalog entries + event types). Wiring emits drop-in with Phase 12. |
| 4 | `chargeback_won` — email or admin-UI only? | **Admin-UI only**. Positive news doesn't need a push; inbox noise. |
| 5 | Platform alert storage: deliveries table, reuse `email_deliveries`, or audit-only? | **Separate `platform_alert_deliveries`** for dedup. `email_delivery_id` FK for correlation. |
| 6 | God-admin UI: separate page or reuse existing god-admin email page? | **Separate `/god-admin/platform-alerts`** (existing /god-admin/email is about template catalog; alerts are about routing). |
| 7 | Integration-down signal: HOW? | **Existing push-log integration wrappers emit at >10% error rate over 5m**. Wrapper lives in `packages/core/src/modules/integrations/health.ts` (new); called from Lenful + carrier + payment wrappers. |

---

## 9. Known deferrals logged

- `chargeback_won` template → never wired (Shopify parity — admin UI only).
- Payouts / chargebacks real emitters → Phase 12 PayPal-Partner sub-phase.
- Per-category alert recipient override (finance vs system vs reviews) → Phase 15.
- Multi-channel alert routing (Slack / PagerDuty) → Phase 15+.
- Alert severity escalation ladder → Phase 15+.
- Historical digest back-fill (merchant opts in mid-month → email past 7 days) → Phase 15+.
