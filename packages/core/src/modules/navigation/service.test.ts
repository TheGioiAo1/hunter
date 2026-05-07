/**
 * Unit tests for the pure helpers in navigation/service.ts.
 *
 * The DB-bound helpers (`listMenuItemsTree`, `reorderMenuItems`,
 * `searchResources`, `resolveResourceUrl`) are covered by the live smoke
 * at `scripts/smoke-phase7-pr2.ts`. This file exercises `buildTree` and
 * `isMenuResourceType` — both pure, no DB required.
 */

import { describe, it, expect } from 'vitest'
import {
  buildTree,
  isMenuResourceType,
  MAX_MENU_DEPTH,
  MENU_RESOURCE_TYPES,
  type MenuItemRow,
} from './service.js'

function row(overrides: Partial<MenuItemRow> & { id: string }): MenuItemRow {
  return {
    id: overrides.id,
    menu_id: overrides.menu_id ?? 'menu-1',
    parent_id: overrides.parent_id ?? null,
    title: overrides.title ?? `Item ${overrides.id}`,
    url: overrides.url ?? null,
    resource_type: overrides.resource_type ?? null,
    resource_id: overrides.resource_id ?? null,
    position: overrides.position ?? 0,
  }
}

describe('isMenuResourceType', () => {
  it('accepts the 4 valid resource types', () => {
    for (const t of MENU_RESOURCE_TYPES) {
      expect(isMenuResourceType(t)).toBe(true)
    }
  })

  it('rejects unknown, empty, and non-string values', () => {
    expect(isMenuResourceType('article')).toBe(false)
    expect(isMenuResourceType('')).toBe(false)
    expect(isMenuResourceType(null)).toBe(false)
    expect(isMenuResourceType(undefined)).toBe(false)
    expect(isMenuResourceType(42)).toBe(false)
    expect(isMenuResourceType({})).toBe(false)
  })
})

describe('buildTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildTree([])).toEqual([])
  })

  it('returns flat items as roots when no parent_id is set', () => {
    const rows = [
      row({ id: 'a', position: 0 }),
      row({ id: 'b', position: 1 }),
      row({ id: 'c', position: 2 }),
    ]
    const tree = buildTree(rows)
    expect(tree.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(tree.every((n) => n.depth === 0)).toBe(true)
    expect(tree.every((n) => n.children.length === 0)).toBe(true)
  })

  it('sorts roots by position ascending', () => {
    const rows = [
      row({ id: 'a', position: 2 }),
      row({ id: 'b', position: 0 }),
      row({ id: 'c', position: 1 }),
    ]
    expect(buildTree(rows).map((n) => n.id)).toEqual(['b', 'c', 'a'])
  })

  it('breaks position ties by id for determinism', () => {
    const rows = [
      row({ id: 'z', position: 0 }),
      row({ id: 'a', position: 0 }),
      row({ id: 'm', position: 0 }),
    ]
    expect(buildTree(rows).map((n) => n.id)).toEqual(['a', 'm', 'z'])
  })

  it('nests children under parent and assigns depth', () => {
    const rows = [
      row({ id: 'root', position: 0 }),
      row({ id: 'child', parent_id: 'root', position: 0 }),
      row({ id: 'grand', parent_id: 'child', position: 0 }),
    ]
    const tree = buildTree(rows)
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('root')
    expect(tree[0].depth).toBe(0)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].id).toBe('child')
    expect(tree[0].children[0].depth).toBe(1)
    expect(tree[0].children[0].children[0].id).toBe('grand')
    expect(tree[0].children[0].children[0].depth).toBe(2)
  })

  it('truncates at MAX_MENU_DEPTH (grandchild\'s kids are dropped)', () => {
    // Build a 5-level-deep chain; the UI should render root→child→grand
    // (depths 0/1/2) and silently drop depths 3+.
    const rows = [
      row({ id: 'L0' }),
      row({ id: 'L1', parent_id: 'L0' }),
      row({ id: 'L2', parent_id: 'L1' }),
      row({ id: 'L3', parent_id: 'L2' }),
      row({ id: 'L4', parent_id: 'L3' }),
    ]
    const tree = buildTree(rows)
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('L0')
    expect(tree[0].children[0].id).toBe('L1')
    expect(tree[0].children[0].children[0].id).toBe('L2')
    expect(tree[0].children[0].children[0].depth).toBe(MAX_MENU_DEPTH - 1)
    // L2 sits at the max; we drop its children so the truncated branch
    // doesn't surface as a broken surface node.
    expect(tree[0].children[0].children[0].children).toEqual([])
  })

  it('sorts children by position within each parent', () => {
    const rows = [
      row({ id: 'root', position: 0 }),
      row({ id: 'c1', parent_id: 'root', position: 2 }),
      row({ id: 'c2', parent_id: 'root', position: 0 }),
      row({ id: 'c3', parent_id: 'root', position: 1 }),
    ]
    const tree = buildTree(rows)
    expect(tree[0].children.map((n) => n.id)).toEqual(['c2', 'c3', 'c1'])
  })

  it('rescues orphans (parent_id points at a missing row) as roots', () => {
    const rows = [
      row({ id: 'real-root', position: 0 }),
      row({ id: 'orphan', parent_id: 'ghost-parent', position: 1 }),
    ]
    const tree = buildTree(rows)
    expect(tree.map((n) => n.id)).toEqual(['real-root', 'orphan'])
    expect(tree.every((n) => n.depth === 0)).toBe(true)
  })

  it('does not mutate its input rows', () => {
    const rows = [
      row({ id: 'a', position: 1 }),
      row({ id: 'b', position: 0 }),
    ]
    const snapshot = JSON.parse(JSON.stringify(rows))
    buildTree(rows)
    expect(rows).toEqual(snapshot)
  })

  it('handles multiple independent trees in one menu', () => {
    const rows = [
      row({ id: 'a', position: 0 }),
      row({ id: 'a1', parent_id: 'a', position: 0 }),
      row({ id: 'b', position: 1 }),
      row({ id: 'b1', parent_id: 'b', position: 0 }),
      row({ id: 'b2', parent_id: 'b', position: 1 }),
    ]
    const tree = buildTree(rows)
    expect(tree.map((n) => n.id)).toEqual(['a', 'b'])
    expect(tree[0].children.map((n) => n.id)).toEqual(['a1'])
    expect(tree[1].children.map((n) => n.id)).toEqual(['b1', 'b2'])
  })

  it('MAX_MENU_DEPTH is 3 (Shopify parity)', () => {
    expect(MAX_MENU_DEPTH).toBe(3)
  })
})
