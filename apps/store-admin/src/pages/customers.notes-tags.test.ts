/**
 * Store-admin — customer notes + tags route handlers (Phase 4 PR1).
 *
 * Covers:
 *   - postCustomerAddNote happy path + empty-body short-circuit.
 *   - postCustomerAddNote propagates service errors via redirect flash.
 *   - postCustomerDeleteNote happy path + "not found / cross-shop" path.
 *   - postCustomerUpdateTags add: deduplicates, updates via service.
 *   - postCustomerUpdateTags remove: filters out the target tag.
 *   - postCustomerUpdateTags cross-shop rejection (customer lookup fails).
 *   - postCustomerUpdateTags invalid action / empty tag / over-long tag.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks (must be declared BEFORE importing the SUT) ---------------------

vi.mock('@gbox/core/modules/customer-notes/service.js', () => ({
  addNote: vi.fn(),
  listNotes: vi.fn(),
  deleteNote: vi.fn(),
  MAX_NOTE_LENGTH: 10000,
  MIN_NOTE_LENGTH: 1,
}))

vi.mock('@gbox/core/modules/customers/service.js', () => ({
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
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
import {
  addNote as addNoteService,
  deleteNote as deleteNoteService,
} from '@gbox/core/modules/customer-notes/service.js'
import { updateCustomer } from '@gbox/core/modules/customers/service.js'
import {
  postCustomerAddNote,
  postCustomerDeleteNote,
  postCustomerUpdateTags,
} from './customers.js'

// --- Fixtures --------------------------------------------------------------

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_SLUG = 'test-shop'
const CUSTOMER_ID = '33333333-3333-3333-3333-333333333333'
const NOTE_ID = '55555555-5555-5555-5555-555555555555'
const USER_ID = '66666666-6666-6666-6666-666666666666'

// --- Fake Kysely ----------------------------------------------------------
//
// The route handlers issue direct selectFrom('customers') + insertInto(
// 'audit_logs') calls outside the mocked core service. We emulate those
// with a tiny builder that records every operation so tests can assert
// behaviour (and swap the "customer exists" bit for cross-shop tests).

interface FakeDbState {
  customers: Array<{ id: string; shop_id: string; tags: string[] | null }>
  audits: Array<Record<string, unknown>>
}

function makeFakeDb(state: FakeDbState) {
  function selectBuilder(table: string) {
    const filters: Array<[string, string, unknown]> = []
    const b: any = {
      select: () => b,
      selectAll: () => b,
      where: (col: string, op: string, val: unknown) => {
        filters.push([col, op, val])
        return b
      },
      orderBy: () => b,
      limit: () => b,
      offset: () => b,
      executeTakeFirst: async () => {
        if (table === 'customers') {
          const shop = filters.find(f => f[0] === 'shop_id')?.[2]
          const id = filters.find(f => f[0] === 'id')?.[2]
          return state.customers.find(c => c.id === id && c.shop_id === shop)
        }
        return undefined
      },
      execute: async () => [],
    }
    return b
  }

  function insertBuilder(table: string) {
    const payloadRef: { values?: Record<string, unknown> } = {}
    const b: any = {
      values: (v: Record<string, unknown>) => {
        payloadRef.values = v
        return b
      },
      returningAll: () => b,
      execute: async () => {
        if (table === 'audit_logs' && payloadRef.values) {
          state.audits.push(payloadRef.values)
        }
      },
      executeTakeFirst: async () => undefined,
      executeTakeFirstOrThrow: async () => ({}),
    }
    return b
  }

  return {
    selectFrom: selectBuilder,
    insertInto: insertBuilder,
    updateTable: (t: string) => insertBuilder(t), // unused in these tests
    deleteFrom: (t: string) => insertBuilder(t),
  } as any
}

// --- Req / Res helpers -----------------------------------------------------

function makeReq(body: Record<string, unknown>, params: Record<string, string> = {}) {
  return {
    body,
    params: { slug: SHOP_SLUG, customerId: CUSTOMER_ID, ...params },
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
// Tests
// ---------------------------------------------------------------------------

describe('postCustomerAddNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls the service and redirects to the detail page with success flash', async () => {
    vi.mocked(addNoteService).mockResolvedValue({
      id: NOTE_ID,
      shop_id: SHOP_ID,
      customer_id: CUSTOMER_ID,
      body: 'nice customer',
      author_user_id: USER_ID,
      author_name_snapshot: 'Thai Admin',
      created_at: '2026-04-20T00:00:00Z',
    } as any)

    const db = makeFakeDb({ customers: [], audits: [] })
    const req = makeReq({ body: 'nice customer' })
    const res = makeRes()

    await postCustomerAddNote(req, res, db)

    expect(addNoteService).toHaveBeenCalledWith(db, expect.objectContaining({
      shop_id: SHOP_ID,
      customer_id: CUSTOMER_ID,
      body: 'nice customer',
      author_user_id: USER_ID,
      author_name_snapshot: 'Thai Admin',
    }))
    expect((res as any).redirect).toHaveBeenCalledWith(
      `/admin/store/${SHOP_SLUG}/customers/${CUSTOMER_ID}?success=note_added`,
    )
  })

  it('short-circuits on empty body with an error flash, never calls service', async () => {
    const db = makeFakeDb({ customers: [], audits: [] })
    const req = makeReq({ body: '   ' })
    const res = makeRes()

    await postCustomerAddNote(req, res, db)

    expect(addNoteService).not.toHaveBeenCalled()
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('error=')
    expect(url).toContain('required')
  })

  it('propagates service errors as error-flash redirects', async () => {
    vi.mocked(addNoteService).mockRejectedValue(new Error('Customer not found in this shop'))

    const db = makeFakeDb({ customers: [], audits: [] })
    const req = makeReq({ body: 'malicious cross-shop' })
    const res = makeRes()

    await postCustomerAddNote(req, res, db)

    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('error=')
    expect(decodeURIComponent(url)).toContain('Customer not found in this shop')
  })
})

describe('postCustomerDeleteNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects with success when the service confirms deletion', async () => {
    vi.mocked(deleteNoteService).mockResolvedValue(true)

    const db = makeFakeDb({ customers: [], audits: [] })
    const req = makeReq({}, { noteId: NOTE_ID })
    const res = makeRes()

    await postCustomerDeleteNote(req, res, db)

    expect(deleteNoteService).toHaveBeenCalledWith(db, {
      shop_id: SHOP_ID,
      note_id: NOTE_ID,
    })
    expect((res as any).redirect).toHaveBeenCalledWith(
      `/admin/store/${SHOP_SLUG}/customers/${CUSTOMER_ID}?success=note_deleted`,
    )
  })

  it('redirects with error flash when the note was not found (or cross-shop)', async () => {
    vi.mocked(deleteNoteService).mockResolvedValue(false)

    const db = makeFakeDb({ customers: [], audits: [] })
    const req = makeReq({}, { noteId: NOTE_ID })
    const res = makeRes()

    await postCustomerDeleteNote(req, res, db)

    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('error=')
    expect(decodeURIComponent(url)).toContain('not found')
  })
})

describe('postCustomerUpdateTags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(updateCustomer).mockResolvedValue({} as any)
  })

  it('add: dedupes and persists via updateCustomer', async () => {
    const db = makeFakeDb({
      customers: [{ id: CUSTOMER_ID, shop_id: SHOP_ID, tags: ['vip'] }],
      audits: [],
    })
    const req = makeReq({ action: 'add', tag: 'wholesale' })
    const res = makeRes()

    await postCustomerUpdateTags(req, res, db)

    expect(updateCustomer).toHaveBeenCalledWith(
      db,
      SHOP_ID,
      CUSTOMER_ID,
      expect.objectContaining({ tags: ['vip', 'wholesale'] }),
    )
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('success=tag_added')
  })

  it('add: no-op when tag already exists (still redirects cleanly, service not called)', async () => {
    const db = makeFakeDb({
      customers: [{ id: CUSTOMER_ID, shop_id: SHOP_ID, tags: ['vip'] }],
      audits: [],
    })
    const req = makeReq({ action: 'add', tag: 'vip' })
    const res = makeRes()

    await postCustomerUpdateTags(req, res, db)

    expect(updateCustomer).not.toHaveBeenCalled()
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('success=tag_exists')
  })

  it('remove: filters the matching tag out', async () => {
    const db = makeFakeDb({
      customers: [
        { id: CUSTOMER_ID, shop_id: SHOP_ID, tags: ['vip', 'wholesale', 'press'] },
      ],
      audits: [],
    })
    const req = makeReq({ action: 'remove', tag: 'wholesale' })
    const res = makeRes()

    await postCustomerUpdateTags(req, res, db)

    expect(updateCustomer).toHaveBeenCalledWith(
      db,
      SHOP_ID,
      CUSTOMER_ID,
      expect.objectContaining({ tags: ['vip', 'press'] }),
    )
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('success=tag_removed')
  })

  it('remove: writes null tags when the final list is empty', async () => {
    const db = makeFakeDb({
      customers: [{ id: CUSTOMER_ID, shop_id: SHOP_ID, tags: ['only'] }],
      audits: [],
    })
    const req = makeReq({ action: 'remove', tag: 'only' })
    const res = makeRes()

    await postCustomerUpdateTags(req, res, db)

    expect(updateCustomer).toHaveBeenCalledWith(
      db,
      SHOP_ID,
      CUSTOMER_ID,
      expect.objectContaining({ tags: null }),
    )
  })

  it('rejects cross-shop access (customer lookup returns undefined)', async () => {
    const db = makeFakeDb({
      customers: [
        // Customer lives on a different shop — lookup won't match.
        { id: CUSTOMER_ID, shop_id: 'different-shop', tags: ['vip'] },
      ],
      audits: [],
    })
    const req = makeReq({ action: 'add', tag: 'wholesale' })
    const res = makeRes()

    await postCustomerUpdateTags(req, res, db)

    expect(updateCustomer).not.toHaveBeenCalled()
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('error=')
    expect(decodeURIComponent(url)).toContain('Customer not found')
  })

  it('rejects invalid action (neither add nor remove)', async () => {
    const db = makeFakeDb({
      customers: [{ id: CUSTOMER_ID, shop_id: SHOP_ID, tags: [] }],
      audits: [],
    })
    const req = makeReq({ action: 'destroy-all', tag: 'bad' })
    const res = makeRes()

    await postCustomerUpdateTags(req, res, db)

    expect(updateCustomer).not.toHaveBeenCalled()
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(decodeURIComponent(url)).toContain('Invalid tag action')
  })

  it('rejects empty tag', async () => {
    const db = makeFakeDb({
      customers: [{ id: CUSTOMER_ID, shop_id: SHOP_ID, tags: [] }],
      audits: [],
    })
    const req = makeReq({ action: 'add', tag: '   ' })
    const res = makeRes()

    await postCustomerUpdateTags(req, res, db)

    expect(updateCustomer).not.toHaveBeenCalled()
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(decodeURIComponent(url)).toContain('1-64 characters')
  })

  it('rejects over-long tag (> 64 chars)', async () => {
    const db = makeFakeDb({
      customers: [{ id: CUSTOMER_ID, shop_id: SHOP_ID, tags: [] }],
      audits: [],
    })
    const req = makeReq({ action: 'add', tag: 'x'.repeat(65) })
    const res = makeRes()

    await postCustomerUpdateTags(req, res, db)

    expect(updateCustomer).not.toHaveBeenCalled()
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(decodeURIComponent(url)).toContain('1-64 characters')
  })

  it('handles legacy CSV-string tags (normalises to array on update)', async () => {
    const db = makeFakeDb({
      customers: [
        // Legacy path: tags came back from the row as a CSV string
        // rather than a pg text[]. Cast through any for the test.
        { id: CUSTOMER_ID, shop_id: SHOP_ID, tags: 'vip, wholesale' as any },
      ],
      audits: [],
    })
    const req = makeReq({ action: 'add', tag: 'press' })
    const res = makeRes()

    await postCustomerUpdateTags(req, res, db)

    expect(updateCustomer).toHaveBeenCalledWith(
      db,
      SHOP_ID,
      CUSTOMER_ID,
      expect.objectContaining({ tags: ['vip', 'wholesale', 'press'] }),
    )
  })
})
