/**
 * God Admin — System Health Page (Category A3: System Health)
 *
 * GET /god-admin/health-check
 *
 * Displays:
 * - Server status: HEALTHY / DEGRADED
 * - CPU usage, Memory usage, Node uptime
 * - Service status: ping ports 4321, 4323, 4324, 4325
 * - Database stats: active connections, pool info, DB size
 * - Visual gauges (CSS colored bars)
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  parts.push(`${mins}m`)
  return parts.join(' ')
}

function gaugeColor(pct: number): string {
  if (pct < 50) return 'var(--green)'
  if (pct < 80) return 'var(--yellow)'
  return 'var(--red)'
}

function gaugeHtml(label: string, value: string, pct: number): string {
  const color = gaugeColor(pct)
  const clampedPct = Math.min(100, Math.max(0, pct))
  return `
    <div class="gauge-item">
      <div class="gauge-header">
        <span class="gauge-label">${esc(label)}</span>
        <span class="gauge-value" style="color:${color}">${esc(value)}</span>
      </div>
      <div class="gauge-track">
        <div class="gauge-fill" style="width:${clampedPct}%;background:${color}"></div>
      </div>
    </div>`
}

async function pingService(port: number, timeout: number = 3000): Promise<{ status: string; latency: number }> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    clearTimeout(timer)
    const latency = Date.now() - start
    return { status: resp.ok ? 'UP' : 'DOWN', latency }
  } catch {
    return { status: 'DOWN', latency: Date.now() - start }
  }
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function getHealthCheck(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  try {
    // Gather system metrics
    const mem = process.memoryUsage()
    const cpuUsage = process.cpuUsage()
    const uptime = process.uptime()

    // CPU usage as rough percentage (user + system time since process start)
    const totalCpuMicros = cpuUsage.user + cpuUsage.system
    const uptimeMicros = uptime * 1_000_000
    const cpuPct = uptimeMicros > 0 ? Math.min(100, (totalCpuMicros / uptimeMicros) * 100) : 0

    // Memory percentage (heap used vs RSS as upper bound)
    const memPct = mem.rss > 0 ? (mem.heapUsed / mem.rss) * 100 : 0

    // Ping services in parallel
    const services = [
      { name: 'Platform API', port: 4321 },
      { name: 'Accounts Portal', port: 4323 },
      { name: 'God Admin', port: 4324 },
      { name: 'Storefront', port: 4325 },
    ]

    const serviceResults = await Promise.all(
      services.map(async s => {
        const result = await pingService(s.port)
        return { ...s, ...result }
      })
    )

    // Database stats
    let dbSize = 'Unknown'
    let dbActiveConns = 'Unknown'
    let dbMaxConns = 'Unknown'

    try {
      const [sizeResult, connResult, maxConnResult] = await Promise.all([
        sql<{ size: string }>`SELECT pg_size_pretty(pg_database_size(current_database())) as size`.execute(db),
        sql<{ count: string }>`SELECT count(*) as count FROM pg_stat_activity WHERE state = 'active'`.execute(db),
        sql<{ setting: string }>`SELECT setting FROM pg_settings WHERE name = 'max_connections'`.execute(db),
      ])
      dbSize = sizeResult.rows[0]?.size ?? 'Unknown'
      dbActiveConns = String(connResult.rows[0]?.count ?? 'Unknown')
      dbMaxConns = String(maxConnResult.rows[0]?.setting ?? 'Unknown')
    } catch (dbErr) {
      console.error('[God Admin] DB stats error:', dbErr)
    }

    // Overall status
    const allServicesUp = serviceResults.every(s => s.status === 'UP')
    const memOk = memPct < 90
    const overallStatus = allServicesUp && memOk ? 'HEALTHY' : 'DEGRADED'
    const statusColor = overallStatus === 'HEALTHY' ? 'var(--green)' : 'var(--yellow)'

    // Service rows
    const serviceRows = serviceResults.map(s => {
      const statusBadge = s.status === 'UP'
        ? '<span class="badge badge-green">UP</span>'
        : '<span class="badge badge-red">DOWN</span>'
      return `
        <tr>
          <td>${esc(s.name)}</td>
          <td class="mono">:${s.port}</td>
          <td>${statusBadge}</td>
          <td class="mono">${s.latency}ms</td>
        </tr>`
    }).join('')

    const content = `
      <style>
        .health-status-banner {
          display: flex; align-items: center; gap: 16px;
          padding: 20px 24px; border-radius: 12px; margin-bottom: 24px;
          border: 1px solid var(--god-border);
        }
        .health-status-banner.healthy { background: rgba(34, 197, 94, 0.08); border-color: rgba(34, 197, 94, 0.3); }
        .health-status-banner.degraded { background: rgba(234, 179, 8, 0.08); border-color: rgba(234, 179, 8, 0.3); }
        .health-status-dot {
          width: 16px; height: 16px; border-radius: 50%;
          flex-shrink: 0;
        }
        .health-status-text { font-size: 20px; font-weight: 700; }
        .health-status-sub { font-size: 13px; color: var(--god-text-muted); margin-left: auto; }

        .gauge-item { margin-bottom: 16px; }
        .gauge-header { display: flex; justify-content: space-between; margin-bottom: 6px; }
        .gauge-label { font-size: 13px; color: var(--god-text-secondary); font-weight: 500; }
        .gauge-value { font-size: 13px; font-weight: 700; font-family: 'SF Mono', Monaco, monospace; }
        .gauge-track {
          height: 8px; background: var(--god-border); border-radius: 4px; overflow: hidden;
        }
        .gauge-fill {
          height: 100%; border-radius: 4px; transition: width 0.5s ease;
        }
      </style>

      <div class="page-header">
        <h1>System Health</h1>
      </div>

      <div class="health-status-banner ${overallStatus === 'HEALTHY' ? 'healthy' : 'degraded'}">
        <div class="health-status-dot" style="background:${statusColor}"></div>
        <div class="health-status-text" style="color:${statusColor}">${overallStatus}</div>
        <div class="health-status-sub">Checked at ${new Date().toLocaleTimeString('en-US')}</div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Node.js Version</div>
          <div class="stat-value" style="font-size:18px">${process.version}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Platform</div>
          <div class="stat-value" style="font-size:18px">${process.platform} ${process.arch}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Uptime</div>
          <div class="stat-value" style="font-size:18px">${formatUptime(uptime)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">PID</div>
          <div class="stat-value" style="font-size:18px">${process.pid}</div>
        </div>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-title" style="margin-bottom:16px">Resource Usage</div>
          ${gaugeHtml('CPU Usage', cpuPct.toFixed(1) + '%', cpuPct)}
          ${gaugeHtml('Heap Used / RSS', formatBytes(mem.heapUsed) + ' / ' + formatBytes(mem.rss), memPct)}
          ${gaugeHtml('Heap Used / Total', formatBytes(mem.heapUsed) + ' / ' + formatBytes(mem.heapTotal), mem.heapTotal > 0 ? (mem.heapUsed / mem.heapTotal) * 100 : 0)}
          ${gaugeHtml('External Memory', formatBytes(mem.external), Math.min(100, (mem.external / (256 * 1024 * 1024)) * 100))}
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:16px">Database</div>
          <div class="info-row">
            <span class="info-label">Database Size</span>
            <span class="info-value mono">${esc(dbSize)}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Active Connections</span>
            <span class="info-value mono">${esc(dbActiveConns)}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Max Connections</span>
            <span class="info-value mono">${esc(dbMaxConns)}</span>
          </div>
          ${dbActiveConns !== 'Unknown' && dbMaxConns !== 'Unknown'
            ? gaugeHtml('Connection Pool', dbActiveConns + ' / ' + dbMaxConns, (Number(dbActiveConns) / Number(dbMaxConns)) * 100)
            : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Service Status</div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Port</th>
              <th>Status</th>
              <th>Latency</th>
            </tr>
          </thead>
          <tbody>${serviceRows}</tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Memory Breakdown</div>
        <div class="info-row">
          <span class="info-label">RSS (Resident Set)</span>
          <span class="info-value mono">${formatBytes(mem.rss)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Heap Total</span>
          <span class="info-value mono">${formatBytes(mem.heapTotal)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Heap Used</span>
          <span class="info-value mono">${formatBytes(mem.heapUsed)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">External</span>
          <span class="info-value mono">${formatBytes(mem.external)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Array Buffers</span>
          <span class="info-value mono">${formatBytes(mem.arrayBuffers)}</span>
        </div>
      </div>
    `

    res.send(godLayout({
      title: 'System Health',
      userEmail: user.email,
      activePath: '/god-admin/health-check',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Health check error:', err)
    res.status(500).send(godLayout({
      title: 'System Health',
      userEmail: user.email,
      activePath: '/god-admin/health-check',
      content: `<div class="card"><p style="color:var(--red)">Error loading health check: ${esc(String(err))}</p></div>`,
    }))
  }
}
