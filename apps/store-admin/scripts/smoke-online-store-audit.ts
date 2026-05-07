/**
 * Comprehensive /online-store audit smoke test — Phase H.
 *
 * Exercises every GET handler under /online-store/* with a mocked req/res
 * pair, then asserts the rendered HTML does not contain dead-link bug
 * patterns from earlier phases plus the Phase H patterns introduced here.
 *
 * Phase H bug class (fixed in this pass):
 *   - online-store.ts hub linked to ${base}/pages and ${base}/blog, but the
 *     routes are mounted at /online-store/pages and /online-store/blog —
 *     both links 404.
 *   - pages.ts (6 handlers) and blog.ts (6 handlers) built every URL with
 *     bare `${base}/pages` / `${base}/blog` and read `req.params.id` —
 *     Express 5 routes use `:pageId` / `:postId`, so `params.id` was
 *     undefined and every detail render hit "not found".
 *   - getCreatePage / getCreateBlogPost submitted to `${base}/pages/new`
 *     and `${base}/blog/new` — POST routes are at the bare listing path.
 *
 * Usage: STORE_ADMIN_PORT=0 tsx scripts/smoke-online-store-audit.ts [storeSlug]
 */

if (!process.env.STORE_ADMIN_PORT) {
  process.env.STORE_ADMIN_PORT = '0'
}

import { createDb, destroyDb } from '@gbox/db'
import { getOnlineStoreHub, getThemes } from '../src/pages/online-store.ts'
import { getFilesPage } from '../src/pages/files.ts'
import { getPages, getCreatePage, getPageDetail } from '../src/pages/pages.ts'
import { getBlogPosts, getCreateBlogPost, getBlogPostDetail } from '../src/pages/blog.ts'
import { getNavigation } from '../src/pages/navigation.ts'
import { getDomains } from '../src/pages/domains.ts'
import { getPreferences } from '../src/pages/preferences.ts'

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
 * Inherits Phase B + C + D + E guards, plus Phase H additions at bottom.
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
    // Phase H guards — catch bare /pages and /blog links without the
    // /online-store/ prefix that matches server.ts route mounts.
    [
      'No bare /pages href (must be /online-store/pages)',
      !new RegExp(`href="${base}/pages(?:"|/|\\?|#)`).test(body),
    ],
    [
      'No bare /pages form action (must be /online-store/pages)',
      !new RegExp(`action="${base}/pages(?:"|/|\\?|#)`).test(body),
    ],
    [
      'No bare /blog href (must be /online-store/blog)',
      !new RegExp(`href="${base}/blog(?:"|/|\\?|#)`).test(body),
    ],
    [
      'No bare /blog form action (must be /online-store/blog)',
      !new RegExp(`action="${base}/blog(?:"|/|\\?|#)`).test(body),
    ],
    [
      'No dead /pages/new form action (POST is to /pages)',
      !new RegExp(`action="${base}/online-store/pages/new(?:"|\\?|#)`).test(body),
    ],
    [
      'No dead /blog/new form action (POST is to /blog)',
      !new RegExp(`action="${base}/online-store/blog/new(?:"|\\?|#)`).test(body),
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

  console.log(`[smoke] Comprehensive /online-store audit for store: ${storeSlug}`)
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

  // ── PHASE 1: /online-store (hub) ───────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 1] GET /online-store')
    const req = makeReq({ path: '/online-store' })
    const res = makeMockRes()
    try {
      await getOnlineStoreHub(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Online Store"', />Online Store</.test(res.body)],
        [
          'Themes quick-link → /online-store/themes',
          new RegExp(`href="${base}/online-store/themes"`).test(res.body),
        ],
        [
          'Pages quick-link → /online-store/pages',
          new RegExp(`href="${base}/online-store/pages"`).test(res.body),
        ],
        [
          'Blog quick-link → /online-store/blog',
          new RegExp(`href="${base}/online-store/blog"`).test(res.body),
        ],
        [
          'Navigation quick-link → /online-store/navigation',
          new RegExp(`href="${base}/online-store/navigation"`).test(res.body),
        ],
        [
          'Domains quick-link → /online-store/domains',
          new RegExp(`href="${base}/online-store/domains"`).test(res.body),
        ],
        [
          'Files quick-link → /online-store/files',
          new RegExp(`href="${base}/online-store/files"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 2: /online-store/themes ─────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 2] GET /online-store/themes')
    const req = makeReq({ path: '/online-store/themes' })
    const res = makeMockRes()
    try {
      await getThemes(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Themes"', />Themes</.test(res.body)],
        [
          'Back to Online Store link',
          new RegExp(`href="${base}/online-store"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/themes', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/themes threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 3: /online-store/files ──────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 3] GET /online-store/files')
    const req = makeReq({ path: '/online-store/files' })
    const res = makeMockRes()
    try {
      await getFilesPage(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Files"', />Files</.test(res.body)],
        [
          'Back to Online Store link',
          new RegExp(`href="${base}/online-store"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/files', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/files threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 4: /online-store/pages (list) ───────────────────────────
  phases.push(async () => {
    console.log('\n[phase 4] GET /online-store/pages')
    const req = makeReq({ path: '/online-store/pages' })
    const res = makeMockRes()
    try {
      await getPages(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Pages"', />Pages</.test(res.body)],
        [
          'Create page link → /online-store/pages/new',
          new RegExp(`href="${base}/online-store/pages/new"`).test(res.body),
        ],
        [
          'Search form action → /online-store/pages',
          new RegExp(`action="${base}/online-store/pages"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/pages', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/pages threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 5: /online-store/pages/new (create form) ────────────────
  phases.push(async () => {
    console.log('\n[phase 5] GET /online-store/pages/new')
    const req = makeReq({ path: '/online-store/pages/new' })
    const res = makeMockRes()
    try {
      await getCreatePage(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Create page"', />Create page</.test(res.body)],
        [
          'Form POSTs to /online-store/pages (bare, no /new suffix)',
          new RegExp(`action="${base}/online-store/pages"`).test(res.body),
        ],
        [
          'Cancel link → /online-store/pages',
          new RegExp(`href="${base}/online-store/pages"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/pages/new', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/pages/new threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 6: /online-store/pages/:invalidId (404 path) ────────────
  phases.push(async () => {
    console.log('\n[phase 6] GET /online-store/pages/<bogus-uuid>')
    const bogusId = '00000000-0000-0000-0000-000000000000'
    const req = makeReq({
      path: `/online-store/pages/${bogusId}`,
      params: { pageId: bogusId },
    })
    const res = makeMockRes()
    try {
      await getPageDetail(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 404', res.statusCode === 404],
        ['non-empty body', res.body.length > 100],
        ['renders "not found"', /Page not found/i.test(res.body)],
        [
          'Back to Pages link → /online-store/pages',
          new RegExp(`href="${base}/online-store/pages"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/pages/<bogus-uuid>', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/pages/<bogus> threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 7: /online-store/blog (list) ────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 7] GET /online-store/blog')
    const req = makeReq({ path: '/online-store/blog' })
    const res = makeMockRes()
    try {
      await getBlogPosts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Blog Posts"', />Blog Posts</.test(res.body)],
        [
          'Create post link → /online-store/blog/new',
          new RegExp(`href="${base}/online-store/blog/new"`).test(res.body),
        ],
        [
          'Search form action → /online-store/blog',
          new RegExp(`action="${base}/online-store/blog"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/blog', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/blog threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 8: /online-store/blog/new (create form) ─────────────────
  phases.push(async () => {
    console.log('\n[phase 8] GET /online-store/blog/new')
    const req = makeReq({ path: '/online-store/blog/new' })
    const res = makeMockRes()
    try {
      await getCreateBlogPost(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['page title "Create blog post"', />Create blog post</.test(res.body)],
        [
          'Form POSTs to /online-store/blog (bare, no /new suffix)',
          new RegExp(`action="${base}/online-store/blog"`).test(res.body),
        ],
        [
          'Cancel link → /online-store/blog',
          new RegExp(`href="${base}/online-store/blog"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/blog/new', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/blog/new threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 9: /online-store/blog/:invalidId (404 path) ─────────────
  phases.push(async () => {
    console.log('\n[phase 9] GET /online-store/blog/<bogus-uuid>')
    const bogusId = '00000000-0000-0000-0000-000000000000'
    const req = makeReq({
      path: `/online-store/blog/${bogusId}`,
      params: { postId: bogusId },
    })
    const res = makeMockRes()
    try {
      await getBlogPostDetail(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 404', res.statusCode === 404],
        ['non-empty body', res.body.length > 100],
        ['renders "not found"', /Blog post not found/i.test(res.body)],
        [
          'Back to Blog link → /online-store/blog',
          new RegExp(`href="${base}/online-store/blog"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/blog/<bogus-uuid>', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/blog/<bogus> threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 10: /online-store/navigation ────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 10] GET /online-store/navigation')
    const req = makeReq({ path: '/online-store/navigation' })
    const res = makeMockRes()
    try {
      await getNavigation(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Back to Online Store link',
          new RegExp(`href="${base}/online-store"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/navigation', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/navigation threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 11: /online-store/domains ───────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 11] GET /online-store/domains')
    const req = makeReq({ path: '/online-store/domains' })
    const res = makeMockRes()
    try {
      await getDomains(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/domains', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/domains threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 12: /online-store/preferences ───────────────────────────
  phases.push(async () => {
    console.log('\n[phase 12] GET /online-store/preferences')
    const req = makeReq({ path: '/online-store/preferences' })
    const res = makeMockRes()
    try {
      await getPreferences(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /online-store/preferences', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /online-store/preferences threw: ${err.message}`)
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
