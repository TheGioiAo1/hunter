/**
 * Comprehensive /products audit smoke test.
 *
 * Phase B audit: exercises every GET handler under /products/* and
 * /products/collections/* with a mocked req/res pair, then asserts the
 * rendered HTML on each page does NOT contain the bug patterns we fixed:
 *
 *   1. Collections links must use `/products/collections/*` (not bare
 *      `/collections/*`) — otherwise the store-auth middleware returns 403
 *      because the bare path isn't mounted under /admin/store/:slug.
 *   2. Product edit page must not link to `${base}/domains` — that route
 *      doesn't exist; the real page lives at `${base}/online-store/domains`.
 *   3. Product edit page must not show Personalization / Printhub links
 *      that point at `${base}/fulfillments/*` — Phase F0 centralised
 *      fulfillment via Lenful and those routes return 410 Gone.
 *   4. Collection detail must have a working Edit button that points to
 *      `.../collections/:id/edit` (handler existed? — Phase B added it).
 *   5. Collection edit form must carry a CSRF token and a Delete button.
 *
 * Usage: STORE_ADMIN_PORT=0 tsx scripts/smoke-products-audit.ts [storeSlug]
 *
 * STORE_ADMIN_PORT=0 lets the OS pick a free port so the imported server.ts
 * side-effect listen doesn't collide with a running dev server on 4325.
 */

// NOTE: set the test port BEFORE imports hoist server.ts. ESM hoists all
// imports to the top of the module, but `process.env` assignments outside
// of imports still execute before the imported module's top-level code runs
// *within* that import. tsx respects this. If we bind to 0 the OS picks a
// random free port.
if (!process.env.STORE_ADMIN_PORT) {
  process.env.STORE_ADMIN_PORT = '0'
}

import { createDb, destroyDb } from '@gbox/db'
import {
  getCollections,
  getCollectionDetail,
  getCreateCollection,
  getEditCollection,
} from '../src/pages/collections.ts'
import { getProducts, getProductDetail, getProductNew } from '../src/pages/products.ts'
import { getInventory } from '../src/pages/inventory.ts'
import { getTransfers, getPurchaseOrders } from '../src/pages/purchase-orders.ts'

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
 * Each pattern is a raw string (anchored to `href="..."` or `action="..."`)
 * that the old code used to emit and the fixes removed.
 */
function deadLinkChecks(body: string, base: string): Array<[string, boolean]> {
  return [
    // Collections must use /products/collections/* — never bare /collections/*
    [
      'No bare /admin/store/<slug>/collections href',
      !new RegExp(`href="${base}/collections(?:"|/|\\?)`).test(body),
    ],
    [
      'No bare /admin/store/<slug>/collections action',
      !new RegExp(`action="${base}/collections(?:"|/|\\?)`).test(body),
    ],
    // Bare /domains is dead — real page is /online-store/domains
    [
      'No dead /domains link (must be /online-store/domains)',
      !new RegExp(`href="${base}/domains(?:"|/|\\?|#)`).test(body),
    ],
    // Fulfillments routes are 410 Gone since Phase F0 — pages must not link
    [
      'No /fulfillments link (Phase F0 removed)',
      !new RegExp(`href="${base}/fulfillments(?:"|/|\\?|#)`).test(body),
    ],
    // /products/create is not a real route — the create form must post to /products
    [
      'No dead /products/create form action',
      !new RegExp(`action="${base}/products/create(?:"|/|\\?|#)`).test(body),
    ],
  ]
}

function sidebarChecks(body: string, expectedActivePage: string): Array<[string, boolean]> {
  // The seller-layout renders:
  //   <aside class="sidebar" id="sidebar">
  //     <nav class="sidebar-nav">
  //       <a class="nav-item active" aria-current="page" ...>
  //       <div class="nav-children"><a class="nav-child" aria-current="page">...
  // For sub-pages like /products/collections, the Products parent nav item
  // is *not* marked "active" (activePage='collections' doesn't match id='products'),
  // but the children drawer is opened and the Collections child gets
  // aria-current="page". So the active-check accepts either signal.
  return [
    ['Sidebar rendered', /class="sidebar"|class="sidebar-nav"|class="nav-item/.test(body)],
    [
      `Active page "${expectedActivePage}" highlighted`,
      // Parent item active (e.g. activePage='products' on /products list page):
      /class="nav-item active"/.test(body)
      // OR a nav-child inside nav-children with aria-current="page"
      // (e.g. activePage='collections' → Products drawer open, Collections child active):
      || /class="nav-children"[\s\S]*?class="nav-child"[^>]*aria-current="page"/.test(body)
      // OR the expected page's href appears with aria-current="page"
      // (fallback signal when the layout decorates the child directly):
      || new RegExp(`href="[^"]*/${expectedActivePage}[^"]*"[^>]*aria-current="page"`).test(body),
    ],
  ]
}

function pageHeaderCheck(body: string, expectedTitle: string): [string, boolean] {
  return [
    `Page title contains "${expectedTitle}"`,
    new RegExp(`<h1[^>]*class="page-title"[^>]*>[^<]*${expectedTitle}`, 'i').test(body)
      || body.includes(`>${expectedTitle}<`),
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

  console.log(`[smoke] Comprehensive /products audit for store: ${storeSlug}`)
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

  // ── PHASE 1: /products (main Lenful tab) ──────────────────────────
  phases.push(async () => {
    console.log('\n[phase 1] GET /products (default=Lenful tab)')
    const req = makeReq({ path: '/products', query: { source: 'lenful' } })
    const res = makeMockRes()
    try {
      await getProducts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 1000],
        pageHeaderCheck(res.body, 'Products'),
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /products (Lenful tab)', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 2: /products (My products tab) ──────────────────────────
  phases.push(async () => {
    console.log('\n[phase 2] GET /products?source=my (My products tab)')
    const req = makeReq({ path: '/products?source=my', query: { source: 'my' } })
    const res = makeMockRes()
    try {
      await getProducts(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 1000],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /products?source=my', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products?source=my threw: ${err.message}`)
      return false
    }
  })

  // ── PHASE 3: /products/new (create form) ──────────────────────────
  phases.push(async () => {
    console.log('\n[phase 3] GET /products/new (create form)')
    const req = makeReq({ path: '/products/new' })
    const res = makeMockRes()
    try {
      await getProductNew(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['CSRF field present', /name="_csrf"/.test(res.body)],
        ['form action points to POST /products', new RegExp(`action="[^"]*${base}/products"`).test(res.body) || /action="[^"]*\/products"/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /products/new', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products/new threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 4: /products/:id (edit form) ────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 4] GET /products/:id (edit form)')
    const firstProduct = await db
      .selectFrom('products' as any)
      .select(['id', 'title', 'status'] as any)
      .where('shop_id' as any, '=', store.id)
      .orderBy('created_at' as any, 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!firstProduct) {
      console.log('[skip] No products — skipping edit form phase')
      return true
    }
    const pid = (firstProduct as any).id
    console.log(`[ok]   Using product: ${(firstProduct as any).title}`)
    const req = makeReq({
      params: { productId: pid },
      path: `/products/${pid}`,
    })
    const res = makeMockRes()
    try {
      await getProductDetail(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['Main form id="pdMainForm"', /<form id="pdMainForm"/.test(res.body)],
        ['Save button wired to pdMainForm', /form="pdMainForm"[^>]*class="btn btn-primary">Save/.test(res.body)],
        ['Delete button wired to pdDeleteForm', /form="pdDeleteForm"[^>]*class="btn btn-danger">Delete/.test(res.body)],
        ['Personalization "Coming soon" badge present', /pd-badge-coming/.test(res.body) || /Coming soon/i.test(res.body)],
        ['Lenful-managed fulfillment card present', /Lenful[^<]*\(managed by Gbox\)|Gbox pushes every paid POD/.test(res.body)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /products/${pid}`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products/:id threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 5: /products/inventory ──────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 5] GET /products/inventory')
    const req = makeReq({ path: '/products/inventory' })
    const res = makeMockRes()
    try {
      await getInventory(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /products/inventory', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products/inventory threw: ${err.message}`)
      return false
    }
  })

  // ── PHASE 6: /products/transfers ──────────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 6] GET /products/transfers')
    const req = makeReq({ path: '/products/transfers' })
    const res = makeMockRes()
    try {
      await getTransfers(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 300],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /products/transfers', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products/transfers threw: ${err.message}`)
      return false
    }
  })

  // ── PHASE 7: /products/purchase-orders ────────────────────────────
  phases.push(async () => {
    console.log('\n[phase 7] GET /products/purchase-orders')
    const req = makeReq({ path: '/products/purchase-orders' })
    const res = makeMockRes()
    try {
      await getPurchaseOrders(req as any, res as any, db as any)
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 300],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /products/purchase-orders', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products/purchase-orders threw: ${err.message}`)
      return false
    }
  })

  // ── PHASE 8: /products/collections (list) ─────────────────────────
  phases.push(async () => {
    console.log('\n[phase 8] GET /products/collections (list)')
    const req = makeReq({ path: '/products/collections' })
    const res = makeMockRes()
    try {
      await getCollections(req as any, res as any, db as any)
      const colBase = `${base}/products/collections`
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['"Create collection" button present', /Create collection/.test(res.body)],
        [
          'Create button points to /products/collections/new',
          new RegExp(`href="${colBase}/new"`).test(res.body),
        ],
        [
          'Search form action uses /products/collections',
          new RegExp(`action="${colBase}"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
        ...sidebarChecks(res.body, 'collections'),
      ]
      return runChecks('GET /products/collections', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products/collections threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 9: /products/collections/new (create form) ──────────────
  phases.push(async () => {
    console.log('\n[phase 9] GET /products/collections/new (create form)')
    const req = makeReq({ path: '/products/collections/new' })
    const res = makeMockRes()
    try {
      await getCreateCollection(req as any, res as any, db as any)
      const colBase = `${base}/products/collections`
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['CSRF field present', /name="_csrf"/.test(res.body)],
        ['Title input present', /name="title"/.test(res.body)],
        [
          'Form action posts to /products/collections',
          new RegExp(`action="${colBase}(/new)?"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks('GET /products/collections/new', checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products/collections/new threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 10: /products/collections/:id (detail) ──────────────────
  phases.push(async () => {
    console.log('\n[phase 10] GET /products/collections/:id (detail)')
    const firstCollection = await db
      .selectFrom('collections' as any)
      .select(['id', 'title', 'slug'] as any)
      .where('shop_id' as any, '=', store.id)
      .limit(1)
      .executeTakeFirst()

    if (!firstCollection) {
      console.log('[skip] No collections — will use synthetic ID to test 404 path')
      const req = makeReq({
        params: { collectionId: '00000000-0000-0000-0000-000000000000' },
        path: '/products/collections/00000000-0000-0000-0000-000000000000',
      })
      const res = makeMockRes()
      try {
        await getCollectionDetail(req as any, res as any, db as any)
        const checks: Array<[string, boolean]> = [
          ['status 404 for missing collection', res.statusCode === 404],
          ['"Back to collections" link present', /Back to collections/.test(res.body)],
          [
            'Back link uses /products/collections (not bare)',
            new RegExp(`href="${base}/products/collections"`).test(res.body),
          ],
        ]
        return runChecks('GET /products/collections/<missing>', checks)
      } catch (err: any) {
        console.error(`[FAIL] GET /products/collections/<missing> threw: ${err.message}`)
        return false
      }
    }

    const cid = (firstCollection as any).id
    const title = (firstCollection as any).title
    console.log(`[ok]   Using collection: ${title} (${cid})`)
    const req = makeReq({
      params: { collectionId: cid },
      path: `/products/collections/${cid}`,
    })
    const res = makeMockRes()
    try {
      await getCollectionDetail(req as any, res as any, db as any)
      const colBase = `${base}/products/collections`
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        [
          'Edit button points to /products/collections/:id/edit',
          new RegExp(`href="${colBase}/${cid}/edit"`).test(res.body),
        ],
        [
          '"Collections" back link uses /products/collections',
          new RegExp(`href="${colBase}"[^>]*>[\\s\\S]*?Collections`).test(res.body),
        ],
        ['Collection title rendered', res.body.includes(title)],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /products/collections/${cid}`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products/collections/:id threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // ── PHASE 11: /products/collections/:id/edit (NEW handler) ────────
  phases.push(async () => {
    console.log('\n[phase 11] GET /products/collections/:id/edit (NEW edit form)')
    const firstCollection = await db
      .selectFrom('collections' as any)
      .select(['id', 'title', 'slug'] as any)
      .where('shop_id' as any, '=', store.id)
      .limit(1)
      .executeTakeFirst()

    if (!firstCollection) {
      console.log('[skip] No collections — skipping edit form phase')
      return true
    }

    const cid = (firstCollection as any).id
    const req = makeReq({
      params: { collectionId: cid },
      path: `/products/collections/${cid}/edit`,
    })
    const res = makeMockRes()
    try {
      await getEditCollection(req as any, res as any, db as any)
      const colBase = `${base}/products/collections`
      const checks: Array<[string, boolean]> = [
        ['status 200', res.statusCode === 200],
        ['non-empty body', res.body.length > 500],
        ['Edit form id="colEditForm"', /<form[^>]*id="colEditForm"/.test(res.body)],
        ['CSRF field present in edit form', /name="_csrf"/.test(res.body)],
        ['Title input present', /name="title"/.test(res.body)],
        ['Description textarea present', /name="description"/.test(res.body)],
        ['Slug input present', /name="slug"/.test(res.body)],
        ['Sort order select present', /name="sort_order"/.test(res.body)],
        ['Image URL input present', /name="image_url"/.test(res.body)],
        ['Published checkbox present', /name="published"/.test(res.body)],
        ['Save button present', /Save changes/.test(res.body)],
        ['Delete button present', /id="colDeleteBtn"/.test(res.body)],
        [
          'Edit form action posts to /update',
          new RegExp(`action="${colBase}/${cid}/update"`).test(res.body),
        ],
        ['Delete form id="colDeleteForm"', /<form[^>]*id="colDeleteForm"/.test(res.body)],
        [
          'Delete form action posts to /delete',
          new RegExp(`action="${colBase}/${cid}/delete"`).test(res.body),
        ],
        [
          'Cancel button returns to detail',
          new RegExp(`href="${colBase}/${cid}"`).test(res.body),
        ],
        ...deadLinkChecks(res.body, base),
      ]
      return runChecks(`GET /products/collections/${cid}/edit`, checks)
    } catch (err: any) {
      console.error(`[FAIL] GET /products/collections/:id/edit threw: ${err.message}`)
      console.error(err.stack)
      return false
    }
  })

  // Run all phases sequentially
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
  process.exit(0)
}

main().catch((err) => {
  console.error('[FAIL] Audit smoke test crashed:', err)
  process.exit(1)
})
