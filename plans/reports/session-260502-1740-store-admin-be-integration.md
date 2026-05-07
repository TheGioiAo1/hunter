# Session — Store-Admin BE Integration Sprint

- **Date:** 2026-05-02 (resume từ session 2026-05-01)
- **Branch:** `master` (sync với `origin/master`)
- **Apps chạy local:** 6 frontend apps (xem section 7 để restart)

---

## 1 — Quy tắc chốt trong session

### A. Bám sát BE 100%
- **KHÔNG** dùng local DB (`shop_settings`, `customers`, `orders` tables, ...)
- Tất cả config / data / state đọc + ghi qua BE microservices
- BE thiếu field/endpoint → render visual-only + log warn + báo BE team
- Pattern: `hasDb` check ở đầu handler → fallback API mode khi `!hasDb`

### B. Git workflow
- **KHÔNG** auto-commit/push — chỉ khi user yêu cầu rõ ràng
- Conventional commits, message tiếng Việt tối giản
- KHÔNG commit `.env` (chứa secrets)
- KHÔNG có AI references trong commit

### C. File / code style
- Module > 200 LOC → tách focused modules
- Kebab-case filenames (self-documenting cho LLM grep/glob)
- Surgical changes — chỉ sửa file cần thiết

---

## 2 — BE Microservices map (verified)

| Service | Base URL | Key endpoints |
|---|---|---|
| Customer | `api-customer.gbox.co` | `GET /api/{shop_id}` (Authorize), `POST /api/{shop_id}` (Anonymous), `GET /api/{shop_id}/{idOrEmail}` (Anonymous) |
| Order | `api-order.gbox.co` | `POST /api/{shop_id}` (Anonymous, Calc), `POST /insert-temp` (Anonymous, draft), `POST /list` (Authorize), `DELETE /{id}` (Authorize) |
| Subfee | `api-order.gbox.co/api/{shop_id}/subfee` | CRUD + `?country_code=` filter — dùng cho Tax FE |
| Product | `api-product.gbox.co` | `GET /api/{shop_id}?keyword=` (Anonymous), `POST /list` |
| Payment | `api-payment.gbox.co` | CRUD payment gateways per shop |
| PayPal Partner | `api.paypal.com` (live) / sandbox | OAuth, `POST /v2/customer/partner-referrals`, `GET /v1/customer/partners/{partner_id}/merchant-integrations/{merchant_id}` |

---

## 3 — Source code references đã xác minh

| Folder | Mục đích |
|---|---|
| `D:\gbox\Gbox\Gbox-{Service}\` | Source BE controllers .NET — verify endpoints + DTOs |
| `D:\gbox\gbox-paypal-master\` | WordPress PayPal plugin — credentials trong `includes/helpers.php` |
| `D:\gbox\gbox-paypal-partner-master\` | WordPress Partner plugin — onboarding flow logic |
| `packages/api-client/src/{service}/models/` | Generated TypeScript models từ Swagger — single source of truth cho field names |

---

## 4 — Files mới + sửa trong session

### Created
| File | Mô tả |
|---|---|
| `apps/store-admin/src/lib/payment-api-client.ts` | BE Payment Service wrapper |
| `apps/store-admin/src/lib/paypal-partner-api.ts` | PayPal Partner OAuth + onboarding (port từ PHP plugin) |
| `apps/store-admin/src/lib/subfee-api-client.ts` | BE Subfee wrapper + `findTaxSubfeeByRegion()` + `upsertTaxSubfee()` (Tax = Subfee mapping) |
| `apps/store-admin/src/pages/tax-region-detail.ts` | Per-region tax detail page (Vietnam, US, ...) |
| `plans/reports/be-gaps-260502-1003-payment-settings.md` | Report BE gaps cho payment-settings |

### Modified
| File | Thay đổi |
|---|---|
| `apps/store-admin/src/pages/payment-settings.ts` | Refactor toàn bộ: bỏ `shop_settings`, dùng BE Payment Service. PayPal onboard callback upsert vào BE. Banner ⚠️ shop-level fields visual-only. |
| `apps/store-admin/src/pages/abandoned-checkouts.ts` | Add `hasDb` check → empty state với banner pending BE |
| `apps/store-admin/src/pages/tax-settings.ts` | Region link đổi từ `/settings/shipping` → `/settings/taxes/regions/{code}` |
| `apps/store-admin/src/server.ts` | Routes mới: paypal/onboard-start, paypal/onboard-callback, taxes/regions/:code (GET+POST) |
| `.env` | **LOCAL-ONLY** — append PayPal Partner credentials production (NOT committed) |

### Commits đã push
```
a996e3c fix(store-admin): abandoned-checkouts empty state khi không có local DB + update BE gaps
31773f1 fix(store-admin): paypal-partner-api lazy env reads (ES module hoist issue)
c5a9f49 docs: BE gaps cho payment-settings (cần payment-policy endpoint)
5868f04 feat(store-admin): payment-settings bám sát BE + PayPal Partner onboarding
```

### Files chưa commit (sẽ commit khi user yêu cầu)
- `apps/store-admin/src/lib/subfee-api-client.ts`
- `apps/store-admin/src/pages/tax-region-detail.ts`
- `apps/store-admin/src/pages/tax-settings.ts` (link change)
- `apps/store-admin/src/server.ts` (tax-region routes)

---

## 5 — Fixes chuẩn pattern (re-use cho future)

### A. Page lỗi `db.selectFrom is not a function` (no local DB)
```ts
const hasDb = !!db && typeof (db as any).selectFrom === 'function'
if (!hasDb) {
  // Render API-mode fallback module hoặc empty state với banner
  return renderXxxApi(req, res)
}
```

### B. Form 403 CSRF
- Form cần `${csrfHiddenField(String((req as any).csrfToken || ''))}` ngay sau `<form>`
- Import: `import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'`
- Token tự attach vào `req.csrfToken` bởi global middleware

### C. ES module env hoist (PayPal partner case)
- ES module hoist `import` TRƯỚC top-level code → IIFE `dotenvConfig()` chạy quá muộn
- Fix: lazy reads `function envXxx() { return process.env.X }` thay vì const at module init
- Hoặc: chạy với `node --env-file=../../.env --import tsx --watch src/server.ts`

### D. BE field mismatch (Order, Customer, ...)
- Customer email không ở top level Order → ở `o.billing_address.email`
- Order status enum: `Pending|Updating|Processing|Picked|Fulfillment|Cancel|Refund|Hold|Resend` (KHÔNG có `draft`)
- Order CartItem: `product_name` + nested `variant: {name, price}` (KHÔNG phải `title`/`price` flat)
- Order date: `create_date` (KHÔNG phải `created_at`)
- BE `insert-temp` strip nhiều field → tính total từ `line_items[].total` ở FE

---

## 6 — BE Gaps đã document (cho team BE bổ sung)

File: `plans/reports/be-gaps-260502-1003-payment-settings.md`

### HIGH priority
1. `GET/PUT /api/{shop_id}/payment-policy` — capture method, refund policy, gift card expiration
2. `GET /api/{shop_id}/abandoned-checkouts` — abandoned checkout sessions cho recovery
3. `GET/PUT /api/{shop_id}/tax-region/{code}` (hoặc dùng Subfee như đã wire) — per-region tax config

### MEDIUM
- `metadata: object` field vào `Payment` model — onboarding state, partner data

### LOW
- `instructions`, `payment_terms`, `webhook_secret` field vào `Payment` model

### Tax via Subfee convention (workaround)
- 1 region = 1 subfee với `name: "Tax — {region}"` + `country_codes: [code]` + `price: rate`
- Cần BE confirm `price` semantic là **percent** hay **fixed amount** khi subfee là tax

---

## 7 — Local dev setup

### Apps đang chạy (background tasks)
- `b2ns31b0c` — 5 apps khác (accounts, god-admin, storefront, checkout, supporter) qua `npm run dev`
- `b75khdz1c` — store-admin riêng với `--env-file` flag để load PayPal env

### Restart store-admin (KHI cần env vars mới)
```bash
# Trong WSL/bash
netstat -ano | grep ':4325' | grep LISTEN | awk '{print $NF}' | xargs -I {} taskkill //PID {} //F
cd apps/store-admin
node --env-file=../../.env --import tsx --watch src/server.ts
```

### Restart toàn bộ
```bash
# Kill all
taskkill //F //IM node.exe
# Restart
npm run dev   # 5 apps + store-admin (default)
```

### .env required
File `.env` ở root chứa:
- API URLs (api-auth.gbox.co, api-shop.gbox.co, ...)
- App ports (4321-4329)
- PayPal Partner credentials (production):
  ```
  PAYPAL_API_BASE=https://api.paypal.com
  PAYPAL_PARTNER_CLIENT_ID=AVtPo46E49w...
  PAYPAL_PARTNER_SECRET=EFs-dUBMMQB3...
  PAYPAL_PARTNER_ID=LNMXG2LZD6362
  PAYPAL_BN_CODE=Gbox_Ecom
  ```
- ⚠️ KHÔNG commit `.env` — local-only

---

## 8 — UI Pages đã refactor BE-only

| Route | Status | BE wiring |
|---|---|---|
| `/customers` | ✅ Done | `listCustomers` + `listOrders` (aggregate stats) |
| `/customers/:id` | ✅ Done | `getCustomerByIdOrEmail` |
| `/customers/new` (POST) | ✅ Done | `createCustomer` API mode |
| `/orders` | ✅ Done | `listOrders` (filter out draft tag) — fields fixed (billing_address, payment_status, fulfillments, create_date) |
| `/orders` Edit/Delete | ✅ Done | `deleteOrder` BE |
| `/orders/drafts` | ✅ Done | `listOrders` filter tag=draft, client-side double-check |
| `/orders/drafts/new` | ✅ Done | Product search proxy + Customer search proxy + `insertTempOrder` (full payload với CartItem schema đúng: product_name + variant.price + total) |
| `/orders/abandoned` | ⚠️ Empty state | Pending BE `/abandoned-checkouts` endpoint |
| `/discounts` | ✅ Done | DB-fail-safe try-catch (giống pattern customers) |
| `/settings/payments` | ✅ Done | BE Payment Service. PayPal Partner onboarding wired. Shop-level policies visual-only |
| `/settings/taxes` | ✅ Done | Static regions + shipping zones |
| `/settings/taxes/regions/:code` | ✅ Done | BE Subfee (tax = subfee với name marker `Tax — `) |
| `/settings/payments/paypal/onboard-start` | ✅ Done | Generate Partner referral link → 302 redirect tới PayPal |
| `/settings/payments/paypal/onboard-callback` | ✅ Done | Persist merchantId + register vào BE Payment Service |

---

## 9 — Open questions

1. BE `Payment.metadata` field — sub-resource hay JSON blob?
2. BE Subfee `price` field semantic — percent hay fixed amount khi dùng làm tax?
3. BE `payment-policy` endpoint — single endpoint hay tách (gift-card-policy, capture-policy, ...)?
4. BE Order Service — có endpoint cập nhật fulfillment không? (FE chưa check)
5. PayPal Venmo, Apple Pay activation — qua single onboarding hay tách flow?

---

## 10 — Resume hint cho session mới

Để continue:
1. **Đọc file này** + `plans/reports/session-260501-1500-frontend-deploy-store-admin-redesign.md` (session trước)
2. **Đọc** `plans/reports/be-gaps-260502-1003-payment-settings.md` để biết BE gaps
3. Verify branch sync: `git status && git pull origin master`
4. Apps chạy chưa: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4325/admin/store/69f1c12aa356d8529ec3dbc1/settings/taxes`
   - Nếu 200 → OK
   - Nếu 000 → restart theo section 7
5. **Quy tắc bắt buộc:** bám sát BE, KHÔNG dùng local DB, KHÔNG auto-commit, BE gap → report

### Patterns đã chốt (reuse cho page mới)
- API client: `apps/store-admin/src/lib/{service}-api-client.ts` — wrapper `fetchJson` + token auth
- Page module: `apps/store-admin/src/pages/{name}-api.ts` — pure render, no DB
- Empty state: card centered + icon + heading + CTA + footer link "Learn more"
- List + Detail pattern: 2-column grid, sticky save, banner ⚠️ pending BE khi cần
- CSRF: form bắt đầu với `${csrfHiddenField(String((req as any).csrfToken || ''))}`
