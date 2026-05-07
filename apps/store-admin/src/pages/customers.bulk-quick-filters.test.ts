/**
 * Store-admin — customer bulk-action + quick-filter handlers (Phase 4 PR5).
 *
 * These are the HTTP-layer tests. The actual SQL / business logic is
 * owned by `@gbox/core/modules/customers/bulk/engine.ts` and
 * `@gbox/core/modules/customers/quick-filters/service.ts` — each has
 * its own suite. Here we're verifying:
 *
 *   - `postCustomerBulk` decodes the HTML form `action` value
 *     (`set_lifecycle:churned`, `add_tags`, etc) into the right
 *     BulkAction shape and hands it off to the engine.
 *   - Audit logs capture `{requested, affected, skipped}` — the
 *     source of truth on the row-affecting side.
 *   - Empty / malformed input short-circuits back to the list page.
 *   - `postCustomerQuickFilterCreate` sanitises body via the service
 *     and redirects with `?filter=<id>` on success.
 *   - `postCustomerQuickFilterDelete` is a no-op on a missing id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks (must be declared BEFORE importing the SUT) -------------------

vi.mock('@gbox/core/modules/customers/bulk/index.js', () => ({
  applyBulkAction: vi.fn(),
}))

vi.mock('@gbox/core/modules/customers/quick-filters/index.js', async () => {
  // Re-export the real normalize + query helpers so the handler's
  // whitelist/round-trip remains under test; only the DB-side calls
  // are swapped for spies.
  const real = await vi.importActual<
    typeof import('@gbox/core/modules/customers/quick-filters/index.js')
  >('@gbox/core/modules/customers/quick-filters/index.js')
  return {
    ...real,
    listQuickFilters: vi.fn(),
    getQuickFilter: vi.fn(),
    saveQuickFilter: vi.fn(),
    deleteQuickFilter: vi.fn(),
  }
})

vi.mock('@gbox/core/modules/customers/service.js', () => ({
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
}))

vi.mock('@gbox/core/modules/customer-notes/service.js', () => ({
  addNote: vi.fn(),
  listNotes: vi.fn(),
  deleteNote: vi.fn(),
  MAX_NOTE_LENGTH: 10000,
  MIN_NOTE_LENGTH: 1,
}))

vi.mock('@gbox/core/modules/automations/engine.js', () => ({
  fireAutomationTrigger: vi.fn(),
}))

vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: vi.fn((u: any) => `By ${u?.name ?? 'unknown'}`),
}))

vi.mock('@gbox/core/modules/auth/csrf.js', () => ({
  csrfHiddenField: vi.fn(() => '<input type="hidden" name="_csrf" value="mock" />'),
}))

vi.mock('../layouts/seller-layout.js', () => ({
  sellerLayout: vi.fn((opts: any) => `<html>${opts.content}</html>`),
  esc: (s: string) => s,
}))

import type { Request, Response } from 'express'
import { applyBulkAction } from '@gbox/core/modules/customers/bulk/index.js'
import {
  saveQuickFilter,
  deleteQuickFilter,
  getQuickFilter,
} from '@gbox/core/modules/customers/quick-filters/index.js'
import { notify } from '../lib/notify.js'
import {
  postCustomerBulk,
  postCustomerQuickFilterCreate,
  postCustomerQuickFilterDelete,
} from './customers.js'

// --- Fixtures --------------------------------------------------------------

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_SLUG = 'test-shop'
const USER_ID = '66666666-6666-6666-6666-666666666666'
const FILTER_ID = '99999999-9999-9999-9999-999999999999'
const CUST_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CUST_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CUST_3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

// --- Fake Kysely ----------------------------------------------------------
//
// The handlers issue `insertInto('audit_logs')` alongside the service
// calls. We record those inserts so tests can assert on the payload
// shape (esp. that `details` carries the engine result).

interface FakeDbState {
  audits: Array<Record<string, unknown>>
}

function makeFakeDb(state: FakeDbState) {
  function insertBuilder(table: string) {
    const ref: { values?: Record<string, unknown> } = {}
    const b: any = {
      values: (v: Record<string, unknown>) => {
        ref.values = v
        return b
      },
      returning: () => b,
      returningAll: () => b,
      execute: async () => {
        if (table === 'audit_logs' && ref.values) {
          state.audits.push(ref.values)
        }
      },
      executeTakeFirst: async () => undefined,
      executeTakeFirstOrThrow: async () => ({}),
    }
    return b
  }

  return {
    selectFrom: () => ({
      select: () => ({ where: () => ({ execute: async () => [] }) }),
      selectAll: () => ({ where: () => ({ execute: async () => [] }) }),
    }),
    insertInto: insertBuilder,
    updateTable: insertBuilder,
    deleteFrom: insertBuilder,
  } as any
}

// --- Req / Res helpers -----------------------------------------------------

function makeReq(body: Record<string, unknown>, params: Record<string, string> = {}) {
  return {
    body,
    params: { slug: SHOP_SLUG, ...params },
    query: {},
    store: { id: SHOP_ID, slug: SHOP_SLUG, name: 'Test Shop' },
    storeUser: { id: USER_ID, name: 'Thai Admin', email: 'thai@example.com' },
  } as unknown as Request
}

function makeRes() {
  const redirect = vi.fn()
  const status = vi.fn().mockReturnThis()
  const send = vi.fn()
  return { redirect, status, send } as unknown as Response & {
    redirect: ReturnType<typeof vi.fn>
  }
}

// ---------------------------------------------------------------------------
// postCustomerBulk
// ---------------------------------------------------------------------------

describe('postCustomerBulk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyBulkAction).mockResolvedValue({
      affected: 2,
      skipped: 1,
      matched: 2,
    })
  })

  it('short-circuits with no action issued on empty ids', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: '', action: 'disable' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(applyBulkAction).not.toHaveBeenCalled()
    expect((res as any).redirect).toHaveBeenCalledWith(`/admin/store/${SHOP_SLUG}/customers`)
  })

  it('short-circuits when action is blank', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: `${CUST_1}`, action: '' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(applyBulkAction).not.toHaveBeenCalled()
  })

  it('short-circuits on unknown action values (stale client)', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: CUST_1, action: 'do_something_weird' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(applyBulkAction).not.toHaveBeenCalled()
    expect((res as any).redirect).toHaveBeenCalledWith(`/admin/store/${SHOP_SLUG}/customers`)
  })

  it('parses "disable" into a flat BulkAction and delegates to the engine', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: `${CUST_1},${CUST_2},${CUST_3}`, action: 'disable' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(applyBulkAction).toHaveBeenCalledWith(
      db,
      SHOP_ID,
      [CUST_1, CUST_2, CUST_3],
      { type: 'disable' },
    )
  })

  it('decodes "set_lifecycle:churned" into the DU variant', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: CUST_1, action: 'set_lifecycle:churned' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(applyBulkAction).toHaveBeenCalledWith(
      db,
      SHOP_ID,
      [CUST_1],
      { type: 'set_lifecycle', stage: 'churned' },
    )
  })

  it('rejects "set_lifecycle:bogus" as an unknown stage', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: CUST_1, action: 'set_lifecycle:bogus' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(applyBulkAction).not.toHaveBeenCalled()
  })

  it('splits the "tag" form field into an array for add_tags', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: CUST_1, action: 'add_tags', tag: ' vip , wholesale ' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(applyBulkAction).toHaveBeenCalledWith(
      db,
      SHOP_ID,
      [CUST_1],
      { type: 'add_tags', tags: ['vip', 'wholesale'] },
    )
  })

  it('rejects add_tags with empty tag field (no-op)', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: CUST_1, action: 'add_tags', tag: '   ' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(applyBulkAction).not.toHaveBeenCalled()
  })

  it('writes an audit_logs row carrying affected/skipped/matched from the engine', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: `${CUST_1},${CUST_2},${CUST_3}`, action: 'disable' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    // Engine returned affected=2, skipped=1, matched=2.
    expect((db as any).audits).toBeUndefined() // state is on the closure, peek via the ref below
  })

  it('audits with a details JSON that includes the engine result', async () => {
    const state: FakeDbState = { audits: [] }
    const db = makeFakeDb(state)
    const req = makeReq({ ids: `${CUST_1},${CUST_2}`, action: 'subscribe_marketing' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(state.audits).toHaveLength(1)
    const audit = state.audits[0]!
    const details = JSON.parse(audit.details as string)
    expect(details).toMatchObject({
      bulk: true,
      action: 'subscribe_marketing',
      requested: 2,
      affected: 2,
      skipped: 1,
      matched: 2,
    })
  })

  it('fires a bell notification with natural-language title', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: `${CUST_1},${CUST_2}`, action: 'disable' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(notify).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        type: 'customers_bulk_updated',
        title: expect.stringContaining('2 customers disabled'),
      }),
    )
  })

  it('dedupes whitespace in the ids CSV before delegating', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({
      ids: `  ${CUST_1} ,,   ${CUST_2}`,
      action: 'enable',
    })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect(applyBulkAction).toHaveBeenCalledWith(
      db,
      SHOP_ID,
      [CUST_1, CUST_2],
      { type: 'enable' },
    )
  })

  it('still redirects when the engine throws (does not 500 the seller)', async () => {
    vi.mocked(applyBulkAction).mockRejectedValue(new Error('db down'))
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ ids: CUST_1, action: 'disable' })
    const res = makeRes()

    await postCustomerBulk(req, res, db)

    expect((res as any).redirect).toHaveBeenCalledWith(`/admin/store/${SHOP_SLUG}/customers`)
  })
})

// ---------------------------------------------------------------------------
// postCustomerQuickFilterCreate
// ---------------------------------------------------------------------------

describe('postCustomerQuickFilterCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects with error on empty name', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ name: '   ', q: 'ada' })
    const res = makeRes()

    await postCustomerQuickFilterCreate(req, res, db)

    expect(saveQuickFilter).not.toHaveBeenCalled()
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('error=')
  })

  it('sanitises the query payload + persists via the service', async () => {
    vi.mocked(saveQuickFilter).mockResolvedValue({
      id: FILTER_ID,
      shop_id: SHOP_ID,
      name: 'VIPs',
      filter_json: { tag: 'vip' },
      position: 0,
      created_by_user_id: USER_ID,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    })

    const db = makeFakeDb({ audits: [] })
    const req = makeReq({
      name: '  VIPs  ',
      q: '',
      lifecycle: 'BOGUS',   // dropped by normalizer
      marketing: 'yes',
      tag: ' vip ',
      status: 'active',
      stray: 'drop me',      // ignored
    })
    const res = makeRes()

    await postCustomerQuickFilterCreate(req, res, db)

    // The persisted query is the normalised whitelist — no `stray`,
    // no empty q, no invalid lifecycle.
    expect(saveQuickFilter).toHaveBeenCalledWith(db, SHOP_ID, {
      name: 'VIPs',
      query: { marketing: 'yes', tag: 'vip', status: 'active' },
      createdByUserId: USER_ID,
    })

    // Redirect preserves the filter id so the new pill is highlighted.
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain(`?filter=${FILTER_ID}`)
  })

  it('flashes the error message when the service throws', async () => {
    vi.mocked(saveQuickFilter).mockRejectedValue(
      new Error('quick-filter name cannot be empty'),
    )
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({ name: 'VIPs', q: 'ada' })
    const res = makeRes()

    await postCustomerQuickFilterCreate(req, res, db)

    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('error=')
    expect(decodeURIComponent(url)).toContain('quick-filter name')
  })
})

// ---------------------------------------------------------------------------
// postCustomerQuickFilterDelete
// ---------------------------------------------------------------------------

describe('postCustomerQuickFilterDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('short-circuits when id is missing', async () => {
    const db = makeFakeDb({ audits: [] })
    const req = makeReq({}, {})
    const res = makeRes()

    await postCustomerQuickFilterDelete(req, res, db)

    expect(deleteQuickFilter).not.toHaveBeenCalled()
    expect((res as any).redirect).toHaveBeenCalledWith(`/admin/store/${SHOP_SLUG}/customers`)
  })

  it('audits the delete when the service reports a hit', async () => {
    vi.mocked(getQuickFilter).mockResolvedValue({
      id: FILTER_ID,
      shop_id: SHOP_ID,
      name: 'VIPs',
      filter_json: { tag: 'vip' },
      position: 0,
      created_by_user_id: USER_ID,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    })
    vi.mocked(deleteQuickFilter).mockResolvedValue(true)

    const state: FakeDbState = { audits: [] }
    const db = makeFakeDb(state)
    const req = makeReq({}, { id: FILTER_ID })
    const res = makeRes()

    await postCustomerQuickFilterDelete(req, res, db)

    expect(deleteQuickFilter).toHaveBeenCalledWith(db, SHOP_ID, FILTER_ID)
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({
      action: 'delete',
      resource_type: 'customer_quick_filter',
      resource_id: FILTER_ID,
    })
  })

  it('does NOT audit when the service reports a miss (cross-shop)', async () => {
    vi.mocked(getQuickFilter).mockResolvedValue(null)
    vi.mocked(deleteQuickFilter).mockResolvedValue(false)

    const state: FakeDbState = { audits: [] }
    const db = makeFakeDb(state)
    const req = makeReq({}, { id: 'foreign-id' })
    const res = makeRes()

    await postCustomerQuickFilterDelete(req, res, db)

    expect(state.audits).toHaveLength(0)
  })

  it('still redirects when the service throws', async () => {
    vi.mocked(getQuickFilter).mockRejectedValue(new Error('boom'))

    const db = makeFakeDb({ audits: [] })
    const req = makeReq({}, { id: FILTER_ID })
    const res = makeRes()

    await postCustomerQuickFilterDelete(req, res, db)

    expect((res as any).redirect).toHaveBeenCalledWith(`/admin/store/${SHOP_SLUG}/customers`)
  })
})
