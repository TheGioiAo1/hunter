/**
 * Store Admin — Collections (B5)
 *
 * Shows: collection listing, collection detail, create collection
 * Features: search, pagination, product count per collection
 * Manual and auto collections with published/draft status
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { logSellerAction } from '../middleware/store-auth.js'
import { notify, byActor } from '../lib/notify.js'
// CSRF: centralized in server.ts; pages use req.csrfToken + csrfHiddenField.
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
// Phase 3: source-site tabs shared helper
import {
  loadSourceTabsContext,
  applySourceFilter,
  renderSourceTabsHtml,
  renderRenameModal,
  SOURCE_TABS_CSS,
  sourceTabsScript,
  type SourceFilter,
} from '../lib/source-tabs.js'
// Phase C2: smart collection rules + async re-eval.
//   canonicaliseRules  → shape merchant form input into the stored JSON.
//   isRulesNonEmpty    → detect legacy-array + new SmartRules shapes so
//                         the "Auto" badge and the skip-manual fan-out
//                         stay in sync.
//   enqueueSyncOne     → best-effort BullMQ trigger after collection save.
import {
  canonicaliseRules,
  isRulesNonEmpty,
  type SmartRules,
} from '@gbox/core/modules/collections/smart-rules.js'
import { enqueueSyncOne } from '@gbox/core/modules/collections/enqueue-triggers.js'
// Phase 2 PR1 — metafields on collection detail. Same pattern as product detail.
import {
  listMetafields as listCollectionMetafields,
  setMetafield as setCollectionMetafield,
  deleteMetafieldById as deleteCollectionMetafieldById,
  VALUE_TYPES as COLLECTION_METAFIELD_TYPES,
  type Metafield as CollectionMetafieldRow,
  type MetafieldValueType as CollectionMetafieldValueType,
} from '@gbox/core/modules/metafields/service.js'
// Phase 03 — API client + render helpers for collections list
import {
  createApiContext,
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  listProducts,
  getProduct,
  updateProduct,
  ProductApiError,
} from '../lib/product-api-client.js'
import { renderCollectionsListPage } from './collections-list-render.js'
import { emptyState } from '../components/empty-state.js'
// Phase 04 — collection detail/edit form
import { renderCollectionEditForm } from './collection-edit-render.js'
import { parseCollectionForm } from '../lib/collection-form-schema.js'
import { productPicker } from '../components/product-picker.js'

/** Render an error card inside the standard layout when API is unreachable. */
function renderCollectionsListError(req: Request, colBase: string, message: string): string {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const content = emptyState({
    title: 'Không tải được danh sách',
    description: message,
    ctaHref: colBase,
    ctaLabel: 'Thử lại',
  })
  return sellerLayout({
    title: 'Collections',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'collections',
    content,
    theme: theme as 'dark' | 'light',
  })
}

// ---------------------------------------------------------------------------
// Phase C2 — Smart rules builder (UI fragment)
//
// Renders the "Collection type" card shared by both create + edit forms.
// The card holds:
//   • A `collection_type=manual|smart` radio group. Default is manual
//     on the create page, and whatever the stored value is on edit.
//   • A Smart panel (shown only when the radio = smart) with:
//       - A match-mode <select name="match"> (all | any).
//       - A list of condition rows, each with field/op/value inputs.
//       - A "+ Add another condition" button.
//   • A hidden <textarea name="rules"> that the form-submit handler
//     populates with a JSON blob matching the SmartRules shape. The
//     server parses + canonicalises on POST; bad blobs degrade to
//     manual. See postCreateCollection / postUpdateCollection.
//
// The JS is vanilla + self-contained (no framework dependency) and
// guards its own setup so calling `initSmartRulesBuilder()` twice is
// a no-op.
// ---------------------------------------------------------------------------

function renderSmartRulesSection(existingRules: unknown): string {
  // Pre-populate from the stored row. `canonicaliseRules` here
  // protects against legacy-array shapes that slipped in during the
  // clone-pro import (phase F) — those get treated as "no initial
  // rules" so the builder starts fresh instead of showing garbage.
  const canonical = canonicaliseRules(existingRules)
  const isSmart = canonical !== null
  // `rules` goes into a hidden <textarea>; we pre-populate on edit
  // so a plain save-without-touching round-trips cleanly.
  const rulesJson = isSmart ? JSON.stringify(canonical) : ''
  const match: 'all' | 'any' = canonical?.match ?? 'all'

  return `
    <div class="card" style="margin-bottom:24px">
      <div class="card-header"><span style="font-weight:600">Collection type</span></div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:10px">
          <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
            <input type="radio" name="collection_type" value="manual" data-smart-radio="manual"${!isSmart ? ' checked' : ''}
              style="margin-top:3px;accent-color:var(--s-accent)" />
            <div>
              <div style="font-weight:500">Manual</div>
              <div style="font-size:12px;color:var(--s-text-muted)">Add products one by one using the "Add products" button below.</div>
            </div>
          </label>
          <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
            <input type="radio" name="collection_type" value="smart" data-smart-radio="smart"${isSmart ? ' checked' : ''}
              style="margin-top:3px;accent-color:var(--s-accent)" />
            <div>
              <div style="font-weight:500">Smart</div>
              <div style="font-size:12px;color:var(--s-text-muted)">Products that match a set of conditions are automatically added. Shopify-style.</div>
            </div>
          </label>
        </div>

        <div id="smartPanel" style="display:${isSmart ? 'block' : 'none'};margin-top:16px;padding-top:16px;border-top:1px solid var(--s-border)">
          <div class="form-group">
            <label class="form-label">Products must match</label>
            <select name="match" id="smartMatch" class="form-select" style="max-width:240px">
              <option value="all"${match === 'all' ? ' selected' : ''}>ALL conditions</option>
              <option value="any"${match === 'any' ? ' selected' : ''}>ANY condition</option>
            </select>
          </div>

          <div id="smartRows" style="display:flex;flex-direction:column;gap:8px;margin-top:12px"></div>

          <button type="button" id="smartAddBtn" class="btn btn-outline btn-sm" style="margin-top:12px">+ Add another condition</button>
        </div>

        <!-- Hidden serialised rules blob — populated on submit by JS. -->
        <textarea name="rules" id="rulesJson" style="display:none">${esc(rulesJson)}</textarea>
      </div>
    </div>

    <script>
      (function() {
        if (window.__smartRulesInit) return
        window.__smartRulesInit = true

        var INITIAL = ${JSON.stringify(canonical ?? { match: 'all', conditions: [] })};

        // Field → allowed ops map. Keep in sync with smart-rules.ts
        // (isSmartRuleCondition). The server canonicaliser treats
        // unknown combinations as invalid and drops the condition,
        // so the UI mirrors the same whitelist here to avoid
        // silently-dropped rows after a save.
        var FIELD_OPTIONS = [
          { value: 'title', label: 'Product title', type: 'text' },
          { value: 'product_type', label: 'Product type', type: 'text' },
          { value: 'vendor', label: 'Product vendor', type: 'text' },
          { value: 'tag', label: 'Product tag', type: 'tag' },
          { value: 'price', label: 'Product price', type: 'numeric' },
          { value: 'inventory_quantity', label: 'Inventory stock', type: 'numeric' }
        ]
        var TEXT_OPS = [
          { value: 'equals', label: 'is equal to' },
          { value: 'not_equals', label: 'is not equal to' },
          { value: 'starts_with', label: 'starts with' },
          { value: 'ends_with', label: 'ends with' },
          { value: 'contains', label: 'contains' },
          { value: 'not_contains', label: 'does not contain' }
        ]
        var TAG_OPS = [
          { value: 'equals', label: 'is equal to' },
          { value: 'not_equals', label: 'is not equal to' }
        ]
        var NUMERIC_OPS = [
          { value: 'greater_than', label: 'is greater than' },
          { value: 'less_than', label: 'is less than' },
          { value: 'equals', label: 'is equal to' },
          { value: 'not_equals', label: 'is not equal to' }
        ]

        function opsForField(field) {
          var meta = FIELD_OPTIONS.find(function(f){ return f.value === field })
          if (!meta) return TEXT_OPS
          if (meta.type === 'tag') return TAG_OPS
          if (meta.type === 'numeric') return NUMERIC_OPS
          return TEXT_OPS
        }

        function buildOption(o, selected) {
          var opt = document.createElement('option')
          opt.value = o.value
          opt.textContent = o.label
          if (selected === o.value) opt.selected = true
          return opt
        }

        function addRow(cond) {
          cond = cond || { field: 'title', op: 'contains', value: '' }
          var list = document.getElementById('smartRows')
          if (!list) return

          var row = document.createElement('div')
          row.className = 'smart-row'
          row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1.3fr auto;gap:8px;align-items:center'

          // Field dropdown
          var fieldSel = document.createElement('select')
          fieldSel.className = 'form-select'
          fieldSel.setAttribute('data-smart-field', '1')
          FIELD_OPTIONS.forEach(function(f){ fieldSel.appendChild(buildOption(f, cond.field)) })

          // Op dropdown — rebuilt whenever the field changes.
          var opSel = document.createElement('select')
          opSel.className = 'form-select'
          opSel.setAttribute('data-smart-op', '1')
          function refreshOps() {
            opSel.innerHTML = ''
            var current = opSel.getAttribute('data-want') || cond.op
            opsForField(fieldSel.value).forEach(function(o){
              opSel.appendChild(buildOption(o, current))
            })
            opSel.removeAttribute('data-want')
          }
          refreshOps()

          fieldSel.addEventListener('change', function(){
            // Keep the current op if the new field still supports it
            opSel.setAttribute('data-want', opSel.value)
            refreshOps()
          })

          // Value input
          var val = document.createElement('input')
          val.type = 'text'
          val.className = 'form-input'
          val.setAttribute('data-smart-value', '1')
          val.value = cond.value || ''
          val.placeholder = 'value'

          // Remove button
          var rm = document.createElement('button')
          rm.type = 'button'
          rm.className = 'btn btn-outline btn-sm'
          rm.textContent = 'Remove'
          rm.addEventListener('click', function(){
            row.parentNode && row.parentNode.removeChild(row)
          })

          row.appendChild(fieldSel)
          row.appendChild(opSel)
          row.appendChild(val)
          row.appendChild(rm)
          list.appendChild(row)
        }

        // Seed with initial conditions (or one empty row on create).
        function hydrate() {
          var list = document.getElementById('smartRows')
          if (!list) return
          list.innerHTML = ''
          if (INITIAL.conditions && INITIAL.conditions.length) {
            INITIAL.conditions.forEach(addRow)
          } else {
            addRow()
          }
        }

        function togglePanel() {
          var chosen = document.querySelector('input[name="collection_type"]:checked')
          var panel = document.getElementById('smartPanel')
          if (!panel) return
          var isSmart = chosen && chosen.value === 'smart'
          panel.style.display = isSmart ? 'block' : 'none'
          if (isSmart && document.getElementById('smartRows').children.length === 0) {
            addRow()
          }
        }

        // Serialise rows → JSON on submit. We walk the DOM so added /
        // removed rows reflect reality; there's no React state to
        // keep in sync.
        function serialise() {
          var chosen = document.querySelector('input[name="collection_type"]:checked')
          if (!chosen || chosen.value !== 'smart') {
            document.getElementById('rulesJson').value = ''
            return
          }
          var match = document.getElementById('smartMatch').value === 'any' ? 'any' : 'all'
          var rows = document.querySelectorAll('#smartRows .smart-row')
          var conditions = []
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i]
            var f = r.querySelector('[data-smart-field]').value
            var o = r.querySelector('[data-smart-op]').value
            var v = r.querySelector('[data-smart-value]').value.trim()
            if (!v) continue // skip empty value; server canonicaliser would drop anyway
            conditions.push({ field: f, op: o, value: v })
          }
          document.getElementById('rulesJson').value = JSON.stringify({ match: match, conditions: conditions })
        }

        // Wire it up.
        document.addEventListener('DOMContentLoaded', function() {
          hydrate()
          togglePanel()

          document.querySelectorAll('[data-smart-radio]').forEach(function(r){
            r.addEventListener('change', togglePanel)
          })

          var addBtn = document.getElementById('smartAddBtn')
          if (addBtn) addBtn.addEventListener('click', function(){ addRow() })

          // Hook every form on the page — create and edit are the
          // only forms that include this fragment, and the hidden
          // textarea is scoped inside them.
          var rulesField = document.getElementById('rulesJson')
          if (rulesField && rulesField.form) {
            rulesField.form.addEventListener('submit', serialise)
          }
        })
      })()
    </script>
  `
}

// ---------------------------------------------------------------------------
// GET /collections — Collections list with search, pagination
// ---------------------------------------------------------------------------

export async function getCollections(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  console.log('[Collections] getCollections called')
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const colBase = `${base}/products/collections`

  // Query params
  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const search = ((req.query.q as string) || '').trim()
  const statusParam = ((req.query.status as string) || 'all').toLowerCase()
  const sort = ((req.query.sort as string) || 'newest').toLowerCase()

  const sortMap: Record<string, string> = {
    newest: 'create_date_desc',
    oldest: 'create_date_asc',
    name: 'name_asc',
    products_desc: 'name_asc',
  }
  const sortBy = sortMap[sort] ?? 'create_date_desc'
  const statusFilter = statusParam === 'published' ? true : statusParam === 'draft' ? false : undefined

  // API call. Trên fail (timeout, network, http) → empty list (giống stores page).
  // UX nhất quán: thà show "no data" còn hơn page error.
  let categories: import('../lib/product-api-types.js').Category[] = []
  let totalCount = 0
  let publishedCount = 0
  let draftCount = 0
  let apiFailed = false

  try {
      const ctx = createApiContext(req)

      const [listResp, publishedResp, draftResp] = await Promise.allSettled([
        listCategories(ctx, {
          keyword: search || undefined,
          status: statusFilter,
          sortBy,
          page,
          limit: 25,
        }),
        listCategories(ctx, { status: true, page: 1, limit: 1, fields: 'id' }),
        listCategories(ctx, { status: false, page: 1, limit: 1, fields: 'id' }),
      ])

      if (listResp.status === 'fulfilled') {
        const r = listResp.value as any
        categories = r?.data ?? []
        totalCount = Number(r?.pagination?.count ?? categories.length)
      } else {
        apiFailed = true
        console.error('[Collections] listCategories failed:', listResp.reason)
        // Do not redirect to login on auth error in API mode, just show the banner
        // to avoid infinite login loops if the remote API uses a different JWT secret.
      }

    if (publishedResp.status === 'fulfilled') {
      publishedCount = Number((publishedResp.value as any)?.pagination?.count ?? 0)
    }
    if (draftResp.status === 'fulfilled') {
      draftCount = Number((draftResp.value as any)?.pagination?.count ?? 0)
    }
  } catch (err) {
    apiFailed = true
    console.error('[Collections] setup failed:', err)
    if (err instanceof ProductApiError && err.kind === 'auth') {
      res.redirect('/accounts/login')
      return
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / 25))

  const flashSuccess = (req.query.success as string) || ''
  const flashError = (req.query.error as string) || ''
  const flash = flashError
    ? { type: 'error' as const, message: flashError }
    : flashSuccess
      ? { type: 'success' as const, message: flashSuccess }
      : apiFailed
        ? { type: 'error' as const, message: 'Không kết nối được Product API. Hiển thị danh sách rỗng.' }
        : undefined

  res.send(
    renderCollectionsListPage({
      req,
      categories,
      totalCount,
      publishedCount,
      draftCount,
      page,
      totalPages,
      q: search,
      status: statusParam,
      sort,
      colBase,
      flash,
    }),
  )
}

// ---------------------------------------------------------------------------
// GET /collections/:id — Collection detail with products
// ---------------------------------------------------------------------------

export async function getCollectionDetail(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`
  const colBase = `${base}/products/collections`
  const collectionId = String(req.params.collectionId || req.params.id || '')

  let ctx
    try {
      ctx = createApiContext(req)
    } catch (e) {
      console.error('[Collections] createApiContext failed:', e)
      res.redirect('/accounts/login')
      return
    }

  // Fetch category + products in parallel
  let collection: import('../lib/product-api-types.js').Category
  let assignedProducts: import('../lib/product-api-types.js').Product[] = []
  try {
    const [cat, prodResp] = await Promise.all([
      getCategory(ctx, collectionId),
      listProducts(ctx, { categoryIds: collectionId, limit: 50, page: 1 }),
    ])
    collection = cat
    assignedProducts = (prodResp as any)?.data?.products ?? (prodResp as any)?.data ?? []
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') {
      res.redirect('/accounts/login')
      return
    }
    const msg = err instanceof ProductApiError ? err.message : 'Không thể tải collection'
    res.status(500).send(sellerLayout({
      title: 'Lỗi',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email,
      userRole: user.role, storeRole: user.storeRole,
      activePage: 'collections',
      content: emptyState({ title: 'Không tải được collection', description: msg, ctaHref: colBase, ctaLabel: 'Quay lại' }),
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  if (!collection) {
    res.status(404).send(sellerLayout({
      title: 'Collection Not Found',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'collections',
      content: `
        <div class="empty-state">
          <p>Collection not found.</p>
          <a href="${colBase}" class="btn btn-primary btn-sm">Back to collections</a>
        </div>
      `,
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  if (!collection) {
    res.status(404).send(sellerLayout({
      title: 'Collection Not Found',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'collections',
      content: `
        <div class="empty-state">
          <p>Collection not found.</p>
          <a href="${colBase}" class="btn btn-primary btn-sm">Back to collections</a>
        </div>
      `,
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  // assignedProducts already loaded above via .NET API
  const products = assignedProducts
  const memberIds = new Set(products.map((p: any) => p.id as string))

  // Picker candidates: load first page (20) — user can search to narrow
  // picker_q and picker_page from URL params
  const pickerQ = (req.query.picker_q as string || '').trim()
  const pickerPage = Math.max(1, parseInt(String(req.query.picker_page || '1'), 10))
  let pickerProducts: import('../lib/product-api-types.js').Product[] = []
  let pickerTotalPages = 1
  if (req.query.picker_open === '1') {
    try {
      const pickerResp = await listProducts(ctx, {
        keyword: pickerQ || undefined,
        excludeCategoryIds: collectionId,
        page: pickerPage,
        limit: 20,
      })
      pickerProducts = (pickerResp as any)?.data?.products ?? (pickerResp as any)?.data ?? []
      const total = (pickerResp as any)?.pagination?.count ?? 0
      pickerTotalPages = Math.max(1, Math.ceil(total / 20))
    } catch {
      // picker load failure is non-fatal; modal shows empty state
    }
  }

  const createdAt = collection.create_date
    ? new Date(collection.create_date as string).toLocaleDateString('vi-VN', { month: 'long', day: 'numeric', year: 'numeric' })
    : '-'

  // Flash messages
  const successMsg = ((req.query.success as string) || '').trim()
  const errorMsg = ((req.query.error as string) || '').trim()

  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  const pickerHtml = productPicker({
    formAction: `${colBase}/${esc(collectionId)}/products/add`,
    csrfField,
    searchValue: pickerQ,
    products: pickerProducts,
    page: pickerPage,
    totalPages: pickerTotalPages,
    memberIds,
  })

  const content = `
    <div class="page-header">
      <div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
          <a href="${colBase}" style="color:var(--s-text-muted);text-decoration:none;font-size:13px">&larr; Collections</a>
        </div>
        <h1 class="page-title">${esc(collection.name ?? '')}</h1>
        <p class="page-subtitle">
          ${collection.status !== false ? '<span class="badge badge-success">Published</span>' : '<span class="badge badge-warning">Draft</span>'}
          &middot; ${products.length} sản phẩm
        </p>
      </div>
      <div style="display:flex;gap:8px">
        <a href="${colBase}/${esc(collectionId)}/edit" class="btn btn-outline btn-sm">Chỉnh sửa</a>
      </div>
    </div>

    ${successMsg ? `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--s-success)">
        <div class="card-body" style="color:var(--s-success);font-size:14px">${esc(successMsg)}</div>
      </div>
    ` : ''}
    ${errorMsg ? `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--s-danger)">
        <div class="card-body" style="color:var(--s-danger);font-size:14px">${esc(errorMsg)}</div>
      </div>
    ` : ''}

    <!-- COLLECTION INFO -->
    <div class="card" style="margin-bottom:24px">
      <div class="card-header">
        <span style="font-weight:600">Thông tin Collection</span>
      </div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <div class="form-label" style="margin-bottom:4px">Tên</div>
            <div style="color:var(--s-text)">${esc(collection.name ?? '')}</div>
          </div>
          <div>
            <div class="form-label" style="margin-bottom:4px">Slug</div>
            <div style="color:var(--s-text);font-family:monospace;font-size:13px">${esc(collection.slug ?? '')}</div>
          </div>
          <div>
            <div class="form-label" style="margin-bottom:4px">Trạng thái</div>
            <div>${collection.status !== false ? '<span class="badge badge-success">Công khai</span>' : '<span class="badge badge-warning">Ẩn</span>'}</div>
          </div>
          <div>
            <div class="form-label" style="margin-bottom:4px">Ngày tạo</div>
            <div style="color:var(--s-text-muted);font-size:13px">${createdAt}</div>
          </div>
        </div>
        ${collection.description ? `
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--s-border)">
            <div class="form-label" style="margin-bottom:4px">Mô tả</div>
            <div style="color:var(--s-text);font-size:14px;line-height:1.6">${esc(collection.description)}</div>
          </div>
        ` : ''}
        ${collection.image_url ? `
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--s-border)">
            <div class="form-label" style="margin-bottom:4px">Ảnh</div>
            <img src="${esc(collection.image_url)}" alt="${esc(collection.name ?? '')}" style="max-width:200px;border-radius:8px" />
          </div>
        ` : ''}
      </div>
    </div>

    <!-- PRODUCTS IN COLLECTION -->
    <div class="card">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-weight:600">Sản phẩm (${products.length})</span>
        <div style="display:flex;gap:8px;align-items:center">
          <span id="colSelCount" style="color:var(--s-text-muted);font-size:13px;display:none">0 đã chọn</span>
          <button type="button" class="btn btn-outline btn-sm" id="colRemoveBtn" style="display:none;min-height:44px">Xóa đã chọn</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="openProductPicker()" style="min-height:44px">+ Thêm sản phẩm</button>
        </div>
      </div>
      <div class="card-body" style="padding:0">
        ${products.length > 0 ? `
        <div class="table-wrap">
          <table id="colProductsTable">
            <thead>
              <tr>
                <th style="width:32px;padding:10px 4px">
                  <input type="checkbox" id="colSelectAll" style="width:16px;height:16px;accent-color:var(--s-accent)" aria-label="Chọn tất cả" />
                </th>
                <th style="width:48px"></th>
                <th>Sản phẩm</th>
                <th>Vendor</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody id="colProductsBody">
              ${(products as any[]).map((p: any) => {
                const pid = esc(p.id ?? '')
                const name = esc(p.name ?? p.title ?? '(no name)')
                const slug = esc(p.slug ?? p.id ?? '')
                const imgSrc = p.images?.[0]?.url ?? p.image_src ?? ''
                const published = p.published !== false
                return `
                <tr data-product-id="${pid}">
                  <td style="padding:10px 4px">
                    <input type="checkbox" class="col-row-check" value="${pid}" style="width:16px;height:16px;accent-color:var(--s-accent)" aria-label="${name}" />
                  </td>
                  <td>
                    ${imgSrc ? `<img src="${esc(imgSrc)}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--s-border)" loading="lazy" />` : `<div style="width:36px;height:36px;border-radius:4px;background:var(--s-surface-2);border:1px solid var(--s-border)"></div>`}
                  </td>
                  <td>
                    <a href="${base}/products/${slug}" style="color:var(--s-accent);text-decoration:none;font-weight:500">${name}</a>
                  </td>
                  <td style="color:var(--s-text-muted)">${esc(p.vendor ?? '-')}</td>
                  <td>${published ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-warning">Draft</span>'}</td>
                </tr>`
              }).join('')}
            </tbody>
          </table>
        </div>
        ` : `
          <div class="empty-state" style="padding:40px">
            <p style="color:var(--s-text-muted)">Chưa có sản phẩm nào trong collection này.</p>
            <button type="button" onclick="openProductPicker()" class="btn btn-primary btn-sm" style="margin-top:12px;min-height:44px">Thêm sản phẩm đầu tiên</button>
          </div>
        `}
      </div>
    </div>

    <!-- Remove form -->
    <form method="POST" action="${colBase}/${esc(collectionId)}/products/remove" id="colRemoveForm" style="display:none">
      ${csrfField}
      <div id="colRemoveInputs"></div>
    </form>

    <!-- Product Picker Modal (from product-picker component) -->
    ${pickerHtml}

    <script>
    (function () {
      // Bulk remove
      var selectAll = document.getElementById('colSelectAll')
      var rowChecks = document.querySelectorAll('.col-row-check')
      var removeBtn = document.getElementById('colRemoveBtn')
      var bulkCount = document.getElementById('colSelCount')
      var removeForm = document.getElementById('colRemoveForm')
      var removeInputs = document.getElementById('colRemoveInputs')

      function updateBulkState() {
        var n = 0
        rowChecks.forEach(function(c) { if (c.checked) n++ })
        if (bulkCount) { bulkCount.style.display = n > 0 ? 'inline' : 'none'; bulkCount.textContent = n + ' đã chọn' }
        if (removeBtn) removeBtn.style.display = n > 0 ? 'inline-flex' : 'none'
      }
      if (selectAll) {
        selectAll.addEventListener('change', function() {
          rowChecks.forEach(function(c) { c.checked = selectAll.checked })
          updateBulkState()
        })
      }
      rowChecks.forEach(function(c) { c.addEventListener('change', updateBulkState) })
      if (removeBtn && removeForm && removeInputs) {
        removeBtn.addEventListener('click', function() {
          var ids = []
          rowChecks.forEach(function(c) { if (c.checked) ids.push(c.value) })
          if (ids.length === 0) return
          if (!confirm('Xóa ' + ids.length + ' sản phẩm khỏi collection? Sản phẩm sẽ không bị xóa.')) return
          removeInputs.innerHTML = ''
          ids.forEach(function(id) {
            var inp = document.createElement('input')
            inp.type = 'hidden'; inp.name = 'product_ids'; inp.value = id
            removeInputs.appendChild(inp)
          })
          removeForm.submit()
        })
      }
    })()
    </script>
  `

  res.send(sellerLayout({
    title: collection.name ?? 'Collection',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'collections',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// GET /collections/new — Create collection form
// ---------------------------------------------------------------------------

export async function getCreateCollection(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const colBase = `/admin/store/${store.slug}/products/collections`

  const flashError = (req.query.error as string) || ''
  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  const content = renderCollectionEditForm({
    action: `${colBase}/new`,
    csrfField,
    category: null,
    backHref: colBase,
    backLabel: 'Collections',
    flashError: flashError || undefined,
    mode: 'create',
  })

  res.send(sellerLayout({
    title: 'Tạo Collection',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'collections',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// Legacy shape kept temporarily for old inline content block — will be removed after compile gate passes
function _legacyCreateFormContent_UNUSED(colBase: string, error: string, csrfField: string): string {
  void error; void csrfField
  const content = `
    <div class="page-header">
      <div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
          <a href="${colBase}" style="color:var(--s-text-muted);text-decoration:none;font-size:13px">&larr; Collections</a>
        </div>
        <h1 class="page-title">Create Collection</h1>
        <p class="page-subtitle">Organize your products into collections</p>
      </div>
    </div>

    ${error ? `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--s-danger)">
        <div class="card-body" style="color:var(--s-danger);font-size:14px">${esc(error)}</div>
      </div>
    ` : ''}

    <form method="POST" action="${colBase}/new">
      ${csrfField}
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <span style="font-weight:600">Collection Details</span>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label" for="title">Title *</label>
            <input type="text" id="title" name="title" class="form-input" required
              placeholder="e.g., Summer Collection 2026" maxlength="255" />
          </div>

          <div class="form-group">
            <label class="form-label" for="description">Description</label>
            <textarea id="description" name="description" class="form-textarea" rows="4"
              placeholder="Describe this collection..."></textarea>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div class="form-group">
              <label class="form-label" for="sort_order">Sort Order</label>
              <select id="sort_order" name="sort_order" class="form-select">
                <option value="manual">Manual</option>
                <option value="best-selling">Best selling</option>
                <option value="alpha-asc">Alphabetically, A-Z</option>
                <option value="alpha-desc">Alphabetically, Z-A</option>
                <option value="price-asc">Price, low to high</option>
                <option value="price-desc">Price, high to low</option>
                <option value="created-desc">Date, newest first</option>
                <option value="created-asc">Date, oldest first</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label" for="image_url">Image URL</label>
              <input type="url" id="image_url" name="image_url" class="form-input"
                placeholder="https://..." />
            </div>
          </div>

          <div class="form-group" style="margin-top:8px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" name="published" value="true" checked id="publishCheck"
                style="width:16px;height:16px;accent-color:var(--s-accent)" />
              <span class="form-label" style="margin:0">Publish this collection</span>
            </label>
          </div>

          <!-- Phase C3c: Scheduled publish.
               Optional. When the merchant enters a future datetime, we
               store it in the published_at column and the storefront
               hides the collection until NOW() catches up.
               Empty = publish now. -->
          <div class="form-group" style="margin-top:4px" id="scheduleRow">
            <label class="form-label" for="publish_at">
              Schedule publish <span style="font-weight:400;color:var(--s-text-muted);font-size:12px">(optional)</span>
            </label>
            <input type="datetime-local" id="publish_at" name="publish_at"
              class="form-input" style="max-width:280px" />
            <div class="form-help" style="font-size:12px;color:var(--s-text-muted);margin-top:4px">
              Leave blank to publish immediately. A future time will hide the collection until that moment, then auto-show it.
            </div>
          </div>
        </div>
      </div>

      <!-- Phase C2: Manual / Smart toggle + rules builder. Emitted by
           the shared renderSmartRulesSection() helper so the create
           and edit pages share the same behaviour. -->
      ${renderSmartRulesSection(null)}

      <!-- SEO — optional overrides for the storefront's <title> and meta -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <span style="font-weight:600">Search engine listing</span>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label" for="seo_title">Page title</label>
            <input type="text" id="seo_title" name="seo_title" class="form-input"
              maxlength="70" placeholder="Defaults to the collection title" />
            <div class="form-help" style="font-size:12px;color:var(--s-text-muted);margin-top:4px">
              Shown as the browser tab title and in search results. Leave blank to use the collection title.
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="seo_description">Meta description</label>
            <textarea id="seo_description" name="seo_description" class="form-textarea" rows="3"
              maxlength="320"
              placeholder="Short summary shown in search results."></textarea>
            <div class="form-help" style="font-size:12px;color:var(--s-text-muted);margin-top:4px">
              Aim for 150–160 characters. Search engines may truncate longer text.
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:12px;justify-content:flex-end">
        <a href="${colBase}" class="btn btn-outline btn-sm">Cancel</a>
        <button type="submit" class="btn btn-primary btn-sm"
                data-busy-label="Creating&hellip;">Create collection</button>
      </div>
    </form>

    <script>
      // Phase C3d — form busy state. Disables the submit button and
      // swaps its label while the POST is in flight so impatient
      // merchants don't double-submit. Progressive-enhancement: the
      // form still works with JS off.
      (function () {
        var form = document.querySelector('form[action$="/collections/new"], form[action$="/collections"]');
        if (!form) return;
        form.addEventListener('submit', function () {
          var btn = form.querySelector('button[type="submit"][data-busy-label]');
          if (!btn || btn.disabled) return;
          btn.dataset.idleLabel = btn.innerHTML;
          btn.innerHTML = btn.dataset.busyLabel;
          btn.disabled = true;
          btn.setAttribute('aria-busy', 'true');
        });
      })();
    </script>
  `
  return content
}

// ---------------------------------------------------------------------------
// POST /collections/new — Save new collection
// ---------------------------------------------------------------------------

export async function postCreateCollection(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const colBase = `/admin/store/${store.slug}/products/collections`
  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)
  const theme = (req as any).theme || 'dark'
  const user = req.storeUser!

  const parsed = parseCollectionForm(req.body as Record<string, unknown>)
  if (!parsed.data) {
    const content = renderCollectionEditForm({
      action: `${colBase}/new`,
      csrfField,
      category: null,
      backHref: colBase,
      backLabel: 'Collections',
      errors: parsed.errors ?? undefined,
      mode: 'create',
    })
    res.status(422).send(sellerLayout({
      title: 'Tạo Collection',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email,
      userRole: user.role, storeRole: user.storeRole,
      activePage: 'collections', content,
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }

  try {
    const category = await createCategory(ctx, {
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description ?? null,
      image_url: parsed.data.image_url || null,
      status: parsed.data.status,
      seo_title: parsed.data.seo_title ?? null,
      seo_description: parsed.data.seo_description ?? null,
    })
    res.redirect(`${colBase}/${category.id}/edit`)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
    const msg = err instanceof ProductApiError ? err.message : 'Tạo collection thất bại'
    const content = renderCollectionEditForm({
      action: `${colBase}/new`,
      csrfField,
      category: null,
      backHref: colBase,
      backLabel: 'Collections',
      flashError: msg,
      mode: 'create',
    })
    res.status(500).send(sellerLayout({
      title: 'Tạo Collection',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email,
      userRole: user.role, storeRole: user.storeRole,
      activePage: 'collections', content,
      theme: theme as 'dark' | 'light',
    }))
  }

}

// ---------------------------------------------------------------------------
// GET /collections/:id/edit — Edit collection form
// ---------------------------------------------------------------------------

export async function getEditCollection(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const colBase = `/admin/store/${store.slug}/products/collections`
  const collectionId = String(req.params.collectionId || req.params.id || '')

  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }

  let collection: import('../lib/product-api-types.js').Category
  try {
    collection = await getCategory(ctx, collectionId)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
    const msg = err instanceof ProductApiError ? err.message : 'Không tải được collection'
    res.status(500).send(sellerLayout({
      title: 'Lỗi',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email,
      userRole: user.role, storeRole: user.storeRole,
      activePage: 'collections',
      content: emptyState({ title: 'Không tải được collection', description: msg, ctaHref: colBase, ctaLabel: 'Quay lại' }),
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  const flashError = (req.query.error as string) || ''
  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  // CUT: metafields — không hỗ trợ ở .NET API Category model. Follow-up: bridge Kysely nếu cần.

  const content = renderCollectionEditForm({
    action: `${colBase}/${esc(collectionId)}/update`,
    csrfField,
    category: collection,
    backHref: `${colBase}/${esc(collectionId)}`,
    backLabel: collection.name ?? 'Collection',
    flashError: flashError || undefined,
    mode: 'edit',
  })

  res.send(sellerLayout({
    title: `Chỉnh sửa: ${collection.name ?? ''}`,
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email,
    userRole: user.role, storeRole: user.storeRole,
    activePage: 'collections', content,
    theme: theme as 'dark' | 'light',
  }))
}


// ---------------------------------------------------------------------------
// POST /collections/:id/update — Save edits
// ---------------------------------------------------------------------------

export async function postUpdateCollection(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const colBase = `/admin/store/${store.slug}/products/collections`
  const theme = (req as any).theme || 'dark'
  const user = req.storeUser!
  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)
  const collectionId = String(req.params.collectionId || req.params.id || '')

  const parsed = parseCollectionForm(req.body as Record<string, unknown>)
  if (!parsed.data) {
    // Re-fetch category to pre-fill form
    let category: import('../lib/product-api-types.js').Category | null = null
    try {
      const ctx2 = createApiContext(req)
      category = await getCategory(ctx2, collectionId)
    } catch { /* best-effort */ }
    const content = renderCollectionEditForm({
      action: `${colBase}/${collectionId}/update`,
      csrfField,
      category,
      backHref: `${colBase}/${collectionId}`,
      backLabel: category?.name ?? 'Collection',
      errors: parsed.errors ?? undefined,
      mode: 'edit',
    })
    res.status(422).send(sellerLayout({
      title: 'Chỉnh sửa Collection',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email,
      userRole: user.role, storeRole: user.storeRole,
      activePage: 'collections', content,
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }

  try {
    await updateCategory(ctx, collectionId, {
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description ?? null,
      image_url: parsed.data.image_url || null,
      status: parsed.data.status,
      seo_title: parsed.data.seo_title ?? null,
      seo_description: parsed.data.seo_description ?? null,
    })
    res.redirect(`${colBase}/${collectionId}?flash=updated`)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
    const msg = err instanceof ProductApiError ? err.message : 'Cập nhật thất bại'
    let category: import('../lib/product-api-types.js').Category | null = null
    try { const ctx2 = createApiContext(req); category = await getCategory(ctx2, collectionId) } catch { /* */ }
    const content = renderCollectionEditForm({
      action: `${colBase}/${collectionId}/update`,
      csrfField,
      category,
      backHref: `${colBase}/${collectionId}`,
      backLabel: category?.name ?? 'Collection',
      flashError: msg,
      mode: 'edit',
    })
    res.status(500).send(sellerLayout({
      title: 'Chỉnh sửa Collection',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email,
      userRole: user.role, storeRole: user.storeRole,
      activePage: 'collections', content,
      theme: theme as 'dark' | 'light',
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /collections/:id/delete — Delete collection
// ---------------------------------------------------------------------------

export async function postDeleteCollection(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const colBase = `/admin/store/${store.slug}/products/collections`
  const collectionId = String(req.params.collectionId || req.params.id || '')

  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }

  try {
    await deleteCategory(ctx, collectionId)
    res.redirect(`${colBase}?flash=deleted`)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
    const msg = err instanceof ProductApiError ? err.message : 'Xóa thất bại'
    res.redirect(`${colBase}/${collectionId}?error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// Phase 2 PR1 — Collection metafields (Custom data)
// ---------------------------------------------------------------------------

/**
 * Render the list of metafields for a collection's "Custom data" card.
 */
function renderCollectionMetafields(
  metafields: CollectionMetafieldRow[],
  collectionId: string,
  colBase: string,
  csrfField: string,
): string {
  if (!metafields.length) {
    return '<p style="font-size:13px;color:var(--s-text-muted);margin:0">No custom fields yet.</p>'
  }
  return metafields
    .map((mf) => {
      const raw = typeof mf.value === 'string' ? mf.value : JSON.stringify(mf.value)
      const preview = raw.length > 80 ? raw.slice(0, 77) + '…' : raw
      return `
        <div class="col-mf-row" data-mf-id="${esc(mf.id)}">
          <div class="col-mf-row-main">
            <div class="col-mf-tuple">${esc(mf.namespace)}.${esc(mf.key)}</div>
            <div class="col-mf-type">${esc(mf.value_type)}</div>
            <div class="col-mf-value" title="${esc(raw)}">${esc(preview)}</div>
          </div>
          <form method="POST" action="${colBase}/${encodeURIComponent(collectionId)}/metafields/${encodeURIComponent(mf.id)}/delete" onsubmit="return confirm('Delete ${esc(mf.namespace)}.${esc(mf.key)}?')">
            ${csrfField}
            <button type="submit" class="col-mf-del-btn" aria-label="Delete">✕</button>
          </form>
        </div>
      `
    })
    .join('')
}

/**
 * POST /collections/:collectionId/metafields
 * Creates or upserts a metafield on a collection (Shopify-style tuple).
 */
export async function postCollectionMetafieldAdd(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const colBase = `${base}/products/collections`
  const collectionId = String(req.params.collectionId || req.params.id || '')

  const existing = await db
    .selectFrom('collections')
    .select('id')
    .where('id', '=', collectionId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()
  if (!existing) {
    res.redirect(`${colBase}?error=${encodeURIComponent('Collection not found')}`)
    return
  }

  const body = req.body ?? {}
  const namespace = String(body.namespace ?? '').trim()
  const key = String(body.key ?? '').trim()
  const rawValue = typeof body.value === 'string' ? body.value : String(body.value ?? '')
  const valueType = String(body.value_type ?? 'single_line_text_field').trim() as CollectionMetafieldValueType
  const description = typeof body.description === 'string' && body.description.trim()
    ? body.description.trim()
    : null

  let parsed: unknown = rawValue
  if (valueType === 'json') {
    try { parsed = JSON.parse(rawValue) } catch {
      res.redirect(`${colBase}/${encodeURIComponent(collectionId)}/edit?error=${encodeURIComponent('Invalid JSON')}`)
      return
    }
  } else if (valueType === 'number_integer') {
    const n = parseInt(rawValue, 10)
    if (Number.isNaN(n)) {
      res.redirect(`${colBase}/${encodeURIComponent(collectionId)}/edit?error=${encodeURIComponent('Value must be an integer')}`)
      return
    }
    parsed = n
  } else if (valueType === 'number_decimal') {
    const n = parseFloat(rawValue)
    if (Number.isNaN(n)) {
      res.redirect(`${colBase}/${encodeURIComponent(collectionId)}/edit?error=${encodeURIComponent('Value must be a number')}`)
      return
    }
    parsed = n
  } else if (valueType === 'boolean') {
    parsed = rawValue === 'true' || rawValue === '1' || rawValue === 'on'
  }

  try {
    await setCollectionMetafield(db as any, {
      shop_id: store.id,
      owner_type: 'collection',
      owner_id: collectionId,
      namespace,
      key,
      value: parsed,
      value_type: valueType,
      description,
    })
  } catch (err: any) {
    res.redirect(`${colBase}/${encodeURIComponent(collectionId)}/edit?error=${encodeURIComponent(err?.message ?? 'Failed to save')}`)
    return
  }

  await logSellerAction(req, 'metafield.upsert', 'collection', collectionId, {
    namespace,
    key,
    value_type: valueType,
  }).catch(() => {})

  res.redirect(`${colBase}/${encodeURIComponent(collectionId)}/edit`)
}

/**
 * POST /collections/:collectionId/metafields/:metafieldId/delete
 */
export async function postCollectionMetafieldDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const colBase = `${base}/products/collections`
  const collectionId = String(req.params.collectionId || req.params.id || '')
  const metafieldId = String(req.params.metafieldId || '')

  await deleteCollectionMetafieldById(db as any, store.id, metafieldId)
  await logSellerAction(req, 'metafield.delete', 'collection', collectionId, {
    metafield_id: metafieldId,
  }).catch(() => {})

  res.redirect(`${colBase}/${encodeURIComponent(collectionId)}/edit`)
}

// ===========================================================================
// Phase C1 — Manual collection UX
//
// Until Phase C1, the only way for a merchant to add a product to a
// collection was via the product editor's "Collections" multiselect.
// Shopify has the picker on both sides; Phase C1 adds the three
// collection-side handlers below.
//
// Cross-tenant defense is the same on every mutation:
//   - Collection looked up scoped to shop_id — wrong shop → redirect
//     with `?error=Collection+not+found`.
//   - Candidate product ids joined against `products` scoped to the
//     same shop_id BEFORE any INSERT — foreign ids silently dropped
//     rather than polluting memberships or leaking existence.
//   - All three handlers tolerate empty input (form with nothing
//     checked is a legitimate UX and shouldn't raise a flash error).
// ===========================================================================

/**
 * Phase C3c — resolve the `published_at` value from the create/edit form.
 *
 * Inputs:
 *   published     — whether the "Publish this collection" box is ticked.
 *   scheduleRaw   — the value of the `publish_at` datetime-local input.
 *                   Empty string when merchant left it blank.
 *
 * Rules:
 *   unpublish  → null (clears the schedule; storefront gate won't see it
 *                anyway because the published flag is false).
 *   published + future schedule → return the scheduled ISO string so
 *                the storefront filter `published_at <= NOW()` hides it
 *                until the scheduled moment passes.
 *   published + no schedule / past schedule → return `now` so the
 *                storefront sees it immediately (same behaviour as
 *                every pre-C3c save).
 *
 * Future-checking is deliberately lenient — we accept anything >2s
 * ahead as "scheduled" so merchants setting a schedule for
 * "right now" (e.g. the default value) still get an immediate publish.
 */
export function resolvePublishedAt(
  published: boolean,
  scheduleRaw: unknown,
): Date | null {
  if (!published) return null
  if (typeof scheduleRaw !== 'string' || scheduleRaw.trim() === '') {
    return new Date()
  }
  const parsed = new Date(scheduleRaw)
  if (Number.isNaN(parsed.getTime())) {
    return new Date()
  }
  const now = Date.now()
  // Lenient "future" — >2s ahead counts. `datetime-local` in the
  // browser rounds to the minute, so we never see sub-second schedules.
  if (parsed.getTime() - now > 2000) return parsed
  return new Date()
}

/**
 * Express form bodies deliver a multi-checkbox field as an array when
 * >1 box is checked and as a bare string when only one is. Normalise
 * to a deduped string[] so every downstream step can iterate.
 *
 * Empty / missing / wrong-typed input → [].
 */
function toIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    )
  }
  if (typeof raw === 'string') {
    // Also accept a single comma-joined string — the reorder handler
    // uses this shape because the drag-sort JS posts a CSV.
    return Array.from(
      new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    )
  }
  return []
}

// ---------------------------------------------------------------------------
// POST /collections/:id/products/add — bulk add products to a collection
// ---------------------------------------------------------------------------

export async function postCollectionProductsAdd(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const colBase = `/admin/store/${store.slug}/products/collections`
  const collectionId = String(req.params.collectionId || req.params.id || '')

  const requested = toIdList((req.body as any)?.product_ids)
  if (requested.length === 0) {
    res.redirect(`${colBase}/${collectionId}`)
    return
  }

  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }

  // For each product: fetch current categories → append this collection → update.
  // Promise.allSettled so partial failures don't abort the batch.
  const results = await Promise.allSettled(
    requested.map(async (productId) => {
      const product = await getProduct(ctx!, productId)
      const existing = product.categories ?? []
      // Deduplicate — no-op if already member
      if (existing.some((c) => c.id === collectionId)) return 'skipped'
      await updateProduct(ctx!, productId, {
        ...product,
        categories: [...existing, { id: collectionId }],
      })
      return 'added'
    }),
  )

  const added = results.filter((r) => r.status === 'fulfilled' && r.value === 'added').length
  const msg = added > 0 ? `Đã thêm ${added} sản phẩm.` : 'Không có sản phẩm mới.'
  res.redirect(`${colBase}/${collectionId}?success=${encodeURIComponent(msg)}`)
}

// ---------------------------------------------------------------------------
// POST /collections/:id/products/remove — bulk remove products from a collection
// ---------------------------------------------------------------------------

export async function postCollectionProductsRemove(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const colBase = `/admin/store/${store.slug}/products/collections`
  const collectionId = String(req.params.collectionId || req.params.id || '')

  const ids = toIdList((req.body as any)?.product_ids)
  if (ids.length === 0) {
    res.redirect(`${colBase}/${collectionId}`)
    return
  }

  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }

  const toRemove = new Set(ids)
  const results = await Promise.allSettled(
    ids.map(async (productId) => {
      const product = await getProduct(ctx!, productId)
      const filtered = (product.categories ?? []).filter((c) => !toRemove.has(c.id ?? ''))
      await updateProduct(ctx!, productId, { ...product, categories: filtered })
    }),
  )

  const removed = results.filter((r) => r.status === 'fulfilled').length
  res.redirect(`${colBase}/${collectionId}?success=${encodeURIComponent(`Đã xóa ${removed} sản phẩm.`)}`)
}

// ---------------------------------------------------------------------------
// POST /collections/:id/products/reorder
// CUT: sort_order trong category không hỗ trợ ở .NET API. Follow-up: bridge Kysely nếu cần.
// ---------------------------------------------------------------------------

export async function postCollectionProductsReorder(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const colBase = `/admin/store/${store.slug}/products/collections`
  const collectionId = String(req.params.collectionId || req.params.id || '')
  // CUT: smart_rules — không hỗ trợ ở .NET API. Follow-up: bridge Kysely nếu cần.
  res.redirect(`${colBase}/${collectionId}`)
}

// ===========================================================================
// Phase C3b — Bulk collection ops
//
// Multi-select on the main collections list → run `publish`,
// `unpublish`, or `delete` on the chosen set in one round-trip.
//
// Design notes
// ------------
//   * Shop-scoped validation happens BEFORE any mutation via a single
//     `WHERE shop_id AND id IN (...)` lookup. Foreign ids (spoofed from
//     another shop or stale UI state) are silently dropped — we don't
//     surface the list of unknown ids because that would leak existence.
//   * Delete cascades through `collection_products` first; collections
//     with FK constraints on memberships would otherwise 23503 and
//     abort the batch.
//   * Publish/unpublish updates `published_at` to mirror the single-
//     collection save path: new publish stamps `now`, unpublish clears
//     to NULL so the next publish gets a fresh timestamp (relevant for
//     sitemap lastmod).
//   * Audit log fires one row per affected collection so bulk ops
//     stay inspectable from the activity page.
//   * Notifications: one aggregated notification per bulk op, not one
//     per row, to keep the bell icon readable.
// ===========================================================================

export async function postCollectionsBulk(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const base = `/admin/store/${store.slug}`
  const colBase = `${base}/products/collections`

  const body = req.body as { action?: string; ids?: string | string[] }
  const action = String(body.action || '')
  if (action !== 'publish' && action !== 'unpublish' && action !== 'delete') {
    res.redirect(`${colBase}?error=${encodeURIComponent('Unknown bulk action')}`)
    return
  }

  const ids = toIdList(body.ids)
  if (ids.length === 0) {
    res.redirect(`${colBase}?error=${encodeURIComponent('No collections selected')}`)
    return
  }

  // Shop-scope gate. Pulls the title for audit log + notification.
  const existing = await db
    .selectFrom('collections')
    .select(['id', 'title'])
    .where('shop_id', '=', store.id)
    .where('id', 'in', ids)
    .execute()

  const validIds = existing.map((r) => r.id as string)
  if (validIds.length === 0) {
    res.redirect(
      `${colBase}?error=${encodeURIComponent('No matching collections found')}`,
    )
    return
  }

  const now = new Date().toISOString()
  const skipped = ids.length - validIds.length

  let actionVerb: string
  if (action === 'delete') {
    // Memberships before collections — FK on collection_products would
    // otherwise 23503 and abort the delete batch mid-flight.
    await db
      .deleteFrom('collection_products')
      .where('collection_id', 'in', validIds)
      .execute()
    await db
      .deleteFrom('collections')
      .where('shop_id', '=', store.id)
      .where('id', 'in', validIds)
      .execute()
    actionVerb = 'Deleted'
  } else {
    const published = action === 'publish'
    await db
      .updateTable('collections')
      .set({
        published,
        // Stamp on publish, clear on unpublish — same invariant as the
        // single-collection update + create paths.
        published_at: published ? now : null,
        updated_at: now,
      } as any)
      .where('shop_id', '=', store.id)
      .where('id', 'in', validIds)
      .execute()
    actionVerb = published ? 'Published' : 'Unpublished'
  }

  // One audit row per collection — keeps per-resource history intact.
  for (const coll of existing) {
    await logSellerAction(
      req,
      `collection.${action}`,
      'collection',
      coll.id as string,
      {
        title: coll.title,
        bulk: true,
      },
    )
  }

  // Aggregated notification (one bell ping, not N).
  notify(db, {
    shopId: store.id,
    userId: user?.id,
    type: `collection_bulk_${action}`,
    title: `${actionVerb} ${validIds.length} collection${validIds.length === 1 ? '' : 's'}`,
    message: byActor(user) || '',
    resourceType: 'collection',
  })

  const summary =
    skipped > 0
      ? `${actionVerb} ${validIds.length} collection${validIds.length === 1 ? '' : 's'}; ${skipped} skipped.`
      : `${actionVerb} ${validIds.length} collection${validIds.length === 1 ? '' : 's'}.`
  res.redirect(`${colBase}?success=${encodeURIComponent(summary)}`)
}
