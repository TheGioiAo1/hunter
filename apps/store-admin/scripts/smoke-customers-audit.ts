/**
 * Comprehensive /customers audit smoke test — Phase D.
 *
 * Exercises every GET handler under /customers/* with a mocked req/res
 * pair, then asserts the rendered HTML does not contain dead-link bug
 * patterns.
 *
 * Phase D fixes that this test guards:
 *   1. /customers no longer renders a "Export" button pointing at
 *      ${base}/customers/export — no such route exists yet. The button
 *      was removed; restore it when a CSV export handler ships.
 *
 * Usage: STORE_ADMIN_PORT=0 tsx scripts/smoke-customers-audit.ts [storeSlug]
 */

if (!process.env.STORE_ADMIN_PORT) {
  process.env.STORE_ADMIN_PORT = '0'
}

import { createDb, destroyDb } from '@gbox/db'
import {
  getCustomers,
  getCustomerNew,
  getCustomerDetail,
  getCustomerEdit,
} from '../src/pages/customers.ts'
import { getCustomerSegments } from '../src/pages/customer-segments.ts'

interface MockResponse {
  statusCode: number
  body: string
  headers: Record<string, string>
}

function makeMockRes(): MockResponse & {
  status: (code: number) => any
  send: (body: string) => any
  redirect: (loc: string) => any
  setHeader: (k: string, v: string) => any
} {
  const res: any = {
    statusCode: 200,
    body: '',
    headers: {},
    status(code: number) {
      this.statusCode = code
      return this
    },
    send(body: string) {
      this.body = body
      return this
    },
    redirect(loc: string) {
      this.statusCode = 302
      this.headers['Location'] = loc
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
      return this
    },
  }
  return res
}

/**
 * Dead link patterns that must NOT appear in any rendered page.
 * Inherits the Phase B + Phase C guards and adds Phase D guards.
 */
function deadLinkChecks(body: string, base: string): Array<[string, boolean]> {
  return [
    // Phase B guards
    [
      'No bare /admin/store/<slug>/collections href',
      !new RegExp(`href="${base}/collections(?:"|/|\\?)`).test(body),
    ],
    [
      'No dead /domains link (must be /online-store/domains)',
      !new RegExp(`href="${base}/domains(?:"|/|\\?|#)`).test(body),
    ],
    [
      'No dead /products/create form action',
      !new RegExp(`action="${base}/products/create(?:"|/|\\?|#)`).test(body),
    ],
    // Phase C guards
    [
      'No /orders/abandoned/:id detail link',
      !/href="[^"]*\/orders\/abandoned\/[0-9a-f]{8}-/i.test(body),
    ],
    [
      'No /marketing/sms/fee-history link',
      !new RegExp(`href="${base}/marketing/sms/fee-history`).test(body),
    ],
    // Phase D guards
    [
      'No dead /customers/export link',
      !new RegExp(`href="${base}/customers/export`).test(body)
        && !new RegExp(`href="/admin/store/[^/]+/customers/export`).test(body),
    ],
  ]
}

function runChecks(label: string, checks: Array<[string, boolean]>): boolean {
  const allPass = checks.every(([, p]) => p)
  if (allPass) {
    console.log(`[ok]   ${label} (${checks.length} checks)`)
    return true
  } else {
    console.error(`[FAIL] ${label}`)
    for (const [name, pass] of checks) {
      console.error(`       ${pass ? '  ok ' : 'FAIL'}  ${name}`)
    }
    return false
  }
}

async function main() {
  const storeSlug = process.argv[2] || 'gbox-test'

  console.log(`[smoke] Comprehensive /customers audit for store: ${storeSlug}`)
  console.log(`[smoke] STORE_ADMIN_PORT=${process.env.STORE_ADMIN_PORT}`)
  const db = createDb()

  const row = await db
    .selectFrom('shops' as any)
    .select(['id', 'name', 'slug', 'domain', 'plan', 'status', 'currency'] as any)
    .where('slug' as any, '=', storeSlug)
    .executeTakeFirst()

  if (!row) {
    console.error(`[FAIL] Store not found: ${storeSlug}`)
    await destroyDb()
    process.exit(1)
  }
  const store = row as any
  console.log(`[ok]   Found store: ${store.name} (${store.id})`)

  const base = `/admin/store/${storeSlug}`
  const regularUser = {
    id: '00000000-0000-0000-0000-000000000000',
    name: 'Smoke Test',
    email: 'smoke@test.local',
    role: 'owner',
    storeRole: 'owner',
  }

  const makeReq = (opts: { params?: any; query?: any; path?: string }) => ({
    params: { slug: storeSlug, ...(opts.params || {}) },
    query: opts.query || {},
    originalUrl: `${base}${opts.path || ''}`,
    store,
    storeUser: regularUser,
    theme: 'dark',
    csrfToken: 'smoke-test-csrf-token',
  })

  let failures = 0
  const phases: Array<() => Promise<boolean>> = []

  // ── PHASE 1: /customers (list) ────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 1] GET /customers')
    const req = makeReq({ path: '/customers' })
    const res = makeMockRes()
    try {
      await getCustomers(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Customers"', />Customers</.test(res.body)],
        [
          'Add Customer button',
          new RegExp(`href="${base}/customers/new"`).test(res.body),
        ],
        [
          'Search form action',
          new RegExp(`action="${base}/customers"`).test(res.body),
        ],
        ['CSRF field present', /name="_csrf"/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /customers', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /customers threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 2: /customers/new (create form) ─────────────────────────
  phases.push(async () => {
    console.log('\n[phase 2] GET /customers/new')
    const req = makeReq({ path: '/customers/new' })
    const res = makeMockRes()
    try {
      await getCustomerNew(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['CSRF field present', /name="_csrf"/.test(res.body)],
        [
          'form posts to /customers',
          new RegExp(`action="${base}/customers"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /customers/new', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /customers/new threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 3: /customers/:customerId (detail) ──────────────────────
  phases.push(async () => {
    console.log('\n[phase 3] GET /customers/:customerId (detail)')
    const firstCustomer = await db
      .selectFrom('customers' as any)
      .select(['id'] as any)
      .where('shop_id' as any, '=', store.id)
      .orderBy('created_at' as any, 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!firstCustomer) {
      console.log('[skip] No customers — skipping detail phase')
      return true
    }
    const cid = (firstCustomer as any).id
    const req = makeReq({
      params: { customerId: cid },
      path: `/customers/${cid}`,
    })
    const res = makeMockRes()
    try {
      await getCustomerDetail(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Back to Customers link',
          new RegExp(`href="${base}/customers"`).test(res.body),
        ],
        [
          'Edit Customer link',
          new RegExp(`href="${base}/customers/${cid}/edit"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /customers/${cid}`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /customers/:id threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 4: /customers/:customerId/edit (edit form) ──────────────
  phases.push(async () => {
    console.log('\n[phase 4] GET /customers/:customerId/edit (edit form)')
    const firstCustomer = await db
      .selectFrom('customers' as any)
      .select(['id'] as any)
      .where('shop_id' as any, '=', store.id)
      .orderBy('created_at' as any, 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!firstCustomer) {
      console.log('[skip] No customers — skipping edit phase')
      return true
    }
    const cid = (firstCustomer as any).id
    const req = makeReq({
      params: { customerId: cid },
      path: `/customers/${cid}/edit`,
    })
    const res = makeMockRes()
    try {
      await getCustomerEdit(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['CSRF field present', /name="_csrf"/.test(res.body)],
        [
          'form posts to /customers/:id/edit',
          new RegExp(`action="${base}/customers/${cid}/edit"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /customers/${cid}/edit`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /customers/:id/edit threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 5: /customers/segments ──────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 5] GET /customers/segments')
    const req = makeReq({ path: '/customers/segments' })
    const res = makeMockRes()
    try {
      await getCustomerSegments(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Customer Segments"', /Customer Segments/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /customers/segments', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /customers/segments threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // Run all phases
  for (const phase of phases) {
    const ok = await phase()
    if (!ok) failures++
  }

  await destroyDb()

  if (failures > 0) {
    console.error(`\n[FAIL] ${failures}/${phases.length} phase(s) failed`)
    process.exit(1)
  }
  console.log(`\n[ok]   All ${phases.length} phases passed`)
}

main().catch((err) => {
  console.error('[FAIL] Smoke test crashed:', err)
  process.exit(1)
})
