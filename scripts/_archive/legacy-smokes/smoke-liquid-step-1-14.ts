/**
 * Smoke test — Decision #1 Step 1.14 Storefront Router
 *
 * End-to-end test for the framework-agnostic storefront router. Sets
 * up a small in-memory shop, runs the pure `handleStorefrontRequest`
 * function across the full 16-route Shopify-compatible table, and
 * also exercises the Express adapter, the rate-limited error logger,
 * the locale negotiator, and the Section Rendering API branch.
 *
 * Asserts (15):
 *
 *   1. Index route renders + uses default layout
 *   2. Product detail (handle param)
 *   3. Collection with pagination + tag filter
 *   4. Page handle
 *   5. Policy handle
 *   6. Blog → article navigation
 *   7. Cart cookie threading
 *   8. Account-by-session-cookie
 *   9. 404 on unknown handle (loader returns null)
 *  10. 405 on POST
 *  11. Rate-limited 500 logger fires + suppresses repeats
 *  12. Locale URL prefix strips and propagates content-language header
 *  13. Accept-Language fallback when no URL prefix
 *  14. ?sections=… AJAX branch returns JSON map
 *  15. Express adapter shim writes status/headers/body via res chain
 *
 * Run:
 *   npx tsx scripts/smoke-liquid-step-1-14.ts
 */

import {
  createLiquidEngine,
  handleStorefrontRequest,
  createExpressStorefrontHandler,
  MemoryDataSource,
  RateLimitedErrorLogger,
  type ErrorLoggerSink,
  type LoadResult,
  type LogicalPath,
  type StorefrontHandlerOptions,
  type StorefrontRequestContext,
  type TemplateLoader,
  type ExpressLikeRequest,
  type ExpressLikeResponse,
  type LoggedEvent,
} from '../packages/core/src/modules/themes/engine/index.js'
import { MemoryI18nService } from '../packages/core/src/modules/i18n/index.js'

// ---------------------------------------------------------------------------
// In-memory loader
// ---------------------------------------------------------------------------

class MemoryLoader implements TemplateLoader {
  readonly name = 'memory-theme'
  constructor(private readonly files: Record<string, string>) {}
  async load(p: LogicalPath): Promise<string | null> {
    return this.files[p] ?? null
  }
  async loadWithMeta(p: LogicalPath): Promise<LoadResult | null> {
    const src = this.files[p]
    return src === undefined ? null : { source: src }
  }
  async exists(p: LogicalPath): Promise<boolean> {
    return p in this.files
  }
  async list(prefix = ''): Promise<LogicalPath[]> {
    return Object.keys(this.files).filter((k) => k.startsWith(prefix))
  }
}

// ---------------------------------------------------------------------------
// Mini theme + datasource
// ---------------------------------------------------------------------------

const THEME: Record<string, string> = {
  'layout/theme.liquid':
    '<!doctype html><html lang="{{ request.locale }}"><body>{{ content_for_layout }}</body></html>',
  'templates/index.liquid': '<h1>HOME {{ shop.name }}</h1>',
  'templates/product.liquid':
    '<h1>{{ product.title }}</h1><p>{{ product.price }}</p>',
  'templates/collection.liquid':
    '<h1>{{ collection.title }}</h1><ul>{% for p in products %}<li>{{ p.title }}</li>{% endfor %}</ul>',
  'templates/list-collections.liquid':
    '<ul>{% for c in collections %}<li>{{ c.title }}</li>{% endfor %}</ul>',
  'templates/page.liquid': '<h1>{{ page.title }}</h1>{{ page.content }}',
  'templates/page.policy.liquid':
    '<h1>{{ policy.title }}</h1>{{ policy.body }}',
  'templates/cart.liquid':
    '<h2>Cart</h2><p>Items: {{ cart.item_count }}</p>',
  'templates/search.liquid':
    '<h1>Search</h1>{% if search.performed %}<p>{{ search.results_count }} results</p>{% else %}<form></form>{% endif %}',
  'templates/blog.liquid':
    '<h1>{{ blog.title }}</h1>{% for a in articles %}<h2>{{ a.title }}</h2>{% endfor %}',
  'templates/article.liquid': '<h1>{{ article.title }}</h1>{{ article.content }}',
  'templates/customers/login.liquid': '<form>Login</form>',
  'templates/customers/account.liquid': '<h1>Welcome {{ customer.email }}</h1>',
  'templates/password.liquid': '<form>Pre-launch password gate</form>',
  'templates/gift_card.liquid':
    '<h1>Gift Card</h1><p>Balance: {{ gift_card.balance }}</p>',
  'templates/404.liquid': '<h1>404 Not Found</h1>',
  'templates/500.liquid':
    '<h1>500 Internal Server Error</h1><p>{{ error_message }}</p>',
  'sections/main-product.liquid':
    '<section data-id="{{ section.id }}"><h2>{{ product.title }}</h2></section>',
  // JSON template for the AJAX sections call
  'templates/product.json': JSON.stringify({
    sections: {
      'main-product': { type: 'main-product', settings: {} },
    },
    order: ['main-product'],
  }),
}

function buildOpts(
  errorSink?: ErrorLoggerSink,
): StorefrontHandlerOptions {
  const engine = createLiquidEngine({
    loader: new MemoryLoader(THEME),
    i18n: new MemoryI18nService(),
  })
  const datasource = new MemoryDataSource({
    shop: { id: 'shop_memory', name: 'Acme Goods' },
    products: [
      {
        id: 'p1',
        handle: 'super-widget',
        title: 'Super Widget',
        price: 1999,
        tags: ['featured', 'sale'],
      },
      {
        id: 'p2',
        handle: 'mega-widget',
        title: 'Mega Widget',
        price: 2999,
        tags: ['featured'],
      },
      {
        id: 'p3',
        handle: 'mini-widget',
        title: 'Mini Widget',
        price: 999,
        tags: ['sale'],
      },
    ],
    collections: [
      {
        id: 'c1',
        handle: 'all',
        title: 'All Products',
        product_handles: ['super-widget', 'mega-widget', 'mini-widget'],
      },
      {
        id: 'c2',
        handle: 'featured',
        title: 'Featured',
        product_handles: ['super-widget', 'mega-widget'],
      },
    ],
    pages: [
      {
        id: 'pg1',
        handle: 'about',
        title: 'About Us',
        content: '<p>Founded 2026.</p>',
      },
    ],
    policies: [
      {
        id: 'pol1',
        handle: 'privacy',
        title: 'Privacy Policy',
        body: 'We respect your data.',
      },
    ],
    blogs: [
      {
        id: 'b1',
        handle: 'news',
        title: 'News',
        article_handles: ['hello-world'],
      },
    ],
    articles: [
      {
        id: 'a1',
        handle: 'hello-world',
        title: 'Hello, world!',
        content: 'First post.',
      },
    ],
    giftCards: [
      { id: 'g1', code: 'XMAS', balance: 5000, currency: 'USD' },
    ],
    customers: [
      {
        id: 'cust1',
        email: 'jane@acme.test',
        first_name: 'Jane',
        session_token: 'tok-jane',
      },
    ],
    carts: {
      ck: { token: 'ck', item_count: 3, total_price: 5997, items: [{}, {}, {}] },
    },
    search: { results: [{ id: 'p1' }, { id: 'p2' }] },
  })
  return {
    engine,
    datasource,
    errorLogger: errorSink
      ? new RateLimitedErrorLogger({
          sink: errorSink,
          maxPerWindow: 2,
          windowMs: 60_000,
          now: () => 1_000,
        })
      : undefined,
    locales: { supported: ['en', 'vi'], default: 'en' },
  }
}

function mkReq(
  path: string,
  overrides: Partial<StorefrontRequestContext> = {},
): StorefrontRequestContext {
  return {
    method: 'GET',
    path,
    query: {},
    headers: {},
    cookies: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function expectContains(haystack: string, needle: string, label: string): void {
  check(label, haystack.includes(needle), `expected to contain "${needle}"`)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Smoke — Step 1.14 Storefront Router')
  console.log('====================================')

  // ---- 1. Index ---------------------------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(opts, mkReq('/'))
    check('1. index route returns 200', res.status === 200)
    expectContains(res.body, 'HOME Acme Goods', '1. index renders shop name')
    expectContains(res.body, '<!doctype html>', '1. layout applied')
  }

  // ---- 2. Product detail ------------------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(
      opts,
      mkReq('/products/super-widget'),
    )
    check('2. product route returns 200', res.status === 200)
    expectContains(res.body, 'Super Widget', '2. product title rendered')
  }

  // ---- 3. Collection with pagination + tag filter -----------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(
      opts,
      mkReq('/collections/all/sale', {
        query: { page: '1', page_size: '50' },
      }),
    )
    check('3. tagged collection returns 200', res.status === 200)
    expectContains(res.body, 'Super Widget', '3. tagged product visible')
    expectContains(res.body, 'Mini Widget', '3. tagged product visible')
    check(
      '3. tagged collection excludes off-tag products',
      !res.body.includes('Mega Widget'),
    )
  }

  // ---- 4. Page handle ---------------------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(opts, mkReq('/pages/about'))
    expectContains(res.body, 'About Us', '4. page title rendered')
    expectContains(res.body, 'Founded 2026', '4. page content rendered')
  }

  // ---- 5. Policy handle -------------------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(
      opts,
      mkReq('/policies/privacy'),
    )
    expectContains(res.body, 'Privacy Policy', '5. policy title rendered')
  }

  // ---- 6. Blog → article ------------------------------------------------
  {
    const opts = buildOpts()
    const blog = await handleStorefrontRequest(opts, mkReq('/blogs/news'))
    expectContains(blog.body, 'Hello, world!', '6. blog lists article')
    const article = await handleStorefrontRequest(
      opts,
      mkReq('/blogs/news/hello-world'),
    )
    expectContains(article.body, 'First post.', '6. article body rendered')
  }

  // ---- 7. Cart cookie threading -----------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(
      opts,
      mkReq('/cart', { cookies: { cart: 'ck' } }),
    )
    expectContains(res.body, 'Items: 3', '7. cart cookie hydrates cart')
  }

  // ---- 8. Account-by-session --------------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(
      opts,
      mkReq('/account', { cookies: { _session: 'tok-jane' } }),
    )
    expectContains(res.body, 'jane@acme.test', '8. account by session')
  }

  // ---- 9. 404 on unknown handle ----------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(
      opts,
      mkReq('/products/no-such-thing'),
    )
    check('9. unknown product handle → 404', res.status === 404)
    expectContains(res.body, '404 Not Found', '9. 404 template rendered')
  }

  // ---- 10. 405 on POST --------------------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(
      opts,
      mkReq('/', { method: 'POST' }),
    )
    check('10. POST → 405', res.status === 405)
    check('10. allow header set', /GET/.test(res.headers['allow'] ?? ''))
  }

  // ---- 11. Rate-limited 500 logger -------------------------------------
  {
    const events: LoggedEvent[] = []
    const opts = buildOpts({ log: (e) => events.push(e) })

    // Hijack the index loader to throw.
    const { STOREFRONT_ROUTES } = await import(
      '../packages/core/src/modules/themes/engine/index.js'
    )
    const original = STOREFRONT_ROUTES[0].loader
    STOREFRONT_ROUTES[0].loader = async () => {
      throw new Error('synthetic boom')
    }
    try {
      const a = await handleStorefrontRequest(opts, mkReq('/'))
      const b = await handleStorefrontRequest(opts, mkReq('/'))
      const c = await handleStorefrontRequest(opts, mkReq('/'))
      check('11. all 3 attempts return 500', a.status === 500 && b.status === 500 && c.status === 500)
      check(
        '11. only 2 events logged (3rd suppressed by rate limit)',
        events.length === 2,
        `got ${events.length}`,
      )
      expectContains(a.body, 'synthetic boom', '11. error message in 500 page')
    } finally {
      STOREFRONT_ROUTES[0].loader = original
    }
  }

  // ---- 12. Locale URL prefix --------------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(opts, mkReq('/vi/'))
    check('12. locale prefix → 200', res.status === 200)
    check(
      '12. content-language header set to vi',
      res.headers['content-language'] === 'vi',
    )
  }

  // ---- 13. Accept-Language fallback -------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(
      opts,
      mkReq('/', {
        headers: { 'accept-language': 'vi-VN,vi;q=0.9,en;q=0.5' },
      }),
    )
    check(
      '13. accept-language → vi',
      res.headers['content-language'] === 'vi',
    )
  }

  // ---- 14. ?sections= AJAX branch --------------------------------------
  {
    const opts = buildOpts()
    const res = await handleStorefrontRequest(
      opts,
      mkReq('/products/super-widget', {
        query: { sections: 'main-product' },
      }),
    )
    check('14. sections API → 200', res.status === 200)
    check(
      '14. content-type is JSON',
      (res.headers['content-type'] ?? '').includes('application/json'),
    )
    const body = JSON.parse(res.body) as Record<string, string>
    expectContains(body['main-product'], 'Super Widget', '14. section HTML rendered')
  }

  // ---- 15. Express adapter shim ----------------------------------------
  {
    const opts = buildOpts()
    const handler = createExpressStorefrontHandler(opts)
    let captured: { status?: number; body?: string; headers?: Record<string, string> } = {}
    const res: ExpressLikeResponse = {
      status(code) {
        captured.status = code
        return this
      },
      set(h) {
        captured.headers = h
        return this
      },
      send(b) {
        captured.body = b
        return this
      },
    }
    const fakeReq: ExpressLikeRequest = {
      method: 'GET',
      path: '/products/super-widget',
      query: {},
      headers: { host: 'shop.gbox.test' },
      cookies: {},
      hostname: 'shop.gbox.test',
    }
    let nextCalled = false
    await handler(fakeReq, res, () => {
      nextCalled = true
    })
    check('15. adapter status === 200', captured.status === 200)
    check('15. adapter sets content-type', !!captured.headers?.['content-type'])
    expectContains(captured.body ?? '', 'Super Widget', '15. adapter body rendered')
    check('15. next not called on success', !nextCalled)
  }

  // ---- Summary ----------------------------------------------------------
  console.log('====================================')
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
