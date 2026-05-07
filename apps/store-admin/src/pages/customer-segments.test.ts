/**
 * Store-admin — customer-segments route handlers (Phase 4 PR2).
 *
 * Covers:
 *   - getCustomerSegmentNew renders the editor shell
 *   - getCustomerSegmentDetail redirects with error when segment not found
 *   - getCustomerSegmentDetail renders editor with name + rules when found
 *   - postCustomerSegmentCreate save path: delegates to createSegment + redirects
 *   - postCustomerSegmentCreate preview path: calls countMatchingCustomers + re-renders
 *   - postCustomerSegmentCreate add_rule / remove_rule actions never call the DB
 *   - postCustomerSegmentUpdate null-row path redirects back to list with error
 *   - postCustomerSegmentDelete true / false semantics
 *
 * All service-layer calls are mocked; we're testing the handlers, not the
 * service. Mirrors the mock style from customers.notes-tags.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks (must be declared BEFORE importing the SUT) ---------------------

vi.mock('@gbox/core/modules/customer-segments/index.js', () => ({
  createSegment: vi.fn(),
  updateSegment: vi.fn(),
  deleteSegment: vi.fn(),
  listSegments: vi.fn(),
  getSegment: vi.fn(),
  countMatchingCustomers: vi.fn(),
  SEGMENT_FIELD_SAFELIST: {
    email: { type: 'string', column: 'email', nullable: true, ops: ['equals', 'contains', 'is_set'], label: 'Email' },
    total_spent: { type: 'number', column: 'total_spent', nullable: false, ops: ['greater_than'], label: 'Total spent' },
  },
  MAX_RULES_PER_SEGMENT: 20,
  MAX_NAME_LENGTH: 120,
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
  createSegment,
  updateSegment,
  deleteSegment,
  listSegments,
  getSegment,
  countMatchingCustomers,
} from '@gbox/core/modules/customer-segments/index.js'
import {
  getCustomerSegments,
  getCustomerSegmentNew,
  getCustomerSegmentDetail,
  postCustomerSegmentCreate,
  postCustomerSegmentUpdate,
  postCustomerSegmentDelete,
} from './customer-segments.js'

// --- Fixtures --------------------------------------------------------------

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_SLUG = 'test-shop'
const SEGMENT_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '66666666-6666-6666-6666-666666666666'

// --- Req / Res helpers -----------------------------------------------------

function makeReq(
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): Request {
  return {
    body,
    query,
    params: { slug: SHOP_SLUG, ...params },
    store: { id: SHOP_ID, slug: SHOP_SLUG, name: 'Test Shop' },
    storeUser: {
      id: USER_ID,
      name: 'Thai Admin',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    csrfToken: 'mock-token',
  } as unknown as Request
}

function makeRes() {
  const redirect = vi.fn()
  const status = vi.fn().mockReturnThis()
  const send = vi.fn()
  return { redirect, status, send } as unknown as Response & {
    redirect: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
  }
}

// Fake DB — shaped like a Kysely instance so handlers detect DB mode
// via `typeof db.selectFrom === 'function'`. Without `selectFrom` the
// handlers fall into API mode (createApiContext + remote Customer Service)
// which the mocks here don't cover.
const fakeDb = { selectFrom: () => ({}) } as any

// ---------------------------------------------------------------------------
// getCustomerSegmentNew
// ---------------------------------------------------------------------------

describe('getCustomerSegmentNew', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the new-segment editor with blank name + blank rule row', async () => {
    const req = makeReq()
    const res = makeRes()

    await getCustomerSegmentNew(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('New segment')
    expect(html).toContain('name="name"')
    expect(html).toContain('name="rule_field[]"')
    expect(html).toContain('name="combinator"')
    // Save button exists
    expect(html).toContain('value="save"')
    // No preview count line yet
    expect(html).not.toMatch(/customers? match this segment/i)
  })
})

// ---------------------------------------------------------------------------
// getCustomerSegmentDetail
// ---------------------------------------------------------------------------

describe('getCustomerSegmentDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects with error flash when segment is not found', async () => {
    vi.mocked(getSegment).mockResolvedValue(null)

    const req = makeReq({}, { segmentId: SEGMENT_ID })
    const res = makeRes()

    await getCustomerSegmentDetail(req, res, fakeDb)

    expect(res.redirect).toHaveBeenCalledTimes(1)
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('/customers/segments?error=')
    expect(decodeURIComponent(url)).toContain('Segment not found')
    expect(res.send).not.toHaveBeenCalled()
  })

  it('renders the editor with name + rules when the segment exists', async () => {
    vi.mocked(getSegment).mockResolvedValue({
      id: SEGMENT_ID,
      shop_id: SHOP_ID,
      name: 'VIP',
      rules_json: {
        combinator: 'and',
        rules: [{ field: 'email', op: 'contains', value: '@gbox.co' }],
      },
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    } as any)

    const req = makeReq({}, { segmentId: SEGMENT_ID })
    const res = makeRes()

    await getCustomerSegmentDetail(req, res, fakeDb)

    expect(getSegment).toHaveBeenCalledWith(fakeDb, {
      shop_id: SHOP_ID,
      id: SEGMENT_ID,
    })
    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('Edit segment')
    expect(html).toContain('value="VIP"')
    // Selected option present
    expect(html).toMatch(/value="email"[^>]*selected/)
  })

  it('handles rules_json stored as a string (JSON column read back as text)', async () => {
    vi.mocked(getSegment).mockResolvedValue({
      id: SEGMENT_ID,
      shop_id: SHOP_ID,
      name: 'stringified',
      rules_json: JSON.stringify({
        combinator: 'or',
        rules: [{ field: 'email', op: 'is_set', value: null }],
      }),
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    } as any)

    const req = makeReq({}, { segmentId: SEGMENT_ID })
    const res = makeRes()

    await getCustomerSegmentDetail(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toMatch(/value="or"[^>]*selected/)
  })
})

// ---------------------------------------------------------------------------
// postCustomerSegmentCreate — save + preview + row mutators
// ---------------------------------------------------------------------------

describe('postCustomerSegmentCreate — save path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to createSegment and redirects to the detail page on success', async () => {
    vi.mocked(createSegment).mockResolvedValue({
      id: SEGMENT_ID,
      shop_id: SHOP_ID,
      name: 'VIP',
      rules_json: {} as any,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    } as any)

    const req = makeReq({
      action: 'save',
      name: 'VIP',
      combinator: 'and',
      'rule_field[]': ['email'],
      'rule_op[]': ['contains'],
      'rule_value[]': ['@gbox.co'],
    })
    const res = makeRes()

    await postCustomerSegmentCreate(req, res, fakeDb)

    expect(createSegment).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        shop_id: SHOP_ID,
        name: 'VIP',
        rules: expect.objectContaining({
          combinator: 'and',
          rules: [expect.objectContaining({ field: 'email', op: 'contains' })],
        }),
      }),
    )
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain(`/customers/segments/${SEGMENT_ID}?success=segment_created`)
  })

  it('re-renders editor with error when createSegment throws (e.g. validation fails)', async () => {
    vi.mocked(createSegment).mockRejectedValue(
      new Error('Segment name is required'),
    )

    const req = makeReq({
      action: 'save',
      name: '   ',
      combinator: 'and',
      'rule_field[]': ['email'],
      'rule_op[]': ['contains'],
      'rule_value[]': ['x'],
    })
    const res = makeRes()

    await postCustomerSegmentCreate(req, res, fakeDb)

    expect(res.redirect).not.toHaveBeenCalled()
    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('Segment name is required')
  })
})

describe('postCustomerSegmentCreate — preview path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls countMatchingCustomers and re-renders the editor with the count line', async () => {
    vi.mocked(countMatchingCustomers).mockResolvedValue(42)

    const req = makeReq({
      action: 'preview',
      name: 'VIP',
      combinator: 'and',
      'rule_field[]': ['email'],
      'rule_op[]': ['contains'],
      'rule_value[]': ['@gbox.co'],
    })
    const res = makeRes()

    await postCustomerSegmentCreate(req, res, fakeDb)

    expect(countMatchingCustomers).toHaveBeenCalledWith(
      fakeDb,
      SHOP_ID,
      expect.objectContaining({ combinator: 'and' }),
    )
    expect(createSegment).not.toHaveBeenCalled()
    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('42')
    expect(html).toMatch(/customers? match this segment/i)
  })

  it('re-renders with error line when rules fail to validate during preview', async () => {
    vi.mocked(countMatchingCustomers).mockRejectedValue(
      new Error('Unknown field: password_hash'),
    )

    const req = makeReq({
      action: 'preview',
      name: 'evil',
      combinator: 'and',
      'rule_field[]': ['password_hash'],
      'rule_op[]': ['equals'],
      'rule_value[]': ['x'],
    })
    const res = makeRes()

    await postCustomerSegmentCreate(req, res, fakeDb)

    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('Unknown field')
    expect(createSegment).not.toHaveBeenCalled()
  })
})

describe('postCustomerSegmentCreate — row mutators', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('add_rule: never touches the DB, re-renders editor with an extra blank row', async () => {
    const req = makeReq({
      action: 'add_rule',
      name: 'Work in progress',
      combinator: 'and',
      'rule_field[]': ['email'],
      'rule_op[]': ['contains'],
      'rule_value[]': ['@gbox.co'],
    })
    const res = makeRes()

    await postCustomerSegmentCreate(req, res, fakeDb)

    expect(createSegment).not.toHaveBeenCalled()
    expect(countMatchingCustomers).not.toHaveBeenCalled()
    const html = (res as any).send.mock.calls[0][0] as string
    // Two rule-field selects rendered (one for existing row, one for
    // the freshly added blank row)
    const occurrences = html.match(/name="rule_field\[\]"/g) ?? []
    expect(occurrences.length).toBeGreaterThanOrEqual(2)
  })

  it('remove_rule:N drops row N before re-render, no DB hit', async () => {
    const req = makeReq({
      action: 'remove_rule:0',
      name: 'Prune me',
      combinator: 'and',
      'rule_field[]': ['email', 'total_spent'],
      'rule_op[]': ['contains', 'greater_than'],
      'rule_value[]': ['@gbox.co', '100'],
    })
    const res = makeRes()

    await postCustomerSegmentCreate(req, res, fakeDb)

    expect(createSegment).not.toHaveBeenCalled()
    const html = (res as any).send.mock.calls[0][0] as string
    // The surviving row should be total_spent (index 1 kept)
    expect(html).toMatch(/value="total_spent"[^>]*selected/)
    // And the removed one should NOT be selected any more
    expect(html).not.toMatch(/value="email"[^>]*selected/)
  })
})

// ---------------------------------------------------------------------------
// postCustomerSegmentUpdate
// ---------------------------------------------------------------------------

describe('postCustomerSegmentUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns list with error when updateSegment returns null (cross-shop / missing)', async () => {
    vi.mocked(updateSegment).mockResolvedValue(null)

    const req = makeReq(
      {
        action: 'save',
        name: 'Renamed',
        combinator: 'and',
        'rule_field[]': ['email'],
        'rule_op[]': ['contains'],
        'rule_value[]': ['@gbox.co'],
      },
      { segmentId: SEGMENT_ID },
    )
    const res = makeRes()

    await postCustomerSegmentUpdate(req, res, fakeDb)

    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('/customers/segments?error=')
    expect(decodeURIComponent(url)).toContain('Segment not found')
  })

  it('redirects back to detail with success flash when updateSegment returns a row', async () => {
    vi.mocked(updateSegment).mockResolvedValue({
      id: SEGMENT_ID,
      shop_id: SHOP_ID,
      name: 'Renamed',
      rules_json: {} as any,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-21T00:00:00Z',
    } as any)

    const req = makeReq(
      {
        action: 'save',
        name: 'Renamed',
        combinator: 'and',
        'rule_field[]': ['email'],
        'rule_op[]': ['contains'],
        'rule_value[]': ['@gbox.co'],
      },
      { segmentId: SEGMENT_ID },
    )
    const res = makeRes()

    await postCustomerSegmentUpdate(req, res, fakeDb)

    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain(`/customers/segments/${SEGMENT_ID}?success=segment_updated`)
  })
})

// ---------------------------------------------------------------------------
// postCustomerSegmentDelete
// ---------------------------------------------------------------------------

describe('postCustomerSegmentDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects to list with success flash when service returns true', async () => {
    vi.mocked(deleteSegment).mockResolvedValue(true)

    const req = makeReq({}, { segmentId: SEGMENT_ID })
    const res = makeRes()

    await postCustomerSegmentDelete(req, res, fakeDb)

    expect(deleteSegment).toHaveBeenCalledWith(fakeDb, {
      shop_id: SHOP_ID,
      id: SEGMENT_ID,
    })
    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('/customers/segments?success=segment_deleted')
  })

  it('redirects to list with error flash when service returns false', async () => {
    vi.mocked(deleteSegment).mockResolvedValue(false)

    const req = makeReq({}, { segmentId: SEGMENT_ID })
    const res = makeRes()

    await postCustomerSegmentDelete(req, res, fakeDb)

    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('/customers/segments?error=')
    expect(decodeURIComponent(url)).toContain('Segment not found')
  })

  it('redirects with error flash when the service throws', async () => {
    vi.mocked(deleteSegment).mockRejectedValue(new Error('db offline'))

    const req = makeReq({}, { segmentId: SEGMENT_ID })
    const res = makeRes()

    await postCustomerSegmentDelete(req, res, fakeDb)

    const url = (res as any).redirect.mock.calls[0][0] as string
    expect(url).toContain('/customers/segments?error=')
    expect(decodeURIComponent(url)).toContain('db offline')
  })
})

// ---------------------------------------------------------------------------
// Smoke: getCustomerSegments renders the Custom Segments card using listSegments
// ---------------------------------------------------------------------------
//
// We don't exercise the full auto-segments Promise.all (it hits 14 raw
// Kysely queries that the chainable proxy would need to simulate). We
// use a lightweight fake-db that blanks every legacy aggregate and
// only returns something for listSegments, so the test focuses on the
// PR2 addition.

describe('getCustomerSegments — custom segments card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listSegments).mockResolvedValue([
      {
        id: SEGMENT_ID,
        shop_id: SHOP_ID,
        name: 'VIP',
        rules_json: { combinator: 'and', rules: [{ field: 'email', op: 'contains', value: '@gbox.co' }] },
        created_at: '2026-04-20T00:00:00Z',
        updated_at: '2026-04-20T00:00:00Z',
      } as any,
    ])
  })

  it('lists the merchant-defined segments and surfaces a New button', async () => {
    // A tiny fake db that makes the auto-segments parallel fetches
    // return a benign empty shape. The legacy summary uses patterns
    // like `db.fn.count('id').as('count')` and subquery-in-in, so we
    // return chainables everywhere.
    const fakeZeroResult = { count: 0 }
    const aggregateCol = { as: () => 'aggregate_alias' }
    const chainable = () => {
      const b: any = {
        select: () => b,
        selectAll: () => b,
        selectFrom: () => b,
        innerJoin: () => b,
        where: () => b,
        groupBy: () => b,
        having: () => b,
        orderBy: () => b,
        limit: () => b,
        offset: () => b,
        executeTakeFirst: async () => fakeZeroResult,
        execute: async () => [],
        then: undefined,
      }
      return b
    }
    const db = {
      selectFrom: () => chainable(),
      fn: {
        count: () => aggregateCol,
        avg: () => aggregateCol,
        sum: () => aggregateCol,
      },
    } as any

    const req = makeReq()
    const res = makeRes()

    await getCustomerSegments(req, res, db)

    expect(listSegments).toHaveBeenCalledWith(db, {
      shop_id: SHOP_ID,
      limit: 250,
    })
    const html = (res as any).send.mock.calls[0][0] as string
    expect(html).toContain('Custom segments')
    expect(html).toContain('VIP')
    expect(html).toContain('+ New segment')
  })
})
