/**
 * Comprehensive /analytics audit smoke test — Phase G.
 *
 * Exercises every GET handler under /analytics/* with a mocked req/res
 * pair, then asserts the rendered HTML does not contain dead-link bug
 * patterns from earlier phases.
 *
 * No structural bugs were found in any analytics page — all hrefs and
 * form actions point at routes that actually exist in server.ts. This
 * test is a regression guard.
 *
 * Note: live-view is intentionally skipped here. It has its own dedicated
 * smoke-live-view.ts and uses an SSE event stream that doesn't fit the
 * mock-req/mock-res pattern.
 *
 * Usage: STORE_ADMIN_PORT=0 tsx scripts/smoke-analytics-audit.ts [storeSlug]
 */

if (!process.env.STORE_ADMIN_PORT) {
  process.env.STORE_ADMIN_PORT = '0'
}

import { createDb, destroyDb } from '@gbox/db'
import {
  getAnalyticsDashboard,
  getSalesReport,
  getProductReport,
  getCustomerReport,
  getFinanceReport,
} from '../src/pages/analytics.ts'

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
 * Inherits Phase B + C + D + E guards.
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
    // Phase E guards
    [
      'No dead /discounts/new form action (must POST to /discounts)',
      !new RegExp(`action="${base}/discounts/new(?:"|/|\\?|#)`).test(body),
    ],
    [
      'No dead /discounts/:id form action without /delete suffix',
      !/action="\/admin\/store\/[^/]+\/discounts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i.test(body),
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

  console.log(`[smoke] Comprehensive /analytics audit for store: ${storeSlug}`)
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

  // ── PHASE 1: /analytics (dashboard, default 7d) ───────────────────
  phases.push(async () => {
    console.log('\n[phase 1] GET /analytics')
    const req = makeReq({ path: '/analytics' })
    const res = makeMockRes()
    try {
      await getAnalyticsDashboard(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 1000],
        [
          'Sales card "View report" link → /analytics/sales',
          new RegExp(`href="${base}/analytics/sales"`).test(res.body),
        ],
        [
          'Reports link → /analytics/reports',
          new RegExp(`href="${base}/analytics/reports"`).test(res.body),
        ],
        [
          'Customer report link → /analytics/customers',
          new RegExp(`href="${base}/analytics/customers"`).test(res.body),
        ],
        [
          'Orders shortcut link → /orders',
          new RegExp(`href="${base}/orders"`).test(res.body),
        ],
        [
          'Period switcher renders 7d link',
          /period=7d/.test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /analytics', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /analytics threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 2: /analytics?period=30d ────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 2] GET /analytics?period=30d')
    const req = makeReq({ path: '/analytics?period=30d', query: { period: '30d' } })
    const res = makeMockRes()
    try {
      await getAnalyticsDashboard(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 1000],
        ['Period link includes period=30d', /period=30d/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /analytics?period=30d', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /analytics?period=30d threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 3: /analytics/reports (= getSalesReport) ────────────────
  phases.push(async () => {
    console.log('\n[phase 3] GET /analytics/reports')
    const req = makeReq({ path: '/analytics/reports' })
    const res = makeMockRes()
    try {
      await getSalesReport(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Sales Report"', />Sales Report</.test(res.body)],
        [
          'Back to Analytics link',
          new RegExp(`href="${base}/analytics"`).test(res.body),
        ],
        [
          'Date range form action /analytics/sales',
          new RegExp(`action="${base}/analytics/sales"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /analytics/reports', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /analytics/reports threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 4: /analytics/sales ─────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 4] GET /analytics/sales')
    const req = makeReq({ path: '/analytics/sales' })
    const res = makeMockRes()
    try {
      await getSalesReport(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Sales Report"', />Sales Report</.test(res.body)],
        [
          'Date range form action /analytics/sales',
          new RegExp(`action="${base}/analytics/sales"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /analytics/sales', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /analytics/sales threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 5: /analytics/products (Product Report) ─────────────────
  phases.push(async () => {
    console.log('\n[phase 5] GET /analytics/products')
    const req = makeReq({ path: '/analytics/products' })
    const res = makeMockRes()
    try {
      await getProductReport(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Product Report"', />Product Report</.test(res.body)],
        [
          'Back to Analytics link',
          new RegExp(`href="${base}/analytics"`).test(res.body),
        ],
        ['Inventory Value Summary section', /Inventory Value Summary/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /analytics/products', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /analytics/products threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 6: /analytics/customers (Customer Report) ───────────────
  phases.push(async () => {
    console.log('\n[phase 6] GET /analytics/customers')
    const req = makeReq({ path: '/analytics/customers' })
    const res = makeMockRes()
    try {
      await getCustomerReport(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Back to Analytics link',
          new RegExp(`href="${base}/analytics"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /analytics/customers', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /analytics/customers threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 7: /analytics/finance (Finance Report) ──────────────────
  phases.push(async () => {
    console.log('\n[phase 7] GET /analytics/finance')
    const req = makeReq({ path: '/analytics/finance' })
    const res = makeMockRes()
    try {
      await getFinanceReport(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Financial Report"', />Financial Report</.test(res.body)],
        [
          'Back to Analytics link',
          new RegExp(`href="${base}/analytics"`).test(res.body),
        ],
        [
          'Date range form action /analytics/finance',
          new RegExp(`action="${base}/analytics/finance"`).test(res.body),
        ],
        ['Revenue Breakdown section', /Revenue Breakdown/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /analytics/finance', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /analytics/finance threw: ${err.message}`)
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
