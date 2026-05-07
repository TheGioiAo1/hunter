import { describe, it, expect } from 'vitest'
import { persistMenus } from './menus-persist.js'
import type { FlaggedMenuTree } from '../validate/guardrails.js'

// Fake tx that returns a fresh id per insert + records every write. Each
// record is `{ table, values, _id }` — keeping `.values` nested matches
// the shape persisters pass to Kysely and makes asserting easier.
function makeFakeTx() {
  const writes: Array<{ table: string; values: any; _id?: string }> = []
  let idCounter = 0
  const nextId = () => `id-${++idCounter}`
  const tx: any = {
    insertInto: (t: string) => ({
      values: (v: any) => ({
        // Path 1 (menus): .values(v).onConflict(...).returning('id').executeTakeFirst()
        onConflict: (_c: any) => ({
          returning: (_col: string) => ({
            executeTakeFirst: async () => {
              const id = nextId()
              writes.push({ table: t, values: v, _id: id })
              return { id }
            },
          }),
          execute: async () => {
            writes.push({ table: t, values: v })
            return undefined
          },
        }),
        // Path 2 (menu_items): .values(v).returning('id').executeTakeFirst()
        // — plain INSERT, no upsert (the persister DELETEs items first).
        returning: (_col: string) => ({
          executeTakeFirst: async () => {
            const id = nextId()
            writes.push({ table: t, values: v, _id: id })
            return { id }
          },
        }),
        execute: async () => {
          writes.push({ table: t, values: v })
          return undefined
        },
      }),
    }),
    deleteFrom: (_t: string) => ({
      where: (_a: any, _o: any, _b: any) => ({
        execute: async () => undefined,
      }),
    }),
  }
  return { tx, writes }
}

describe('persistMenus', () => {
  it('persists menu + hierarchical items with correct parent_id / depth / broken', async () => {
    const tree: FlaggedMenuTree = {
      handle: 'main-menu',
      nodes: [
        {
          label: 'Shop',
          url: 'https://x.com/collections/all',
          broken: false,
          children: [
            {
              label: 'Men',
              url: 'https://x.com/collections/men',
              broken: false,
              children: [],
            },
          ],
        },
        {
          label: 'Gone',
          url: 'https://x.com/dead',
          broken: true,
          children: [],
        },
      ],
    }

    const { tx, writes } = makeFakeTx()
    const res = await persistMenus(tx, 'shop-1', tree)

    expect(res.menuInserted).toBe(1)
    expect(res.itemsInserted).toBe(3)

    // Menu row: schema uses `slug` + `title`, not `handle` + `title`.
    const menuWrite = writes.find((w) => w.table === 'menus')!
    expect(menuWrite.values).toMatchObject({
      shop_id: 'shop-1',
      slug: 'main-menu',
      title: 'main-menu',
    })

    // Menu items: schema column is `title`, NOT label. `broken` + `depth`
    // come from 091b.
    const items = writes.filter((w) => w.table === 'menu_items')
    expect(items).toHaveLength(3)
    const shop = items.find((i: any) => i.values.title === 'Shop')
    const men = items.find((i: any) => i.values.title === 'Men')
    const gone = items.find((i: any) => i.values.title === 'Gone')

    // Shop is a root (parent_id null, depth 0).
    expect(shop.values.parent_id).toBeNull()
    expect(shop.values.depth).toBe(0)
    expect(shop.values.broken).toBe(false)

    // Men is nested under Shop (parent_id = shop's returned id, depth 1).
    expect(men.values.parent_id).toBe(shop._id)
    expect(men.values.depth).toBe(1)
    expect(men.values.broken).toBe(false)

    // Gone is a root, flagged broken.
    expect(gone.values.parent_id).toBeNull()
    expect(gone.values.depth).toBe(0)
    expect(gone.values.broken).toBe(true)
  })

  it('persists an empty menu (no items) without crashing', async () => {
    const tree: FlaggedMenuTree = { handle: 'footer', nodes: [] }
    const { tx, writes } = makeFakeTx()
    const res = await persistMenus(tx, 'shop-1', tree)
    expect(res.menuInserted).toBe(1)
    expect(res.itemsInserted).toBe(0)
    expect(writes.filter((w) => w.table === 'menu_items')).toHaveLength(0)
  })

  it('assigns positions starting at 0 per-parent', async () => {
    const tree: FlaggedMenuTree = {
      handle: 'main',
      nodes: [
        { label: 'A', url: 'https://x.com/a', broken: false, children: [] },
        { label: 'B', url: 'https://x.com/b', broken: false, children: [] },
        { label: 'C', url: 'https://x.com/c', broken: false, children: [] },
      ],
    }
    const { tx, writes } = makeFakeTx()
    await persistMenus(tx, 'shop-1', tree)
    const items = writes.filter((w) => w.table === 'menu_items')
    expect(items.map((i: any) => i.values.position)).toEqual([0, 1, 2])
  })
})
