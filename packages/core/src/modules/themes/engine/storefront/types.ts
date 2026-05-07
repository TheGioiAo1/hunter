/**
 * Gbox Platform — Storefront Router types
 *
 * Decision #1 Step 1.14 — Shared shapes for the storefront request /
 * response pipeline. Kept in one file so the router, datasource,
 * locale negotiator, error logger, and Express adapter can all
 * reference the same types without circular imports.
 *
 * Design goal: framework-agnostic. The pure
 * `handleStorefrontRequest` function in router.ts speaks
 * `StorefrontRequestContext` → `StorefrontResponse` so the same
 * code path can serve Express, Hono (Cloudflare Workers), Fastify,
 * or a unit test driver. Adapters convert framework-native types
 * to/from the shapes here.
 */

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic representation of an incoming HTTP request to
 * the storefront. The Express adapter (and any future Workers /
 * Hono adapter) builds this from native request types.
 *
 * Keep this minimal — only fields the router actually consumes.
 * Anything else is exposed via `headers` raw or pulled out by a
 * middleware before the request reaches the router.
 */
export interface StorefrontRequestContext {
  /** HTTP method (GET/POST/...). Router currently only handles GET. */
  method: string

  /**
   * URL path including locale prefix if any. The locale negotiator
   * strips the prefix during route resolution. Always starts with
   * `/`. Never includes the query string.
   *
   * Examples: `/`, `/products/foo`, `/vi/collections/all`.
   */
  path: string

  /**
   * Parsed query parameters as a flat string-map. Multi-value
   * params are collapsed to the first value (Shopify storefront
   * doesn't use array params for any documented route).
   */
  query: Record<string, string>

  /**
   * Request headers, lowercased keys. Used for `Accept-Language`
   * negotiation and a few cache-friendly headers.
   */
  headers: Record<string, string>

  /**
   * Parsed cookies, lowercased keys. The router reads `cart` and
   * `_session` (Shopify's cart token cookie name and our session
   * cookie name) for cart + customer lookup. All other cookies
   * pass through unchanged.
   */
  cookies: Record<string, string>

  /**
   * Host header (or X-Forwarded-Host when present). Surfaced into
   * `request.host` Liquid drop. Defaults to empty string when
   * absent — never throws.
   */
  host?: string

  /**
   * Whether the request is running in theme-editor preview mode.
   * Surfaced into `request.design_mode` Liquid drop. Adapters set
   * this from the `?design_mode=true` query param or a header,
   * depending on deployment.
   */
  designMode?: boolean

  /**
   * Optional shop id. Production multi-tenant deployments resolve
   * this from the host (DNS-based tenant routing); single-tenant
   * dev installs hardcode it. The datasource uses this to scope
   * loads (`loadProductByHandle(handle, { shopId })`).
   *
   * When omitted, the router falls back to the datasource's
   * `defaultShopId()` method.
   */
  shopId?: string
}

// ---------------------------------------------------------------------------
// Response side
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic HTTP response. Adapters translate to native
 * response types (`res.status().set().send()` for Express, `new
 * Response(body, { status, headers })` for Workers, etc.).
 *
 * Body is always a string — the router renders templates to
 * strings, never streams. If we add streaming later, we'll add a
 * `bodyStream` variant rather than overloading this type.
 */
export interface StorefrontResponse {
  status: number
  headers: Record<string, string>
  body: string
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

/**
 * One row in the storefront route table. The router walks this
 * array in order on every request, matching `pattern` against the
 * locale-stripped path.
 *
 * The `loader` callback is async because real datasource calls hit
 * the database. It returns:
 *   - `{ pageDrop, status }` to render the template
 *   - `null` to render 404 (template route exists but the data
 *     loader couldn't find the requested record — e.g. unknown
 *     product handle)
 *
 * Why a function instead of a config object? Because each route
 * needs different drops shaped differently — the product route
 * needs `{ product }`, the collection route needs `{ collection,
 * paginate }`, etc. A function gives each loader the freedom to
 * build whatever shape that route's templates expect.
 */
export interface StorefrontRoute {
  /** Human-readable name for logs and debugging. */
  name: string

  /**
   * Path pattern with `:param` style placeholders. Compiled to a
   * regex by `compileRoute()` in router.ts at module-load time.
   * Matches the FULL path (anchored at both ends).
   */
  pattern: string

  /**
   * Template name passed to `renderPage`. Can be a constant
   * (`'product'`) or a function that derives the template from the
   * matched params (used by `/pages/:handle` to look for
   * `templates/page.<handle>` first).
   */
  template:
    | string
    | ((
        params: Record<string, string>,
        ds: import('./datasource.js').StorefrontDataSource,
        req: StorefrontRequestContext,
      ) => Promise<string>)

  /**
   * Loader callback. Receives matched params + request context +
   * datasource and returns the page drop (data the templates
   * consume). Return `null` for 404.
   *
   * Loader implementations should NEVER throw on missing data —
   * return null instead. Throws are reserved for true errors
   * (database down, malformed data) and become 500s.
   */
  loader: (
    params: Record<string, string>,
    ds: import('./datasource.js').StorefrontDataSource,
    req: StorefrontRequestContext,
  ) => Promise<RouteLoaderResult | null>
}

/**
 * Result of a successful route loader call. The router merges
 * `pageDrop` into the rendered context, and uses `paginate` to
 * thread `{% paginate %}` data into the template (collection +
 * blog routes mostly).
 */
export interface RouteLoaderResult {
  /** Drops merged into the page-level scope (product, collection, …). */
  pageDrop: Record<string, unknown>

  /**
   * Optional pagination input passed to `renderPage`. Keyed by the
   * dotted-path expression in the `{% paginate %}` tag (e.g.
   * `"collection.products"`).
   */
  paginate?: Record<string, { page?: number; total?: number }>

  /**
   * Optional override for which template to render. Used by
   * special routes like `/products/:h.json` (no, those are out
   * of scope) or 404 chaining. When present, replaces the
   * route's `template` field.
   */
  template?: string

  /**
   * Optional sectionInstances override for the .liquid path. When
   * the route's template is a classic `.liquid` file (not JSON),
   * the loader can supply per-section instance data here.
   */
  sectionInstances?: Record<string, import('../schema/types.js').SectionInstance>
}

// ---------------------------------------------------------------------------
// Handler config
// ---------------------------------------------------------------------------

/**
 * Options bag passed once at handler construction. Contains every
 * dependency `handleStorefrontRequest` needs that's NOT request-
 * scoped: the engine, the datasource, the error logger, the locale
 * config, etc.
 */
export interface StorefrontHandlerOptions {
  /** Liquid engine — built once per theme deploy. */
  engine: import('../liquid.js').LiquidEngine

  /** Datasource — typically a DbDataSource in production. */
  datasource: import('./datasource.js').StorefrontDataSource

  /**
   * Error logger. Defaults to a no-op console logger; production
   * should pass a Sentry-backed sink.
   */
  errorLogger?: import('./error-logger.js').ErrorLogger

  /**
   * Locale config. Defaults to `{ supported: ['en'], default: 'en' }`.
   */
  locales?: import('./locale.js').LocaleConfig

  /**
   * Hard cap on `?sections=` count per AJAX call. Defaults to
   * `DEFAULT_MAX_SECTIONS` (5). Set higher for staging / dev.
   */
  maxSections?: number

  /**
   * Default layout name when a template doesn't declare one.
   * Forwarded to `renderPage`. Defaults to `'theme'`.
   */
  defaultLayout?: string

  /**
   * Pre-loaded theme config bundle (Decision #1 Step 1.15). Built once
   * per theme deploy by the host (typically via `prepareThemeConfig`)
   * and reused for the lifetime of the handler. Contains:
   *
   *   - `settings`     — resolved `{{ settings.* }}` drop
   *   - `schemaLocales` — per-locale schema-translation dicts for
   *                       `t:foo.bar` references inside section schemas
   *
   * When omitted the router renders without theme settings (the
   * `settings` global is unset, all `t:` references render as bare
   * keys). Useful for tests + brand-new themes that haven't
   * configured the customizer yet.
   */
  themeConfig?: StorefrontThemeConfig
}

/**
 * Pre-loaded theme config attached to the handler. Built once per
 * deploy via `prepareThemeConfig(loader)` (or hand-rolled in tests),
 * and reused on every request — settings rarely change between
 * deploys, so we don't re-read on every render.
 *
 * Storefront strings are NOT included here — they're fed into the
 * existing `I18nService` via `applyThemeLocalesToI18n`, which is the
 * caller's responsibility (per Q3: theme i18n flows through the
 * platform's existing i18n module, not a parallel bundle system).
 */
export interface StorefrontThemeConfig {
  /**
   * Resolved theme settings drop. Forwarded into every `renderPage`
   * + `renderSections` call as `themeSettings`.
   */
  settings?: import('../theme-config/index.js').ResolvedThemeSettings

  /**
   * Per-locale schema-translation dictionaries. Keyed by locale tag
   * (`'en'`, `'vi'`, …). The router picks the entry matching the
   * negotiated locale and forwards it as `schemaLocaleDict`.
   *
   * Missing locale → falls back to the dict for `defaultSchemaLocale`,
   * then to no dict at all (which renders `t:` references as bare
   * keys, matching Shopify's broken-reference behavior).
   */
  schemaLocales?: Record<
    string,
    import('../theme-config/index.js').ThemeLocaleDict
  >

  /**
   * Default locale to use when the negotiated locale isn't in
   * `schemaLocales`. Typically the locale marked `<locale>.default.json`
   * in the theme's `locales/` folder.
   */
  defaultSchemaLocale?: string | null
}
