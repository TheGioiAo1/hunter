# Phase 14 Email — Deferred Triggers (scope-out from PR2 / PR3 / PR4 / PR4.B / PR5 / PR6)

**Status:** Living checklist. Last updated 2026-04-22 (PR6 in progress).

PR3 picks up 18 Priority 2 templates (see `phase-14-pr3-scope.md` §2)
and closes §4 below (`fulfillment_out_for_delivery`).

PR4 adds **open + click tracking** (see `phase-14-pr4-scope.md`).

PR4.B adds **bounce / complaint webhooks + suppression list** (see
`phase-14-pr4b-scope.md`).

PR5 adds **GDPR/Privacy compliance pack + soft-bounce aggregation +
IP tracking salt rotation** (see `phase-14-pr5-scope.md`). Items now
**in progress** under PR5:

- IP tracking salt rotation tool (CLI) + audit table
- Data export flow (ZIP = JSON + CSV)
- Consent audit log (append-only `consent_events`)
- GDPR email templates — `data_export_ready`,
  `account_deletion_confirmed`, `data_breach_notification`,
  `consent_renewal_request`, `privacy_policy_update`
- Soft-bounce aggregation (5 transients in 30d → hard)

PR6 adds **Priority 3 ops emails — 20 templates (14 wired + 6 deferred to Phase 12 payments)**
(see `phase-14-pr6-scope.md`). Items wired in PR6:

- 6 merchant-audience finance templates: `first_time_customer_order`,
  `payment_failed_merchant`, `refund_issued_merchant`,
  `out_of_stock_alert`, `high_risk_order`, `daily_sales_digest`
- 8 god_admin-audience platform templates: `new_merchant_signup`,
  `platform_incident_alert`, `platform_daily_digest`,
  `platform_churn_alert`, `platform_fraud_review`,
  `platform_policy_violation`, `platform_integration_down`,
  `platform_weekly_roundup`
- `@gbox/core/modules/platform-alerts` send pipeline + 9 typed emitters
- `/god-admin/platform-alerts` recipient/dedup ledger admin page
- `/settings/finance-alerts` merchant toggle panel

PR6 still defers to **Phase 12 (payments)**:

- **`payout_scheduled`** — merchant. Fires when a Stripe Connect /
  bank payout is scheduled. Wire when the Stripe payout scheduler cron
  ships in Phase 12. Variables: `payout_id`, `amount`, `currency`,
  `arrival_date`.
- **`payout_completed`** — merchant. Fires when funds land in the
  seller's bank. Wire from Stripe `payout.paid` webhook handler in
  Phase 12.
- **`payout_failed`** — merchant. Fires on Stripe `payout.failed`.
  Include `reason` (bank-rejected / ACH-returned). Seller-safe copy
  only (Iron rule 5).
- **`chargeback_opened`** — merchant. Fires from
  Stripe `charge.dispute.created` webhook. Variables: `chargeback_id`,
  `order_id`, `amount`, `currency`, `reason`, `due_by` (response deadline).
- **`chargeback_lost`** — merchant. Fires when
  `charge.dispute.closed` arrives with `status=lost`. Funds pulled from
  merchant balance. Pair with a "What happens next" help link.

Each of the 5 deferred templates already has:

- ✅ Flow-catalog entry in `packages/core/src/modules/automations/flow-catalog.ts`
  (so the merchant `/settings/finance-alerts` page shows a "Coming with
  payouts" row)
- ✅ Registry seed in `scripts/seed-email-registry.ts` with
  `implemented: false`
- ⬜ Emit site (none — no Stripe Connect substrate in Phase 14)
- ⬜ Smoke assertion (Phase 12 smoke must assert each template fires
  from its respective webhook/cron handler)

PR5 still defers to future phases:

- **Admin UI for IP salt rotation** (button in privacy-requests page):
  deferred to Phase 15 — CLI is enough for ops; UI needs god-admin-only
  role check + grace handling for in-flight tokens.
- **Rectification auto-apply**: deferred to Phase 15. PR5 ships
  rectification as manual admin workflow.
- **CCPA "Do Not Sell" flag**: deferred to Phase 15 — requires pixel
  integrations (Meta/TikTok/Google) which Gbox doesn't have today.
- **Link-level CTR breakdown**, **Apple Mail Privacy Protection
  mitigation**: deferred to Phase 15+ (analytics refinement).
- **SendGrid / Mailgun native format parsers**: deferred to Phase 15+ —
  PR4.B's generic HMAC endpoint covers them via a translation layer;
  native parsers are an optimization, not a gap.
- **Gmail SMTP return-path IMAP scraping**: deferred to Phase 15+ — no
  webhook path for Gmail SMTP; need to scrape `postmaster@` returns.
- **Per-category suppression** (hard-bounce marketing only vs global):
  deferred to Phase 15+ (Shopify ships global-only).
- **Global platform-wide suppression** (shared across tenants):
  deferred to Phase 15+ (multi-tenant privacy concern).
- **Encrypted-at-rest `consent_events.metadata`**: deferred to Phase
  15+ (metadata is non-PII by design + runtime guard).
- **Multi-region export storage**: deferred to Phase 15+ (requires
  multi-region S3 layout).
- **Automatic consent expiry + renewal cron**: deferred to Phase 15+
  (`consent_renewal_request` template scaffold lands in PR5, the cron
  that picks candidates doesn't).

Everything still listed in the "Open" sections below is explicitly out
of scope for Phase 14 and remains scaffold-only until its owning
feature phase ships.

**Context**

Phase 14 PR2 wired 15 Priority 1 customer/merchant-facing emails. The templates
below are **already seeded** in `email_template_registry` (via
`scripts/seed-email-registry.ts`) and appear in `/admin/store/:slug/settings/
email-templates`, but they are **NOT triggered from real feature code** — they
are scaffold-only.

**Why this doc exists**

The owner flagged that when the related feature phase lands, the email MUST
be wired as part of acceptance criteria — no scaffold left behind. This doc
is the checklist. Every time we close a phase listed below, grep for the
template key and verify at least one non-test, non-scaffold call to
`sendTemplatedEmail({ templateKey: '<key>', … })` exists.

---

## 1. `order_paid` — Deferred until deferred-capture payments

- **Priority in registry:** 2 (transactional, customer)
- **Wire when:** Phase 12 (PayPal Partner) or any future PR introduces
  **authorize-then-capture** payment flow (currently MVP is immediate-capture).
- **Trigger point:** payment-capture success handler (post-webhook
  confirmation that the auth was converted to a capture).
- **Proposed file:** `packages/core/src/modules/payments/capture.ts`
  (create if doesn't exist) or wherever the existing payment flow keeps
  its post-capture hook.
- **Variables to pass:** `order_number`, `customer_name`, `amount_captured`,
  `currency`.
- **Acceptance:**
  - [ ] Call `sendTemplatedEmail` after capture confirmed
  - [ ] Idempotency key = `capture:{orderId}:{captureId}` (prevent dup on
        webhook retry)
  - [ ] Smoke test asserts delivery row with `templateKey='order_paid'`,
        `status='sent'`

## 2. `magic_link_login` — Deferred until passwordless auth UX ships

- **Priority in registry:** 2 (transactional, customer)
- **Wire when:** passwordless login flow reaches MVP polish. Relevant paths
  already exist under `apps/storefront/src/middleware/account-routes.ts` and
  `apps/store-admin/src/pages/customer-accounts-settings.ts` but the UX
  isn't complete.
- **Trigger point:** `POST /accounts/login/magic-link` (or the storefront
  equivalent) — where a one-time login URL is minted.
- **Variables:** `user_name`, `login_url`, `expires_minutes`.
- **Acceptance:**
  - [ ] Link token is 1-hour TTL, single-use, hashed in DB
  - [ ] IP rate-limit 5/min (same as other auth endpoints per Iron rule 1)
  - [ ] Email sent via `sendTemplatedEmail`, logged to `email_deliveries`

## 3. `fulfillment_ready_for_pickup` — Deferred until BOPIS / local pickup

- **Priority in registry:** 2 (transactional, customer)
- **Wire when:** Store offers buy-online-pickup-in-store (BOPIS). Requires
  a `fulfillment_type = 'pickup'` column on `fulfillments` and a
  pickup-ready UI action in the admin order detail.
- **Trigger point:** admin "Mark ready for pickup" button on fulfillment.
- **Variables:** `order_number`, `customer_name`, `pickup_location_name`,
  `pickup_hours`, `pickup_instructions`.

## 4. `fulfillment_out_for_delivery` — SCHEDULED FOR PR3

- **Status:** will close in Phase 14 PR3 (branch
  `phase-14-pr3-priority2-growth-and-automations`). PR3 adds
  `out_for_delivery` to the tracking-sync normaliser and wires the
  template via the new automation framework on event
  `fulfillment.out_for_delivery`. Move to the "Closed" section below
  when PR3 merges.
- **Priority in registry:** 2 (transactional, customer)

## 5. `fulfillment_failed` — Deferred until carrier webhook granularity

- Same dependency as #4. Fires on `delivery_failed` / `returned_to_sender`
  carrier events. Merchant needs to action (re-ship, contact customer).

## 6. `return_requested` — Deferred until RMA system

- **Priority in registry:** 2 (transactional, customer)
- **Wire when:** dedicated Returns/RMA phase ships — needs schema
  (`return_requests` table), admin workflow, storefront return portal.
- **Trigger point:** `POST /storefront/returns/request` (customer-initiated)
  or admin "Create return request" action.

## 7. `return_approved` — Deferred until RMA system

- Fires when seller approves a return. MUST include shipping label URL +
  return instructions. Same dependency as #6.

## 8. `return_declined` — Deferred until RMA system

- Fires when seller declines. MUST include a seller-safe reason (not the
  internal decline code). Iron rule 5 applies — no god-admin leak in the
  reason string.

## 9. `return_received` — Deferred until RMA system

- Fires when warehouse scans the returned shipment. Signals refund is
  processing next.

## 10. `order_edited` — Deferred until Edit Order feature

- **Priority in registry:** 2 (transactional, customer)
- **Wire when:** admin "Edit order" flow is productionized (line-item swap,
  address change post-payment). Low-urgency — Shopify parity but low volume.
- **Trigger point:** after `orders/service.ts::editOrder` commits changes.

## 11. `order_invoice_sent` — Deferred until invoice reminder cron

- **Priority in registry:** 2 (transactional, customer)
- **Wire when:** we build a reminder cron that re-pings unpaid draft
  orders (e.g. 24h after `draft_order_invoice` goes unanswered).
- **Trigger point:** `packages/core/src/modules/marketing/invoice-reminder-
  cron.ts` (to be created).
- **Pair with:** `draft_order_invoice` (already wired in PR2).

---

## How to close a line item

1. Wire the template via `sendTemplatedEmail({ templateKey, … })` in the
   feature handler.
2. Add an assertion to the relevant phase smoke script that expects a row
   in `email_deliveries` with the template_key.
3. Flip `implemented: true` on the spec in `packages/core/src/modules/
   email/registry.ts` (currently still uses the `scaffold()` helper which
   sets `implemented: false`).
4. Remove the inline `// DEFERRED_PR2` TODO comment above the spec.
5. Re-run `node --import tsx scripts/seed-email-registry.ts` so the DB
   row's `implemented` flag reflects the catalog change.
6. Strike the entry from this doc (or move to a "Closed" section below).

---

## Closed (wired in later PRs)

_Nothing yet — this section fills as PRs close items._
