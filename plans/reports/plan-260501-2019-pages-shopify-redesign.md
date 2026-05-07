# Pages Redesign — Shopify-style + Gbox-Page-Service integration

**Created:** 2026-05-01 20:19 GMT+7
**Branch:** master
**Type:** Medium (refactor 1 file lớn + thêm ~5 file lib/module mới)

---

## Mục tiêu

1. Refactor `apps/store-admin/src/pages/pages.ts` → thay backend SQLite (`@gbox/db`) bằng **Gbox-Page-Service** (`https://api-page.gbox.co`).
2. Editor 2 cột Shopify-style: **left main** (Title + RichText content + SEO listing) + **right sidebar** (Visibility, Template, Tags, Featured image, Custom fields readonly, View counter readonly).
3. Tích hợp **Quill 2.0** (CDN) thay textarea HTML thô — minimal toolbar.
4. Surface đầy đủ field BE: `tags[]`, `image_url`, `images[]`, `custom_fields[]`, `page_view` (đọc từ custom_fields).
5. Giữ style server-render HTML inline (template literals) như `pages.ts` cũ — không thêm framework mới.

## Non-goals

- KHÔNG làm landing page, navigation, theme editor.
- KHÔNG redesign list view full Shopify (giữ table hiện tại — chỉ đổi data source).
- KHÔNG tách dual-mode (SQLite + API). Page Service là source of truth duy nhất.
- KHÔNG migrate dữ liệu pages từ SQLite cũ (BE Page Service đã chứa data thật).

---

## Mapping field

| FE cũ (SQLite) | BE Page Service | Ghi chú |
|---|---|---|
| `id` | `id` | ObjectId 24-hex |
| `title` | `title` | |
| `slug` | `slug` | BE auto-generate khi create (ToSlug) |
| `body_html` | `content` | Đổi tên field |
| `template_suffix` | `template` | Đổi tên field |
| `published` | `published` (bool?) | |
| `seo_title` | `seo_title` | |
| `seo_description` | `seo_description` | |
| `author` | ❌ không có BE | Lưu vào `custom_fields[{name:'author'}]` hoặc bỏ |
| `created_at` | `created_at` | |
| `updated_at` | `updated_at` | |
| — | `tags[]` | mới surface |
| — | `image_url` | mới surface |
| — | `images[]` | mới surface (position+url) |
| — | `custom_fields[]` | mới surface — `page_view` readonly |
| — | `finished_at` | mới surface (schedule visibility?) |

## BE endpoints (relative `/api/{shop_id}`)

- `GET /` — list (page, limit, tags, keyword, fields, published, sort_by)
- `GET /{IdOrSlug}` — detail (admin gọi bằng id 24-hex để bypass cache)
- `POST /` — create
- `PUT /` — update (body chứa id)
- `DELETE /` — delete (body: `[{id, shop_id, slug}]`)
- `GET /tags` — distinct tags
- `PUT /{slug}/view_counter` — tăng view (storefront, không dùng admin)

---

## Phases

### Phase 1 — API client + types (3 file mới)

**File mới:**

- `apps/store-admin/src/lib/page-api-types.ts` (~80 LOC)
  - `ApiPage` interface khớp BE Page model (id, title, slug, content, seo_title, seo_description, shop_id, tags[], published, template, image_url, images[], custom_fields[], created_at, finished_at, updated_at)
  - `ApiImageObject { position, url }`
  - `ApiCustomField { name, value }`
  - `ApiPageListResponse { data, pagination }`
  - `ListPagesOpts { page, limit, keyword, tags, published, fields, sort_by }`

- `apps/store-admin/src/lib/page-api-client.ts` (~150 LOC)
  - `BASE = process.env.API_PAGE_BASE_URL || 'https://api-page.gbox.co'`
  - `shopBase(shopId)` → `${BASE}/api/${shopId}`
  - Re-export `createApiContext` từ `product-api-client` (cùng resolver shop_id + token)
  - `fetchPage<T>(...)` wrapper qua `fetchJson` (label `'Page'`)
  - `listPages(ctx, opts)` → GET /
  - `getPage(ctx, idOrSlug)` → GET /{idOrSlug}, 404 → null
  - `createPage(ctx, body)` → POST /
  - `updatePage(ctx, body)` → PUT / (body có id)
  - `deletePages(ctx, pages: {id, shop_id, slug}[])` → DELETE /
  - `listPageTags(ctx)` → GET /tags

- (Reuse) `formatProductApiError` từ `product-api-errors.ts` cho UI banner.

**Acceptance:**
- Type check pass.
- 1 smoke test: gọi `listPages` với fake fetch → URL + headers đúng.

---

### Phase 2 — Refactor pages.ts core (CRUD + List)

**File sửa:** `apps/store-admin/src/pages/pages.ts`

Thay tất cả Kysely query bằng API call:

| Handler cũ | Đổi thành |
|---|---|
| `getPages` | `listPages(ctx, {page, limit:20, keyword, sort_by:'updated_at_desc'})` |
| `getCreatePage` | (chỉ render form, không query) |
| `getPageDetail` | `getPage(ctx, pageId)` — admin pass id 24-hex |
| `postCreatePage` | `createPage(ctx, {title, content, template, published, seo_title, seo_description, tags, image_url})` |
| `postUpdatePage` | `updatePage(ctx, {id, ...fields})` |
| `postDeletePage` | `deletePages(ctx, [{id, shop_id, slug}])` |
| `postBulkPages` | publish/unpublish → loop `updatePage` (BE chưa có bulk-update); delete → 1 call `deletePages` với array |

**Cắt bỏ:**
- `loadSourceTabsContext` + source-tabs (BE chưa hỗ trợ filter clone_job_id) → bỏ tabs khỏi list page (giữ source-tabs.ts utility nguyên trạng — file khác dùng).
- `logSellerAction` + `notify` — bỏ vì user chọn "Page Service only" (audit log BE tự ghi).
- Field `author` — bỏ khỏi UI (BE không hỗ trợ).

**Giữ:**
- Bulk bar UI (publish/unpublish/delete checkboxes).
- Search query string + pagination.
- Flash success/error banner.
- CSRF middleware (express-level).

**Edge cases:**
- BE PUT update không match → 400 → render error banner ở edit form.
- Empty list → giữ empty state cũ.
- API error → wrap qua `formatProductApiError` + render banner đỏ trên đầu list.
- BE list endpoint dùng cache (Redis) → admin invalidate qua chính BE (POST/PUT/DELETE auto clear). FE không cần xử lý.

**LOC ước tính:** giảm từ 818 → ~600 LOC. Vẫn vượt 200 LOC nhưng còn dày — tách Phase 3.

---

### Phase 3 — Editor 2-cột Shopify (tách module)

**File mới:** `apps/store-admin/src/pages/pages-form-editor.ts` (~280 LOC)

Export 1 hàm `pageEditorForm(opts)` thay `pageForm()` cũ.

**Layout:**

```
┌──────────────────────────────────────────────┬──────────────────┐
│  TITLE INPUT (large)                          │  VISIBILITY      │
│  [_________________________________________]  │  ○ Visible       │
│                                               │  ○ Hidden        │
│  CONTENT (Quill)                              │  [Schedule date] │
│  ┌─────────────────────────────────────────┐  │                  │
│  │ B I U  H1 H2  • —  link  img            │  │  ONLINE STORE    │
│  ├─────────────────────────────────────────┤  │  Template:       │
│  │                                         │  │  [page________]  │
│  │  (rich text body)                       │  │                  │
│  │                                         │  │  TAGS            │
│  └─────────────────────────────────────────┘  │  [chip][chip][+] │
│                                               │  (autocomplete   │
│  SEARCH ENGINE LISTING (collapsible)          │   từ /tags)      │
│  ▶ Edit website SEO                           │                  │
│    [Page title] [Meta description]            │  FEATURED IMAGE  │
│    Live preview Google snippet                │  [drop / URL]    │
│                                               │                  │
│                                               │  CUSTOM FIELDS   │
│                                               │  page_view: 1234 │
│                                               │  (readonly)      │
└──────────────────────────────────────────────┴──────────────────┘

[Delete page]                          [Cancel]  [Save changes]
```

**CSS Grid:** `grid-template-columns: 1fr 320px; gap:24px` — collapse 1 cột < 1024px.

**Implementation notes:**
- Inline style (như cả store-admin) — không thêm CSS module.
- Hidden input `name="content"` được sync từ Quill instance qua `<script>` block cuối form (oninput).
- Tags: dùng `<input>` + datalist từ `listPageTags(ctx)` được fetch trước khi render. Submit dạng comma-separated → BE parse vào array.
- Featured image: text input URL (đơn giản nhất). Upload lên Files lib là follow-up.
- Custom fields: render readonly nếu `pageData.custom_fields` có `page_view`. Cấu trúc list `dl/dt/dd` đơn giản.
- Visibility schedule: checkbox "Schedule" → datetime-local input → submit `finished_at` (hoặc field khác — kiểm tra BE meaning của `finished_at` trong Phase 2).

**Acceptance:**
- Quill load + edit + sync hidden input → POST gửi đúng HTML.
- Tag chip render từ comma-list.
- Right sidebar sticky khi scroll body dài (`position:sticky; top:16px`).

---

### Phase 4 — Quill rich text integration

**Thực hiện trong Phase 3** (cùng pages-form-editor.ts), tách ra để rõ:

- CDN: `https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.snow.css` + `quill.js` (~80KB gz).
- Init script:
  ```html
  <div id="page-editor"></div>
  <input type="hidden" name="content" id="page-content-input">
  <script>
    const quill = new Quill('#page-editor', {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ header: [1,2,3,false] }],
          ['bold','italic','underline','strike'],
          [{ list:'ordered' },{ list:'bullet' }],
          ['link','image','blockquote','code-block'],
          ['clean']
        ]
      }
    });
    quill.root.innerHTML = ${JSON.stringify(content)};
    document.getElementById('page-form').addEventListener('submit', () => {
      document.getElementById('page-content-input').value = quill.root.innerHTML;
    });
  </script>
  ```
- CSP: cần verify `seller-layout.ts` cho phép `cdn.jsdelivr.net` trong script-src + style-src. Nếu CSP strict → host Quill local (vendor copy vào `public/vendor/`).

**Risk:** CSP block CDN → fallback giải pháp là vendor + serve từ `/static/`. Sẽ kiểm tra trong Phase 1.

---

### Phase 5 — Wiring + cleanup

- `apps/store-admin/src/server.ts`:
  - Imports không thay đổi (handler signature giữ nguyên).
  - Có thể bỏ `db` argument truyền vào pages handlers — nhưng để tránh side-effect (signature dùng chung), giữ nguyên & ignore.
- Verify routes existing:
  - `GET /admin/store/:slug/online-store/pages` → `getPages`
  - `GET .../pages/new` → `getCreatePage`
  - `POST .../pages` → `postCreatePage`
  - `GET .../pages/:pageId` → `getPageDetail`
  - `POST .../pages/:pageId` → `postUpdatePage`
  - `POST .../pages/:pageId/delete` → `postDeletePage`
  - `POST .../pages/bulk` → `postBulkPages`

---

## File ownership

| File | Action | LOC ước tính |
|---|---|---|
| `apps/store-admin/src/lib/page-api-types.ts` | NEW | ~80 |
| `apps/store-admin/src/lib/page-api-client.ts` | NEW | ~150 |
| `apps/store-admin/src/pages/pages-form-editor.ts` | NEW | ~320 (thêm image picker + Quill init) |
| `apps/store-admin/src/pages/pages.ts` | REFACTOR (818 → ~380) | -440 net |
| `apps/store-admin/src/pages/files.ts` | OPTIONAL EDIT (~30 LOC) | thêm `?picker=1` mode nếu cần |
| `apps/store-admin/src/server.ts` | NO CHANGE | 0 |
| `.env` / `.env.example` | NO CHANGE (đã có `API_PAGE_BASE_URL`) | 0 |

Total: 3 file mới + 1 refactor (+ 1 optional edit) = 4-5 file.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| BE Page Service downtime → admin liệt | Wrap call trong try/catch, render error banner đỏ + nút Retry. Pattern customers-api-list. |
| BE create không trả `id` đúng kiểu (`string?`) | Check `if (!created.id) throw` → fallback list redirect. |
| Slug collision (BE auto-generate có handling, nhưng update không) | UPDATE chỉ truyền title không truyền slug — để BE giữ nguyên. Check BE behaviour: nhìn code update không re-slug → ok. |
| Quill CSP block | Verify CSP `seller-layout.ts` trong Phase 1. Fallback: vendor file local. |
| `published` bool? trong BE update — null vs false | Always send explicit `false` khi unchecked (không undefined). |
| Field `author` mất → hiển thị `-` trong list | Document UX trade-off. Có thể lưu vào `custom_fields` nếu user yêu cầu (follow-up). |
| Bulk publish dùng loop N×PUT — chậm với 100 pages | Limit chọn ≤ 50 ids/lần, hoặc Promise.all với concurrency 5. Đa số shop ít page → chấp nhận được. |

---

## Test plan (manual, không có automated test trong scope)

1. List page render với search + pagination.
2. Create page → redirect đến edit page với content render đúng.
3. Edit page → Quill load HTML cũ, edit, save → BE GET /detail trả nội dung mới.
4. Delete single → list redirect + page biến mất.
5. Bulk publish 3 pages → tất cả published=true sau khi reload.
6. Bulk delete → tất cả biến mất.
7. Tags input "vn, hot" → BE lưu tags=["vn","hot"], list filter `?tags=vn` trả page đó.
8. Featured image URL → render `<img>` trong storefront (bỏ qua trong scope FE admin, chỉ lưu).
9. Empty title submit → BE 400 → banner error.
10. Logout → vào /pages → 401 redirect login.

---

## Decisions (locked sau Q&A 2026-05-01)

| # | Topic | Decision |
|---|---|---|
| 1 | Field `author` | **BỎ khỏi UI** + bỏ cột Author trong list. BE không hỗ trợ. |
| 2 | Field `finished_at` | **BỎ khỏi UI Phase này**. Swagger không document semantic, chờ BE team confirm — follow-up. |
| 3 | `logSellerAction` + `notify` | **BỎ hoàn toàn**. Page Service only, không ghi local DB. |
| 4 | Featured image | **Tích hợp Files lib** — modal/picker từ `/online-store/files` + upload mới qua `POST /online-store/files/upload` (đã tồn tại, multer). |
| 5 | Quill loader | **CDN jsdelivr** mặc định. Verify CSP `seller-layout.ts` trong Phase 1; fallback vendor local nếu block. |
| 6 | Source-tabs (clone_job_id) | **BỎ** khỏi list page. BE Page Service không có field này. |
| 7 | Bulk publish/unpublish | Loop N×PUT với concurrency 5, limit ≤ 50 ids/batch. |
| 8 | Bulk delete | 1 call DELETE / với array body (BE đã hỗ trợ). |

## Implementation impact của decisions

- **Phase 2 (pages.ts refactor):** xóa `import { logSellerAction }` và `import { notify, byActor }`. Tất cả `await logSellerAction(...)` và `notify(...)` blocks → xóa. Cột Author trong list table → xóa. Field `author` form → xóa.
- **Phase 3 (editor):** thêm Featured image picker section trong right sidebar:
  - Hiển thị preview hiện tại (từ `image_url`)
  - 2 nút: `[Browse from Files]` (mở modal iframe `/online-store/files?picker=1`) + `[Upload new]` (file input → POST tới `/online-store/files/upload` qua fetch, response có URL → setvalue input + render preview)
  - Hidden input `name="image_url"`
  - **Phụ thuộc:** `getFilesPage` cần support query `?picker=1` để render minimal mode (return URL qua `postMessage`). Nếu chưa hỗ trợ → tạo trong scope này (sửa nhẹ files.ts ~30 LOC) hoặc dùng modal HTML đơn giản tự render danh sách.
- **List page bỏ source-tabs:** xóa `loadSourceTabsContext`, `applySourceFilter`, `renderSourceTabsHtml`, `renderRenameModal`, `SOURCE_TABS_CSS`, `sourceTabsScript` imports + tất cả markup liên quan. Giữ nguyên `lib/source-tabs.ts` (file khác dùng).

---

## Reuse audit (per .claude/rules/reuse-first.md)

**Phase 1 — page-api-client:**
- ✅ REUSE-AS-IS: `createApiContext` từ `product-api-client.ts` (cùng resolver).
- ✅ REUSE-AS-IS: `fetchJson` từ `api-fetch-json.ts`.
- ✅ REUSE-AS-IS: `ProductApiError` + `formatProductApiError` từ `product-api-errors.ts`.
- ✅ Pattern mirror: `customer-api-client.ts` (label 'Customer'), chỉ khác BASE_URL + endpoints.

**Phase 3 — pages-form-editor:**
- 🔍 Check Quill: chưa có file nào dùng. FORK-NEW.
- ✅ Reuse `csrfHiddenField` từ `@gbox/core/modules/auth/csrf.js`.
- ✅ Reuse `esc` từ `seller-layout.js`.

Verdict: REUSE-EXTEND (extend pattern customer-api-* sang page-api-*). KHÔNG cần extract shared layer vì 2 client cùng dùng `fetchJson + createApiContext + ProductApiError` rồi.

---

## Estimated effort

- Phase 1: 30 min
- Phase 2: 90 min (refactor cẩn thận, smoke test từng handler)
- Phase 3+4: 90 min (Quill integration + 2-col layout + sticky sidebar)
- Phase 5: 15 min (verify routes)
- Total: **~3.5h** một lượt nếu không vướng CSP / BE quirks.
