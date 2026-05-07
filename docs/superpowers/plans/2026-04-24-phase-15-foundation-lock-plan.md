# Phase 15 — Foundation Lock (5 Risks Fix) — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-04-24-gbox-vs-shopify-deployment-readiness.md` v3
**Ngày:** 2026-04-24
**Branch base:** `fix/smoke-phase14-p0-followup` (will branch per PR)
**Target duration:** 6 tuần (may compress with parallel PRs)
**Author:** Claude (delegated by owner Thai Bui)

---

## Scope & Ordering Rationale

Phase 15 hardens the 5 data-integrity + security risks called out in the spec Part 8. Based on audit (`Agent` Explore report 2026-04-24):

| # | Risk | Current State | Ordering Reason |
|---|------|---------------|-----------------|
| 1 | Transaction isolation on checkout | MISSING — no explicit isolation level in `createOrder` | Highest impact on race conditions; small change; do first |
| 2 | Webhook idempotency (PayPal/Stripe) | PARTIAL — SES has UNIQUE, payments don't | Prevent duplicate charges; foundation for Phase 16 |
| 3 | Automated backup health | EXISTS (script + cron doc) — no smoke probe | Small polish; add before RLS so we can test restore |
| 4 | PostgreSQL RLS | MISSING entirely | Big migration — needs careful ordering; last |
| 5 | Customer 2FA | MISSING (staff exists) | Independent track; can run parallel |

Plus:
- Per-shop API keys (P1 for app ecosystem) — DEFER to Phase 16 Track F (overlaps with gateway credentials)
- Pen-test prep — DEFER to Phase 19 (final polish)

## PR Breakdown

### PR1 — Transaction Isolation SERIALIZABLE on Checkout (3 ngày)

**Branch:** `phase-15/pr1-tx-isolation`

**Goal:** Wrap checkout critical section (payment authorize + inventory deduct + order insert) in SERIALIZABLE transaction so oversell / double-charge cannot occur under concurrent load.

**Changes:**
1. Locate `createOrder` entry point: `packages/core/src/modules/orders/service.ts`
2. Identify inventory deduction call site (likely in `packages/core/src/modules/inventory/*.ts`)
3. Wrap the composite "reserve inventory → capture payment → insert order" operation in a single transaction with `ISOLATION LEVEL SERIALIZABLE`
4. Handle serialization failures (`40001` SQLSTATE) with retry-with-backoff (3 attempts, 100ms/300ms/900ms jitter)
5. Add unit test: two concurrent `createOrder` calls on same inventory with stock=1 → one succeeds, one fails cleanly (no oversell)
6. Add smoke test: `scripts/smoke-phase15-pr1.ts` — live DB round-trip

**Files touched:**
- `packages/core/src/modules/orders/service.ts` (wrap in transaction)
- `packages/core/src/modules/orders/__tests__/createOrder-concurrency.test.ts` (NEW)
- `scripts/smoke-phase15-pr1.ts` (NEW)

**Risk:** SERIALIZABLE adds rollback on conflict — retry logic must be correct.
**Smoke:** +5 tests.

---

### PR2 — Payment Webhook Idempotency (4 ngày)

**Branch:** `phase-15/pr2-webhook-idempotency`

**Goal:** Add idempotency guarantee for PayPal + Stripe inbound webhooks. Duplicate events (same `event_id` / `webhook_id`) must be safely no-ops.

**Migration 090:** `payment_webhook_events`
```sql
CREATE TABLE payment_webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  gateway       TEXT NOT NULL CHECK (gateway IN ('paypal','stripe','airwallex')),
  event_id      TEXT NOT NULL,        -- gateway's own unique id
  event_type    TEXT NOT NULL,
  shop_id       UUID,                 -- may be NULL for platform-level events
  raw_payload   JSONB NOT NULL,
  signature     TEXT,
  processed_at  TIMESTAMPTZ DEFAULT NOW(),
  result        TEXT NOT NULL CHECK (result IN ('ok','error','ignored')),
  error_reason  TEXT,
  UNIQUE (gateway, event_id)
);
CREATE INDEX idx_pwe_shop_processed ON payment_webhook_events (shop_id, processed_at DESC);
```

**Handler pattern:**
```typescript
// pseudocode
async function handleWebhook(gateway, req) {
  const eventId = extractEventId(gateway, req);
  const inserted = await db.insertInto('payment_webhook_events')
    .values({ gateway, event_id: eventId, event_type, raw_payload, signature, result: 'ignored' })
    .onConflict((oc) => oc.columns(['gateway', 'event_id']).doNothing())
    .executeTakeFirst();

  if (!inserted) return { status: 'duplicate' }; // dedup — idempotent no-op

  try {
    await processEvent(gateway, req);
    await db.updateTable('payment_webhook_events').set({ result: 'ok' }).where('id', '=', inserted.id).execute();
  } catch (err) {
    await db.updateTable('payment_webhook_events').set({ result: 'error', error_reason: err.message }).where('id', '=', inserted.id).execute();
    throw err;
  }
}
```

**Files touched:**
- `packages/db/src/migrations/090_payment_webhook_events.ts` (NEW)
- `packages/db/src/migrations/run.ts` (import + array)
- `packages/core/src/modules/webhooks/idempotency.ts` (NEW — shared helper)
- `packages/core/src/modules/payments/paypal.ts` (apply dedup)
- `packages/core/src/modules/payments/stripe.ts` (apply dedup)
- `packages/core/src/modules/payments/__tests__/webhook-idempotency.test.ts` (NEW)
- `scripts/smoke-phase15-pr2.ts` (NEW)

**Risk:** Missed event_id extraction for some event types — audit all handlers.
**Smoke:** +12 tests (6 paypal + 6 stripe).

---

### PR3 — Backup Health Smoke Probe + Runbook Polish (2 ngày)

**Branch:** `phase-15/pr3-backup-smoke`

**Goal:** Add smoke test for backup freshness + publish restore runbook. Ensures ops can prove backups actually ran.

**Changes:**
1. New script `scripts/smoke-phase15-pr3.ts` — uses existing `summariseBackups()` helper to assert at least 1 backup < 26h old
2. Extend `scripts/ops/smoke-all.ts` to include this probe
3. Write `docs/ops/backup-restore-runbook.md` — step-by-step restore from R2 backup
4. Add `npm run backup:verify` script in root package.json (runs the smoke)

**Files touched:**
- `scripts/smoke-phase15-pr3.ts` (NEW)
- `scripts/ops/smoke-all.ts` (extend)
- `docs/ops/backup-restore-runbook.md` (NEW)
- `package.json` (add `backup:verify` script)

**Risk:** Low — existing helpers robust.
**Smoke:** +3 tests.

---

### PR4 — PostgreSQL Row-Level Security Policies (1-2 tuần)

**Branch:** `phase-15/pr4-rls-policies`

**Goal:** Enable RLS on all shop-scoped tables with `FORCE ROW LEVEL SECURITY`. Middleware sets `app.current_shop_id` GUC on each connection checkout. Defense-in-depth against application-layer bugs.

**Migration 091:** `rls_shop_scoped_tables`
```sql
-- For each shop-scoped table (orders, products, customers, collections, domains,
-- email_deliveries, webhooks, etc.):
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;

CREATE POLICY <table>_shop_isolation ON <table>
  USING (shop_id = current_setting('app.current_shop_id', true)::uuid)
  WITH CHECK (shop_id = current_setting('app.current_shop_id', true)::uuid);

-- God admin bypass (level 0 / 1):
CREATE POLICY <table>_god_admin_bypass ON <table>
  FOR ALL
  TO god_admin_role
  USING (true)
  WITH CHECK (true);
```

**Steps:**
1. Enumerate all shop-scoped tables by scanning migrations for `shop_id UUID` columns
2. Group by migration batch to keep migration file manageable (may split into 091a/091b)
3. Add middleware in `apps/store-admin/server/*` + `apps/storefront/server/*` + `apps/platform-api/*` that runs `SET LOCAL app.current_shop_id = $shop_id` at start of each request's transaction
4. Create `god_admin_role` PostgreSQL role; grant to app DB user only when god admin session authenticates
5. Test matrix: merchant user querying peer shop → 0 rows; god admin → sees all
6. Migration includes safety switch: feature flag `RLS_ENABLED` (default false) → can disable at runtime if breakage

**Files touched:**
- `packages/db/src/migrations/091_rls_shop_scoped_tables.ts` (NEW)
- `packages/db/src/migrations/run.ts`
- `packages/core/src/modules/db/rls.ts` (NEW — middleware helper)
- `apps/store-admin/server/middleware/shop-context.ts` (extend to SET LOCAL)
- `apps/storefront/server/middleware/shop-context.ts`
- `packages/core/src/modules/db/__tests__/rls-isolation.test.ts` (NEW — critical test)
- `scripts/smoke-phase15-pr4.ts` (NEW)

**Risk:** HIGH. RLS can silently break queries if `shop_id` isn't set. Mitigation: feature flag + staging soak test + ordered rollout per table.
**Smoke:** +25 tests (cross-shop isolation + god admin bypass).

---

### PR5 — Customer 2FA (TOTP + Email OTP Fallback) (1 tuần)

**Branch:** `phase-15/pr5-customer-2fa`

**Goal:** Customers enroll TOTP authenticator (Google Authenticator / 1Password / Authy). Email OTP fallback. Backup codes. Matches staff UX.

**Migration 092:** `customer_2fa`
```sql
CREATE TABLE customer_2fa (
  customer_id       UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  totp_secret_enc   BYTEA NOT NULL,    -- AES-256-GCM via oauth-token-crypto pattern
  totp_secret_iv    BYTEA NOT NULL,
  totp_secret_tag   BYTEA NOT NULL,
  backup_codes      TEXT[] NOT NULL,   -- SHA-256 hashed, consumed on use
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at      TIMESTAMPTZ,
  recovery_email    TEXT
);

ALTER TABLE customers ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customer_sessions ADD COLUMN two_fa_verified BOOLEAN NOT NULL DEFAULT false;
```

**Changes:**
1. Reuse `packages/core/src/modules/auth/two-factor.ts` (extracted common TOTP logic)
2. New enrollment flow on `/account/security/2fa` customer portal page
3. Login flow: after password success, if `totp_enabled` → challenge screen → require TOTP/email/backup code
4. Audit log rows: `customer_2fa_enrolled`, `customer_2fa_verified`, `customer_2fa_failed`

**Files touched:**
- `packages/db/src/migrations/092_customer_2fa.ts` (NEW)
- `packages/core/src/modules/auth/two-factor.ts` (refactor: extract shared, split `staff-two-factor.ts` / `customer-two-factor.ts`)
- `packages/core/src/modules/customers/service.ts` (add enrollTwoFactor / verifyTwoFactor)
- `apps/accounts/server/routes/2fa.ts` (customer-facing routes)
- `apps/accounts/views/pages/security/2fa-enroll.ejs` (UI)
- `apps/accounts/views/pages/security/2fa-challenge.ejs` (UI)
- `packages/core/src/modules/customers/__tests__/2fa.test.ts` (NEW)
- `scripts/smoke-phase15-pr5.ts` (NEW)

**Risk:** Medium — UX parity with staff flow; recovery path if lost device.
**Smoke:** +20 tests.

---

## Execution Order

```
PR1 (tx-isolation, 3d) ─────────────┐
PR2 (webhook-idem, 4d) ─────────────┼─► merge to phase-15 integration branch
PR3 (backup-smoke, 2d) ─────────────┘
                                      │
PR4 (RLS, 1-2 weeks) ─────────────────┼─► staging soak (1 week)
                                      │
PR5 (customer-2fa, 1 week) ───────────┘
```

PR1-3 parallel-able (no shared files). PR4 serial after (needs full DB knowledge). PR5 parallel with PR4 (different modules).

---

## Out of Scope (defer)

- Per-shop API keys (Phase 16 Track F — overlaps with gateway creds)
- Pen-test execution (Phase 19)
- SMS 2FA (defer — cost + VN/BD SMS gateway not wired)
- Hardware keys / WebAuthn for customers (defer — passkey scope)

---

## Success Criteria

1. All 5 PRs merged with smoke green on live DB (gbox_platform on server 2 per MEMORY smoke_test_runbook)
2. Zero regression in baseline matrix (`npm run smoke:matrix`)
3. Transaction isolation test proves oversell prevention under concurrency
4. Webhook idempotency test proves duplicate event = idempotent no-op
5. RLS test proves shop A cannot read shop B data (even via raw SQL)
6. Customer 2FA enrollment + login round-trip demonstrates on staging

---

## Commit Discipline

Every PR: single topic, smoke+unit tests, changelog entry in CLAUDE-EXTENDED.md, migration in `packages/db/src/migrations/`, migration registered in `run.ts`.
