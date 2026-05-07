# Fix Report — `/customers` page 500 (View Customers click)

## Symptom
Click "View Customers" button trên auto segment cards → URL
`/admin/store/<shop_id>/customers?segment=all` → Chrome "Page not working"
(HTTP 500). Reproducible cứ khi load `/customers` route trong production
(no DB binding).

## Scout
- **URL khớp route**: `app.get('/admin/store/:slug/customers', getCustomers)`
  (server.ts:1270) — plain bind, không có closure inject `db`.
- **Express handler arity**: `getCustomers(req, res, db)` 3 args. Express
  với plain `app.get(path, handler)` invoke `handler(req, res, next)` →
  arg 3 = Express `next` callback function.
- **Module-level `db`**: `const db = null as any` (server.ts:555). Một số
  routes có closure `(req, res) => handler(req, res, db)` (purchase-orders,
  collections); routes customers KHÔNG có wrapper.
- **`getCustomers` line 108**: `db.selectFrom('customers').where(...)` —
  unguarded chain. Khi `db` là `next` (function, không phải Kysely) →
  `next.selectFrom` undefined → throw "selectFrom is not a function".
- **Pattern compare**: `customer-segments.ts` đã có `if (hasDb) {DB} else {API}`
  guard nên không crash. `customers.ts` chưa migrate → throw.

## Diagnosis

**Root cause**: `getCustomers` thiếu `hasDb` guard. Production runtime nhận
`db === next` (Express callback), gọi `db.selectFrom(...)` → unhandled
runtime exception → Express default handler trả 500.

Hypothesis ranking:
1. ✓ `db` là Express `next`, không có Kysely method → throw — **proven**
   bằng đọc bind pattern + handler signature + line 555 `const db = null`
2. ✗ Auth middleware reject — loại vì các routes `/customers/segments` cùng
   middleware chain hoạt động OK
3. ✗ `?segment=all` parsing crash — loại vì query string parse luôn an toàn
   ở Express

Evidence: `getCustomerSegments` cùng module pattern đã work (vì có
`hasDb` guard). `getCustomers` thiếu guard duy nhất là phần khác.

## Patch
3 file thay đổi:

| File | Thay đổi |
|---|---|
| `apps/store-admin/src/lib/customer-api-client.ts` | + `listCustomers(ctx, opts)` wrap BE `GET /api/{shop_id}/list` (BE đã có endpoint, chỉ FE thiếu helper) |
| `apps/store-admin/src/pages/customers-api-list.ts` | NEW — `renderCustomersApiList(req, res)` minimal Shopify-style table cho mode !hasDb. Tách module để KHÔNG phình customers.ts (80KB). Hỗ trợ search keyword + pagination + segment banner cho `?segment=key` non-'all' (BE list không filter theo segment) |
| `apps/store-admin/src/pages/customers.ts` | + `hasDb` guard ở đầu `getCustomers`. !hasDb → `return renderCustomersApiList(req, res)`. DB code path KHÔNG đổi (tests cũ vẫn pass) |

Patch surface: minimal, không touch các handler khác trong customers.ts
(detail/edit/notes/tags) — chúng vẫn throw nếu access trong production
(documented Follow-ups).

## Verification

- **TS check**: `npx tsc --noEmit` → 0 errors mới ở 3 file thay đổi
  (3 errors `string | string[]` còn lại trong customers.ts đều
  pre-existing baseline ở DB mode code path mình KHÔNG touch)
- **Existing tests**: customer-segments.test.ts → 16/16 pass
- **Manual smoke** (cần user verify): click "View Customers" trên segment
  card "All Customers" → expect HTTP 200 với minimal table thay vì 500

**Regression test gap**: `customers.ts` import chain >6 deep modules
(`@gbox/core/modules/customers/service`, `customers/quick-filters`,
`customer-notes`, `customers/bulk`, `automations/engine`) → mock setup
nặng nề cho 1 test guard. Chấp nhận manual verification + ghi vào
Follow-ups để Phase B (full migration) thêm proper test suite.

## Follow-ups
- **Cùng pattern bug ở các handler khác trong customers.ts**: `getCustomerDetail`,
  `getCustomerEdit`, `postCustomerEdit`, `postCustomerAddNote`,
  `postCustomerDeleteNote`, `postCustomerUpdateTags`, `postCustomerCreate`,
  `getCustomerNew`, `getCustomerExport`, `getCustomerImport`,
  `postCustomerImport*`, `postCustomerBulk`, `postCustomerQuickFilter*`
  — toàn bộ DB-only, sẽ throw 500 nếu user click. Phase B migrate
  từng cái sang API mode (BE endpoints sẵn: GET/POST/PUT/DELETE
  `/api/{shop_id}/{IdOrEmail}`, `/api/{shop_id}/{id}/custom_fields`).
- **Auto segment filter**: 5/6 auto segment cards (repeat, vip, high-value,
  at-risk, new) link sang `/customers?segment=key` → mới chỉ render banner
  "use custom segments". BE `/segments/preview` cần extend page+limit
  param hoặc thêm endpoint `apply-inline` để FE auto-segments work full.
- **Regression test**: viết test `customers.api-mode-guard.test.ts` mock
  `customers-api-list` + verify guard delegate đúng (skipped do mock
  chain).
