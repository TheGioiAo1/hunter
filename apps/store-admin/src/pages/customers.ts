/**
 * Store Admin — Customers
 *
 * Shows: customer listing with stats, search, pagination
 * Detail: individual customer profile, order history, notes
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc as escLayout } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'
// CSRF: centralized in server.ts; pages use req.csrfToken + csrfHiddenField.
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { createCustomer, updateCustomer } from '@gbox/core/modules/customers/service.js'
import { fireAutomationTrigger } from '@gbox/core/modules/automations/engine.js'
import {
  addNote as addCustomerNote,
  listNotes as listCustomerNotes,
  deleteNote as deleteCustomerNote,
  MAX_NOTE_LENGTH,
} from '@gbox/core/modules/customer-notes/service.js'
import {
  isLifecycleStage,
  type LifecycleStage,
} from '@gbox/core/modules/customer-lifecycle/index.js'
import {
  applyBulkAction,
  type BulkAction,
} from '@gbox/core/modules/customers/bulk/index.js'
import {
  listQuickFilters,
  getQuickFilter,
  saveQuickFilter,
  deleteQuickFilter,
  normalizeQuickFilterQuery,
  queryToParams,
  type QuickFilterQuery,
  type QuickFilter,
} from '@gbox/core/modules/customers/quick-filters/index.js'
import { renderCustomersApiList } from './customers-api-list.js'
import { COUNTRY_NAME, nameOf } from '../lib/country-data.js'

/**
 * Map a persisted lifecycle_stage column value onto the badge class
 * + seller-facing label we render on the customer detail page. Kept
 * a local function (not shared with the marketing segments UI)
 * because the colour palette is tuned to the admin theme and the
 * seller-facing copy is different ("At risk" vs the marketing team's
 * "at_risk" enum).
 *
 * Unknown values (pre-migration rows that somehow escaped the
 * DEFAULT, or a typo from a future migration) collapse to a neutral
 * badge rather than crashing the page.
 */
function lifecycleBadge(value: unknown): { cls: string; label: string } {
  const stage: LifecycleStage | null = isLifecycleStage(value) ? value : null
  switch (stage) {
    case 'new':
      return { cls: 'badge-info', label: 'New' }
    case 'returning':
      return { cls: 'badge-success', label: 'Returning' }
    case 'at_risk':
      return { cls: 'badge-warning', label: 'At risk' }
    case 'churned':
      return { cls: 'badge-danger', label: 'Churned' }
    default:
      return { cls: 'badge-neutral', label: 'Unknown' }
  }
}

export async function getCustomers(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  // Express plain bind `app.get(path, getCustomers)` truyền (req, res, next)
  // → param `db` thực tế là `next`. Thiếu guard này → unguarded Kysely call
  // (line `db.selectFrom('customers').where(...)`) throw → page 500.
  // !hasDb (production) → fallback API mode minimal list.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    return renderCustomersApiList(req, res)
  }

  const store = req.store!
  const user = req.storeUser!

  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const perPage = 20
  const offset = (page - 1) * perPage

  // --- Phase 4 PR5 — filter state -----------------------------------
  // The list page accepts a small closed set of filter params that
  // also round-trip through saved "quick filter" pills. The shape is
  // `{q, lifecycle, marketing, tag, status}` and lives in
  // `packages/core/src/modules/customers/quick-filters/service.ts`.
  //
  // Order of resolution (later overrides earlier):
  //   1. `?filter=<id>` — hydrate the saved pill's filter_json.
  //   2. Raw URL params — anything the seller typed manually.
  // This lets a seller pick a pill and then tweak one field (e.g.
  // tag) without the URL losing the pill context.
  const quickPills = await listQuickFilters(db, store.id).catch(() => [] as QuickFilter[])
  const filterIdParam = typeof req.query.filter === 'string' ? req.query.filter : ''
  const activePill = filterIdParam
    ? (await getQuickFilter(db, store.id, filterIdParam).catch(() => null))
    : null
  const paramFilters = normalizeQuickFilterQuery(req.query)
  const filters: QuickFilterQuery = {
    ...(activePill?.filter_json ?? {}),
    ...paramFilters,
  }
  const search = (filters.q ?? '').trim()

  // Build base query — every WHERE we add also enforces shop_id so a
  // malicious `?lifecycle=...` can't leak across tenants.
  let baseQuery = db.selectFrom('customers')
    .where('shop_id', '=', store.id)

  if (search) {
    baseQuery = baseQuery.where((eb) =>
      eb.or([
        eb('first_name', 'ilike', `%${search}%`),
        eb('last_name', 'ilike', `%${search}%`),
        eb('email', 'ilike', `%${search}%`),
      ])
    )
  }
  if (filters.lifecycle) {
    baseQuery = baseQuery.where('lifecycle_stage', '=', filters.lifecycle)
  }
  if (filters.marketing === 'yes') {
    baseQuery = baseQuery.where('accepts_marketing', '=', true)
  } else if (filters.marketing === 'no') {
    baseQuery = baseQuery.where('accepts_marketing', '=', false)
  }
  if (filters.status) {
    baseQuery = baseQuery.where('status', '=', filters.status)
  }
  if (filters.tag) {
    // `tags` is Postgres `text[]`. The `@>` contains operator is the
    // idiomatic way to ask "does the array include this value";
    // Kysely's expression builder doesn't model `@>` natively, so we
    // drop to a raw SQL fragment. Parameterised — no injection risk.
    const tagValue = filters.tag
    baseQuery = baseQuery.where(sql<boolean>`tags @> ARRAY[${tagValue}]::text[]`)
  }

  // Serialize the active filter set into a `&foo=bar` fragment we
  // append to every self-link (pagination, search reset) so the
  // pills and search survive page nav.
  const filterQueryString = queryToParams(filters)
  const filterAppend = filterQueryString ? `&${filterQueryString}` : ''

  // Fetch data in parallel
  const [stats, totalCount, customers] = await Promise.all([
    // Aggregate stats across all customers in this store
    db.selectFrom('customers')
      .select([
        db.fn.count('id').as('total_customers'),
      ])
      .where('shop_id', '=', store.id)
      .executeTakeFirst(),

    // Count for pagination (with search filter)
    baseQuery
      .select(db.fn.count('id').as('count'))
      .executeTakeFirst(),

    // Customer list with order aggregates
    baseQuery
      .select([
        'customers.id',
        'customers.first_name',
        'customers.last_name',
        'customers.email',
        'customers.orders_count',
        'customers.total_spent',
        'customers.status',
        'customers.created_at',
        // Phase 4 PR5 — surface the state the pill filters + bulk
        // actions mutate so sellers can see at a glance what state
        // each row is in (matches Shopify's customer list density).
        'customers.lifecycle_stage',
        'customers.accepts_marketing',
        'customers.tags',
      ])
      .orderBy('customers.created_at', 'desc')
      .limit(perPage)
      .offset(offset)
      .execute(),
  ])

  // Compute avg orders across all customers
  const totalCustomers = Number(stats?.total_customers ?? 0)
  const totalResults = Number(totalCount?.count ?? 0)
  const totalPages = Math.max(1, Math.ceil(totalResults / perPage))

  // Aggregate total spent across all customers
  const overallSpent = await db.selectFrom('customers')
    .select(db.fn.sum('total_spent').as('sum'))
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  const allSpent = Number(overallSpent?.sum ?? 0)
  const avgOrders = totalCustomers > 0
    ? (customers.reduce((sum, c) => sum + Number(c.orders_count ?? 0), 0) / totalCustomers)
    : 0

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Customers</h1>
        <p class="page-subtitle">${totalCustomers} customer${totalCustomers !== 1 ? 's' : ''} in your store</p>
      </div>
      <div style="display:flex;gap:8px">
        <!-- Phase 6 PR3 — customer behavior report (top spenders, at-risk,
             new vs returning, lifecycle breakdown). Segment-scopable. -->
        <a href="/admin/store/${store.slug}/reports/customers" class="btn btn-outline btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 14V6M6 14V2M10 14V8M14 14v-4"/></svg>
          Behavior Report
        </a>
        <!-- Phase 4 PR4 — CSV import / export. Both ship a full
             Shopify-compatible CSV and a dry-run preview, so sellers
             can round-trip their customer list to any other
             platform. -->
        <a href="/admin/store/${store.slug}/customers/import" class="btn btn-outline btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v8M4 7l4 4 4-4"/><path d="M2 13v1h12v-1"/></svg>
          Import
        </a>
        <a href="/admin/store/${store.slug}/customers/export" class="btn btn-outline btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 13V5M4 9l4-4 4 4"/><path d="M2 13v1h12v-1"/></svg>
          Export
        </a>
        <a href="/admin/store/${store.slug}/customers/new" class="btn btn-primary btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
          Add Customer
        </a>
      </div>
    </div>

    <!-- STATS -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${totalCustomers}</div>
        <div class="stat-label">Total Customers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">$${allSpent.toFixed(2)}</div>
        <div class="stat-label">Total Spent (All)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${avgOrders.toFixed(1)}</div>
        <div class="stat-label">Avg Orders / Customer</div>
      </div>
    </div>

    <!-- QUICK-FILTER PILLS (Phase 4 PR5)
         Shop-scoped saved views. Every staffer sees the same pills.
         The "All customers" pill is synthetic (no DB row) — it just
         clears every filter. Each saved pill carries a small ✕ that
         deletes it; the confirmation gate stops accidental wipes. -->
    <div class="pill-row" role="tablist" aria-label="Saved views">
      <a href="/admin/store/${store.slug}/customers"
         class="pill ${(!activePill && !filterQueryString) ? 'pill-active' : ''}"
         role="tab">All customers</a>
      ${quickPills.map((p) => {
        const params = queryToParams(p.filter_json)
        const href = `/admin/store/${store.slug}/customers?filter=${encodeURIComponent(p.id)}`
        const isActive = activePill?.id === p.id
        return `
          <span class="pill-group ${isActive ? 'pill-active' : ''}">
            <a href="${href}" class="pill-link" role="tab" title="${esc(params || 'no filters')}">${esc(p.name)}</a>
            <form method="POST" action="/admin/store/${store.slug}/customers/quick-filters/${encodeURIComponent(p.id)}/delete" style="display:inline" onsubmit="return confirm('Delete the &quot;${esc(p.name)}&quot; view? This cannot be undone.')">
              ${csrfHiddenField(req.csrfToken!)}
              <button type="submit" class="pill-x" title="Delete view" aria-label="Delete view ${esc(p.name)}">✕</button>
            </form>
          </span>
        `
      }).join('')}
      ${filterQueryString && !activePill ? `
        <form method="POST" action="/admin/store/${store.slug}/customers/quick-filters" style="display:inline-flex;gap:4px;align-items:center;margin-left:8px">
          ${csrfHiddenField(req.csrfToken!)}
          <input type="hidden" name="filter_json" value='${esc(JSON.stringify(filters))}'>
          <input type="text" name="name" required maxlength="80" placeholder="Name this view…" class="pill-save-name">
          <button type="submit" class="btn btn-sm btn-outline">Save view</button>
        </form>
      ` : ''}
    </div>

    <!-- SEARCH + FACET FILTERS -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-body" style="padding:12px 16px">
        <form method="GET" action="/admin/store/${store.slug}/customers" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input
            type="text"
            name="q"
            value="${esc(search)}"
            placeholder="Search customers by name or email..."
            style="flex:2;min-width:220px;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;outline:none"
          />
          <select name="lifecycle" class="facet-select" aria-label="Lifecycle stage">
            <option value="">Any lifecycle</option>
            <option value="new" ${filters.lifecycle === 'new' ? 'selected' : ''}>New</option>
            <option value="returning" ${filters.lifecycle === 'returning' ? 'selected' : ''}>Returning</option>
            <option value="at_risk" ${filters.lifecycle === 'at_risk' ? 'selected' : ''}>At risk</option>
            <option value="churned" ${filters.lifecycle === 'churned' ? 'selected' : ''}>Churned</option>
          </select>
          <select name="marketing" class="facet-select" aria-label="Marketing consent">
            <option value="">Any marketing</option>
            <option value="yes" ${filters.marketing === 'yes' ? 'selected' : ''}>Subscribed</option>
            <option value="no" ${filters.marketing === 'no' ? 'selected' : ''}>Not subscribed</option>
          </select>
          <select name="status" class="facet-select" aria-label="Account status">
            <option value="">Any status</option>
            <option value="active" ${filters.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="disabled" ${filters.status === 'disabled' ? 'selected' : ''}>Disabled</option>
          </select>
          <input type="text" name="tag" value="${esc(filters.tag ?? '')}" placeholder="Tag…" class="facet-input">
          <button type="submit" class="btn btn-sm">Apply</button>
          ${filterQueryString || activePill ? `<a href="/admin/store/${store.slug}/customers" class="btn btn-outline btn-sm">Clear</a>` : ''}
        </form>
      </div>
    </div>

    <!-- BULK ACTION BAR (hidden until selection)
         Phase 4 PR5 — action list now matches the bulk engine:
         tags, lifecycle, marketing, enable/disable. "delete" is
         intentionally omitted — the engine only soft-disables, and
         the word "delete" was misleading in the old UI. -->
    <div class="bulk-bar" id="bulkBar" style="display:none">
      <div class="bulk-bar-inner">
        <span class="bulk-count"><span id="bulkCount">0</span> selected</span>
        <form method="POST" action="/admin/store/${store.slug}/customers/bulk" id="bulkForm" style="display:flex;gap:8px;align-items:center">
          ${csrfHiddenField(req.csrfToken!)}
          <input type="hidden" name="ids" id="bulkIds">
          <select name="action" id="bulkAction" class="bulk-select" onchange="updateBulkInputs()">
            <option value="">Actions</option>
            <optgroup label="Tags">
              <option value="add_tags">Add tag</option>
              <option value="remove_tags">Remove tag</option>
            </optgroup>
            <optgroup label="Lifecycle">
              <option value="set_lifecycle:new">Set lifecycle — New</option>
              <option value="set_lifecycle:returning">Set lifecycle — Returning</option>
              <option value="set_lifecycle:at_risk">Set lifecycle — At risk</option>
              <option value="set_lifecycle:churned">Set lifecycle — Churned</option>
            </optgroup>
            <optgroup label="Marketing">
              <option value="subscribe_marketing">Subscribe to marketing</option>
              <option value="unsubscribe_marketing">Unsubscribe from marketing</option>
            </optgroup>
            <optgroup label="Account status">
              <option value="enable">Enable account</option>
              <option value="disable">Disable account</option>
            </optgroup>
          </select>
          <input type="text" name="tag" id="bulkTag" placeholder="Tag name" style="display:none;padding:6px 10px;border-radius:6px;font-size:12px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.15);color:#fff;width:140px" />
          <button type="submit" class="btn btn-primary btn-sm" onclick="return confirm('Apply bulk action to selected customers?')">Apply</button>
        </form>
        <button class="btn btn-outline btn-sm" onclick="clearSelection()">Deselect all</button>
      </div>
    </div>

    <!-- CUSTOMER TABLE -->
    <div class="card">
      <div class="card-header">
        <span>Customers${search ? ` matching "${esc(search)}"` : ''}</span>
        <span style="font-size:13px;color:#6b7280">${totalResults} result${totalResults !== 1 ? 's' : ''}</span>
      </div>
      <div class="card-body" style="padding:0">
        ${customers.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:32px;padding-left:16px"><input type="checkbox" id="selectAll" onchange="toggleAll(this.checked)" class="bulk-check"></th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Orders</th>
                  <th>Total Spent</th>
                  <th>Lifecycle</th>
                  <th>Marketing</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${customers.map(c => {
                  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown'
                  const spent = Number(c.total_spent ?? 0)
                  const orders = Number(c.orders_count ?? 0)
                  // The DB check constraint limits status to {active,disabled}.
                  // We treat "active" as the green state — the old code
                  // compared against 'enabled' which never matched, so
                  // every row rendered warning-yellow by accident.
                  const state = c.status || 'active'
                  const lc = lifecycleBadge(c.lifecycle_stage)
                  const tags = Array.isArray(c.tags) ? (c.tags as string[]) : []
                  return `
                    <tr class="customer-row" data-id="${esc(c.id)}">
                      <td style="padding-left:16px"><input type="checkbox" class="bulk-check row-check" value="${esc(c.id)}" onchange="updateBulk()"></td>
                      <td>
                        <a href="/admin/store/${store.slug}/customers/${c.id}"
                           style="color:var(--s-accent);text-decoration:none;font-weight:600">
                          ${esc(name)}
                        </a>
                        ${tags.length > 0 ? `<div class="row-tags">${tags.slice(0, 3).map(t => `<span class="row-tag">${esc(t)}</span>`).join('')}${tags.length > 3 ? `<span class="row-tag row-tag-more">+${tags.length - 3}</span>` : ''}</div>` : ''}
                      </td>
                      <td>${esc(c.email || 'N/A')}</td>
                      <td>${orders}</td>
                      <td style="font-weight:500">$${spent.toFixed(2)}</td>
                      <td><span class="badge ${lc.cls}">${lc.label}</span></td>
                      <td>${c.accepts_marketing ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-neutral">No</span>'}</td>
                      <td>
                        <span class="badge ${state === 'active' ? 'badge-success' : 'badge-warning'}">${state}</span>
                      </td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>

          <!-- PAGINATION preserves the full filter set (not just q)
               via filterAppend, so paging through a pill keeps the
               pill context intact. -->
          ${totalPages > 1 ? `
            <div style="display:flex;justify-content:center;align-items:center;gap:8px;padding:16px 0;border-top:1px solid #e5e7eb;margin-top:12px">
              ${page > 1 ? `
                <a href="/admin/store/${store.slug}/customers?page=${page - 1}${filterAppend}${activePill ? '&filter=' + encodeURIComponent(activePill.id) : ''}"
                   class="btn btn-outline btn-sm">&laquo; Previous</a>
              ` : `
                <span class="btn btn-outline btn-sm" style="opacity:0.4;pointer-events:none">&laquo; Previous</span>
              `}
              <span style="font-size:13px;color:#6b7280">Page ${page} of ${totalPages}</span>
              ${page < totalPages ? `
                <a href="/admin/store/${store.slug}/customers?page=${page + 1}${filterAppend}${activePill ? '&filter=' + encodeURIComponent(activePill.id) : ''}"
                   class="btn btn-outline btn-sm">Next &raquo;</a>
              ` : `
                <span class="btn btn-outline btn-sm" style="opacity:0.4;pointer-events:none">Next &raquo;</span>
              `}
            </div>
          ` : ''}
        ` : `
          <p style="color:#6b7280;font-size:13px;text-align:center;padding:20px">
            ${search ? 'No customers found matching your search' : 'No customers yet'}
          </p>
        `}
      </div>
    </div>

    <style>
      .bulk-bar {
        position:sticky; top:0; z-index:50; margin-bottom:12px;
        background:var(--s-accent); border-radius:10px; padding:8px 16px;
        animation:slideDown .2s ease;
      }
      @keyframes slideDown { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
      .bulk-bar-inner { display:flex; align-items:center; gap:12px; }
      .bulk-count { color:#fff; font-size:13px; font-weight:600; }
      .bulk-select {
        padding:6px 10px; border-radius:6px; font-size:12px;
        border:1px solid rgba(255,255,255,.3); background:rgba(255,255,255,.15);
        color:#fff; cursor:pointer;
      }
      .bulk-bar .btn-primary { background:rgba(255,255,255,.2); border-color:rgba(255,255,255,.3); color:#fff; }
      .bulk-bar .btn-outline { color:#fff; border-color:rgba(255,255,255,.3); }
      .bulk-check { width:16px; height:16px; cursor:pointer; accent-color:var(--s-accent); }
      .customer-row.selected { background:rgba(99,102,241,.06); }
      /* Phase 4 PR5 pills + facet row */
      .pill-row { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; align-items:center; }
      .pill, .pill-group { display:inline-flex; align-items:center; padding:5px 12px; border-radius:999px;
        background:#f3f4f6; color:#374151; text-decoration:none; font-size:12px; font-weight:500;
        border:1px solid transparent; transition:background .12s; }
      .pill:hover, .pill-group:hover { background:#e5e7eb; }
      .pill-active, .pill-group.pill-active { background:var(--s-accent, #4f46e5); color:#fff; border-color:var(--s-accent, #4f46e5); }
      .pill-group { padding:0; overflow:hidden; gap:0; }
      .pill-group .pill-link { padding:5px 8px 5px 12px; color:inherit; text-decoration:none; }
      .pill-group.pill-active .pill-link { color:#fff; }
      .pill-x { background:none; border:none; color:inherit; opacity:.55; font-size:11px;
        cursor:pointer; padding:5px 10px 5px 4px; }
      .pill-x:hover { opacity:1; }
      .pill-save-name { padding:4px 10px; border-radius:999px; border:1px dashed #9ca3af;
        font-size:12px; background:#fff; outline:none; min-width:160px; }
      .facet-select, .facet-input { padding:8px 10px; border:1px solid #d1d5db; border-radius:6px;
        font-size:13px; background:#fff; outline:none; }
      .facet-input { min-width:100px; }
      .row-tags { display:inline-flex; gap:4px; margin-top:4px; flex-wrap:wrap; }
      .row-tag { font-size:10px; padding:1px 6px; border-radius:4px; background:#eef2ff;
        color:#4338ca; font-weight:500; }
      .row-tag-more { background:#e5e7eb; color:#4b5563; }
      .badge-neutral { background:#f3f4f6; color:#4b5563; }
    </style>

    <script>
    function toggleAll(checked) {
      document.querySelectorAll('.row-check').forEach(cb => { cb.checked = checked; cb.closest('tr').classList.toggle('selected', checked); });
      updateBulk();
    }
    function updateBulk() {
      const checks = [...document.querySelectorAll('.row-check:checked')];
      const bar = document.getElementById('bulkBar');
      const count = document.getElementById('bulkCount');
      const ids = document.getElementById('bulkIds');
      if (checks.length > 0) {
        bar.style.display = 'block';
        count.textContent = checks.length;
        ids.value = checks.map(c => c.value).join(',');
      } else {
        bar.style.display = 'none';
      }
      document.querySelectorAll('.row-check').forEach(cb => {
        cb.closest('tr').classList.toggle('selected', cb.checked);
      });
      document.getElementById('selectAll').checked = checks.length === document.querySelectorAll('.row-check').length && checks.length > 0;
    }
    function clearSelection() {
      document.querySelectorAll('.row-check').forEach(cb => { cb.checked = false; cb.closest('tr').classList.remove('selected'); });
      document.getElementById('selectAll').checked = false;
      document.getElementById('bulkBar').style.display = 'none';
    }
    /* Only tag actions need the auxiliary tag input visible. */
    function updateBulkInputs() {
      const action = document.getElementById('bulkAction').value;
      const tagInput = document.getElementById('bulkTag');
      const needsTag = action === 'add_tags' || action === 'remove_tags';
      tagInput.style.display = needsTag ? 'block' : 'none';
      if (!needsTag) tagInput.value = '';
    }
    </script>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Customers',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'customers',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

export async function getCustomerDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const customerId = req.params.customerId || req.params.id

  // API mode fallback when no local DB (production / local dev w/o Postgres).
  // Renders Shopify-style detail from BE Customer-Service GET /api/{shop_id}/{IdOrEmail}.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    const { renderCustomerDetailApi } = await import('./customer-detail-api.js')
    return renderCustomerDetailApi(req, res, customerId)
  }

  // Fetch customer, their orders, and their notes timeline in parallel.
  //
  // The notes listing is shop-scoped inside the service — we pass the
  // shop id so a cross-shop customer_id guess returns an empty list
  // rather than another tenant's data (fail-closed, Shopify-parity).
  const [customer, recentOrders, notes] = await Promise.all([
    db.selectFrom('customers')
      .selectAll()
      .where('id', '=', customerId)
      .where('shop_id', '=', store.id)
      .executeTakeFirst(),

    db.selectFrom('orders')
      .select(['id', 'order_number', 'total_price', 'financial_status', 'fulfillment_status', 'created_at'])
      .where('shop_id', '=', store.id)
      .where('customer_id', '=', customerId)
      .orderBy('created_at', 'desc')
      .limit(20)
      .execute(),

    listCustomerNotes(db, {
      shop_id: store.id,
      customer_id: customerId,
      limit: 50,
    }).catch(() => [] as Array<{
      id: string
      body: string
      author_name_snapshot: string | null
      created_at: string
    }>),
  ])

  if (!customer) {
    const theme = (req as any).theme || 'dark'
    res.status(404).send(sellerLayout({
      title: 'Customer Not Found',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'customers',
      theme: theme as 'dark' | 'light',
      content: `
        <div class="page-header">
          <div>
            <h1 class="page-title">Customer Not Found</h1>
            <p class="page-subtitle">The customer you are looking for does not exist or was removed.</p>
          </div>
        </div>
        <a href="/admin/store/${store.slug}/customers" class="btn btn-outline">Back to Customers</a>
      `,
    }))
    return
  }

  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Unknown'
  const totalSpent = Number(customer.total_spent ?? 0)
  const totalOrders = Number(customer.orders_count ?? 0)
  const avgOrderValue = totalOrders > 0 ? totalSpent / totalOrders : 0
  const state = customer.status || 'enabled'
  const lifecycle = lifecycleBadge((customer as any).lifecycle_stage)
  const lastOrderAtRaw = (customer as any).last_order_at
  const lastOrderAtLabel = lastOrderAtRaw
    ? new Date(lastOrderAtRaw).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'No orders yet'

  // Normalise tags defensively. Schema says text[], but legacy code paths
  // stored CSV strings in some environments. Accept both, dedupe, trim.
  const customerTagList: string[] = (() => {
    const raw = (customer as any).tags
    if (!raw) return []
    const arr = Array.isArray(raw)
      ? raw
      : String(raw).split(',')
    const seen = new Set<string>()
    const out: string[] = []
    for (const t of arr) {
      const trimmed = String(t ?? '').trim()
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed)
        out.push(trimmed)
      }
    }
    return out
  })()

  const content = `
    <div class="page-header">
      <div>
        <a href="/admin/store/${store.slug}/customers" style="color:#6b7280;text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Back to Customers
        </a>
        <h1 class="page-title">${esc(fullName)}</h1>
        <p class="page-subtitle">Customer since ${new Date(customer.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>
      <a href="/admin/store/${store.slug}/customers/${customerId}/edit" class="btn btn-outline btn-sm" style="text-decoration:none">Edit Customer</a>
    </div>

    <!-- STATS -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${totalOrders}</div>
        <div class="stat-label">Total Orders</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">$${totalSpent.toFixed(2)}</div>
        <div class="stat-label">Total Spent</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">$${avgOrderValue.toFixed(2)}</div>
        <div class="stat-label">Avg Order Value</div>
      </div>
      <div class="stat-card" data-testid="lifecycle-stat">
        <div class="stat-value" style="font-size:14px;line-height:1.2;padding-top:4px">
          <span class="badge ${lifecycle.cls}">${lifecycle.label}</span>
        </div>
        <div class="stat-label">Lifecycle · last order ${esc(lastOrderAtLabel)}</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <!-- PROFILE CARD -->
      <div class="card">
        <div class="card-header">
          <span>Customer Profile</span>
          <span class="badge ${state === 'enabled' ? 'badge-success' : 'badge-warning'}">${state}</span>
        </div>
        <div class="card-body">
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">Name</div>
              <div style="font-weight:500">${esc(fullName)}</div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">Email</div>
              <div style="font-weight:500">${esc(customer.email || 'N/A')}</div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">Phone</div>
              <div style="font-weight:500">${esc(customer.phone || 'Not provided')}</div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">Accepts Marketing</div>
              <div>
                <span class="badge ${customer.accepts_marketing ? 'badge-success' : 'badge-warning'}">
                  ${customer.accepts_marketing ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">Verified Email</div>
              <div>
                <span class="badge ${customer.verified_email ? 'badge-success' : 'badge-warning'}">
                  ${customer.verified_email ? 'Verified' : 'Unverified'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- NOTES TIMELINE (Phase 4 PR1) -->
      <!--
        Append-only, author-attributed notes. Legacy customers.note is
        kept as a read-only "Summary note" block below so merchants who
        wrote a note pre-Phase-4 do not lose it.
      -->
      <div class="card">
        <div class="card-header">
          <span>Notes timeline</span>
          <span style="font-size:13px;color:#6b7280">${notes.length} note${notes.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="card-body">
          <form method="POST"
                action="/admin/store/${store.slug}/customers/${customerId}/notes"
                style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
            ${csrfHiddenField((req as any).csrfToken?.() || '')}
            <textarea name="body"
                      required
                      maxlength="${MAX_NOTE_LENGTH}"
                      rows="3"
                      placeholder="Add a note visible to you and your team..."
                      style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical"></textarea>
            <div style="display:flex;justify-content:flex-end">
              <button type="submit" class="btn btn-primary btn-sm">Add note</button>
            </div>
          </form>
          ${notes.length > 0 ? `
            <div style="display:flex;flex-direction:column;gap:10px">
              ${notes.map(n => `
                <div class="gbx-note-entry"
                     style="border-left:2px solid #2c6ecb;padding:8px 10px;background:rgba(44,110,203,0.05);border-radius:0 6px 6px 0">
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px">
                    <div style="font-size:12px;color:#6b7280">
                      <span style="font-weight:600;color:#374151">${esc(n.author_name_snapshot || 'System')}</span>
                      &middot;
                      ${new Date(n.created_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <form method="POST"
                          action="/admin/store/${store.slug}/customers/${customerId}/notes/${n.id}/delete"
                          onsubmit="return confirm('Delete this note? This cannot be undone.')"
                          style="margin:0">
                      ${csrfHiddenField((req as any).csrfToken?.() || '')}
                      <button type="submit"
                              class="btn-link"
                              style="background:none;border:none;color:#b91c1c;cursor:pointer;font-size:12px;padding:0">Delete</button>
                    </form>
                  </div>
                  <div style="font-size:14px;color:#111827;line-height:1.5;white-space:pre-wrap">${esc(n.body)}</div>
                </div>
              `).join('')}
            </div>
          ` : `
            <p style="color:#6b7280;font-size:13px;text-align:center;padding:12px 0 0">No notes yet &mdash; add one above.</p>
          `}
          ${customer.note ? `
            <div style="margin-top:14px;padding-top:14px;border-top:1px dashed #e5e7eb">
              <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Legacy summary note</div>
              <p style="font-size:13px;color:#6b7280;line-height:1.6;white-space:pre-wrap;margin:0">${esc(customer.note)}</p>
            </div>
          ` : ''}
        </div>
      </div>
    </div>

    <!-- ORDER HISTORY -->
    <div class="card" style="margin-top:20px">
      <div class="card-header">
        <span>Order History</span>
        <span style="font-size:13px;color:#6b7280">${recentOrders.length} order${recentOrders.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="card-body">
        ${recentOrders.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Date</th>
                  <th>Total</th>
                  <th>Payment</th>
                  <th>Fulfillment</th>
                </tr>
              </thead>
              <tbody>
                ${recentOrders.map(o => `
                  <tr>
                    <td>
                      <a href="/admin/store/${store.slug}/orders/${o.id}"
                         style="color:#2c6ecb;text-decoration:none;font-weight:600">
                        #${o.order_number}
                      </a>
                    </td>
                    <td>${new Date(o.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                    <td style="font-weight:500">$${Number(o.total_price).toFixed(2)}</td>
                    <td>
                      <span class="badge ${o.financial_status === 'paid' ? 'badge-success' : 'badge-warning'}">
                        ${o.financial_status || 'pending'}
                      </span>
                    </td>
                    <td>
                      <span class="badge ${o.fulfillment_status === 'fulfilled' ? 'badge-success' : 'badge-warning'}">
                        ${o.fulfillment_status || 'unfulfilled'}
                      </span>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <p style="color:#6b7280;font-size:13px;text-align:center;padding:20px">No orders from this customer yet</p>
        `}
      </div>
    </div>

    <!-- TAGS CHIP EDITOR (Phase 4 PR1) -->
    <!--
      customers.tags is Postgres text[] — must handle array correctly.
      The legacy code called split-comma on it, which throws once the
      column is actually populated. We normalise defensively so both
      array and CSV-string shapes render.
    -->
    <div class="card" style="margin-top:20px">
      <div class="card-header">
        <span>Tags</span>
        <span style="font-size:12px;color:#6b7280">${customerTagList.length} tag${customerTagList.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="card-body">
        ${customerTagList.length > 0 ? `
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
            ${customerTagList.map(tag => `
              <form method="POST"
                    action="/admin/store/${store.slug}/customers/${customerId}/tags"
                    style="margin:0;display:inline-flex">
                ${csrfHiddenField((req as any).csrfToken?.() || '')}
                <input type="hidden" name="action" value="remove" />
                <input type="hidden" name="tag" value="${esc(tag)}" />
                <button type="submit"
                        title="Remove tag"
                        style="background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:16px;padding:4px 10px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px">
                  ${esc(tag)}
                  <span style="color:#b91c1c;font-weight:700">&times;</span>
                </button>
              </form>
            `).join('')}
          </div>
        ` : `
          <p style="color:#6b7280;font-size:13px;margin:0 0 12px">No tags yet.</p>
        `}
        <form method="POST"
              action="/admin/store/${store.slug}/customers/${customerId}/tags"
              style="display:flex;gap:6px">
          ${csrfHiddenField((req as any).csrfToken?.() || '')}
          <input type="hidden" name="action" value="add" />
          <input type="text"
                 name="tag"
                 required
                 maxlength="64"
                 placeholder="Add a tag..."
                 style="flex:1;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px" />
          <button type="submit" class="btn btn-outline btn-sm">Add</button>
        </form>
      </div>
    </div>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: esc(fullName),
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'customers',
    theme: theme as 'dark' | 'light',
    content,
  }))
}

// ---------------------------------------------------------------------------
// GET /customers/new — Create customer form
// ---------------------------------------------------------------------------

export async function getCustomerNew(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const error = req.query.error as string || ''

  const content = `
    <div style="max-width:780px;margin:0 auto;padding:0 16px">
      <div class="page-header" style="margin-bottom:18px">
        <div>
          <a href="/admin/store/${store.slug}/customers" style="color:var(--s-text-muted);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
            &larr; Back to Customers
          </a>
          <h1 class="page-title" style="margin:0">Add Customer</h1>
        </div>
      </div>

      ${error ? `<div style="background:color-mix(in srgb, var(--s-danger) 14%, transparent);border:1px solid color-mix(in srgb, var(--s-danger) 40%, transparent);border-radius:8px;padding:12px 16px;margin-bottom:16px;color:var(--s-text);font-size:13px">${esc(decodeURIComponent(error))}</div>` : ''}

    <form method="POST" action="/admin/store/${store.slug}/customers">
      <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />

      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 16px;font-size:17px;font-weight:700">Customer Overview</h2>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">First name</label>
            <input type="text" name="first_name" placeholder="John" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Last name</label>
            <input type="text" name="last_name" placeholder="Doe" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
        </div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Email *</label>
          <input type="email" name="email" required placeholder="customer@example.com" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
        </div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Phone</label>
          <input type="tel" name="phone" placeholder="+1 555-123-4567" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
        </div>

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
          <input type="checkbox" name="accepts_marketing" value="true" id="mkt" style="width:16px;height:16px" />
          <label for="mkt" style="font-size:14px;color:var(--s-text-primary);cursor:pointer">Customer agrees to receive marketing emails</label>
        </div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Tags (comma-separated)</label>
          <input type="text" name="tags" placeholder="vip, wholesale, newsletter" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
        </div>

        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Note</label>
          <textarea name="note" rows="3" placeholder="Internal notes about this customer" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px;resize:vertical"></textarea>
        </div>
      </div>

      <!-- Address -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 16px;font-size:17px;font-weight:700">Address</h2>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div style="grid-column:span 2">
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Address</label>
            <input type="text" name="address1" placeholder="123 Main St" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div style="grid-column:span 2">
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Apartment, suite, etc.</label>
            <input type="text" name="address2" placeholder="Apt 4B" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">City</label>
            <input type="text" name="city" placeholder="New York" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">State / Province</label>
            <input type="text" name="province" placeholder="NY" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">ZIP / Postal code</label>
            <input type="text" name="zip" placeholder="10001" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Country</label>
            <select name="country_code" required style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px">
              <option value="">— Select country —</option>
              ${Object.entries(COUNTRY_NAME)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([code, name]) => `<option value="${esc(code)}"${code === 'US' ? ' selected' : ''}>${esc(name)} (${esc(code)})</option>`)
                .join('')}
            </select>
            <p style="margin:4px 0 0;font-size:11px;color:var(--s-text-dim)">Stores standard ISO country code in DB to avoid typos.</p>
          </div>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px">
        <a href="/admin/store/${store.slug}/customers" style="padding:9px 22px;font-size:13px;border-radius:8px;background:var(--s-card);border:1px solid var(--s-border);color:var(--s-text);text-decoration:none">Cancel</a>
        <button type="submit" style="padding:9px 22px;font-size:13px;font-weight:600;border-radius:8px;background:var(--s-accent);color:#fff;border:1px solid var(--s-accent);cursor:pointer">Save Customer</button>
      </div>
    </form>
    </div>
  `

  res.send(sellerLayout({
    title: 'Add Customer',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'customers',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /customers — Create customer
// ---------------------------------------------------------------------------

export async function postCustomerCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const { first_name, last_name, email, phone, accepts_marketing, tags, note,
          address1, address2, city, province, zip, country_code } = req.body

  // Country: form sends country_code (ISO 2-letter, e.g. "VN", "US"). Map to
  // country_name via country-data.ts and store both fields on BE Customer model
  // (BE keeps raw, FE rendering uses country_name; tax compute uses country_code).
  const cc = (country_code || '').toString().trim().toUpperCase()
  const cn = cc ? nameOf(cc) : ''
  const countryNameResolved: string | undefined = cn && cn !== cc ? cn : undefined

  // API mode: when no local DB, post directly to Gbox-Customer-Service.
  // Field map matches BE Customer model (see packages/api-client/.../Customer.ts):
  // first_name, last_name, email, phone, address_1, address_2, city, province,
  // zip, country_name, country_code. accepts_marketing/tags/note are local-only
  // (BE Customer model doesn't have them) — drop silently in API mode.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    try {
      const { createApiContext, createCustomer: apiCreate } = await import('../lib/customer-api-client.js')
      const ctx = createApiContext(req)
      await apiCreate(ctx, {
        first_name: first_name || null,
        last_name: last_name || null,
        email: email || null,
        phone: phone || null,
        address_1: address1 || null,
        address_2: address2 || null,
        city: city || null,
        province: province || null,
        zip: zip || null,
        country_code: cc || null,
        country_name: countryNameResolved,
      })
      res.redirect(`/admin/store/${store.slug}/customers?success=${encodeURIComponent('Customer created')}`)
    } catch (err: any) {
      console.error('[customers-api] create failed:', err?.message || err)
      res.redirect(`/admin/store/${store.slug}/customers/new?error=${encodeURIComponent(err?.message || 'API create failed')}`)
    }
    return
  }

  try {
    const addresses = address1 ? [{
      first_name: first_name || null,
      last_name: last_name || null,
      address1: address1 || null,
      address2: address2 || null,
      city: city || null,
      province: province || null,
      country: cc || 'US',
      zip: zip || null,
      is_default: true,
    }] : []

    const tagList = tags
      ? tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : null

    const newCustomer = await createCustomer(db, store.id, {
      email: email || null,
      first_name: first_name || null,
      last_name: last_name || null,
      phone: phone || null,
      accepts_marketing: accepts_marketing === 'true',
      tags: tagList,
      note: note || null,
      addresses,
    })

    // Fire automation trigger (fire-and-forget)
    void fireAutomationTrigger(db, store.id, 'customer_created', { customer: newCustomer }).catch(() => {})

    const displayName = [first_name, last_name].filter(Boolean).join(' ') || email || 'customer'
    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'customer_created',
      title: `Customer created: ${displayName}`,
      message: byActor(user),
      resourceType: 'customer',
      resourceId: (newCustomer as any)?.id,
    })

    res.redirect(`/admin/store/${store.slug}/customers?success=created`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/customers/new?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// GET /customers/:id/edit — Edit customer form
// ---------------------------------------------------------------------------

export async function getCustomerEdit(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const customerId = req.params.customerId || req.params.id
  const error = req.query.error as string || ''

  const [customer, addresses] = await Promise.all([
    db.selectFrom('customers').selectAll()
      .where('id', '=', customerId).where('shop_id', '=', store.id)
      .executeTakeFirst(),
    db.selectFrom('customer_addresses').selectAll()
      .where('customer_id', '=', customerId)
      .orderBy('is_default', 'desc')
      .limit(1)
      .execute(),
  ])

  if (!customer) {
    res.status(404).send(sellerLayout({
      title: 'Customer Not Found', storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role,
      storeRole: user.storeRole, activePage: 'customers', theme: theme as 'dark' | 'light',
      content: `<div class="page-header"><h1 class="page-title">Customer Not Found</h1></div>
                <a href="/admin/store/${store.slug}/customers" class="btn btn-outline">Back</a>`,
    }))
    return
  }

  const addr = (addresses[0] || {}) as any

  const content = `
    <div class="page-header">
      <div>
        <a href="/admin/store/${store.slug}/customers/${customerId}" style="color:#6b7280;text-decoration:none;font-size:13px">&larr; Back to Customer</a>
        <h1 class="page-title">Edit ${esc([customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer')}</h1>
      </div>
    </div>

    ${error ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#b91c1c;font-size:13px">${esc(decodeURIComponent(error))}</div>` : ''}

    <form method="POST" action="/admin/store/${store.slug}/customers/${customerId}/edit" style="max-width:700px">
      <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />

      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 16px;font-size:17px;font-weight:700">Customer Overview</h2>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">First name</label>
            <input type="text" name="first_name" value="${esc(customer.first_name || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Last name</label>
            <input type="text" name="last_name" value="${esc(customer.last_name || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
        </div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Email</label>
          <input type="email" name="email" value="${esc(customer.email || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
        </div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Phone</label>
          <input type="tel" name="phone" value="${esc(customer.phone || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
        </div>

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
          <input type="checkbox" name="accepts_marketing" value="true" ${customer.accepts_marketing ? 'checked' : ''} id="mkt_edit" style="width:16px;height:16px" />
          <label for="mkt_edit" style="font-size:14px;color:var(--s-text-primary);cursor:pointer">Customer agrees to receive marketing emails</label>
        </div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Tags</label>
          <input type="text" name="tags" value="${esc(Array.isArray(customer.tags) ? customer.tags.join(', ') : (customer.tags || ''))}" placeholder="vip, wholesale" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
        </div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Note</label>
          <textarea name="note" rows="3" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px;resize:vertical">${esc(customer.note || '')}</textarea>
        </div>

        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Status</label>
          <select name="status" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px">
            <option value="enabled" ${(customer.status || 'enabled') === 'enabled' ? 'selected' : ''}>Enabled</option>
            <option value="disabled" ${customer.status === 'disabled' ? 'selected' : ''}>Disabled</option>
            <option value="invited" ${customer.status === 'invited' ? 'selected' : ''}>Invited</option>
          </select>
        </div>
      </div>

      <!-- Address -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 16px;font-size:17px;font-weight:700">Default Address</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div style="grid-column:span 2">
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Address</label>
            <input type="text" name="address1" value="${esc(addr.address1 || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div style="grid-column:span 2">
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Apartment, suite, etc.</label>
            <input type="text" name="address2" value="${esc(addr.address2 || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">City</label>
            <input type="text" name="city" value="${esc(addr.city || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">State / Province</label>
            <input type="text" name="province" value="${esc(addr.province || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">ZIP / Postal code</label>
            <input type="text" name="zip" value="${esc(addr.zip || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Country</label>
            <input type="text" name="country" value="${esc(addr.country || 'US')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
        </div>
      </div>

      <div style="display:flex;gap:12px">
        <button type="submit" class="btn btn-primary" style="padding:10px 24px;font-size:14px;font-weight:600;border-radius:8px">Save Changes</button>
        <a href="/admin/store/${store.slug}/customers/${customerId}" class="btn" style="padding:10px 24px;font-size:14px;border-radius:8px;background:var(--s-bg);border:1px solid var(--s-border);color:var(--s-text-primary);text-decoration:none">Cancel</a>
      </div>
    </form>
  `

  res.send(sellerLayout({
    title: 'Edit Customer',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'customers',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /customers/:id/edit — Update customer
// ---------------------------------------------------------------------------

export async function postCustomerEdit(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const customerId = req.params.customerId || req.params.id
  const { first_name, last_name, email, phone, accepts_marketing, tags, note, status } = req.body

  try {
    const tagList = tags
      ? tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : null

    // The `status` check constraint is `active | disabled` (migration
    // 012). An older form default of `'enabled'` would trip the
    // constraint; normalize here so the edit form stays forgiving.
    const normalizedStatus =
      status === 'disabled' ? 'disabled' : 'active'

    await updateCustomer(db, store.id, customerId, {
      email: email || null,
      first_name: first_name || null,
      last_name: last_name || null,
      phone: phone || null,
      accepts_marketing: accepts_marketing === 'true',
      tags: tagList,
      note: note || null,
      status: normalizedStatus,
    })

    const displayName = [first_name, last_name].filter(Boolean).join(' ') || email || 'customer'
    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'customer_updated',
      title: `Customer updated: ${displayName}`,
      message: byActor(user),
      resourceType: 'customer',
      resourceId: customerId,
    })

    res.redirect(`/admin/store/${store.slug}/customers/${customerId}?success=updated`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/customers/${customerId}/edit?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /customers/bulk — Bulk actions (add_tag, remove_tag, enable, disable, delete)
// ---------------------------------------------------------------------------

/**
 * POST /customers/bulk — apply one action to many customer rows.
 *
 * The form encodes the action as a single select value; actions that
 * take a parameter are encoded colon-separated (`set_lifecycle:churned`).
 * We parse that back into a `BulkAction` discriminated-union value and
 * delegate everything else — tag array ops, cross-shop defense, the
 * transaction — to `applyBulkAction`.
 *
 * We audit-log the outcome (`affected`/`skipped` from the engine, not
 * the raw input length — so a stale UI selection that touched 8 rows
 * but only 5 belonged to this shop is logged as 5 affected, 3 skipped).
 */
export async function postCustomerBulk(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const { ids, action, tag } = req.body as {
    ids?: string
    action?: string
    tag?: string
  }
  if (!ids || !action) {
    res.redirect(`${base}/customers`)
    return
  }

  const customerIds = ids
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (customerIds.length === 0) {
    res.redirect(`${base}/customers`)
    return
  }

  // Parse `action` into a BulkAction. The form encodes parameterised
  // actions as `type:arg` (e.g. `set_lifecycle:churned`); flat actions
  // are just their type.
  const bulkAction = parseBulkAction(action, tag)
  if (!bulkAction) {
    console.warn('[Customer bulk] unknown action value:', action)
    res.redirect(`${base}/customers`)
    return
  }

  try {
    const result = await applyBulkAction(db, store.id, customerIds, bulkAction)

    // Audit log — one row per batch, details captures affected/skipped
    // so we can diagnose stale selections after the fact.
    await db
      .insertInto('audit_logs')
      .values({
        shop_id: store.id,
        user_id: user.id,
        action: 'update',
        resource_type: 'customer',
        resource_id: customerIds[0] ?? '',
        details: JSON.stringify({
          bulk: true,
          action: bulkAction.type,
          ...(bulkAction.type === 'set_lifecycle' && { stage: bulkAction.stage }),
          ...(bulkAction.type === 'add_tags' && { tags: bulkAction.tags }),
          ...(bulkAction.type === 'remove_tags' && { tags: bulkAction.tags }),
          requested: customerIds.length,
          affected: result.affected,
          skipped: result.skipped,
          matched: result.matched,
        }),
      })
      .execute()
      .catch(() => {})

    // Notification. Title uses natural-language phrasing ("5 customers
    // subscribed to marketing") rather than the raw action type.
    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'customers_bulk_updated',
      title: bulkTitle(result.affected, bulkAction),
      message: byActor(user),
      resourceType: 'customer',
      resourceId: null,
    })
  } catch (err: any) {
    console.error('[Customer bulk action error]', err?.message ?? err)
  }

  res.redirect(`${base}/customers`)
}

/**
 * Decode an HTML-form action string into a `BulkAction` or `null` if
 * the value is unrecognised. We accept:
 *   - `add_tags`, `remove_tags` — `tag` form field carries the value.
 *   - `set_lifecycle:<stage>` — colon-separated encoding.
 *   - `subscribe_marketing`, `unsubscribe_marketing`, `enable`, `disable`.
 *
 * Returning `null` for unknown values (instead of throwing) keeps the
 * handler resilient to a stale client sending an old action name.
 */
function parseBulkAction(raw: string, tag: string | undefined): BulkAction | null {
  const [head, arg] = raw.split(':', 2) as [string, string | undefined]
  switch (head) {
    case 'add_tags': {
      const tags = (tag ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      if (tags.length === 0) return null
      return { type: 'add_tags', tags }
    }
    case 'remove_tags': {
      const tags = (tag ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      if (tags.length === 0) return null
      return { type: 'remove_tags', tags }
    }
    case 'set_lifecycle': {
      if (arg !== 'new' && arg !== 'returning' && arg !== 'at_risk' && arg !== 'churned') {
        return null
      }
      return { type: 'set_lifecycle', stage: arg }
    }
    case 'subscribe_marketing':
      return { type: 'subscribe_marketing' }
    case 'unsubscribe_marketing':
      return { type: 'unsubscribe_marketing' }
    case 'enable':
      return { type: 'enable' }
    case 'disable':
      return { type: 'disable' }
    default:
      return null
  }
}

/** Natural-language phrasing for the bell notification title. */
function bulkTitle(affected: number, a: BulkAction): string {
  const n = `${affected} customer${affected === 1 ? '' : 's'}`
  switch (a.type) {
    case 'add_tags':
      return `${n} tagged with ${a.tags.join(', ')}`
    case 'remove_tags':
      return `${n} had tags removed`
    case 'set_lifecycle':
      return `${n} moved to ${a.stage}`
    case 'subscribe_marketing':
      return `${n} subscribed to marketing`
    case 'unsubscribe_marketing':
      return `${n} unsubscribed from marketing`
    case 'enable':
      return `${n} enabled`
    case 'disable':
      return `${n} disabled`
  }
}

// ---------------------------------------------------------------------------
// POST /customers/:id/notes — Phase 4 PR1 append note to timeline
// ---------------------------------------------------------------------------

export async function postCustomerAddNote(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  // Coerce to string — Express params can widen to string | string[] when
  // parametric middleware is in play; the service layer and audit_logs
  // column both want a plain string.
  const customerId = String(req.params.customerId ?? req.params.id ?? '')
  const backUrl = `/admin/store/${store.slug}/customers/${customerId}`

  const body = String(req.body?.body ?? '').trim()
  if (!body) {
    res.redirect(`${backUrl}?error=${encodeURIComponent('Note body is required')}`)
    return
  }

  try {
    const note = await addCustomerNote(db, {
      shop_id: store.id,
      customer_id: customerId,
      body,
      author_user_id: user.id,
      author_name_snapshot: user.name || user.email || 'Admin',
    })

    // Audit log — best effort; never block the redirect on logging.
    await db.insertInto('audit_logs')
      .values({
        shop_id: store.id,
        user_id: user.id,
        action: 'create',
        resource_type: 'customer_note',
        resource_id: note.id,
        details: JSON.stringify({ customer_id: customerId, body_length: body.length }),
      })
      .execute()
      .catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'customer_note_added',
      title: 'Customer note added',
      message: byActor(user),
      resourceType: 'customer',
      resourceId: customerId,
    })

    res.redirect(`${backUrl}?success=note_added`)
  } catch (err: any) {
    res.redirect(`${backUrl}?error=${encodeURIComponent(err.message || 'Failed to add note')}`)
  }
}

// ---------------------------------------------------------------------------
// POST /customers/:id/notes/:noteId/delete — Phase 4 PR1 delete note
// ---------------------------------------------------------------------------

export async function postCustomerDeleteNote(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const customerId = String(req.params.customerId ?? req.params.id ?? '')
  const noteId = String(req.params.noteId ?? '')
  const backUrl = `/admin/store/${store.slug}/customers/${customerId}`

  try {
    const ok = await deleteCustomerNote(db, {
      shop_id: store.id,
      note_id: noteId,
    })

    if (!ok) {
      // Cross-shop access or already-gone note — treat as idempotent.
      res.redirect(`${backUrl}?error=${encodeURIComponent('Note not found')}`)
      return
    }

    await db.insertInto('audit_logs')
      .values({
        shop_id: store.id,
        user_id: user.id,
        action: 'delete',
        resource_type: 'customer_note',
        resource_id: noteId,
        details: JSON.stringify({ customer_id: customerId }),
      })
      .execute()
      .catch(() => {})

    res.redirect(`${backUrl}?success=note_deleted`)
  } catch (err: any) {
    res.redirect(`${backUrl}?error=${encodeURIComponent(err.message || 'Failed to delete note')}`)
  }
}

// ---------------------------------------------------------------------------
// POST /customers/:id/tags — Phase 4 PR1 add/remove a single tag
// ---------------------------------------------------------------------------

const TAG_MAX_LENGTH = 64

export async function postCustomerUpdateTags(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const customerId = String(req.params.customerId ?? req.params.id ?? '')
  const backUrl = `/admin/store/${store.slug}/customers/${customerId}`

  const action = String(req.body?.action ?? '').trim()
  const tag = String(req.body?.tag ?? '').trim()

  if (action !== 'add' && action !== 'remove') {
    res.redirect(`${backUrl}?error=${encodeURIComponent('Invalid tag action')}`)
    return
  }
  if (!tag || tag.length > TAG_MAX_LENGTH) {
    res.redirect(`${backUrl}?error=${encodeURIComponent('Tag must be 1-64 characters')}`)
    return
  }

  try {
    const current = await db.selectFrom('customers')
      .select(['id', 'tags'])
      .where('id', '=', customerId)
      .where('shop_id', '=', store.id)
      .executeTakeFirst()

    if (!current) {
      res.redirect(`${backUrl}?error=${encodeURIComponent('Customer not found')}`)
      return
    }

    // Normalise existing tags to a deduped array regardless of whether the
    // column currently holds a Postgres text[] or a legacy CSV string.
    const rawTags = (current as any).tags
    const existing: string[] = Array.isArray(rawTags)
      ? rawTags.map((t: any) => String(t ?? '').trim()).filter(Boolean)
      : rawTags
        ? String(rawTags).split(',').map(t => t.trim()).filter(Boolean)
        : []

    let nextTags: string[]
    if (action === 'add') {
      if (existing.includes(tag)) {
        // No-op — already tagged. Still redirect cleanly.
        res.redirect(`${backUrl}?success=tag_exists`)
        return
      }
      nextTags = [...existing, tag]
    } else {
      nextTags = existing.filter(t => t !== tag)
    }

    await updateCustomer(db, store.id, customerId, {
      tags: nextTags.length > 0 ? nextTags : null,
    })

    await db.insertInto('audit_logs')
      .values({
        shop_id: store.id,
        user_id: user.id,
        action: 'update',
        resource_type: 'customer',
        resource_id: customerId,
        details: JSON.stringify({ tag_action: action, tag }),
      })
      .execute()
      .catch(() => {})

    // Use explicit past-tense suffix — "remove" + "ed" naively would
    // produce "removeed", which reads as a typo in the URL.
    const successKey = action === 'add' ? 'tag_added' : 'tag_removed'
    res.redirect(`${backUrl}?success=${successKey}`)
  } catch (err: any) {
    res.redirect(`${backUrl}?error=${encodeURIComponent(err.message || 'Failed to update tag')}`)
  }
}

// ---------------------------------------------------------------------------
// POST /customers/quick-filters — Phase 4 PR5: create or upsert a pill
// ---------------------------------------------------------------------------

/**
 * Save the currently-applied filters as a named pill (or update the
 * existing pill with the same name — upsert-by-name keeps the saved
 * set flat instead of letting two "VIPs" pills drift apart).
 *
 * Body:
 *   - `name`: 1..80 chars, trimmed
 *   - `q`, `lifecycle`, `marketing`, `tag`, `status`: the filter shape,
 *     same whitelist as the list-page URL params.
 *
 * On success we redirect back to the list with `?filter=<id>` so the
 * newly-saved pill is visually active. On validation failure we redirect
 * with `?error=...`.
 */
export async function postCustomerQuickFilterCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const body = req.body as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    res.redirect(`${base}/customers?error=${encodeURIComponent('Name is required')}`)
    return
  }

  const query: QuickFilterQuery = normalizeQuickFilterQuery({
    q: body.q,
    lifecycle: body.lifecycle,
    marketing: body.marketing,
    tag: body.tag,
    status: body.status,
  })

  try {
    const saved = await saveQuickFilter(db, store.id, {
      name,
      query,
      createdByUserId: user.id,
    })

    await db
      .insertInto('audit_logs')
      .values({
        shop_id: store.id,
        user_id: user.id,
        action: 'update',
        resource_type: 'customer_quick_filter',
        resource_id: saved.id,
        details: JSON.stringify({ name: saved.name, query: saved.filter_json }),
      })
      .execute()
      .catch(() => {})

    // Preserve the filter params + pin the pill id so the same view
    // re-opens (now visually "saved").
    const suffix = queryToParams(saved.filter_json)
    const sep = suffix ? '&' : ''
    res.redirect(`${base}/customers?filter=${saved.id}${sep}${suffix}`)
  } catch (err: any) {
    console.error('[Customer quick-filter create]', err?.message ?? err)
    res.redirect(`${base}/customers?error=${encodeURIComponent(err?.message ?? 'Failed to save view')}`)
  }
}

// ---------------------------------------------------------------------------
// POST /customers/quick-filters/:id/delete — Phase 4 PR5: remove a pill
// ---------------------------------------------------------------------------

/**
 * Delete one pill by id. Cross-shop / missing ids are a no-op (the
 * service returns `false` on misses). We audit-log successful deletes
 * so a malicious staffer can't silently wipe the saved views.
 */
export async function postCustomerQuickFilterDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  // `req.params.id` is typed as `string | string[]` in express 5; we
  // only honour the single-segment form.
  const rawId = req.params.id
  const filterId = typeof rawId === 'string' ? rawId : ''
  if (!filterId) {
    res.redirect(`${base}/customers`)
    return
  }

  try {
    // Read-before-delete so the audit row captures what was removed.
    const existing = await getQuickFilter(db, store.id, filterId)
    const removed = await deleteQuickFilter(db, store.id, filterId)

    if (removed && existing) {
      await db
        .insertInto('audit_logs')
        .values({
          shop_id: store.id,
          user_id: user.id,
          action: 'delete',
          resource_type: 'customer_quick_filter',
          resource_id: filterId,
          details: JSON.stringify({ name: existing.name, query: existing.filter_json }),
        })
        .execute()
        .catch(() => {})
    }
  } catch (err: any) {
    console.error('[Customer quick-filter delete]', err?.message ?? err)
  }

  res.redirect(`${base}/customers`)
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
