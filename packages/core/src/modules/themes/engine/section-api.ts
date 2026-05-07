/**
 * Gbox Platform — Section Rendering API
 *
 * Decision #1 Step 1.13 — Shopify's Section Rendering API, ported to
 * the Gbox engine. A pure function that renders one or more sections
 * independently (no layout, no content_for_header hoist, no
 * all-or-nothing failure mode) so AJAX partial updates can refresh
 * just the slices of the page that changed.
 *
 * Motivating use cases (all direct Shopify theme patterns):
 *
 *   - Cart drawer: after `POST /cart/add.js`, re-render the
 *     `cart-drawer` section with the updated line items and swap
 *     the HTML in place.
 *   - Predictive search: re-render `predictive-search` on every
 *     keystroke with the new query results.
 *   - Collection filters: re-render `main-collection` when the
 *     visitor toggles a facet, without full page reload.
 *   - Header updates: re-render the `header` section after a
 *     currency switch.
 *
 * Shopify API shape (for reference):
 *
 *   GET /products/foo?sections=main-product,cart-drawer,header
 *   → 200 application/json
 *   {
 *     "main-product": "<section id=\"main-product\">...</section>",
 *     "cart-drawer":  "<div class=\"cart-drawer\">...</div>",
 *     "header":       "<header>...</header>"
 *   }
 *
 * This module is the engine-level primitive the storefront router
 * (Step 1.14) will call when it sees a `?sections=` query param. It
 * returns a plain object — the router wraps the HTTP response.
 *
 * Resolution rules (per owner decision, Step 1.13 mindmap):
 *
 *   - The caller supplies a `template` string just like `renderPage`.
 *     Section ids are resolved against that template:
 *       * `templates/<name>.json` → look up id in `sections` object;
 *         use type + settings + blocks from the JSON entry.
 *       * `templates/<name>.liquid` (fallback) → id IS the section
 *         filename; instance data comes from `sectionInstances` option
 *         (same env-based pattern `{% section %}` tag uses).
 *   - This ties every AJAX call to a specific page context. A cart
 *     drawer on the product page can expose different settings than
 *     the one on the collection page because they come from
 *     different JSON templates.
 *
 * Error model (partial-success):
 *
 *   - Each section renders independently. A failure in one section
 *     (missing file, missing id, render throw) is captured in the
 *     `errors[id]` field but does NOT prevent the other sections
 *     from rendering.
 *   - `errors` is only populated when at least one section fails;
 *     callers can check `result.errors != null` for the fast path.
 *   - Shopify returns 200 with partial HTML in this case; the router
 *     (Step 1.14) mirrors that.
 *
 * What this function does NOT do:
 *
 *   - It does NOT apply the layout. Sections are meant to be pasted
 *     into an already-rendered page, so wrapping them in
 *     `<!doctype html>...</html>` would corrupt the DOM.
 *   - It does NOT hoist `content_for_header`. AJAX refreshes don't
 *     rebuild `<head>`; any `{% stylesheet %}` or `{% javascript %}`
 *     the section emits is SILENTLY DROPPED (logged via the meta
 *     register for observability, but not concatenated into the
 *     response). The initial page load already injected those.
 *   - It does NOT call `renderPage`. The two paths are independent
 *     — sharing the pipeline would entangle layout selection logic
 *     with section-only rendering.
 *   - It does NOT read the `.liquid` page body for classic templates.
 *     It only needs the page's `sectionInstances` map (if any) to
 *     source instance data. The Liquid template body is irrelevant
 *     because Section Rendering API skips the page-level flow.
 */

import { Context } from 'liquidjs'
import type { LiquidEngine } from './liquid.js'
import {
  GBOX_SCHEMA_LOCALE_DICT_ENV_KEY,
  renderSectionInstance,
  type GboxSchemaLocaleDictEnv,
} from './tags/section.js'
import { parseJsonTemplate } from './json-template/parser.js'
import type { JsonTemplate } from './json-template/types.js'
import {
  GBOX_PAGINATION_ENV_KEY,
  type GboxPaginationEnv,
  type PaginationInput,
} from './tags/paginate.js'
import type { SectionInstance, SectionBlockInstance } from './schema/types.js'
import { normalizeTemplateBase } from './pipeline.js'
import type { ResolvedThemeSettings } from './theme-config/index.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Default upper bound on `sectionIds.length` per call. Matches
 * Shopify's documented limit. Callers can override via
 * `RenderSectionsOptions.maxSections` — 0 or negative means no limit
 * (dev mode only; enforce 1-5 in production via the router).
 */
export const DEFAULT_MAX_SECTIONS = 5

/**
 * Error codes surfaced via `SectionRenderingError` and the `errors`
 * field on `RenderSectionsResult`. String constants (not an enum) so
 * the router can map them to HTTP status codes with a switch and
 * theme debuggers can pattern-match them in logs.
 */
export type SectionRenderingErrorCode =
  | 'too_many_sections'
  | 'empty_section_ids'
  | 'template_not_found'
  | 'section_not_found'
  | 'section_render_failed'

/**
 * Error class for section rendering failures. Only thrown for whole-
 * request failures (too-many, empty input, missing template). Per-
 * section failures land in `result.errors[id]` as plain objects.
 */
export class SectionRenderingError extends Error {
  constructor(
    message: string,
    readonly code: SectionRenderingErrorCode,
  ) {
    super(message)
    this.name = 'SectionRenderingError'
  }
}

/**
 * Caller-supplied options for a single Section Rendering API call.
 *
 * Shares most fields with `RenderPageOptions` (shop, customer, cart,
 * request, locale, csrfToken, formState, extraGlobals, paginate,
 * sectionInstances). The two unique fields are `template` (required,
 * same semantics as `renderPage`) and `sectionIds` (the ids to
 * render).
 *
 * We don't reuse the `RenderPageOptions` type directly because the
 * section API rejects a few fields that don't make sense here
 * (skipLayout, defaultLayout — the section API never applies a
 * layout, period). Duplicating the common fields keeps the types
 * honest and self-documenting.
 */
export interface RenderSectionsOptions {
  /**
   * Template identifier — same forms as `renderPage.template`. Used
   * to resolve section ids:
   *   - `.json` template → id lookup in the `sections` object
   *   - `.liquid` template → id IS the section filename
   */
  template: string

  /**
   * Ids to render. 1..N items; default max 5 per Shopify. Duplicates
   * are allowed and produce independent entries in the result map,
   * but downstream callers should dedupe at the query parser.
   */
  sectionIds: string[]

  /**
   * Optional override for the per-call section limit. Defaults to
   * `DEFAULT_MAX_SECTIONS`. Set to 0 or a negative number to disable
   * the cap (dev/testing only — routers must enforce a ceiling).
   */
  maxSections?: number

  /**
   * Page-level drops. Merged into the top scope frame visible to
   * every section in the batch. Same semantics as
   * `RenderPageOptions.pageDrop`.
   */
  pageDrop?: Record<string, unknown>

  /** Shop drop. */
  shop?: unknown

  /** Customer drop (or undefined for anonymous requests). */
  customer?: unknown

  /** Cart drop. */
  cart?: unknown

  /**
   * Request metadata. `request.path` is used by the `{% paginate %}`
   * tag to build page URLs; callers should set this to the page URL
   * the AJAX call came from (NOT the section endpoint URL).
   */
  request?: {
    path?: string
    host?: string
    design_mode?: boolean
    locale?: string
    [key: string]: unknown
  }

  /** Locale override (merged into request.locale). */
  locale?: string

  /** CSRF token available to the `{% form %}` tag inside sections. */
  csrfToken?: string

  /** Per-form post-back state (rarely used by AJAX refreshes). */
  formState?: Record<string, unknown>

  /** Arbitrary extra globals merged into the top scope frame. */
  extraGlobals?: Record<string, unknown>

  /**
   * Fallback section instance data for classic `.liquid` templates.
   * IGNORED when the resolved template is JSON — the JSON entry is
   * authoritative in that case.
   */
  sectionInstances?: Record<string, SectionInstance>

  /**
   * Per-expression pagination data for `{% paginate %}` tags inside
   * any section in the batch. Same shape as
   * `RenderPageOptions.paginate`.
   */
  paginate?: Record<string, PaginationInput>

  /**
   * Resolved theme settings drop, exposed as `{{ settings.* }}` to
   * every section in the batch. Same semantics as
   * `RenderPageOptions.themeSettings` (Step 1.15).
   */
  themeSettings?: ResolvedThemeSettings

  /**
   * Per-locale schema-translation dictionary for `t:foo.bar`
   * references in section + block schemas. Same semantics as
   * `RenderPageOptions.schemaLocaleDict` (Step 1.15d).
   */
  schemaLocaleDict?: GboxSchemaLocaleDictEnv
}

/**
 * Result bundle returned from `renderSections`.
 */
export interface RenderSectionsResult {
  /**
   * Rendered HTML per input section id. Keys mirror the input
   * `sectionIds` array (with duplicates preserved as the same key —
   * the second render just overwrites the first; callers should
   * dedupe upstream).
   */
  sections: Record<string, string>

  /**
   * Per-id error entries, keyed by section id. Only present when at
   * least one section failed. Callers can check `result.errors != null`
   * for the fast path.
   */
  errors?: Record<
    string,
    { code: SectionRenderingErrorCode; message: string }
  >

  /**
   * Which template was resolved (so callers can log/debug).
   * `kind` distinguishes JSON vs classic Liquid lookup.
   */
  resolved: { kind: 'json' | 'liquid'; path: string }

  /** Wall-clock render time in milliseconds. */
  renderMs: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Render one or more sections independently (Shopify Section
 * Rendering API). See file header for the full behavioural contract.
 *
 * Every `LiquidEngine` instance can be reused across many concurrent
 * `renderSections` calls — LiquidJS's parse cache is process-global
 * and this function never mutates the engine.
 */
export async function renderSections(
  engine: LiquidEngine,
  opts: RenderSectionsOptions,
): Promise<RenderSectionsResult> {
  const start = Date.now()

  // --- 1. Validate input --------------------------------------------------
  if (!opts.sectionIds || opts.sectionIds.length === 0) {
    throw new SectionRenderingError(
      '[gbox-engine] renderSections: sectionIds must be a non-empty array',
      'empty_section_ids',
    )
  }
  const maxSections =
    opts.maxSections === undefined ? DEFAULT_MAX_SECTIONS : opts.maxSections
  if (maxSections > 0 && opts.sectionIds.length > maxSections) {
    throw new SectionRenderingError(
      `[gbox-engine] renderSections: too many sections requested (${opts.sectionIds.length} > ${maxSections})`,
      'too_many_sections',
    )
  }

  // --- 2. Resolve the page template (JSON preferred, .liquid fallback) ---
  const resolved = await resolveForSectionApi(engine, opts.template)

  // --- 3. Build a shared root Context for the batch -----------------------
  // Every section spawns a child context off this root via
  // renderSectionInstance, inheriting environments + registers.
  const topScope: Record<string, unknown> = {
    ...(opts.pageDrop ?? {}),
    ...(opts.extraGlobals ?? {}),
  }
  // Theme settings drop — `{{ settings.* }}` reads from the top scope.
  // Wired in BEFORE Context construction so it lives on the same
  // frame as `pageDrop` and `extraGlobals`. Caller's `extraGlobals.settings`
  // (if any) wins over the engine-supplied one.
  if (opts.themeSettings !== undefined && topScope.settings === undefined) {
    topScope.settings = opts.themeSettings
  }
  const ctx = new Context(topScope, engine.liquid.options)

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
  if (opts.paginate !== undefined) {
    env[GBOX_PAGINATION_ENV_KEY] = opts.paginate as GboxPaginationEnv
  }
  // Schema translation dict — read by the `{% section %}` tag and
  // `renderSectionInstance` for `t:foo.bar` references inside section
  // + block schemas. Absent → no-op.
  if (opts.schemaLocaleDict !== undefined) {
    env[GBOX_SCHEMA_LOCALE_DICT_ENV_KEY] = opts.schemaLocaleDict
  }

  // --- 4. Render each section independently ------------------------------
  const sections: Record<string, string> = {}
  const errors: Record<
    string,
    { code: SectionRenderingErrorCode; message: string }
  > = {}

  for (const id of opts.sectionIds) {
    try {
      const html = await renderOne(engine, ctx, resolved, id, opts)
      sections[id] = html
    } catch (err) {
      // Capture per-section failure without killing the batch.
      const message =
        err instanceof Error ? err.message : String(err)
      const code =
        err instanceof SectionRenderingError
          ? err.code
          : 'section_render_failed'
      errors[id] = { code, message }
    }
  }

  const hasErrors = Object.keys(errors).length > 0
  return {
    sections,
    ...(hasErrors ? { errors } : {}),
    resolved: { kind: resolved.kind, path: resolved.path },
    renderMs: Date.now() - start,
  }
}

// ---------------------------------------------------------------------------
// Internal — template resolution
// ---------------------------------------------------------------------------

/**
 * Internal template resolution for the Section Rendering API. Mirrors
 * `pipeline.resolvePageTemplate` but with one key difference: for
 * `.liquid` templates we do NOT need the body source — we only need
 * to know the template exists (so section ids can fall back to
 * filename-based lookup against `sectionInstances`).
 *
 * Exported for tests only.
 */
export async function resolveForSectionApi(
  engine: LiquidEngine,
  raw: string,
): Promise<ResolvedForSectionApi> {
  const base = normalizeTemplateBase(raw)
  const jsonPath = base + '.json'
  const liquidPath = base + '.liquid'

  // Prefer JSON — Shopify themes ship the modern format first.
  const jsonSource = await engine.loader.load(jsonPath)
  if (jsonSource !== null) {
    const template = parseJsonTemplate(jsonSource, jsonPath)
    return { kind: 'json', path: jsonPath, template }
  }

  // Classic .liquid — we just need to confirm it exists; we never
  // parse or render the body for section-only dispatch.
  const exists = await engine.loader.exists(liquidPath)
  if (exists) {
    return { kind: 'liquid', path: liquidPath }
  }

  throw new SectionRenderingError(
    `[gbox-engine] renderSections: template not found: ${base}.(json|liquid) (loader: ${engine.loader.name})`,
    'template_not_found',
  )
}

/**
 * Discriminated union representing a resolved section-api template.
 * JSON templates carry the parsed object; Liquid templates carry
 * just the path (we never read their body).
 */
export type ResolvedForSectionApi =
  | { kind: 'json'; path: string; template: JsonTemplate }
  | { kind: 'liquid'; path: string }

// ---------------------------------------------------------------------------
// Internal — single-section dispatch
// ---------------------------------------------------------------------------

async function renderOne(
  engine: LiquidEngine,
  ctx: Context,
  resolved: ResolvedForSectionApi,
  sectionId: string,
  opts: RenderSectionsOptions,
): Promise<string> {
  if (resolved.kind === 'json') {
    // JSON branch: look up the id in the template's `sections` object.
    const jsonSection = resolved.template.sections[sectionId]
    if (!jsonSection) {
      throw new SectionRenderingError(
        `section id "${sectionId}" is not declared in ${resolved.path}`,
        'section_not_found',
      )
    }
    if (jsonSection.disabled === true) {
      // Shopify returns an empty string for disabled sections rather
      // than an error — the section exists, it's just intentionally
      // hidden. AJAX callers that asked for it should just get "".
      return ''
    }
    const instance: SectionInstance = {
      settings: jsonSection.settings,
      blocks: jsonSection.blocks.map(jsonBlockToInstance),
    }
    return renderSectionInstance(
      engine.liquid,
      engine.loader,
      sectionId,
      jsonSection.type,
      instance,
      ctx,
    )
  }

  // Classic .liquid branch: the section id IS the filename. Instance
  // data comes from the caller's `sectionInstances` map (same keying
  // the `{% section %}` tag uses through the env).
  const src = await engine.loader.load(`sections/${sectionId}.liquid`)
  if (src === null) {
    throw new SectionRenderingError(
      `section "${sectionId}" not found (looked for sections/${sectionId}.liquid)`,
      'section_not_found',
    )
  }
  const instance = opts.sectionInstances?.[sectionId]
  return renderSectionInstance(
    engine.liquid,
    engine.loader,
    sectionId,
    sectionId, // classic template: id === filename
    instance,
    ctx,
  )
}

/**
 * Same adapter the JSON renderer uses — keeps block id + settings +
 * any pass-through fields intact on the way into the schema resolver.
 * Duplicated (not imported) because the JSON renderer doesn't export
 * it and a 5-line helper isn't worth a public surface.
 */
function jsonBlockToInstance(blk: {
  id: string
  type: string
  settings?: Record<string, unknown>
  [extra: string]: unknown
}): SectionBlockInstance {
  return {
    ...blk,
    type: blk.type,
    settings: blk.settings,
  }
}
