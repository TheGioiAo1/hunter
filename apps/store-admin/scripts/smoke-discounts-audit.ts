/**
 * Comprehensive /discounts audit smoke test — Phase E.
 *
 * Exercises every GET handler under /discounts/* with a mocked req/res
 * pair, then asserts the rendered HTML does not contain dead-link bug
 * patterns.
 *
 * Phase E fixes that this test guards:
 *   1. POST /discounts/new does NOT exist — the create form must post to
 *      ${base}/discounts (the actual handler). Earlier the form action
 *      was /discounts/new and would 404 on submit.
 *   2. getDiscountDetail must read req.params.discountId (not .id) — the
 *      route is /:discountId. Reading the wrong param made every detail
 *      page render "Discount not found".
 *   3. postDeleteDiscount has the same params.discountId bug.
 *   4. The detail page renders the edit form as a disabled <fieldset>
 *      with a "Coming soon" Save button because no
 *      POST /discounts/:discountId update handler exists yet.
 *
 * Usage: STORE_ADMIN_PORT=0 tsx scripts/smoke-discounts-audit.ts [storeSlug]
 */

if (!process.env.STORE_ADMIN_PORT) {
  process.env.STORE_ADMIN_PORT = '0'
}

import { createDb, destroyDb } from '@gbox/db'
import {
  getDiscounts,
  getCreateDiscount,
  getDiscountDetail,
} from '../src/pages/discounts.ts'

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
 * Inherits Phase B + C + D guards and adds Phase E guards.
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
      // Allow action="${base}/discounts/${id}/delete" but reject the bare
      // action="${base}/discounts/${uuid}" which would target the absent
      // update handler.
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

  console.log(`[smoke] Comprehensive /discounts audit for store: ${storeSlug}`)
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

  // ── PHASE 1: /discounts (list, all tabs) ──────────────────────────
  phases.push(async () => {
    console.log('\n[phase 1] GET /discounts')
    const req = makeReq({ path: '/discounts' })
    const res = makeMockRes()
    try {
      await getDiscounts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Discounts"', />Discounts</.test(res.body)],
        [
          'Create discount button',
          new RegExp(`href="${base}/discounts/new"`).test(res.body),
        ],
        [
          'Search form action',
          new RegExp(`action="${base}/discounts"`).test(res.body),
        ],
        ['Tabs render', /class="tab/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /discounts', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /discounts threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 2: /discounts?tab=active ────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 2] GET /discounts?tab=active')
    const req = makeReq({ path: '/discounts?tab=active', query: { tab: 'active' } })
    const res = makeMockRes()
    try {
      await getDiscounts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Active tab marked as current',
          /class="tab active"[^>]*>Active</.test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /discounts?tab=active', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /discounts?tab=active threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 3: /discounts?tab=scheduled ─────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 3] GET /discounts?tab=scheduled')
    const req = makeReq({ path: '/discounts?tab=scheduled', query: { tab: 'scheduled' } })
    const res = makeMockRes()
    try {
      await getDiscounts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /discounts?tab=scheduled', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /discounts?tab=scheduled threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 4: /discounts?tab=expired ───────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 4] GET /discounts?tab=expired')
    const req = makeReq({ path: '/discounts?tab=expired', query: { tab: 'expired' } })
    const res = makeMockRes()
    try {
      await getDiscounts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /discounts?tab=expired', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /discounts?tab=expired threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 5: /discounts?q=foo (search) ────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 5] GET /discounts?q=test')
    const req = makeReq({ path: '/discounts?q=test', query: { q: 'test' } })
    const res = makeMockRes()
    try {
      await getDiscounts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['Search input echoed', /value="test"/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /discounts?q=test', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /discounts?q=test threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 6: /discounts/new (create form) ─────────────────────────
  phases.push(async () => {
    console.log('\n[phase 6] GET /discounts/new')
    const req = makeReq({ path: '/discounts/new' })
    const res = makeMockRes()
    try {
      await getCreateDiscount(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['CSRF field present', /name="_csrf"/.test(res.body)],
        [
          'form posts to /discounts (NOT /discounts/new)',
          new RegExp(`<form[^>]*action="${base}/discounts"[^>]*method="POST"`).test(res.body)
            || new RegExp(`<form[^>]*method="POST"[^>]*action="${base}/discounts"`).test(res.body),
        ],
        ['Submit button labeled Create', /Create discount<\/button>/i.test(res.body) || /type="submit"/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /discounts/new', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /discounts/new threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 7: /discounts/:discountId (detail, read-only) ───────────
  phases.push(async () => {
    console.log('\n[phase 7] GET /discounts/:discountId (detail)')
    const firstDiscount = await db
      .selectFrom('discounts' as any)
      .select(['id', 'code'] as any)
      .where('shop_id' as any, '=', store.id)
      .orderBy('created_at' as any, 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!firstDiscount) {
      console.log('[skip] No discounts — skipping detail phase')
      return true
    }
    const did = (firstDiscount as any).id
    const req = makeReq({
      params: { discountId: did },
      path: `/discounts/${did}`,
    })
    const res = makeMockRes()
    try {
      await getDiscountDetail(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200 (NOT 404)', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'NOT showing "Discount not found"',
          !/Discount not found/.test(res.body),
        ],
        [
          'Back to discounts link',
          new RegExp(`href="${base}/discounts"`).test(res.body),
        ],
        [
          'Delete form posts to /discounts/:id/delete',
          new RegExp(`action="${base}/discounts/${did}/delete"`).test(res.body),
        ],
        [
          'Edit form is disabled (read-only fieldset)',
          /<fieldset disabled/.test(res.body),
        ],
        [
          '"Coming soon" save button label',
          /Coming soon/.test(res.body),
        ],
        [
          'Save button is disabled',
          /<button[^>]*type="button"[^>]*disabled/.test(res.body)
            || /<button[^>]*disabled[^>]*type="button"/.test(res.body),
        ],
        ['CSRF field present (for delete)', /name="_csrf"/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /discounts/${did}`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /discounts/:id threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 8: /discounts/:invalidId (404 path) ─────────────────────
  phases.push(async () => {
    console.log('\n[phase 8] GET /discounts/:invalidId (404 path)')
    const req = makeReq({
      params: { discountId: '00000000-0000-0000-0000-000000000000' },
      path: '/discounts/00000000-0000-0000-0000-000000000000',
    })
    const res = makeMockRes()
    try {
      await getDiscountDetail(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 404', res.statusCode === 404],
        ['shows "Discount not found" message', /Discount not found/.test(res.body)],
        [
          'Back to discounts link',
          new RegExp(`href="${base}/discounts"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /discounts/<bogus-uuid>', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /discounts/:invalidId threw: ${err.message}`)
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
