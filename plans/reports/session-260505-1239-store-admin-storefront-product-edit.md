# Session 260505-1239 — store-admin + storefront + product edit Shopify-style

## Mục tiêu phiên
Refactor toàn bộ store-admin sang API mode (no Postgres), redesign các trang theo Shopify pattern, wire BE Product/Shop/Order/Customer/Shipping qua FE proxy, setup local dev cho 2 codebase storefront (Express + .NET).

## Repos chạm
- `gbox-platform` (Express + Node) — branch `master`, push 21 commits trong phiên
- `Gbox-StoreFront-V3` (ASP.NET Core .NET 8) — local dev only, chưa push

## Files dirty cuối phiên

### gbox-platform
- `apps/store-admin/src/pages/orders-list-api.ts` — button list `View` thay `Edit`
- `apps/store-admin/src/pages/products.ts` — Shopify-style product edit + media upload/remove + category full list + payload merge với existing product
- `apps/store-admin/src/server.ts` — route media-upload/media-remove + CSRF skip
- `apps/storefront/src/server.ts` — `lookupShopByHost` BE primary, Postgres fallback

### Gbox-StoreFront-V3 (chưa commit)
- `Properties/launchSettings.json` — URL local
- `appsettings.Development.json` — `Dev:OverrideDomain`
- `Services/TemplateService.cs` — inject `IConfiguration` + dev override block

## Highlights đã làm (theo URL)

### Order
- `/orders/<id>` (detail + edit): tax + shipping auto-fill theo country (codeOfName fallback name→ISO), `findShippingForCountry()` consume `listShippings` không sửa shipping client; `enrichLineItemsWithImages()` lookup Product Service vì BE order line_item KHÔNG có image
- `/orders/drafts/new`: căn giữa 1100px, table products 4-col fixed-width, ảnh sản phẩm thật từ search, dev-rates map embed (`window.__GBOX_RATES__`) → `applyRatesForCountry(c.country_code || c.country_name)` khi pick customer + recalc dynamic
- `/orders` list: button "View" trỏ `/orders/<id>` thay vì `?edit=1`
- Order test simulated qua BE: `POST /api/{shop_id}` body `{status:"Pending", line_items, shipping_address, ...}` (KHÔNG dùng `"open"`)

### Customer
- `/customers` (list): `listCustomers` + enrich `getCustomerStats` per-id qua `Promise.allSettled` (orders/amount/email-subscription)
- `/customers/new`: dropdown Country ISO (`country-data.ts` `codeOfName`), POST lưu `country_code` + `country_name`, center 780px
- `/customers/<id>`: More actions dropdown 5 mục, Delete dùng BE `DELETE /api/{shop_id}` body=`[id]` (BE chỉ có bulk)

### Product
- `/products/<id>` (API mode): redesign Shopify 2-col `1fr 320px`, max-width 1200px center
- Form fields: title, body_html, price/compare_at/cost_per_item, inventory/sku/barcode, vendor, tags, slug, seo_*, status, category_id
- Mapping → BE PUT: name, body_html, vendor, tags, published, seo_*, `variant_default.{price,old_price,base_cost,inventory,sku,barcode}`, `categories: [{id}]`
- **CRITICAL fix**: `postProductUpdate` API mode GET current product → spread vào payload trước override → tránh mất `images[]`/`variants[]`/options khi BE PUT replace
- **Upload ảnh**: `POST https://api-shop.gbox.co/api/{shop_id}/images` (BE Shop Service Images endpoint, AllowAnonymous, multipart `file=`, max 5MB, returns `{url}` S3)
- FE proxy: `postProductMediaUploadApi` (3 bước: S3 upload → GET product → PUT append images)
- Remove ảnh: index-based `postProductMediaRemoveApi` (×× button overlay trên thumbnail, splice + PUT)
- CSRF skip pattern: `\/products\/[^/]+\/(media-upload|media-remove)$`
- Category dropdown: fetch full list `GET /api/{shop_id}/category` (4 categories: Accessories/Canvas/T-shirt/Tumbler), display name, value=id

### Settings + Analytics + Reports (hasDb fallback API mode)
- `/settings/currencies`, `/settings/customer-accounts`, `/settings/email-suppressions`, `/settings/languages`, `/settings/notifications` + email template editor, `/settings/legal`, `/settings/activity`, `/settings/finance-alerts`, `/settings/preferences`
- `/online-store/preferences`, `/online-store/themes`
- `/analytics` dashboard + 6 sub-reports + 2 CSV (placeholder card "Report not available")
- `/reports/email-analytics` (KPI=0, empty chart/breakdown)
- `/analytics/live` (8 parallel query Postgres → empty fallback)
- `/analytics/traffic + funnel + attribution + cohort` (4 measurement reports)

Pattern chuẩn: `const hasDb = !!db && typeof (db as any).selectFrom === 'function'` → if hasDb try DB; else fallback empty/defaults. POST handler: hasDb early return + redirect banner "not supported in API mode".

## Storefront

### gbox-platform `apps/storefront/src/server.ts`
- Helper mới `fetchShopFromBeByHost(host)` — call `GET https://api-shop.gbox.co/api/{key}` (BE accept ObjectId / public_domain / private_domain). Subdomain ObjectId 24-hex → ObjectId match; else dùng host
- `lookupShopByHost`: BE primary (path 0), Postgres legacy fallback giữ nguyên
- Map BE Shop → ResolvedShop: id, slug=private_domain||public_domain||id, name, currency, defaultLocale=locale_name, status=active?'active':'inactive'

### Gbox-StoreFront-V3 (.NET 8 ASP.NET Core local)
- Config sẵn 10 BE service URLs trong `appsettings.json` (api-shop/api-product/api-page/api-customer/api-order/api-shipping/api-address/api-payment/api-app/api-auth)
- Edit `Properties/launchSettings.json`: `applicationUrl: https://gbox.co` → `https://localhost:7227;http://localhost:5098`
- Edit `appsettings.Development.json`: thêm `"Dev": { "OverrideDomain": "69f1c12aa356d8529ec3dbc1" }`
- Edit `Services/TemplateService.cs` constructor + `InitAsync()`: inject `IConfiguration`, khi host `localhost`/`127.0.0.1`/`[::1]` + có `Dev:OverrideDomain` → thay publicDomain bằng override → BE Shop Service lookup theo ObjectId thật
- `dotnet restore` + `dotnet run --project Gbox-StoreFront-V3.csproj` chạy thành công
- URL hoạt động: https://localhost:7227 (HTTPS) hoặc http://localhost:5098 (HTTP)
- ⚠️ Warning không fatal: MongoDB `text index required for $text query` ở Products collection (BE Mongo prod thiếu index, không ảnh hưởng render)

## BE shapes/conventions ghi nhớ
- Order line_item: `{id, short_id, product_name, variant: {name, price, old_price, base_cost, inventory}, quantity, fulfillment_quantity, total, status}` — KHÔNG CÓ image, image_url
- Order shipping_address: `{id, address_1, city, country_name, full_address, first_name, last_name, full_name, phone, email, province, zip}` — thường KHÔNG có `country_code` (chỉ `country_name="Vietnam"`) → cần `codeOfName()` fallback
- Order status enum: `Pending|Updating|Processing|Picked|Fulfillment|Cancel|Refund|Hold|Resend` (KHÔNG dùng "open")
- BE Customer DELETE: chỉ bulk `DELETE /api/{shop_id}` body=string[] ids
- BE Product images upload: `POST /api/{shop_id}/images` Shop Service (AllowAnonymous), max 5MB, jpg/png/webp → S3 bucket `gboxplatform`
- BE Product PUT replace toàn bộ — phải GET trước rồi spread

## Open follow-ups
- `/products/<id>`: rich-text editor Description (hiện textarea simple), Variants list editor, Collections multi-select, Theme template, Sales 90 days
- Storefront-V3 push lên git (3 files dirty + 1 untracked dir `wwwroot/template/shop_thegioiao123.gbox.co/`)
- BE Mongo Products thiếu text index cho `$text` query (cần seed index trên prod)
- gbox-platform/storefront: deploy code mới lên server 3 để URL `https://<shop_id>.gbox.co` resolve được

## Memory updates trong phiên
- `feedback_no_working_tree_status.md` (chat ngắn không kết thúc bằng "Working tree clean")
- `feedback_code_in_english.md` (comments + UI strings phải English)

## Cách tiếp tục phiên
1. Restart dev: `npm run dev` (gbox-platform monorepo) + `dotnet run --project Gbox-StoreFront-V3.csproj` (Storefront V3)
2. Verify ports: 4323 accounts / 4324 god-admin / 4325 store-admin / 4326 storefront / 4327 checkout / 4328 supporter / 7227 storefront-V3
3. Files dirty cần commit/push tiếp (gbox-platform 4 files + Gbox-StoreFront-V3 3 files)
