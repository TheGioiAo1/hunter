# PHASE 7 — ONLINE STORE (Detailed Execution Plan)

**Date:** 2026-04-21
**Owner:** Thai Bui
**Parent roadmap:** `2026-04-20-phase-2-to-10-master-roadmap.md`
**Status:** 🟢 EXECUTING — PR1 open
**Est:** 5 PRs, ~8 working days, branch family `feat/phase-7-*`

---

## 0. TL;DR

Phase 7 = the admin-side of Shopify's "Online store" section: CMS pages,
blog, navigation/menus, custom domains + SSL, theme editor, and files.
All 7 admin pages already exist (~4,400 LOC of UI + handlers), and every
backing table is live in schema. Most routes are already wired.

What's missing is Shopify-class **depth** and **coverage**:

1. **SEO fields are in the DB** (migration 036 added
   `seo_title`/`seo_description` to `pages` + `blog_posts`) but **the
   admin forms never render them**. Invisible feature. ← PR1.
2. **No bulk ops** on pages or blog (no bulk publish / unpublish /
   delete). ← PR1.
3. **Blog tags are a comma-string input** with no validation, no dedup,
   no chip UI. ← PR1.
4. **Menus are flat** despite `menu_items.parent_id` existing — no
   nested submenus, no drag-drop reorder, no product/collection
   resource picker. ← PR2.
5. **Zero test coverage** across 6 of 7 pages. `domains.test.ts` is a
   minimal stub. ← tests land incrementally per PR.
6. **Theme editor has no live preview** — file tree + plain textarea
   only. Not a blocker for sellers editing simple Liquid but it's not
   Shopify-class. ← PR4.
7. **Files page is a UI shell** with the upload button disabled. ← PR5.

Phase 7 does NOT cover the Theme Engine V2 rewrite (that's Infra
Track I-b, ~16 days, runs in parallel). Admin UI ships against
whatever backend exists today; Infra I-b swaps implementation behind
stable contracts later.

---

## 1. PRE-FLIGHT (audited 2026-04-21)

- ✅ Master roadmap signed off — Phase 7 scope = Online Store admin.
- ✅ All 7 target pages exist and are routed from `server.ts`:
  `pages.ts` · `blog.ts` · `navigation.ts` · `domains.ts` ·
  `theme-editor.ts` · `online-store.ts` · `content.ts`.
- ✅ DB tables all live: `pages`, `blog_posts`, `menus`, `menu_items`,
  `shop_domains`, `themes`, `theme_assets`, `files`,
  `theme_section_schemas`, `theme_page_sections`,
  `theme_global_settings`, `theme_versions`, `theme_section_blocks`.
- ✅ Migration 036 already added SEO columns to `pages` + `blog_posts`
  — no new migration needed for PR1.
- ✅ Latest migration on master: `061_discounts_bogo_and_segments`
  (Phase 5). Phase 7 expects migrations in the **062+** range if any
  new columns are needed (PR2 nested menus + PR5 files may land one).
- ✅ `domains.test.ts` is the only test file in Phase 7 surface — all
  other pages are untested.
- ✅ No open PR touches any of the Phase 7 files on `master`. Safe to
  branch.

---

## 2. PR BREAKDOWN

### PR1 — Pages + Blog: surface SEO + bulk ops + tag chips 🟢 THIS PR
**Branch:** `feat/phase-7-pr1-pages-blog-seo-bulk`
**Est:** 1.5 days

**Deliverables:**
- **Pages admin** (`apps/store-admin/src/pages/pages.ts`):
  - New SEO accordion in the create+edit form: `seo_title` (optional,
    fallback to `title` when blank), `seo_description` (optional,
    255-char soft limit). Form POST reads both, service layer writes
    NULL when blank.
  - List page: bulk checkbox column + bulk action bar (Publish /
    Unpublish / Delete). Uses a shared `bulk-actions.ts` helper so
    the same pattern lands for blog.
- **Blog admin** (`apps/store-admin/src/pages/blog.ts`):
  - SEO accordion (same contract as pages).
  - Tag chip editor (add/remove, enter-to-add, dedup on submit,
    writes back as `text[]`). Preserves legacy comma-string for
    backward-compat when user just types freely.
  - Bulk publish / unpublish / delete on list page.
- **Core services** (new, minimal):
  - `packages/core/src/modules/pages/service.ts` — extract existing
    inline queries in `pages.ts` into `listPages`, `createPage`,
    `updatePage`, `deletePage`, `bulkUpdatePages`. No behavior
    change for non-bulk paths; bulk helper is the new surface.
  - `packages/core/src/modules/blog/service.ts` — same shape for
    `blog_posts`.
- **Tests**:
  - `pages/service.test.ts` — CRUD + bulk + SEO NULL-vs-value
    roundtrip, ≥ 15 assertions.
  - `blog/service.test.ts` — CRUD + bulk + tag dedup + SEO, ≥ 15
    assertions.
- **Live smoke** (`scripts/smoke-phase7-pr1.ts`): seeds a disposable
  shop, exercises every service path against live `gbox_platform`,
  cleans up in `finally{}`. Target: **≥ 30 check calls**.

**Acceptance:**
- SEO title + description visible in both admin forms, round-trip via
  POST, show as current value on edit.
- Bulk bar appears when ≥ 1 row selected; actions succeed for the
  selected set only.
- Blog tag chip editor: add "sale", add "new", remove "sale" → POST
  body contains `["new"]`.
- Smoke green on server 2.
- vitest green for new test files.

---

### PR2 — Navigation: nested menus + drag-drop + resource picker 🔴
**Branch:** `feat/phase-7-pr2-navigation-nested-dnd`
**Est:** 1.5 days

**Deliverables:**
- **Core service** `packages/core/src/modules/navigation/service.ts`:
  - `listMenuTree(shopId, menuSlug)` — hydrates flat `menu_items` into
    a tree via `parent_id` + `position`.
  - `reorderMenu(shopId, menuId, ops)` — accepts an array of
    `{id, parentId, position}` ops, executes in one txn.
  - `resolveLink({resourceType, resourceId, url})` — turns a resource
    reference into a resolved URL at render time; used by both the
    storefront and admin preview.
- **Admin UI** (`navigation.ts`):
  - Tree renderer (recursive, max 3 levels deep — Shopify's cap).
  - Vanilla-JS drag-drop: HTML5 `draggable` + drop zones.
  - Resource picker: `<input>` + autocomplete dropdown querying
    `/api/admin/search/products` + `/api/admin/search/collections`
    (endpoints already exist from products/collections admin).
- **Tests** (`navigation/service.test.ts`, ≥ 12 assertions): tree
  hydration, reorder txn atomicity, circular-parent rejection,
  depth-cap enforcement, resolveLink for all resource types.
- **Live smoke** (`smoke-phase7-pr2.ts`): builds a 3-level menu,
  reorders, nests, asserts tree shape. ≥ 20 check calls.

---

### PR3 — Domains: test matrix expansion + hardening 🔴
**Branch:** `feat/phase-7-pr3-domains-hardening`
**Est:** 1 day

**Deliverables:**
- Expand `apps/store-admin/src/pages/domains.test.ts` from stub to full
  matrix: add/verify/set-primary/set-redirect/remove × happy + error.
- Audit the Cloudflare service in
  `packages/core/src/modules/domains/cloudflare-service.ts` for missing
  test cases (NS lookup failure, verify race, primary switch with no
  existing primary, redirect to self).
- Live smoke (`smoke-phase7-pr3.ts`): seeds shop + fake domain, runs
  through the state machine. ≥ 18 check calls. Uses a local test
  domain the CF service recognizes as "verified" via a test hook.

**Scope note:** This is deliberately the lightest PR in the phase —
the code is already mature and deployed, we're closing the coverage
gap. If it turns out the domain service has real bugs, they get a
follow-up PR, not an expansion here.

---

### PR4 — Theme editor: live preview + syntax highlighting + search 🔴
**Branch:** `feat/phase-7-pr4-theme-editor-live-preview`
**Est:** 2 days

**Deliverables:**
- Split-pane editor: left = file tree, middle = textarea, right =
  `<iframe>` pointing at `/admin/store/:slug/preview-theme/:themeId`.
- Syntax highlighting: CodeMirror 5 via CDN (`codemirror.net`), no
  new npm dep, ~40 KB gzip. Modes: liquid, json, css, js, html.
- File search: Ctrl+Shift+F opens a search bar; server-side endpoint
  `/themes/:id/editor/search?q=...` grep's across all `theme_assets`
  for that theme.
- Preview refresh: save-file POST emits a message to the iframe via
  `postMessage`; iframe reloads on receipt.
- Tests (`theme-editor.test.ts`, ≥ 10 assertions): file list shape,
  save round-trip, search result shape.
- Live smoke (`smoke-phase7-pr4.ts`): seeds a theme with 3 assets,
  exercises save/search/preview-URL. ≥ 15 check calls.

**Out of scope:** section/block schema UI, visual color picker, font
picker, theme customizer panel. All belong to Infra Track I-b.

---

### PR5 — Files library: upload + browser + quota 🔴
**Branch:** `feat/phase-7-pr5-files-library`
**Est:** 2 days

**Deliverables:**
- Core service `packages/core/src/modules/files/service.ts`:
  - `uploadFile({shopId, filename, mimeType, bytes})` — writes to
    configured storage driver (local fs by default; S3 driver
    contract stubbed). Enforces per-shop quota from
    `shop_settings.files_quota_bytes` (new column, migration 062).
  - `listFiles({shopId, q, limit, offset})` — list with search by
    filename + mime prefix.
  - `deleteFile(shopId, fileId)` — soft-delete (sets
    `deleted_at` column, migration 062).
  - `getFileUrl(file)` — resolves to the CDN URL (driver-dependent).
- Admin UI (`online-store.ts` files tab):
  - Drag-drop upload zone (multipart form POST, no progress bar v1 —
    save for v2).
  - File browser grid (thumbnail for images, icon for others).
  - Search bar + mime-type filter chips (All / Images / Documents /
    Video).
  - Copy URL button per file.
  - Storage quota meter (used / total) in the header.
- Migration 062:
  - `files.deleted_at timestamptz NULL`
  - `shop_settings.files_quota_bytes bigint DEFAULT 5368709120` (5 GB
    free tier).
- Tests (`files/service.test.ts`, ≥ 15 assertions): upload happy +
  quota-exceeded + duplicate-filename dedup + list search +
  soft-delete behavior.
- Live smoke (`smoke-phase7-pr5.ts`): uploads 3 files, searches, hits
  quota, soft-deletes, verifies list excludes deleted. ≥ 22 check
  calls.

**Storage driver (v1):** local fs under
`${DATA_ROOT}/shops/{shopId}/files/`. Interface shape matches S3 so
Phase 8+ can swap to R2/S3 without touching the service.

---

## 3. CROSS-CUTTING DECISIONS

- **Extract-then-reuse**: for pages, blog, navigation, files — the
  service layer is getting extracted OUT of the admin page handlers
  (where it lives today). This makes PR1-5 reusable by the storefront
  v2 Liquid runtime without a second refactor.
- **No new React/Vue**: admin stays vanilla JS + Liquid-style string
  templates. Drag-drop uses native HTML5 API. Chip editor is 40 lines
  of JS. CodeMirror is CDN-loaded, no bundler change.
- **CodeMirror over Monaco**: Monaco is 4 MB, CodeMirror is 100 KB.
  Shopify themselves use CodeMirror in their theme editor.
- **Quota from day 1**: even with local fs storage, we enforce quotas
  so merchants can't fill the disk. The ceiling just becomes "whatever
  the DB admin configured via `shop_settings`".
- **Bulk ops use one `IN` clause**: no per-row updates in a loop. Safer
  and 50x faster at 100+ rows.
- **SEO columns are NULLable**: blank input → NULL in DB → storefront
  falls back to page title / first 160 chars of body.
- **Iron Rule #5 compliance**: no mention of god-admin anywhere in the
  store-admin UI. Any fatal error that needs Thai's eyeballs logs
  server-side only; the seller sees "Please contact Gbox support".

---

## 4. RISKS + MITIGATIONS

| Risk | Mitigation |
|---|---|
| PR4 live preview exposes theme bugs that predate Phase 7 | Scope the PR to iframe + hotload only; any preview-rendering bug that surfaces gets logged in a follow-up issue, NOT fixed in-flight. |
| PR5 storage driver local-fs is wrong for production | Interface contract matches S3 from day 1 — swap is a one-file change in Phase 8. |
| Migration 062 collides with a parallel branch | Check `git log --all --oneline -- packages/db/src/migrations/` before writing it. Use next free number. |
| CodeMirror CDN unreachable during dev | Fall back gracefully to plain textarea; log a console warn. |
| Bulk delete is irreversible and sellers click by accident | Confirm modal with count ("Delete 14 pages?") + recovery instructions pointing to backups. |
| Drag-drop JS breaks in Safari | Use standard HTML5 drag API; verify manually. If it breaks, ship a fallback "Move up / Move down" button row. |

---

## 5. DELIVERABLES CHECKLIST

- [ ] PR1 merged — Pages + Blog SEO + bulk + tags
- [ ] PR2 merged — Navigation nested + drag-drop
- [ ] PR3 merged — Domains test matrix
- [ ] PR4 merged — Theme editor live preview
- [ ] PR5 merged — Files library
- [ ] `CLAUDE.md` Current Phase updated to "PHASE 8 — TBD" on phase close
- [ ] `CLAUDE-EXTENDED.md` gains a full Phase 7 section
- [ ] All 5 PRs have vitest + live smoke green on server 2

---

## 6. OUT-OF-SCOPE (do not build in this phase)

- Theme Engine V2 rewrite (Infra Track I-b)
- Section/block visual customizer
- Theme customizer color/font picker
- Origin TLS ACME wiring beyond what migration 055 already did
- Email forwarding at custom domains
- Metaobjects (Phase 8+)
- Landing page builder (separate effort)
- Watermark / size charts (Phase 10 polish)
- Full Shopify theme store integration
- File CDN offload to R2/S3 (Phase 8 — interface ready)

---

**End of Phase 7 detailed plan.** PR1 starts immediately after this
file commits.
