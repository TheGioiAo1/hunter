/**
 * Store Admin — Online Store > Navigation
 *
 * Shopify-style navigation builder. Calls Gbox-Shop-Service API.
 * Menu model: { id, name, location, position, items: Menu[], link }
 * Items are recursive Menu[] — no separate table, no parent_id.
 *
 * Views:
 *   GET /navigation          → list all menus
 *   GET /navigation?menu=ID  → menu editor
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { logSellerAction } from '../middleware/store-auth.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { createApiContext, listCategories, listProducts } from '../lib/product-api-client.js'
import { listPages } from '../lib/page-api-client.js'
import { fetchJson } from '../lib/api-fetch-json.js'
import { ProductApiError } from '../lib/product-api-errors.js'
import { getSessionTokenFromCookies } from '@gbox/core/modules/auth/session.js'
import { randomBytes } from 'crypto'

const MAX_DEPTH = 3

/**
 * Generate Mongo ObjectId-like 24-hex id cho menu items (BE Menu.cs có
 * BsonRepresentation(BsonType.ObjectId) trên field id; nested items không
 * auto-gen, FE phải set). Khi id thiếu → URL action `/items//delete` empty
 * param → Express 404. Fix: gen 12-byte hex tại tạo & lưu.
 */
function genMenuItemId(): string {
  return randomBytes(12).toString('hex')
}

/**
 * Đệ quy gán id cho mọi item thiếu/empty. Trả về items mới + flag changed
 * để caller PUT update lên BE.
 */
function healMissingItemIds(items: any[]): { items: any[]; changed: boolean; fixedCount: number } {
  let changed = false
  let fixedCount = 0
  function walk(arr: any[]): any[] {
    return arr.map((item) => {
      const childResult = walk(Array.isArray(item.items) ? item.items : [])
      if (childResult.some((c) => c !== item.items)) changed = true
      const id = String(item.id || '').trim()
      if (!id || id.startsWith('tmp_')) {
        changed = true
        fixedCount++
        return { ...item, id: genMenuItemId(), items: childResult }
      }
      return { ...item, items: childResult }
    })
  }
  const out = walk(items)
  return { items: out, changed, fixedCount }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiMenuItem {
  id?: string | null
  name?: string | null
  link?: string | null
  items?: ApiMenuItem[] | null
  position?: number | null
}

interface ApiMenu {
  id?: string | null
  name?: string | null
  location?: string | null
  position?: number | null
  items?: ApiMenuItem[] | null
  shop_id?: string | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHOP_BASE = (process.env.API_SHOP_BASE_URL || 'https://api-shop.gbox.co').replace(/\/+$/, '')

const KNOWN_LOCATION_LABELS: Record<string, string> = {
  header:      'Header',
  'main-menu': 'Header',
  footer:      'Footer',
  sidebar:     'Sidebar',
  mobile:      'Mobile',
}

function locationLabel(loc: string): string {
  return KNOWN_LOCATION_LABELS[loc] ??
    loc.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchAllMenus(token: string, shopId: string): Promise<ApiMenu[]> {
  try {
    const result = await fetchJson<ApiMenu[] | null>(
      `${SHOP_BASE}/api/${encodeURIComponent(shopId)}/menu`,
      { method: 'GET', token },
      'Menu',
    )
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

async function fetchMenuById(token: string, shopId: string, menuId: string): Promise<ApiMenu | null> {
  try {
    return await fetchJson<ApiMenu>(
      `${SHOP_BASE}/api/${encodeURIComponent(shopId)}/menu/${encodeURIComponent(menuId)}`,
      { method: 'GET', token },
      'Menu',
    )
  } catch (err: any) {
    if (err instanceof ProductApiError && (err.status === 404 || err.status === 403)) return null
    throw err
  }
}

async function createMenuApi(token: string, shopId: string, body: ApiMenu): Promise<ApiMenu | null> {
  return fetchJson<ApiMenu>(
    `${SHOP_BASE}/api/${encodeURIComponent(shopId)}/menu`,
    { method: 'POST', body: JSON.stringify(body), token },
    'Menu',
  )
}

async function updateMenuApi(token: string, shopId: string, menuId: string, body: ApiMenu): Promise<ApiMenu | null> {
  return fetchJson<ApiMenu>(
    `${SHOP_BASE}/api/${encodeURIComponent(shopId)}/menu/${encodeURIComponent(menuId)}`,
    { method: 'PUT', body: JSON.stringify(body), token },
    'Menu',
  )
}

async function deleteMenuApi(token: string, shopId: string, menuId: string): Promise<void> {
  await fetchJson<unknown>(
    `${SHOP_BASE}/api/${encodeURIComponent(shopId)}/menu/${encodeURIComponent(menuId)}`,
    { method: 'DELETE', token },
    'Menu',
  )
}


function getToken(req: Request): string {
  return getSessionTokenFromCookies(req.headers.cookie ?? '') ?? ''
}

// ---------------------------------------------------------------------------
// Item tree helpers
// ---------------------------------------------------------------------------

function countItems(items: ApiMenuItem[] | null | undefined): number {
  if (!items) return 0
  let count = items.length
  for (const item of items) count += countItems(item.items)
  return count
}

function findItemById(items: ApiMenuItem[], id: string): ApiMenuItem | null {
  for (const item of items) {
    if (item.id === id) return item
    const found = findItemById(item.items || [], id)
    if (found) return found
  }
  return null
}

function removeItemById(items: ApiMenuItem[], id: string): ApiMenuItem[] {
  return items
    .filter(item => item.id !== id)
    .map(item => ({ ...item, items: removeItemById(item.items || [], id) }))
}

function updateItemById(items: ApiMenuItem[], id: string, patch: Partial<ApiMenuItem>): ApiMenuItem[] {
  return items.map(item => {
    if (item.id === id) return { ...item, ...patch, items: item.items || [] }
    return { ...item, items: updateItemById(item.items || [], id, patch) }
  })
}

function addItemToParent(
  items: ApiMenuItem[],
  parentId: string | null,
  newItem: ApiMenuItem,
): ApiMenuItem[] {
  if (!parentId) return [...items, newItem]
  return items.map(item => {
    if (item.id === parentId) {
      return { ...item, items: [...(item.items || []), newItem] }
    }
    return { ...item, items: addItemToParent(item.items || [], parentId, newItem) }
  })
}

// Rebuild tree from flat {id, parent_id} list, preserving item data from existing tree
function rebuildTree(
  updates: Array<{ id: string; parent_id: string | null }>,
  itemMap: Map<string, ApiMenuItem>,
  parentId: string | null = null,
): ApiMenuItem[] {
  return updates
    .filter(u => (u.parent_id || null) === parentId)
    .map((u, i) => {
      const existing = itemMap.get(u.id) ?? { id: u.id, name: '', link: null }
      return {
        ...existing,
        position: i,
        items: rebuildTree(updates, itemMap, u.id),
      }
    })
}

function flattenToMap(items: ApiMenuItem[], map = new Map<string, ApiMenuItem>()): Map<string, ApiMenuItem> {
  for (const item of items) {
    map.set(item.id ?? '', { ...item, items: [] })
    flattenToMap(item.items || [], map)
  }
  return map
}

// Flatten recursive items to a tree node list for rendering
interface ItemNode extends ApiMenuItem {
  depth: number
  children: ItemNode[]
}

function buildRenderTree(items: ApiMenuItem[], depth = 0): ItemNode[] {
  if (depth >= MAX_DEPTH) return []
  return (items || []).map(item => ({
    ...item,
    depth,
    children: buildRenderTree(item.items || [], depth + 1),
  }))
}

function buildParentOpts(nodes: ItemNode[]): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = []
  function walk(list: ItemNode[]) {
    for (const n of list) {
      if (n.depth < MAX_DEPTH - 1) out.push({ id: n.id ?? '', label: '  '.repeat(n.depth) + (n.name ?? '') })
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

// ---------------------------------------------------------------------------
// Flat tree helpers
// ---------------------------------------------------------------------------

interface FlatNode {
  id: string
  name: string
  link: string
  depth: number
}

function flattenItems(items: ApiMenuItem[], depth = 0): FlatNode[] {
  if (depth >= MAX_DEPTH) return []
  const result: FlatNode[] = []
  for (const item of (items || [])) {
    result.push({ id: item.id ?? '', name: item.name ?? '', link: item.link ?? '', depth })
    if (item.items?.length) result.push(...flattenItems(item.items, depth + 1))
  }
  return result
}

function buildParentOptsFlat(nodes: FlatNode[]): Array<{ id: string; label: string }> {
  return nodes
    .filter(n => n.depth < MAX_DEPTH - 1 && n.id)
    .map(n => ({ id: n.id, label: '  '.repeat(n.depth) + n.name }))
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function navCss(): string {
  return `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    .nav-pg { font-family: 'Geist', ui-sans-serif, system-ui, sans-serif; }

    .nav-crumb { font-size:12px; color:var(--s-text-muted); margin-bottom:14px; }
    .nav-crumb a { color:var(--s-text-muted); text-decoration:none; }
    .nav-crumb a:hover { color:var(--s-text); }
    .nav-crumb-sep { margin:0 6px; opacity:.5; }

    .nav-tbl { width:100%; border-collapse:collapse; }
    .nav-tbl th {
      padding:10px 16px; font-size:11px; font-weight:600;
      text-transform:uppercase; letter-spacing:.05em;
      color:var(--s-text-muted); border-bottom:1px solid var(--s-border);
      text-align:left; white-space:nowrap;
    }
    .nav-tbl td { padding:14px 16px; border-bottom:1px solid var(--s-border); vertical-align:middle; }
    .nav-tbl tr:last-child td { border-bottom:none; }
    .nav-tbl tbody tr { cursor:pointer; transition:background .12s; }
    .nav-tbl tbody tr:hover td { background:var(--s-card-hover); }

    .nav-loc {
      display:inline-block; padding:3px 9px; border-radius:9999px;
      font-size:11px; font-weight:600;
      background:rgba(99,102,241,.1); color:var(--s-accent);
      border:1px solid rgba(99,102,241,.22);
    }

    .nav-title-input {
      font-size:22px; font-weight:700; background:transparent;
      border:1px solid transparent; outline:none; color:var(--s-text);
      padding:3px 8px; margin:-3px -8px; border-radius:7px;
      transition:background .15s, border-color .15s; width:auto; min-width:120px;
    }
    .nav-title-input:hover  { background:var(--s-card-hover); }
    .nav-title-input:focus  {
      background:var(--s-input-bg); border-color:var(--s-accent);
      box-shadow:0 0 0 3px rgba(99,102,241,.15);
    }

    .nav-tree   { list-style:none; padding:0; margin:0; }
    .nav-item-row {
      display:flex; align-items:center; gap:10px;
      padding:10px 13px; border:1px solid var(--s-border);
      border-radius:8px; background:var(--s-card);
      transition:border-color .12s;
    }
    .nav-item-row:hover { border-color:var(--s-border-light); }
    .nav-item-row.dragging { opacity:.35; }
    .nav-drop-before { box-shadow:0 -2px 0 var(--s-accent); }
    .nav-drop-after  { box-shadow:0 2px 0 var(--s-accent); }
    .nav-drop-inside { outline:2px dashed var(--s-accent); outline-offset:-3px; }

    .nav-drag-hdl {
      color:var(--s-text-dim); cursor:grab; flex-shrink:0;
      padding:4px 2px; border-radius:4px;
      display:flex; align-items:center;
    }
    .nav-drag-hdl:hover { color:var(--s-text-muted); }

    .nav-item-body { flex:1; min-width:0; }
    .nav-item-name { font-size:13px; font-weight:500; color:var(--s-text); display:flex; align-items:center; gap:6px; }
    .nav-item-url  {
      font-size:11px; color:var(--s-text-muted); margin-top:1px;
      font-family:ui-monospace,monospace;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:300px;
    }
    .nav-item-acts { display:flex; gap:4px; flex-shrink:0; }

    .nav-edit-form {
      display:grid; grid-template-columns:1fr 1fr auto auto;
      gap:8px; align-items:end;
      padding:12px 13px; border:1px solid var(--s-accent);
      border-radius:8px; background:var(--s-card);
    }

    .nav-add-block {
      border:2px dashed var(--s-border); border-radius:10px;
      padding:20px; transition:border-color .2s;
    }
    .nav-add-block:focus-within { border-color:var(--s-accent); border-style:solid; }

    .nav-picker-bd {
      position:fixed; inset:0; background:rgba(0,0,0,.48);
      display:none; align-items:center; justify-content:center; z-index:1000;
    }
    .nav-picker-bd.open { display:flex; }
    .nav-picker-panel {
      width:min(580px,95vw); max-height:78vh;
      background:var(--s-card); border:1px solid var(--s-border);
      border-radius:14px; display:flex; flex-direction:column; overflow:hidden;
      box-shadow:0 20px 60px rgba(0,0,0,.35);
    }
    .nav-picker-head {
      padding:16px 20px; border-bottom:1px solid var(--s-border);
      display:flex; align-items:center; gap:10px;
    }
    .nav-picker-tabs {
      display:flex; gap:4px; padding:10px 20px;
      border-bottom:1px solid var(--s-border);
    }
    .nav-picker-tab {
      padding:4px 12px; border:1px solid var(--s-border); border-radius:9999px;
      background:transparent; color:var(--s-text-muted);
      font-size:12px; font-weight:500; cursor:pointer; transition:all .12s;
    }
    .nav-picker-tab:hover { color:var(--s-text); }
    .nav-picker-tab.active { background:var(--s-accent); color:#fff; border-color:transparent; }
    .nav-picker-list { flex:1; overflow-y:auto; padding:6px 0; }
    .nav-picker-hit {
      padding:10px 20px; cursor:pointer;
      display:flex; align-items:center; gap:10px; transition:background .1s;
    }
    .nav-picker-hit:hover { background:rgba(99,102,241,.07); }
    .nav-picker-hit-type {
      font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px;
      background:rgba(99,102,241,.1); color:var(--s-accent);
      text-transform:uppercase; letter-spacing:.04em; flex-shrink:0;
    }

    .nav-create-bd {
      position:fixed; inset:0; background:rgba(0,0,0,.48);
      display:none; align-items:center; justify-content:center; z-index:1000;
    }
    .nav-create-bd.open { display:flex; }
    .nav-create-panel {
      width:min(460px,95vw);
      background:var(--s-card); border:1px solid var(--s-border);
      border-radius:14px; overflow:hidden;
      box-shadow:0 20px 60px rgba(0,0,0,.35);
    }

    .nav-empty {
      padding:40px 20px; text-align:center; color:var(--s-text-muted);
    }
    .nav-empty p:first-of-type { font-weight:600; color:var(--s-text); margin-bottom:4px; }
    .nav-empty p { margin:0 0 4px; font-size:13px; }

    .nav-flash {
      padding:10px 14px; border-radius:8px; margin-bottom:16px;
      background:rgba(34,197,94,.08); border:1px solid rgba(34,197,94,.25);
      color:#22c55e; font-size:13px;
    }

    .nav-input {
      padding:8px 12px; border:1px solid var(--s-border); border-radius:8px;
      font-size:13px; background:var(--s-input-bg); color:var(--s-text);
      outline:none; width:100%; box-sizing:border-box; transition:border-color .15s;
    }
    .nav-input:focus { border-color:var(--s-accent); box-shadow:0 0 0 3px rgba(99,102,241,.1); }

    /* flat tree */
    .nav-flat-list { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:6px; position:relative; }
    .nav-flat-item { list-style:none; position:relative; transition:padding-left .15s; }
    .nav-flat-item[data-depth="1"] { padding-left:36px; }
    .nav-flat-item[data-depth="2"] { padding-left:72px; }
    .nav-flat-item[data-depth="1"]::before,
    .nav-flat-item[data-depth="2"]::before {
      content:''; position:absolute; left:12px; top:0; bottom:0; width:2px;
      background:rgba(99,102,241,.18); border-radius:1px;
    }
    .nav-flat-item[data-depth="2"]::before { left:48px; }

    /* drop indicator line */
    #nav-drop-indicator {
      position:fixed; height:2px; background:var(--s-accent);
      border-radius:2px; pointer-events:none; z-index:9999;
      box-shadow:0 0 6px rgba(99,102,241,.5);
      display:none;
    }
    #nav-drop-indicator::before {
      content:''; position:absolute; left:-4px; top:-4px;
      width:10px; height:10px; border-radius:50%;
      background:var(--s-accent);
    }
  </style>`
}

// ---------------------------------------------------------------------------
// SVG icons
// ---------------------------------------------------------------------------

const DRAG_ICON  = `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="4" cy="3" r="1.2"/><circle cx="4" cy="7" r="1.2"/><circle cx="4" cy="11" r="1.2"/><circle cx="10" cy="3" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="10" cy="11" r="1.2"/></svg>`
const EDIT_ICON  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 16.5-16.5z"/></svg>`
const DEL_ICON   = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`
const CLOSE_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
const LINK_ICON  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--s-text-muted)" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`

// ---------------------------------------------------------------------------
// Item node renderer
// ---------------------------------------------------------------------------

function renderItemNode(
  node: ItemNode,
  base: string,
  csrfField: string,
  editingId: string | null,
  menuId: string,
): string {
  const id   = node.id ?? ''
  const name = node.name ?? ''
  const link = node.link ?? ''
  const isEditing = editingId === id
  const urlUpdate = `${base}/online-store/navigation/items/${esc(id)}/update`
  const urlDelete = `${base}/online-store/navigation/items/${esc(id)}/delete`

  const body = isEditing
    ? `<form method="POST" action="${urlUpdate}" class="nav-edit-form">
        ${csrfField}
        <input type="hidden" name="menu_id" value="${esc(menuId)}">
        <div>
          <label style="display:block;font-size:11px;font-weight:600;margin-bottom:4px;color:var(--s-text-muted)">Label</label>
          <input class="nav-input" style="padding:7px 10px;font-size:13px" type="text" name="name" value="${esc(name)}" required maxlength="255">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;margin-bottom:4px;color:var(--s-text-muted)">URL</label>
          <input class="nav-input" style="padding:7px 10px;font-size:13px" type="text" name="link" value="${esc(link)}">
        </div>
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
        <a href="${base}/online-store/navigation?menu=${esc(menuId)}" class="btn btn-outline btn-sm" style="text-decoration:none">Cancel</a>
       </form>`
    : `<div class="nav-item-row" draggable="true"
          data-item-id="${esc(id)}"
          data-name="${esc(name)}"
          data-link="${esc(link)}"
          data-parent-id=""
          data-depth="${node.depth}">
          <div class="nav-drag-hdl" title="Drag to reorder">${DRAG_ICON}</div>
          <div class="nav-item-body">
            <div class="nav-item-name">${esc(name)}</div>
            <div class="nav-item-url">${esc(link || '—')}</div>
          </div>
          <div class="nav-item-acts">
            <a href="${base}/online-store/navigation?menu=${esc(menuId)}&amp;edit=${esc(id)}"
               class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 8px;text-decoration:none" title="Edit">${EDIT_ICON}</a>
            <form method="POST" action="${urlDelete}"
                  onsubmit="return confirm('Remove \\u201c${esc(name).replace(/'/g, "\\'")}\\u201d?')" style="margin:0">
              ${csrfField}
              <input type="hidden" name="menu_id" value="${esc(menuId)}">
              <button type="submit" class="btn btn-outline btn-sm"
                      style="font-size:11px;padding:4px 8px;color:var(--s-danger);border-color:rgba(239,68,68,.3)"
                      title="Remove">${DEL_ICON}</button>
            </form>
          </div>
        </div>`

  const childrenHtml = node.children.length > 0
    ? `<ul class="nav-tree" style="padding-left:32px;margin-top:8px;display:flex;flex-direction:column;gap:8px">
         ${node.children.map(c => renderItemNode(c, base, csrfField, editingId, menuId)).join('')}
       </ul>`
    : ''

  return `<li style="list-style:none" data-node-id="${esc(id)}">${body}${childrenHtml}</li>`
}

function renderTree(
  nodes: ItemNode[],
  base: string,
  csrfField: string,
  editingId: string | null,
  menuId: string,
): string {
  if (nodes.length === 0) {
    return `<div class="nav-empty">
      <svg style="margin:0 auto 12px;display:block;opacity:.3" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--s-text-muted)" stroke-width="1.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="16" y2="12"/><line x1="3" y1="18" x2="12" y2="18"/></svg>
      <p>No items yet</p>
      <p style="color:var(--s-text-muted)">Add your first item using the form below.</p>
    </div>`
  }
  return `<ul class="nav-tree" style="display:flex;flex-direction:column;gap:8px">
    ${nodes.map(n => renderItemNode(n, base, csrfField, editingId, menuId)).join('')}
  </ul>`
}

// ---------------------------------------------------------------------------
// Flat item + tree renderer
// ---------------------------------------------------------------------------

function renderFlatItem(
  node: FlatNode,
  base: string,
  csrfField: string,
  editingId: string | null,
  menuId: string,
): string {
  const { id, name, link, depth } = node
  const urlUpdate = `${base}/online-store/navigation/items/${esc(id)}/update`
  const urlDelete = `${base}/online-store/navigation/items/${esc(id)}/delete`

  const body = editingId === id
    ? `<form method="POST" action="${urlUpdate}" class="nav-edit-form">
        ${csrfField}
        <input type="hidden" name="menu_id" value="${esc(menuId)}">
        <div>
          <label style="display:block;font-size:11px;font-weight:600;margin-bottom:4px;color:var(--s-text-muted)">Label</label>
          <input class="nav-input" style="padding:7px 10px;font-size:13px" type="text" name="name" value="${esc(name)}" required maxlength="255">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;margin-bottom:4px;color:var(--s-text-muted)">URL</label>
          <input class="nav-input" style="padding:7px 10px;font-size:13px" type="text" name="link" value="${esc(link)}">
        </div>
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
        <a href="${base}/online-store/navigation?menu=${esc(menuId)}" class="btn btn-outline btn-sm" style="text-decoration:none">Cancel</a>
       </form>`
    : `<div class="nav-item-row"
          data-item-id="${esc(id)}"
          data-name="${esc(name)}"
          data-link="${esc(link)}"
          data-depth="${depth}">
          <div class="nav-drag-hdl" draggable="true" title="Drag to reorder">${DRAG_ICON}</div>
          <div class="nav-item-body">
            <div class="nav-item-name">${esc(name)}</div>
            <div class="nav-item-url">${esc(link || '—')}</div>
          </div>
          <div class="nav-item-acts">
            <a href="${base}/online-store/navigation?menu=${esc(menuId)}&amp;edit=${esc(id)}"
               class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 8px;text-decoration:none" title="Edit">${EDIT_ICON}</a>
            <form method="POST" action="${urlDelete}"
                  onsubmit="return confirm('Remove \\u201c${esc(name).replace(/'/g, "\\'")}\\u201d?')" style="margin:0">
              ${csrfField}
              <input type="hidden" name="menu_id" value="${esc(menuId)}">
              <button type="submit" class="btn btn-outline btn-sm"
                      style="font-size:11px;padding:4px 8px;color:var(--s-danger);border-color:rgba(239,68,68,.3)"
                      title="Remove">${DEL_ICON}</button>
            </form>
          </div>
        </div>`

  return `<li class="nav-flat-item" data-item-id="${esc(id)}" data-depth="${depth}">${body}</li>`
}

function renderFlatTree(
  nodes: FlatNode[],
  base: string,
  csrfField: string,
  editingId: string | null,
  menuId: string,
): string {
  if (nodes.length === 0) {
    return `<div class="nav-empty" id="nav-tree-empty">
      <svg style="margin:0 auto 12px;display:block;opacity:.3" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--s-text-muted)" stroke-width="1.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="16" y2="12"/><line x1="3" y1="18" x2="12" y2="18"/></svg>
      <p>No items yet</p>
      <p style="color:var(--s-text-muted)">Add your first item using the form below.</p>
    </div>`
  }
  return `<ul class="nav-flat-list" id="nav-tree-list">
    ${nodes.map(n => renderFlatItem(n, base, csrfField, editingId, menuId)).join('')}
  </ul>`
}

// ---------------------------------------------------------------------------
// Picker modal JS
// ---------------------------------------------------------------------------

function pickerScript(base: string): string {
  return `
    var _pickerBase=${JSON.stringify(base)};
    (function(){
      var modal=document.getElementById('nav-picker-modal');
      var opener=document.getElementById('nav-picker-btn');
      var closer=document.getElementById('nav-picker-close');
      var search=document.getElementById('nav-picker-search');
      var list=document.getElementById('nav-picker-list');
      var typeBtns=modal?modal.querySelectorAll('.nav-picker-tab'):[];
      var urlField=document.getElementById('nav-add-url');
      var clearBtn=document.getElementById('nav-res-clear');
      var chip=document.getElementById('nav-res-chip');
      var chipLbl=document.getElementById('nav-res-chip-lbl');
      var activeType='', debounce=null, _reqSeq=0;
      function openModal(){if(!modal)return;modal.classList.add('open');modal.setAttribute('aria-hidden','false');if(search){search.value='';search.focus()}loadHits()}
      function closeModal(){if(!modal)return;modal.classList.remove('open');modal.setAttribute('aria-hidden','true')}
      async function loadHits(){
        if(!list)return;
        var seq=++_reqSeq;
        var q=search?search.value.trim():'';
        var qs=new URLSearchParams();if(q)qs.set('q',q);if(activeType)qs.set('type',activeType);
        list.innerHTML='<div style="padding:20px;text-align:center;color:var(--s-text-muted);font-size:13px">Loading…</div>';
        try{
          var r=await fetch(_pickerBase+'/online-store/navigation/resources?'+qs,{headers:{'Accept':'application/json'},credentials:'same-origin'});
          if(seq!==_reqSeq)return;
          if(!r.ok)throw new Error('HTTP '+r.status);
          var d=await r.json();
          if(seq!==_reqSeq)return;
          renderHits(d.hits||[]);
        }catch(e){if(seq!==_reqSeq)return;list.innerHTML='<div style="padding:20px;text-align:center;color:var(--s-danger);font-size:13px">'+(e&&e.message||'Failed')+'</div>'}
      }
      function renderHits(hits){
        if(!hits.length){list.innerHTML='<div style="padding:20px;text-align:center;color:var(--s-text-muted);font-size:13px">No results.</div>';return}
        list.innerHTML=hits.map(function(h){
          var t=String(h.type||'');
          var lbl=({product:'Product',collection:'Collection',page:'Page',blog_post:'Blog'})[t]||t;
          function esc2(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
          return '<div class="nav-picker-hit" role="button" tabindex="0" data-title="'+esc2(h.title)+'" data-url="'+esc2(h.url)+'">'+
            '<span class="nav-picker-hit-type">'+lbl+'</span>'+
            '<span style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500">'+esc2(h.title)+'</div>'+
            '<div style="font-size:11px;color:var(--s-text-muted);font-family:monospace">'+esc2(h.url)+'</div></span></div>';
        }).join('');
        list.querySelectorAll('.nav-picker-hit').forEach(function(el){
          el.addEventListener('click',function(){selectHit(el)});
          el.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();selectHit(el)}});
        });
      }
      function selectHit(el){
        var title=el.getAttribute('data-title')||'',url=el.getAttribute('data-url')||'';
        if(urlField)urlField.value=url;
        if(chip&&chipLbl){chipLbl.textContent='Linked to '+title;chip.style.display=''}
        var tf=document.querySelector('#nav-add-form input[name="name"]');
        if(tf&&!tf.value.trim())tf.value=title;
        closeModal();
      }
      if(opener)opener.addEventListener('click',openModal);
      if(closer)closer.addEventListener('click',closeModal);
      if(modal)modal.addEventListener('click',function(e){if(e.target===modal)closeModal()});
      document.addEventListener('keydown',function(e){if(e.key==='Escape'&&modal&&modal.classList.contains('open'))closeModal()});
      if(search)search.addEventListener('input',function(){if(debounce)clearTimeout(debounce);debounce=setTimeout(loadHits,150)});
      typeBtns.forEach(function(btn){
        btn.addEventListener('click',function(){
          typeBtns.forEach(function(b){b.classList.remove('active');b.setAttribute('aria-selected','false')});
          btn.classList.add('active');btn.setAttribute('aria-selected','true');
          activeType=btn.getAttribute('data-type')||'';loadHits();
        });
      });
      if(clearBtn)clearBtn.addEventListener('click',function(){if(chip)chip.style.display='none';if(chipLbl)chipLbl.textContent='';if(urlField)urlField.value='';});
    })();`
}

function dragDropScript(base: string, menuId: string): string {
  // base and menuId unused here but kept in signature for consistency
  void base; void menuId
  return `
  (function(){
    var MAX=${MAX_DEPTH};
    var dragLi=null,indEl=null,overLi=null,overPos='after',overDepth=0;

    function mkInd(){
      var d=document.createElement('div');d.id='nav-drop-indicator';document.body.appendChild(d);return d;
    }
    function getInd(){return indEl||(indEl=document.getElementById('nav-drop-indicator')||mkInd());}
    function hideInd(){getInd().style.display='none';}
    function showInd(li,pos,depth){
      var ind=getInd();
      var listEl=document.getElementById('nav-tree-list');if(!listEl)return;
      var listRect=listEl.getBoundingClientRect();
      var liRect=li.getBoundingClientRect();
      var indent=depth*36+12;
      ind.style.display='block';
      ind.style.top=((pos==='before'?liRect.top:liRect.bottom)-1)+'px';
      ind.style.left=(listRect.left+indent)+'px';
      ind.style.width=(listRect.width-indent)+'px';
    }
    function liDepth(li){return parseInt(li.getAttribute('data-depth')||'0',10);}
    function getLi(el){while(el&&el.tagName!=='LI'){el=el.parentElement;}return el&&el.classList.contains('nav-flat-item')?el:null;}
    function prevSibLi(li){var p=li.previousElementSibling;while(p&&!p.classList.contains('nav-flat-item'))p=p.previousElementSibling;return p;}

    document.addEventListener('dragstart',function(e){
      // draggable="true" is on .nav-drag-hdl, so e.target IS the handle (or SVG child)
      var hdl=e.target&&e.target.closest?e.target.closest('.nav-drag-hdl'):null;
      if(!hdl)return;
      dragLi=hdl.closest('.nav-flat-item');if(!dragLi)return;
      dragLi.style.opacity='0.35';
      e.dataTransfer.effectAllowed='move';
      try{e.dataTransfer.setDragImage(dragLi,20,10);}catch(x){}
      try{e.dataTransfer.setData('text/plain',dragLi.getAttribute('data-item-id')||'');}catch(x){}
    });
    document.addEventListener('dragend',function(){
      if(dragLi)dragLi.style.opacity='';
      dragLi=null;hideInd();
    });
    document.addEventListener('dragover',function(e){
      if(!dragLi)return;
      var li=getLi(e.target);if(!li||li===dragLi){hideInd();return;}
      e.preventDefault();e.dataTransfer.dropEffect='move';
      var rect=li.getBoundingClientRect();
      var listEl=document.getElementById('nav-tree-list');
      var listLeft=listEl?listEl.getBoundingClientRect().left:0;
      var mouseX=e.clientX-listLeft-12;
      var pos=e.clientY<rect.top+rect.height/2?'before':'after';
      // depth from mouse X position (right = deeper)
      var rawDepth=Math.min(MAX-1,Math.max(0,Math.floor(mouseX/36)));
      // can only nest 1 level deeper than the item before drop position
      var refLi=pos==='before'?prevSibLi(li):li;
      var maxDepth=refLi?liDepth(refLi)+1:0;
      var depth=Math.min(rawDepth,maxDepth);
      overLi=li;overPos=pos;overDepth=depth;
      showInd(li,pos,depth);
    });
    var _autoSaveTimer=null;
    document.addEventListener('drop',function(e){
      hideInd();
      if(!dragLi||!overLi){return;}
      e.preventDefault();
      var ul=document.getElementById('nav-tree-list');if(!ul)return;
      if(overPos==='before'){overLi.parentNode.insertBefore(dragLi,overLi);}
      else{overLi.parentNode.insertBefore(dragLi,overLi.nextSibling);}
      // update depth
      dragLi.setAttribute('data-depth',String(overDepth));
      var row=dragLi.querySelector('.nav-item-row');
      if(row)row.setAttribute('data-depth',String(overDepth));
      dragLi=null;overLi=null;
      if(typeof window.navMarkChanged==='function')window.navMarkChanged();
      // Auto-save sau drag — debounce 600ms cho phép user drag nhiều item liên tục.
      // User chỉ cần kéo lên/xuống là xong, không cần bấm Save thủ công.
      if(_autoSaveTimer)clearTimeout(_autoSaveTimer);
      _autoSaveTimer=setTimeout(function(){
        if(typeof window.navSave==='function')window.navSave();
      },600);
    });
  })();`
}

// ---------------------------------------------------------------------------
// Add-item + Save script (client-side SPA interaction)
// ---------------------------------------------------------------------------

function addItemScript(base: string, menuId: string): string {
  const dragSvgStr = JSON.stringify(DRAG_ICON)
  const editIconStr = JSON.stringify(EDIT_ICON)
  const delIconStr = JSON.stringify(DEL_ICON)
  return `
  (function(){
    var _base=${JSON.stringify(base)};
    var _menuId=${JSON.stringify(menuId)};
    var _dragSvg=${dragSvgStr};
    var _editIcon=${editIconStr};
    var _delIcon=${delIconStr};
    window._navHasChanges=false;

    window.navMarkChanged=function(){
      window._navHasChanges=true;
      var btn=document.getElementById('nav-save-btn');
      if(btn)btn.removeAttribute('disabled');
    };

    window.navRemoveItem=function(btn){
      var li=btn&&btn.closest?btn.closest('.nav-flat-item'):null;
      if(li)li.remove();
      if(typeof window.navMarkChanged==='function')window.navMarkChanged();
    };

    function e_(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

    window.navAddItem=function(ev){
      if(ev&&ev.preventDefault)ev.preventDefault();
      var form=document.getElementById('nav-add-form');
      var nameEl=form&&form.querySelector('[name="name"]');
      var linkEl=form&&form.querySelector('[name="link"]');
      var parentEl=form&&form.querySelector('[name="parent_id"]');
      var name=nameEl?nameEl.value.trim():'';
      var link=linkEl?linkEl.value.trim():'';
      var parentId=parentEl?parentEl.value.trim():'';
      if(!name){if(nameEl)nameEl.focus();return false;}

      var depth=0;
      if(parentId){
        var parentLi=document.querySelector('[data-item-id="'+parentId+'"]');
        depth=parentLi?Math.min(${MAX_DEPTH}-1,parseInt(parentLi.getAttribute('data-depth')||'0',10)+1):1;
      }

      var tempId='tmp_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
      var li=document.createElement('li');
      li.className='nav-flat-item';
      li.setAttribute('data-item-id',tempId);
      li.setAttribute('data-depth',String(depth));
      li.innerHTML=
        '<div class="nav-item-row" data-item-id="'+tempId+'" data-name="'+e_(name)+'" data-link="'+e_(link)+'" data-depth="'+depth+'">'+
        '<div class="nav-drag-hdl" draggable="true" title="Drag to reorder">'+_dragSvg+'</div>'+
        '<div class="nav-item-body">'+
          '<div class="nav-item-name">'+e_(name)+'</div>'+
          '<div class="nav-item-url">'+e_(link||'—')+'</div>'+
        '</div>'+
        '<div class="nav-item-acts">'+
          '<button type="button" onclick="navRemoveItem(this)" class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 8px;color:var(--s-danger);border-color:rgba(239,68,68,.3)" title="Remove">&#xD7;</button>'+
        '</div>'+
        '</div>';

      // find insert position: after last child of parent, or at end of list
      var ul=document.getElementById('nav-tree-list');
      var empty=document.getElementById('nav-tree-empty');
      if(empty){
        var newUl=document.createElement('ul');
        newUl.className='nav-flat-list';newUl.id='nav-tree-list';
        empty.parentNode.replaceChild(newUl,empty);
        ul=newUl;
      }
      if(ul){
        if(parentId){
          // insert after the last item that has this parentId in ancestry
          var all=ul.querySelectorAll('.nav-flat-item');
          var lastChild=null;
          var inParent=false;
          for(var i=0;i<all.length;i++){
            if(all[i].getAttribute('data-item-id')===parentId)inParent=true;
            if(inParent){
              var d=parseInt(all[i].getAttribute('data-depth')||'0',10);
              if(all[i].getAttribute('data-item-id')===parentId||d>parseInt((all[i-1]&&all[i-1].getAttribute('data-depth'))||'0',10)){
                lastChild=all[i];
              }else if(d<=depth&&all[i].getAttribute('data-item-id')!==parentId){break;}
              else{lastChild=all[i];}
            }
          }
          if(lastChild&&lastChild.nextSibling)ul.insertBefore(li,lastChild.nextSibling);
          else ul.appendChild(li);
        }else{ul.appendChild(li);}
      }

      if(nameEl)nameEl.value='';
      if(linkEl)linkEl.value='';
      if(parentEl)parentEl.value='';
      var chip=document.getElementById('nav-res-chip');if(chip)chip.style.display='none';

      // add to parent select
      if(depth<${MAX_DEPTH}-1){
        var sel=form&&form.querySelector('[name="parent_id"]');
        if(sel){var opt=document.createElement('option');opt.value=tempId;opt.textContent='  '.repeat(depth)+name;sel.appendChild(opt);}
      }

      window.navMarkChanged();
      if(nameEl)nameEl.focus();
      return false;
    };

    function navCollectFlat(){
      var ul=document.getElementById('nav-tree-list');if(!ul)return[];
      var result=[];
      ul.querySelectorAll(':scope > .nav-flat-item').forEach(function(li){
        var row=li.querySelector('.nav-item-row');if(!row)return;
        var id=row.getAttribute('data-item-id')||'';
        var name=(row.getAttribute('data-name')||li.querySelector('.nav-item-name').textContent||'').trim();
        var link=row.getAttribute('data-link')||'';
        if(!link){var u=li.querySelector('.nav-item-url');if(u){var t=u.textContent.trim();if(t!=='—')link=t;}}
        var depth=parseInt(li.getAttribute('data-depth')||'0',10);
        result.push({id:id.startsWith('tmp_')?null:id,name:name,link:link||null,depth:depth});
      });
      return result;
    }

    function flatToTree(flat){
      var roots=[];
      var stack=[];// stack[depth] = current node
      flat.forEach(function(item){
        var node={name:item.name,link:item.link,items:[]};
        if(item.id)node.id=item.id;
        var d=item.depth||0;
        if(d===0){roots.push(node);stack=[node];}
        else{
          var parent=stack[d-1];
          if(parent){parent.items.push(node);}else{roots.push(node);}
          stack[d]=node;
          stack.length=d+1;
        }
      });
      return roots;
    }

    window.navSave=async function(){
      var btn=document.getElementById('nav-save-btn');
      var flat=navCollectFlat();
      var items=flatToTree(flat);
      var tk=(document.querySelector('meta[name="csrf-token"]')||{getAttribute:function(){return'';}}).getAttribute('content')||
             (document.querySelector('input[name="_csrf"]')||{value:''}).value;
      if(btn){btn.disabled=true;btn.textContent='Saving…';}
      try{
        var r=await fetch(_base+'/online-store/navigation/menus/'+_menuId+'/save-items',{
          method:'POST',credentials:'same-origin',
          headers:{'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':tk},
          body:JSON.stringify({items:items,_csrf:tk})
        });
        if(!r.ok)throw new Error('HTTP '+r.status);
        window._navHasChanges=false;
        window.location.href=_base+'/online-store/navigation?menu='+encodeURIComponent(_menuId)+'&flash=updated';
      }catch(ex){
        if(btn){btn.disabled=false;btn.textContent='Save';}
        alert('Could not save: '+((ex&&ex.message)||'Unknown error'));
      }
    };

    window.addEventListener('beforeunload',function(e){
      if(window._navHasChanges){e.preventDefault();e.returnValue='';}
    });
  })();`
}

// ---------------------------------------------------------------------------
// Picker modal HTML
// ---------------------------------------------------------------------------

function renderPickerModal(): string {
  return `
    <div class="nav-picker-bd" id="nav-picker-modal" aria-hidden="true">
      <div class="nav-picker-panel" role="dialog" aria-modal="true" aria-labelledby="nav-picker-ttl">
        <div class="nav-picker-head">
          ${LINK_ICON}
          <h3 id="nav-picker-ttl" style="margin:0;font-size:14px;font-weight:600;flex:1">Link to a resource</h3>
          <button type="button" id="nav-picker-close" class="btn btn-outline btn-sm" style="padding:4px 8px">${CLOSE_ICON}</button>
        </div>
        <div style="padding:10px 20px">
          <input type="text" id="nav-picker-search" class="nav-input" placeholder="Search products, collections, pages…" autocomplete="off">
        </div>
        <div class="nav-picker-tabs" role="tablist">
          <button class="nav-picker-tab active" data-type="" role="tab" aria-selected="true">All</button>
          <button class="nav-picker-tab" data-type="product" role="tab">Products</button>
          <button class="nav-picker-tab" data-type="collection" role="tab">Collections</button>
          <button class="nav-picker-tab" data-type="page" role="tab">Pages</button>
        </div>
        <div class="nav-picker-list" id="nav-picker-list" aria-live="polite">
          <div style="padding:20px;text-align:center;color:var(--s-text-muted);font-size:13px">Search or pick a tab to browse.</div>
        </div>
      </div>
    </div>`
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function renderListView(
  base: string,
  menus: ApiMenu[],
  csrfField: string,
  flashMsg: string,
): string {
  const rows = menus.length === 0
    ? `<tr><td colspan="3" style="padding:48px 20px;text-align:center">
        <svg style="margin:0 auto 14px;display:block;opacity:.3" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
        <p style="font-size:14px;font-weight:600;color:var(--s-text);margin:0 0 6px">No menus yet</p>
        <p style="font-size:13px;color:var(--s-text-muted);margin:0">Create your first menu to start building navigation.</p>
       </td></tr>`
    : menus.map(m => {
        const id   = m.id ?? ''
        const name = m.name ?? ''
        const loc  = m.location ?? ''
        const cnt  = countItems(m.items)
        const editUrl = `${base}/online-store/navigation?menu=${esc(id)}`
        return `
          <tr onclick="location.href='${editUrl}'">
            <td>
              <div style="font-size:14px;font-weight:500;color:var(--s-text)">${esc(name)}</div>
              <div style="font-size:11px;color:var(--s-text-muted);margin-top:2px;font-family:ui-monospace,monospace">${esc(loc)}</div>
            </td>
            <td><span class="nav-loc">${esc(locationLabel(loc))}</span></td>
            <td>
              <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px" onclick="event.stopPropagation()">
                <span style="font-size:13px;color:var(--s-text-muted);min-width:50px;text-align:right">${cnt} item${cnt === 1 ? '' : 's'}</span>
                <a href="${editUrl}" class="btn btn-outline btn-sm" style="font-size:12px;text-decoration:none">Edit</a>
                <form method="POST" action="${base}/online-store/navigation/menus/${esc(id)}/delete"
                      onsubmit="return confirm('Delete \\u201c${esc(name).replace(/'/g, "\\'")}\\u201d and all its items?')" style="margin:0">
                  ${csrfField}
                  <button type="submit" class="btn btn-outline btn-sm"
                          style="font-size:12px;color:var(--s-danger);border-color:rgba(239,68,68,.25)">Delete</button>
                </form>
              </div>
            </td>
          </tr>`
      }).join('')

  return `
    <div class="nav-pg">
      <nav class="nav-crumb">
        <a href="${base}/online-store">Online Store</a>
        <span class="nav-crumb-sep">&rsaquo;</span>
        <span>Navigation</span>
      </nav>

      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px;gap:12px">
        <div>
          <h1 style="font-size:22px;font-weight:700;margin:0 0 4px">Navigation</h1>
          <p style="margin:0;font-size:13px;color:var(--s-text-muted)">Manage menus to help customers find their way around your store.</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm"
                onclick="document.getElementById('nav-create-modal').classList.add('open')"
                style="white-space:nowrap;margin-top:28px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-2px;margin-right:4px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add menu
        </button>
      </div>

      ${flashMsg ? `<div class="nav-flash">${esc(flashMsg)}</div>` : ''}

      <div class="card">
        <table class="nav-tbl">
          <thead>
            <tr>
              <th>Menu</th>
              <th>Location</th>
              <th style="text-align:right"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <!-- Create menu modal -->
      <div class="nav-create-bd" id="nav-create-modal">
        <div class="nav-create-panel">
          <div style="padding:20px 24px;border-bottom:1px solid var(--s-border);display:flex;justify-content:space-between;align-items:center">
            <h3 style="margin:0;font-size:16px;font-weight:700">Create menu</h3>
            <button type="button" onclick="document.getElementById('nav-create-modal').classList.remove('open')"
                    class="btn btn-outline btn-sm" style="padding:5px 8px">${CLOSE_ICON}</button>
          </div>
          <form method="POST" action="${base}/online-store/navigation/menus"
                style="padding:22px 24px;display:flex;flex-direction:column;gap:16px">
            ${csrfField}
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-muted)">Menu name</label>
              <input class="nav-input" type="text" name="name" id="nav-create-name"
                     placeholder="e.g. Main menu, Footer, Sidebar nav" required maxlength="255"
                     style="font-size:14px">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-muted)">
                Location <span style="font-weight:400;color:var(--s-text-dim)">&mdash; identifies this menu in your theme</span>
              </label>
              <input class="nav-input" type="text" name="location" id="nav-create-loc"
                     placeholder="e.g. header, footer, sidebar"
                     pattern="[a-z0-9-]+" title="Lowercase letters, numbers and hyphens only"
                     style="font-size:14px;font-family:ui-monospace,monospace">
              <p style="margin:5px 0 0;font-size:11px;color:var(--s-text-dim)">Auto-generated from name if left blank.</p>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:2px">
              <button type="button" onclick="document.getElementById('nav-create-modal').classList.remove('open')"
                      class="btn btn-outline btn-sm">Cancel</button>
              <button type="submit" class="btn btn-primary btn-sm">Create menu</button>
            </div>
          </form>
        </div>
      </div>

      <script>
      (function(){
        var name=document.getElementById('nav-create-name');
        var loc=document.getElementById('nav-create-loc');
        var locEdited=false;
        if(loc)loc.addEventListener('input',function(){locEdited=true});
        if(name)name.addEventListener('input',function(){
          if(locEdited)return;
          loc.value=name.value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
        });
        document.addEventListener('keydown',function(e){
          if(e.key==='Escape')document.getElementById('nav-create-modal').classList.remove('open');
        });
      })();
      </script>
    </div>`
}

// ---------------------------------------------------------------------------
// Editor view
// ---------------------------------------------------------------------------

function renderEditorView(
  base: string,
  menu: ApiMenu,
  nodes: FlatNode[],
  parentOpts: Array<{ id: string; label: string }>,
  csrfField: string,
  editingId: string | null,
  flashMsg: string,
): string {
  const menuId = menu.id ?? ''
  const name   = menu.name ?? ''
  const loc    = menu.location ?? ''
  const treeHtml = renderFlatTree(nodes, base, csrfField, editingId, menuId)

  return `
    <div class="nav-pg">
      <nav class="nav-crumb">
        <a href="${base}/online-store">Online Store</a>
        <span class="nav-crumb-sep">&rsaquo;</span>
        <a href="${base}/online-store/navigation">Navigation</a>
        <span class="nav-crumb-sep">&rsaquo;</span>
        <span>${esc(name)}</span>
      </nav>

      ${flashMsg ? `<div class="nav-flash">${esc(flashMsg)}</div>` : ''}

      <!-- Inline rename -->
      <div style="margin-bottom:24px">
        <form method="POST" action="${base}/online-store/navigation/menus/${esc(menuId)}/rename">
          ${csrfField}
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
            <input class="nav-title-input" type="text" name="name" value="${esc(name)}"
                   required maxlength="255" title="Click to rename"
                   onblur="if(this.value.trim()&&this.value!==this.defaultValue)this.form.submit()">
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="nav-loc">${esc(locationLabel(loc))}</span>
            <span style="font-size:11px;color:var(--s-text-dim);font-family:ui-monospace,monospace">${esc(loc)}</span>
          </div>
        </form>
      </div>

      <!-- Items card -->
      <div class="card" style="margin-bottom:20px" data-menu-id="${esc(menuId)}">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <h3 class="card-title" style="margin:0;font-size:14px;font-weight:600">Menu items</h3>
          <div style="display:flex;align-items:center;gap:12px">
            <span style="font-size:11px;color:var(--s-text-muted)">Drag to reorder &bull; drop on item to nest</span>
            <button type="button" id="nav-save-btn" onclick="navSave()" class="btn btn-primary btn-sm" style="font-size:12px">Save</button>
          </div>
        </div>
        <div class="card-body">${treeHtml}</div>
      </div>

      <!-- Add item form -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <h3 class="card-title" style="margin:0;font-size:14px;font-weight:600">Add menu item</h3>
        </div>
        <div class="card-body">
          <form id="nav-add-form" onsubmit="return navAddItem(event)"
                style="display:flex;flex-direction:column;gap:12px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;color:var(--s-text-muted)">Label</label>
                <input class="nav-input" type="text" name="name"
                       placeholder="e.g. Shop, FAQ, Gallery" required maxlength="255">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;color:var(--s-text-muted)">Nest under</label>
                <select name="parent_id" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none">
                  <option value="">&mdash; Top level &mdash;</option>
                  ${parentOpts.map(o => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;color:var(--s-text-muted)">Link</label>
              <div style="display:flex;gap:8px">
                <input class="nav-input" type="text" name="link" id="nav-add-url"
                       placeholder="e.g. /products, https://… or pick a resource →">
                <button type="button" id="nav-picker-btn" class="btn btn-outline btn-sm"
                        style="font-size:12px;white-space:nowrap">Browse&hellip;</button>
              </div>
              <p id="nav-res-chip" style="display:none;margin:5px 0 0;font-size:11px;color:var(--s-text-muted)">
                <span id="nav-res-chip-lbl"></span>
                <button type="button" id="nav-res-clear"
                        style="background:none;border:none;color:var(--s-danger);cursor:pointer;margin-left:4px;font-size:11px;text-decoration:underline">clear</button>
              </p>
            </div>
            <div style="display:flex;justify-content:flex-end">
              <button type="button" class="btn btn-outline btn-sm" onclick="navAddItem(event)">Add item</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Footer -->
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <a href="${base}/online-store/navigation" class="btn btn-outline btn-sm"
           style="text-decoration:none;font-size:12px">&#8592; Back to navigation</a>
        <form method="POST" action="${base}/online-store/navigation/menus/${esc(menuId)}/delete"
              onsubmit="return confirm('Delete \\u201c${esc(name).replace(/'/g, "\\'")}\\u201d and all its items?')" style="margin:0">
          ${csrfField}
          <button type="submit" class="btn btn-outline btn-sm"
                  style="font-size:12px;color:var(--s-danger);border-color:rgba(239,68,68,.25)">Delete menu</button>
        </form>
      </div>

      ${renderPickerModal()}
      <script>${pickerScript(base)}</script>
      <script>try{${dragDropScript(base, menuId)}}catch(e){console.error('drag-drop error',e)}</script>
      <script>try{${addItemScript(base, menuId)}}catch(e){console.error('add-item error',e)}</script>
    </div>`
}

// ---------------------------------------------------------------------------
// GET /navigation
// ---------------------------------------------------------------------------

export async function getNavigation(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  try {
    const store = req.store!
    const user  = req.storeUser!
    const theme = (req as any).theme || 'dark'
    const base  = `/admin/store/${store.slug}`

    const csrfToken = req.csrfToken!
    const csrfField = csrfHiddenField(csrfToken)
    const meta = `<meta name="csrf-token" content="${esc(csrfToken)}">`

    const flashMap: Record<string, string> = {
      added:        'Menu item added.',
      updated:      'Menu item updated.',
      removed:      'Menu item removed.',
      menu_created: 'Menu created.',
      menu_deleted: 'Menu deleted.',
      menu_renamed: 'Menu renamed.',
    }
    const flashKey = typeof req.query.flash === 'string' ? req.query.flash : ''
    const flashMsg = flashMap[flashKey] || ''

    const token   = getToken(req)
    const shopId  = store.id
    const rawMenuId = typeof req.query.menu === 'string' ? req.query.menu.trim() : ''

    let content: string

    if (rawMenuId) {
      const menuData = await fetchMenuById(token, shopId, rawMenuId)
      if (!menuData || !menuData.id) {
        res.redirect(`${base}/online-store/navigation`)
        return
      }

      // Auto-heal legacy items thiếu id (BE Menu nested item — id required cho
      // delete/edit URL). Patch + PUT silent một lần. Lần render sau đã sạch.
      const healed = healMissingItemIds(menuData.items || [])
      if (healed.changed) {
        try {
          await updateMenuApi(token, shopId, menuData.id, { ...menuData, items: healed.items })
          menuData.items = healed.items
          console.log('[Navigation] healed %d menu items missing id (menu_id=%s)', healed.fixedCount, menuData.id)
        } catch (err) {
          console.warn('[Navigation] heal items failed:', err instanceof Error ? err.message : err)
        }
      }

      const editingId  = typeof req.query.edit === 'string' ? req.query.edit.trim() : null
      const flatNodes  = flattenItems(menuData.items || [])
      const parentOpts = buildParentOptsFlat(flatNodes)

      content = meta + navCss() +
        renderEditorView(base, menuData, flatNodes, parentOpts, csrfField, editingId, flashMsg)
    } else {
      const menus = await fetchAllMenus(token, shopId)
      content = meta + navCss() + renderListView(base, menus, csrfField, flashMsg)
    }

    res.send(sellerLayout({
      title:     'Navigation',
      storeName: store.name,
      storeSlug: store.slug,
      userName:  user.name,
      userEmail: user.email,
      userRole:  user.role,
      storeRole: user.storeRole,
      activePage: 'online-store',
      theme,
      content,
    }))
  } catch (err) {
    console.error('getNavigation error:', err)
    res.status(500).send('Internal server error')
  }
}

// ---------------------------------------------------------------------------
// POST /navigation/menus — create menu
// ---------------------------------------------------------------------------

export async function postCreateMenu(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base  = `/admin/store/${store.slug}`

  const name   = String(req.body.name     || '').trim()
  let   location = String(req.body.location || '').trim()

  if (!name) { res.status(400).send('Menu name is required'); return }

  if (!location) {
    location = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'menu'
  }
  if (!/^[a-z0-9-]+$/.test(location)) {
    res.status(400).send('Location must be lowercase letters, numbers and hyphens only')
    return
  }

  const token = getToken(req)
  const created = await createMenuApi(token, store.id, {
    name,
    location,
    shop_id: store.id,
    items:   [],
  })

  const newId = created?.id ?? ''
  await logSellerAction(req, 'create', 'menu', newId, { name, location })

  res.redirect(`${base}/online-store/navigation${newId ? `?menu=${encodeURIComponent(newId)}&flash=menu_created` : '?flash=menu_created'}`)
}

// ---------------------------------------------------------------------------
// POST /navigation/menus/:menuId/delete
// ---------------------------------------------------------------------------

export async function postDeleteMenu(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store  = req.store!
  const base   = `/admin/store/${store.slug}`
  const menuId = String(req.params.menuId || '')

  const token = getToken(req)
  try {
    await deleteMenuApi(token, store.id, menuId)
  } catch (err: any) {
    if (!(err instanceof ProductApiError) || err.status !== 404) {
      console.error('postDeleteMenu error:', err)
    }
  }

  await logSellerAction(req, 'delete', 'menu', menuId, {})
  res.redirect(`${base}/online-store/navigation?flash=menu_deleted`)
}

// ---------------------------------------------------------------------------
// POST /navigation/menus/:menuId/rename
// ---------------------------------------------------------------------------

export async function postRenameMenu(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store  = req.store!
  const base   = `/admin/store/${store.slug}`
  const menuId = String(req.params.menuId || '')

  const name = String(req.body.name || '').trim()
  if (!name) {
    res.redirect(`${base}/online-store/navigation?menu=${encodeURIComponent(menuId)}`)
    return
  }

  const token   = getToken(req)
  const current = await fetchMenuById(token, store.id, menuId)
  if (!current) { res.status(404).send('Menu not found'); return }

  await updateMenuApi(token, store.id, menuId, { ...current, name })
  await logSellerAction(req, 'update', 'menu', menuId, { name })

  res.redirect(`${base}/online-store/navigation?menu=${encodeURIComponent(menuId)}&flash=menu_renamed`)
}

// ---------------------------------------------------------------------------
// POST /navigation/items — add menu item
// ---------------------------------------------------------------------------

export async function postCreateMenuItem(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base  = `/admin/store/${store.slug}`

  const name      = String(req.body.name     || '').trim()
  const link      = String(req.body.link     || '').trim()
  const menuId    = String(req.body.menu_id  || '').trim()
  const parentId  = String(req.body.parent_id || '').trim() || null

  if (!name)   { res.status(400).send('Label is required'); return }
  if (!menuId) { res.status(400).send('Menu is required');  return }

  const token   = getToken(req)
  const current = await fetchMenuById(token, store.id, menuId)
  if (!current) { res.status(400).send('Menu not found'); return }

  const newItem: ApiMenuItem = { id: genMenuItemId(), name, link: link || null, items: [] }
  const updatedItems = addItemToParent(current.items || [], parentId, newItem)

  await updateMenuApi(token, store.id, menuId, { ...current, items: updatedItems })
  await logSellerAction(req, 'create', 'menu_item', menuId, { name, link, parent_id: parentId })

  res.redirect(`${base}/online-store/navigation?menu=${encodeURIComponent(menuId)}&flash=added`)
}

// ---------------------------------------------------------------------------
// POST /navigation/items/:itemId/update
// ---------------------------------------------------------------------------

export async function postUpdateMenuItem(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store  = req.store!
  const base   = `/admin/store/${store.slug}`
  const itemId = String(req.params.itemId || '')
  const menuId = String(req.body.menu_id  || '').trim()

  const name = String(req.body.name || '').trim()
  const link = String(req.body.link || '').trim()
  if (!name) { res.status(400).send('Label is required'); return }
  if (!menuId) { res.status(400).send('menu_id is required'); return }

  const token   = getToken(req)
  const current = await fetchMenuById(token, store.id, menuId)
  if (!current) { res.status(404).send('Menu not found'); return }

  const item = findItemById(current.items || [], itemId)
  if (!item) { res.status(404).send('Item not found'); return }

  const updatedItems = updateItemById(current.items || [], itemId, { name, link: link || null })
  await updateMenuApi(token, store.id, menuId, { ...current, items: updatedItems })
  await logSellerAction(req, 'update', 'menu_item', itemId, { name, link })

  res.redirect(`${base}/online-store/navigation?menu=${encodeURIComponent(menuId)}&flash=updated`)
}

// ---------------------------------------------------------------------------
// POST /navigation/items/:itemId/delete
// ---------------------------------------------------------------------------

export async function postDeleteMenuItem(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store  = req.store!
  const base   = `/admin/store/${store.slug}`
  const itemId = String(req.params.itemId || '')
  const menuId = String(req.body.menu_id  || '').trim()

  if (!menuId) { res.status(400).send('menu_id is required'); return }

  const token   = getToken(req)
  const current = await fetchMenuById(token, store.id, menuId)
  if (!current) { res.status(404).send('Menu not found'); return }

  const updatedItems = removeItemById(current.items || [], itemId)
  await updateMenuApi(token, store.id, menuId, { ...current, items: updatedItems })
  await logSellerAction(req, 'delete', 'menu_item', itemId, {})

  res.redirect(`${base}/online-store/navigation?menu=${encodeURIComponent(menuId)}&flash=removed`)
}

// ---------------------------------------------------------------------------
// POST /navigation/menus/:menuId/reorder — drag-drop AJAX
// ---------------------------------------------------------------------------

export async function postReorderMenu(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store  = req.store!
  const menuId = String(req.params.menuId || '')

  const updates: Array<{ id: string; parent_id: string | null }> = req.body.updates
  if (!Array.isArray(updates)) {
    res.status(400).json({ error: 'updates must be an array' })
    return
  }

  const token   = getToken(req)
  const current = await fetchMenuById(token, store.id, menuId)
  if (!current) { res.status(404).json({ error: 'Menu not found' }); return }

  const itemMap = flattenToMap(current.items || [])
  const newItems = rebuildTree(updates, itemMap, null)

  await updateMenuApi(token, store.id, menuId, { ...current, items: newItems })
  res.json({ ok: true })
}

// ---------------------------------------------------------------------------
// GET /navigation/resources — resource picker search
// ---------------------------------------------------------------------------

export async function getResourceSearch(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const q     = typeof req.query.q    === 'string' ? req.query.q.trim()    : ''
  const type  = typeof req.query.type === 'string' ? req.query.type.trim() : ''

  try {
    const ctx = createApiContext(req)
    const hits: Array<{ id: string; title: string; url: string; type: string }> = []

    if (!type || type === 'product') {
      const r = await (listProducts as any)(ctx, { keyword: q || undefined, page: 1, limit: 8 })
      for (const p of ((r as any)?.data ?? []) as any[]) {
        hits.push({ id: String(p.id || p._id || ''), title: String(p.name || p.title || ''), url: `/products/${p.slug || p.id}`, type: 'product' })
      }
    }
    if (!type || type === 'collection') {
      const r = await (listCategories as any)(ctx, { keyword: q || undefined, page: 1, limit: 8 })
      for (const c of ((r as any)?.data ?? []) as any[]) {
        hits.push({ id: String(c.id || ''), title: String(c.name || ''), url: `/collections/${c.slug || c.id}`, type: 'collection' })
      }
    }
    if (!type || type === 'page') {
      const r = await listPages(ctx, { keyword: q || undefined, page: 1, limit: 8, fields: 'id,title,slug' })
      for (const p of r.data ?? []) {
        hits.push({ id: String(p.id || ''), title: String(p.title || ''), url: `/pages/${p.slug || p.id}`, type: 'page' })
      }
    }

    res.json({ hits: hits.slice(0, 20) })
  } catch {
    res.json({ hits: [] })
  }
}

// ---------------------------------------------------------------------------
// POST /navigation/menus/:menuId/save-items — full-tree save (AJAX from editor)
// ---------------------------------------------------------------------------

function cleanItems(raw: any[]): ApiMenuItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map(item => {
    const rawId = String(item.id || '')
    // Real id (24-hex từ BE) → keep. tmp_xxx (FE-side temp pre-save) hoặc
    // empty → gen mới để render delete/edit không gãy với URL `/items//`.
    const id = rawId && !rawId.startsWith('tmp_') ? rawId : genMenuItemId()
    return {
      id,
      name: String(item.name || ''),
      link: item.link || null,
      items: cleanItems(item.items || []),
    }
  })
}

export async function postSaveMenuItems(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store  = req.store!
  const menuId = String(req.params.menuId || '')

  const items = cleanItems(Array.isArray(req.body.items) ? req.body.items : [])

  const token   = getToken(req)
  const current = await fetchMenuById(token, store.id, menuId)
  if (!current) { res.status(404).json({ error: 'Menu not found' }); return }

  await updateMenuApi(token, store.id, menuId, { ...current, items })
  await logSellerAction(req, 'update', 'menu', menuId, { items_count: items.length })
  res.json({ ok: true })
}

