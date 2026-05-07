# Phase 14 PR4.B — Bounce & Complaint Webhooks + Suppression List

**Status:** LOCKED (scope approved 2026-04-22 by owner, autonomous
continuation under prior directive).
**Branch:** `phase-14-pr4b-bounce-webhooks`
**Base:** tip of `phase-14-pr4-email-analytics` (PR #77 stacked).
**Depends on:** PR1 (foundation — `email_deliveries` + `email_events`
pre-wired with `bounce_type` / `'complaint'` / `'skipped_suppressed'`
already in their respective CHECK constraints), PR4 (analytics —
`getEmailSummary.bounceRate` now reads a real signal instead of 0).

---

## 1. Why this PR exists

PR4 closed the positive feedback loop (opens + clicks). The negative
feedback loop — bounces, complaints, spam reports — is still missing.
Right now:

- A send to a non-existent mailbox goes out, comes back as an SMTP
  bounce, and dies silently in the transport's DSN handler.
- A recipient who marks the email as spam in Gmail → complaint fires
  off via SES/SNS → we have nowhere to receive it.
- The next scheduled send to that dead address **goes out again**.
- PR4's `bounceRate` KPI stays at 0% until somebody manually marks
  `email_deliveries.bounced_at`.

That's a deliverability disaster. Modern email providers measure the
health of a sender by their bounce + complaint rate: once SES sees you
bouncing above 5% or complaining above 0.1%, they throttle you. Once
Gmail sees the same, your messages start landing in Spam.

PR4.B adds the **receiver side**: webhook endpoints that accept
bounce/complaint events from the transport provider, classify them,
persist them as `email_events` rows, and — most importantly — write to
a new `email_suppressions` table that `send()` consults *before* every
outbound message. A hard-bounced address is never retried. A complainer
is never emailed again.

The bounce-rate KPI from PR4 then lights up on its own.

---

## 2. Scope

### 2a. In scope

| # | Feature | Delivery |
|---|---------|----------|
| 1 | **SES/SNS webhook endpoint** | `POST /webhooks/email/ses` — accepts SNS `SubscriptionConfirmation`, `Notification` (Bounce/Complaint/Delivery), `UnsubscribeConfirmation` |
| 2 | **Generic HMAC webhook endpoint** | `POST /webhooks/email/generic` — accepts any provider shaped like SES via shared-secret HMAC (Resend, Postmark, home-grown SMTP DSN parsers) |
| 3 | **SNS X.509 signature verification** | Full cert-fetch + RSA-SHA1/SHA256 verify + SSRF-safe cert host allowlist; injectable `CertFetcher` so smoke tests can mock the fetch |
| 4 | **Bounce classifier** | SES `Bounce.bounceType` / `bounceSubType` → `hard` / `soft` / `transient`; maps to `email_events.bounce_type` column |
| 5 | **Suppression list** | New `email_suppressions` table (shop-scoped + platform partition); `checkSuppressed()` + `addSuppression()` + `listSuppressions()` + `unsuppress()` |
| 6 | **Raw audit table** | New `ses_webhook_events` table — stores every SNS delivery (even unmatched) with raw JSON + idempotency key (`sns_message_id` UNIQUE) |
| 7 | **Pre-send suppression gate** | `send.ts` checks suppressions before transport call; failed check → `status='skipped_suppressed'`, no transport invocation |
| 8 | **Admin suppression management** | `/admin/store/:slug/settings/email-suppressions` — paginated list, manual unsuppress, CSV export, notes field |
| 9 | **Iron Rule 5 compliance** | Webhook responses are seller-opaque; admin page uses `safeMessage()` on every error path; zero "god admin" leakage |
| 10 | **Idempotency + replay defense** | SNS `Message-Id` UNIQUE; duplicate deliveries are no-ops with 200 |

### 2b. Out of scope (deferred)

| Deferred | Goes to | Why |
|----------|---------|-----|
| **Soft-bounce aggregation** (5 transients in 30d → treat as hard) | PR5 | Needs a sliding-window job + policy config; not a security gap — just an optimization |
| **SendGrid / Mailgun native format parsers** | PR5+ | Generic HMAC endpoint already covers them (they can POST SES-shaped JSON with a translation layer); native format matters when we actually choose one as primary |
| **DMARC-based return-path parsing for Gmail SMTP** | PR5+ | No webhook path for Gmail SMTP — requires IMAP mailbox scraping of `postmaster@` returns. Non-trivial; ship provider-backed webhooks first |
| **Per-category suppression** (hard-bounce only marketing, not transactional) | Phase 15+ | Legal/compliance: recipient complaints usually apply to all categories. Shopify ships global-only. Defer until merchants ask |
| **Supplier-initiated warmup ramp** | Phase 15+ | Belongs with full deliverability tooling — bounce reputation + warmup + IP rotation |
| **Global platform-wide suppression** (shared across shops) | Phase 15+ | Multi-tenant privacy concern — shopA shouldn't know shopB has a bounce from `user@example.com`. Per-shop isolation from day 1 |

---

## 3. Design

### 3a. Schema (migration 087)

Two new tables + zero changes to existing columns (all necessary status
values + event types were already in CHECK constraints from PR1).

```sql
-- Raw webhook audit (written before matching, for forensics)
CREATE TABLE ses_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  sns_message_id TEXT NOT NULL UNIQUE,          -- idempotency key
  sns_topic_arn TEXT,
  event_type TEXT NOT NULL,                     -- 'Bounce' | 'Complaint' | 'Delivery' | 'SubscriptionConfirmation' | ...
  bounce_type TEXT,                             -- 'Permanent' | 'Transient' | 'Undetermined' (from SES)
  bounce_subtype TEXT,                          -- 'General' | 'NoEmail' | 'Suppressed' | ...
  ses_message_id TEXT,                          -- SES mail.messageId (matches email_deliveries.smtp_message_id)
  matched_delivery_id BIGINT NULL REFERENCES email_deliveries(id) ON DELETE SET NULL,
  matched_shop_id UUID NULL REFERENCES shops(id) ON DELETE SET NULL,
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload JSONB NOT NULL,
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  source_ip TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processing_error TEXT
);

-- Suppression list (checked before every send)
CREATE TABLE email_suppressions (
  id BIGSERIAL PRIMARY KEY,
  shop_id UUID NULL REFERENCES shops(id) ON DELETE CASCADE,
  email_address_hash CHAR(64) NOT NULL,        -- sha256(lower(email))
  email_address_lower TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce','complaint','manual')),
  bounce_type TEXT,
  bounce_subtype TEXT,
  source_transport TEXT NOT NULL,              -- 'ses' | 'gmail_smtp' | 'smtp_gbox' | 'resend' | 'manual' | 'webhook_generic' | 'other'
  source_event_id BIGINT NULL REFERENCES ses_webhook_events(id) ON DELETE SET NULL,
  source_delivery_id BIGINT NULL REFERENCES email_deliveries(id) ON DELETE SET NULL,
  raw_diagnostic_code TEXT,
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unsuppressed_at TIMESTAMPTZ,
  unsuppressed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active-suppression UNIQUE (per-shop) — allows re-suppression after unsuppress
CREATE UNIQUE INDEX idx_email_suppressions_active_shop
  ON email_suppressions(shop_id, email_address_hash)
  WHERE unsuppressed_at IS NULL AND shop_id IS NOT NULL;

-- Active-suppression UNIQUE (platform partition, shop_id NULL)
CREATE UNIQUE INDEX idx_email_suppressions_active_platform
  ON email_suppressions(email_address_hash)
  WHERE unsuppressed_at IS NULL AND shop_id IS NULL;

CREATE INDEX idx_email_suppressions_shop_created
  ON email_suppressions(shop_id, suppressed_at DESC);

CREATE INDEX idx_ses_webhook_events_received ON ses_webhook_events(received_at DESC);
CREATE INDEX idx_ses_webhook_events_matched
  ON ses_webhook_events(matched_shop_id, received_at DESC)
  WHERE matched_shop_id IS NOT NULL;
```

### 3b. SNS X.509 signature verification

SNS signs every message with an RSA key whose X.509 certificate is
fetched from `SigningCertURL`. The string-to-sign is a canonical form
of the payload. To verify:

1. **SSRF defense**: reject `SigningCertURL` if the host isn't under
   `sns.{region}.amazonaws.com` or `sns.amazonaws.com`. Use a
   hard-coded suffix allowlist — **no DNS lookup**, no following
   redirects, HTTPS-only.
2. **Cert cache**: memoize cert PEM by URL. Certs rotate rarely; don't
   hit AWS on every notification.
3. **Canonical string**: concat specific fields in a specific order,
   separated by `\n`, trailing `\n` required. Fields differ for
   `Notification` vs `SubscriptionConfirmation` — implement both.
4. **Verify**: `crypto.createVerify('RSA-SHA256').update(canonical)
   .verify(pubKey, Buffer.from(Signature, 'base64'))`. Support
   `SignatureVersion: '1'` (RSA-SHA1, legacy) and `'2'` (RSA-SHA256,
   default since 2022).

Injectable `CertFetcher` interface so smoke tests don't hit AWS:

```ts
interface CertFetcher {
  fetchCert(url: string): Promise<string> // PEM
}
```

Production fetcher uses `node:https` with a 3-second timeout, no
redirects, and an explicit `servername` for SNI. Test fetcher returns
an in-memory cert that the test itself signs with.

### 3c. Generic HMAC webhook

For non-SES providers (Resend, Postmark, future additions), the
`/webhooks/email/generic` endpoint accepts a JSON body of the same
shape as SES's `Notification.Message`, authenticated with HMAC-SHA256
via the existing `verifySignature()` helper in
`packages/core/src/modules/webhooks/hmac.ts`.

Shared secret rotation uses the existing
`getShopWebhookSecretBundle()` which returns `{ current, previous,
rotatedAt, graceRemainingMs }` — reuse this verbatim; no PR4.B-specific
secret mgmt.

Header: `x-gbox-hmac-sha256` (existing `HMAC_HEADER` constant).

### 3d. Bounce classifier

```ts
// bounce-classifier.ts
export type ClassifiedBounce =
  | { kind: 'hard'; reason: 'hard_bounce'; suppress: true }
  | { kind: 'soft'; reason: null; suppress: false }
  | { kind: 'complaint'; reason: 'complaint'; suppress: true }
  | { kind: 'delivery'; reason: null; suppress: false } // just informational
  | { kind: 'unknown'; reason: null; suppress: false }

export function classifySesEvent(notification: SnsNotificationMessage): ClassifiedBounce
```

Mapping rules (SES → Gbox):

| SES `bounceType`     | SES `bounceSubType`            | Gbox classification |
|----------------------|--------------------------------|---------------------|
| `Permanent`          | any                            | `hard`              |
| `Transient`          | `General` / `MailboxFull` / `MessageTooLarge` / `ContentRejected` | `soft` (no suppress) |
| `Transient`          | `AttachmentRejected`           | `soft`              |
| `Undetermined`       | any                            | `soft` (conservative) |
| Complaint (any type) | —                              | `complaint`         |

### 3e. Pre-send suppression gate

In `send.ts`, right after `canSend()` (which handles prefs +
unsubscribes), before transport dispatch:

```ts
const suppression = await checkSuppressed(db, { shopId, email: input.to })
if (suppression) {
  // short-circuit: mark skipped_suppressed, record delivery row, return
  await logSkipped(db, { ...dryRun, reason: 'skipped_suppressed',
    extra: { suppressionId: suppression.id, suppressionReason: suppression.reason } })
  return { ok: false, deliveryId: null, reason: 'skipped_suppressed' }
}
```

Note: we DO write a delivery row with `status='skipped_suppressed'` so
the analytics dashboard can show "X sends blocked this week" as a
positive signal.

### 3f. Webhook handler flow

```
POST /webhooks/email/ses
  │
  ├─ 1. Parse SNS envelope (SubscriptionConfirmation | Notification)
  ├─ 2. Verify X.509 signature (CertFetcher, cached)
  │     └─ fail → 403, audit row with signature_verified=false
  ├─ 3. Handle SubscriptionConfirmation → HTTP GET SubscribeURL → 200
  ├─ 4. Dedup: SELECT 1 FROM ses_webhook_events WHERE sns_message_id = $1
  │     └─ exists → 200 (idempotent replay)
  ├─ 5. Insert ses_webhook_events row (raw audit, matched_delivery_id=NULL)
  ├─ 6. Parse SES message body (JSON inside Notification.Message)
  ├─ 7. classifySesEvent() → { kind, suppress }
  ├─ 8. Match delivery: SELECT id, shop_id FROM email_deliveries
  │     WHERE smtp_message_id = ses.mail.messageId
  ├─ 9. Update ses_webhook_events SET matched_delivery_id, matched_shop_id
  ├─ 10. For each bouncedRecipient:
  │       a. Insert email_events (event_type='bounce'|'complaint', bounce_type)
  │       b. If suppress=true: INSERT email_suppressions (ON CONFLICT DO NOTHING)
  │       c. UPDATE email_deliveries SET bounced_at = now() (if hard bounce)
  ├─ 11. Update ses_webhook_events SET processed_at
  └─ 12. Return 200 (empty body — don't leak internals)
```

### 3g. Admin page

`/admin/store/:slug/settings/email-suppressions`:

- Paginated list (50/page) of active suppressions for this shop
- Columns: email, reason, bounce subtype, suppressed_at, source
- Actions: unsuppress (soft-removes — keeps the row, sets
  `unsuppressed_at` + `unsuppressed_by`), delete notes
- Top-level stats: total active, hard bounces 30d, complaints 30d
- Export CSV (server-generated, stream)
- Entry point: Settings hub card + sidebar (under "Emails" submenu) +
  command palette (`nav-email-suppressions`, keywords: bounce, block,
  unsuppress, deliverability)

Iron Rule 5: no mention of "god admin", "platform admin", or
`/god-admin/*`. All error paths → "Please contact Gbox support."

---

## 4. File structure

### 4a. New files

```
docs/email-system/
  phase-14-pr4b-scope.md                          # this file

packages/db/src/migrations/
  087_email_suppressions.ts                       # migration

packages/core/src/modules/email/
  webhook-verify.ts                               # SNS X.509 + HMAC helpers
  bounce-classifier.ts                            # SES payload → classification
  suppression.ts                                  # CRUD + check
  webhook-handler.ts                              # orchestrator

packages/core/test/
  email-webhook-verify.test.ts
  email-bounce-classifier.test.ts
  email-suppression.test.ts
  email-webhook-handler.test.ts

apps/storefront/src/routes/webhooks/
  email-ses.ts                                    # POST /webhooks/email/ses
  email-generic.ts                                # POST /webhooks/email/generic

apps/store-admin/src/pages/
  email-suppressions.ts                           # admin page

scripts/
  smoke-phase14-pr4b.ts                           # end-to-end live-DB smoke
```

### 4b. Modified files

```
packages/db/src/migrations/run.ts                 # register 087
packages/core/src/modules/email/send.ts           # pre-send suppression gate
packages/core/src/modules/email/index.ts          # re-export suppression + webhook-handler
apps/storefront/src/server.ts                     # mount /webhooks/email/*
apps/store-admin/src/server.ts                    # mount /settings/email-suppressions
apps/store-admin/src/pages/settings.ts            # hub card
apps/store-admin/src/layouts/seller-layout.ts     # sidebar + palette
scripts/ops/smoke-baseline.json                   # smoke-phase14-pr4b entry
```

---

## 5. Env vars

| Name | Purpose | Default (dev) |
|------|---------|---------------|
| `EMAIL_WEBHOOK_SES_ENABLED` | Master kill switch for SES webhook | `1` |
| `EMAIL_WEBHOOK_GENERIC_SECRET` | HMAC shared secret for generic endpoint | unset → endpoint returns 503 |
| `EMAIL_WEBHOOK_SNS_CERT_HOST_ALLOWLIST` | Comma-sep cert-host suffixes | `.amazonaws.com` |
| `EMAIL_WEBHOOK_SKIP_SNS_VERIFY` | Bypass SNS cert verify (TESTS ONLY) | unset → full verify |

`EMAIL_WEBHOOK_SKIP_SNS_VERIFY` is a testing escape hatch. In
production, `resolveCertFetcher()` ignores it. Smoke tests set it to
`1` and use the in-memory test fetcher instead.

---

## 6. Rollout

1. Ship migration 087 on dev → verify both tables + 5 indexes created.
2. Smoke test on server 2 (local Windows can't reach PG) → 25+ asserts.
3. Merge PR4 first (dependency), then PR4.B.
4. Configure SNS topic subscription in AWS console → point at
   `https://gbox.co/webhooks/email/ses`. SES auto-confirms subscription.
5. Send one test email via SES to `bounce@simulator.amazonses.com` →
   observe bounce row in `ses_webhook_events` + `email_events` +
   `email_suppressions`.
6. Verify PR4's analytics dashboard now shows nonzero bounce rate.

---

## 7. Success criteria

- ✅ Migration 087 applies cleanly; two tables + five indexes created
- ✅ All commits pass `npm test` on Windows (vitest symlink guard respected)
- ✅ 25+ smoke assertions pass on live `gbox_platform` DB (server 2)
- ✅ SNS signature verification rejects tampered payloads
- ✅ Hard bounce → suppression → next send short-circuits with
  `status='skipped_suppressed'`
- ✅ Admin page shows ≥ 1 suppression end-to-end after a simulated bounce
- ✅ Iron Rule 5 scan: zero matches for "god admin" / "god_admin" /
  "/god-admin/" in webhook responses or admin page HTML

---

## 8. Known deferrals logged

- Soft-bounce aggregation → PR5
- SendGrid / Mailgun native parsers → PR5+
- Gmail SMTP return-path IMAP scraping → PR5+
- Per-category suppression → Phase 15+
- Global platform-wide suppression → Phase 15+
