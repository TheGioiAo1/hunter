/**
 * Gbox Platform — `{% paginate %}` tag
 *
 * Decision #1 Step 1.12 — Shopify's pagination primitive. Slices a
 * long collection into pages and exposes a `paginate` drop for
 * rendering the page navigation widget.
 *
 * Syntax:
 *
 *   {% paginate collection.products by 20 %}
 *     {% for product in collection.products %}
 *       <li>{{ product.title }}</li>
 *     {% endfor %}
 *     {% for part in paginate.parts %}
 *       {% if part.is_link %}
 *         <a href="{{ part.url }}">{{ part.title }}</a>
 *       {% else %}
 *         <span>{{ part.title }}</span>
 *       {% endif %}
 *     {% endfor %}
 *   {% endpaginate %}
 *
 * `by N` is the page size — can be a number literal or a Liquid
 * expression (e.g. `by section.settings.per_page`).
 *
 * The paginate drop exposes:
 *
 *   - `current_page`    1-based index of the current page
 *   - `current_offset`  (current_page - 1) * page_size
 *   - `items`           total item count across all pages
 *   - `pages`           total page count (ceil(items / page_size))
 *   - `page_size`       size from the tag's `by` argument
 *   - `previous`        { title: '«', url } | null
 *   - `next`            { title: '»', url } | null
 *   - `parts[]`         [{ title, url?, is_link }] for building the
 *                       page navigation widget with ellipses
 *
 * Data sources:
 *
 *   - Page size         → tag's `by` argument (evaluated at render
 *                         time so theme settings work).
 *   - Current page      → `ctx.environments.__gboxPagination[expr].page`
 *                         (defaults to 1 when absent).
 *   - Total item count  → `ctx.environments.__gboxPagination[expr].total`
 *                         (defaults to the expression's array length
 *                         when absent — handy for tests and small
 *                         collections that fit in memory).
 *   - Base URL for pages → `ctx.environments.request.path` (query
 *                          string is appended; existing `?page=`
 *                          stripped and replaced).
 *
 * Expression rebinding (FULL-PATH mode per Step 1.12 decision):
 *
 *   When a theme writes:
 *
 *     {% paginate collection.products by 12 %}
 *       {% for p in collection.products %}...{% endfor %}
 *
 *   The inner `collection.products` must resolve to the SLICED
 *   array, not the full list. We walk the dotted path, rebuild each
 *   intermediate object by spreading over the original, and push a
 *   single scope frame with the TOP-LEVEL segment rebound. This
 *   supports arbitrary depth:
 *
 *     paginate foo.bar.baz by 10
 *       → frame { foo: { ...foo, bar: { ...foo.bar, baz: slice } } }
 *
 *   Limitation: expression must be a literal dotted path. Expressions
 *   with filters (`collection.products | reverse`) or index accessors
 *   (`shop.products[0..10]`) are not supported — Shopify doesn't
 *   allow them in paginate either.
 *
 * Pagination parts algorithm:
 *
 *   Window = ±2 neighbors around the current page. Always include
 *   page 1 and the last page. Gaps between shown pages become
 *   `{ title: '…', is_link: false }` ellipsis entries. The current
 *   page is `{ title: 'N', is_link: false }` (no URL — it's the
 *   current one). Matches Shopify's widget byte-for-byte for the
 *   common case.
 */

import {
  Tag,
  Value,
  type Liquid,
  type Context,
  type Emitter,
  type TagToken,
  type TopLevelToken,
  type Parser,
  type Template,
} from 'liquidjs'

// ---------------------------------------------------------------------------
// Env key + shape
// ---------------------------------------------------------------------------

/**
 * Key in `ctx.environments` where the render pipeline stashes
 * per-expression pagination data.
 */
export const GBOX_PAGINATION_ENV_KEY = '__gboxPagination' as const

/**
 * Caller-supplied pagination data for one expression.
 */
export interface PaginationInput {
  /** 1-based current page. Clamped to [1, totalPages]. */
  page?: number
  /** Total item count across all pages. Defaults to array length. */
  total?: number
}

/** Map of `"dotted.path"` → pagination data. */
export type GboxPaginationEnv = Record<string, PaginationInput>

// ---------------------------------------------------------------------------
// Paginate drop shape
// ---------------------------------------------------------------------------

/** One entry in `paginate.parts[]`. */
export interface PaginatePart {
  title: string
  url?: string
  is_link: boolean
}

/** The `paginate` drop injected into the tag body's scope. */
export interface PaginateDrop {
  current_page: number
  current_offset: number
  items: number
  pages: number
  page_size: number
  previous: { title: string; url: string } | null
  next: { title: string; url: string } | null
  parts: PaginatePart[]
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/**
 * Register the `{% paginate ... %}...{% endpaginate %}` block tag on
 * the given Liquid instance. Call once per engine — the engine
 * factory (`createLiquidEngine`) wires this up.
 */
export function registerPaginateTag(liquid: Liquid): void {
  class PaginateTag extends Tag {
    /** Original dotted-path expression as written in the template. */
    private readonly exprPath: string
    /** Segments of `exprPath` for rebinding. */
    private readonly exprSegments: string[]
    /** Value wrapper for looking up the iterable at render time. */
    private readonly exprValue: Value
    /** Value wrapper for the `by` argument (literal or expression). */
    private readonly sizeValue: Value
    /** Parsed body templates between {% paginate %} and {% endpaginate %}. */
    private readonly body: Template[]

    constructor(
      token: TagToken,
      remainTokens: TopLevelToken[],
      liquidInstance: Liquid,
      parser: Parser,
    ) {
      super(token, remainTokens, liquidInstance)

      // ---- Parse args ----------------------------------------------------
      // tagToken.args is the raw string after "paginate" up to `%}`.
      const args = (token.args ?? '').trim()
      // Match `<path> by <sizeExpr>`. The path accepts identifiers,
      // dots, and brackets; the size expression is anything else.
      const m = /^([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*)\s+by\s+(.+?)\s*$/.exec(
        args,
      )
      if (!m) {
        throw new Error(
          `[gbox-engine] {% paginate %} requires the form "paginate <path> by <size>", got: ${token.getText()}`,
        )
      }
      this.exprPath = m[1]
      this.exprSegments = this.exprPath.split('.')
      this.exprValue = new Value(this.exprPath, liquidInstance)
      this.sizeValue = new Value(m[2], liquidInstance)

      // ---- Parse body until {% endpaginate %} ----------------------------
      const body: Template[] = []
      parser
        .parseStream(remainTokens)
        .on('template', (tpl: Template) => body.push(tpl))
        .on('tag:endpaginate', function () {
          this.stop()
        })
        .on('end', () => {
          throw new Error(
            `[gbox-engine] {% paginate %} block not closed (expected {% endpaginate %})`,
          )
        })
        .start()
      this.body = body
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    *render(ctx: Context, emitter: Emitter): Generator<unknown, void, any> {
      // ---- Evaluate the iterable and the page size ----------------------
      const iterableRaw: unknown = yield this.exprValue.value(ctx, false)
      const iterable: unknown[] = Array.isArray(iterableRaw) ? iterableRaw : []
      const rawSize: unknown = yield this.sizeValue.value(ctx, false)
      const pageSize = Math.max(1, toPositiveInt(rawSize, 20))

      // ---- Read per-expression pagination data from env ------------------
      const env = ctx.environments as Record<string, unknown>
      const paginationEnv =
        (env[GBOX_PAGINATION_ENV_KEY] as GboxPaginationEnv | undefined) ?? {}
      const input: PaginationInput = paginationEnv[this.exprPath] ?? {}

      const totalItems =
        typeof input.total === 'number' && input.total >= 0
          ? Math.floor(input.total)
          : iterable.length
      const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
      const currentPage = clamp(
        typeof input.page === 'number' && input.page > 0
          ? Math.floor(input.page)
          : 1,
        1,
        totalPages,
      )
      const currentOffset = (currentPage - 1) * pageSize

      // ---- Slice the iterable -------------------------------------------
      // If the caller supplied a total larger than the array length,
      // they're paginating a DB query where the array is already the
      // current page. We slice anyway to handle both cases.
      const sliced = iterable.slice(
        totalItems === iterable.length ? currentOffset : 0,
        totalItems === iterable.length
          ? currentOffset + pageSize
          : iterable.length,
      )

      // ---- Build the paginate drop --------------------------------------
      const basePath = readRequestPath(ctx)
      const drop: PaginateDrop = {
        current_page: currentPage,
        current_offset: currentOffset,
        items: totalItems,
        pages: totalPages,
        page_size: pageSize,
        previous:
          currentPage > 1
            ? { title: '«', url: buildPageUrl(basePath, currentPage - 1) }
            : null,
        next:
          currentPage < totalPages
            ? { title: '»', url: buildPageUrl(basePath, currentPage + 1) }
            : null,
        parts: buildPaginateParts(currentPage, totalPages, basePath),
      }

      // ---- Rebind the dotted path to the sliced array -------------------
      // Walk from the deepest segment outwards, spreading each
      // intermediate object so we never mutate the original. The
      // top-level segment is the frame key.
      const frame = buildRebindFrame(ctx, this.exprSegments, sliced)

      // ---- Push frame + render body -------------------------------------
      ctx.push({ ...frame, paginate: drop })
      try {
        yield this.liquid.renderer.renderTemplates(this.body, ctx, emitter)
      } finally {
        ctx.pop()
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liquid.registerTag('paginate', PaginateTag as any)
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Build the pagination parts array — the data structure themes use
 * to render the `« 1 2 … 5 6 7 … 10 »` page navigation widget.
 *
 * Algorithm (matches Shopify for the window=2 case):
 *
 *   - Always include page 1 and `totalPages`
 *   - Always include current ± 2 neighbors
 *   - Gaps between shown pages become a single `…` ellipsis part
 *   - Current page is non-link (`is_link: false`), no URL
 *   - Other pages are link parts with their URL
 *
 * Edge cases:
 *
 *   - `totalPages <= 1` → empty array (no navigation needed)
 *   - `currentPage` out of range is already clamped by the caller
 */
export function buildPaginateParts(
  currentPage: number,
  totalPages: number,
  basePath: string,
  window = 2,
): PaginatePart[] {
  if (totalPages <= 1) return []

  // Collect the distinct pages we want to show.
  const pages = new Set<number>()
  pages.add(1)
  pages.add(totalPages)
  for (
    let p = Math.max(1, currentPage - window);
    p <= Math.min(totalPages, currentPage + window);
    p++
  ) {
    pages.add(p)
  }

  const sorted = [...pages].sort((a, b) => a - b)
  const parts: PaginatePart[] = []
  let last = 0
  for (const p of sorted) {
    if (p - last > 1) {
      parts.push({ title: '…', is_link: false })
    }
    if (p === currentPage) {
      parts.push({ title: String(p), is_link: false })
    } else {
      parts.push({
        title: String(p),
        url: buildPageUrl(basePath, p),
        is_link: true,
      })
    }
    last = p
  }
  return parts
}

/**
 * Build a page URL by taking the current request path and replacing
 * or appending `?page=N`. Preserves any other query params. If the
 * path has no `?`, appends a fresh query string.
 *
 * Examples:
 *   buildPageUrl('/collections/all', 2) → '/collections/all?page=2'
 *   buildPageUrl('/blog?tag=news', 3)   → '/blog?tag=news&page=3'
 *   buildPageUrl('/x?page=5', 2)        → '/x?page=2'
 *   buildPageUrl('', 4)                 → '?page=4'
 */
export function buildPageUrl(basePath: string, page: number): string {
  const safePath = basePath ?? ''
  const qIdx = safePath.indexOf('?')
  if (qIdx < 0) {
    return `${safePath}?page=${page}`
  }
  const pathPart = safePath.slice(0, qIdx)
  const queryPart = safePath.slice(qIdx + 1)
  // Strip any existing `page=...` entry and rejoin.
  const cleaned = queryPart
    .split('&')
    .filter((seg) => seg && !seg.startsWith('page='))
    .join('&')
  const prefix = cleaned ? `${cleaned}&` : ''
  return `${pathPart}?${prefix}page=${page}`
}

/**
 * Walk the dotted-path segments and rebuild a scope frame where the
 * leaf segment is replaced by `sliced`. Intermediate objects are
 * spread over their originals so nothing upstream mutates.
 *
 * Returns an object with a single top-level key (the first segment)
 * suitable for `ctx.push(frame)`. When `segments.length === 1`, the
 * frame is `{ [segment]: sliced }` directly.
 */
export function buildRebindFrame(
  ctx: Context,
  segments: string[],
  sliced: unknown[],
): Record<string, unknown> {
  if (segments.length === 0) return {}
  const [head, ...rest] = segments
  if (rest.length === 0) {
    return { [head]: sliced }
  }
  // Look up the head variable from the ctx scope chain. We use
  // `ctx.get` which walks the scope stack + environments.
  const topOriginal = lookup(ctx, head) as Record<string, unknown> | undefined
  const rebuilt = rebuildIntermediate(topOriginal ?? {}, rest, sliced)
  return { [head]: rebuilt }
}

/**
 * Recursively rebuild the intermediate object chain. `rest` is the
 * segments below the current level; when it has length 1, we know
 * the deepest field is the one to replace.
 */
function rebuildIntermediate(
  parent: Record<string, unknown>,
  rest: string[],
  sliced: unknown[],
): Record<string, unknown> {
  const [head, ...tail] = rest
  if (tail.length === 0) {
    return { ...parent, [head]: sliced }
  }
  const inner = parent[head]
  const innerObj =
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : {}
  return { ...parent, [head]: rebuildIntermediate(innerObj, tail, sliced) }
}

/**
 * Context lookup that walks the scope chain AND environments. We
 * don't use `ctx.get([key])` because it returns a promise in
 * LiquidJS's async mode; we want a sync read for the rebind step.
 */
function lookup(ctx: Context, key: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyCtx = ctx as any
  const scopes: Array<Record<string, unknown>> = anyCtx.scopes ?? []
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i] && Object.prototype.hasOwnProperty.call(scopes[i], key)) {
      return scopes[i][key]
    }
  }
  const env = (anyCtx.environments ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(env, key)) return env[key]
  const globals = (anyCtx.globals ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(globals, key)) return globals[key]
  return undefined
}

/**
 * Read `ctx.environments.request.path` safely, returning an empty
 * string if missing.
 */
function readRequestPath(ctx: Context): string {
  const env = ctx.environments as Record<string, unknown>
  const req = env.request as { path?: unknown } | undefined
  if (req && typeof req.path === 'string') return req.path
  return ''
}

/** Clamp x into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo
  if (x > hi) return hi
  return x
}

/**
 * Coerce a value to a positive integer, using `fallback` when the
 * value is missing, zero, or negative.
 */
function toPositiveInt(v: unknown, fallback: number): number {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string'
        ? Number(v)
        : NaN
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}
