/**
 * Gbox Platform — Cart Service tests (Stage 3B.1)
 *
 * The cart is a Redis-only, opaque-token-addressed bag of line items.
 * There is no `carts` table in Postgres — the cart's entire lifetime
 * lives between "customer hit /cart/add.js" and "checkout.completed_at
 * is set". This is the same pattern Shopify uses and it keeps the
 * cart cheap to mutate (every add/update is a single Redis write)
 * without dragging transaction locks into the hot path.
 *
 * These tests pin down the Shopify-compatible Ajax semantics that the
 * storefront routes (Stage 3B.2) will bolt straight onto Express:
 *
 *   • POST /cart/add.js       → addItem
 *   • POST /cart/change.js    → updateLine  (quantity=0 ⇒ remove)
 *   • POST /cart/update.js    → setAttributes / setNote / bulk update
 *   • POST /cart/clear.js     → clearCart
 *   • GET  /cart.js           → getCart
 *
 * We test against an in-memory `CartStore` so the suite runs without
 * Redis. Production wiring swaps in the `redisCartStore()` helper
 * which reads from `cacheGet/cacheSet/cacheDel` with a process-local
 * fallback Map, exactly the same pattern as `checkout/service.ts`.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  CartService,
  type Cart,
  type CartStore,
} from './service.js'

/**
 * Pure in-memory CartStore — sufficient for every unit test. The
 * production Redis store is tested separately via a thin integration
 * test that asserts it round-trips through `cacheSet/cacheGet`.
 */
function memoryStore(): CartStore {
  const map = new Map<string, Cart>()
  return {
    async get(token) {
      // Deep clone on read so mutating the returned cart outside the
      // service can't accidentally poison the store.
      const cart = map.get(token)
      return cart ? structuredClone(cart) : null
    },
    async set(token, cart) {
      map.set(token, structuredClone(cart))
    },
    async del(token) {
      map.delete(token)
    },
  }
}

describe('CartService — createCart', () => {
  let svc: CartService

  beforeEach(() => {
    svc = new CartService(memoryStore())
  })

  it('mints a fresh cart with a unique opaque token', async () => {
    const a = await svc.createCart('shop_1')
    const b = await svc.createCart('shop_1')
    expect(a.token).toMatch(/^ct_/)
    expect(b.token).toMatch(/^ct_/)
    expect(a.token).not.toBe(b.token)
  })

  it('starts with zero lines and empty attributes', async () => {
    const cart = await svc.createCart('shop_1')
    expect(cart.shop_id).toBe('shop_1')
    expect(cart.lines).toEqual([])
    expect(cart.note).toBeNull()
    expect(cart.attributes).toEqual({})
  })

  it('stamps created_at and updated_at as ISO strings', async () => {
    const cart = await svc.createCart('shop_1')
    expect(cart.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(cart.updated_at).toBe(cart.created_at)
  })

  it('persists the new cart so getCart can retrieve it', async () => {
    const cart = await svc.createCart('shop_1')
    const fetched = await svc.getCart(cart.token)
    expect(fetched).not.toBeNull()
    expect(fetched!.token).toBe(cart.token)
  })
})

describe('CartService — getCart', () => {
  let svc: CartService

  beforeEach(() => {
    svc = new CartService(memoryStore())
  })

  it('returns null for unknown tokens', async () => {
    expect(await svc.getCart('ct_does_not_exist')).toBeNull()
  })

  it('returns null for null/undefined/empty token', async () => {
    expect(await svc.getCart(null)).toBeNull()
    expect(await svc.getCart(undefined)).toBeNull()
    expect(await svc.getCart('')).toBeNull()
  })
})

describe('CartService — addItem', () => {
  let svc: CartService
  let cart: Cart

  beforeEach(async () => {
    svc = new CartService(memoryStore())
    cart = await svc.createCart('shop_1')
  })

  it('appends a new line when the variant is not present', async () => {
    const updated = await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_1',
      quantity: 2,
    })
    expect(updated.lines).toHaveLength(1)
    expect(updated.lines[0]).toMatchObject({
      variant_id: 'var_1',
      quantity: 2,
    })
  })

  it('merges quantities when the same variant is added twice', async () => {
    await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_1',
      quantity: 1,
    })
    const updated = await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_1',
      quantity: 3,
    })
    expect(updated.lines).toHaveLength(1)
    expect(updated.lines[0]!.quantity).toBe(4)
  })

  it('mints a new cart when token is null (first-touch visitor)', async () => {
    const fresh = await svc.addItem(null, 'shop_1', {
      variant_id: 'var_1',
      quantity: 1,
    })
    expect(fresh.token).toMatch(/^ct_/)
    expect(fresh.token).not.toBe(cart.token)
    expect(fresh.lines).toHaveLength(1)
  })

  it('mints a new cart when the supplied token no longer exists', async () => {
    const fresh = await svc.addItem('ct_evaporated', 'shop_1', {
      variant_id: 'var_1',
      quantity: 1,
    })
    expect(fresh.token).toMatch(/^ct_/)
    expect(fresh.token).not.toBe('ct_evaporated')
    expect(fresh.lines).toHaveLength(1)
  })

  it('rejects zero or negative quantities', async () => {
    await expect(
      svc.addItem(cart.token, 'shop_1', { variant_id: 'var_1', quantity: 0 }),
    ).rejects.toThrow(/quantity/i)
    await expect(
      svc.addItem(cart.token, 'shop_1', { variant_id: 'var_1', quantity: -1 }),
    ).rejects.toThrow(/quantity/i)
  })

  it('rejects non-integer quantities', async () => {
    await expect(
      svc.addItem(cart.token, 'shop_1', {
        variant_id: 'var_1',
        quantity: 1.5,
      }),
    ).rejects.toThrow(/quantity/i)
  })

  it('refuses to mix variants from a different shop onto the same cart', async () => {
    await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_1',
      quantity: 1,
    })
    await expect(
      svc.addItem(cart.token, 'shop_2', {
        variant_id: 'var_2',
        quantity: 1,
      }),
    ).rejects.toThrow(/shop/i)
  })

  it('preserves line properties when provided', async () => {
    const updated = await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_1',
      quantity: 1,
      properties: { engraving: 'Happy Birthday' },
    })
    expect(updated.lines[0]!.properties).toEqual({
      engraving: 'Happy Birthday',
    })
  })

  it('advances updated_at on every mutation', async () => {
    const first = await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_1',
      quantity: 1,
    })
    // Force a clock tick so ISO strings differ even on fast machines.
    await new Promise((r) => setTimeout(r, 2))
    const second = await svc.addItem(first.token, 'shop_1', {
      variant_id: 'var_2',
      quantity: 1,
    })
    expect(second.updated_at >= first.updated_at).toBe(true)
    expect(second.created_at).toBe(first.created_at)
  })
})

describe('CartService — updateLine', () => {
  let svc: CartService
  let cart: Cart

  beforeEach(async () => {
    svc = new CartService(memoryStore())
    cart = await svc.createCart('shop_1')
    await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_1',
      quantity: 2,
    })
    await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_2',
      quantity: 1,
    })
  })

  it('sets the quantity on an existing line', async () => {
    const updated = await svc.updateLine(cart.token, 'var_1', 5)
    const line = updated.lines.find((l) => l.variant_id === 'var_1')!
    expect(line.quantity).toBe(5)
  })

  it('removes the line when quantity becomes zero (Shopify semantics)', async () => {
    const updated = await svc.updateLine(cart.token, 'var_1', 0)
    expect(updated.lines.find((l) => l.variant_id === 'var_1')).toBeUndefined()
    expect(updated.lines).toHaveLength(1)
  })

  it('throws when the cart does not exist', async () => {
    await expect(svc.updateLine('ct_missing', 'var_1', 1)).rejects.toThrow(
      /cart/i,
    )
  })

  it('is a noop (returns the cart unchanged) when the variant is not on the cart', async () => {
    const before = (await svc.getCart(cart.token))!
    const after = await svc.updateLine(cart.token, 'var_99', 3)
    expect(after.lines).toEqual(before.lines)
  })

  it('rejects negative quantities', async () => {
    await expect(svc.updateLine(cart.token, 'var_1', -1)).rejects.toThrow(
      /quantity/i,
    )
  })
})

describe('CartService — removeLine', () => {
  let svc: CartService
  let cart: Cart

  beforeEach(async () => {
    svc = new CartService(memoryStore())
    cart = await svc.createCart('shop_1')
    await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_1',
      quantity: 2,
    })
    await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_2',
      quantity: 1,
    })
  })

  it('drops the matching line and leaves the others in place', async () => {
    const updated = await svc.removeLine(cart.token, 'var_1')
    expect(updated.lines).toHaveLength(1)
    expect(updated.lines[0]!.variant_id).toBe('var_2')
  })

  it('is a noop when the variant is not on the cart', async () => {
    const updated = await svc.removeLine(cart.token, 'var_99')
    expect(updated.lines).toHaveLength(2)
  })
})

describe('CartService — clearCart', () => {
  let svc: CartService
  let cart: Cart

  beforeEach(async () => {
    svc = new CartService(memoryStore())
    cart = await svc.createCart('shop_1')
    await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_1',
      quantity: 2,
    })
    await svc.addItem(cart.token, 'shop_1', {
      variant_id: 'var_2',
      quantity: 1,
    })
  })

  it('empties the lines but keeps the token, note and attributes', async () => {
    await svc.setNote(cart.token, 'gift wrap please')
    await svc.setAttributes(cart.token, { source: 'newsletter' })
    const cleared = await svc.clearCart(cart.token)
    expect(cleared.token).toBe(cart.token)
    expect(cleared.lines).toEqual([])
    expect(cleared.note).toBe('gift wrap please')
    expect(cleared.attributes).toEqual({ source: 'newsletter' })
  })
})

describe('CartService — setNote / setAttributes', () => {
  let svc: CartService
  let cart: Cart

  beforeEach(async () => {
    svc = new CartService(memoryStore())
    cart = await svc.createCart('shop_1')
  })

  it('setNote writes and clears the note', async () => {
    const withNote = await svc.setNote(cart.token, 'leave at door')
    expect(withNote.note).toBe('leave at door')
    const cleared = await svc.setNote(cart.token, '')
    expect(cleared.note).toBeNull()
  })

  it('setAttributes merges into the existing bag', async () => {
    await svc.setAttributes(cart.token, { a: '1' })
    const merged = await svc.setAttributes(cart.token, { b: '2' })
    expect(merged.attributes).toEqual({ a: '1', b: '2' })
  })

  it('setAttributes drops keys whose value is the empty string', async () => {
    await svc.setAttributes(cart.token, { a: '1', b: '2' })
    const dropped = await svc.setAttributes(cart.token, { a: '' })
    expect(dropped.attributes).toEqual({ b: '2' })
  })
})

describe('CartService — destroyCart', () => {
  let svc: CartService

  beforeEach(() => {
    svc = new CartService(memoryStore())
  })

  it('removes the cart from the store', async () => {
    const cart = await svc.createCart('shop_1')
    await svc.destroyCart(cart.token)
    expect(await svc.getCart(cart.token)).toBeNull()
  })

  it('is idempotent on unknown tokens', async () => {
    await expect(svc.destroyCart('ct_nope')).resolves.toBeUndefined()
  })
})
