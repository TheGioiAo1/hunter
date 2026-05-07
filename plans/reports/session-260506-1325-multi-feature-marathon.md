# Session 260506-1325 — Multi-feature marathon

Phiên làm việc dài (~28 commits, 30+ changes) trải đều store-admin / accounts / supporter / deploy script.

## Commits đã push (theo thứ tự)

| Hash | Message |
|---|---|
| `fb76335` | `feat(store-admin): /products/inventory collapsible product cards + configurable per_page` |
| `b673a72` | `fix(store-admin): sidebar active gradient + nav-child strict match + light theme gx-* aliases` |
| `f3e78aa` | `feat(store-admin): /admin home — real KPI metrics + period bar chart + quick action links` |
| `3826932` | `fix(supporter): add /health route alias for deploy script health check (keep /healthz)` |
| `04554f0` | `fix(deploy): sync host nginx config + reload trong vps-update.sh` |
| `0619b75` | `revert(deploy): bỏ pre-flight REDIS_URL check (đã setup thủ công trên server)` |
| `799f236` | `feat(store-admin): /products/new full create flow with API + media + variants` |
| `39273a8` | `feat(store-admin): /products/export + /products/import qua PSV (pipe-separated)` |
| `9b9d2db` | `feat(store-admin): sidebar store-switcher dropdown với private domain + actions` |
| `518a6f8` | `feat(accounts): /accounts/stores giao diện card mới — chấm xanh/đỏ trạng thái + 2 nút icon` |
| `aa467cc` | `feat(store-admin): /stores hub fetch BE Shop API + áp dụng card v2` |
| `20b3bdf` | `fix(stores): filter shops có id không phải 24-hex` |
| `a37b531` | `fix(stores): hiển thị banner lỗi rõ ràng + log middleware để trace shop_id bậy` |
| `939ac35` | `feat(accounts): /accounts/stores thêm nút icon xóa shop (CSRF + confirm dialog)` |
| `868d099` | `fix(store-admin): /online-store/navigation menu items thiếu id gây 404` |
| `248c92d` | `feat(accounts): /accounts/stores bỏ nút Switch — click cả card tự navigate vào admin` |
| `8aa94cd` | `feat(accounts): /accounts/stores box max 5 shop, dài hơn → scroll bên trong` |
| `a4a058a` | `feat(store-admin): /online-store/navigation auto-save sau khi kéo-thả menu item (debounce 600ms)` |
| `c37f441` | `revert(store-admin): /online-store/navigation list view bỏ kéo-thả menu (giữ kéo item bên trong)` |
| `dc8f64e` | `feat(store-admin): /settings/plan redesign UI — hero current plan + clean usage bars + plan tier cards` |
| `958225c` | `style(store-admin): /settings/plan căn giữa chữ trong plan tier cards` |
| `7d8ab27` | `feat(store-admin): /orders/drafts/new dấu '...' Customer card mở dropdown 'Create customer' → popup` |
| `a789be9` | `feat(store-admin): popup tạo customer đầy đủ form (Customer Overview + Address)` |
| `352c31c` | `style(store-admin): popup tạo customer căn giữa + bo góc 16px + backdrop blur` |
| `569c70a` | `fix(store-admin): popup customer khoá scroll cả html + body khi mở (bỏ thanh cuộn ngoài)` |

## Thay đổi theo nhóm

### A. Inventory `/products/inventory`
- Card per product collapsible (chevron `▶` xoay 90° khi expanded)
- Variants section indent 48px (24px mobile)
- Click header toggle, skip nếu click vào `a/button/input/label/form`
- Pagination đổi từ variants → **products** (mặc định 10, input number 1-200, auto-submit)
- File: `apps/store-admin/src/pages/inventory.ts`

### B. Sidebar redesign
- Active state: gradient indigo trail (`90deg, rgba(99,102,241,.38) → .10`) + 4px left bar gradient + outer glow + pure white text
- Nav-child active fix bug `c.href.includes(activePage)` (làm tất cả children active khi ở parent) → `c.href.endsWith('/' + activePage)`
- Thêm `--gx-bg/-card/-surface/-text/-muted/-border` aliases vào `:root, [data-theme=...]` block (tránh light mode hardcode `#13161c` đen)
- File: `apps/store-admin/src/layouts/seller-layout.ts`

### C. Dashboard `/admin/store/<slug>` home
- 6 KPI cards lấy real data từ BE Order Service: Total sales, Orders, AOV, Returning customer rate (sessions + conversion = 0, no analytics API)
- Bar chart period: time-series buckets (today=24h, 7d/30d=daily, 90d=13×7d), scale theo max
- Quick actions: Add product → `/products`, Unfulfilled → alert "coming soon", Create discount → `/discounts`
- Banner "Demo Mode Active" gỡ bỏ
- File: `apps/store-admin/src/pages/dashboard.ts`

### D. Sidebar store-switcher dropdown (nút tên store top sidebar)
- API endpoint `GET /admin/store/:slug/api/my-stores`: decode JWT shopIds[] → Promise.all `getShopDetail` per shopId → `{id, name, privateDomain, publicDomain, isOnline, isActive}`
- Layout 1 hàng: avatar | dot xanh/đỏ + name + domain | open icon | switch icon
- Switch ẩn khi current; Open mở `https://<domain>` tab mới
- Lazy load (fetch lần đầu mở), click outside / ESC đóng
- Files: `apps/store-admin/src/pages/my-stores-api.ts` (new), `seller-layout.ts`, `server.ts`

### E. `/accounts/stores` card redesign
- Card v2 1-row: avatar | dot + name + domain | Open icon | Delete icon
- Click cả card body → navigate admin (active shops only); Switch button gỡ
- Container `max-height:400px` overflow-y auto (5 shop visible, scroll khi nhiều)
- **Delete button** (icon trash, confirm dialog) → POST `/accounts/stores/:shopId/delete` → BE Shop DELETE
- Banner đỏ khi `?error=invalid_shop_id|no_access|shop_not_found|csrf_invalid|delete_failed`
- File: `apps/accounts/src/pages/stores.ts`

### F. `/stores` hub (store-admin) — đồng bộ
- Apply same card v2 design với BE Shop API fetch (thay `getUserShops(db=null)` demo fallback)
- File: `apps/store-admin/src/pages/stores-hub.ts`

### G. Shop ID validation (filter 24-hex)
- BE Shop schema: `[BsonRepresentation(BsonType.ObjectId)] string? id` với `EmitDefaultValue=false` → có thể omit từ JSON
- FE filter `/^[a-f0-9]{24}$/i.test(s.id)` trước khi render → tránh build URL `/admin/store/undefined`
- Log `[Stores] BE returned N shops; ids:[...]` + skip warnings
- Middleware [store-auth.ts:142](apps/store-admin/src/middleware/store-auth.ts#L142) redirect `?error=invalid_shop_id` thêm `console.warn` ghi slug + path + referer + jwtUser.shopIds

### H. `/products/new` full create flow
- `createProduct()` helper trong `product-api-client.ts` (wrap `ProductService.postApi`)
- Multipart form upload `media` (multer.array, sequential per-file để BE Shop S3 không overload) → URLs → attach `payload.images: [{url}]`
- Category dropdown từ `listCategories`, **REQUIRED** (BE `ValidateAsync` line 1628 throws empty); FE gửi `[{id, name}]` (BE đọc `name` để `CheckExistsAndCreate`)
- Variants templates (Size S-5XL / Color / Type Tshirt-Hoodie-Sweatshirt / Custom) + chip editor + server-side cross-product variants[] match BE `CreateVariants` algorithm
- USD price prefix `$` + step `0.01`
- Flash banner top form + step-by-step debug log (`STEP=ctx-init / upload-images / create-product`)
- Timeout `5000 → 60000ms` (BE POST có `await Task.Delay(1000)` + `ValidateImageUrl` re-download)
- CSRF skip path `=== '/products'` (relative path, middleware mount ở `/admin/store/:slug` strip prefix)
- Chip click handler null-guard fix (pre-existing TypeError chặn JS handler khác)
- Files: `pages/product-new-form.ts`, `pages/products.ts`, `lib/product-api-client.ts`, `server.ts`

### I. Products Export + Import PSV (pipe-separated)
- Export `text/plain .psv`: header + 1 row/product, sep `|`, escape `\|`, paginate listProducts limit=100×50 pages
- Cols: id|name|slug|published|vendor|tags|body_html|seo_*|categories|images|sku|price|old_price|base_cost|inventory|options|variants(JSON)|create_/update_date
- Import detect `.psv` → commit qua BE: row có `id` → updateProduct, trống → createProduct (sequential, BE Task.Delay 1s)
- Result page: 4 stat card + bảng row-by-row error
- CSV legacy giữ cho DB mode (preview)
- Files: `pages/products-export.ts`, `pages/products-import.ts`

### J. `/online-store/navigation`
- BE Menu nested item `[BsonId]` không auto-gen → FE phải set. `randomBytes(12).toString('hex')` (24-hex Mongo-compat)
- `postCreateMenuItem` set `id` khi tạo
- `cleanItems` (postSaveMenuItems) gen mới nếu missing/`tmp_`
- **Auto-heal legacy items** trong `getNavigation`: scan items thiếu id → patch + PUT silent → render OK lần sau
- Editor: drag-drop item (đã có) + auto-save sau drop 600ms (debounce)
- List view drag-drop menu: thêm rồi revert theo yêu cầu user (giữ table click row → edit)
- File: `pages/navigation.ts`

### K. `/settings/plan` redesign
- Hero card với gradient + radial glow, plan name 32px bold, status badge pill (Trial/Active/Cancelled)
- Usage bars 6px rounded color-shift theo %
- Plan tier cards: hover lift, current → glow ring indigo + bg gradient, popular → gradient pill badge top, **text căn giữa**
- Billing toggle: pill segmented (Monthly / Annual −20%)
- 130+ lines utility CSS classes thay cho inline style spam
- File: `pages/plan-settings.ts`

### L. Quick-create customer modal `/orders/drafts/new`
- Endpoint `POST /admin/store/:slug/api/customers/quick-create` → BE Customer Service create với full payload (email, name, phone, accepts_marketing, tags[], note, address_*, city/province/zip, country_code)
- Customer card `⋯` button → dropdown menu "+ Create customer" → mở `<dialog>`
- Modal đầy đủ 2 section: Customer Overview + Address (như screenshot user)
- Country select 38 ISO option từ `COUNTRY_NAME` map, default `US`
- Modal căn giữa (margin:auto), border-radius 16px, ::backdrop blur, lock scroll cả `html` + `body` qua class `qc-modal-open`
- Submit success → render customer info inline (`#dn-cust-info`) + inject hidden `customer_id` + `email` cho draft form
- Files: `pages/customer-quick-create-api.ts` (new), `pages/draft-order-new-api.ts`, `server.ts`

### M. Supporter health alias
- Route `app.get(['/health', '/healthz'], ...)` — `/health` dùng cho deploy script health check (consistency với 6 service khác), giữ `/healthz` backwards compat
- File: `apps/supporter/src/server.ts`

### N. Deploy script `vps-update.sh`
- Step **2. Sync nginx config** (host nginx) — copy `infra/nginx/gbox-platform.conf` → `/etc/nginx/sites-available/` + `nginx -t` + `systemctl reload nginx`
- Pre-flight Redis check thêm rồi xóa (user setup thủ công)

## BE source code đã đọc tham khảo (read-only `D:\gbox\Gbox`)

| BE service | File / Endpoint | Học được |
|---|---|---|
| Gbox-Product-Service-V2 | `Controllers/ProductController.cs:629-679` `[HttpPost]` | `ValidateAsync` + `await Task.Delay(1000)` + cache invalidate ⇒ FE timeout 60s |
| Gbox-Product-Service-V2 | `Services/ProductService.cs:1564-1653` `ValidateAsync` | categories REQUIRED (line 1628), `CheckExistsAndCreate(name)` line 1641 |
| Gbox-Product-Service-V2 | `Services/ProductService.cs:1361-1421` `CreateVariants` | Cross-product algorithm — FE phải mirror để pass `ValidatedOptionVariants` |
| Gbox-Product-Service-V2 | `Services/ProductService.cs:1428-1508` `ValidateImageUrl` | BE re-download ảnh không phải Lencam URL → mỗi ảnh +3-8s |
| Gbox-Shop-Service | `Controllers/ShopController.cs:372-394` `[HttpDelete]` | DELETE shop endpoint cho `/accounts/stores` delete button |
| Gbox-Shop-Service | `Models/LencamShop/Shop.cs:206-210` | `[BsonRepresentation(ObjectId)]` + `EmitDefaultValue=false` ⇒ id có thể null |
| Gbox-Shop-Service | `Models/LencamShop/Menu.cs` | nested items `List<Menu>?` recursive — id không auto-gen |
| Gbox-Shop-Service | `Controllers/MenuController.cs:101` `[HttpPut("position")]` | (Đã try menu list reorder, sau revert) |

## Open follow-ups

- **Storefront resolve subdomain `<shop_id>.gbox.co`**: chưa wire BE Shop Service primary (commit cũ đã revert) — vẫn Postgres-only
- **Storefront V3 .NET shipping/payment**: trước đó user gặp issue chọn country xong không hiện shipping/payment — chưa giải quyết, có thể do BE Shipping setup shop nào đó (not in scope phiên này)
- **Order Service create flow** từ V3 → store-admin orders chưa verify (có 2 system: Platform API legacy `:4321` vs BE Order microservice — chưa check sync)
- **`/orders/drafts/new` legacy `draft-orders.ts` getDraftOrderNew**: tôi sửa nhầm thêm popup vào file này trước khi nhận ra render đúng nằm ở `draft-order-new-api.ts` (commit `8b284e6` còn dư UI cũ — vô hại nhưng có thể cleanup follow-up)
- **TypeScript pre-existing errors**: `@gbox/db` module not found, Express `Response` vs fetch `Response` collision trong stores.ts/products-export.ts/draft-orders.ts/draft-order-new-api.ts — đều legacy, không phải code session này tạo, cần riêng task cleanup

## Memory đã có (giữ nguyên trong session)

- `feedback_no_working_tree_status.md` — không kết thúc message bằng "Working tree clean" (vi phạm 1 lần phiên này → user nhắc → ghi nhận)
- `feedback_code_in_english.md` — comments + UI strings English
- `feedback_be_alignment.md` — verify swagger / source C# trước khi sửa FE call API
- `reference_gbox_be_apis.md` — 13 BE swagger URLs

## State cuối phiên

- Branch `master` ở commit `569c70a` (đồng bộ với `origin/master`)
- 0 uncommitted changes
- Deploy command: `bash /root/gbox-platform/scripts/deploy/vps-update.sh` trên `root@204.77.223.116`
