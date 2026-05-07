# PHẦN 4 — Architectural Hardening Plan

**Date:** 2026-04-08
**Status:** In progress
**Owner:** Thai Bui
**Reference prototype:** Shopify (admin.shopify.com, shopify.dev/docs/api)

---

## Goal

Harden Gbox Platform across four axes before scaling merchant onboarding:

1. **Architectural decisions** that are painful to add later (multi-currency, metafields, idempotency, event sourcing, shop context).
2. **Security red flags** that Shopify learned the hard way (rate limits on hot paths, HMAC webhooks, token scoping, dynamic CORS, safe SQL, file validation, XSS).
3. **Performance bottlenecks** that only surface at scale (N+1 queries, Redis connectivity, cart recompute, image caching, pre-aggregated metrics).
4. **Principles documentation** — hard-won product/psychological lessons distilled into `PRINCIPLES.md`.

Everything here is additive. No existing table is dropped; existing routes keep working unchanged.

---

## 4.1 Architectural Decisions

Each of these is a "do it once, do it right" decision. Adding multi-currency to a single-currency DB later means touching every price column in every table and every invoice ever generated. We front-load the cost now.

### 4.1.1 Multi-currency (Shopify Markets pattern)

**Shopify pattern:** every monetary value has two forms — `shop_money` (in the shop's base currency) and `presentment_money` (in the buyer's currency). Orders store both plus an `exchange_rate` snapshot.

**Changes:**
- New table `currency_rates(base_currency, quote_currency, rate, effective_at)` — store ECB / fixer.io / manual rates.
- New columns on `orders`: `presentment_currency`, `exchange_rate` (numeric 18,10).
- Service `packages/core/src/modules/currency/` with `getRate(base, quote, at?)` and `convert(amount, base, quote)`.

**Why now:** Adding `presentment_currency` after orders exist means every historical order is implicitly "same as shop currency" — this is *fine* as a default, but the column must exist from day one so new orders carry it.

### 4.1.2 Metafields & Metaobjects

**Shopify pattern:** any resource (product/order/customer/shop) can have arbitrary key-value extensions via metafields, without schema migrations. Merchants rely on this for SEO, custom fields, B2B data, subscriptions.

**Changes:**
- New table `metafields(id, shop_id, owner_type, owner_id, namespace, key, value, value_type, created_at, updated_at)`.
- Composite unique index `(shop_id, owner_type, owner_id, namespace, key)`.
- Module `packages/core/src/modules/metafields/` with `get/set/delete/list` scoped by owner.
- REST contract: `GET /api/2026-04/products/:id/metafields`.

**Why now:** Every app/extension the merchant installs wants metafields. If we don't ship this, merchants will hack it into `shop_settings` or `product.description` and the data model will rot.

### 4.1.3 Idempotency keys (Stripe/Shopify pattern)

**Shopify pattern:** POST endpoints accept `Idempotency-Key` header; the same key + payload hash returns the cached response instead of double-charging.

**Changes:**
- New table `idempotency_keys(key, shop_id, request_hash, status_code, response_body, created_at, expires_at)` with PK `(key, shop_id)`.
- Middleware `packages/core/src/modules/idempotency/middleware.ts` — Redis-first (SET NX PX), DB-fallback for persistence.
- Applied to: checkout, payment capture, refund, fulfillment create.

**Why now:** Mobile networks drop POSTs all the time. Without this, every checkout retry creates a duplicate order. This is the #1 reason Stripe/Shopify support tickets say "I was charged twice".

### 4.1.4 Event sourcing for orders

**Shopify pattern:** order has an immutable `events` stream (`order_placed`, `payment_authorized`, `fulfillment_created`, `refund_issued`). The current row state is derived; the audit trail is always accurate.

**Changes:**
- New table `order_events(id, shop_id, order_id, event_type, actor_type, actor_id, data jsonb, created_at)`.
- Emitter `packages/core/src/modules/events/orderEvents.ts` — single entry point that writes event AND updates order row in the same transaction.
- Existing order mutation sites gradually migrate to emit events.

**Why now:** Disputes ("my customer says they never got the order") are impossible to resolve without an immutable timeline. Shopify's Order Timeline UI is the single most-used customer support tool.

### 4.1.5 Shop context middleware

**Shopify pattern:** every request carries an implicit `shop` derived from domain/subdomain/token, and `shop_id` is automatically scoped into every query.

**Changes:**
- Middleware `packages/core/src/modules/shops/context.ts` — resolves shop from (in order):
  1. `X-Shop-Domain` header (server-side calls)
  2. `Host` header → `shop_domains` lookup
  3. API token → `api_tokens.shop_id`
- Attaches `req.shop` and `req.shopId`. Downstream handlers never need to read `req.query.shop_id` again.

**Why now:** Manual `shop_id` threading is how multi-tenant leaks happen. One forgotten `WHERE shop_id=?` exposes another merchant's data.

---

## 4.2 Security Red Flags

### 4.2.1 Rate limit checkout endpoints

Current `rate_limits` table only covers auth. Checkout/payment endpoints are unthrottled → trivial card-tester abuse.
- Add limits: `POST /checkout` (10/min/IP + 30/min/shop), `POST /payments/capture` (20/min/shop).

### 4.2.2 Webhook HMAC audit

All outgoing webhooks must sign `X-Gbox-Hmac-SHA256: base64(hmac_sha256(secret, body))`. All incoming partner webhooks (Stripe, PayPal) must verify signature BEFORE parsing body. Audit every webhook site.

### 4.2.3 API token scoping middleware

Current `api_tokens` has a `scopes` column but no enforcement. Add `requireScope('write_products')` middleware; compare `token.scopes` JSON array on every request.

### 4.2.4 Dynamic CORS per shop domain

Hard-coded allow-list won't work once merchants bring custom domains. Middleware reads `Origin`, checks `shop_domains.verified = true`, echoes back exact origin.

### 4.2.5 Safe ORDER BY helper

Query strings like `?sort=price` currently interpolate into `ORDER BY`. Add `safeOrderBy(input, allowedColumns)` that returns a Kysely `.orderBy()` expression only if input is in the allow-list.

### 4.2.6 Magic bytes file upload validation

Content-Type is client-controlled. Validate real file type by reading the first bytes (`ffd8ff` = jpeg, `89504e47` = png, `47494638` = gif, `25504446` = pdf). Reject everything else.

### 4.2.7 XSS sanitization for reviews

`product_reviews.content` is user-submitted and rendered on storefront. Run through DOMPurify (server-side via `isomorphic-dompurify`) before storing. Strip `<script>`, `on*=`, `javascript:` URLs.

---

## 4.3 Performance Bottlenecks

### 4.3.1 Product listing JSON aggregation

Currently `GET /products` does 1 query for products + 1 per-product for variants + 1 per-product for images = N+1. Replace with a single query using `jsonb_agg`:

```sql
SELECT p.*,
  COALESCE(jsonb_agg(DISTINCT v.*) FILTER (WHERE v.id IS NOT NULL), '[]') as variants,
  COALESCE(jsonb_agg(DISTINCT i.*) FILTER (WHERE i.id IS NOT NULL), '[]') as images
FROM products p
LEFT JOIN product_variants v ON v.product_id = p.id
LEFT JOIN product_images i ON i.product_id = p.id
WHERE p.shop_id = $1
GROUP BY p.id
```

### 4.3.2 Redis on server 2 & 3

Server 2's API reports `redis: not_connected` because REDIS_URL is unset. Set `REDIS_URL=redis://:GboxRedis2026@192.168.1.13:6379/0` in `.env` on servers 2/3 and restart PM2.

### 4.3.3 Cart incremental calculation

Current cart recomputes totals from all line items on every mutation. At scale with 50-line carts, this is wasted CPU. Store running totals in `carts` row and adjust by delta on each line item change.

### 4.3.4 Image URL helper + cache headers

Product images currently served directly from DB path. Add helper `imageUrl(file, {width, format})` that emits CDN-friendly URLs (eventually Cloudflare Images). Add `Cache-Control: public, max-age=31536000, immutable` for hashed assets.

### 4.3.5 Pre-aggregated daily metrics

Dashboard queries `SELECT sum(total_price) FROM orders WHERE shop_id=? AND created_at > now() - '30d'` on every page load. Add `daily_metrics(shop_id, date, orders_count, revenue, visitors)` populated by a cron at 00:05 UTC.

---

## 4.4 PRINCIPLES.md

Distill non-obvious lessons:

- **Never trust the client for money.** All prices come from DB, not from cart JSON.
- **Treat idempotency as a user experience feature, not a bug fix.**
- **Every merchant email is a potential typo.** Magic-link + OTP instead of punishing them for it.
- **The bounce rate on "password strength meter" is higher than on "6-digit code".**
- **When a merchant asks "how do I do X", the answer is metafields 70% of the time.**
- **Search is a feature, not a query.** Plan for trigram/pg_vector from day one.
- **The refund flow is more important than the checkout flow.** Customers who get refunded smoothly come back.

---

## Execution Order

1. Migration 006 (`006_phase4_foundations.ts`) — all new tables + new columns.
2. Update `schema/tables.ts` — register new types in `Database`.
3. Core modules (4.1.1 → 4.1.5) — foundational, no routes yet.
4. Security modules (4.2.1 → 4.2.7) — wire into existing routes.
5. Performance work (4.3.1 → 4.3.5).
6. `PRINCIPLES.md`.
7. Deploy migration 006 on server 1 DB.
8. Verify E2E through Nginx on 192.168.1.13.
9. Commit + push to both remotes.

---

## Non-goals (explicitly deferred)

- Full storefront rewrite with presentment_money — columns exist, wiring later.
- Real-time event stream via WebSocket — polling is fine for Phase 4.
- Cloudflare Images integration — helper exists, actual CDN wiring is Phase 5.
- Automatic FX rate updater — manual `currency_rates` seed for now.
