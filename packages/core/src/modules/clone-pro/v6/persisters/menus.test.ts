import { describe, it, expect } from 'vitest'
import { menusPersister } from './menus.js'
import type { MenuItemDTO } from '../scrapers/types.js'

// ---------------------------------------------------------------------------
// Minimal DTO factory
// ---------------------------------------------------------------------------
function makeMenuDto(
  overrides: Partial<{
    sourceHandle: string
    title: string
    items: MenuItemDTO[]
  }> = {},
) {
  return {
    sourceHandle: 'main-menu',
    title: 'Main Menu',
    items: [] as MenuItemDTO[],
    ...overrides,
  }
}

function makeItem(
  title: string,
  url: string,
  position: number,
  children: MenuItemDTO[] = [],
): MenuItemDTO {
  return { title, url, position, children }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('MenusPersister', () => {
  it('inserts menu with nested items using parent_id FK', async () => {
    const inserts: any[] = []
    const deletes: any[] = []

    const fakeDb = makeFakeDb(inserts, {}, [], deletes)

    const items: MenuItemDTO[] = [
      makeItem('Home', '/', 0, []),
      makeItem('Shop', '/collections/all', 1, [
        makeItem('T-Shirts', '/collections/t-shirts', 0, []),
        makeItem('Hoodies', '/collections/hoodies', 1, []),
      ]),
    ]

    const r = await menusPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeMenuDto({ items })],
    })

    expect(r.inserted).toBe(1)
    expect(r.updated).toBe(0)
    expect(r.skippedEdited).toBe(0)
    expect(r.errors).toHaveLength(0)

    // Menu row inserted
    const menuInsert = inserts.find((i) => i.table === 'menus')
    expect(menuInsert?.values).toMatchObject({
      shop_id: 'shop-1',
      slug: 'main-menu',
      title: 'Main Menu',
      source: 'clone',
      clone_snapshot: expect.any(String),
    })
    const snap = JSON.parse(menuInsert.values.clone_snapshot)
    expect(snap.title).toBe('Main Menu')
    expect(snap.items).toHaveLength(2)

    // menu_items deleted (once, for the new menu id)
    expect(deletes.filter((d) => d.table === 'menu_items')).toHaveLength(1)

    // 4 menu_items inserted (Home, Shop, T-Shirts, Hoodies)
    const itemInserts = inserts.filter((i) => i.table === 'menu_items')
    expect(itemInserts).toHaveLength(4)

    // Home — top-level: parent_id null, depth 0
    const homeItem = itemInserts.find((i) => i.values.title === 'Home')
    expect(homeItem?.values.parent_id).toBeNull()
    expect(homeItem?.values.depth).toBe(0)
    expect(homeItem?.values.source).toBe('clone')

    // Shop — top-level: parent_id null, depth 0
    const shopItem = itemInserts.find((i) => i.values.title === 'Shop')
    expect(shopItem?.values.parent_id).toBeNull()
    expect(shopItem?.values.depth).toBe(0)

    // Resolve Shop's assigned fake id from the insert record
    const shopInsertRecord = inserts.find((i) => i.table === 'menu_items' && i.values.title === 'Shop')
    const shopId = shopInsertRecord?._id

    // T-Shirts — child of Shop: parent_id = Shop's fake id, depth 1
    const tshirtsItem = itemInserts.find((i) => i.values.title === 'T-Shirts')
    expect(tshirtsItem?.values.parent_id).toBe(shopId)
    expect(tshirtsItem?.values.depth).toBe(1)

    // Hoodies — child of Shop: parent_id = Shop's fake id, depth 1
    const hoodiesItem = itemInserts.find((i) => i.values.title === 'Hoodies')
    expect(hoodiesItem?.values.parent_id).toBe(shopId)
    expect(hoodiesItem?.values.depth).toBe(1)
  })

  it('skips update when menu source=edited (preserves seller customisation)', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const deletes: any[] = []
    const existingMenus = [
      { id: 'menu-1', shop_id: 'shop-1', slug: 'main-menu', source: 'edited', title: 'Custom Menu' },
    ]

    const fakeDb = makeFakeDb(inserts, { menus: existingMenus }, updates, deletes)

    const r = await menusPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeMenuDto({ items: [makeItem('Home', '/', 0)] })],
    })

    expect(r.skippedEdited).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.updated).toBe(0)
    // No menu_items delete or insert should have occurred
    expect(deletes.filter((d) => d.table === 'menu_items')).toHaveLength(0)
    expect(inserts.filter((i) => i.table === 'menu_items')).toHaveLength(0)
  })

  it('updates existing clone-source menu and replaces items', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const deletes: any[] = []
    const existingMenus = [
      { id: 'menu-1', shop_id: 'shop-1', slug: 'main-menu', source: 'clone', title: 'Old Title' },
    ]

    const fakeDb = makeFakeDb(inserts, { menus: existingMenus }, updates, deletes)

    const r = await menusPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeMenuDto({ title: 'New Title', items: [makeItem('Home', '/', 0)] })],
    })

    expect(r.updated).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.skippedEdited).toBe(0)

    const menuUpdate = updates.find((u) => u.table === 'menus')
    expect(menuUpdate?.values.title).toBe('New Title')
    expect(menuUpdate?.values.source).toBe('clone')

    // Items were deleted and reinserted
    expect(deletes.filter((d) => d.table === 'menu_items')).toHaveLength(1)
    expect(inserts.filter((i) => i.table === 'menu_items')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Fake transaction / DB builder
// ---------------------------------------------------------------------------
function makeFakeDb(
  inserts: any[],
  existing: Record<string, any[]> = {},
  updates: any[] = [],
  deletes: any[] = [],
) {
  return {
    transaction: () => ({
      setIsolationLevel: () => ({
        execute: async (fn: any) => fn(makeTrx(inserts, existing, updates, deletes)),
      }),
    }),
  }
}

function makeTrx(
  inserts: any[],
  existing: Record<string, any[]> = {},
  updates: any[] = [],
  deletes: any[] = [],
): any {
  // Per-table counters so each table id sequence starts at 0
  const counters: Record<string, number> = {}
  // Map from table+sequential-index → assigned id so callers can look up ids
  const assignedIds: Record<string, string> = {}

  return {
    selectFrom: (table: string) => ({
      where: () => ({
        where: () => ({
          select: () => ({
            executeTakeFirst: async () => existing[table]?.[0] ?? undefined,
            execute: async () => existing[table] ?? [],
          }),
          executeTakeFirst: async () => existing[table]?.[0] ?? undefined,
        }),
      }),
    }),
    insertInto: (table: string) => ({
      values: (values: any) => ({
        returningAll: () => ({
          execute: async () => {
            counters[table] = (counters[table] ?? 0)
            const id = `${table}-${counters[table]++}`
            inserts.push({ table, values, _id: id })
            return [{ ...values, id }]
          },
        }),
        execute: async () => {
          inserts.push({ table, values })
        },
      }),
    }),
    updateTable: (table: string) => ({
      set: (values: any) => ({
        where: () => ({
          execute: async () => {
            updates.push({ table, values })
          },
          where: () => ({
            execute: async () => {
              updates.push({ table, values })
            },
          }),
        }),
      }),
    }),
    deleteFrom: (table: string) => ({
      where: () => ({
        execute: async () => {
          deletes.push({ table })
        },
        where: () => ({
          execute: async () => {
            deletes.push({ table })
          },
        }),
      }),
    }),
  }
}
