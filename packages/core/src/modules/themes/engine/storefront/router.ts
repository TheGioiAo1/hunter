/**
 * Gbox Platform — Storefront Router
 *
 * Decision #1 Step 1.14 — The framework-agnostic core of the new
 * storefront. A pure async function that takes a
 * `StorefrontRequestContext` + a handler config bag and returns a
 * `StorefrontResponse`. Express / Hono / Workers / unit tests all
 * funnel through this single entry point.
 *
 * Why pure (and not a class)?
 *
 *   - Each request is independent. The router holds no per-request
 *     state — every state lives on the inputs (datasource for data,
 *     engine for parsed templates, errorLogger for the rate buckets).
 *   - Pure functions are trivial to test: build a fake context, call
 *     the function, assert on the response. No mocking framework.
 *   - Adapters become 10-line shims instead of subclasses.
 *
 * What this file owns:
 *
 *   1. The 16-row Shopify-compatible storefront route table.
 *   2. `compileRoute()` — turns `/products/:handle` into a regex
 *      that captures `:handle` as a named param.
 *   3. `matchRoute()` — walks the table in order, returning the
 *      first match (with extracted params) or null.
 *   4. `handleStorefrontRequest()` — the public entry point.
 *      Orchestrates: locale → match → loader → render →
 *      response.
 *   5. `parseSectionsParam()` — splits the `?sections=a,b,c` query
 *      param and clamps to `maxSections`.
 *
 * What this file does NOT own:
 *
 *   - HTTP framework specifics (Express adapter is in
 *     `express-adapter.ts`).
 *   - Data fetching (lives behind `StorefrontDataSource`).
 *   - Template rendering (lives in `pipeline.ts` and
 *     `section-api.ts`).
 *   - Error logging policy (lives in `error-logger.ts`).
 */

import { renderPage } from '../pipeline.js'
import {
  renderSections,
  SectionRenderingError,
  DEFAULT_MAX_SECTIONS,
  type RenderSectionsResult,
} from '../section-api.js'
import type { StorefrontDataSource, DataSourceContext } from './datasource.js'
import {
  DEFAULT_LOCALE_CONFIG,
  negotiateLocale,
  type LocaleConfig,
} from './locale.js'
import {
  createDefaultErrorLogger,
  type ErrorLogger,
} from './error-logger.js'
import type {
  StorefrontHandlerOptions,
  StorefrontRequestContext,
  StorefrontResponse,
  StorefrontRoute,
  StorefrontThemeConfig,
  RouteLoaderResult,
} from './types.js'
import type { ThemeLocaleDict } from '../theme-config/index.js'

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

/**
 * The 16-row route table. Order matters — the router walks
 * top-to-bottom and returns the first match. More specific routes
 * (`/blogs/:handle/:article`) MUST come before less specific ones
 * (`/blogs/:handle`).
 *
 * Cross-checked against Shopify's storefront route docs:
 *   - https://shopify.dev/docs/storefronts/themes/architecture/templates
 *   - https://shopify.dev/docs/storefronts/themes/navigation-search/search
 *
 * Loaders return `null` to trigger 404 chaining; throws become 500s.
 */
export const STOREFRONT_ROUTES: StorefrontRoute[] = [
  // ---- 1. Index --------------------------------------------------------
  {
    name: 'index',
    pattern: '/',
    template: 'index',
    async loader(_params, ds, req) {
      const ctx = mkCtx(ds, req)
      const [shop, customer, cart, allCollections] = await Promise.all([
        ds.loadShop(ctx),
        ds.loadCustomerBySession(req.cookies['_session'], ctx),
        ds.loadCart(req.cookies['cart'], ctx),
        ds.listCollections(ctx),
      ])
      // Build a hash-like `collections` object keyed by handle so
      // sections can use `collections['frontpage']` or
      // `collections[section.settings.collection_handle]`.
      const collectionsMap: Record<string, unknown> = {}
      for (const c of allCollections) {
        const handle = (c as any).handle ?? (c as any).slug
        if (handle) {
          // Eagerly load products for each collection so
          // `collection.products` works inside sections.
          const { products } = await ds.loadCollectionProducts(
            (c as any).id,
            { page: 1, pageSize: 24 },
            ctx,
          )
          collectionsMap[handle] = { ...c, products }
        }
      }
      return {
        pageDrop: { shop, customer, cart, collections: collectionsMap },
      }
    },
  },

  // ---- 2. Product detail ----------------------------------------------
  {
    name: 'product',
    pattern: '/products/:handle',
    template: 'product',
    async loader(params, ds, req) {
      const ctx = mkCtx(ds, req)
      const product = await ds.loadProductByHandle(params.handle, ctx)
      if (!product) return null
      return {
        pageDrop: { product },
      }
    },
  },

  // ---- 3. Collection inside a tag (must precede /collections/:h) ------
  {
    name: 'collection-tagged',
    pattern: '/collections/:handle/:tag',
    template: 'collection',
    async loader(params, ds, req) {
      const ctx = mkCtx(ds, req)
      const collection = await ds.loadCollectionByHandle(params.handle, ctx)
      if (!collection) return null
      const page = parsePageArgs(req.query)
      const { products, total } = await ds.loadCollectionProducts(
        collection.id,
        page,
        ctx,
        params.tag,
      )
      return {
        pageDrop: {
          collection: { ...collection, current_tag: params.tag },
          products,
        },
        paginate: {
          'collection.products': { page: page.page, total },
        },
      }
    },
  },

  // ---- 4. Collection detail -------------------------------------------
  {
    name: 'collection',
    pattern: '/collections/:handle',
    template: 'collection',
    async loader(params, ds, req) {
      const ctx = mkCtx(ds, req)
      const collection = await ds.loadCollectionByHandle(params.handle, ctx)
      if (!collection) return null
      const page = parsePageArgs(req.query)
      const { products, total } = await ds.loadCollectionProducts(
        collection.id,
        page,
        ctx,
      )
      return {
        pageDrop: { collection, products },
        paginate: {
          'collection.products': { page: page.page, total },
        },
      }
    },
  },

  // ---- 5. Collections index --------------------------------------------
  {
    name: 'collections-index',
    pattern: '/collections',
    template: 'list-collections',
    async loader(_params, ds, req) {
      const ctx = mkCtx(ds, req)
      const collections = await ds.listCollections(ctx)
      return {
        pageDrop: { collections },
      }
    },
  },

  // ---- 6. Article (must precede /blogs/:handle/tagged/:tag check) ----
  // Order: /blogs/:handle/tagged/:tag -> /blogs/:handle/:article -> /blogs/:handle
  {
    name: 'blog-tagged',
    pattern: '/blogs/:handle/tagged/:tag',
    template: 'blog',
    async loader(params, ds, req) {
      const ctx = mkCtx(ds, req)
      const blog = await ds.loadBlogByHandle(params.handle, ctx)
      if (!blog) return null
      const page = parsePageArgs(req.query)
      const { articles, total } = await ds.loadBlogArticles(
        blog.id,
        page,
        ctx,
        params.tag,
      )
      return {
        pageDrop: {
          blog: { ...blog, current_tag: params.tag },
          articles,
        },
        paginate: {
          'blog.articles': { page: page.page, total },
        },
      }
    },
  },

  // ---- 7. Article -----------------------------------------------------
  {
    name: 'article',
    pattern: '/blogs/:handle/:article',
    template: 'article',
    async loader(params, ds, req) {
      const ctx = mkCtx(ds, req)
      const article = await ds.loadArticleByHandles(
        params.handle,
        params.article,
        ctx,
      )
      if (!article) return null
      const blog = await ds.loadBlogByHandle(params.handle, ctx)
      return {
        pageDrop: { article, blog },
      }
    },
  },

  // ---- 8. Blog detail -------------------------------------------------
  {
    name: 'blog',
    pattern: '/blogs/:handle',
    template: 'blog',
    async loader(params, ds, req) {
      const ctx = mkCtx(ds, req)
      const blog = await ds.loadBlogByHandle(params.handle, ctx)
      if (!blog) return null
      const page = parsePageArgs(req.query)
      const { articles, total } = await ds.loadBlogArticles(
        blog.id,
        page,
        ctx,
      )
      return {
        pageDrop: { blog, articles },
        paginate: {
          'blog.articles': { page: page.page, total },
        },
      }
    },
  },

  // ---- 9. Page --------------------------------------------------------
  // Template can be `templates/page.<handle>.liquid` if it exists,
  // else falls back to `templates/page.liquid`. We do that lookup
  // inside the `template` function so the engine layer doesn't have
  // to know about Shopify's per-handle template suffix convention.
  {
    name: 'page',
    pattern: '/pages/:handle',
    template: async (params, ds, req) => {
      // Always render the page template; the engine doesn't currently
      // probe for `page.<handle>.liquid` so we hand back the base name
      // and rely on the loader for the data. (Per-handle suffix
      // resolution is a future step.)
      void params
      void ds
      void req
      return 'page'
    },
    async loader(params, ds, req) {
      const ctx = mkCtx(ds, req)
      const page = await ds.loadPageByHandle(params.handle, ctx)
      if (!page) return null
      return {
        pageDrop: { page },
      }
    },
  },

  // ---- 10. Policy ------------------------------------------------------
  {
    name: 'policy',
    pattern: '/policies/:handle',
    template: 'page.policy',
    async loader(params, ds, req) {
      const ctx = mkCtx(ds, req)
      const policy = await ds.loadPolicyByHandle(params.handle, ctx)
      if (!policy) return null
      return {
        pageDrop: { policy, page: policy },
      }
    },
  },

  // ---- 11. Cart -------------------------------------------------------
  {
    name: 'cart',
    pattern: '/cart',
    template: 'cart',
    async loader(_params, ds, req) {
      const ctx = mkCtx(ds, req)
      const cart = await ds.loadCart(req.cookies['cart'], ctx)
      return {
        pageDrop: { cart },
      }
    },
  },

  // ---- 12. Search ------------------------------------------------------
  {
    name: 'search',
    pattern: '/search',
    template: 'search',
    async loader(_params, ds, req) {
      const ctx = mkCtx(ds, req)
      const terms = req.query['q'] ?? ''
      const page = parsePageArgs(req.query)
      const search = await ds.runSearch(terms, page, ctx)
      return {
        pageDrop: { search },
        paginate: {
          'search.results': { page: page.page, total: search.results_count },
        },
      }
    },
  },

  // ---- 13. Account login (placeholder) --------------------------------
  {
    name: 'account-login',
    pattern: '/account/login',
    template: 'customers/login',
    async loader() {
      return { pageDrop: {} }
    },
  },

  // ---- 14. Account index (placeholder) --------------------------------
  {
    name: 'account',
    pattern: '/account',
    template: 'customers/account',
    async loader(_params, ds, req) {
      const ctx = mkCtx(ds, req)
      const customer = await ds.loadCustomerBySession(
        req.cookies['_session'],
        ctx,
      )
      if (!customer) return null
      return { pageDrop: { customer } }
    },
  },

  // ---- 15. Password gate (pre-launch) ---------------------------------
  {
    name: 'password',
    pattern: '/password',
    template: 'password',
    async loader() {
      return { pageDrop: {} }
    },
  },

  // ---- 16. Gift card by id --------------------------------------------
  {
    name: 'gift-card',
    pattern: '/gift_cards/:id',
    template: 'gift_card',
    async loader(params, ds, req) {
      const ctx = mkCtx(ds, req)
      const giftCard = await ds.loadGiftCardById(params.id, ctx)
      if (!giftCard) return null
      return {
        pageDrop: { gift_card: giftCard },
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Compiled patterns
// ---------------------------------------------------------------------------

/** Result of compiling a route's `pattern` field. */
export interface CompiledRoute {
  route: StorefrontRoute
  regex: RegExp
  paramNames: string[]
}

/**
 * Compile a `:param`-style pattern into a regex with named capture
 * groups. Anchored at both ends so partial matches don't sneak in.
 *
 * Strategy:
 *   - `/products/:handle` → `^/products/([^/]+)$` with paramNames
 *     `['handle']`.
 *   - `:` is the only metachar; everything else is literal-escaped.
 */
export function compileRoute(route: StorefrontRoute): CompiledRoute {
  const paramNames: string[] = []
  const escaped = route.pattern.replace(
    // Match literal segments and `:param` placeholders.
    /(:[A-Za-z_][A-Za-z0-9_]*)|([^:]+)/g,
    (_match, paramExpr, literal) => {
      if (paramExpr) {
        paramNames.push(paramExpr.slice(1)) // strip leading colon
        return '([^/]+)'
      }
      // Escape regex special chars in literal segments.
      return (literal as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    },
  )
  return {
    route,
    regex: new RegExp(`^${escaped}$`),
    paramNames,
  }
}

/**
 * Compile every row in the table once at module load. The table is
 * static so this happens exactly once per process.
 */
export const COMPILED_ROUTES: CompiledRoute[] =
  STOREFRONT_ROUTES.map(compileRoute)

/**
 * Walk the compiled routes and return the first match, or null. The
 * returned `params` map keys are the param names from the pattern.
 */
export function matchRoute(path: string): {
  compiled: CompiledRoute
  params: Record<string, string>
} | null {
  for (const compiled of COMPILED_ROUTES) {
    const m = compiled.regex.exec(path)
    if (!m) continue
    const params: Record<string, string> = {}
    compiled.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? '')
    })
    return { compiled, params }
  }
  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a `DataSourceContext` from the request. */
function mkCtx(
  ds: StorefrontDataSource,
  req: StorefrontRequestContext,
): DataSourceContext {
  return {
    shopId: req.shopId ?? ds.defaultShopId(),
    locale: req.headers['x-gbox-locale'] ?? 'en',
  }
}

/** Parse `?page=N&page_size=M` from the query, with sane defaults. */
function parsePageArgs(query: Record<string, string>): {
  page: number
  pageSize: number
} {
  const page = clampInt(query['page'], 1, 1, 1_000_000)
  const pageSize = clampInt(query['page_size'], 50, 1, 250)
  return { page, pageSize }
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Pick the right schema-translation dictionary for the negotiated
 * locale from a `StorefrontThemeConfig`. Falls back through the
 * `defaultSchemaLocale` and finally to `undefined` (no dict → `t:`
 * references render as bare keys, matching Shopify's broken-ref
 * behavior).
 *
 * Exported for tests.
 */
export function pickSchemaLocaleDict(
  themeConfig: StorefrontThemeConfig | undefined,
  locale: string,
): ThemeLocaleDict | undefined {
  if (!themeConfig?.schemaLocales) return undefined
  const direct = themeConfig.schemaLocales[locale]
  if (direct) return direct
  // Try base language (`en` for `en-CA`).
  const dash = locale.indexOf('-')
  if (dash > 0) {
    const base = locale.slice(0, dash)
    const baseDict = themeConfig.schemaLocales[base]
    if (baseDict) return baseDict
  }
  // Fall back to the configured default locale.
  if (themeConfig.defaultSchemaLocale) {
    const def = themeConfig.schemaLocales[themeConfig.defaultSchemaLocale]
    if (def) return def
  }
  return undefined
}

/**
 * Parse the `?sections=` query param into a deduped, length-clamped
 * array. Returns `null` when the param is absent — the router uses
 * that to choose the full-page render path.
 *
 * `maxSections <= 0` disables the cap (dev only).
 */
export function parseSectionsParam(
  raw: string | undefined,
  maxSections: number,
): string[] | null {
  if (raw === undefined || raw === '') return null
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  // Dedupe preserving first-seen order.
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  if (out.length === 0) return null
  if (maxSections > 0 && out.length > maxSections) {
    return out.slice(0, maxSections)
  }
  return out
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * The pure router function. Every framework adapter (Express, Hono,
 * Workers, tests) calls this with a normalized request context and
 * the handler options bag.
 *
 * Lifecycle of a request:
 *
 *   1. Method check — only GET is supported (POST / forms route
 *      through dedicated handlers in a future step). Anything else
 *      becomes 405.
 *   2. Locale negotiation — strip URL prefix, parse Accept-Language,
 *      fall back to shop default. Surfaces `request.locale` into
 *      every drop and `?sections=` requests.
 *   3. Route match — walk the compiled table; 404 on miss.
 *   4. Loader call — get `RouteLoaderResult` (or null → 404).
 *   5. Section API branch — if `?sections=` is set, dispatch through
 *      `renderSections` and return JSON. Else go to 6.
 *   6. Render branch — call `renderPage` with the loader result and
 *      return HTML.
 *   7. Error handling — any throw becomes a 500 with the error
 *      logged via the rate-limited `errorLogger`.
 *
 * Returns a `StorefrontResponse` with `body` always a string. Adapters
 * convert to native response types.
 */
export async function handleStorefrontRequest(
  opts: StorefrontHandlerOptions,
  req: StorefrontRequestContext,
): Promise<StorefrontResponse> {
  const locales: LocaleConfig = opts.locales ?? DEFAULT_LOCALE_CONFIG
  const errorLogger: ErrorLogger =
    opts.errorLogger ?? createDefaultErrorLogger()
  const maxSections = opts.maxSections ?? DEFAULT_MAX_SECTIONS
  const defaultLayout = opts.defaultLayout ?? 'theme'

  // ---- 1. Method check --------------------------------------------------
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return {
      status: 405,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        allow: 'GET, HEAD',
      },
      body: 'Method Not Allowed',
    }
  }

  // ---- 2. Locale negotiation -------------------------------------------
  const { locale, strippedPath } = negotiateLocale(
    req.path,
    req.headers['accept-language'],
    locales,
  )

  // ---- 3. Match the route ----------------------------------------------
  const matched = matchRoute(strippedPath)
  if (!matched) {
    return await render404(opts, req, locale)
  }

  const ds = opts.datasource
  const ctx: DataSourceContext = {
    shopId: req.shopId ?? ds.defaultShopId(),
    locale,
  }

  // We need shop/customer/cart on every render — fetch them once and
  // pass into both branches. Loader-supplied page drops override
  // these on key conflict (per-route customization).
  let shop: unknown
  let customer: unknown
  let cart: unknown
  let loaderResult: RouteLoaderResult | null
  try {
    ;[shop, customer, cart, loaderResult] = await Promise.all([
      ds.loadShop(ctx),
      ds.loadCustomerBySession(req.cookies['_session'], ctx),
      ds.loadCart(req.cookies['cart'], ctx),
      matched.compiled.route.loader(matched.params, ds, req),
    ])
  } catch (err) {
    return await render500(opts, req, errorLogger, err, locale)
  }

  // Loader returned null → 404 (record exists in template, but the
  // requested handle doesn't exist).
  if (loaderResult === null) {
    return await render404(opts, req, locale)
  }

  // ---- 4. Resolve the template name ------------------------------------
  let templateName: string
  try {
    if (typeof matched.compiled.route.template === 'function') {
      templateName = await matched.compiled.route.template(
        matched.params,
        ds,
        req,
      )
    } else {
      templateName = matched.compiled.route.template
    }
    // Loader can override.
    if (loaderResult.template) templateName = loaderResult.template
  } catch (err) {
    return await render500(opts, req, errorLogger, err, locale)
  }

  // ---- 5. Sections API branch ------------------------------------------
  const schemaLocaleDict = pickSchemaLocaleDict(opts.themeConfig, locale)
  const themeSettings = opts.themeConfig?.settings
  const sectionIds = parseSectionsParam(req.query['sections'], maxSections)
  if (sectionIds) {
    try {
      const result = await renderSections(opts.engine, {
        template: templateName,
        sectionIds,
        maxSections,
        pageDrop: loaderResult.pageDrop,
        shop,
        customer,
        cart,
        request: requestDropFor(req, locale),
        locale,
        sectionInstances: loaderResult.sectionInstances,
        paginate: loaderResult.paginate,
        themeSettings,
        schemaLocaleDict,
      })
      return sectionsApiResponse(result)
    } catch (err) {
      // Whole-batch failure (template missing, too many ids, etc.).
      // Per-section failures live in `result.errors` and went through
      // the success path above.
      if (err instanceof SectionRenderingError) {
        return sectionsApiErrorResponse(err)
      }
      return await render500(opts, req, errorLogger, err, locale)
    }
  }

  // ---- 6. Full-page render branch --------------------------------------
  try {
    const rendered = await renderPage(opts.engine, {
      template: templateName,
      pageDrop: loaderResult.pageDrop,
      shop,
      customer,
      cart,
      request: requestDropFor(req, locale),
      locale,
      defaultLayout,
      sectionInstances: loaderResult.sectionInstances,
      paginate: loaderResult.paginate,
      themeSettings,
      schemaLocaleDict,
    })
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-language': locale,
      },
      body: rendered.html,
    }
  } catch (err) {
    return await render500(opts, req, errorLogger, err, locale)
  }
}

// ---------------------------------------------------------------------------
// Error / 404 paths
// ---------------------------------------------------------------------------

/**
 * Render the 404 template. Tries `templates/404.(json|liquid)` and
 * falls back to a hard-coded plain-text body if even that template
 * is missing (so a broken theme still produces a meaningful response
 * instead of an infinite recursion).
 */
async function render404(
  opts: StorefrontHandlerOptions,
  req: StorefrontRequestContext,
  locale: string,
): Promise<StorefrontResponse> {
  try {
    const ctx: DataSourceContext = {
      shopId: req.shopId ?? opts.datasource.defaultShopId(),
      locale,
    }
    const [shop, customer, cart] = await Promise.all([
      opts.datasource.loadShop(ctx),
      opts.datasource.loadCustomerBySession(req.cookies['_session'], ctx),
      opts.datasource.loadCart(req.cookies['cart'], ctx),
    ])
    const rendered = await renderPage(opts.engine, {
      template: '404',
      shop,
      customer,
      cart,
      request: requestDropFor(req, locale),
      locale,
      defaultLayout: opts.defaultLayout ?? 'theme',
      themeSettings: opts.themeConfig?.settings,
      schemaLocaleDict: pickSchemaLocaleDict(opts.themeConfig, locale),
    })
    return {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-language': locale,
      },
      body: rendered.html,
    }
  } catch {
    // Theme has no 404 template (or it threw). Return a plain
    // fallback so the visitor sees SOMETHING and the operator gets
    // a clear signal in the logs.
    return {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Not Found',
    }
  }
}

/**
 * Render the 500 template. Logs the error through the rate-limited
 * logger first (so a flapping bug doesn't fill Sentry), then tries
 * `templates/500.(json|liquid)`. Falls back to plain text on a double
 * failure.
 */
async function render500(
  opts: StorefrontHandlerOptions,
  req: StorefrontRequestContext,
  errorLogger: ErrorLogger,
  err: unknown,
  locale: string,
): Promise<StorefrontResponse> {
  const error = err instanceof Error ? err : new Error(String(err))
  errorLogger.report({
    error,
    status: 500,
    path: req.path,
    method: req.method,
    shopId: req.shopId,
  })
  try {
    const ctx: DataSourceContext = {
      shopId: req.shopId ?? opts.datasource.defaultShopId(),
      locale,
    }
    const [shop, customer, cart] = await Promise.all([
      opts.datasource.loadShop(ctx),
      opts.datasource.loadCustomerBySession(req.cookies['_session'], ctx),
      opts.datasource.loadCart(req.cookies['cart'], ctx),
    ])
    const rendered = await renderPage(opts.engine, {
      template: '500',
      shop,
      customer,
      cart,
      request: requestDropFor(req, locale),
      locale,
      defaultLayout: opts.defaultLayout ?? 'theme',
      extraGlobals: { error_message: error.message },
      themeSettings: opts.themeConfig?.settings,
      schemaLocaleDict: pickSchemaLocaleDict(opts.themeConfig, locale),
    })
    return {
      status: 500,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-language': locale,
      },
      body: rendered.html,
    }
  } catch {
    return {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Internal Server Error',
    }
  }
}

/**
 * Build the `request` drop passed into `renderPage` /
 * `renderSections`. Bundles the locale, host, design_mode, and the
 * stripped path so templates can render canonical URLs from
 * `{{ request.path }}`.
 */
function requestDropFor(
  req: StorefrontRequestContext,
  locale: string,
): RouteLoaderRequest {
  return {
    path: req.path,
    host: req.host ?? '',
    design_mode: req.designMode ?? false,
    locale,
  }
}

/**
 * Shape of the `request` drop. Kept local — the public schema lives
 * in the templates, not in TS types.
 */
interface RouteLoaderRequest {
  [key: string]: unknown
  path: string
  host: string
  design_mode: boolean
  locale: string
}

// ---------------------------------------------------------------------------
// Section API responses
// ---------------------------------------------------------------------------

/**
 * Build the JSON response for a successful (or partially successful)
 * `?sections=` request. Mirrors Shopify's response shape:
 *
 *   { "header": "<header>...</header>", "main-product": "..." }
 *
 * Errors are surfaced under a top-level `errors` key matching the
 * resolver's per-id error map. Status is always 200 — even on
 * partial failure — because the visitor's page is still usable.
 */
function sectionsApiResponse(result: RenderSectionsResult): StorefrontResponse {
  // Shopify returns a flat map of id → html. We add `__errors` (with
  // a leading underscore so it can't collide with a real section id)
  // when partial failures occurred. Callers can ignore it on the fast
  // path or surface it to ops dashboards.
  const body: Record<string, unknown> = { ...result.sections }
  if (result.errors) body.__errors = result.errors
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

/**
 * Build the JSON response for a whole-batch section API failure
 * (template missing, too-many ids, empty input). 4xx because the
 * caller has to fix something before retrying.
 */
function sectionsApiErrorResponse(
  err: SectionRenderingError,
): StorefrontResponse {
  const status =
    err.code === 'too_many_sections' || err.code === 'empty_section_ids'
      ? 400
      : 404
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: { code: err.code, message: err.message } }),
  }
}
