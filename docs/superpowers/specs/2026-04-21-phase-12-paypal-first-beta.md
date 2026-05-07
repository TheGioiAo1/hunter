# GBOX PLATFORM — PHASE 12 SPEC
## PayPal-First Beta + Sprint 0 Pre-Hardening

**Date:** 2026-04-21  
**Author:** Claude (for Thai Bui review)  
**Status:** DRAFT — awaiting owner sign-off  
**Branch:** `feat/phase-12-paypal-first-beta`  
**Related:** CLAUDE.md §Rule 1-5, docs/ops/smtp-gbox-integration.md,
docs/security/2026-04-21-paypal-legacy-secret-rotation.md

---

## 0. WHY NOW

Phase 11 closed with release gates + smoke matrix (PR #64-#65). The
platform is shippable-shaped; the beta blocker isn't code mass, it's
three compounding things:

1. **Payment gateway policy is unlocked on code but locked in plan.**
   `packages/core/src/modules/payments/paypal-partner/` has the whole
   create → capture → refund → onboarding flow. `gateway-selector.ts`
   picks PayPal first, Stripe second. Policy says "PayPal only for
   beta" but Stripe env vars are documented in `.env.example` as if
   they're still first-class, so operators will wire them up
   reflexively.
2. **Silent-break env vars.** `.env.example` documented
   `COOKIE_DOMAIN` which nothing reads. Merchant session cookies only
   land when `SESSION_COOKIE_DOMAIN` is set; customer sessions need
   `CUSTOMER_COOKIE_DOMAIN`. Without both, cross-subdomain login fails
   silently (user types correct password, lands on login page again).
3. **Scheduled cron seeds never ran.** Phase 10 PR2 added gift-card
   `send_at`, Phase 8 PR2 added abandoned-cart recovery, but neither
   seed was wired at boot. Handlers registered, rows never created,
   `executeDueJobs` never fired. Silent no-op on prod.

Sprint 0 closes these three gaps so Phase 12 can ship PayPal-first
beta in week 1 without rediscovering them in an incident.

---

## 1. LOCKED DECISIONS (2026-04-21)

Seven decisions closed with owner on 2026-04-21:

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | PayPal Partner TS port in-tree is authoritative | gbox-paypal PHP is reference only; TS has tests + tree-shaking + env isolation |
| 2 | BN code `Gbox_Ecom` hardcoded default in `config.ts` | Matches our registered Partner Attribution ID; required on every Orders v2 + Refunds v2 call |
| 3 | Twilio for SMS (Phase 14) | Cheapest reliable VN + EU + US coverage; SDK maturity > Vonage |
| 4 | Multi-region + multi-language, EN priority | English lands week 1; VN + ES + FR follow-on in Phase 13 |
| 5 | AWS S3 stays (no R2 migration) | `gbox-platform` is already fully on §4.1 role-based buckets (public/theme/private/backups); migration risk > savings |
| 6 | Beta launch: week 1 | 3-5 day Sprint 0 pre-hardening → open beta w/ PayPal-only payments |
| 7 | Go | Execute |

Ten directional pillars from the founder:

1. DTC global brand + wholesale + POD/dropship targeting VN,
   Bangladesh, emerging markets
2. AI-first (Phase 10 PR1 already lives on god-admin) > pure ops scale
3. PayPal-only for beta (this spec); second gateway deferred past beta
4. Aggressive beta week 1: 5K-10K sellers, 20K stores target
5. Email + SMS marketing as critical differentiator (Phase 14
   graduates both onto the SMTP-Gbox relay)
6. Unified customer DB — one customer row per email across all shops
   where the operator opts in (Phase 13)
7. Personal badge / PSD realtime / multi-platform integrations
   deferred
8. Marketing timeline driven by founder's calendar, not engineer's
9. Every seller-facing error routes through `safeMessage()` with
   "Please contact Gbox support" fallback (CLAUDE.md Rule 5)
10. No god-admin leaks in seller UI, emails, logs seller can read

---

## 2. SPRINT 0 — PRE-BETA HARDENING (3–5 days, in flight)

Goal: land the fixes below behind one PR, run release-check + smoke
matrix, merge to `master`, deploy to staging, staging smoke, cut beta
build.

### 2.1 CRITICAL fixes (merge-blocking)

```
┌─ .env.example: SESSION_COOKIE_DOMAIN + CUSTOMER_COOKIE_DOMAIN ──── ✓
│   Replaces the dead COOKIE_DOMAIN entry. Comment explains which
│   auth surface reads which var.
│
├─ .env.example: Stripe variables commented out + reordered ───────── ✓
│   PayPal Partner vars move to top with BETA POLICY comment.
│   gateway-selector.ts already treats empty STRIPE_SECRET_KEY as
│   "Stripe unavailable".
│
├─ scripts/deploy/deploy-production.sh: parametrize IPs ───────────── ✓
│   GBOX_SERVER{1,2,3}_{HOST,USER} env overrides. Defaults still
│   target Thai's LAN test fleet so a naked `bash ./deploy.sh` does
│   what it always did.
│
├─ apps/storefront/src/server.ts: installProcessErrorHandlers ────── ✓
│   Matches gbox-api. Uncaught exception + unhandled rejection now
│   log structured Pino events with service=gbox-storefront instead
│   of a bare stack trace into stderr.
│
├─ server.ts: seedAbandonedCartCronTasks(db) on boot ──────────────── ✓
│   Phase 8 PR2 handler was registered but the cron_tasks row was
│   never inserted. Fix: call the seed alongside campaigns seed.
│
└─ server.ts: seedGiftCardCronTasks(db) on boot ───────────────────── ✓
    New handler: `process_pending_gift_cards` runs every 5 min via
    cron/service.ts → gift-cards/email.ts#processPendingGiftCardEmails.
    Closes Phase 10 PR2 gap.
```

### 2.2 HIGH-priority docs (non-merge-blocking, but Sprint 0)

- ✓ `docs/security/2026-04-21-paypal-legacy-secret-rotation.md` —
  rotation procedure for the burned `gbox-paypal` PHP repo secret.
  Owner action required; platform side already env-var-driven.
- ✓ `docs/ops/smtp-gbox-integration.md` — explains why SMTP-Gbox is
  deployed-but-idle in beta and the Phase 14 cutover shape.
- ✓ This spec.

### 2.3 Tech debt flagged (NOT Sprint 0)

- `executeDueJobs` polling is hosted inside the Lenful cron block
  gated by `DISABLE_LENFUL_CRON !== "1"`. If a replica disables
  Lenful cron, it also silently disables campaigns + abandoned-cart
  + gift-card delivery. Decouple into its own block guarded by
  `DISABLE_MARKETING_CRON` in Phase 13.

---

## 3. PHASE 12 SCOPE — what actually ships in the beta

### 3.1 In-scope (must ship week 1)

- PayPal Partner onboarding flow end-to-end (already built; verify).
- PayPal Orders v2 create + capture + cancel + refund (already built;
  smoke on sandbox + 1 live shop before promoting).
- Per-shop `paypal_merchant_id` persisted in `shop_settings`; read by
  `gateway-selector.ts`.
- Storefront checkout uses PayPal SDK; Venmo button variant behind
  settings flag.
- Admin "Payment providers" page shows PayPal connection status and
  onboarding CTA when unset.
- Platform commission: NONE in beta. Gbox is facilitator. Money
  lands 100% in merchant PayPal. (§BETA_POLICY in
  paypal-partner/index.ts)
- Gift-card delivery cron (Sprint 0 fix, above) — scheduled sends
  actually fire.
- Abandoned-cart recovery (Sprint 0 fix, above) — `dispatch_abandoned_cart_steps`
  tick actually fires.

### 3.2 In-scope but already shipped (smoke-verify only)

- AI copywriter + campaign suggester on god-admin (Phase 10 PR1,
  2026-04-21).
- Gift cards photos / votes / profanity / settings (Phase 10 PR2-PR4).
- Multi-market + multi-currency + 37-currency catalog (Phase 9 PR3).
- US + EU shipping carriers + rate providers (Phase 9 PR1).
- US sales tax + EU VAT + VN VAT (Phase 9 PR2).
- Staff permissions + security events + alerts (Phase 9 PR4).
- Release gates + smoke matrix (Phase 11 PR1-PR2).

### 3.3 OUT-of-scope (deferred past beta)

- Stripe as alternate gateway. Second gateway decision waits until
  the top 3 complaints from beta are in hand.
- SMS marketing. Twilio decision is locked (§1 row 3) but the wiring
  is Phase 14.
- SMTP-Gbox relay on critical path. Deployed as dark service only.
- Unified customer-DB across shops. Phase 13.
- Wholesale pricing tiers. Phase 13.
- POD / dropship integrations. Phase 14+.

---

## 4. WORKFLOW MINDMAP (Iron Rule 3)

```
                    ┌───────────────────────────────────────┐
                    │   SELLER signs up via accounts.gbox.co │
                    │   (merchant auth, session cookie on   │
                    │    .gbox.co; SESSION_COOKIE_DOMAIN)    │
                    └───────────────┬───────────────────────┘
                                    │
                                    ↓
                    ┌───────────────────────────────────────┐
                    │   Onboarding wizard forces shop       │
                    │   setup → name, slug, currency,       │
                    │   market region, shipping origin.     │
                    │   GBOX_ONBOARDING_WIZARD_ENABLED=true │
                    └───────────────┬───────────────────────┘
                                    │
                                    ↓
                    ┌───────────────────────────────────────┐
                    │   "Connect payment" step:             │
                    │   - ONLY option = PayPal Partner      │
                    │   - CTA → createPartnerReferralLink() │
                    │   - PayPal hosts the onboarding UI    │
                    └───────────────┬───────────────────────┘
                                    │ (PayPal redirects back)
                                    ↓
                    ┌───────────────────────────────────────┐
                    │   processOnboardingCallback(db, code) │
                    │   → store paypal_merchant_id          │
                    │   → set paypal_connected=TRUE         │
                    │   → isMerchantReady()?                │
                    └───────────────┬───────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │ YES                 │                     │ NO
              ↓                     ↓                     ↓
  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ Shop goes LIVE.  │  │ Admin sees       │  │ Shop stays in    │
  │ Storefront shows │  │ "PayPal pending" │  │ onboarding       │
  │ PayPal button +  │  │ banner until the │  │ wizard until     │
  │ Venmo (opt-in).  │  │ webhook confirms │  │ Partner flow     │
  │                  │  │ primary_email +  │  │ completes.       │
  │                  │  │ payments_receivable │                 │
  │                  │  │ flags flip true. │  │                  │
  └─────────┬────────┘  └─────────┬────────┘  └──────────────────┘
            │                     │
            └──────────┬──────────┘
                       ↓
           ┌─────────────────────────┐
           │  Customer checkout      │
           │  (checkout.gbox.co —    │
           │   CUSTOMER_COOKIE_DOMAIN)│
           │  gateway-selector picks │
           │  PayPal; Stripe path    │
           │  returns UNAVAILABLE.   │
           └─────────┬───────────────┘
                     ↓
           ┌─────────────────────────┐
           │  createPayPalPartnerOrder│
           │  → PayPal approval UI   │
           │  → capturePayPalPartnerOrder│
           │  → money lands in       │
           │     merchant's PayPal.  │
           │  BN: Gbox_Ecom attached │
           │  to every request.      │
           └─────────┬───────────────┘
                     ↓
           ┌─────────────────────────┐
           │  Order confirmation     │
           │  email → SES direct     │
           │  (Sprint 0: SMTP_GBOX_URL│
           │   not yet wired).       │
           │  sendOrderConfirmation()│
           └─────────┬───────────────┘
                     ↓
           ┌─────────────────────────┐
           │  Cron ticks every 5 min │
           │  dispatch gift-card     │
           │  delivery; every 30 min │
           │  abandoned-cart recovery│
           │  (both seeded at boot). │
           └─────────────────────────┘
```

### 4.1 Seller-facing failure paths

Every seller-facing error goes through `safeMessage()`. Examples:

- PayPal Partner not configured (env vars empty) →
  `Please contact Gbox support.` (NOT "PAYPAL_PARTNER_CLIENT_ID is
  empty — set it in .env" — that's a god-admin leak per Rule 5).
- `gateway-selector` returns `available=[]` →
  `Payment unavailable, contact support.`
- SMTP unconfigured → order still captures successfully; email retry
  rides the `email_send` BullMQ queue.
- Onboarding callback returns error → dashboard banner says
  `PayPal connection failed — please try again` and the god-admin
  sees the actual error in `platform_logs`.

---

## 5. PR PLAN

Sprint 0 (this week):

1. `feat/sprint-0-pre-beta-hardening` (one PR, one merge)
   - All 6 CRITICAL fixes above
   - 3 doc files
   - Touches: `.env.example`, `server.ts`, `apps/storefront/src/server.ts`,
     `scripts/deploy/deploy-production.sh`,
     `packages/core/src/modules/cron/service.ts`,
     `packages/core/src/modules/gift-cards/cron.ts` (new)
   - Tests to add:
     - Unit: seed function idempotency (covers abandoned-cart +
       gift-card)
     - Unit: gateway-selector returns PayPal when Stripe env empty
       (already covered by existing tests — verify)
   - Run: `scripts/ops/release-check.ts`, `scripts/ops/smoke-matrix.ts`
   - Merge criterion: both release-check + smoke-matrix green

Phase 12 PR1+ (post-Sprint 0, during beta):

2. `feat/phase-12-pr1-paypal-live-smoke` — sandbox → single live shop
   end-to-end; add a smoke script `scripts/smoke-phase12-pr1.ts` that
   mints an order + captures + refunds against a test PayPal Partner
   merchant.
3. `feat/phase-12-pr2-onboarding-polish` — paid Partner banner,
   resume-onboarding link when merchant starts but drops off.
4. `feat/phase-12-pr3-webhook-hardening` — the webhook verify endpoint
   already exists (paypal.ts#verifyWebhook); add replay protection via
   `paypal_webhook_events.event_id` UNIQUE constraint.

---

## 6. RISK REGISTER

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
| 1 | PayPal secret rotation not done before beta opens | MEDIUM | CRITICAL | `docs/security/...-rotation.md` on owner desk today; gate beta on rotation + 24h clean logs |
| 2 | Stripe env accidentally set by an operator reading outdated .env.example | LOW | HIGH | Sprint 0 reorders .env.example; gateway-selector still correct even if someone sets Stripe, but sellers may see "Stripe offered" paths light up — we treat that as bug, not feature |
| 3 | Abandoned-cart / gift-card seeds fire too aggressively against fresh DB | LOW | MEDIUM | Seeds are idempotent + only run once; handler no-ops when SMTP not configured (short-circuits) |
| 4 | Beta sellers hit 5K-10K but SES tier is capped at 200 msg/sec | LOW | MEDIUM | Current beta email volume estimate = 500K/month = ~190 msg/hour, 0.05 msg/sec. 4 orders of magnitude of headroom. Revisit if volume 10x's overnight |
| 5 | PayPal webhook replay (same event delivered twice) | MEDIUM | LOW | `paypal_webhook_events.event_id` UNIQUE via Phase 12 PR3; until then, idempotency keys on capture + refund prevent double-actions |
| 6 | Storefront uncaught exception with no structured log | MEDIUM | MEDIUM | Sprint 0 wires installProcessErrorHandlers; PM2 captures stderr to `/var/log/pm2/gbox-storefront-error.log` which already ships to the god-admin log viewer |
| 7 | `DISABLE_LENFUL_CRON=1` on a replica silently stops marketing cron | LOW | HIGH | Flagged as tech debt §2.3; beta runs on single fleet so no replica disables Lenful cron yet |

---

## 7. ACCEPTANCE CRITERIA

Sprint 0 is done when:

- [ ] PR `feat/sprint-0-pre-beta-hardening` merged to `master`
- [ ] `scripts/ops/release-check.ts` exits 0
- [ ] `scripts/ops/smoke-matrix.ts` regression diff = 0 vs baseline
- [ ] Staging deploy via `bash ./scripts/deploy/deploy-production.sh --update`
      completes + all 7 health endpoints pass
- [ ] Owner rotates PayPal Partner secret; both curl verifications pass
- [ ] SMTP-Gbox deployed to server 1 port 4328 + health endpoint added
      to deploy script

Phase 12 beta opens when:

- [ ] All of Sprint 0 done
- [ ] Live-shop PayPal Partner onboarding completes on a real PayPal
      Business account (Thai's own account, as smoke)
- [ ] One live capture + one live refund execute against the smoke
      shop
- [ ] Sellers onboarded via invite in first 48h ≤ 20 (soft-open)
- [ ] No P1 errors in `platform_logs` for 72h post-soft-open

---

**Next action:** land PR `feat/sprint-0-pre-beta-hardening`. Tests +
release-check are the blocker, not additional code.
