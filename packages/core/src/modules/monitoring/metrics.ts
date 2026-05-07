/**
 * Gbox Platform — Metrics & Health Check Module
 *
 * Provides:
 * 1. Enhanced health check with dependency status (DB, Redis)
 * 2. Prometheus-compatible metrics endpoint
 * 3. Request counting and latency tracking
 *
 * Usage:
 *   import { healthCheck, metricsMiddleware, getMetrics } from '@gbox/core/modules/monitoring/metrics.js'
 *   app.get('/health', healthCheck(db))
 *   app.get('/metrics', getMetrics())
 *   app.use(metricsMiddleware())
 */

import type { Request, Response, NextFunction } from 'express'
import type { Kysely } from 'kysely'
import { redisPing } from '../cache/redis.js'

// ---------------------------------------------------------------------------
// Metrics storage (in-memory, reset on restart)
// ---------------------------------------------------------------------------

interface MetricsStore {
  // Request counters
  requests_total: number
  requests_by_method: Record<string, number>
  requests_by_status: Record<string, number>

  // Latency tracking (sliding window)
  latencies: number[]    // Last 1000 response times in ms
  latency_index: number  // Circular buffer index

  // Error counters
  errors_total: number
  errors_5xx: number
  errors_4xx: number

  // Business metrics
  started_at: number
}

const metrics: MetricsStore = {
  requests_total: 0,
  requests_by_method: {},
  requests_by_status: {},
  latencies: new Array(1000).fill(0),
  latency_index: 0,
  errors_total: 0,
  errors_5xx: 0,
  errors_4xx: 0,
  started_at: Date.now(),
}

// ---------------------------------------------------------------------------
// Percentile calculation
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(sorted.length * p / 100) - 1
  return sorted[Math.max(0, idx)]
}

function getLatencyStats() {
  // Filter out zeros (unfilled slots)
  const nonZero = metrics.latencies.filter(l => l > 0)
  if (nonZero.length === 0) return { p50: 0, p95: 0, p99: 0, avg: 0, max: 0 }

  const sorted = nonZero.sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)

  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    avg: Math.round(sum / sorted.length),
    max: sorted[sorted.length - 1],
  }
}

// ---------------------------------------------------------------------------
// Metrics middleware — tracks requests/latency
// ---------------------------------------------------------------------------

export function metricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()

    res.on('finish', () => {
      const duration = Date.now() - start

      // Increment counters
      metrics.requests_total++
      metrics.requests_by_method[req.method] = (metrics.requests_by_method[req.method] || 0) + 1

      const statusGroup = `${Math.floor(res.statusCode / 100)}xx`
      metrics.requests_by_status[statusGroup] = (metrics.requests_by_status[statusGroup] || 0) + 1

      if (res.statusCode >= 500) metrics.errors_5xx++
      if (res.statusCode >= 400 && res.statusCode < 500) metrics.errors_4xx++
      if (res.statusCode >= 400) metrics.errors_total++

      // Track latency (circular buffer)
      metrics.latencies[metrics.latency_index % 1000] = duration
      metrics.latency_index++
    })

    next()
  }
}

// ---------------------------------------------------------------------------
// Health check endpoint
// ---------------------------------------------------------------------------

export function healthCheck(db: Kysely<any>) {
  return async (_req: Request, res: Response) => {
    const start = Date.now()

    // Check all dependencies in parallel
    const [dbCheck, redisCheck] = await Promise.allSettled([
      db.selectFrom('shops' as any).select('id' as any).limit(1).execute()
        .then(() => true)
        .catch(() => false),
      redisPing(),
    ])

    const dbOk = dbCheck.status === 'fulfilled' && dbCheck.value === true
    const redisOk = redisCheck.status === 'fulfilled' && redisCheck.value === true

    const latency = Date.now() - start
    const status = dbOk ? 'healthy' : 'degraded'
    const httpStatus = status === 'healthy' ? 200 : 503

    const mem = process.memoryUsage()
    const latencyStats = getLatencyStats()

    res.status(httpStatus).json({
      status,
      service: process.env.SERVICE_NAME || 'gbox-platform',
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      uptime_human: formatUptime(process.uptime()),
      timestamp: new Date().toISOString(),

      checks: {
        database: dbOk ? 'ok' : 'fail',
        redis: redisOk ? 'ok' : 'not_connected',
      },

      latency_ms: latency,

      memory: {
        rss_mb: Math.round(mem.rss / 1048576),
        heap_used_mb: Math.round(mem.heapUsed / 1048576),
        heap_total_mb: Math.round(mem.heapTotal / 1048576),
        external_mb: Math.round(mem.external / 1048576),
      },

      requests: {
        total: metrics.requests_total,
        errors: metrics.errors_total,
        error_rate: metrics.requests_total > 0
          ? `${((metrics.errors_total / metrics.requests_total) * 100).toFixed(2)}%`
          : '0%',
      },

      latency: {
        p50_ms: latencyStats.p50,
        p95_ms: latencyStats.p95,
        p99_ms: latencyStats.p99,
        avg_ms: latencyStats.avg,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Prometheus-compatible metrics endpoint
// ---------------------------------------------------------------------------

export function getMetrics() {
  return (_req: Request, res: Response) => {
    const mem = process.memoryUsage()
    const latencyStats = getLatencyStats()
    const uptimeSeconds = Math.floor((Date.now() - metrics.started_at) / 1000)

    const lines: string[] = []

    // Helper to add metric
    const gauge = (name: string, help: string, value: number, labels?: string) => {
      lines.push(`# HELP ${name} ${help}`)
      lines.push(`# TYPE ${name} gauge`)
      lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`)
    }

    const counter = (name: string, help: string, value: number, labels?: string) => {
      lines.push(`# HELP ${name} ${help}`)
      lines.push(`# TYPE ${name} counter`)
      lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`)
    }

    // Process metrics
    gauge('gbox_process_uptime_seconds', 'Process uptime in seconds', uptimeSeconds)
    gauge('gbox_process_memory_rss_bytes', 'RSS memory usage', mem.rss)
    gauge('gbox_process_memory_heap_used_bytes', 'Heap used', mem.heapUsed)
    gauge('gbox_process_memory_heap_total_bytes', 'Heap total', mem.heapTotal)

    // Request metrics
    counter('gbox_requests_total', 'Total HTTP requests', metrics.requests_total)
    counter('gbox_errors_total', 'Total errors (4xx + 5xx)', metrics.errors_total)
    counter('gbox_errors_5xx_total', 'Total server errors (5xx)', metrics.errors_5xx)
    counter('gbox_errors_4xx_total', 'Total client errors (4xx)', metrics.errors_4xx)

    // Request by method
    for (const [method, count] of Object.entries(metrics.requests_by_method)) {
      lines.push(`gbox_requests_by_method{method="${method}"} ${count}`)
    }

    // Request by status
    for (const [status, count] of Object.entries(metrics.requests_by_status)) {
      lines.push(`gbox_requests_by_status{status="${status}"} ${count}`)
    }

    // Latency histogram
    lines.push('# HELP gbox_response_time_ms Response time in milliseconds')
    lines.push('# TYPE gbox_response_time_ms summary')
    lines.push(`gbox_response_time_ms{quantile="0.5"} ${latencyStats.p50}`)
    lines.push(`gbox_response_time_ms{quantile="0.95"} ${latencyStats.p95}`)
    lines.push(`gbox_response_time_ms{quantile="0.99"} ${latencyStats.p99}`)
    lines.push(`gbox_response_time_ms_avg ${latencyStats.avg}`)
    lines.push(`gbox_response_time_ms_max ${latencyStats.max}`)

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.send(lines.join('\n') + '\n')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(' ')
}
