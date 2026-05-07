/**
 * Store-admin — Source-Site Tabs Helper (Phase 3, cleaned up in Phase 5)
 *
 * Shared library for the "Filter by source site" tab strip used across
 * five admin pages:
 *
 *   /admin/store/:slug/products
 *   /admin/store/:slug/pages
 *   /admin/store/:slug/blog
 *   /admin/store/:slug/collections
 *   /admin/store/:slug/navigation      (Menus)
 *
 * A "source site" is a `storefront_clone_jobs` row whose imports left
 * behind rows in one of the content tables (products, pages, blog_posts,
 * collections, menus). Each content table carries a nullable
 * `clone_job_id` column that we INNER JOIN against the clone_jobs table
 * to build the tab strip.
 *
 * Tabs rendered:
 *
 *   [ All (N) ]  [ Manual (N) ]  [ bibliobloom.com (N) ✏️ ]  [ More ▼ ]
 *
 * Rules (locked in by the owner during Phase 2):
 *   1. Tab label = merchant-editable `label`, falls back to
 *      `canonical_domain`, then to the source URL hostname.
 *   2. Pencil icon per clone-source tab → rename modal that POSTs to
 *      /admin/store/:slug/clone-pro/:jobId/rename.
 *   3. Up to 5 inline tabs. Overflow goes behind a "More ▼" dropdown.
 *
 * Phase 5 (2026-04-17): Removed the "Imported (unknown source)" orphan
 * tab and its supporting query/filter/render paths. Migration 044
 * retrofitted `products.clone_job_id` with `FOREIGN KEY ... ON DELETE
 * SET NULL`, joining the four sibling tables that already had the FK
 * since migration 042. With the FK in place, a clone-job row can no
 * longer be hard-deleted without NULL'ing its pointers — so orphan
 * rows are physically impossible and the old workaround tab became
 * dead code.
 *
 * Everything here is pure-ish: no I/O beyond the single Kysely query
 * in `getCloneSources`. The HTML/CSS/JS exports are plain strings and
 * the filter helpers mutate nothing.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

/**
 * Content tables that participate in source-site tabs. The column
 * `clone_job_id` is present on every one of these (migration 040 for
 * products, 042 for the rest).
 */
export type ContentTable =
  | 'products'
  | 'pages'
  | 'blog_posts'
  | 'collections'
  | 'menus'

/** One entry in the tab strip — always backed by a real clone_jobs row. */
export interface CloneSource {
  id: string
  source_url: string
  label: string | null
  canonical_domain: string | null
  item_count: number
}

/** Resolved filter value — 'all' means no filter; 'manual' means clone_job_id IS NULL. */
export type SourceFilter = 'all' | 'manual' | string

/** Aggregate loaded by `loadSourceTabsContext`. */
export interface SourceTabsContext {
  sources: CloneSource[]
  knownSourceIds: string[]
  filter: SourceFilter
  totalAll: number
  totalManual: number
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the clone-job list for one shop × one content table.
 *
 * Active clone jobs (discarded_at IS NULL) that currently have at least
 * one row in `contentTable` show up as tabs. A job whose content rows
 * have all been deleted disappears from the strip automatically via
 * the INNER JOIN.
 *
 * Post-migration-044 invariant: every non-NULL `clone_job_id` points
 * to an existing clone_jobs row (FK enforces it). We no longer need
 * an "Imported (unknown source)" fallback — if a job row is removed,
 * `ON DELETE SET NULL` demotes its content rows to `clone_job_id IS
 * NULL` and they show up in the Manual tab instead.
 */
export async function getCloneSources(
  db: Kysely<Database>,
  shopId: string,
  contentTable: ContentTable,
): Promise<CloneSource[]> {
  // INNER JOIN keeps the tab strip honest — jobs with zero remaining
  // rows (all products deleted, all pages re-slugged, etc.) don't
  // produce a tab. That also means an empty content table → zero tabs,
  // and the caller's `sources.length > 0` guard naturally hides the
  // strip. `(db as any)` because dynamic-table joins defeat Kysely's
  // column inference.
  const rows = await (db as any)
    .selectFrom('storefront_clone_jobs as sj')
    .innerJoin(`${contentTable} as ct`, 'ct.clone_job_id', 'sj.id')
    .select([
      'sj.id as id',
      'sj.source_url as source_url',
      'sj.label as label',
      'sj.canonical_domain as canonical_domain',
      'sj.created_at as created_at',
      (db as any).fn.count('ct.id').as('item_count'),
    ])
    .where('sj.shop_id', '=', shopId)
    .where('ct.shop_id', '=', shopId)
    .where('sj.discarded_at', 'is', null)
    .groupBy([
      'sj.id',
      'sj.source_url',
      'sj.label',
      'sj.canonical_domain',
      'sj.created_at',
    ])
    .orderBy('sj.created_at', 'desc')
    .execute()

  return (rows as any[]).map((r) => ({
    id: String(r.id),
    source_url: String(r.source_url ?? ''),
    label: r.label ? String(r.label) : null,
    canonical_domain: r.canonical_domain ? String(r.canonical_domain) : null,
    item_count: Number(r.item_count ?? 0),
  }))
}

/**
 * Parse the ?source= query param against the known-source set.
 *   - 'manual'          → clone_job_id IS NULL
 *   - <known job uuid>  → clone_job_id = <uuid>
 *   - anything else     → 'all' (no filter)
 *
 * Unknown ids fall back to 'all' intentionally so a stale bookmark
 * pointing at a discarded job doesn't 404 the page. Since Phase 5
 * (migration 044), any hypothetical "orphan" bookmark (pre-FK era)
 * also lands here as 'all' — the rows it used to point at are now
 * in the Manual tab.
 */
export function resolveSourceParam(
  sourceRaw: string,
  sources: CloneSource[],
): SourceFilter {
  const known = new Set(sources.map((s) => s.id))
  const v = (sourceRaw || '').trim().toLowerCase()
  if (v === 'manual') return 'manual'
  if (v && known.has(v)) return v
  return 'all'
}

/**
 * Apply the source filter to a Kysely query builder on `col` (the
 * content table's clone_job_id column). Returns the builder unchanged
 * when filter is 'all'.
 *
 * The function is generic so callers can pipe it into any stage of
 * their builder — it mutates nothing.
 */
export function applySourceFilter<Q extends { where: (...args: any[]) => Q }>(
  q: Q,
  col: string,
  filter: SourceFilter,
  _knownSourceIds: string[] = [],
): Q {
  if (filter === 'all') return q
  if (filter === 'manual') return q.where(col, 'is', null)
  // Concrete job uuid — resolveSourceParam has already validated this
  // against the known-source set, so callers can't leak filters across
  // shops.
  return q.where(col, '=', filter)
}

/**
 * Display label for a tab.
 * Preference: merchant-set label → canonical_domain → hostname of
 * source_url → raw source_url → 'Clone source'.
 */
export function cloneSourceLabel(c: CloneSource): string {
  if (c.label && c.label.trim()) return c.label.trim()
  if (c.canonical_domain && c.canonical_domain.trim()) return c.canonical_domain.trim()
  try {
    const u = new URL(c.source_url)
    return u.hostname.replace(/^www\./i, '')
  } catch {
    return c.source_url || 'Clone source'
  }
}

/**
 * One-shot loader — convenience wrapper used by every admin page.
 * Fetches sources, resolves the filter, and computes the All/Manual
 * totals that populate the first two tab badges.
 */
export async function loadSourceTabsContext(
  db: Kysely<Database>,
  shopId: string,
  contentTable: ContentTable,
  sourceRaw: string,
): Promise<SourceTabsContext> {
  const sources = await getCloneSources(db, shopId, contentTable)
  const knownSourceIds = sources.map((s) => s.id)
  const filter = resolveSourceParam(sourceRaw, sources)

  // All / Manual counts so the first two tabs always show accurate
  // badges regardless of which tab is active.
  const [allRow, manualRow] = await Promise.all([
    (db as any)
      .selectFrom(contentTable)
      .select((db as any).fn.count('id').as('count'))
      .where('shop_id', '=', shopId)
      .executeTakeFirst(),
    (db as any)
      .selectFrom(contentTable)
      .select((db as any).fn.count('id').as('count'))
      .where('shop_id', '=', shopId)
      .where('clone_job_id', 'is', null)
      .executeTakeFirst(),
  ])

  return {
    sources,
    knownSourceIds,
    filter,
    totalAll: Number(allRow?.count ?? 0),
    totalManual: Number(manualRow?.count ?? 0),
  }
}

// ---------------------------------------------------------------------------
// HTML renderers
// ---------------------------------------------------------------------------

/** Minimal HTML-escape — same behaviour as seller-layout's `esc`. */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface RenderSourceTabsOptions {
  /** Fully-loaded context from `loadSourceTabsContext`. */
  ctx: SourceTabsContext
  /** Function that builds a URL for a given filter value. */
  sourceUrl: (filter: SourceFilter) => string
  /** English label used in the "Rename source" modal copy (defaults to 'items'). */
  itemNoun?: string
  /** When true, renders nothing if no clone sources exist (the common case). */
  hideWhenEmpty?: boolean
}

/**
 * Render the source-site tab strip.
 *
 * Returns an empty string when there are no sources AND `hideWhenEmpty`
 * (default true) — callers get to splice the HTML into their template
 * unconditionally.
 *
 * The caller is responsible for also embedding `SOURCE_TABS_CSS`,
 * `sourceTabsScript(base)` (the JS), and `renderRenameModal(base, csrfField)`
 * somewhere on the page so the pencil button works.
 */
export function renderSourceTabsHtml(opts: RenderSourceTabsOptions): string {
  const { ctx, sourceUrl, hideWhenEmpty = true } = opts
  if (ctx.sources.length === 0 && hideWhenEmpty) return ''

  const { sources, filter, totalAll, totalManual } = ctx
  const MAX_INLINE = 5
  const inline = sources.slice(0, MAX_INLINE)
  const overflow = sources.slice(MAX_INLINE)
  const renameIcon = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8 8-4 1 1-4 8-8z"/></svg>`

  const renderTab = (c: CloneSource): string => {
    const isActive = filter === c.id
    return `
    <a href="${esc(sourceUrl(c.id))}" class="site-tab${isActive ? ' active' : ''}" data-source-id="${esc(c.id)}">
      <span class="site-tab-dot"></span>
      <span class="site-tab-label">${esc(cloneSourceLabel(c))}</span>
      <span class="site-tab-count">${c.item_count}</span>
      <button type="button" class="site-tab-edit" title="Rename this source"
              data-source-id="${esc(c.id)}" data-source-label="${esc(cloneSourceLabel(c))}"
              onclick="event.preventDefault();event.stopPropagation();openRenameModalFrom(this)">
        ${renameIcon}
      </button>
    </a>`
  }

  const renderOverflowItem = (c: CloneSource): string => {
    const isActive = filter === c.id
    return `
    <a href="${esc(sourceUrl(c.id))}" role="menuitem" class="site-tab-more-item${isActive ? ' active' : ''}">
      <span class="site-tab-dot"></span>
      <span>${esc(cloneSourceLabel(c))}</span>
      <span class="site-tab-count">${c.item_count}</span>
      <button type="button" class="site-tab-edit" title="Rename this source"
              data-source-id="${esc(c.id)}" data-source-label="${esc(cloneSourceLabel(c))}"
              onclick="event.preventDefault();event.stopPropagation();openRenameModalFrom(this)">
        ${renameIcon}
      </button>
    </a>`
  }

  return `
  <div class="site-tabs" role="tablist" aria-label="Filter by source site">
    <a href="${esc(sourceUrl('all'))}" class="site-tab${filter === 'all' ? ' active' : ''}">
      <span class="site-tab-label">All</span>
      <span class="site-tab-count">${totalAll}</span>
    </a>
    <a href="${esc(sourceUrl('manual'))}" class="site-tab${filter === 'manual' ? ' active' : ''}">
      <span class="site-tab-label">Manual</span>
      <span class="site-tab-count">${totalManual}</span>
    </a>
    ${inline.map(renderTab).join('')}
    ${overflow.length > 0 ? `
      <div class="site-tab-more">
        <button type="button" class="site-tab site-tab-more-btn" onclick="toggleSiteTabMore(this)" aria-haspopup="true" aria-expanded="false">
          More
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 4l3 3 3-3"/></svg>
        </button>
        <div class="site-tab-more-menu" role="menu">
          ${overflow.map(renderOverflowItem).join('')}
        </div>
      </div>
    ` : ''}
  </div>
  `
}

/**
 * HTML for the rename modal. Embed once per page. Works alongside
 * `sourceTabsScript(base)` which binds `openRenameModal` + friends.
 */
export function renderRenameModal(csrfField: string): string {
  return `
  <div class="gbx-modal-overlay" id="renameModal" onclick="if(event.target===this) closeRenameModal()">
    <form class="gbx-modal" role="dialog" aria-labelledby="renameModalTitle" aria-modal="true"
          method="POST" id="renameForm" action="">
      ${csrfField}
      <h2 class="gbx-modal-title info" id="renameModalTitle">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8 8-4 1 1-4 8-8z"/></svg>
        Rename source
      </h2>
      <p class="muted">Give this imported site a friendlier label for the tab. Leave blank to reset to the domain name.</p>
      <label class="gbx-field" for="renameInput">Tab label</label>
      <input type="text" name="label" id="renameInput" class="gbx-field-input" maxlength="60" placeholder="e.g. Bibliobloom Tea Shop">
      <div class="gbx-modal-actions">
        <button type="button" class="btn btn-outline" onclick="closeRenameModal()">Cancel</button>
        <button type="submit" class="btn btn-accent">Save</button>
      </div>
    </form>
  </div>`
}

// ---------------------------------------------------------------------------
// CSS & JS
// ---------------------------------------------------------------------------

/**
 * CSS for the tab strip + rename modal. Include once per page inside
 * the page's own `<style>` block.
 */
export const SOURCE_TABS_CSS = `
/* -----------------------------------------------------------------
 * Source-site tab strip (.site-tabs).
 *
 * Sits between the page title and the status/filter area. Each tab
 * represents one clone source plus two synthetic tabs: "All" and
 * "Manual". Active tab gets an indigo chip; hover shows the pencil
 * edit button (hidden by default so the default view stays calm).
 * The More ▼ overflow is an absolutely-positioned dropdown.
 * --------------------------------------------------------------- */
.site-tabs {
  display:flex; flex-wrap:wrap; gap:6px;
  margin:-8px 0 20px; padding:4px 0;
  align-items:center;
}
.site-tab {
  display:inline-flex; align-items:center; gap:6px;
  padding:6px 12px; border-radius:999px;
  font-size:12px; font-weight:600; line-height:1;
  color:var(--s-text-muted, #6b7280); text-decoration:none;
  border:1px solid var(--border, #e5e7eb);
  background:var(--s-card, #fff);
  transition:background .12s, color .12s, border-color .12s;
  position:relative;
  cursor:pointer;
}
.site-tab:hover {
  color:var(--s-text, #111);
  background:color-mix(in srgb, var(--s-accent, #6366f1) 8%, transparent);
  border-color:color-mix(in srgb, var(--s-accent, #6366f1) 30%, var(--border, #e5e7eb));
}
.site-tab.active {
  color:#fff;
  background:var(--s-accent, #6366f1);
  border-color:var(--s-accent, #6366f1);
}
.site-tab.active .site-tab-count {
  background:rgba(255,255,255,.22); color:#fff;
}
.site-tab-count {
  display:inline-block; padding:1px 7px; border-radius:8px;
  font-size:11px; font-weight:700; line-height:1.4;
  background:var(--s-surface-2, rgba(0,0,0,.05));
  color:var(--s-text-muted, #6b7280);
}
.site-tab-dot {
  display:inline-block; width:6px; height:6px; border-radius:50%;
  background:var(--s-accent, #6366f1); opacity:.6;
}
.site-tab.active .site-tab-dot { background:#fff; opacity:1; }
.site-tab-edit {
  display:inline-flex; align-items:center; justify-content:center;
  background:transparent; border:none; color:inherit;
  padding:2px; margin-left:2px; border-radius:4px;
  cursor:pointer; opacity:0;
  transition:opacity .12s, background .12s;
}
.site-tab:hover .site-tab-edit,
.site-tab.active .site-tab-edit { opacity:.75; }
.site-tab-edit:hover {
  opacity:1 !important;
  background:color-mix(in srgb, currentColor 18%, transparent);
}
/* More ▼ overflow */
.site-tab-more { position:relative; }
.site-tab-more-btn {
  display:inline-flex; align-items:center; gap:4px;
  padding:6px 10px; border-radius:999px;
  font-size:12px; font-weight:600;
  color:var(--s-text-muted, #6b7280);
  border:1px solid var(--border, #e5e7eb);
  background:var(--s-card, #fff);
  cursor:pointer;
}
.site-tab-more-btn:hover {
  color:var(--s-text, #111);
  background:color-mix(in srgb, var(--s-accent, #6366f1) 8%, transparent);
}
.site-tab-more-menu {
  display:none;
  position:absolute; top:calc(100% + 4px); right:0; z-index:30;
  min-width:220px; padding:6px;
  background:var(--s-card, #fff);
  border:1px solid var(--border, #e5e7eb);
  border-radius:10px;
  box-shadow:0 8px 24px rgba(0,0,0,.12);
}
.site-tab-more.open .site-tab-more-menu { display:block; }
.site-tab-more-item {
  display:flex; align-items:center; gap:8px;
  padding:8px 10px; border-radius:6px;
  font-size:13px; font-weight:500; text-decoration:none;
  color:var(--s-text, #111);
  position:relative;
}
.site-tab-more-item:hover {
  background:color-mix(in srgb, var(--s-accent, #6366f1) 10%, transparent);
}
.site-tab-more-item.active {
  background:color-mix(in srgb, var(--s-accent, #6366f1) 16%, transparent);
  color:var(--s-accent, #6366f1);
}
.site-tab-more-item .site-tab-count { margin-left:auto; }
.site-tab-more-item .site-tab-edit { opacity:.5; }
.site-tab-more-item:hover .site-tab-edit { opacity:1; }

/* -----------------------------------------------------------------
 * Rename-source modal (pencil icon → edit tab label).
 * Matches the shared .gbx-modal chrome used by the delete-confirm
 * modal for visual consistency.
 * --------------------------------------------------------------- */
.gbx-modal-overlay {
  display:none; position:fixed; inset:0; z-index:100;
  align-items:center; justify-content:center;
  background:rgba(0,0,0,.45);
  animation:modalIn .14s ease;
}
.gbx-modal-overlay.show { display:flex; }
@keyframes modalIn { from { opacity:0; } to { opacity:1; } }
.gbx-modal {
  width:min(480px, calc(100vw - 32px));
  padding:22px 22px 18px;
  border-radius:12px;
  background:var(--s-card, #fff);
  box-shadow:0 12px 32px rgba(0,0,0,.2);
  color:var(--s-text, #111);
}
.gbx-modal .gbx-modal-title {
  display:flex; align-items:center; gap:8px;
  font-size:16px; font-weight:600;
  margin:0 0 12px;
}
.gbx-modal .gbx-modal-title.info { color:var(--s-accent, #6366f1); }
.gbx-modal p { font-size:13px; line-height:1.5; margin:0 0 10px; }
.gbx-modal p.muted { color:var(--s-text-muted, #6b7280); }
.gbx-modal .gbx-modal-actions {
  display:flex; justify-content:flex-end; gap:8px;
  margin-top:18px;
}
.gbx-modal label.gbx-field {
  display:block; font-size:12px; font-weight:600;
  color:var(--s-text-muted, #6b7280); margin:12px 0 6px;
}
.gbx-modal input[type=text].gbx-field-input {
  width:100%; padding:10px 12px; font-size:14px;
  border:1px solid var(--border, #e5e7eb); border-radius:8px;
  background:var(--s-surface, #fff); color:var(--s-text, #111);
  outline:none;
  box-sizing:border-box;
}
.gbx-modal input[type=text].gbx-field-input:focus {
  border-color:var(--s-accent, #6366f1);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--s-accent, #6366f1) 18%, transparent);
}
.gbx-modal .btn-accent {
  background:var(--s-accent, #6366f1); color:#fff;
  border:1px solid var(--s-accent, #6366f1); font-weight:600;
}
.gbx-modal .btn-accent:hover { filter:brightness(.95); }
`

/**
 * JS bindings for the tab strip + rename modal. Embed once per page
 * inside the page's own `<script>` block. `base` is the admin base
 * (e.g. "/admin/store/my-shop") — the rename form POSTs to
 * `${base}/clone-pro/<jobId>/rename`.
 */
export function sourceTabsScript(base: string): string {
  const baseJson = JSON.stringify(base + '/clone-pro/')
  return `
/* ---------------------------------------------------------------
 * Source-tabs: rename modal + More ▼ overflow handlers.
 * Generated by apps/store-admin/src/lib/source-tabs.ts.
 * ------------------------------------------------------------- */
function openRenameModalFrom(btn) {
  openRenameModal(
    btn.getAttribute('data-source-id') || '',
    btn.getAttribute('data-source-label') || '',
  );
}
function openRenameModal(jobId, currentLabel) {
  var modal = document.getElementById('renameModal');
  if (!modal) return;
  var form = document.getElementById('renameForm');
  var input = document.getElementById('renameInput');
  form.action = ${baseJson} + encodeURIComponent(jobId) + '/rename';
  input.value = currentLabel || '';
  modal.classList.add('show');
  setTimeout(function(){ input.focus(); input.select(); }, 60);
}
function closeRenameModal() {
  var modal = document.getElementById('renameModal');
  if (modal) modal.classList.remove('show');
}

function toggleSiteTabMore(btn) {
  var wrap = btn.closest('.site-tab-more');
  if (!wrap) return;
  var isOpen = wrap.classList.toggle('open');
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}
document.addEventListener('click', function(e){
  var openMenu = document.querySelector('.site-tab-more.open');
  if (!openMenu) return;
  if (!openMenu.contains(e.target)) {
    openMenu.classList.remove('open');
    var btn = openMenu.querySelector('.site-tab-more-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', function(e){
  if (e.key !== 'Escape') return;
  closeRenameModal();
  var openMenu = document.querySelector('.site-tab-more.open');
  if (openMenu) openMenu.classList.remove('open');
});
`
}
