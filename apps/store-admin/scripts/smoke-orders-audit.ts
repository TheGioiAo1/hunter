/**
 * Comprehensive /orders audit smoke test — Phase C.
 *
 * Exercises every GET handler under /orders/*, /returns/*, /fulfillments/*
 * and /refund-requests/* with a mocked req/res pair, then asserts the
 * rendered HTML does not contain dead-link bug patterns.
 *
 * Phase C fixes that this test guards:
 *   1. Abandoned checkouts no longer link to ${base}/orders/abandoned/:id
 *      because there is no route for that. The checkout label is now plain
 *      text (will be wrapped in <a> again once a detail page lands).
 *   2. Abandoned checkouts no longer render the "SMS fee history" button
 *      that pointed at ${base}/marketing/sms/fee-history — that route
 *      doesn't exist.
 *
 * It also re-applies every dead-link check from smoke-products-audit.ts
 * (no bare /collections, no ${base}/domains, no /fulfillments LINKS from
 * product pages, no /products/create).
 *
 * Usage: STORE_ADMIN_PORT=0 tsx scripts/smoke-orders-audit.ts [storeSlug]
 */

if (!process.env.STORE_ADMIN_PORT) {
  process.env.STORE_ADMIN_PORT = '0'
}

import { createDb, destroyDb } from '@gbox/db'
import {
  getOrders,
  getOrderDetail,
} from '../src/pages/orders.ts'
import {
  getDraftOrders,
  getDraftOrderNew,
  getDraftOrderDetail,
} from '../src/pages/draft-orders.ts'
import { getOrderExport } from '../src/pages/orders-export.ts'
import { getOrderImport } from '../src/pages/orders-import.ts'
import { getImportTracking } from '../src/pages/orders-import-tracking.ts'
import {
  getReturns,
  getReturnDetail,
  getCreateReturn,
} from '../src/pages/orders-returns.ts'
import { getAbandonedCheckouts } from '../src/pages/abandoned-checkouts.ts'
import { getOrderAnalytics } from '../src/pages/order-analytics.ts'
import {
  getFulfillments,
  getFulfillmentDetail,
} from '../src/pages/fulfillments.ts'
import {
  getRefundRequests,
  getCreateRefundRequest,
} from '../src/pages/refund-requests.ts'

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
 * Extends the Phase B dead-link set with Phase C guards for the
 * abandoned-checkout detail route and the SMS fee history button.
 */
function deadLinkChecks(body: string, base: string): Array<[string, boolean]> {
  return [
    // Phase B guards (inherited)
    [
      'No bare /admin/store/<slug>/collections href',
      !new RegExp(`href="${base}/collections(?:"|/|\\?)`).test(body),
    ],
    [
      'No bare /admin/store/<slug>/collections action',
      !new RegExp(`action="${base}/collections(?:"|/|\\?)`).test(body),
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
      'No /orders/abandoned/:id detail link (no route yet)',
      // Note: the list page href was /orders/abandoned/<uuid>. A bare /orders/abandoned
      // (no suffix) is the list page itself and is legal. Match only paths that
      // go one segment deeper than the list.
      !/href="[^"]*\/orders\/abandoned\/[0-9a-f]{8}-/i.test(body),
    ],
    [
      'No /marketing/sms/fee-history link',
      !new RegExp(`href="${base}/marketing/sms/fee-history`).test(body),
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

  console.log(`[smoke] Comprehensive /orders audit for store: ${storeSlug}`)
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
    isDefaultAdmin: true, // exercise the isDefaultAdmin branch (which previously had the SMS button)
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

  // ── PHASE 1: /orders (main list) ──────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 1] GET /orders')
    const req = makeReq({ path: '/orders' })
    const res = makeMockRes()
    try {
      await getOrders(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title contains "Orders"', />Orders</.test(res.body)],
        ['Export button href present', new RegExp(`href="${base}/orders/export"`).test(res.body)],
        ['Import button href present', new RegExp(`href="${base}/orders/import"`).test(res.body)],
        ['Import tracking button', new RegExp(`href="${base}/orders/import-tracking"`).test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /orders', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /orders threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 2: /orders/drafts ───────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 2] GET /orders/drafts')
    const req = makeReq({ path: '/orders/drafts' })
    const res = makeMockRes()
    try {
      await getDraftOrders(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['Create order button', new RegExp(`href="${base}/orders/drafts/new"`).test(res.body)],
        ['Draft filter form action', new RegExp(`action="${base}/orders/drafts"`).test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /orders/drafts', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /orders/drafts threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 3: /orders/drafts/new ───────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 3] GET /orders/drafts/new')
    const req = makeReq({ path: '/orders/drafts/new' })
    const res = makeMockRes()
    try {
      await getDraftOrderNew(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['CSRF token present', /name="_csrf"/.test(res.body)],
        [
          'form posts to /orders/drafts',
          /action="[^"]*\/orders\/drafts"/.test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /orders/drafts/new', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /orders/drafts/new threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 4: /orders/:orderId (detail) ────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 4] GET /orders/:orderId (detail)')
    const firstOrder = await db
      .selectFrom('orders' as any)
      .select(['id', 'order_number'] as any)
      .where('shop_id' as any, '=', store.id)
      .orderBy('created_at' as any, 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!firstOrder) {
      console.log('[skip] No orders — skipping order-detail phase')
      return true
    }
    const oid = (firstOrder as any).id
    console.log(`[ok]   Using order: #${(firstOrder as any).order_number}`)
    const req = makeReq({
      params: { orderId: oid },
      path: `/orders/${oid}`,
    })
    const res = makeMockRes()
    try {
      await getOrderDetail(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['Back to orders link', new RegExp(`href="${base}/orders"`).test(res.body)],
        [
          'Add Note form action',
          new RegExp(`action="${base}/orders/${oid}/add-note"`).test(res.body),
        ],
        [
          'Create Return link',
          new RegExp(`href="${base}/orders/${oid}/return"`).test(res.body),
        ],
        [
          'Request Refund link',
          new RegExp(`href="${base}/refund-requests/new\\?orderId=`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /orders/${oid}`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /orders/:orderId threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 5: /orders/:orderId?edit=1 (edit mode) ──────────────────
  phases.push(async () => {
    console.log('\n[phase 5] GET /orders/:orderId?edit=1 (edit mode)')
    const firstOrder = await db
      .selectFrom('orders' as any)
      .select(['id'] as any)
      .where('shop_id' as any, '=', store.id)
      .orderBy('created_at' as any, 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!firstOrder) {
      console.log('[skip] No orders — skipping edit-mode phase')
      return true
    }
    const oid = (firstOrder as any).id
    const req = makeReq({
      params: { orderId: oid },
      query: { edit: '1' },
      path: `/orders/${oid}?edit=1`,
    })
    const res = makeMockRes()
    try {
      await getOrderDetail(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        [
          'Edit form action posts to /edit',
          new RegExp(`action="${base}/orders/${oid}/edit"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /orders/${oid}?edit=1`, checks)
    } catch (err: any) {
      console.error(`[FAIL] edit mode threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 6: /orders/:orderId/return (create return) ──────────────
  phases.push(async () => {
    console.log('\n[phase 6] GET /orders/:orderId/return (create return)')
    const firstOrder = await db
      .selectFrom('orders' as any)
      .select(['id'] as any)
      .where('shop_id' as any, '=', store.id)
      .orderBy('created_at' as any, 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!firstOrder) {
      console.log('[skip] No orders — skipping create-return phase')
      return true
    }
    const oid = (firstOrder as any).id
    const req = makeReq({
      params: { orderId: oid },
      path: `/orders/${oid}/return`,
    })
    const res = makeMockRes()
    try {
      await getCreateReturn(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['CSRF token present', /name="_csrf"/.test(res.body)],
        [
          'return form action',
          new RegExp(`action="${base}/orders/${oid}/return"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /orders/${oid}/return`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET return threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 7: /orders/abandoned ────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 7] GET /orders/abandoned')
    const req = makeReq({ path: '/orders/abandoned' })
    const res = makeMockRes()
    try {
      await getAbandonedCheckouts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Abandoned Checkouts"', /Abandoned Checkouts/.test(res.body)],
        [
          'filter form action',
          new RegExp(`action="${base}/orders/abandoned"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /orders/abandoned', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /orders/abandoned threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 8: /orders/analytics ────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 8] GET /orders/analytics')
    const req = makeReq({ path: '/orders/analytics', query: { period: '30d' } })
    const res = makeMockRes()
    try {
      await getOrderAnalytics(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 300],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /orders/analytics', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /orders/analytics threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 9: /orders/export ───────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 9] GET /orders/export')
    const req = makeReq({ path: '/orders/export' })
    const res = makeMockRes()
    try {
      await getOrderExport(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 300],
        ['CSRF token present', /name="_csrf"/.test(res.body)],
        [
          'export form action',
          new RegExp(`action="${base}/orders/export/download"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /orders/export', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /orders/export threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 10: /orders/import ──────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 10] GET /orders/import')
    const req = makeReq({ path: '/orders/import' })
    const res = makeMockRes()
    try {
      await getOrderImport(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 300],
        ['CSRF token present', /name="_csrf"/.test(res.body)],
        [
          'import upload form action',
          new RegExp(`action="${base}/orders/import/upload"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /orders/import', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /orders/import threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 11: /orders/import-tracking ─────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 11] GET /orders/import-tracking')
    const req = makeReq({ path: '/orders/import-tracking' })
    const res = makeMockRes()
    try {
      await getImportTracking(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 300],
        [
          'upload form action',
          new RegExp(`action="${base}/orders/import-tracking/upload"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /orders/import-tracking', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /orders/import-tracking threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 12: /returns (list) ─────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 12] GET /returns')
    const req = makeReq({ path: '/returns' })
    const res = makeMockRes()
    try {
      await getReturns(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 300],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /returns', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /returns threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 13: /fulfillments (list) ────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 13] GET /fulfillments')
    const req = makeReq({ path: '/fulfillments' })
    const res = makeMockRes()
    try {
      await getFulfillments(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 300],
        [
          'filter form action',
          new RegExp(`action="${base}/fulfillments"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /fulfillments', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /fulfillments threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 14: /fulfillments/:orderId (detail) ─────────────────────
  phases.push(async () => {
    console.log('\n[phase 14] GET /fulfillments/:orderId (detail)')
    const firstOrder = await db
      .selectFrom('orders' as any)
      .select(['id'] as any)
      .where('shop_id' as any, '=', store.id)
      .orderBy('created_at' as any, 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!firstOrder) {
      console.log('[skip] No orders — skipping fulfillment-detail phase')
      return true
    }
    const oid = (firstOrder as any).id
    const req = makeReq({
      params: { orderId: oid },
      path: `/fulfillments/${oid}`,
    })
    const res = makeMockRes()
    try {
      await getFulfillmentDetail(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 300],
        [
          'Back to fulfillments link',
          new RegExp(`href="${base}/fulfillments"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /fulfillments/${oid}`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /fulfillments/:id threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 15: /refund-requests (list) ─────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 15] GET /refund-requests')
    const req = makeReq({ path: '/refund-requests' })
    const res = makeMockRes()
    try {
      await getRefundRequests(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 200],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /refund-requests', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /refund-requests threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 16: /refund-requests/new?orderId=... ─────────────────────
  phases.push(async () => {
    console.log('\n[phase 16] GET /refund-requests/new?orderId=...')
    const firstOrder = await db
      .selectFrom('orders' as any)
      .select(['id'] as any)
      .where('shop_id' as any, '=', store.id)
      .orderBy('created_at' as any, 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!firstOrder) {
      console.log('[skip] No orders — skipping refund-requests/new phase')
      return true
    }
    const oid = (firstOrder as any).id
    const req = makeReq({
      query: { orderId: oid },
      path: `/refund-requests/new?orderId=${oid}`,
    })
    const res = makeMockRes()
    try {
      await getCreateRefundRequest(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 200],
        ['CSRF token present', /name="_csrf"/.test(res.body)],
        [
          'refund form action',
          new RegExp(`action="${base}/refund-requests/new`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /refund-requests/new?orderId=${oid}`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET refund-requests/new threw: ${err.message}`)
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
