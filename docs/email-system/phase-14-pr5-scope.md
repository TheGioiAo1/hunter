# Phase 14 PR5 — GDPR/Privacy Compliance Pack + Soft-Bounce Aggregation

**Status:** LOCKED (scope approved 2026-04-22 by owner; 5 open questions
answered; autonomous continuation of the Phase 14 thread under the
standing directive).
**Branch:** `phase-14-pr5-gdpr-privacy-pack`
**Base:** tip of `phase-14-pr4b-bounce-webhooks` (PR #78 stacked).
**Depends on:** PR1 (email foundation — `email_deliveries`,
`email_events`, `email_preferences`, `email_template_registry`), PR4
(tracking — `email_tracking_events` + `EMAIL_TRACKING_IP_SALT`), PR4.B
(suppression list — `email_suppressions`, `ses_webhook_events`, bounce
classifier → produces Transient events that this PR aggregates).

---

## 1. Why this PR exists

PR1–PR4.B shipped the email "send side" end-to-end: templates, transports,
per-customer prefs, delivery log, open/click tracking, bounces, complaints,
suppression. What's still missing is the **data subject side** — the
legal + operational tooling a Shopify-class platform needs once real
customer PII lives in the email + audit tables:

- **GDPR Art. 15 (right of access)**: a customer emails the merchant
  and asks "send me everything you have on me". No way to produce that
  dump today — customer data is scattered across `customers`, `orders`,
  `order_line_items`, `email_deliveries`, `email_tracking_events`,
  `email_suppressions`, `consent_events`...
- **GDPR Art. 17 (right to erasure / "right to be forgotten")**: a
  customer asks the merchant to delete them. We have no scheduled /
  reversible delete path. A hard `DELETE` would cascade into `orders`
  and corrupt the merchant's accounting.
- **GDPR Art. 7(1) (consent demonstrability)**: the merchant must be
  able to *prove* the customer opted into marketing. `email_preferences`
  stores the current state; there is **no append-only audit** of
  when/where/how consent was granted, withdrawn, renewed.
- **Soft-bounce aggregation**: PR4.B writes `Transient` bounces to
  `email_events` and does **not** add them to suppression. A dead
  address that returns `451 4.7.1 Temporary ... but actually permanent`
  keeps getting sends. Industry norm: 5 transients in 30 days ⇒ treat
  as hard, add to suppression. Missing → deliverability slowly rots.
- **IP salt rotation**: PR4 hashes `viewer_ip` with `EMAIL_TRACKING_IP_SALT`
  for pseudonymous analytics. Legal requires periodic rotation (to
  break long-term re-identification). No rotation path exists.
- **GDPR email templates (5)**: `data_export_ready`,
  `account_deletion_confirmed`, `data_breach_notification`,
  `consent_renewal_request`, `privacy_policy_update` — seeded by PR1 as
  scaffold-only, never triggered from real code.

PR5 closes all of this in one coherent pack. After PR5, any Gbox
merchant can answer a GDPR DSAR within the statutory 30-day window
from the admin UI, without a developer ticket.

---

## 2. Scope

### 2a. In scope

| # | Feature | Delivery |
|---|---------|----------|
| 1 | **Customer privacy request store** | New `customer_privacy_requests` table; `export` / `deletion` / `rectification` types with explicit state machine (`pending` → `processing` → `ready` / `completed` → `consumed` / `cancelled`) |
| 2 | **Data export packager** | Pure function `packageCustomerData()` → in-memory `{ json: Buffer, csv: Buffer, filename: string }`; `DataExportStorage` interface + S3 adapter reusing media pipeline bucket with `privacy-exports/` prefix; 7-day signed-URL TTL; single-use download token (SHA-256 hashed) |
| 3 | **Account deletion flow (30-day grace)** | `requestAccountDeletion()` → `scheduled_deletion_at = now + 30d`, `account_deletion_scheduled` email with cancel link; `cancelAccountDeletion()` consumes the cancel token; cron `scripts/ops/run-privacy-deletions.ts` finalizes expired requests (soft-delete: NULL `customer_id` on orders, hard-delete rows that are PII-only). Shopify pattern. |
| 4 | **Consent ledger (append-only)** | New `consent_events` table; `recordConsent()`, `listConsentEvents()`, `latestConsentFor()` — every opt-in/opt-out/renew/implicit (e.g. "you're a returning customer, we assume opt-in") writes a row. IP hashed with salt. Actor (customer self vs merchant staff) captured. |
| 5 | **Soft-bounce aggregation** | New `aggregateSoftBounces()` job: sliding window 30 days, threshold 5 `Transient` events per `(shop_id, email_address_hash)`; promotes to hard by writing `email_suppressions(reason='hard_bounce', source_transport='soft_bounce_rollup')`. Runs via `scripts/ops/run-soft-bounce-aggregation.ts` cron. |
| 6 | **IP tracking salt rotation** | New `email_tracking_salt_rotations` table (audit); `rotateTrackingSalt()` generates 32-byte hex salt, writes audit row, persists to `platform_settings.email.tracking_ip_salt`; CLI `scripts/ops/rotate-email-salt.ts` (admin UI deferred to Phase 15); 1-hour minimum between rotations (rate limit against accidental double-runs). |
| 7 | **5 GDPR email templates wired** | `data_export_ready` (variables: `customer_name`, `download_url`, `expires_at`), `account_deletion_confirmed` (`customer_name`, `scheduled_deletion_at`, `cancel_url`), `data_breach_notification` (`customer_name`, `breach_date`, `affected_data_categories`, `actions_taken`), `consent_renewal_request` (`customer_name`, `current_categories`, `renewal_link`), `privacy_policy_update` (`customer_name`, `summary_of_changes`, `effective_date`, `policy_url`). Registry flip `implemented: true`. |
| 8 | **Customer portal endpoints** | `POST /accounts/privacy/export` (authenticated customer requests their own dump); `POST /accounts/privacy/delete` (initiates 30-day deletion); `GET /accounts/privacy/download/:token` (single-use consume → 302 to S3 signed URL); `GET /accounts/privacy/cancel-deletion/:token` (consumes cancel token, back to active). Rate-limited 5/min/IP like other customer-account endpoints. |
| 9 | **Admin `/settings/privacy-requests` page** | Paginated list (50/page) of all privacy requests for the shop; filter by type + status; manual "mark ready" button for rectification (type=rectification has no automation); admin can cancel a deletion before `scheduled_deletion_at` (e.g. customer phoned in to reverse). Settings hub card + sidebar under "Customers" submenu + command palette. |
| 10 | **Iron Rule 5 compliance** | Customer portal responses are generic ("Your request has been received. We will email you when it is ready."); admin page uses `safeMessage()` on every error; zero "god admin" / `/god-admin/` leakage in HTML, emails, or toast strings. |

### 2b. Out of scope (deferred)

| Deferred | Goes to | Why |
|----------|---------|-----|
| **Admin UI for IP salt rotation** (button in `/settings/privacy-requests`) | Phase 15 | CLI is sufficient for ops; admin UI needs god-admin role check + warn dialog + grace handling for in-flight tokens. Build when self-serve needed. |
| **Rectification auto-apply** (customer edits `email`/`name` and we apply) | Phase 15 | PR5 ships rectification as "manual workflow": customer submits, merchant staff apply manually. Automation requires column-level allowlist + audit + multi-table sync. |
| **CCPA "Do Not Sell" flag** | Phase 15 | Gbox doesn't share PII with third parties today. When Phase 15 adds pixel integrations (Meta/TikTok/Google), wire the flag there. |
| **SendGrid / Mailgun native bounce parsers** | Phase 15+ | Generic HMAC endpoint from PR4.B covers them. Native parsers are an optimization. |
| **Link-level CTR + Apple MPP mitigation** | Phase 15+ | Analytics refinement, not a legal gap. |
| **Encrypted-at-rest `consent_events.metadata`** | Phase 15+ | `metadata` JSONB never contains PII (only source URL, referrer header, UA family). If we ever store raw payloads, add envelope encryption. |
| **Multi-region export storage** (EU customer → EU bucket) | Phase 15+ | Requires multi-region S3 layout, not wired today. |
| **Automatic consent expiry + renewal** (e.g. 24 months → prompt) | Phase 15+ | `consent_renewal_request` template scaffold lands in PR5 but the *cron* that picks renewal candidates is Phase 15. |

---

## 3. Design

### 3a. Schema (migration 088)

Three new tables; zero destructive changes to existing tables.

```sql
-- 3a.1  Privacy requests (GDPR Art. 15 / 17 / 16)
CREATE TABLE customer_privacy_requests (
  id BIGSERIAL PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id UUID NULL REFERENCES customers(id) ON DELETE SET NULL,
  customer_email_lower TEXT NOT NULL,             -- redundant for post-delete audit
  request_type TEXT NOT NULL CHECK (request_type IN ('export','deletion','rectification')),
  status TEXT NOT NULL CHECK (status IN ('pending','processing','ready','completed','consumed','cancelled','failed')),
  -- Export-specific
  storage_key TEXT,                               -- S3 key under `privacy-exports/<shop>/<uuid>.zip`
  download_token_hash CHAR(64),                   -- sha256(raw); raw token emailed to customer once
  download_expires_at TIMESTAMPTZ,                -- 7 days after `ready`
  download_consumed_at TIMESTAMPTZ,
  -- Deletion-specific
  scheduled_deletion_at TIMESTAMPTZ,              -- now + 30 days at `requested`
  cancel_token_hash CHAR(64),                     -- sha256(raw) for cancel link
  -- Rectification-specific
  rectification_payload JSONB,                    -- { field, old_value, new_value }
  -- Lifecycle
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  processor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,                                     -- admin notes
  last_error TEXT,                                -- on `failed`
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cpr_shop_status ON customer_privacy_requests(shop_id, status, requested_at DESC);
CREATE INDEX idx_cpr_customer ON customer_privacy_requests(customer_id, requested_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_cpr_scheduled_deletion ON customer_privacy_requests(scheduled_deletion_at) WHERE scheduled_deletion_at IS NOT NULL AND status IN ('pending','processing');

-- One active deletion per customer per shop
CREATE UNIQUE INDEX idx_cpr_unique_active_deletion
  ON customer_privacy_requests(shop_id, customer_id)
  WHERE request_type = 'deletion' AND status IN ('pending','processing');

-- 3a.2  Consent ledger (append-only Art. 7 evidence)
CREATE TABLE consent_events (
  id BIGSERIAL PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id UUID NULL REFERENCES customers(id) ON DELETE SET NULL,
  email_address_lower TEXT NOT NULL,
  consent_type TEXT NOT NULL CHECK (consent_type IN ('marketing','transactional','analytics','all')),
  action TEXT NOT NULL CHECK (action IN ('opt_in','opt_out','renew','implicit_opt_in')),
  source TEXT NOT NULL,                           -- 'checkout' | 'account_signup' | 'preference_center' | 'import' | 'admin_action' | 'api' | 'api_bulk' | 'other'
  source_url TEXT,                                -- URL where the action was taken
  ip_hash CHAR(64),                               -- sha256(ip + EMAIL_TRACKING_IP_SALT)
  user_agent_family TEXT,                         -- 'chrome' / 'firefox' / 'safari' / 'edge' / 'other' (no version)
  actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,   -- if merchant-staff applied
  actor_role TEXT,                                -- 'customer' | 'staff' | 'system' | 'import'
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,    -- non-PII extra fields
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_consent_shop_email ON consent_events(shop_id, email_address_lower, recorded_at DESC);
CREATE INDEX idx_consent_customer ON consent_events(customer_id, recorded_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_consent_shop_type ON consent_events(shop_id, consent_type, recorded_at DESC);

-- 3a.3  IP tracking salt rotation audit
CREATE TABLE email_tracking_salt_rotations (
  id BIGSERIAL PRIMARY KEY,
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_by TEXT NOT NULL,                       -- 'cli' | 'admin:<user_id>' | 'system'
  old_salt_hash CHAR(64),                         -- sha256(old salt) — never the raw
  new_salt_hash CHAR(64) NOT NULL,                -- sha256(new salt)
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_salt_rotations_rotated_at ON email_tracking_salt_rotations(rotated_at DESC);
```

### 3b. Data export packager

```ts
// data-export-packager.ts
export interface CustomerDataBundle {
  customer: { id: string; email: string; first_name: string | null; ... }
  orders: OrderRow[]
  emailDeliveries: EmailDeliveryRow[]
  emailTrackingEvents: TrackingEventRow[]
  emailPreferences: PreferenceRow[]
  consentEvents: ConsentEventRow[]
  suppressions: SuppressionRow[]
}

export interface DataExportStorage {
  uploadExport(input: { shopId: string; requestId: number; zipBuffer: Buffer }): Promise<{ storageKey: string }>
  presignDownload(storageKey: string, ttlSeconds: number): Promise<string>
}

export async function packageCustomerData(bundle: CustomerDataBundle): Promise<{ zip: Buffer; json: Buffer; csvMap: Record<string, Buffer> }>
```

- **ZIP structure** (Shopify-style single archive, both formats):
  ```
  customer-export-<customer_id>-<timestamp>.zip
  ├── README.txt                    (explains contents + GDPR context)
  ├── customer.json                 (full bundle, nested JSON)
  ├── csv/
  │   ├── customer.csv
  │   ├── orders.csv
  │   ├── email_deliveries.csv
  │   ├── email_tracking_events.csv
  │   ├── email_preferences.csv
  │   ├── consent_events.csv
  │   └── suppressions.csv
  └── manifest.json                 (row counts + sha256 per file)
  ```
- **Dependency:** use `adm-zip` (MIT, zero-native) for the archive. Already
  in lockfile via an indirect dep; verify before adding.
- **PII handling in emails:** email addresses appear in plain text —
  the whole point is giving the customer their own data. Any
  non-customer PII (e.g. admin_user_id in `email_deliveries.created_by`)
  is replaced with `"<internal staff>"`.
- **Storage:** reuse existing S3 bucket + credentials, new prefix
  `privacy-exports/<shop_id>/<request_id>.zip`. Server-side 7-day
  lifecycle rule deletes expired exports (added by migration 088
  as a comment pointing to the AWS console action, since lifecycle
  rules live outside DB).

### 3c. Account deletion flow

```
POST /accounts/privacy/delete   (customer, authenticated)
  │
  ├─ 1. Rate-limit 5/min/IP
  ├─ 2. Insert customer_privacy_requests:
  │       type='deletion', status='pending',
  │       scheduled_deletion_at = now + 30 days,
  │       cancel_token_hash = sha256(raw_token)
  ├─ 3. sendTemplatedEmail({ templateKey: 'account_deletion_confirmed', to: customer.email,
  │        variables: { customer_name, scheduled_deletion_at, cancel_url }})
  ├─ 4. recordConsent({ action: 'opt_out', consent_type: 'all',
  │        source: 'preference_center', actor_role: 'customer' })
  └─ 5. Return 200 { status: 'scheduled', cancel_window_days: 30 }

GET /accounts/privacy/cancel-deletion/:token
  │
  ├─ 1. Look up request by sha256(:token)
  ├─ 2. Must be status='pending' AND scheduled_deletion_at > now
  ├─ 3. UPDATE status='cancelled', completed_at=now
  ├─ 4. recordConsent({ action: 'renew', consent_type: 'all', source: 'preference_center' })
  └─ 5. Render "Your account is restored." page

Cron: scripts/ops/run-privacy-deletions.ts
  │
  ├─ 1. SELECT * WHERE status='pending' AND scheduled_deletion_at <= now
  ├─ 2. For each request, in transaction:
  │       a. UPDATE customers SET email=NULL, first_name=NULL, last_name=NULL,
  │          phone=NULL, accepts_marketing=false, is_deleted=true,
  │          deleted_at=now WHERE id=:customer_id
  │       b. UPDATE orders SET customer_id=NULL WHERE customer_id=:customer_id
  │          (preserves order history for merchant accounting)
  │       c. DELETE FROM email_deliveries WHERE customer_id=:customer_id
  │          (PII-only rows)
  │       d. DELETE FROM email_tracking_events WHERE email_delivery_id IN (...)
  │       e. DELETE FROM email_preferences WHERE customer_id=:customer_id
  │       f. DELETE FROM email_suppressions WHERE shop_id=:shop_id
  │          AND email_address_lower=:email
  │       g. INSERT consent_events (action='opt_out', source='system_finalize')
  │       h. UPDATE customer_privacy_requests SET status='completed', completed_at=now
  └─ 3. Log summary; alert on failures via existing push-log
```

**Shopify parity:** orders are never deleted — merchants need them for
tax/accounting. Customer PII is null'd; the FK is released.

### 3d. Consent ledger

```ts
// consent-ledger.ts
export async function recordConsent(db, input: {
  shopId: string
  customerId: string | null
  email: string
  consentType: 'marketing' | 'transactional' | 'analytics' | 'all'
  action: 'opt_in' | 'opt_out' | 'renew' | 'implicit_opt_in'
  source: string
  sourceUrl?: string
  ip?: string            // hashed internally with EMAIL_TRACKING_IP_SALT
  userAgent?: string     // reduced to family
  actorUserId?: string
  actorRole: 'customer' | 'staff' | 'system' | 'import'
  metadata?: Record<string, unknown>  // validated: no PII keys
}): Promise<{ id: bigint; recordedAt: Date }>

export async function listConsentEvents(db, { shopId, email, limit?, cursor? })
export async function latestConsentFor(db, { shopId, email, consentType })
```

- **PII hygiene:** `metadata` is JSONB but the caller MUST NOT pass raw
  emails/names/phones. A runtime check rejects keys matching `/email|phone|address|name$/i`
  with a clear error so developers notice in smoke tests.
- **UA family reduction:** `user-agent-family.ts` strips version numbers
  and returns one of: `chrome`, `firefox`, `safari`, `edge`, `opera`,
  `samsung`, `bot`, `other`.
- **IP hashing:** uses `EMAIL_TRACKING_IP_SALT` (the same salt rotated
  by 3g). If salt is unset, store `NULL` for `ip_hash` rather than
  leaking raw IP — explicit test guards this.

### 3e. Soft-bounce aggregator

```ts
// bounce-aggregator.ts
export interface AggregationPolicy {
  windowDays: number     // 30
  threshold: number      // 5
}

export const DEFAULT_POLICY: AggregationPolicy = { windowDays: 30, threshold: 5 }

export async function aggregateSoftBounces(db, policy = DEFAULT_POLICY): Promise<{
  promoted: number
  inspectedAddresses: number
  ran_at: string
}>
```

- **Query**: `SELECT shop_id, sha256(lower(email)) as hash, count(*)
  FROM email_events WHERE event_type='bounce' AND bounce_type='soft'
  AND created_at >= now - :window GROUP BY 1,2 HAVING count(*) >= :threshold`
- **Skip** addresses already in `email_suppressions` with
  `unsuppressed_at IS NULL` (avoid double-write).
- **Idempotent**: INSERT ON CONFLICT DO NOTHING on the partial UNIQUE
  index from PR4.B.
- **Cron wrapper**: `scripts/ops/run-soft-bounce-aggregation.ts`; daily at 06:00 UTC.

### 3f. IP tracking salt rotation

```ts
// salt-rotation.ts
export async function rotateTrackingSalt(db, input: {
  actor: string              // 'cli' | `admin:${userId}`
  reason?: string
}): Promise<{ rotated_at: Date; new_salt_hash: string }>
```

- Reads current salt from `platform_settings.email.tracking_ip_salt`.
- Generates 32 bytes of crypto-random → hex-encoded.
- Writes `email_tracking_salt_rotations` row with sha256(old) and sha256(new).
- Updates `platform_settings.email.tracking_ip_salt` in the same txn.
- **Rate limit**: reject if the latest row's `rotated_at > now - 1 hour`
  (guard against accidental double-run). Override flag `--force`.
- **Side effect**: after rotation, **new** IPs hash under new salt. Old
  `ip_hash` values in `email_tracking_events` and `consent_events` no
  longer correlate — this is intentional; that's the security goal.

CLI: `scripts/ops/rotate-email-salt.ts --reason="quarterly rotation" [--force] [--json]`.

### 3g. Customer portal endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST   | `/accounts/privacy/export`                     | Request dump |
| POST   | `/accounts/privacy/delete`                     | Schedule deletion |
| GET    | `/accounts/privacy/download/:token`            | Consume download token (single-use) |
| GET    | `/accounts/privacy/cancel-deletion/:token`     | Cancel scheduled deletion |

All four require authenticated customer session (existing
`requireCustomerAuth` middleware). All four rate-limited 5/min/IP. All
four responses are terse + generic to avoid leaking which customers
exist ("If an account matches, a confirmation email has been sent"
pattern).

### 3h. Admin page

`/admin/store/:slug/settings/privacy-requests`:

- Top KPIs: pending, processing, ready (unclaimed exports), scheduled
  deletions (grace window), completed 30d, failed.
- Filter chips: type (export / deletion / rectification), status (all states).
- Table columns: customer (email), type, status, requested_at,
  scheduled_deletion_at (if deletion), download_expires_at (if export).
- Row actions:
  - Deletion + pending → "Cancel deletion" (converts back to cancelled).
  - Export + ready → "Copy download link" (reveals one-time link — only
    works if still pre-`download_consumed_at`).
  - Rectification → "Mark completed" (manual workflow).
- Entry point: hub card + sidebar ("Customers" submenu) + command palette.

Iron Rule 5: no mention of "god admin". All error toasts use
`safeMessage()` → "Please contact Gbox support."

---

## 4. File structure

### 4a. New files

```
docs/email-system/
  phase-14-pr5-scope.md                          # this file

packages/db/src/migrations/
  088_privacy_requests_and_consent.ts            # migration

packages/core/src/modules/email/
  consent-ledger.ts
  privacy-requests.ts
  data-export-packager.ts
  bounce-aggregator.ts
  salt-rotation.ts
  user-agent-family.ts

packages/core/test/
  email-consent-ledger.test.ts
  email-privacy-requests.test.ts
  email-data-export-packager.test.ts
  email-bounce-aggregator.test.ts
  email-salt-rotation.test.ts

apps/storefront/src/routes/accounts/
  privacy.ts                                     # 4 customer-portal handlers

apps/store-admin/src/pages/
  privacy-requests.ts                            # admin page

scripts/ops/
  rotate-email-salt.ts                           # CLI
  run-privacy-deletions.ts                       # cron
  run-soft-bounce-aggregation.ts                 # cron

scripts/
  smoke-phase14-pr5.ts                           # end-to-end live-DB smoke
```

### 4b. Modified files

```
packages/db/src/migrations/run.ts                 # register 088
packages/core/src/modules/email/index.ts          # re-export new modules
packages/core/src/modules/email/registry.ts       # flip implemented:true on 5 GDPR templates
scripts/seed-email-registry.ts                    # re-seed with updated implemented flags
apps/storefront/src/server.ts                     # mount /accounts/privacy/*
apps/store-admin/src/server.ts                    # mount /settings/privacy-requests
apps/store-admin/src/pages/settings.ts            # hub card
apps/store-admin/src/layouts/seller-layout.ts     # sidebar + palette
scripts/ops/smoke-baseline.json                   # smoke-phase14-pr5 entry
docs/email-system/phase-14-deferred.md            # strike PR5 items
```

---

## 5. Env vars

| Name | Purpose | Default (dev) |
|------|---------|---------------|
| `PRIVACY_EXPORT_S3_BUCKET` | Bucket for export ZIPs (reuses media bucket if unset) | unset → falls back to `MEDIA_S3_BUCKET` |
| `PRIVACY_EXPORT_S3_PREFIX` | Prefix within bucket | `privacy-exports/` |
| `PRIVACY_EXPORT_DOWNLOAD_TTL_SECONDS` | Signed-URL TTL | `604800` (7d) |
| `PRIVACY_DELETION_GRACE_DAYS` | Cancel-window for scheduled deletions | `30` |
| `SOFT_BOUNCE_WINDOW_DAYS` | Aggregation window | `30` |
| `SOFT_BOUNCE_THRESHOLD` | Transients before promote | `5` |
| `SALT_ROTATION_MIN_INTERVAL_SECONDS` | Floor between rotations | `3600` (1h) |

---

## 6. Rollout

1. Ship migration 088 on dev → verify 3 tables + 7 indexes created.
2. Verify S3 write path on dev: `scripts/ops/test-privacy-upload.ts`
   uploads a 1-byte file to `privacy-exports/` and reads back.
3. Smoke test on server 2 → 40+ asserts covering all 8 sections.
4. Merge PR5 stacked on PR4.B after owner review.
5. Configure AWS S3 lifecycle rule: delete `privacy-exports/*` after 7 days.
6. Wire the two daily crons (`run-privacy-deletions`,
   `run-soft-bounce-aggregation`) into PM2 ecosystem.

---

## 7. Success criteria

- ✅ Migration 088 applies cleanly; 3 tables + 7 indexes created.
- ✅ All commits pass `npm test` on Windows.
- ✅ 40+ smoke assertions pass on live `gbox_platform` DB.
- ✅ Customer export produces a valid ZIP that unpacks to JSON + CSV
   with matching row counts in `manifest.json`.
- ✅ Scheduled deletion finalizer nulls customer PII while preserving
   orders + order_line_items.
- ✅ Soft-bounce aggregator promotes addresses with ≥ 5 transients in
   30d to hard suppression.
- ✅ Salt rotation writes audit row + refuses back-to-back calls
   within 1 hour unless `--force`.
- ✅ 5 GDPR templates flip to `implemented: true` in registry + seed.
- ✅ Iron Rule 5 scan: zero matches for "god admin" / "god_admin" /
  "/god-admin/" in any PR5 route / page / email body.

---

## 8. Open questions (locked)

| # | Question | Answer |
|---|----------|--------|
| 1 | Data export format: JSON only, CSV only, or both? | **Shopify-style ZIP** — JSON + CSV together in one archive |
| 2 | Account-deletion grace period (days)? | **30** |
| 3 | Export ZIP storage: new bucket or reuse S3 media pipeline? | **Reuse media pipeline bucket**, new `privacy-exports/` prefix |
| 4 | Soft-bounce threshold: X transients in Y days → hard? | **5 in 30 days** |
| 5 | IP salt rotation UI: CLI only, or admin button too? | **CLI-only for PR5** (admin UI deferred to Phase 15) |

---

## 9. Known deferrals logged

- Admin UI for salt rotation → Phase 15
- Rectification auto-apply → Phase 15
- CCPA "Do Not Sell" flag → Phase 15 (needs pixel integrations first)
- SendGrid / Mailgun native parsers → Phase 15+
- Link-level CTR + Apple MPP mitigation → Phase 15+
- Encrypted-at-rest `consent_events.metadata` → Phase 15+
- Multi-region export storage → Phase 15+
- Automatic consent expiry cron → Phase 15+
