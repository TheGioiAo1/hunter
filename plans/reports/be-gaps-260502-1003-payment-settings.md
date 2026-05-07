# BE Gaps — Payment Settings

**Date:** 2026-05-02
**Page:** `/admin/store/:slug/settings/payments` (`apps/store-admin/src/pages/payment-settings.ts`)
**Source verified:** `D:\gbox\Gbox\Gbox-Payment-Service\Controllers\PaymentController.cs`
**BE model:** `packages/api-client/src/payment/models/Payment.ts`

## Summary

FE đang refactor để **không dùng local DB** (`shop_settings` table). Tất cả config payment phải đọc/ghi qua BE Payment Service (`api-payment.gbox.co`).

BE hiện có:
```typescript
Payment {
  id, shop_id, name, description,
  public_key, private_key,    // gateway credentials
  paygate,                     // 'paypal' | 'stripe' | 'manual' | ...
  active, live,
  position,
  create_date, update_date
}
```

BE supports per-gateway record (PayPal/Stripe/etc.) với credentials. **Đủ** cho gateway-level config.

## Phần BE đã đủ (FE wire được)

| FE feature | BE field | Notes |
|---|---|---|
| Gateway name | `Payment.name` | ✓ |
| Gateway description | `Payment.description` | ✓ |
| Enable/disable | `Payment.active` | ✓ |
| Live/Sandbox mode | `Payment.live` | ✓ |
| Display order | `Payment.position` | ✓ |
| PayPal Client ID / Stripe Pub Key | `Payment.public_key` | ✓ |
| PayPal Secret / Stripe Secret Key | `Payment.private_key` | ✓ |
| PayPal Merchant ID (after onboarding) | `Payment.public_key` (reuse) | ✓ — partner integration override pattern |

## Phần BE THIẾU (cần BE team bổ sung)

### 1. Shop-level payment policies
Các setting áp dụng cho TOÀN shop (không thuộc 1 gateway cụ thể):

| FE field | Mô tả | Đề xuất BE |
|---|---|---|
| `capture_method` | Khi nào capture: `automatic_checkout` / `automatic_fulfilled` / `manual` | Thêm endpoint `GET/PUT /api/{shop_id}/payment-policy` trả/nhận `{ capture_method, refund_policy, auto_capture }` |
| `refund_policy` | `full` / `partial` / `none` | (như trên) |
| `auto_capture` | bool — capture ngay khi order placed | (như trên) |
| `gift_card_expiration` | `never` / `expire` (+ ngày nếu expire) | Thêm vào `payment-policy` hoặc tách `GET/PUT /api/{shop_id}/gift-card-policy` |
| `apple_wallet_pass_template` | URL/template ID cho Apple Wallet pass | Thêm field vào `payment-policy` |
| `manual_payment_methods[]` | Custom manual methods (COD, bank transfer, ...) | Có thể reuse `Payment` với `paygate='manual'` + thêm field `instructions` (BE Payment hiện chưa có `instructions` field) |

**Đề xuất schema mới:**
```typescript
ShopPaymentPolicy {
  shop_id: string
  capture_method: 'automatic_checkout' | 'automatic_fulfilled' | 'manual'
  refund_policy: 'full' | 'partial' | 'none'
  auto_capture: boolean
  gift_card_expiration: 'never' | 'expire'
  gift_card_expire_days?: number
  apple_wallet_enabled: boolean
  apple_wallet_pass_id?: string
  update_date: string
}
```
**Routes đề xuất:**
- `GET /api/{shop_id}/payment-policy` (Authorize)
- `PUT /api/{shop_id}/payment-policy` (Authorize)

### 2. PayPal Partner Onboarding metadata

Khi seller onboarding PayPal Partner (xem `lib/paypal-partner-api.ts`), PayPal callback trả về nhiều metadata FE cần lưu:

| Field | Hiện FE save vào | BE chưa có |
|---|---|---|
| `merchantIdInPayPal` | `Payment.public_key` (paygate=paypal) | ✅ wired (reuse field) |
| `accountStatus` | shop_settings (nay phải remove) | ❌ thiếu |
| `permissionsGranted` | shop_settings | ❌ thiếu |
| `consentStatus` | shop_settings | ❌ thiếu |
| `isEmailConfirmed` | shop_settings | ❌ thiếu |
| `payments_receivable` | shop_settings | ❌ thiếu |
| `primary_email` | shop_settings | ❌ thiếu |
| `connected_at` | shop_settings | ❌ thiếu |

**Đề xuất:** Thêm field `metadata: object` (JSON blob) vào `Payment` model — flexible, dùng cho mọi gateway:
```typescript
Payment {
  ...existing fields,
  metadata?: Record<string, any>  // gateway-specific blob
}
```

Hoặc thêm endpoint riêng:
- `GET /api/{shop_id}/{payment_id}/metadata`
- `PUT /api/{shop_id}/{payment_id}/metadata`

### 3. Manual payment methods — instructions field

Hiện `Payment` model thiếu:
- `instructions` — text dài hướng dẫn customer (e.g. "Bank: VCB | Account: 123456 | Note: order_id")
- `payment_terms` — `due_on_receipt` / `net_7` / `net_15` / ...

**Đề xuất:** thêm 2 field optional vào Payment model:
```typescript
Payment {
  ...,
  instructions?: string | null
  payment_terms?: string | null
}
```

### 4. Webhook secrets (Stripe)

Stripe cần `webhook_secret` riêng (khác `private_key`). Hiện không có chỗ lưu. Đề xuất tận dụng `metadata.webhook_secret` (nếu có metadata), hoặc thêm field `webhook_secret?: string`.

## Quyết định FE tạm thời (chờ BE)

Trong khi BE chưa có các field/endpoint trên:

1. **PayPal credentials & connection state** → wire BE Payment Service ngay (BE đã đủ)
2. **Capture method, refund policy, gift card expiration** → render UI **read-only/visual-only**, hiển thị banner ⚠️ "Tạm thời chưa lưu — chờ BE bổ sung endpoint payment-policy"
3. **Apple Wallet** → giữ button "Customize" như visual-only (không POST)
4. **Manual payment** → giữ button visual-only (không POST)
5. **Onboarding metadata** → tạm chỉ lưu `merchantIdInPayPal` vào `Payment.public_key`. Phần metadata khác (account_status, permissions, ...) → log console, không persist
6. **Bỏ hoàn toàn** `shop_settings` reads/writes trong page này

## Action items cho BE team

| Priority | Task |
|---|---|
| HIGH | Thêm `GET/PUT /api/{shop_id}/payment-policy` với schema `ShopPaymentPolicy` ở trên |
| HIGH | Thêm `GET /api/{shop_id}/abandoned-checkouts` (Order Service) — page `/orders/abandoned` đang phụ thuộc 100% local DB `checkout_sessions`. Schema đề xuất: `{ data: CheckoutSession[], pagination }` với CheckoutSession có `{id, customer_id, customer_email, line_items, subtotal, state, updated_at, recovery_status, email_status, sms_status}` |
| MEDIUM | Thêm `metadata: object` field vào `Payment` model (cho onboarding state) |
| LOW | Thêm `instructions`, `payment_terms`, `webhook_secret` field vào `Payment` model |

## Liên hệ

- FE refactor pending BE → blocked đến khi `payment-policy` endpoint sẵn sàng
- Sau khi BE deliver: FE update `payment-api-client.ts` thêm `getPaymentPolicy()` / `updatePaymentPolicy()` + remove visual-only banners

## Unresolved questions

- BE team prefers single `payment-policy` endpoint, hay tách nhỏ (gift-card-policy, capture-policy, ...)?
- `metadata` JSON blob chấp nhận được, hay BE prefer typed sub-resource (`paypal-partner-state`, `stripe-webhook-config`, ...)?
- Có nên versionize policy schema để future migration?
