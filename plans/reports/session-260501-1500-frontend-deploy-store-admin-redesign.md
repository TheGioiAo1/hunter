# Session — Frontend Deploy + Store Admin Redesign

- **Date:** 2026-05-01 (10:38 → 15:00)
- **Branch:** `master` (synced với `origin/master`)
- **Apps chạy local:** 6 frontend apps qua `npm run dev` (background task `b2ns31b0c`)

---

## 1 — Local deploy setup

### Quyết định
- Bỏ Docker (slow trên máy này, overkill cho FE dev)
- Dùng `npm run dev` trực tiếp với `tsx watch` cho hot reload
- Apps connect qua remote APIs đã cấu hình trong `.env` (`api-auth.gbox.co`, `api-shop.gbox.co`, ...)
- DB/Redis: skip local (apps gracefully degrade)

### Ports đang chạy
| App | URL |
|---|---|
| accounts | http://localhost:4323 |
| god-admin | http://localhost:4324 |
| store-admin | http://localhost:4325 |
| storefront | http://localhost:4326 |
| checkout | http://localhost:4327 |
| supporter | http://localhost:4328 |

### Sự cố đã xử lý
- `.git` folder mất trong session → restore qua `git init -b master` + `git fetch` + `git reset --mixed origin/master` (working tree clean, no data loss)

---

## 2 — Code changes (3 commits đã push)

### `7dc52bb` fix(store-admin): sidebar parent items navigate instead of toggle-only
- File: `apps/store-admin/src/layouts/seller-layout.ts` line 1346-1361
- Bug: Click vào "Products"/"Customers" parent chỉ toggle dropdown, không navigate (vì `e.preventDefault()` luôn chạy)
- Fix: Chỉ preventDefault khi đang ở chính page đó (toggle), còn lại navigate bình thường

### `87e2799` feat(store-admin): redesign Add Product form (Shopify-style layout)
- Tách form khỏi `pages/products.ts` inline → module mới `pages/product-new-form.ts` (~330 LOC)
- Layout 2 cột (1fr + 320px): Title/Description/Media/Category/Price/Inventory/Shipping/Variants/SEO + Status/Publishing/Organization/Theme template
- Style scoped `.pn` dùng `--s-*` system tokens (auto sync dark/light theme)
- POST handler không đổi — giữ nguyên field names

### `476b91d` feat(store-admin): redesign Gift Cards (empty state, create form, product form)
- `pages/gift-cards.ts`:
  - Empty state Shopify-style (icon teal, 2 CTA buttons, Terms link)
  - `getCreateGiftCard` redesign: 2 cột (Gift card details + Customer/Notes), auto-gen 16-char code, expiry pill toggle
  - `getCreateGiftCardProduct` (mới): handler cho Add gift card product
  - DB-fail-safe: list page wrap query trong try-catch riêng, treat fail như empty
- `pages/gift-card-product-form.ts` (mới, ~280 LOC):
  - Layout đầy đủ với Denominations USD ($), SEO listing với live counter, URL handle preview
- `server.ts`: thêm 2 routes mới
  - `GET /admin/store/:slug/products/gift-cards/new` → `getCreateGiftCard`
  - `GET /admin/store/:slug/products/gift-cards/product/new` → `getCreateGiftCardProduct`

---

## 3 — Audit Add Product Form (BE alignment)

### BE contract
- `POST /api/{shop_id}` body = `Product` model
- Source: `packages/api-client/src/product/models/Product.ts` (generated từ Swagger)

### Wired đúng (9 fields)
`title→name`, `body_html`, `vendor`, `tags(CSV→array)`, `status→published(bool)`, `price`, `compare_at_price`, `sku`, `inventory_quantity` (4 cuối nest vào `variant_default`)

### Decorative (FE submit, handler/BE drop) — cần xử lý
| FE field | Vấn đề |
|---|---|
| `product_type` | Handler không forward khi POST sang BE remote |
| `category` | Cần map sang `categories[{id}]` array — cần fetch list ID |
| `weight` | Thuộc `variant_default.weight`, handler chưa map |
| `inventory_tracked` | Field không tồn tại trong BE Product model |
| `physical_product` | Field không tồn tại trong BE |
| `theme_template` | Cần map sang `template` |
| `gift_card_template` (form GC product) | Field không tồn tại trong BE |
| `seo_title`, `seo_description` (form GC product) | BE support nhưng handler chưa forward |
| `denominations[]` | Cần build `variants[]` array (BE support multi-variant), handler hiện chỉ lấy first |
| `handle/slug` | FE expose ở GC product form, handler không nhận |

### Recommend tiers
- **A** (5 min, zero risk): đánh dấu `data-be-status="dropped"` + HTML comment cho field decorative
- **B** (30 min): wire `weight`, `template`, `slug`, `seo_title`, `seo_description` vào handler
- **C** (2h): category picker (fetch list) + variant/denomination builder

→ User chưa chốt mức → **TODO follow-up**

---

## 4 — Quy tắc đã chốt

- **Bám sát BE:** mỗi field FE mới phải verify với BE trước (Swagger / `packages/api-client/src/*/models` / `D:\gbox\Gbox\Gbox-{Service}\` source / `packages/core/modules/*/service.ts`)
- Field BE chưa support → đánh dấu rõ trong code (HTML comment), KHÔNG submit silently
- Commit/push: chỉ khi user yêu cầu rõ ràng

---

## 5 — Files đã sửa/tạo (full list)

**Modified:**
- `apps/store-admin/src/layouts/seller-layout.ts`
- `apps/store-admin/src/pages/products.ts`
- `apps/store-admin/src/pages/gift-cards.ts`
- `apps/store-admin/src/server.ts`

**Created:**
- `apps/store-admin/src/pages/product-new-form.ts`
- `apps/store-admin/src/pages/gift-card-product-form.ts`

**Removed (giữa session, không persist):**
- `Dockerfile`, `docker-compose.yml`, `.dockerignore` (đã thử Docker rồi switch sang npm run dev)

---

## 6 — Open questions / next steps

1. Audit & wire BE alignment cho Add Product / Add Gift Card Product (chọn tier A/B/C)
2. Build form tiếp theo? User đã hint "tôi sẽ gửi tiếp" cho các màn hình mới
3. Audit form Create Gift Card (single instance) — chưa làm
4. Multi-variant POST handler để wire `denominations[]` thực sự
5. Category picker component (cần fetch list từ BE)

---

## 7 — Resume hint

Lần sau resume:
- Apps có thể đã stop khi máy restart → chạy lại `npm run dev` ở `D:\gboxfontend\gbox-platform`
- Branch `master` đã sync với origin (476b91d), pull mới nhất trước khi continue
- File này tóm tắt full state, không mất context khi mở session mới
