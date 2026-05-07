/**
 * Navigation service — nested menu trees, reorder, resource picker.
 *
 * Phase 7 PR2 builds on the columns that migration 001 always had
 * (`menu_items.parent_id`, `menu_items.resource_type`,
 *  `menu_items.resource_id`) but that the original admin UI ignored.
 *
 * Responsibilities:
 *   - `buildTree`         — flat rows → nested nodes (handles max depth)
 *   - `listMenuItemsTree` — DB read + tree build in one call
 *   - `reorderMenuItems`  — batch position + parent_id patch under a menu
 *   - `searchResources`   — fuzzy-search products / collections / pages /
 *                            blog posts for the picker dropdown
 *   - `resolveResourceUrl`— `{type, id}` → canonical storefront path
 *
 * Max nesting depth is 3 (Shopify parity): top-level → child → grandchild.
 * `reorderMenuItems` enforces this server-side so a malicious client can't
 * bypass the UI guard.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shopify allows 3 levels: top → child → grandchild. Enforced server-side. */
export const MAX_MENU_DEPTH = 3

/** Resource types the link-picker knows how to resolve to a storefront URL. */
export type MenuResourceType = 'product' | 'collection' | 'page' | 'blog_post'

export const MENU_RESOURCE_TYPES: readonly MenuResourceType[] = [
  'product',
  'collection',
  'page',
  'blog_post',
] as const

export function isMenuResourceType(v: unknown): v is MenuResourceType {
  return typeof v === 'string' && (MENU_RESOURCE_TYPES as readonly string[]).includes(v)
}

export interface MenuItemRow {
  id: string
  menu_id: string
  parent_id: string | null
  title: string
  url: string | null
  resource_type: MenuResourceType | null
  resource_id: string | null
  position: number
}

export interface MenuItemNode extends MenuItemRow {
  children: MenuItemNode[]
  depth: number
}

export interface ReorderUpdate {
  id: string
  parent_id: string | null
  position: number
}

export interface ReorderResult {
  updated: number
  skipped_over_depth: number
}

export interface ResourcePickerHit {
  type: MenuResourceType
  id: string
  title: string
  url: string
}

// ---------------------------------------------------------------------------
// Tree builder (pure — exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Assemble flat rows into a forest keyed by `parent_id`. Children keep
 * their parent's sort-by-position ordering. Rows whose `parent_id` points
 * at a row outside this set become orphans and attach to the root (so
 * data corruption never disappears from the admin UI).
 *
 * `depth` is assigned as the node is attached (root = 0). Subtrees that
 * exceed `MAX_MENU_DEPTH - 1` are truncated — the node still renders but
 * its further descendants are collapsed into its level.
 */
export function buildTree(rows: MenuItemRow[]): MenuItemNode[] {
  // Normalise + group by parent. Note: Array.sort is stable in modern V8
  // but we also sort inside each group after the fact to be explicit.
  const byParent = new Map<string | null, MenuItemNode[]>()
  const byId = new Map<string, MenuItemNode>()

  for (const r of rows) {
    const node: MenuItemNode = { ...r, children: [], depth: 0 }
    byId.set(node.id, node)
    const key = node.parent_id
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(node)
  }

  // Sort each parent's children by `position` (ascending, ties broken
  // by id so output is deterministic).
  for (const list of byParent.values()) {
    list.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  }

  // Roots are anything with parent_id=null OR whose parent_id points at
  // a row we don't have (orphan rescue).
  const roots: MenuItemNode[] = []
  const topLevel = byParent.get(null) ?? []
  for (const r of topLevel) roots.push(r)
  for (const r of rows) {
    if (r.parent_id && !byId.has(r.parent_id)) {
      const node = byId.get(r.id)
      if (node) roots.push(node)
    }
  }
  // Re-sort roots so rescued orphans interleave by position, not append.
  roots.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  // Walk the forest, attach children, assign depth, truncate at max.
  function attach(node: MenuItemNode, depth: number) {
    node.depth = depth
    if (depth >= MAX_MENU_DEPTH - 1) {
      // Leaf-at-max: ignore any children this node claims.
      node.children = []
      return
    }
    const kids = byParent.get(node.id) ?? []
    node.children = kids
    for (const k of kids) attach(k, depth + 1)
  }
  for (const r of roots) attach(r, 0)

  return roots
}

// ---------------------------------------------------------------------------
// DB-bound helpers
// ---------------------------------------------------------------------------

/**
 * Read every menu_item under `menuId` and return as a nested tree.
 * Scope-check the menu belongs to `shopId` first so cross-tenant leaks
 * return an empty tree, not someone else's data.
 */
export async function listMenuItemsTree(
  db: Kysely<Database>,
  shopId: string,
  menuId: string,
): Promise<MenuItemNode[]> {
  const menu = await db
    .selectFrom('menus')
    .select('id')
    .where('id', '=', menuId)
    .where('shop_id', '=', shopId)
    .executeTakeFirst()
  if (!menu) return []

  const rows = await db
    .selectFrom('menu_items')
    .select([
      'id',
      'menu_id',
      'parent_id',
      'title',
      'url',
      'resource_type',
      'resource_id',
      'position',
    ])
    .where('menu_id', '=', menuId)
    .execute()

  const normalised: MenuItemRow[] = rows.map((r: any) => ({
    id: String(r.id),
    menu_id: String(r.menu_id),
    parent_id: r.parent_id ? String(r.parent_id) : null,
    title: r.title,
    url: r.url ?? null,
    resource_type: isMenuResourceType(r.resource_type) ? r.resource_type : null,
    resource_id: r.resource_id ? String(r.resource_id) : null,
    position: Number(r.position ?? 0),
  }))

  return buildTree(normalised)
}

/**
 * Apply a batch of `{id, parent_id, position}` updates to rows under
 * `menuId`. Runs inside a transaction so a mid-batch failure rolls back
 * the whole reorder (UI would otherwise desync from the DB).
 *
 * Guards:
 *   - Every id must belong to `menuId` AND `menuId.shop_id === shopId`
 *     (cross-tenant ids are silently dropped).
 *   - Re-parenting that would create a cycle (parent chain contains the
 *     moving node) is rejected.
 *   - Depth ≥ MAX_MENU_DEPTH is rejected (counted as skipped_over_depth).
 */
export async function reorderMenuItems(
  db: Kysely<Database>,
  shopId: string,
  menuId: string,
  updates: ReorderUpdate[],
): Promise<ReorderResult> {
  // Scope check the menu.
  const menu = await db
    .selectFrom('menus')
    .select('id')
    .where('id', '=', menuId)
    .where('shop_id', '=', shopId)
    .executeTakeFirst()
  if (!menu) return { updated: 0, skipped_over_depth: 0 }

  if (updates.length === 0) return { updated: 0, skipped_over_depth: 0 }

  // Load the full current state so we can cycle-check + depth-check.
  const allRows = await db
    .selectFrom('menu_items')
    .select(['id', 'parent_id'])
    .where('menu_id', '=', menuId)
    .execute()
  const parentById = new Map<string, string | null>()
  for (const r of allRows) {
    parentById.set(String(r.id), r.parent_id ? String(r.parent_id) : null)
  }

  // Apply proposed parent changes to a copy so multi-node reparent cycles
  // are caught before we start writing.
  const proposed = new Map(parentById)
  for (const u of updates) {
    if (proposed.has(u.id)) proposed.set(u.id, u.parent_id)
  }

  function wouldCycle(nodeId: string): boolean {
    let cursor = proposed.get(nodeId) ?? null
    const visited = new Set<string>()
    let steps = 0
    while (cursor) {
      if (cursor === nodeId) return true
      if (visited.has(cursor)) return true
      visited.add(cursor)
      cursor = proposed.get(cursor) ?? null
      // Hard guard against unbounded walks if the data is wildly corrupt.
      if (++steps > 1000) return true
    }
    return false
  }

  function depthOf(nodeId: string): number {
    let cursor = proposed.get(nodeId) ?? null
    let depth = 0
    const visited = new Set<string>()
    while (cursor) {
      if (visited.has(cursor)) break
      visited.add(cursor)
      depth++
      if (depth >= 64) break // pathological data guard
      cursor = proposed.get(cursor) ?? null
    }
    return depth
  }

  let updated = 0
  let skipped_over_depth = 0

  // Kysely transaction — one batch to keep the UI in sync with the DB.
  await db.transaction().execute(async (tx) => {
    for (const u of updates) {
      if (!parentById.has(u.id)) continue // not in this menu: drop silently
      if (wouldCycle(u.id)) continue
      if (depthOf(u.id) >= MAX_MENU_DEPTH) {
        skipped_over_depth++
        continue
      }

      await tx
        .updateTable('menu_items')
        .set({
          parent_id: u.parent_id,
          position: u.position,
        } as any)
        .where('id', '=', u.id)
        .where('menu_id', '=', menuId)
        .execute()
      updated++
    }
  })

  return { updated, skipped_over_depth }
}

// ---------------------------------------------------------------------------
// Resource picker
// ---------------------------------------------------------------------------

/**
 * Map a resource pointer to the canonical storefront path. Returns `null`
 * if the row does not exist or is deleted — the caller can then fall
 * back to the free-text URL.
 */
export async function resolveResourceUrl(
  db: Kysely<Database>,
  shopId: string,
  type: MenuResourceType,
  resourceId: string,
): Promise<string | null> {
  if (type === 'product') {
    const row: any = await db
      .selectFrom('products')
      .select('slug')
      .where('id', '=', resourceId)
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    return row?.slug ? `/products/${row.slug}` : null
  }
  if (type === 'collection') {
    const row: any = await db
      .selectFrom('collections')
      .select('slug')
      .where('id', '=', resourceId)
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    return row?.slug ? `/collections/${row.slug}` : null
  }
  if (type === 'page') {
    const row: any = await db
      .selectFrom('pages')
      .select('slug')
      .where('id', '=', resourceId)
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    return row?.slug ? `/pages/${row.slug}` : null
  }
  if (type === 'blog_post') {
    const row: any = await db
      .selectFrom('blog_posts')
      .select('slug')
      .where('id', '=', resourceId)
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    return row?.slug ? `/blog/${row.slug}` : null
  }
  return null
}

/**
 * Fuzzy-search shop-owned resources for the link-picker dropdown.
 *
 * `q` is a title ILIKE match, case-insensitive. Empty `q` returns the
 * N most-recent rows of each type so the picker shows *something* on
 * open. `types` is optional; defaults to all four.
 */
export async function searchResources(
  db: Kysely<Database>,
  shopId: string,
  q: string,
  opts?: { types?: readonly MenuResourceType[]; limit?: number },
): Promise<ResourcePickerHit[]> {
  const types = opts?.types?.length ? opts.types : MENU_RESOURCE_TYPES
  // Per-type limit; we fan out + merge so one noisy type can't starve the
  // others. 15 each × 4 types = 60 max — plenty for a picker.
  const perTypeLimit = Math.max(1, Math.min(50, opts?.limit ?? 15))
  const likePattern = `%${q.trim()}%`
  const hits: ResourcePickerHit[] = []

  for (const type of types) {
    if (type === 'product') {
      let qb = db
        .selectFrom('products')
        .select(['id', 'title', 'slug'])
        .where('shop_id', '=', shopId)
      if (q.trim()) qb = qb.where('title', 'ilike', likePattern)
      const rows = await qb
        .orderBy('updated_at', 'desc')
        .limit(perTypeLimit)
        .execute()
      for (const r of rows as any[]) {
        hits.push({
          type: 'product',
          id: String(r.id),
          title: String(r.title),
          url: `/products/${r.slug}`,
        })
      }
    } else if (type === 'collection') {
      let qb = db
        .selectFrom('collections')
        .select(['id', 'title', 'slug'])
        .where('shop_id', '=', shopId)
      if (q.trim()) qb = qb.where('title', 'ilike', likePattern)
      const rows = await qb
        .orderBy('updated_at', 'desc')
        .limit(perTypeLimit)
        .execute()
      for (const r of rows as any[]) {
        hits.push({
          type: 'collection',
          id: String(r.id),
          title: String(r.title),
          url: `/collections/${r.slug}`,
        })
      }
    } else if (type === 'page') {
      let qb = db
        .selectFrom('pages')
        .select(['id', 'title', 'slug'])
        .where('shop_id', '=', shopId)
      if (q.trim()) qb = qb.where('title', 'ilike', likePattern)
      const rows = await qb
        .orderBy('updated_at', 'desc')
        .limit(perTypeLimit)
        .execute()
      for (const r of rows as any[]) {
        hits.push({
          type: 'page',
          id: String(r.id),
          title: String(r.title),
          url: `/pages/${r.slug}`,
        })
      }
    } else if (type === 'blog_post') {
      let qb = db
        .selectFrom('blog_posts')
        .select(['id', 'title', 'slug'])
        .where('shop_id', '=', shopId)
      if (q.trim()) qb = qb.where('title', 'ilike', likePattern)
      const rows = await qb
        .orderBy('updated_at', 'desc')
        .limit(perTypeLimit)
        .execute()
      for (const r of rows as any[]) {
        hits.push({
          type: 'blog_post',
          id: String(r.id),
          title: String(r.title),
          url: `/blog/${r.slug}`,
        })
      }
    }
  }

  return hits
}
