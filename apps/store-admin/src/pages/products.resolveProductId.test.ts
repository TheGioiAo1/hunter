/**
 * Store-admin — `resolveProductId` unit tests.
 *
 * Regression fix (2026-04-17): collection pages link to
 * `/admin/store/:slug/products/:handle` using the product slug, but the
 * product-detail route historically fed `req.params.productId` straight
 * into `where('id', '=', productId)` on a uuid column. Non-UUID input
 * bubbled up as `invalid input syntax for type uuid` → 500 → generic
 * page-not-found.
 *
 * The helper under test translates the raw param into a UUID before the
 * query runs: canonical 8-4-4-4-12 hex passes through, anything else
 * gets resolved via a `products.slug` lookup scoped to the shop. A miss
 * returns the zero UUID so the caller's existing `if (!existing)` 404
 * branch fires without needing edits.
 */

import { describe, it, expect, vi } from 'vitest'

import { resolveProductId } from './products.js'

// ---------------------------------------------------------------------------
// Kysely stub — just enough chain to satisfy the one query the helper runs.
// ---------------------------------------------------------------------------

interface FakeProduct {
  id: string
  shop_id: string
  slug: string
}

function fakeDb(rows: FakeProduct[]) {
  // Records each call so assertions can inspect what the helper asked for.
  const calls: Array<{ shop_id?: string; slug?: string }> = []

  const makeBuilder = () => {
    const filters: { shop_id?: string; slug?: string } = {}
    const builder: any = {
      select: () => builder,
      where: (col: string, _op: string, val: string) => {
        if (col === 'shop_id') filters.shop_id = val
        if (col === 'slug') filters.slug = val
        return builder
      },
      executeTakeFirst: async () => {
        calls.push({ ...filters })
        const row = rows.find(
          (r) => r.shop_id === filters.shop_id && r.slug === filters.slug,
        )
        return row ? { id: row.id } : undefined
      },
    }
    return builder
  }

  return {
    calls,
    db: {
      selectFrom: vi.fn(() => makeBuilder()),
    } as any,
  }
}

// Valid-looking UUIDs — any hex in the 8-4-4-4-12 shape passes the regex.
const PROD_UUID = 'f9fe9fc6-6d1c-4567-a7be-724cd0a90ddc'
const SHOP_UUID = '11111111-2222-3333-4444-555555555555'
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveProductId', () => {
  it('returns a canonical UUID input unchanged without touching the DB', async () => {
    const { db, calls } = fakeDb([])
    const out = await resolveProductId(db, SHOP_UUID, PROD_UUID)
    expect(out).toBe(PROD_UUID)
    // No slug lookup should have fired — we short-circuit on UUID shape.
    expect(calls).toHaveLength(0)
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('accepts upper-case UUIDs (Postgres casts casing-insensitively)', async () => {
    const { db } = fakeDb([])
    const upper = PROD_UUID.toUpperCase()
    const out = await resolveProductId(db, SHOP_UUID, upper)
    expect(out).toBe(upper)
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('resolves a slug to the matching product UUID', async () => {
    const { db, calls } = fakeDb([
      {
        id: PROD_UUID,
        shop_id: SHOP_UUID,
        slug: 'little-women-ceramic-book-vase-small',
      },
    ])
    const out = await resolveProductId(
      db,
      SHOP_UUID,
      'little-women-ceramic-book-vase-small',
    )
    expect(out).toBe(PROD_UUID)
    // The lookup must be scoped to both shop_id and slug — never leak
    // products between shops.
    expect(calls).toEqual([
      {
        shop_id: SHOP_UUID,
        slug: 'little-women-ceramic-book-vase-small',
      },
    ])
  })

  it('returns the zero UUID when the slug does not exist (no crash)', async () => {
    const { db } = fakeDb([])
    const out = await resolveProductId(db, SHOP_UUID, 'does-not-exist')
    // Zero UUID is a valid uuid value that can never match a real row,
    // so downstream `where('id', '=', productId)` queries return no
    // rows and the caller's existing 404 path fires naturally.
    expect(out).toBe(ZERO_UUID)
  })

  it('refuses to cross-shop match a slug from a different shop', async () => {
    const OTHER_SHOP = '99999999-9999-9999-9999-999999999999'
    const { db } = fakeDb([
      {
        id: PROD_UUID,
        shop_id: OTHER_SHOP, // belongs to a different shop
        slug: 'borrowed-slug',
      },
    ])
    const out = await resolveProductId(db, SHOP_UUID, 'borrowed-slug')
    // Different shop → no match → zero UUID. This is the cross-tenant
    // leak guard; without it a hostile merchant could probe another
    // shop's product via slug.
    expect(out).toBe(ZERO_UUID)
  })

  it('returns the zero UUID for empty input without hitting the DB', async () => {
    const { db } = fakeDb([])
    const out = await resolveProductId(db, SHOP_UUID, '')
    expect(out).toBe(ZERO_UUID)
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('trims whitespace before matching', async () => {
    // Some older redirects added leading/trailing whitespace; the raw
    // param is still a valid slug once trimmed. Don't surface that as
    // a "product not found" just because of cosmetic whitespace.
    const { db } = fakeDb([
      {
        id: PROD_UUID,
        shop_id: SHOP_UUID,
        slug: 'my-product',
      },
    ])
    const out = await resolveProductId(db, SHOP_UUID, '  my-product  ')
    expect(out).toBe(PROD_UUID)
  })

  it('rejects obviously malformed uuid-ish inputs and falls back to slug lookup', async () => {
    // A string that's UUID-flavoured but the wrong length must NOT be
    // passed through — it would still fail the pg cast. Instead we
    // fall through to the slug path (which will miss harmlessly).
    const { db, calls } = fakeDb([])
    const out = await resolveProductId(db, SHOP_UUID, 'not-a-valid-uuid')
    expect(out).toBe(ZERO_UUID)
    expect(calls).toEqual([{ shop_id: SHOP_UUID, slug: 'not-a-valid-uuid' }])
  })
})
