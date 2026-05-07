/**
 * Gbox Platform — Cart hydration tests (Stage 3B.3)
 *
 * `hydrateCart` is the bridge between the cheap, variant-only cart
 * the `CartService` stores in Redis and the priced, shoppable
 * `CartDrop` the theme engine exposes to Liquid templates. Tests
 * here use a hand-rolled Kysely-shaped stub so we can run the
 * hydration without a real DB — identical pattern to the existing
 * `DbDataSource` tests.
 *
 * What we pin down:
 *
 *   1. A null / missing cart → the same empty CartDrop shape the
 *      theme already assumes.
 *   2. An empty cart → item_count 0, total_price 0, items [].
 *   3. A cart with real lines →
 *      a. Missing variants are dropped silently (inventory
 *         gets deleted, the buyer shouldn't see an exploded cart).
 *      b. Surviving lines carry title, variant_title, price,
 *         line_price, quantity, image and url.
 *      c. total_price is sum(price * quantity), rounded to the
 *         nearest cent (the rest of the platform speaks decimal
 *         strings — we keep numbers here because CartDrop uses
 *         `total_price: number`).
 *   4. The query is shop-scoped — lines whose product lives in a
 *      different shop are dropped, not priced with the wrong data.
 */

import { describe, it, expect } from 'vitest'
import { hydrateCart } from './hydrate.js'
import type { Cart } from './service.js'

// ---------------------------------------------------------------------------
// Fake DB that lets us stub `product_variants INNER JOIN products` reads.
// ---------------------------------------------------------------------------

interface FakeVariantRow {
  variant_id: string
  product_id: string
  variant_title: string | null
  price: string
  image_url: string | null
  product_title: string
  product_handle: string
  shop_id: string
}

/**
 * Map a qualified Kysely column reference to the matching key on
 * our fake rows. The real query aliases `product_variants.id` to
 * `variant_id` via `.select(...as variant_id)`; the fake rows
 * carry both names so the filter can pick either.
 */
function resolveColumn(
  col: string,
  row: FakeVariantRow,
): string | undefined {
  const tail = col.split('.').pop()!
  // `product_variants.id` → `variant_id` alias on the row.
  if (col === 'product_variants.id') return row.variant_id
  // Everything else uses the unprefixed tail name, which already
  // matches the FakeVariantRow keys.
  return (row as unknown as Record<string, string | null>)[tail] ?? undefined
}

function createFakeDb(rows: FakeVariantRow[]): any {
  const db: any = {
    selectFrom: (_table: string) => {
      const buildChain = (current: FakeVariantRow[]) => {
        const chain: any = {
          innerJoin: () => chain,
          select: () => chain,
          selectAll: () => chain,
          where: (col: string, op: string, val: any) => {
            const filtered = current.filter((r) => {
              const v = resolveColumn(col, r)
              if (op === '=') return v === val
              if (op === 'in') return (val as string[]).includes(v as string)
              return true
            })
            return buildChain(filtered)
          },
          execute: async () => current,
        }
        return chain
      }
      return buildChain(rows)
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCart(overrides: Partial<Cart> = {}): Cart {
  return {
    token: 'ct_test',
    shop_id: 'shop_1',
    lines: [],
    note: null,
    attributes: {},
    created_at: '2026-04-09T00:00:00Z',
    updated_at: '2026-04-09T00:00:00Z',
    ...overrides,
  }
}

const variantRows: FakeVariantRow[] = [
  {
    variant_id: 'var_shirt_s',
    product_id: 'prod_shirt',
    variant_title: 'Small',
    price: '25.00',
    image_url: '/i/shirt.jpg',
    product_title: 'Demo Shirt',
    product_handle: 'demo-shirt',
    shop_id: 'shop_1',
  },
  {
    variant_id: 'var_shirt_m',
    product_id: 'prod_shirt',
    variant_title: 'Medium',
    price: '25.00',
    image_url: '/i/shirt.jpg',
    product_title: 'Demo Shirt',
    product_handle: 'demo-shirt',
    shop_id: 'shop_1',
  },
  {
    variant_id: 'var_hat',
    product_id: 'prod_hat',
    variant_title: null,
    price: '12.50',
    image_url: null,
    product_title: 'Demo Hat',
    product_handle: 'demo-hat',
    shop_id: 'shop_1',
  },
  {
    variant_id: 'var_other_shop',
    product_id: 'prod_other',
    variant_title: null,
    price: '99.00',
    image_url: null,
    product_title: 'Wrong Shop Hat',
    product_handle: 'wrong',
    shop_id: 'shop_2',
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hydrateCart', () => {
  it('returns an empty drop when the cart is null', async () => {
    const db = createFakeDb(variantRows)
    const drop = await hydrateCart(db, null, 'shop_1')
    expect(drop.item_count).toBe(0)
    expect(drop.total_price).toBe(0)
    expect(drop.items).toEqual([])
    expect(drop.token).toBeUndefined()
  })

  it('returns an empty drop (with token) when the cart has no lines', async () => {
    const db = createFakeDb(variantRows)
    const cart = makeCart()
    const drop = await hydrateCart(db, cart, 'shop_1')
    expect(drop.token).toBe('ct_test')
    expect(drop.item_count).toBe(0)
    expect(drop.total_price).toBe(0)
    expect(drop.items).toEqual([])
  })

  it('hydrates a cart with multiple lines into priced items', async () => {
    const db = createFakeDb(variantRows)
    const cart = makeCart({
      lines: [
        { variant_id: 'var_shirt_s', quantity: 2 },
        { variant_id: 'var_hat', quantity: 1 },
      ],
    })
    const drop = await hydrateCart(db, cart, 'shop_1')
    expect(drop.item_count).toBe(3)
    // 2 * 25.00 + 1 * 12.50 = 62.50
    expect(drop.total_price).toBeCloseTo(62.5, 2)
    expect(drop.items).toHaveLength(2)

    const shirtLine = (drop.items as Array<Record<string, unknown>>).find(
      (i) => i.variant_id === 'var_shirt_s',
    )!
    expect(shirtLine).toMatchObject({
      variant_id: 'var_shirt_s',
      product_id: 'prod_shirt',
      title: 'Demo Shirt',
      variant_title: 'Small',
      handle: 'demo-shirt',
      quantity: 2,
      image: '/i/shirt.jpg',
      url: '/products/demo-shirt',
    })
    expect(shirtLine.price).toBeCloseTo(25.0, 2)
    expect(shirtLine.line_price).toBeCloseTo(50.0, 2)
  })

  it('drops lines whose variant no longer exists', async () => {
    const db = createFakeDb(variantRows)
    const cart = makeCart({
      lines: [
        { variant_id: 'var_hat', quantity: 1 },
        { variant_id: 'var_deleted', quantity: 5 },
      ],
    })
    const drop = await hydrateCart(db, cart, 'shop_1')
    expect(drop.item_count).toBe(1)
    expect(drop.items).toHaveLength(1)
    expect((drop.items[0] as Record<string, unknown>).variant_id).toBe(
      'var_hat',
    )
  })

  it('drops lines whose product belongs to a different shop', async () => {
    const db = createFakeDb(variantRows)
    const cart = makeCart({
      lines: [
        { variant_id: 'var_hat', quantity: 1 },
        { variant_id: 'var_other_shop', quantity: 2 },
      ],
    })
    const drop = await hydrateCart(db, cart, 'shop_1')
    expect(drop.item_count).toBe(1)
    expect(drop.items).toHaveLength(1)
    expect((drop.items[0] as Record<string, unknown>).variant_id).toBe(
      'var_hat',
    )
  })

  it('preserves per-line properties', async () => {
    const db = createFakeDb(variantRows)
    const cart = makeCart({
      lines: [
        {
          variant_id: 'var_shirt_s',
          quantity: 1,
          properties: { engraving: 'HB' },
        },
      ],
    })
    const drop = await hydrateCart(db, cart, 'shop_1')
    const line = drop.items[0] as Record<string, unknown>
    expect(line.properties).toEqual({ engraving: 'HB' })
  })
})
