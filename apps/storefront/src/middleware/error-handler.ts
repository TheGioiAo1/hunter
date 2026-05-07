/**
 * Gbox Storefront — Error + 404 Handler Middleware (Stage 3A.9)
 *
 * Terminal middleware that convert uncaught pipeline throws into a
 * presentable page, and guarantee that any request which falls
 * through every upstream middleware gets a templated 404 instead of
 * the bare Express default.
 *
 * Why two factories instead of one?
 *
 *   • `buildErrorMiddleware` is the Express 4-arg error handler
 *     `(err, req, res, next)`. It is installed LAST in the pipeline
 *     so it catches throws from:
 *       - the storefront handler wrapper (genuine infra errors, not
 *         the router's own render500 which is already a 200-level
 *         StorefrontResponse flow);
 *       - the resolve-shop / cookie / locale / asset middleware;
 *       - any future middleware added ahead of the handler.
 *
 *   • `buildNotFoundMiddleware` is the classic 3-arg fallback run
 *     when the catch-all storefront handler is NOT installed (tests
 *     or early stages) or when an unmatched method (POST, DELETE)
 *     reaches the bottom of the stack. It attempts the same
 *     templated render as the 5xx path, then falls back to plain
 *     text if the theme has no `templates/404.liquid`.
 *
 * Both factories accept a bag with an optional `getHandlerOptions`
 * callback identical to the storefront handler's — so in practice
 * `buildApp()` passes the same function to both and the caller
 * never has to duplicate their per-shop theme lookup.
 *
 * Design notes:
 *
 *   • **Never re-throw.** An error handler that throws creates
 *     surprise 500s that bypass observability. Any failure inside
 *     rendering is swallowed and replaced with a plain-text reply.
 *
 *   • **Rendering is engine-direct.** We DON'T re-enter
 *     `handleStorefrontRequest` for the error render — that would
 *     trigger the same error path that got us here in the first
 *     place if the problem is upstream (cookies, locale, …). Instead
 *     we pull the loader off `opts.engine`, load
 *     `templates/<500|404>.liquid` + the configured layout, and
 *     pipe the two through `engine.liquid.parseAndRender` with the
 *     minimum drops merchants actually use on error pages
 *     (`error_message`, `request.path`, `locale`).
 *
 *   • **`headersSent` check.** If a previous middleware already
 *     started streaming the response body before throwing, the only
 *     safe thing is to forward the error to Express's default
 *     handler so the socket can be closed cleanly. We never try to
 *     rewrite headers once they've left the socket.
 */

import type { Request, Response, NextFunction } from 'express'
import type { StorefrontHandlerOptions } from '@gbox/core/modules/themes/engine/storefront/index.js'
import type { TemplateLoader } from '@gbox/core/modules/themes/engine/loader.js'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Minimal duck-typed logger — matches `req.gboxCtx?.logger` and
 * Pino's core method set. Only `error` is required; everything else
 * is optional so callers can pass in a bare `{ error: console.error }`
 * in tests.
 */
export interface StorefrontErrorLogger {
  error(bag: Record<string, unknown>, msg?: string): void
}

export interface ErrorHandlerDeps {
  /**
   * Resolve the per-request `StorefrontHandlerOptions` so the error
   * path can render a branded 500 via the active theme. Identical to
   * the storefront handler's callback — callers typically reuse the
   * same function. Sync or async. Return `null` to force the plain-
   * text fallback.
   */
  getHandlerOptions?: (
    req: Request,
  ) =>
    | StorefrontHandlerOptions
    | null
    | Promise<StorefrontHandlerOptions | null>
  /**
   * Overrides the logger used for the "caught a 500" line. Defaults
   * to `req.gboxCtx?.logger` (the per-request pino child installed
   * by the request-context middleware in Stage 3A.2), falling back
   * to a no-op so tests never see extra log spew.
   */
  logger?: StorefrontErrorLogger
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to render `templates/<name>.liquid` wrapped in the theme's
 * default layout. Returns the rendered HTML on success, or `null`
 * when any step fails (loader miss, parse error, runtime throw).
 *
 * The tiny drop exposed here (`error_message`, `request`, `locale`)
 * is the same set Gbox Dawn uses in its error templates. Merchants
 * with custom themes that reference richer drops will get empty
 * strings there — that's intentional: the 500 path MUST not touch
 * the datasource, because the datasource may be the thing that's on
 * fire.
 */
async function renderErrorTemplate(
  opts: StorefrontHandlerOptions,
  templateName: '404' | '500',
  errorMessage: string,
  locale: string,
  requestPath: string,
): Promise<string | null> {
  try {
    const loader = (opts.engine as unknown as { loader: TemplateLoader }).loader
    if (!loader || typeof loader.load !== 'function') return null
    const innerSrc = await loader.load(`templates/${templateName}.liquid`)
    if (innerSrc === null || innerSrc === undefined) return null

    const liquid = (
      opts.engine as unknown as {
        liquid: {
          parseAndRender: (
            source: string,
            ctx: Record<string, unknown>,
          ) => Promise<string>
        }
      }
    ).liquid
    if (!liquid || typeof liquid.parseAndRender !== 'function') return null

    const baseDrops: Record<string, unknown> = {
      error_message: errorMessage,
      request: { path: requestPath, locale },
      locale,
    }

    const innerHtml = await liquid.parseAndRender(innerSrc, baseDrops)

    // Wrap in the default layout if the theme ships one. Missing
    // layouts are fine — we just send the template body as-is.
    const layoutName = opts.defaultLayout ?? 'theme'
    const layoutSrc = await loader.load(`layout/${layoutName}.liquid`)
    if (layoutSrc === null || layoutSrc === undefined) return innerHtml

    return await liquid.parseAndRender(layoutSrc, {
      ...baseDrops,
      content_for_layout: innerHtml,
    })
  } catch {
    return null
  }
}

function pickLocale(req: Request, opts: StorefrontHandlerOptions | null): string {
  return (
    req.gboxLocale?.locale ??
    opts?.locales?.default ??
    'en'
  )
}

function pickRequestPath(req: Request): string {
  if (req.gboxLocale?.strippedPath) return req.gboxLocale.strippedPath
  if (typeof req.path === 'string') return req.path
  if (typeof req.url === 'string') return req.url
  return '/'
}

function resolveLogger(
  deps: ErrorHandlerDeps,
  req: Request,
): StorefrontErrorLogger | null {
  if (deps.logger) return deps.logger
  const ctxLogger = req.gboxCtx?.logger
  if (
    ctxLogger &&
    typeof (ctxLogger as { error?: unknown }).error === 'function'
  ) {
    return ctxLogger as StorefrontErrorLogger
  }
  return null
}

async function safeGetHandlerOptions(
  deps: ErrorHandlerDeps,
  req: Request,
): Promise<StorefrontHandlerOptions | null> {
  if (!deps.getHandlerOptions) return null
  try {
    return (await deps.getHandlerOptions(req)) ?? null
  } catch {
    // A throw inside the caller's options resolver must never
    // cascade into a second 500. Return null and let the caller
    // fall back to plain text.
    return null
  }
}

// ---------------------------------------------------------------------------
// 500 error middleware
// ---------------------------------------------------------------------------

/**
 * Build the Express 4-arg error handler. Install it LAST in the
 * middleware chain, after the storefront handler:
 *
 *   app.use(buildErrorMiddleware({ getHandlerOptions }))
 *
 * Express routes errors to the first middleware whose function
 * signature has arity 4. We intentionally DON'T return an arrow
 * (whose arity inference Express used to get wrong) — the named
 * `function` expression keeps the contract explicit.
 */
export function buildErrorMiddleware(
  deps: ErrorHandlerDeps,
): (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void> {
  return async function storefrontErrorHandler(err, req, res, next) {
    // If the response has already started, we can't recover —
    // hand the error back to Express so the socket gets destroyed.
    if (res.headersSent) {
      next(err)
      return
    }

    const logger = resolveLogger(deps, req)
    logger?.error?.(
      {
        err,
        method: req.method,
        url: req.url,
        shopId: req.gboxShopId,
      },
      'storefront: uncaught error',
    )

    const opts = await safeGetHandlerOptions(deps, req)
    const locale = pickLocale(req, opts)
    const errorMessage =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Internal Server Error'

    if (opts) {
      const html = await renderErrorTemplate(
        opts,
        '500',
        errorMessage,
        locale,
        pickRequestPath(req),
      )
      if (html !== null) {
        try {
          res.status(500)
          res.set('Content-Type', 'text/html; charset=utf-8')
          res.set('Content-Language', locale)
          res.send(html)
          return
        } catch {
          // fall through to plain text below
        }
      }
    }

    // Hard fallback — theme missing, template missing, or
    // rendering threw. Keep the response minimal and predictable.
    try {
      res.status(500)
      res.type('text/plain; charset=utf-8')
      res.send('500 Internal Server Error')
    } catch {
      // If even this throws (should be impossible — fake res in
      // tests, or res already half-written), defer to Express's
      // default handler.
      next(err)
    }
  }
}

// ---------------------------------------------------------------------------
// 404 fallback middleware
// ---------------------------------------------------------------------------

/**
 * Build the 404 fallback middleware. Install it LAST among the
 * non-error middleware (just before `buildErrorMiddleware`), so it
 * catches any request that fell through the storefront handler
 * without matching a route:
 *
 *   app.use(buildStorefrontHandler(...))      // happy path
 *   app.use(buildNotFoundMiddleware({ ... })) // fall-through 404
 *   app.use(buildErrorMiddleware({ ... }))    // 500
 *
 * Design choice: we don't try to forward from here into the core
 * `render404` helper because that would re-run datasource reads on
 * every missing asset. The templated 404 is lightweight (loader +
 * two parseAndRender calls) and deliberately avoids hitting the DB.
 */
export function buildNotFoundMiddleware(
  deps: ErrorHandlerDeps,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function storefrontNotFoundHandler(req, res, next) {
    if (res.headersSent) {
      next()
      return
    }

    const opts = await safeGetHandlerOptions(deps, req)
    const locale = pickLocale(req, opts)

    if (opts) {
      const html = await renderErrorTemplate(
        opts,
        '404',
        'Not Found',
        locale,
        pickRequestPath(req),
      )
      if (html !== null) {
        try {
          res.status(404)
          res.set('Content-Type', 'text/html; charset=utf-8')
          res.set('Content-Language', locale)
          res.send(html)
          return
        } catch {
          // fall through to plain text below
        }
      }
    }

    try {
      res.status(404)
      res.type('text/plain; charset=utf-8')
      res.send('404 Not Found')
    } catch {
      next()
    }
  }
}
