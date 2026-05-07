/**
 * Gbox Storefront — Request Context Middleware (Stage 3A.2)
 *
 * The first middleware every storefront request flows through. It
 * owns three jobs and nothing else:
 *
 *   1. **Assign a request id.** Uses the upstream `X-Request-ID`
 *      header if the proxy supplied one and it passes a safety check
 *      (so operators can trace a request across load-balancer hops),
 *      otherwise generates a fresh one.
 *   2. **Propagate the id.** Stamps it onto the response as
 *      `X-Request-ID` so the client can quote it in a bug report.
 *   3. **Create a per-request context object.** Attaches
 *      `req.gboxCtx = { id, startedAt, logger }` where `logger` is a
 *      pino child pre-bound to `{ req_id }`. Every later middleware
 *      should use `req.gboxCtx.logger` so every log line carries the
 *      trace id automatically.
 *
 * It also registers a `finish` listener on the response so the app
 * can log `method url status durationMs req_id` in one place. The
 * actual log emission is delegated to an injected `onFinish` hook —
 * that keeps this file framework-agnostic and testable without pino.
 */

import { randomUUID } from 'node:crypto'
import { createServiceLogger } from '@gbox/core/modules/logging/logger.js'
import type { Logger } from 'pino'
import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StorefrontRequestContext {
  /** Unique request id — upstream passthrough or freshly generated. */
  id: string
  /** Epoch ms at which the middleware ran. */
  startedAt: number
  /** Pino child logger (or compatible) bound to `{ req_id }`. */
  logger: Logger | MinimalLogger
}

/**
 * The shape we actually consume from the logger, so tests can inject
 * a lightweight stub without pulling in pino.
 */
export interface MinimalLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface RequestContextMiddlewareOptions {
  /**
   * Service name for the pino child logger. Defaults to
   * `gbox-storefront`. Override in tests or if two storefront
   * processes run side by side.
   */
  serviceName?: string
  /**
   * Hook invoked inside the response `finish` event. Wrapped in
   * try/catch so a logging failure never propagates back into the
   * response lifecycle.
   */
  onFinish?: (info: {
    id: string
    durationMs: number
    statusCode: number
    req: Request
    res: Response
  }) => void
  /**
   * Logger factory override. Primarily for tests — lets us skip pino
   * entirely. Defaults to `createServiceLogger(serviceName)`.
   */
  loggerFactory?: (serviceName: string) => Logger | MinimalLogger
}

// Augment Express Request typing so downstream middleware gets
// intellisense for `req.gboxCtx` without casting every time.
declare module 'express-serve-static-core' {
  interface Request {
    gboxCtx?: StorefrontRequestContext
  }
}

// ---------------------------------------------------------------------------
// Id helpers
// ---------------------------------------------------------------------------

/**
 * Generate a fresh request id. We pick UUID v4 so upstream systems
 * that already use UUID tracing feel at home, but the middleware
 * does NOT require the upstream to use UUIDs — any safe string is
 * accepted (see `isValidUpstreamRequestId`).
 */
export function newRequestId(): string {
  return randomUUID()
}

/**
 * Decide whether an upstream `X-Request-ID` header is safe to reuse.
 * Rejects anything that could be used to inject other headers or
 * poison log lines.
 *
 * Rules:
 *   - Must be a non-empty string.
 *   - At most 128 chars (any reasonable tracing id is shorter; long
 *     ids are almost always an attacker fuzzing).
 *   - Only `[A-Za-z0-9._-]` allowed — no whitespace, no control
 *     chars, no CR/LF.
 */
export function isValidUpstreamRequestId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 128) return false
  return /^[A-Za-z0-9._-]+$/.test(value)
}

/**
 * Normalise the incoming header value (which may be `string`,
 * `string[]`, or `undefined`) to a single candidate string, then
 * validate it. Returns the chosen id, or `null` if we should
 * generate a fresh one.
 */
function pickUpstreamRequestId(
  headerValue: string | string[] | undefined,
): string | null {
  if (headerValue === undefined) return null
  const first = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (isValidUpstreamRequestId(first)) return first
  return null
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Build the request-context middleware. Returns an Express middleware
 * function that mutates `req` and `res`, then calls `next()`.
 */
export function buildRequestContextMiddleware(
  options: RequestContextMiddlewareOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const serviceName = options.serviceName ?? 'gbox-storefront'
  const makeLogger =
    options.loggerFactory ??
    ((name: string) => createServiceLogger(name))

  const baseLogger = makeLogger(serviceName)

  return function requestContextMiddleware(req, res, next) {
    const startedAt = Date.now()
    const upstreamId = pickUpstreamRequestId(req.headers['x-request-id'])
    const id = upstreamId ?? newRequestId()

    // Child logger bound to { req_id }. Pino supports `.child(...)`;
    // our MinimalLogger stub may not, in which case we fall back to
    // the base logger itself.
    const logger: Logger | MinimalLogger =
      'child' in baseLogger && typeof baseLogger.child === 'function'
        ? baseLogger.child({ req_id: id })
        : baseLogger

    req.gboxCtx = { id, startedAt, logger }

    // Stamp the header immediately so even an upstream middleware
    // that short-circuits the pipeline still exposes the trace id.
    res.setHeader('X-Request-ID', id)

    // Always register a finish listener so every request gets a
    // completion log line with req_id + duration + status. The
    // optional `onFinish` hook is an additional observer — used by
    // tests and by any downstream code that wants per-request
    // metrics without having to parse log output. Both are wrapped
    // in try/catch so a logging failure never propagates back into
    // the response lifecycle (the response has already been
    // committed by the time the finish event fires).
    const onFinish = options.onFinish
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt
      try {
        ;(logger as MinimalLogger).info?.(
          {
            req_id: id,
            method: req.method,
            url: req.originalUrl ?? req.url,
            status: res.statusCode,
            duration_ms: durationMs,
          },
          `${req.method} ${req.originalUrl ?? req.url} ${res.statusCode} ${durationMs}ms`,
        )
      } catch {
        /* never bubble log failures */
      }
      if (onFinish) {
        try {
          onFinish({
            id,
            durationMs,
            statusCode: res.statusCode,
            req,
            res,
          })
        } catch (err) {
          try {
            ;(logger as MinimalLogger).error?.(
              { err, req_id: id },
              'request-context onFinish hook threw',
            )
          } catch {
            /* last-resort fallback */
          }
        }
      }
    })

    next()
  }
}
