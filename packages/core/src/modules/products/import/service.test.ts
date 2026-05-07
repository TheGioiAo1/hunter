/**
 * Import service dry-run tests.
 *
 * The Windows dev host can't reach Postgres (see memory/smoke_test_runbook.md),
 * so we use an in-memory fake Kysely-shape builder — same pattern as the
 * export service tests.
 *
 * Coverage targets:
 *   - Shop-scoping: OTHER_SHOP products/variants are invisible to the planner
 *   - Upsert match: existing handle → 'update', new handle → 'create'
 *   - Variant reuse: SKU match wins; option-tuple fallback when SKU null
 *   - SKU collision across products in same shop → blocking error
 *   - Structural errors bubble up into `issues` + `rowsBlocked` tally
 */

import { describe, it, expect } from 'vitest'
import { buildImportPlan } from './service.js'
import type { ParsedProduct, ParsedVariant } from './csv-parser.js'

// ---------------------------------------------------------------------------
// Fake Kysely
// ---------------------------------------------------------------------------

interface FakeTableData {
  [table: string]: Array<Record<string, any>>
}

interface WhereClause {
  col: string
  op: string
  val: any
}

function makeFakeDb(tables: FakeTableData) {
  function selectFrom(table: string) {
    const wheres: WhereClause[] = []
    let limit: number | undefined
    let selectCols: string[] | null = null
    const joins: Array<{ table: string; lhs: string; rhs: string }> = []

    const builder: any = {
      selectAll() {
        selectCols = null
        return builder
      },
      select(cols: any) {
        selectCols = Array.isArray(cols) ? cols : [cols]
        return builder
      },
      innerJoin(tbl: string, lhs: string, rhs: string) {
        joins.push({ table: tbl, lhs, rhs })
        return builder
      },
      where(col: any, op?: any, val?: any) {
        if (typeof col === 'function') return builder
        wheres.push({ col, op, val })
        return builder
      },
      limit(n: number) {
        limit = n
        return builder
      },
      async execute() {
        let rows = (tables[table] ?? []).map((r) => ({ ...r }))

        // Handle joins by pulling in rows from the joined table.
        for (const j of joins) {
          const joinRows = tables[j.table] ?? []
          const merged: Array<Record<string, any>> = []
          for (const base of rows) {
            for (const jr of joinRows) {
              // j.lhs / j.rhs are fully-qualified "table.column". Resolve
              // each against whichever side matches its table prefix.
              const lhsVal = refFor(j.lhs, { [table]: base, [j.table]: jr })
              const rhsVal = refFor(j.rhs, { [table]: base, [j.table]: jr })
              if (lhsVal === rhsVal) {
                const composite: Record<string, any> = { ...base }
                for (const [k, v] of Object.entries(jr)) {
                  composite[`${j.table}.${k}`] = v
                  if (!(k in composite)) composite[k] = v
                }
                for (const [k, v] of Object.entries(base)) {
                  composite[`${table}.${k}`] = v
                }
                merged.push(composite)
              }
            }
          }
          rows = merged
        }

        for (const w of wheres) {
          rows = rows.filter((r) => matches(r, w))
        }
        if (limit != null) rows = rows.slice(0, limit)
        if (selectCols) {
          rows = rows.map((r) => {
            const picked: Record<string, any> = {}
            for (const c of selectCols as string[]) {
              // Support "table.column as alias" form.
              const aliasMatch = /(.+)\s+as\s+(.+)/i.exec(c)
              if (aliasMatch) {
                picked[aliasMatch[2]!] = r[aliasMatch[1]!]
              } else {
                // Support bare and qualified forms.
                picked[c.includes('.') ? c.split('.').pop()! : c] =
                  r[c] ?? r[c.split('.').pop()!]
              }
            }
            return picked
          })
        }
        return rows
      },
    }
    return builder
  }
  return { selectFrom } as any
}

/** Resolve a "table.column" reference against a per-table row map. */
function refFor(ref: string, rows: Record<string, Record<string, any>>): any {
  const dot = ref.indexOf('.')
  if (dot < 0) {
    // Bare column — look it up in any of the rows, first-wins.
    for (const r of Object.values(rows)) if (ref in r) return r[ref]
    return undefined
  }
  const table = ref.slice(0, dot)
  const col = ref.slice(dot + 1)
  return rows[table]?.[col]
}

function matches(row: Record<string, any>, w: WhereClause): boolean {
  const lhs =
    row[w.col] ??
    (w.col.includes('.') ? row[w.col.split('.').pop()!] : undefined)
  switch (w.op) {
    case '=':
      return lhs === w.val
    case 'in':
      if (Array.isArray(w.val)) return w.val.includes(lhs)
      return false
    default:
      return true
  }
}

// ---------------------------------------------------------------------------
// Helpers to build ParsedProduct fixtures
// ---------------------------------------------------------------------------

function variant(overrides: Partial<ParsedVariant> = {}): ParsedVariant {
  return {
    sourceRow: 2,
    sku: 'SKU-NEW',
    barcode: null,
    price: '10.00',
    compare_at_price: null,
    cost: null,
    grams: 0,
    weight_unit: 'g',
    inventory_quantity: 0,
    inventory_policy: 'deny',
    inventory_tracker: '',
    fulfillment_service: 'manual',
    requires_shipping: true,
    taxable: true,
    option1: 'Default',
    option2: null,
    option3: null,
    image_url: null,
    hs_code: null,
    country_of_origin: null,
    metafields: {},
    ...overrides,
  }
}

function product(overrides: Partial<ParsedProduct> = {}): ParsedProduct {
  return {
    sourceRow: 2,
    handle: 'new-handle',
    title: 'New Product',
    body_html: null,
    vendor: null,
    product_type: null,
    tags: null,
    published: null,
    status: 'active',
    seo_title: null,
    seo_description: null,
    gift_card: null,
    variants: [variant()],
    images: [],
    optionNames: [null, null, null],
    metafields: {},
    extraColumns: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = 'shop-A'
const OTHER_SHOP = 'shop-B'

function baseFixture(): FakeTableData {
  return {
    products: [
      { id: 'p-existing', shop_id: SHOP, handle: 'existing-tee' },
      { id: 'p-other-shop', shop_id: OTHER_SHOP, handle: 'existing-tee' }, // same handle, other shop — must not collide
    ],
    product_variants: [
      { id: 'v-1', product_id: 'p-existing', sku: 'SKU-EXISTING', option1: 'Small', option2: null, option3: null },
      { id: 'v-2', product_id: 'p-existing', sku: 'SKU-EXISTING-M', option1: 'Medium', option2: null, option3: null },
      // Cross-shop SKU must be invisible to the planner.
      { id: 'v-x', product_id: 'p-other-shop', sku: 'SKU-EXISTING', option1: 'Small', option2: null, option3: null },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildImportPlan — create vs update detection', () => {
  it('marks a parsed handle with no match as create', async () => {
    const db = makeFakeDb(baseFixture())
    const plan = await buildImportPlan(SHOP, [product({ handle: 'brand-new' })], db)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]!.action).toBe('create')
    expect(plan.items[0]!.existingProductId).toBeNull()
    expect(plan.stats.productsCreating).toBe(1)
    expect(plan.stats.productsUpdating).toBe(0)
  })

  it('marks a parsed handle with DB match in the same shop as update', async () => {
    const db = makeFakeDb(baseFixture())
    const plan = await buildImportPlan(
      SHOP,
      [product({ handle: 'existing-tee', variants: [variant({ sku: 'SKU-EXISTING', option1: 'Small' })] })],
      db,
    )
    expect(plan.items[0]!.action).toBe('update')
    expect(plan.items[0]!.existingProductId).toBe('p-existing')
    expect(plan.stats.productsUpdating).toBe(1)
  })

  it('does not match handles from other shops (shop-scoping)', async () => {
    const db = makeFakeDb({
      products: [{ id: 'p-other-shop', shop_id: OTHER_SHOP, handle: 'only-in-other' }],
      product_variants: [],
    })
    const plan = await buildImportPlan(SHOP, [product({ handle: 'only-in-other' })], db)
    expect(plan.items[0]!.action).toBe('create')
  })
})

describe('buildImportPlan — variant matching', () => {
  it('matches existing variant by SKU first', async () => {
    const db = makeFakeDb(baseFixture())
    const plan = await buildImportPlan(
      SHOP,
      [
        product({
          handle: 'existing-tee',
          variants: [variant({ sku: 'SKU-EXISTING', option1: 'DIFFERENT OPTIONS SHOULD STILL MATCH BY SKU' })],
        }),
      ],
      db,
    )
    expect(plan.items[0]!.variantPlan[0]!.action).toBe('update')
    expect(plan.items[0]!.variantPlan[0]!.existingVariantId).toBe('v-1')
  })

  it('matches existing variant by option-tuple when SKU is null', async () => {
    const db = makeFakeDb(baseFixture())
    const plan = await buildImportPlan(
      SHOP,
      [
        product({
          handle: 'existing-tee',
          variants: [variant({ sku: null, option1: 'Medium', option2: null, option3: null })],
        }),
      ],
      db,
    )
    expect(plan.items[0]!.variantPlan[0]!.action).toBe('update')
    expect(plan.items[0]!.variantPlan[0]!.existingVariantId).toBe('v-2')
  })

  it('plans a create when no existing variant matches', async () => {
    const db = makeFakeDb(baseFixture())
    const plan = await buildImportPlan(
      SHOP,
      [
        product({
          handle: 'existing-tee',
          variants: [variant({ sku: 'SKU-BRAND-NEW', option1: 'XL' })],
        }),
      ],
      db,
    )
    expect(plan.items[0]!.variantPlan[0]!.action).toBe('create')
    expect(plan.items[0]!.variantPlan[0]!.existingVariantId).toBeNull()
  })
})

describe('buildImportPlan — SKU cross-product conflict', () => {
  it('flags an error when SKU is used by a different product in the same shop', async () => {
    const db = makeFakeDb(baseFixture())
    const plan = await buildImportPlan(
      SHOP,
      [product({ handle: 'brand-new', variants: [variant({ sku: 'SKU-EXISTING' })] })],
      db,
    )
    const issue = plan.issues.find((i) => i.code === 'sku_conflict_other_product')
    expect(issue).toBeTruthy()
    expect(issue!.severity).toBe('error')
    expect(plan.items[0]!.action).toBe('blocked')
    expect(plan.stats.productsBlocked).toBe(1)
  })

  it('ignores cross-shop SKU collisions (SKU unique per shop)', async () => {
    // Shop A imports a product with SKU-EXISTING — that SKU exists in
    // p-other-shop but NOT in shop A, so no conflict.
    const fixture: FakeTableData = {
      products: [{ id: 'p-other-shop', shop_id: OTHER_SHOP, handle: 'other-handle' }],
      product_variants: [
        {
          id: 'v-other',
          product_id: 'p-other-shop',
          sku: 'SKU-EXISTING',
          option1: null,
          option2: null,
          option3: null,
        },
      ],
    }
    const db = makeFakeDb(fixture)
    const plan = await buildImportPlan(
      SHOP,
      [product({ handle: 'new', variants: [variant({ sku: 'SKU-EXISTING' })] })],
      db,
    )
    expect(plan.issues.find((i) => i.code === 'sku_conflict_other_product')).toBeFalsy()
    expect(plan.items[0]!.action).toBe('create')
  })

  it('allows same-product SKU match (update), not a conflict', async () => {
    const db = makeFakeDb(baseFixture())
    const plan = await buildImportPlan(
      SHOP,
      [
        product({
          handle: 'existing-tee',
          variants: [variant({ sku: 'SKU-EXISTING' })],
        }),
      ],
      db,
    )
    expect(plan.issues.find((i) => i.code === 'sku_conflict_other_product')).toBeFalsy()
    expect(plan.items[0]!.action).toBe('update')
  })
})

describe('buildImportPlan — structural issues surface in plan', () => {
  it('marks products blocked by structural validation as action=blocked', async () => {
    const db = makeFakeDb(baseFixture())
    const plan = await buildImportPlan(
      SHOP,
      [product({ handle: 'brand-new', title: null })], // title_required
      db,
    )
    expect(plan.items[0]!.action).toBe('blocked')
    expect(plan.stats.productsBlocked).toBe(1)
    expect(plan.issues.some((i) => i.code === 'title_required')).toBe(true)
  })
})

describe('buildImportPlan — empty input', () => {
  it('returns an empty plan on empty input (no DB calls crash)', async () => {
    const db = makeFakeDb(baseFixture())
    const plan = await buildImportPlan(SHOP, [], db)
    expect(plan.items).toHaveLength(0)
    expect(plan.issues).toHaveLength(0)
    expect(plan.stats).toEqual({
      productsCreating: 0,
      productsUpdating: 0,
      productsBlocked: 0,
      variantsCreating: 0,
      variantsUpdating: 0,
      rowsBlocked: 0,
    })
  })
})
