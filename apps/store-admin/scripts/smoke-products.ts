/**
 * Smoke test for Products page fixes.
 * Directly invokes getProducts (Lenful list tab) and getProductDetail (edit
 * form) with a mocked req/res and asserts the rendered HTML contains:
 *
 *   Lenful tab (source=lenful):
 *     - .lf-list wrapper (NEW list layout, replacing .lf-grid)
 *     - .lf-list-head header row
 *     - NO .lf-grid (old grid killed)
 *     - NO .lf-card (old card killed)
 *     - per-row thumb + title + import button structure
 *
 *   Product detail / edit:
 *     - <form id="pdMainForm"> self-closed (empty)
 *     - form="pdMainForm" on title, body_html, seo_title, seo_description,
 *       slug, avail_listing, avail_sitemap, product_type, vendor,
 *       collection_ids, tags, template_suffix
 *     - Save button has form="pdMainForm" attribute
 *     - Delete button still has form="pdDeleteForm" attribute
 *
 * Both checks together catch the nested-form regression: if the main form
 * closed at the first </form> again, the form="pdMainForm" attrs would be
 * missing from later inputs.
 *
 * Usage: tsx scripts/smoke-products.ts [storeSlug]
 */

import { createDb, destroyDb } from '@gbox/db'
import { getProducts, getProductDetail } from '../src/pages/products.ts'

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

function lenfulChecks(body: string, statusCode: number): Array<[string, boolean]> {
  return [
    ['status 200', statusCode === 200],
    ['Lenful products tab active', /source-tab[^"]*active[^>]*>[\s\S]*?Lenful products/.test(body)],
    ['New .lf-list wrapper present', /class="lf-list"/.test(body)],
    ['List header row present', /class="lf-list-head"/.test(body)],
    ['List header has Product column', /lf-list-head-title[^>]*>Product</.test(body)],
    ['List header has Base price column', /lf-list-head-price[^>]*>Base price</.test(body)],
    ['OLD .lf-grid class gone', !/class="lf-grid"/.test(body)],
    ['OLD .lf-card class gone', !/class="lf-card"/.test(body)],
    ['OLD renderLenfulCard output gone', !/lf-card-thumb|lf-card-body|lf-card-import-btn/.test(body)],
  ]
}

function lenfulRowChecks(body: string): Array<[string, boolean]> {
  // Only applies when there's at least one catalog row rendered.
  return [
    ['Row thumbnail container', /class="lf-row-thumb"/.test(body)],
    ['Row body container', /class="lf-row-body"/.test(body)],
    ['Row title element', /class="lf-row-title"/.test(body)],
    ['Row meta row', /class="lf-row-meta"/.test(body)],
    ['POD badge', /class="lf-row-pod"/.test(body)],
    ['SKU cell', /class="lf-row-sku"/.test(body)],
    ['Price cell', /class="lf-row-price"/.test(body)],
    ['Action cell', /class="lf-row-action"/.test(body)],
    ['Import button', /class="lf-row-import-btn"/.test(body)],
    ['Import form points to /lenful/import', /action="[^"]*\/products\/lenful\/import"/.test(body)],
  ]
}

function editFormChecks(body: string, statusCode: number): Array<[string, boolean]> {
  // The critical assertions: every editable field must carry form="pdMainForm"
  // so it's wired to the self-closed outer form regardless of DOM position.
  return [
    ['status 200', statusCode === 200],
    ['Main form id="pdMainForm"', /<form id="pdMainForm"/.test(body)],
    ['Main form action points to /update', /id="pdMainForm"[^>]*action="[^"]*\/update"/.test(body)],
    ['Main form self-closed (empty)', /<form id="pdMainForm"[^>]*>[\s\S]{0,200}?<\/form>/.test(body)],
    ['Hidden _return=detail present', /name="_return" value="detail"/.test(body)],
    ['Title input wired to pdMainForm', /name="title" form="pdMainForm"/.test(body)],
    ['body_html wired to pdMainForm', /name="body_html" form="pdMainForm"/.test(body)],
    ['seo_title wired', /name="seo_title" form="pdMainForm"/.test(body)],
    ['seo_description wired', /name="seo_description" form="pdMainForm"/.test(body)],
    ['slug wired', /name="slug" form="pdMainForm"/.test(body)],
    ['avail_listing wired', /name="avail_listing" form="pdMainForm"/.test(body)],
    ['avail_sitemap wired', /name="avail_sitemap" form="pdMainForm"/.test(body)],
    ['product_type wired', /name="product_type" form="pdMainForm"/.test(body)],
    ['vendor wired', /name="vendor" form="pdMainForm"/.test(body)],
    ['collection_ids wired', /name="collection_ids" form="pdMainForm"/.test(body)],
    ['tags wired', /name="tags" form="pdMainForm"/.test(body)],
    ['template_suffix wired', /name="template_suffix" form="pdMainForm"/.test(body)],
    ['Save button attached to pdMainForm', /form="pdMainForm" class="btn btn-primary">Save/.test(body)],
    ['Delete button still on pdDeleteForm', /form="pdDeleteForm"[^>]*class="btn btn-danger">Delete product/.test(body)],
    ['Hidden pdDeleteForm present', /<form id="pdDeleteForm"/.test(body)],
  ]
}

async function main() {
  const storeSlug = process.argv[2] || 'gbox-test'

  console.log(`[smoke] Testing Products pages for store: ${storeSlug}`)
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

  const regularUser = {
    id: '00000000-0000-0000-0000-000000000000',
    name: 'Smoke Test',
    email: 'smoke@test.local',
    role: 'owner',
    storeRole: 'owner',
  }

  let failures = 0

  // ── PHASE 1: Lenful catalog tab (list layout) ─────────────────────
  console.log('\n[phase 1] Lenful catalog tab (source=lenful)')
  const req1: any = {
    params: { slug: storeSlug },
    query: { source: 'lenful' },
    originalUrl: `/admin/store/${storeSlug}/products?source=lenful`,
    store: store,
    storeUser: regularUser,
    theme: 'dark',
    csrfToken: 'smoke-test-csrf-token',
  }
  const res1 = makeMockRes()

  try {
    await getProducts(req1, res1 as any, db as any)
    const body = res1.body || ''
    const checks = lenfulChecks(body, res1.statusCode)
    const hasRows = /class="lf-row"/.test(body)
    const allChecks = hasRows ? [...checks, ...lenfulRowChecks(body)] : checks
    const allPass = allChecks.every(([, p]) => p)
    if (allPass) {
      console.log(
        `[ok]   Lenful tab rendered ${body.length} bytes (${allChecks.length} checks${hasRows ? ', rows present' : ', no rows — catalog empty'})`,
      )
    } else {
      failures++
      console.error(`[FAIL] Lenful tab status=${res1.statusCode} size=${body.length}`)
      for (const [name, pass] of allChecks) {
        console.error(`       ${pass ? '  ok ' : 'FAIL'}  ${name}`)
      }
    }
  } catch (err: any) {
    failures++
    console.error(`[FAIL] Lenful tab threw: ${err.message}`)
    console.error(err.stack)
  }

  // ── PHASE 2: product detail / edit form ───────────────────────────
  console.log('\n[phase 2] Product detail / edit form')
  const firstProduct = await db
    .selectFrom('products' as any)
    .select(['id', 'title', 'status'])
    .where('shop_id' as any, '=', store.id)
    .orderBy('created_at' as any, 'desc')
    .limit(1)
    .executeTakeFirst()

  if (!firstProduct) {
    console.log('[skip] No products in store — skipping edit-form phase')
  } else {
    console.log(
      `[ok]   Using product: ${(firstProduct as any).title} (${(firstProduct as any).status})`,
    )
    const req2: any = {
      params: { slug: storeSlug, productId: (firstProduct as any).id },
      query: {},
      originalUrl: `/admin/store/${storeSlug}/products/${(firstProduct as any).id}`,
      store: store,
      storeUser: regularUser,
      theme: 'dark',
      csrfToken: 'smoke-test-csrf-token',
    }
    const res2 = makeMockRes()

    try {
      await getProductDetail(req2, res2 as any, db as any)
      const body = res2.body || ''
      const checks = editFormChecks(body, res2.statusCode)
      const allPass = checks.every(([, p]) => p)
      if (allPass) {
        console.log(`[ok]   edit form rendered ${body.length} bytes (${checks.length} checks)`)
      } else {
        failures++
        console.error(`[FAIL] edit form status=${res2.statusCode} size=${body.length}`)
        for (const [name, pass] of checks) {
          console.error(`       ${pass ? '  ok ' : 'FAIL'}  ${name}`)
        }
      }
    } catch (err: any) {
      failures++
      console.error(`[FAIL] edit form threw: ${err.message}`)
      console.error(err.stack)
    }
  }

  await destroyDb()

  if (failures > 0) {
    console.error(`\n[FAIL] ${failures} check group(s) failed`)
    process.exit(1)
  }
  console.log(`\n[ok]   All checks passed`)
}

main().catch((err) => {
  console.error('[FAIL] Smoke test crashed:', err)
  process.exit(1)
})
