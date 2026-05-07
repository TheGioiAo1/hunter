/**
 * Store-admin — customers-export handler tests (Phase 4 PR4).
 *
 * The page composes two DB fetches (customers + default addresses)
 * and hands the result to the streaming exporter. Tests stub the DB
 * with a chainable fake and assert:
 *   - GET renders the scope picker + counts
 *   - POST streams the CSV with the right headers
 *   - empty result redirects with a friendly message
 *
 * We use a small Proxy-based fake so each `selectFrom('table')` chain
 * can hand back the fixture row set the test queues up. The exporter
 * itself is NOT mocked — we exercise the real streamer so a
 * regression in the CSV headers/rows is caught here too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/notify.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  byActor: vi.fn(() => 'By mock'),
}))

vi.mock('../layouts/seller-layout.js', () => ({
  sellerLayout: vi.fn((opts: any) => `<html>${opts.content}</html>`),
  esc: (s: string) => (s == null ? '' : String(s)),
}))

import {
  getCustomerExport,
  postCustomerExportDownload,
} from './customers-export.js'

const SHOP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SHOP_SLUG = 'shop-4'

// ---- fake db --------------------------------------------------------------

interface FakeResult {
  execute?: any[]
  executeTakeFirst?: any
}

/**
 * A single `selectFrom(name)` chain. The chain object records every
 * method call (so we could assert on shape later) and terminates at
 * `execute()` / `executeTakeFirst()` with whatever row set the test
 * passed in.
 */
function chain(fixture: FakeResult): any {
  const c: any = {}
  for (const m of ['select', 'where', 'orderBy', 'limit']) {
    c[m] = (..._args: any[]) => c
  }
  c.execute = async () => fixture.execute ?? []
  c.executeTakeFirst = async () => fixture.executeTakeFirst ?? null
  // For the count subselect `fn.count('id')` inside select(callback)
  // — the page passes `({fn}) => ...` to select. We accept any callable.
  return c
}

/**
 * Build a fake db whose `selectFrom` returns the next fixture for
 * each distinct table in the order the test queues them. Reusing the
 * same queue across multiple tables is fine because we key by table.
 */
function makeDb(byTable: Record<string, FakeResult[]>): any {
  const ptr: Record<string, number> = {}
  return {
    selectFrom(table: string) {
      const list = byTable[table] ?? []
      const i = ptr[table] ?? 0
      ptr[table] = i + 1
      const fixture = list[i] ?? { execute: [] }
      return chain(fixture)
    },
    fn: {
      count: () => ({ as: () => 'c' }),
    },
  }
}

function baseReq(overrides: any = {}): any {
  return {
    store: { id: SHOP_ID, slug: SHOP_SLUG, name: 'Shop Four' },
    storeUser: {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      name: 'Seller',
      email: 's@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    query: {},
    body: {},
    ...overrides,
  }
}

function baseRes(): any {
  const chunks: string[] = []
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    sent: '' as string,
    redirectedTo: null as string | null,
    ended: false,
    chunks,
    status(c: number) { this.statusCode = c; return this },
    setHeader(k: string, v: string) { this.headers[k] = v },
    send(x: string) { this.sent = x },
    redirect(u: string) { this.redirectedTo = u },
    write(x: string) { chunks.push(x); return true },
    end() { this.ended = true },
    get headersSent() { return chunks.length > 0 },
  }
  return res
}

// ---- Tests ----------------------------------------------------------------

describe('getCustomerExport', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the scope picker with count cards', async () => {
    // 6 count queries fire in parallel. Each returns {c: N}. Order
    // doesn't matter because they all hit selectFrom('customers').
    const db = makeDb({
      customers: [
        { executeTakeFirst: { c: 42 } }, // total
        { executeTakeFirst: { c: 10 } }, // marketing
        { executeTakeFirst: { c: 5 } },  // new
        { executeTakeFirst: { c: 20 } }, // returning
        { executeTakeFirst: { c: 7 } },  // at_risk
        { executeTakeFirst: { c: 3 } },  // churned
      ],
    })
    const req = baseReq()
    const res = baseRes()

    await getCustomerExport(req, res, db)
    expect(res.sent).toContain('Export customers')
    expect(res.sent).toContain('All customers')
    expect(res.sent).toContain('42 customers')
    expect(res.sent).toContain('Marketing opted-in')
    expect(res.sent).toContain('Lifecycle: Churned')
  })
})

describe('postCustomerExportDownload', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects with no_customers when the scope has no rows', async () => {
    const db = makeDb({ customers: [{ execute: [] }] })
    const req = baseReq({ body: { scope: 'all' } })
    const res = baseRes()
    await postCustomerExportDownload(req, res, db)
    expect(res.redirectedTo).toContain('no_customers')
    // No content written before the redirect.
    expect(res.chunks).toHaveLength(0)
  })

  it('streams a CSV with the Shopify header row and one line per customer', async () => {
    const db = makeDb({
      customers: [
        {
          execute: [
            {
              id: 'cust-1',
              first_name: 'Ada',
              last_name: 'Lovelace',
              email: 'ada@example.com',
              phone: '555-0001',
              accepts_marketing: true,
              note: 'VIP',
              tags: ['vip'],
              tax_exempt: false,
              total_spent: '100.00',
              orders_count: 3,
              lifecycle_stage: 'returning',
            },
          ],
        },
      ],
      customer_addresses: [
        {
          execute: [
            {
              customer_id: 'cust-1',
              first_name: null,
              last_name: null,
              company: 'Acme',
              address1: '1 Foo St',
              address2: null,
              city: 'NYC',
              province: 'NY',
              province_code: 'NY',
              country: 'United States',
              country_code: 'US',
              zip: '10001',
              phone: null,
              is_default: true,
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        },
      ],
    })

    const req = baseReq({ body: { scope: 'all' } })
    const res = baseRes()
    await postCustomerExportDownload(req, res, db)

    expect(res.redirectedTo).toBeNull()
    expect(res.ended).toBe(true)
    expect(res.headers['Content-Type']).toContain('text/csv')
    expect(res.headers['Content-Disposition']).toMatch(/attachment; filename="customers-shop-4-\d{4}-\d{2}-\d{2}\.csv"/)

    const full = res.chunks.join('')
    // First line is the canonical Shopify header row.
    const [headerLine, dataLine] = full.split('\n')
    expect(headerLine).toContain('First Name')
    expect(headerLine).toContain('Email')
    expect(headerLine).toContain('Accepts Email Marketing')
    expect(headerLine).toContain('Lifecycle Stage')
    // Data row carries the customer + address fields.
    expect(dataLine).toContain('Ada')
    expect(dataLine).toContain('ada@example.com')
    expect(dataLine).toContain('Acme')
    expect(dataLine).toContain('1 Foo St')
    expect(dataLine).toContain('yes')       // accepts_marketing
    expect(dataLine).toContain('returning') // lifecycle_stage
  })

  it('falls back to scope=all when the scope value is unknown', async () => {
    const db = makeDb({ customers: [{ execute: [] }] })
    const req = baseReq({ body: { scope: 'garbage' } })
    const res = baseRes()
    await postCustomerExportDownload(req, res, db)
    // No rows → redirect path, not a crash.
    expect(res.redirectedTo).toContain('no_customers')
  })
})
