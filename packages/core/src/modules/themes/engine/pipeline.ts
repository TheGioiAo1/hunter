/**
 * Gbox Platform — Theme Render Pipeline
 *
 * Decision #1 Step 1.10 — The one public entry point for rendering a
 * Shopify-compatible page through the Gbox engine. Ties together
 * everything built in Steps 1.3–1.9 into a single async function:
 *
 *   renderPage(engine, {
 *     template: 'product',
 *     shop, customer, cart, request,
 *     pageDrop: { product, collection },
 *     csrfToken,
 *     formState,
 *     locale,
 *   })
 *     → { html, layoutUsed, meta, renderMs }
 *
 * What it does, in order:
 *
 *   1. Normalize the `template` arg to a logical path under
 *      `templates/` (so callers can pass `'product'` instead of
 *      `'templates/product.liquid'`).
 *   2. Load the template source via the engine's `TemplateLoader`.
 *   3. Build a `Context` with:
 *        - Top scope:    page-level drops (product, collection, …)
 *        - Environments: shop, customer, cart, request (+ locale),
 *                        csrf_token, form_state
 *        - Extra globals: whatever the caller passes in extraGlobals
 *   4. Parse + render the page template. This is where sections run,
 *      schemas/stylesheets/javascripts get captured into gboxMeta,
 *      and any `{% layout %}` tag mutates gboxLayout.
 *   5. Read the `gboxLayout` register to decide which layout file
 *      (if any) wraps the page:
 *        - `skipLayout: true`              → no layout (raw page)
 *        - `register.seen && name === null` → no layout (`{% layout none %}`)
 *        - `register.seen`                  → `layout/<name>.liquid`
 *        - else                             → `layout/<defaultLayout>.liquid`
 *                                             (default 'theme')
 *   6. Read `gboxMeta` register and build `content_for_header` —
 *      a concatenation of `<style data-gbox-section>` and
 *      `<script data-gbox-section>` blocks in render order.
 *   7. Push `{ content_for_layout, content_for_header, ... }` onto
 *      the same Context (not a spawn — we want to keep environments
 *      and any top-level assigns from the page template visible to
 *      the layout), then render the layout file.
 *   8. Pop the frame, return the final HTML + metadata.
 *
 * Design rationale:
 *
 *   - Why a function, not a class? The pipeline is stateless; every
 *     render is an independent call. A class would just add ceremony
 *     around function args.
 *
 *   - Why take the engine as an argument (not instantiate inside)?
 *     One engine instance should serve many renders — parse cache
 *     amortizes across requests. Callers (Step 1.14 storefront router)
 *     build one engine per theme deployment and hand it to every
 *     request handler.
 *
 *   - Why push content_for_* onto the EXISTING ctx instead of a
 *     fresh one? Three reasons:
 *       1. Environments (shop, customer, …) are already on the ctx
 *          — re-stuffing them on a new Context is error-prone.
 *       2. Top-level `{% assign %}` statements in the page template
 *          leak into `scopes[0]`; Shopify themes rely on the layout
 *          seeing these (e.g. `{% assign page_title = product.title %}`
 *          in the page, then `<title>{{ page_title }}</title>` in
 *          the layout). Spawning a new context would drop them.
 *       3. The gboxLayout + gboxMeta registers are already on ctx;
 *          sharing the ctx means layout-level meta ALSO lands in
 *          the same register, so the pipeline can capture it too
 *          (though we don't re-hoist it — see next note).
 *
 *   - Why meta hoist is page-only (NOT recursive through layout)?
 *     Simpler semantics, and Shopify layouts rarely contain their
 *     own `{% stylesheet %}` blocks in practice. `content_for_header`
 *     is computed BEFORE the layout renders, so anything the layout's
 *     own sections emit into `gboxMeta` is silently ignored by the
 *     hoist logic. Step 1.11's schema-settings pass can revisit this
 *     if a real theme needs it.
 *
 *   - Why missing templates/layouts throw? Because a 404 page is
 *     the router's job (Step 1.14), not the engine's. The engine is
 *     a pure function: in → HTML out or throw. The router catches
 *     the throw and renders whatever 404 template is configured.
 */

import { Context } from 'liquidjs'
import type { LiquidEngine } from './liquid.js'
import {
  GBOX_LAYOUT_REGISTER_KEY,
  type GboxLayoutRegister,
} from './tags/layout.js'
import {
  GBOX_META_REGISTER_KEY,
  type GboxMetaRegister,
} from './tags/meta-blocks.js'
import {
  GBOX_SECTION_INSTANCES_ENV_KEY,
  GBOX_SCHEMA_LOCALE_DICT_ENV_KEY,
  type GboxSchemaLocaleDictEnv,
  type GboxSectionInstancesEnv,
} from './tags/section.js'
import type { ResolvedThemeSettings } from './theme-config/index.js'
import {
  GBOX_PAGINATION_ENV_KEY,
  type GboxPaginationEnv,
  type PaginationInput,
} from './tags/paginate.js'
import type { SectionInstance } from './schema/types.js'
import { parseJsonTemplate } from './json-template/parser.js'
import { renderJsonTemplate } from './json-template/renderer.js'
import type { JsonTemplate } from './json-template/types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Caller-supplied request context for a single page render. Every
 * field is optional; the engine still produces HTML with missing
 * drops rendered as empty strings (thanks to `strictVariables: false`
 * in the factory).
 */
export interface RenderPageOptions {
  /**
   * Template to render. Accepts three forms:
   *   - `'product'`                    → `templates/product.liquid`
   *   - `'templates/product'`          → `templates/product.liquid`
   *   - `'templates/product.liquid'`   → as-is
   *   - `'templates/customers/login'`  → nested paths also work
   */
  template: string

  /**
   * Page-level drops — `product`, `collection`, `article`, etc.
   * Merged into the top scope frame so templates can write
   * `{{ product.title }}` directly.
   */
  pageDrop?: Record<string, unknown>

  /**
   * Shop drop. Exposes `{{ shop.name }}`, `{{ shop.id }}`,
   * `{{ shop.default_locale }}`, etc. Pushed onto `environments`
   * so the i18n filter (`{{ 'key' | t }}`) can read `shop.id`.
   */
  shop?: unknown

  /** Logged-in customer, or `undefined` for anonymous visitors. */
  customer?: unknown

  /** Cart drop. Rendered as `cart.item_count`, `cart.items[]`, etc. */
  cart?: unknown

  /**
   * Request metadata. Exposes `{{ request.path }}`, `{{ request.host }}`,
   * `{{ request.design_mode }}`, and `{{ request.locale }}`. The
   * pipeline merges `locale` into this object if supplied separately.
   */
  request?: {
    path?: string
    host?: string
    design_mode?: boolean
    locale?: string
    [key: string]: unknown
  }

  /**
   * Current page locale (`en`, `vi`, `en-CA`…). Merged into
   * `request.locale` so the i18n filter picks it up automatically.
   * When omitted, the i18n filter falls back to `shop.default_locale`.
   */
  locale?: string

  /**
   * CSRF token for form submission. Read by the `{% form %}` tag
   * from `ctx.environments.csrf_token`. When omitted, the form tag
   * skips the authenticity_token hidden input — dev/tests still
   * render, they just aren't session-bound.
   */
  csrfToken?: string

  /**
   * Per-form post-back state, keyed by form type:
   *
   *     {
   *       contact: {
   *         errors: ['email'],
   *         errors_messages: { email: 'must be present' },
   *         posted_successfully: false,
   *         email: 'bad@',
   *       }
   *     }
   *
   * The `{% form %}` tag reads this to populate the `form` drop
   * inside its body scope.
   */
  formState?: Record<string, unknown>

  /**
   * Arbitrary extra globals. Merged into the top scope frame AFTER
   * `pageDrop`, so callers can inject drops that neither pageDrop
   * nor a dedicated field covers (e.g. `blog`, `search_results`,
   * `canonical_url`, `theme.settings`). Last-write-wins on conflict.
   */
  extraGlobals?: Record<string, unknown>

  /**
   * Force skip the layout wrap. Used by JSON/AJAX endpoints and the
   * section-rendering API (Step 1.13) where the response is meant
   * to be pasted into a pre-rendered page. Overrides any
   * `{% layout %}` tag in the template.
   */
  skipLayout?: boolean

  /**
   * Layout to use when the template doesn't declare one. Defaults
   * to `'theme'`. Set this to a custom value for A/B tests, alt
   * layouts for specific routes, etc.
   */
  defaultLayout?: string

  /**
   * Render-time data for `{% section 'name' %}` instances, keyed by
   * SECTION NAME (the filename argument to the section tag, not a
   * dynamic id). Each entry supplies either `settings` overrides or
   * a `blocks` array — or both — which the section tag merges with
   * the schema defaults to produce the `section.*` drop.
   *
   * Example:
   *
   *     renderPage(engine, {
   *       template: 'index',
   *       sectionInstances: {
   *         hero: { settings: { heading: 'Welcome' } },
   *         carousel: {
   *           blocks: [
   *             { type: 'slide', settings: { title: 'Alpha' } },
   *             { type: 'slide', settings: { title: 'Beta' } },
   *           ],
   *         },
   *       },
   *     })
   *
   * Step 1.11 introduces this option. Step 1.12 will populate it
   * from Shopify JSON templates (`templates/index.json`) so callers
   * don't have to hand-wire it for every page.
   */
  sectionInstances?: Record<string, SectionInstance>

  /**
   * Per-expression pagination input for `{% paginate expr by N %}`
   * tags inside the page template. Keyed by the dotted path used in
   * the tag — e.g. `"collection.products"` for
   * `{% paginate collection.products by 12 %}`.
   *
   * Each entry supplies:
   *   - `page`  (1-based current page; defaults to 1)
   *   - `total` (total item count across all pages; defaults to the
   *              current expression's array length)
   *
   * When omitted, every paginate tag behaves as if `page=1` and
   * `total=iterable.length` — fine for tests and small collections
   * that fit in memory. Real stores inject paginate data from the
   * data layer so DB-backed collections don't load the whole table.
   */
  paginate?: Record<string, PaginationInput>

  /**
   * Resolved theme settings drop, exposed as `{{ settings.* }}` to
   * every template + section + snippet on the page. Built once per
   * request by the storefront router via `loadThemeSettings(loader)`
   * (Step 1.15) and re-used for the lifetime of the handler — settings
   * rarely change between deploys, so we don't re-read on every render.
   *
   * When omitted, the `settings` global is left unset and any
   * `{{ settings.foo }}` reference renders as an empty string (LiquidJS
   * `strictVariables: false` default). This keeps tests + brand-new
   * themes happy without forcing every caller to wire the loader.
   */
  themeSettings?: ResolvedThemeSettings

  /**
   * Per-locale schema-translation dictionary, used to resolve
   * `"label": "t:foo.bar"` references inside section + block schemas
   * at render time (Step 1.15d).
   *
   * Keys are flat dot-separated strings (`general.cart.title`); values
   * are the localized labels for the visitor's current locale. The
   * router builds this from `loadThemeLocales(loader).byLocale[locale].schema`
   * once per locale and threads it through.
   *
   * Schema strings are kept SEPARATE from the storefront I18nService —
   * a typo in a schema key never silently resolves against a
   * storefront key (and vice versa).
   */
  schemaLocaleDict?: GboxSchemaLocaleDictEnv
}

/**
 * Result bundle returned from `renderPage()`. `html` is what the
 * router sends to the browser; the other fields are for observability
 * (logging, metrics, theme editor preview mode).
 */
export interface RenderPageResult {
  /** Final HTML ready to ship to the browser. */
  html: string

  /** Layout name actually used, or `null` when layout was skipped. */
  layoutUsed: string | null

  /** Captured meta-block register at time of render. */
  meta: GboxMetaRegister

  /** Wall-clock render time in milliseconds. */
  renderMs: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Normalize a caller-supplied template identifier into a loader
 * logical path. Accepts three forms (see `RenderPageOptions.template`
 * doc).
 *
 * Internal; exported for tests only.
 */
export function normalizeTemplatePath(raw: string): string {
  if (!raw) {
    throw new Error('[gbox-engine] renderPage: template is required')
  }
  let p = raw.trim()
  // Strip leading slash so we always produce a relative logical path.
  if (p.startsWith('/')) p = p.slice(1)
  // Add `templates/` prefix if missing.
  if (!p.startsWith('templates/')) {
    p = 'templates/' + p
  }
  // Add `.liquid` extension if missing.
  if (!p.endsWith('.liquid')) {
    p += '.liquid'
  }
  return p
}

/**
 * Normalize a caller-supplied template identifier into a base path
 * (NO extension) + a friendly "stem" for diagnostic error messages.
 *
 * Step 1.12 dual-format resolution: the pipeline tries `<base>.json`
 * first, then falls back to `<base>.liquid`. Having the base path
 * cached once means both lookups go through the same normalization
 * rules (strip leading slash, add `templates/` prefix, etc.).
 *
 * Internal; exported for tests only.
 */
export function normalizeTemplateBase(raw: string): string {
  if (!raw) {
    throw new Error('[gbox-engine] renderPage: template is required')
  }
  let p = raw.trim()
  if (p.startsWith('/')) p = p.slice(1)
  if (!p.startsWith('templates/')) {
    p = 'templates/' + p
  }
  // Strip any known extension so the caller can pass
  // `templates/product`, `templates/product.json`, or
  // `templates/product.liquid` interchangeably.
  if (p.endsWith('.liquid')) p = p.slice(0, -'.liquid'.length)
  else if (p.endsWith('.json')) p = p.slice(0, -'.json'.length)
  return p
}

/**
 * Represents the result of looking up a page template — either a
 * Liquid source file or a Shopify-style JSON template descriptor.
 */
export type ResolvedTemplate =
  | { kind: 'liquid'; path: string; source: string }
  | { kind: 'json'; path: string; template: JsonTemplate }

/**
 * Try to load a page template from the engine loader. Prefers
 * `<base>.json` (Shopify modern format), falls back to
 * `<base>.liquid` (classic format). Throws when neither exists.
 *
 * Internal; exported for tests only.
 */
export async function resolvePageTemplate(
  engine: LiquidEngine,
  raw: string,
): Promise<ResolvedTemplate> {
  const base = normalizeTemplateBase(raw)
  const jsonPath = base + '.json'
  const liquidPath = base + '.liquid'

  // Prefer JSON — Shopify themes ship the modern format first.
  const jsonSource = await engine.loader.load(jsonPath)
  if (jsonSource !== null) {
    const template = parseJsonTemplate(jsonSource, jsonPath)
    return { kind: 'json', path: jsonPath, template }
  }

  // Fall back to classic Liquid.
  const liquidSource = await engine.loader.load(liquidPath)
  if (liquidSource !== null) {
    return { kind: 'liquid', path: liquidPath, source: liquidSource }
  }

  throw new Error(
    `[gbox-engine] template not found: ${base}.(json|liquid) (loader: ${engine.loader.name})`,
  )
}

/**
 * Build the `content_for_header` string from a captured meta register.
 * The hoisted blocks are wrapped in `data-gbox-section` marker attrs
 * so devtools / theme editor can attribute them back to specific
 * sections at inspection time.
 *
 * We keep stylesheet before javascript because CSS must parse before
 * the first script that reads computed styles (a common theme pattern).
 */
export function buildContentForHeader(meta: GboxMetaRegister): string {
  const parts: string[] = []
  if (meta.stylesheet && meta.stylesheet.length > 0) {
    for (const css of meta.stylesheet) {
      parts.push(`<style data-gbox-section>${css}</style>`)
    }
  }
  if (meta.javascript && meta.javascript.length > 0) {
    for (const js of meta.javascript) {
      parts.push(`<script data-gbox-section>${js}</script>`)
    }
  }
  return parts.join('\n')
}

/**
 * Decide which layout file (if any) wraps the page. Returns `null`
 * when no layout should be applied. See `RenderPageOptions.skipLayout`
 * + the Step 1.7 layout tag doc for the full precedence rules.
 *
 * Internal; exported for tests only.
 */
export function resolveLayoutName(
  layoutRegister: GboxLayoutRegister,
  opts: { skipLayout?: boolean; defaultLayout?: string },
): string | null {
  if (opts.skipLayout) return null
  if (layoutRegister.seen) {
    // `name === null` means `{% layout none %}` — explicit skip.
    return layoutRegister.name ?? null
  }
  return opts.defaultLayout ?? 'theme'
}

/**
 * Render a Shopify-compatible page through the Gbox engine. See file
 * header for the end-to-end flow diagram.
 *
 * Every `LiquidEngine` instance can be reused across many concurrent
 * `renderPage()` calls — LiquidJS's parse cache is process-global and
 * the pipeline never mutates the engine, so no locking is needed.
 */
export async function renderPage(
  engine: LiquidEngine,
  opts: RenderPageOptions,
): Promise<RenderPageResult> {
  const start = Date.now()

  // 1. Resolve + load the page template. Step 1.12 adds a dual-format
  //    lookup: prefer `templates/<name>.json` (modern Shopify format);
  //    fall back to `templates/<name>.liquid` (classic). Either flavor
  //    feeds into the same layout + meta + pagination pipeline below.
  const resolved = await resolvePageTemplate(engine, opts.template)
  const templatePath = resolved.path

  // 2. Build the render context.
  //    - Top scope frame: pageDrop + extraGlobals + settings
  //    - Environments:    shop/customer/cart/request/locale/csrf/formState
  const topScope: Record<string, unknown> = {
    ...(opts.pageDrop ?? {}),
    ...(opts.extraGlobals ?? {}),
  }
  // Theme settings drop — `{{ settings.* }}` reads from the top scope.
  // Wired in BEFORE Context construction so it lives on the same frame
  // as `pageDrop` and `extraGlobals`. Caller's `extraGlobals.settings`
  // (if any) wins over the engine-supplied one — last write here.
  if (opts.themeSettings !== undefined && topScope.settings === undefined) {
    topScope.settings = opts.themeSettings
  }
  const ctx = new Context(topScope, engine.liquid.options)

  // Stuff environment drops. LiquidJS's `Context.environments` is a
  // public field; we mutate it directly. The i18n filter reads
  // `shop` and `request.locale` from here; the form tag reads
  // `csrf_token` and `form_state`.
  //
  // We merge `locale` into `request.locale` so callers can pass it
  // as a top-level option without having to construct a request
  // object themselves.
  const env = ctx.environments as Record<string, unknown>
  env.shop = opts.shop
  env.customer = opts.customer
  env.cart = opts.cart
  const request = { ...(opts.request ?? {}) }
  if (opts.locale !== undefined) {
    request.locale = request.locale ?? opts.locale
  }
  env.request = request
  if (opts.csrfToken !== undefined) env.csrf_token = opts.csrfToken
  if (opts.formState !== undefined) env.form_state = opts.formState

  // Section instance data — the `{% section %}` tag reads this from
  // the environments map. We always write the key (even when empty)
  // so the tag can do a single lookup without worrying about absent
  // environment fields.
  if (opts.sectionInstances !== undefined) {
    env[GBOX_SECTION_INSTANCES_ENV_KEY] =
      opts.sectionInstances as GboxSectionInstancesEnv
  }

  // Schema translation dict — read by the `{% section %}` tag and
  // `renderSectionInstance` to resolve `t:foo.bar` references inside
  // section + block schemas at render time. Absent → no-op.
  if (opts.schemaLocaleDict !== undefined) {
    env[GBOX_SCHEMA_LOCALE_DICT_ENV_KEY] = opts.schemaLocaleDict
  }

  // Pagination input — the `{% paginate %}` tag reads this from the
  // environments map. Keyed by the dotted-path expression (e.g.
  // `collection.products`) so multiple paginate tags on a page can
  // coexist with independent state.
  if (opts.paginate !== undefined) {
    env[GBOX_PAGINATION_ENV_KEY] = opts.paginate as GboxPaginationEnv
  }

  // 3. Parse + render the page template. Side effects: populates
  //    gboxLayout + gboxMeta registers on `ctx`.
  //
  //    JSON templates run through `renderJsonTemplate`, which iterates
  //    `order[]` and dispatches each section through the same
  //    renderSectionInstance helper the `{% section %}` tag uses.
  //    Liquid templates take the classic parse-and-render path.
  let pageOutput: string
  if (resolved.kind === 'json') {
    pageOutput = await renderJsonTemplate(engine, resolved.template, ctx)
    // JSON templates can declare `layout: "alt"` or `layout: false`
    // at the top level. That value takes precedence over the engine
    // default but is still overridable by the caller's `skipLayout`.
    // We wire it into the layout register so the standard
    // `resolveLayoutName` precedence applies uniformly to both flavors.
    const jsonLayout = resolved.template.layout
    if (jsonLayout !== undefined) {
      const reg = ctx.getRegister(
        GBOX_LAYOUT_REGISTER_KEY,
      ) as GboxLayoutRegister
      reg.seen = true
      reg.name = jsonLayout // string | null (null === `layout: false`)
    }
  } else {
    const pageTemplates = engine.liquid.parse(resolved.source, templatePath)
    pageOutput = await engine.liquid.render(pageTemplates, ctx)
  }

  // 4. Read registers for layout + meta decisions.
  const layoutRegister = ctx.getRegister(
    GBOX_LAYOUT_REGISTER_KEY,
  ) as GboxLayoutRegister
  const metaRegister = ctx.getRegister(
    GBOX_META_REGISTER_KEY,
  ) as GboxMetaRegister

  const layoutName = resolveLayoutName(layoutRegister, {
    skipLayout: opts.skipLayout,
    defaultLayout: opts.defaultLayout,
  })

  // 5. No layout → return the raw page output.
  if (layoutName === null) {
    return {
      html: pageOutput,
      layoutUsed: null,
      meta: metaRegister,
      renderMs: Date.now() - start,
    }
  }

  // 6. Load the layout file. Throws when missing — no silent fallback
  //    because a configured layout that isn't on disk is almost always
  //    a deploy bug, not something we should paper over.
  const layoutPath = `layout/${layoutName}.liquid`
  const layoutSource = await engine.loader.load(layoutPath)
  if (layoutSource === null) {
    throw new Error(
      `[gbox-engine] layout not found: ${layoutPath} (loader: ${engine.loader.name})`,
    )
  }

  // 7. Build content_for_* drops and push them as a scope frame on
  //    the SAME Context. We keep the existing ctx so the layout sees
  //    everything the page saw: environments, top-level assigns,
  //    registers (so i18n filter + form tag + asset_url all work).
  const contentForHeader = buildContentForHeader(metaRegister)
  ctx.push({
    content_for_layout: pageOutput,
    content_for_header: contentForHeader,
  })

  let finalHtml: string
  try {
    const layoutTemplates = engine.liquid.parse(layoutSource, layoutPath)
    finalHtml = await engine.liquid.render(layoutTemplates, ctx)
  } finally {
    // Always pop the frame, even if layout render threw, so the ctx
    // is in a consistent state if the caller catches the error and
    // tries to render an error page on the same ctx (rare but safe).
    ctx.pop()
  }

  return {
    html: finalHtml,
    layoutUsed: layoutName,
    meta: metaRegister,
    renderMs: Date.now() - start,
  }
}
