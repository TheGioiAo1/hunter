/**
 * Gbox Platform — Structured Logger (Pino)
 *
 * WHY: console.log is synchronous I/O that blocks the event loop.
 * At 100K RPS, each console.log adds ~0.1ms latency = 10s/s total blocking.
 *
 * Pino is 5x faster than console.log:
 * - Async buffered writes (non-blocking)
 * - JSON structured output (machine-parseable)
 * - Log levels (disable debug in production)
 * - Automatic serialization of errors, objects
 *
 * Usage:
 *   import { logger } from '@gbox/core/modules/logging/logger.js'
 *   logger.info({ shopId, action: 'product.create' }, 'Product created')
 *   logger.error({ err, orderId }, 'Payment failed')
 */

import pino from 'pino'

const isProduction = process.env.NODE_ENV === 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),

  // Production: JSON to stdout (for log aggregators like Loki, ELK)
  // Development: Pretty-print with colors
  transport: isProduction
    ? undefined // Raw JSON to stdout — fastest mode
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },

  // Base context added to every log line
  base: {
    service: process.env.SERVICE_NAME || 'gbox-platform',
    pid: process.pid,
  },

  // Serialize Error objects properly
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },

  // Redact sensitive fields from logs
  redact: {
    paths: [
      'password',
      'password_hash',
      'token',
      'token_hash',
      'authorization',
      'cookie',
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    censor: '[REDACTED]',
  },
})

// ---------------------------------------------------------------------------
// Child loggers for each service
// ---------------------------------------------------------------------------

export function createServiceLogger(serviceName: string) {
  return logger.child({ service: serviceName })
}

// Pre-built service loggers
export const apiLogger = createServiceLogger('gbox-api')
export const accountsLogger = createServiceLogger('gbox-accounts')
export const adminLogger = createServiceLogger('gbox-god-admin') // iron-rule-5-ok: PM2 service name, server-side only, never reaches seller browser
export const storeLogger = createServiceLogger('gbox-store-admin')

// ---------------------------------------------------------------------------
// Request logging middleware
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'

// ---------------------------------------------------------------------------
// Correlation ID middleware — attaches a unique ID to every request
// ---------------------------------------------------------------------------

/**
 * Generates or propagates a correlation ID for request tracing.
 * Uses X-Request-ID header if present, otherwise generates a new one.
 * The ID is available as `req.correlationId` and returned in response headers.
 */
export function correlationId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = (req.headers['x-request-id'] as string) || crypto.randomUUID()
    ;(req as any).correlationId = id
    res.setHeader('X-Request-ID', id)
    next()
  }
}

/**
 * Express middleware that logs request/response with timing.
 * Production: only logs errors and slow requests (>1000ms).
 * Development: logs everything.
 * Includes correlation ID for distributed tracing.
 */
export function requestLogger(serviceName?: string) {
  const log = serviceName ? createServiceLogger(serviceName) : logger

  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()

    // Log response when finished
    res.on('finish', () => {
      const duration = Date.now() - start
      const level = res.statusCode >= 500 ? 'error'
        : res.statusCode >= 400 ? 'warn'
        : duration > 1000 ? 'warn'  // Slow request warning
        : 'info'

      // In production, skip logging successful fast requests
      if (isProduction && level === 'info' && duration < 200) return

      log[level]({
        request_id: (req as any).correlationId,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration_ms: duration,
        ip: req.ip,
        ...(res.statusCode >= 400 && { user_agent: req.headers['user-agent'] }),
      }, `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`)
    })

    next()
  }
}

// ---------------------------------------------------------------------------
// Shopify-compatible error response format
// ---------------------------------------------------------------------------

export interface ShopifyError {
  errors: Record<string, string[]> | string
}

/**
 * Format an error in Shopify API format.
 * Shopify returns: { errors: { field: ["message"] } } or { errors: "message" }
 */
export function shopifyError(message: string, field?: string): ShopifyError {
  if (field) {
    return { errors: { [field]: [message] } }
  }
  return { errors: message }
}

/**
 * Express error-handling middleware (4-arg) that produces Shopify-format errors,
 * logs with correlation ID, and optionally notifies admins on 5xx.
 */
export function shopifyErrorHandler(opts?: { notifyFn?: (err: any, req: Request) => void }) {
  return (err: any, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as any).correlationId || 'unknown'
    const status = err?.status || err?.statusCode || 500

    // Log the error with full context
    const logData = {
      request_id: requestId,
      err: err?.message,
      stack: status >= 500 ? err?.stack : undefined,
      url: req.originalUrl,
      method: req.method,
      ip: req.ip,
      status,
    }

    if (status >= 500) {
      logger.error(logData, `[${requestId}] Server error: ${err?.message}`)
      // Notify admin on 5xx errors (fire-and-forget)
      if (opts?.notifyFn) {
        try { opts.notifyFn(err, req) } catch {}
      }
    } else {
      logger.warn(logData, `[${requestId}] Client error: ${err?.message}`)
    }

    if (res.headersSent) return

    const message = isProduction && status >= 500
      ? 'An unexpected error occurred'
      : (err?.message || 'Unknown error')

    res.status(status).json({
      errors: message,
      request_id: requestId,
    })
  }
}

// ---------------------------------------------------------------------------
// Process-level error handlers
// ---------------------------------------------------------------------------

/**
 * Install process-level handlers for uncaught exceptions and unhandled rejections.
 * Call once at server startup.
 *
 * Phase 14 PR6: opt-in platform-incident alerting. When `opts.db` is
 * provided, every uncaught exception / unhandled rejection also fires
 * `emitPlatformIncident()`, which routes to alerts@gbox.co via the
 * god-admin mailbox. The emit is fire-and-forget — any failure here
 * (DB down, email transport dead, dedup collision) is swallowed so
 * the fatal-error path itself never throws. The emitter has a 60s
 * app-enforced cooldown on sha256(err.message + env), so a single
 * crash-loop won't spam the inbox.
 *
 * Passing `opts.db` is safe even in tests — the emitter is a no-op
 * when `PLATFORM_ALERTS_ENABLED=0` in env, and pt-alerts wraps
 * sendTemplatedEmail which respects the ConsoleTransport fallback.
 */
export function installProcessErrorHandlers(
  serviceName: string,
  opts?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db?: any // Kysely<Database> — loose type keeps logger free of @gbox/db dep
    env?: string
  },
) {
  const log = createServiceLogger(serviceName)
  const envName = opts?.env ?? process.env.NODE_ENV ?? 'development'

  // Lazy require to avoid a circular dep — logger is imported by every
  // service, platform-alerts is a higher-level module. A dynamic import
  // inside the handler also ensures that services which don't care
  // about platform alerts (or are in a test environment without a DB)
  // don't pay the import cost at startup.
  async function fireIncident(
    severity: 'critical' | 'high',
    errMessage: string,
    errStack: string | undefined,
  ): Promise<void> {
    if (!opts?.db) return
    try {
      const { emitPlatformIncident } = await import(
        '../platform-alerts/emitters.js'
      )
      await emitPlatformIncident(opts.db, {
        severity,
        title: `${serviceName}: ${errMessage.slice(0, 120)}`,
        errorMessage: errMessage,
        env: envName,
      })
    } catch {
      // Non-fatal. Logger already recorded the primary error via
      // log.fatal/log.error; alert failure just means nobody gets
      // paged, which is worse than the current state but not worse
      // than crashing the process trying to page.
    }
  }

  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, `[${serviceName}] Uncaught exception`)
    // Fire the incident BEFORE setTimeout — the process has 500ms
    // before exit, so as long as our promise settles in that window
    // the transport has a chance. If not, the next process restart
    // will still see the log line.
    fireIncident('critical', err.message, err.stack).catch(() => {})
    // Give logger time to flush before exit
    setTimeout(() => process.exit(1), 500)
  })

  process.on('unhandledRejection', (reason: any) => {
    const errMessage = reason?.message || String(reason)
    const errStack = reason?.stack
    log.error(
      { err: errMessage, stack: errStack },
      `[${serviceName}] Unhandled promise rejection`,
    )
    // Don't exit — log and continue (Node 18+ default). Severity is
    // 'high' not 'critical' for unhandled rejections since they don't
    // kill the process; ops can still mute these separately.
    fireIncident('high', errMessage, errStack).catch(() => {})
  })

  log.info(`Process error handlers installed for ${serviceName}`)
}
