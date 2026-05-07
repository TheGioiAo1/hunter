/**
 * Comprehensive /settings audit smoke test — Phase I.
 *
 * Exercises every GET handler under /settings/* with a mocked req/res pair,
 * then asserts the rendered HTML does not contain dead-link bug patterns
 * from earlier phases plus the Phase I patterns introduced here.
 *
 * Phase I bug class (fixed in this pass):
 *   - settings.ts (hub) linked to `${base}/settings/domains` which is not a
 *     real route (real one is `/online-store/domains`). Hub also only
 *     showed 7 of the 17 cards the sidebar nav exposes.
 *   - settings-extended.ts getTaxSettings rendered a form POSTing to
 *     `/settings/taxes` but there was no POST handler — the form was a
 *     dead write.
 *   - `/settings/shipping` served the old 1-form handler while the
 *     full-featured page was orphaned at `/settings/shipping/full`.
 *   - `/settings/billing` (getBillingPage) had no nav/hub links — dead
 *     orphan. Swapped to a redirect to `/settings/plan`.
 *   - payment-settings.ts rendered a `<a href=".../settings/payments?disconnect_paypal=1">`
 *     but the GET handler never parsed that query param — disconnect
 *     was a no-op. Swapped to a POST form → `/settings/payments/disconnect-paypal`.
 *
 * Usage: STORE_ADMIN_PORT=0 tsx scripts/smoke-settings-audit.ts [storeSlug]
 */

if (!process.env.STORE_ADMIN_PORT) {
  process.env.STORE_ADMIN_PORT = '0'
}

import { createDb, destroyDb } from '@gbox/db'
import { getSettings, getGeneralSettings, getStaffSettings } from '../src/pages/settings.ts'
import {
  getShippingSettings,
  getTaxSettings,
  getNotificationSettings,
  getLegalPages,
  getActivityLog,
} from '../src/pages/settings-extended.ts'
import { getShippingSettingsPage } from '../src/pages/shipping-settings.ts'
import { getPaymentSettings } from '../src/pages/payment-settings.ts'
import { getCheckoutSettings } from '../src/pages/checkout-settings.ts'
import { getMarketsSettings } from '../src/pages/markets-settings.ts'
import { getCustomerAccountsSettings } from '../src/pages/customer-accounts-settings.ts'
import { getCustomDataSettings } from '../src/pages/custom-data-settings.ts'
import { getLanguagesSettings } from '../src/pages/languages-settings.ts'
import { getPlanSettings } from '../src/pages/plan-settings.ts'
import { getAiSettings } from '../src/pages/ai-settings.ts'
import { getLocations } from '../src/pages/locations.ts'
import { getPixelConfigPage } from '../src/pages/pixel-config.ts'

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
  appendHeader: (k: string, v: string | string[]) => any
  getHeader: (k: string) => any
} {
  const res: any = {
    statusCode: 200,
    body: '',
    headers: {},
    // Track Set-Cookie separately so CSRF `issue()` (which calls
    // res.appendHeader('set-cookie', ...)) doesn't throw on Express 5.
    _cookies: [] as string[],
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
    getHeader(k: string) {
      return this.headers[k]
    },
    appendHeader(k: string, v: string | string[]) {
      const key = k.toLowerCase()
      if (key === 'set-cookie') {
        const vals = Array.isArray(v) ? v : [v]
        this._cookies.push(...vals)
        return this
      }
      if (this.headers[k] == null) {
        this.headers[k] = v
      } else if (Array.isArray(this.headers[k])) {
        this.headers[k] = [...this.headers[k], ...(Array.isArray(v) ? v : [v])]
      } else {
        this.headers[k] = [this.headers[k], ...(Array.isArray(v) ? v : [v])]
      }
      return this
    },
  }
  return res
}

/**
 * Dead link patterns that must NOT appear in any rendered settings page.
 * Inherits Phase B/C/D/E/H guards, plus Phase I additions at the bottom.
 */
function deadLinkChecks(body: string, base: string): Array<[string, boolean]> {
  return [
    // Phase B
    [
      'No bare /admin/store/<slug>/collections href',
      !new RegExp(`href="${base}/collections(?:"|/|\\?)`).test(body),
    ],
    [
      'No dead /products/create form action',
      !new RegExp(`action="${base}/products/create(?:"|/|\\?|#)`).test(body),
    ],
    // Phase C
    [
      'No /orders/abandoned/:id detail link',
      !/href="[^"]*\/orders\/abandoned\/[0-9a-f]{8}-/i.test(body),
    ],
    // Phase D
    [
      'No dead /customers/export link',
      !new RegExp(`href="${base}/customers/export`).test(body)
        && !new RegExp(`href="/admin/store/[^/]+/customers/export`).test(body),
    ],
    // Phase E
    [
      'No dead /discounts/new form action',
      !new RegExp(`action="${base}/discounts/new(?:"|/|\\?|#)`).test(body),
    ],
    // Phase H
    [
      'No bare /pages href (must be /online-store/pages)',
      !new RegExp(`href="${base}/pages(?:"|/|\\?|#)`).test(body),
    ],
    [
      'No bare /blog href (must be /online-store/blog)',
      !new RegExp(`href="${base}/blog(?:"|/|\\?|#)`).test(body),
    ],
    // Phase I — new dead-link guards for /settings
    [
      'No dead /settings/domains href (must be /online-store/domains)',
      !new RegExp(`href="${base}/settings/domains(?:"|/|\\?|#)`).test(body),
    ],
    [
      'No dead PayPal disconnect GET link (must be POST form)',
      !/href="[^"]*disconnect_paypal=1/.test(body),
    ],
    [
      'No dead Stripe disconnect GET link (must be POST form)',
      !/href="[^"]*disconnect_stripe=1/.test(body),
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

  console.log(`[smoke] Comprehensive /settings audit for store: ${storeSlug}`)
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
    protocol: 'https',
    get: (header: string) => (header.toLowerCase() === 'host' ? 'admin.gbox.co' : ''),
    store,
    storeUser: regularUser,
    theme: 'dark',
    csrfToken: 'smoke-test-csrf-token',
  })

  let failures = 0
  const phases: Array<() => Promise<boolean>> = []

  // ── PHASE 1: /settings (hub) ────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 1] GET /settings (hub)')
    const req = makeReq({ path: '/settings' })
    const res = makeMockRes()
    try {
      await getSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Settings"', />Settings</.test(res.body)],
        // Hub must expose all 17 cards (Phase I expansion)
        [
          'Hub card: General',
          new RegExp(`href="${base}/settings/general"`).test(res.body),
        ],
        [
          'Hub card: Plan',
          new RegExp(`href="${base}/settings/plan"`).test(res.body),
        ],
        [
          'Hub card: Payments',
          new RegExp(`href="${base}/settings/payments"`).test(res.body),
        ],
        [
          'Hub card: Checkout',
          new RegExp(`href="${base}/settings/checkout"`).test(res.body),
        ],
        [
          'Hub card: Shipping',
          new RegExp(`href="${base}/settings/shipping"`).test(res.body),
        ],
        [
          'Hub card: Taxes',
          new RegExp(`href="${base}/settings/taxes"`).test(res.body),
        ],
        [
          'Hub card: Markets',
          new RegExp(`href="${base}/settings/markets"`).test(res.body),
        ],
        // Domains now points to /online-store/domains (was dead /settings/domains)
        [
          'Hub card: Domains → /online-store/domains',
          new RegExp(`href="${base}/online-store/domains"`).test(res.body),
        ],
        [
          'Hub card: Locations',
          new RegExp(`href="${base}/settings/locations"`).test(res.body),
        ],
        [
          'Hub card: Customer accounts',
          new RegExp(`href="${base}/settings/customer-accounts"`).test(res.body),
        ],
        [
          'Hub card: Notifications',
          new RegExp(`href="${base}/settings/notifications"`).test(res.body),
        ],
        [
          'Hub card: Custom data',
          new RegExp(`href="${base}/settings/custom-data"`).test(res.body),
        ],
        [
          'Hub card: Languages',
          new RegExp(`href="${base}/settings/languages"`).test(res.body),
        ],
        [
          'Hub card: Policies (legal)',
          new RegExp(`href="${base}/settings/legal"`).test(res.body),
        ],
        [
          'Hub card: Users and staff',
          new RegExp(`href="${base}/settings/staff"`).test(res.body),
        ],
        [
          'Hub card: Activity log',
          new RegExp(`href="${base}/settings/activity"`).test(res.body),
        ],
        [
          'Hub card: AI',
          new RegExp(`href="${base}/settings/ai"`).test(res.body),
        ],
        [
          'Hub card: Marketing pixels',
          new RegExp(`href="${base}/settings/pixels"`).test(res.body),
        ],
        // Phase 10 PR4 — Reviews settings card surfaces the profanity
        // filter + notification toggles from the Settings hub, matching
        // how AI / Notifications / Legal are already exposed.
        [
          'Hub card: Reviews → /products/reviews/settings',
          new RegExp(`href="${base}/products/reviews/settings"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 2: /settings/general ──────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 2] GET /settings/general')
    const req = makeReq({ path: '/settings/general' })
    const res = makeMockRes()
    try {
      await getGeneralSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Form POSTs to /settings/general',
          new RegExp(`action="${base}/settings/general"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/general', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/general threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 3: /settings/staff ────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 3] GET /settings/staff')
    const req = makeReq({ path: '/settings/staff' })
    const res = makeMockRes()
    try {
      await getStaffSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/staff', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/staff threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 4: /settings/payments ─────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 4] GET /settings/payments')
    const req = makeReq({ path: '/settings/payments' })
    const res = makeMockRes()
    try {
      await getPaymentSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Form POSTs to /settings/payments',
          new RegExp(`action="${base}/settings/payments"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/payments', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/payments threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 5: /settings/shipping (must serve FULL page now) ─────
  phases.push(async () => {
    console.log('\n[phase 5] GET /settings/shipping (full-featured)')
    const req = makeReq({ path: '/settings/shipping' })
    const res = makeMockRes()
    try {
      await getShippingSettingsPage(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        // Unique marker: full page has create-zone/create-rate/delete-zone forms
        [
          'Full-page create-zone form action',
          new RegExp(`action="${base}/settings/shipping/create-zone"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/shipping (full)', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/shipping threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 6: /settings/shipping/legacy (old handler still works) ─
  phases.push(async () => {
    console.log('\n[phase 6] GET /settings/shipping/legacy')
    const req = makeReq({ path: '/settings/shipping/legacy' })
    const res = makeMockRes()
    try {
      await getShippingSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/shipping/legacy', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/shipping/legacy threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 7: /settings/taxes ────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 7] GET /settings/taxes')
    const req = makeReq({ path: '/settings/taxes' })
    const res = makeMockRes()
    try {
      await getTaxSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        // Phase I: form must POST to /settings/taxes (the new handler)
        [
          'Form POSTs to /settings/taxes',
          new RegExp(`action="${base}/settings/taxes"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/taxes', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/taxes threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 8: /settings/notifications ────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 8] GET /settings/notifications')
    const req = makeReq({ path: '/settings/notifications' })
    const res = makeMockRes()
    try {
      await getNotificationSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/notifications', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/notifications threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 9: /settings/legal ────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 9] GET /settings/legal')
    const req = makeReq({ path: '/settings/legal' })
    const res = makeMockRes()
    try {
      await getLegalPages(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/legal', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/legal threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 10: /settings/activity ────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 10] GET /settings/activity')
    const req = makeReq({ path: '/settings/activity' })
    const res = makeMockRes()
    try {
      await getActivityLog(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/activity', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/activity threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 11: /settings/plan ────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 11] GET /settings/plan')
    const req = makeReq({ path: '/settings/plan' })
    const res = makeMockRes()
    try {
      await getPlanSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/plan', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/plan threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 12: /settings/checkout ────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 12] GET /settings/checkout')
    const req = makeReq({ path: '/settings/checkout' })
    const res = makeMockRes()
    try {
      await getCheckoutSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Form POSTs to /settings/checkout',
          new RegExp(`action="${base}/settings/checkout"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/checkout', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/checkout threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 13: /settings/markets ─────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 13] GET /settings/markets')
    const req = makeReq({ path: '/settings/markets' })
    const res = makeMockRes()
    try {
      await getMarketsSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Form POSTs to /settings/markets',
          new RegExp(`action="${base}/settings/markets"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/markets', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/markets threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 14: /settings/customer-accounts ──────────────────────
  phases.push(async () => {
    console.log('\n[phase 14] GET /settings/customer-accounts')
    const req = makeReq({ path: '/settings/customer-accounts' })
    const res = makeMockRes()
    try {
      await getCustomerAccountsSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Form POSTs to /settings/customer-accounts',
          new RegExp(`action="${base}/settings/customer-accounts"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/customer-accounts', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/customer-accounts threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 15: /settings/custom-data ─────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 15] GET /settings/custom-data')
    const req = makeReq({ path: '/settings/custom-data' })
    const res = makeMockRes()
    try {
      await getCustomDataSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/custom-data', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/custom-data threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 16: /settings/languages ───────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 16] GET /settings/languages')
    const req = makeReq({ path: '/settings/languages' })
    const res = makeMockRes()
    try {
      await getLanguagesSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Form POSTs to /settings/languages',
          new RegExp(`action="${base}/settings/languages"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/languages', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/languages threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 17: /settings/ai ──────────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 17] GET /settings/ai')
    const req = makeReq({ path: '/settings/ai' })
    const res = makeMockRes()
    try {
      await getAiSettings(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Form POSTs to /settings/ai',
          new RegExp(`action="${base}/settings/ai"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/ai', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/ai threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 18: /settings/locations ───────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 18] GET /settings/locations')
    const req = makeReq({ path: '/settings/locations' })
    const res = makeMockRes()
    try {
      await getLocations(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Create location form action → /settings/locations/create',
          new RegExp(`action="${base}/settings/locations/create"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/locations', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/locations threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 19: /settings/pixels (Marketing pixels — multi-pixel list) ─
  // Rewritten 2026-04-16 (migration 034): page is now a card list of
  // rows from `shop_tracking_pixels`, not a singleton form. No fixed
  // provider fields — merchants hit "+ Add pixel" to append Meta / GA4
  // / GTM / TikTok entries, each with its own Pixel ID + token.
  phases.push(async () => {
    console.log('\n[phase 19] GET /settings/pixels (multi-pixel list)')
    const req = makeReq({ path: '/settings/pixels' })
    const res = makeMockRes()
    try {
      await getPixelConfigPage(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Page title "Marketing pixels"',
          />Marketing pixels</.test(res.body),
        ],
        [
          '"+ Add pixel" link → /settings/pixels/new',
          new RegExp(`href="${base}/settings/pixels/new"`).test(res.body),
        ],
        [
          'Breadcrumb points back to /settings (not storefront-clone)',
          new RegExp(`href="${base}/settings"`).test(res.body) &&
            !/Storefront Clone/.test(res.body),
        ],
        [
          'No legacy /storefront-clone/pixels action',
          !new RegExp(`action="${base}/storefront-clone/pixels"`).test(res.body),
        ],
        [
          'No legacy singleton field names',
          !/name="meta_pixel_id"/.test(res.body) &&
            !/name="ga4_measurement_id"/.test(res.body) &&
            !/name="tiktok_pixel_id"/.test(res.body) &&
            !/name="consent_mode"/.test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/pixels', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/pixels threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 20: /settings/pixels/new (create form) ────────────────
  phases.push(async () => {
    console.log('\n[phase 20] GET /settings/pixels/new (create form)')
    const req = makeReq({ path: '/settings/pixels/new' })
    const res = makeMockRes()
    try {
      const { getPixelNewPage } = await import('../src/pages/pixel-config.ts')
      await getPixelNewPage(req as any, res as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Form POSTs to /settings/pixels (not legacy /storefront-clone/pixels)',
          new RegExp(`action="${base}/settings/pixels"`).test(res.body) &&
            !new RegExp(`action="${base}/storefront-clone/pixels"`).test(res.body),
        ],
        [
          'Provider select present',
          /name="provider"/.test(res.body),
        ],
        [
          'Label field present',
          /name="label"/.test(res.body),
        ],
        [
          'Pixel ID field present',
          /name="pixel_id"/.test(res.body),
        ],
        [
          'API token field present (password input)',
          /name="api_token"/.test(res.body),
        ],
        [
          'Events checkboxes present',
          /name="events"/.test(res.body),
        ],
        [
          'is_active checkbox present',
          /name="is_active"/.test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /settings/pixels/new', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /settings/pixels/new threw: ${err.message}`)
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
