# Phase 14 PR4 — Email Analytics (Open + Click Tracking)

**Status:** LOCKED (scope approved 2026-04-22 by owner).
**Branch:** `phase-14-pr4-email-analytics`
**Base:** `b7489f4` (tip of PR3).
**Depends on:** PR1 (foundation — `email_events` + `opened_at` / `clicked_at`
columns pre-created in migration 083), PR1.5 (overrides), PR2 (15 Priority 1
transactional), PR3 (automation framework + 18 Priority 2 growth).

---

## 1. Why this PR exists

Phase 14 PR1–PR3 built the **send** side of the email system: foundation,
overrides, 33 wired templates (15 transactional + 18 growth), and an
event-driven automation framework. Sellers can now send emails from
every lifecycle hook in the platform.

What they **can't** do is tell whether those emails are working. Open
rate, click-through rate, bounce rate — the feedback loop that turns
email from a fire-and-forget send into a marketing channel — doesn't
exist yet. Every `email_deliveries` row ends at `status='sent'` and
that's the last anyone hears of it.

PR4 closes the loop by adding **open tracking** (via a 1×1 pixel) and
**click tracking** (via a redirect wrapper). It does NOT include bounce
handling — that's PR4.B, a tightly-scoped follow-up dedicated to
provider webhook plumbing.

---

## 2. Scope

### 2a. In scope

| # | Feature | Delivery |
|---|---------|----------|
| 1 | **Open tracking pixel** | 1×1 transparent GIF (43 bytes, industry default) served from `/email/track/open/:token.gif` |
| 2 | **Click tracking redirect** | `<a href>` rewriting + 302 redirect through `/email/track/click/:token?u=<base64url(target)>` |
| 3 | **HMAC-signed tokens** | `tracking_token = hmac_sha256(EMAIL_TRACKING_SECRET, delivery_id).slice(0, 32)`; stored on `email_deliveries` with a UNIQUE partial index |
| 4 | **Event ingest** | Pixel / click hits write `email_events` rows (`event_type IN ('open', 'click')`) + update `email_deliveries.opened_at` / `.clicked_at` / counters |
| 5 | **Analytics aggregation** | Per-template stats (sent / opened / clicked / open-rate / CTR) and per-day volume, scoped by shop |
| 6 | **Seller dashboard** | `/admin/store/:slug/reports/email-analytics` — filter 7d / 30d / 90d, per-template drill-down, settings hub entry |
| 7 | **Iron Rule 5 compliance** | All tracking URLs are seller-safe; errors route through "Please contact Gbox support"; pixel / redirect responses leak zero internals |

### 2b. Out of scope (deferred)

| Deferred | Goes to | Why |
|----------|---------|-----|
| Bounce webhooks (SES + Gmail SMTP + Postmark DSN parsing) | **PR4.B** | Provider-specific signature verification + DMARC validation + DSN parsing + replay-attack defense + auto-suppression list — deserves its own tightly-scoped PR |
| IP salt rotation tool | **PR5** (GDPR pack) | Privacy/GDPR concern, not deliverability — theme belongs with data retention + right-to-erasure |
| Link-level CTR breakdown | PR5+ | Nice-to-have; needs `email_links` join table; analytics UI can render later without data migration |
| Apple Mail Privacy Protection mitigation | PR5+ | MPP pre-fetches all pixels regardless of open → inflates open rate. Need machine-learning / IP-range detection. Dashboard caveat in PR4 is enough for v1 |
| Per-variant / A-B email testing | Phase 15+ | Requires campaign management layer we don't have yet |

---

## 3. Design

### 3a. Token generation

```ts
// tracking.ts::generateTrackingToken
function generateTrackingToken(deliveryId: number): string {
  const secret = process.env.EMAIL_TRACKING_SECRET ?? 'gbox-dev-insecure-DO-NOT-USE'
  const mac = crypto.createHmac('sha256', secret).update(String(deliveryId)).digest('hex')
  return mac.slice(0, 32) // 32 hex chars = 128 bits, plenty for a non-secret signed pointer
}
```

The token is **deterministic** — same `deliveryId` → same token.
That's intentional: a recipient clicking the pixel or a link doesn't
need to carry session state, and we don't want to store a random token
per send (extra DB round-trip + rotation headache). The token's job is
to prove "this URL was minted by us" (defeats CSRF-via-crafted-URL),
not to be a secret.

The HMAC uses `EMAIL_TRACKING_SECRET` env var, same pattern as
`UNSUBSCRIBE_TOKEN_SECRET` from PR1. Ops sets it once; rotating it
invalidates every open/click link in in-flight emails (acceptable
— this is telemetry, not auth).

### 3b. Link rewriting

Marketing / lifecycle / reviews templates (`spec.category ∈
{'marketing', 'lifecycle', 'reviews'}`) get:
- Every `<a href="https://…">` → `<a href="https://<host>/email/track/click/<token>?u=<base64url(target)>">`
- A single pixel `<img>` appended right before `</body>` (or end of HTML if no `</body>`)

Transactional templates (`password_reset`, `order_confirmation`,
`shipping_notification`, etc.) **do NOT get rewritten**. Reasons:
1. Password reset links already have a one-time token; double-wrapping
   adds zero signal and doubles the URL length (some email clients
   truncate).
2. Order confirmation links go to a customer portal that has its own
   auth; tracking those clicks doesn't inform marketing decisions.
3. Tracking transactional "opens" has the same MPP-inflation problem
   but worse: security-sensitive recipients (password reset) are the
   ones most likely to have image-blocking on.

Pixel injection is allowed for transactional (rate of "email delivered
successfully" signal), but behind a per-shop setting with default=OFF
for this PR. PR4 ships with **tracking enabled for marketing / lifecycle
/ reviews, OFF for transactional**, and a shop setting knob.

### 3c. Route responses

| Route | Response |
|-------|----------|
| `GET /email/track/open/:token.gif` | `200 OK`, `Content-Type: image/gif`, `Cache-Control: no-store, no-cache, must-revalidate`, `Pragma: no-cache`. Body = 43-byte 1×1 transparent GIF. Even on unknown/malformed token, return the pixel — never leak validity to the client (DO return 200 to avoid broken-image icons in Outlook) |
| `GET /email/track/click/:token?u=<target>` | If token+target valid: `302 Found`, `Location: <target>`. If malformed / unsafe target: `302 Found`, `Location: /` (storefront home). Never `400/500` — recipient should never see an error page from clicking an email link |

### 3d. Iron Rule 5 guarantees

- Routes live at `/email/track/...`, not `/god-admin/...` or `/admin/...`
- Unknown template in analytics page → `"Please contact Gbox support"`
- DB errors in tracking endpoints → log server-side (pino), return success
  to client (pixel) or 302 to `/` (click). Never surface an error to the
  recipient.
- Analytics aggregations scoped by `WHERE shop_id = :current_shop` —
  never cross-shop.
- Dashboard does not reveal god_admin send counts (platform-level
  deliveries have `shop_id = NULL`; analytics filters them out).

---

## 4. Commits (8)

| # | Commit | Content |
|---|--------|---------|
| 1 | `docs(pr4): scope + deferred updates` | This file + update `phase-14-deferred.md` |
| 2 | `db(migration-086): email_deliveries.tracking_token + UNIQUE partial index` | `ALTER TABLE email_deliveries ADD COLUMN tracking_token TEXT`. Partial UNIQUE index `WHERE tracking_token IS NOT NULL` (retroactive rows stay NULL). Also add `open_count INT DEFAULT 0` + `click_count INT DEFAULT 0` for fast dashboard counters without joining `email_events` |
| 3 | `email(core): tracking.ts — HMAC sign/verify + pixel URL + link rewriter` | Pure-function module. Exports `generateTrackingToken(deliveryId)`, `buildPixelUrl(token)`, `buildClickUrl(token, target)`, `rewriteHtmlLinks(html, token, baseUrl)`, `injectPixel(html, token, baseUrl)`, `verifyTrackingToken(token, deliveryId)`. Plus unit tests (sign/verify roundtrip, rewriter idempotency, injection before `</body>`). |
| 4 | `email(send): integrate tracking into sendTemplatedEmail` | After queue row created (step 4), mint tracking token, persist to `email_deliveries.tracking_token`. If category ∈ `{'marketing', 'lifecycle', 'reviews'}`: `renderedHtml = injectPixel(rewriteHtmlLinks(renderedHtml, token, baseUrl), token, baseUrl)`. Pass rewritten HTML to transport. |
| 5 | `email(routes): GET /email/track/open/:token.gif + /email/track/click/:token` | New `apps/storefront/src/routes/email-tracking.ts`. Lookup delivery by token, write `email_events` row, update counters, return pixel / 302. Uses `X-Forwarded-For` → SHA-256 with `EMAIL_TRACKING_IP_SALT` for `ip_hash`. |
| 6 | `email(analytics): aggregation queries per-template + per-day` | `modules/email/analytics.ts` exports `getShopEmailStats(db, shopId, { since, until })`, `getShopTemplateStats(...)`, `getShopDailyVolume(...)`. Bounce-aware denominators: `delivered = sent - bounced`, `open_rate = opened / delivered`, `ctr = clicked / delivered`. |
| 7 | `admin(reports): /admin/store/:slug/reports/email-analytics page` | Seller-facing dashboard. Filter chips (7d / 30d / 90d). Overview cards (delivered, opens, clicks, unsubscribes). Per-template table sortable by open-rate / CTR. Per-day sparkline. MPP caveat banner: "Open rates may be inflated by Apple Mail Privacy Protection." Settings hub card entry. |
| 8 | `smoke(pr4): end-to-end smoke on live DB` | Seed shop + delivery → inject pixel → GET pixel → assert opened_at + event row → rewrite link → GET click URL → assert clicked_at + redirect → analytics aggregation returns expected shape. Standalone `scripts/smoke-phase14-pr4.ts`. Forces `EMAIL_TRACKING_SECRET=test-secret` + `EMAIL_TRACKING_IP_SALT=test-salt` in setup, restores in finally. |

---

## 5. Rollback

Kill-switch: `EMAIL_TRACKING_ENABLED` env var (default: `1`).

When `EMAIL_TRACKING_ENABLED=0`:
- `sendTemplatedEmail` skips pixel injection + link rewriting
- Existing tracked emails in recipient inboxes still work (tracking
  routes stay live — they just don't receive new hits)
- Analytics dashboard still renders — just shows frozen numbers

Schema rollback:
- Migration 086 is purely additive (3 new columns). Dropping the feature
  means setting `EMAIL_TRACKING_ENABLED=0` — no DDL reversal needed.
- If the column absolutely must go: `ALTER TABLE email_deliveries DROP
  COLUMN tracking_token, DROP COLUMN open_count, DROP COLUMN
  click_count`. But losing the counters is silly — leaving them as
  dead columns costs nothing.

---

## 6. PR4.B preview (next PR, tỉ mỉ)

PR4.B will add:
- `POST /email/webhook/bounce/:provider` endpoints for SES + Gmail SMTP + Postmark
- Per-provider signature verification (SES SNS signature, Gmail DSN DKIM, Postmark basic auth)
- DSN (Delivery Status Notification) parsing to classify `hard` vs `soft` vs `transient`
- Auto-suppression list: hard bounce → `email_preferences.subscribed = false` + `unsubscribed_at = now()` with `source = 'bounce_auto'`
- Replay attack defense: idempotency on `raw_payload` hash → drop duplicates
- Ops runbook: provider webhook configuration guide
- Dashboard integration: bounce-rate column + "risky recipients" drill-down

PR4 **anticipates** PR4.B by:
- Using `delivered = sent - bounced` in all aggregations from day 1
  (`bounced = 0` in PR4 era; auto-fills when PR4.B lands)
- Leaving `email_events.bounce_type` and `email_deliveries.bounced_at`
  columns as-is (migration 083 already created them)
- Not adding bounce-specific UI (would be empty in PR4; PR4.B adds)

---

## 7. Success criteria

- ✅ 20+ smoke assertions pass on live `gbox_platform` DB
- ✅ 1 real email sent via console transport with working pixel + click links
- ✅ Pixel hit registers `email_events` + bumps `open_count`
- ✅ Click hit registers `email_events` + bumps `click_count` + 302s to target
- ✅ Analytics page renders for seeded shop with non-zero numbers
- ✅ `scripts/ops/smoke-matrix.ts` baseline updated to include PR4 row
- ✅ Zero occurrences of "god admin" or "/god-admin/" in seller-facing
  tracking URLs, error messages, or dashboard strings
