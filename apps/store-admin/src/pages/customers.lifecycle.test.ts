/**
 * Store-admin — customer detail lifecycle badge (Phase 4 PR3).
 *
 * Covers the render paths added in PR3:
 *   - getCustomerDetail renders the correct badge class + label for
 *     each of the 4 lifecycle stages.
 *   - getCustomerDetail shows "No orders yet" when last_order_at is
 *     null, and a formatted date when it's present.
 *   - An unknown stage value (pre-migration row or corrupt cast)
 *     collapses to the neutral "Unknown" badge instead of crashing.
 *
 * Same mock pattern as customers.notes-tags.test.ts — we mock the
 * core modules + the seller-layout so the SUT is the page handler
 * itself, not the rendering pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks (must be declared BEFORE importing the SUT) ---------------------

vi.mock('@gbox/core/modules/customer-notes/service.js', () => ({
  addNote: vi.fn(),
  listNotes: vi.fn().mockResolvedValue([]),
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

// Keep esc as a pass-through so the test can assert plain text and
// human-readable dates inside the rendered HTML.
vi.mock('../layouts/seller-layout.js', () => ({
  sellerLayout: vi.fn((opts: any) => `<html>${opts.content}</html>`),
  esc: (s: string) => s,
}))

import type { Request, Response } from 'express'
import { getCustomerDetail } from './customers.js'

// --- Fixtures --------------------------------------------------------------

const SHOP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SHOP_SLUG = 'lifecycle-shop'
const CUSTOMER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

interface CustomerRow {
  id: string
  shop_id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  accepts_marketing: boolean
  orders_count: number
  total_spent: number
  tags: string[] | null
  note: string | null
  verified_email: boolean
  status: string
  created_at: string
  updated_at: string
  lifecycle_stage: string
  last_order_at: string | null
}

// Minimal fake db that only needs to return the customer row on
// selectFrom('customers').executeTakeFirst(), an empty orders list,
// and an empty notes list (mocked above).
function makeFakeDb(customer: CustomerRow | null) {
  function customersChain() {
    const b: any = {
      selectAll: () => b,
      select: () => b,
      where: () => b,
      orderBy: () => b,
      limit: () => b,
      executeTakeFirst: async () => customer ?? undefined,
      execute: async () => [],
    }
    return b
  }
  function ordersChain() {
    const b: any = {
      select: () => b,
      where: () => b,
      orderBy: () => b,
      limit: () => b,
      execute: async () => [],
    }
    return b
  }
  return {
    selectFrom: (t: string) => (t === 'orders' ? ordersChain() : customersChain()),
  } as any
}

function baseCustomer(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: CUSTOMER_ID,
    shop_id: SHOP_ID,
    email: 'vip@example.com',
    first_name: 'Smoke',
    last_name: 'Target',
    phone: null,
    accepts_marketing: true,
    orders_count: 3,
    total_spent: 250,
    tags: [],
    note: null,
    verified_email: true,
    status: 'enabled',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    lifecycle_stage: 'new',
    last_order_at: null,
    ...overrides,
  }
}

function makeReq(): Request {
  return {
    params: { slug: SHOP_SLUG, customerId: CUSTOMER_ID, id: CUSTOMER_ID },
    store: { id: SHOP_ID, slug: SHOP_SLUG, name: 'Lifecycle Shop' },
    storeUser: {
      id: USER_ID,
      name: 'Thai',
      email: 'thai@gbox.co',
      role: 'admin',
      storeRole: 'owner',
    },
  } as unknown as Request
}

function makeRes() {
  const send = vi.fn()
  const status = vi.fn().mockReturnThis()
  return { send, status } as unknown as Response & {
    send: ReturnType<typeof vi.fn>
  }
}

function renderedHtml(res: { send: ReturnType<typeof vi.fn> }): string {
  const first = res.send.mock.calls[0]?.[0]
  return typeof first === 'string' ? first : ''
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getCustomerDetail — lifecycle badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a blue "New" badge for lifecycle_stage=new', async () => {
    const db = makeFakeDb(baseCustomer({ lifecycle_stage: 'new' }))
    const req = makeReq()
    const res = makeRes()
    await getCustomerDetail(req, res, db)
    const html = renderedHtml(res)
    expect(html).toContain('data-testid="lifecycle-stat"')
    expect(html).toContain('badge-info')
    expect(html).toContain('>New<')
  })

  it('renders a green "Returning" badge for lifecycle_stage=returning', async () => {
    const db = makeFakeDb(baseCustomer({ lifecycle_stage: 'returning' }))
    const res = makeRes()
    await getCustomerDetail(makeReq(), res, db)
    const html = renderedHtml(res)
    expect(html).toContain('badge-success')
    expect(html).toContain('>Returning<')
  })

  it('renders an amber "At risk" badge for lifecycle_stage=at_risk', async () => {
    const db = makeFakeDb(baseCustomer({ lifecycle_stage: 'at_risk' }))
    const res = makeRes()
    await getCustomerDetail(makeReq(), res, db)
    const html = renderedHtml(res)
    expect(html).toContain('badge-warning')
    expect(html).toContain('>At risk<')
  })

  it('renders a red "Churned" badge for lifecycle_stage=churned', async () => {
    const db = makeFakeDb(baseCustomer({ lifecycle_stage: 'churned' }))
    const res = makeRes()
    await getCustomerDetail(makeReq(), res, db)
    const html = renderedHtml(res)
    expect(html).toContain('badge-danger')
    expect(html).toContain('>Churned<')
  })

  it('falls back to neutral "Unknown" for an unrecognised stage value', async () => {
    // Stages not in LIFECYCLE_STAGES (e.g. leftover from a migration
    // that never ran, or a typo) must not crash — they render as
    // neutral + "Unknown" so the page stays live while Thai fixes the
    // underlying data.
    const db = makeFakeDb(baseCustomer({ lifecycle_stage: 'vip' as any }))
    const res = makeRes()
    await getCustomerDetail(makeReq(), res, db)
    const html = renderedHtml(res)
    expect(html).toContain('badge-neutral')
    expect(html).toContain('>Unknown<')
  })

  it('shows "No orders yet" subtext when last_order_at is null', async () => {
    const db = makeFakeDb(baseCustomer({ last_order_at: null }))
    const res = makeRes()
    await getCustomerDetail(makeReq(), res, db)
    const html = renderedHtml(res)
    expect(html).toContain('Lifecycle · last order No orders yet')
  })

  it('formats the last_order_at timestamp to a locale date string', async () => {
    const db = makeFakeDb(
      baseCustomer({
        lifecycle_stage: 'returning',
        last_order_at: '2026-03-15T10:30:00Z',
      }),
    )
    const res = makeRes()
    await getCustomerDetail(makeReq(), res, db)
    const html = renderedHtml(res)
    // toLocaleDateString(en-US, {year,month,day}) emits "March 15, 2026".
    // We assert on the year + month name; the day number can shift by
    // one across timezones but the format is stable.
    expect(html).toMatch(/March \d+, 2026/)
  })
})
