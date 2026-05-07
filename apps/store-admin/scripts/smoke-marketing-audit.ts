/**
 * Comprehensive /marketing audit smoke test — Phase F.
 *
 * Exercises every GET handler under /marketing/* with a mocked req/res
 * pair, then asserts the rendered HTML does not contain dead-link bug
 * patterns from earlier phases.
 *
 * No structural bugs were found in marketing/campaigns/automations/SEO
 * pages, so this script is purely a regression guard for the dead-link
 * patterns accumulated across Phase B–E.
 *
 * Usage: STORE_ADMIN_PORT=0 tsx scripts/smoke-marketing-audit.ts [storeSlug]
 */

if (!process.env.STORE_ADMIN_PORT) {
  process.env.STORE_ADMIN_PORT = '0'
}

import { createDb, destroyDb } from '@gbox/db'
import {
  getMarketingDashboard,
  getAbandonedCarts,
  getSeoManager,
} from '../src/pages/marketing.ts'
import { getCampaigns } from '../src/pages/campaigns.ts'
import { getAutomations } from '../src/pages/automations.ts'

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

  console.log(`[smoke] Comprehensive /marketing audit for store: ${storeSlug}`)
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

  const makeReq = (opts: { params?: any; query?: any; path?: string; body?: any }) => ({
    params: { slug: storeSlug, ...(opts.params || {}) },
    query: opts.query || {},
    body: opts.body || {},
    originalUrl: `${base}${opts.path || ''}`,
    store,
    storeUser: regularUser,
    theme: 'dark',
    csrfToken: 'smoke-test-csrf-token',
  })

  let failures = 0
  const phases: Array<() => Promise<boolean>> = []

  // ── PHASE 1: /marketing (dashboard) ───────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 1] GET /marketing')
    const req = makeReq({ path: '/marketing' })
    const res = makeMockRes()
    try {
      await getMarketingDashboard(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Marketing"', />Marketing</.test(res.body)],
        [
          'Abandoned carts link',
          new RegExp(`href="${base}/marketing/abandoned"`).test(res.body),
        ],
        [
          'Campaigns link',
          new RegExp(`href="${base}/marketing/campaigns"`).test(res.body),
        ],
        [
          'SEO link',
          new RegExp(`href="${base}/marketing/seo"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /marketing', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /marketing threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 2: /marketing/campaigns ─────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 2] GET /marketing/campaigns')
    const req = makeReq({ path: '/marketing/campaigns' })
    const res = makeMockRes()
    try {
      await getCampaigns(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Campaigns"', />Campaigns</.test(res.body)],
        [
          'Back to Marketing link',
          new RegExp(`href="${base}/marketing"`).test(res.body),
        ],
        [
          'Audience segments rendered',
          /All Subscribers/.test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /marketing/campaigns', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /marketing/campaigns threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 3: /marketing/automations ───────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 3] GET /marketing/automations')
    const req = makeReq({ path: '/marketing/automations' })
    const res = makeMockRes()
    try {
      await getAutomations(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Automations"', />Automations</.test(res.body)],
        [
          'Forms post to /marketing/automations',
          new RegExp(`action="${base}/marketing/automations"`).test(res.body),
        ],
        ['CSRF field present', /name="_csrf"/.test(res.body)],
        [
          'All 5 preset automations rendered',
          /Abandoned Cart Recovery/.test(res.body)
            && /Welcome Email/.test(res.body)
            && /Post-Purchase Follow-up/.test(res.body)
            && /Win-back Campaign/.test(res.body)
            && /Birthday Discount/.test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /marketing/automations', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /marketing/automations threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 4: /marketing/automations?create=1 (create form) ────────
  phases.push(async () => {
    console.log('\n[phase 4] GET /marketing/automations?create=1')
    const req = makeReq({
      path: '/marketing/automations?create=1',
      query: { create: '1' },
    })
    const res = makeMockRes()
    try {
      await getAutomations(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['Create form rendered', /Create Custom Automation/.test(res.body)],
        [
          'Form submits to /marketing/automations',
          new RegExp(`action="${base}/marketing/automations"`).test(res.body),
        ],
        [
          'Cancel link returns to /marketing/automations',
          new RegExp(`href="${base}/marketing/automations"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /marketing/automations?create=1', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /marketing/automations?create=1 threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 5: /marketing/abandoned (carts list) ────────────────────
  phases.push(async () => {
    console.log('\n[phase 5] GET /marketing/abandoned')
    const req = makeReq({ path: '/marketing/abandoned' })
    const res = makeMockRes()
    try {
      await getAbandonedCarts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Abandoned Carts"', />Abandoned Carts</.test(res.body)],
        [
          'Back to Marketing link',
          new RegExp(`href="${base}/marketing"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /marketing/abandoned', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /marketing/abandoned threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 6: /marketing/seo (SEO Manager) ─────────────────────────
  phases.push(async () => {
    console.log('\n[phase 6] GET /marketing/seo')
    const req = makeReq({ path: '/marketing/seo' })
    const res = makeMockRes()
    try {
      await getSeoManager(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "SEO Manager"', />SEO Manager</.test(res.body)],
        [
          'Back to Marketing link',
          new RegExp(`href="${base}/marketing"`).test(res.body),
        ],
        ['SEO score rendered', /SEO Score/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /marketing/seo', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /marketing/seo threw: ${err.message}`)
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
