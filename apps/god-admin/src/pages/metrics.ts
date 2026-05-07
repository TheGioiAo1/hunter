/**
 * God Admin — Real-time Metrics Page (Category A2: Real-time Metrics)
 *
 * GET /god-admin/metrics         — HTML page with auto-refresh
 * GET /god-admin/api/metrics     — JSON API for AJAX refresh
 *
 * Displays:
 * - Orders per hour (last 24h)
 * - Active sessions count
 * - Revenue today vs yesterday (same hour comparison)
 * - Live activity feed (last 20 audit_logs)
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

function fmtMoney(val: string | number | null): string {
  const n = Number(val) || 0
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtNum(val: number | string | null): string {
  return Number(val || 0).toLocaleString('en-US')
}

function shortTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function pctChange(today: number, yesterday: number): string {
  if (yesterday === 0) return today > 0 ? '+100%' : '0%'
  const pct = ((today - yesterday) / yesterday) * 100
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

// ---------------------------------------------------------------------------
// Shared data fetcher
// ---------------------------------------------------------------------------

async function fetchMetricsData(db: Kysely<Database>) {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString()
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const currentHour = now.getHours()

  const [
    ordersPerHour,
    activeSessionsRow,
    revenueTodayRow,
    revenueYesterdayRow,
    activityFeed,
  ] = await Promise.all([
    // Orders per hour (last 24h)
    sql<{ hour: string; count: string }>`
      SELECT
        to_char(date_trunc('hour', created_at), 'YYYY-MM-DD HH24:00') as hour,
        count(*) as count
      FROM orders
      WHERE created_at >= ${twentyFourHoursAgo}
      GROUP BY date_trunc('hour', created_at)
      ORDER BY date_trunc('hour', created_at) ASC
    `.execute(db),

    // Active sessions
    db.selectFrom('sessions')
      .where('expires_at', '>', new Date().toISOString())
      .select(sql<string>`count(*)`.as('count'))
      .executeTakeFirst(),

    // Revenue today up to current hour
    db.selectFrom('orders')
      .where('financial_status', '=', 'paid')
      .where('created_at', '>=', todayStart)
      .select(sql<string>`coalesce(sum(total_price::numeric), 0)`.as('total'))
      .executeTakeFirst(),

    // Revenue yesterday up to same hour
    sql<{ total: string }>`
      SELECT coalesce(sum(total_price::numeric), 0) as total
      FROM orders
      WHERE financial_status = 'paid'
        AND created_at >= ${yesterdayStart}
        AND created_at < ${yesterdayStart}::timestamp + interval '${sql.raw(String(currentHour))} hours'
    `.execute(db),

    // Last 20 audit_log entries
    sql<{ id: string; action: string; resource_type: string; resource_id: string; user_id: string; ip_address: string; details: string; created_at: string }>`
      SELECT al.id, al.action, al.resource_type, al.resource_id,
             coalesce(u.email, al.user_id::text) as user_id,
             al.ip_address, al.details::text, al.created_at
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ORDER BY al.created_at DESC
      LIMIT 20
    `.execute(db),
  ])

  const revToday = Number(revenueTodayRow?.total ?? 0)
  const revYesterday = Number(revenueYesterdayRow?.rows?.[0]?.total ?? 0)

  return {
    ordersPerHour: ordersPerHour.rows,
    activeSessions: Number(activeSessionsRow?.count ?? 0),
    revenueToday: revToday,
    revenueYesterday: revYesterday,
    revenueChange: pctChange(revToday, revYesterday),
    activityFeed: activityFeed.rows,
    timestamp: now.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// JSON API endpoint
// ---------------------------------------------------------------------------

export async function getMetricsApi(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  try {
    const data = await fetchMetricsData(db)
    res.json(data)
  } catch (err) {
    console.error('[God Admin] Metrics API error:', err)
    res.status(500).json({ error: String(err) })
  }
}

// ---------------------------------------------------------------------------
// HTML page
// ---------------------------------------------------------------------------

export async function getMetrics(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  try {
    const data = await fetchMetricsData(db)

    // Orders per hour chart (simple bar chart via CSS)
    const maxOrders = Math.max(...data.ordersPerHour.map(r => Number(r.count)), 1)
    const ordersChartBars = data.ordersPerHour.map(r => {
      const count = Number(r.count)
      const pct = Math.round((count / maxOrders) * 100)
      const hourLabel = r.hour.split(' ')[1] || r.hour
      return `
        <div class="bar-group">
          <div class="bar-wrapper">
            <div class="bar" style="height:${pct}%" title="${count} orders"></div>
          </div>
          <div class="bar-label">${esc(hourLabel)}</div>
        </div>`
    }).join('')

    const emptyChart = data.ordersPerHour.length === 0
      ? '<div style="text-align:center;color:var(--god-text-muted);padding:40px">No order data in the last 24 hours</div>'
      : ''

    // Activity feed rows
    const activityRows = data.activityFeed.length > 0
      ? data.activityFeed.map(a => {
          const actionColor = ['login', 'create', 'enable'].some(k => a.action?.includes(k))
            ? 'var(--green)'
            : ['fail', 'delete', 'suspend', 'disable'].some(k => a.action?.includes(k))
              ? 'var(--red)'
              : 'var(--yellow)'
          return `
            <tr>
              <td><span style="color:${actionColor};font-weight:600">${esc(a.action)}</span></td>
              <td>${esc(a.user_id)}</td>
              <td class="mono">${esc(a.resource_type)}${a.resource_id ? ':' + esc(a.resource_id) : ''}</td>
              <td class="mono">${esc(a.ip_address)}</td>
              <td>${shortTime(a.created_at)}</td>
            </tr>`
        }).join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--god-text-muted);padding:24px">No recent activity</td></tr>'

    const content = `
      <style>
        .metrics-refresh-bar {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 20px; font-size: 12px; color: var(--god-text-muted);
        }
        .metrics-refresh-bar .refresh-dot {
          width: 8px; height: 8px; border-radius: 50%; background: var(--green);
          display: inline-block; margin-right: 6px; animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .bar-chart {
          display: flex; align-items: flex-end; gap: 4px;
          height: 200px; padding: 0 8px;
        }
        .bar-group {
          flex: 1; display: flex; flex-direction: column; align-items: center;
          min-width: 0;
        }
        .bar-wrapper {
          width: 100%; height: 180px; display: flex; align-items: flex-end;
          justify-content: center;
        }
        .bar {
          width: 70%; max-width: 30px; background: var(--god-accent);
          border-radius: 3px 3px 0 0; min-height: 2px;
          transition: height 0.3s ease;
        }
        .bar:hover { background: var(--god-accent-hover); }
        .bar-label {
          font-size: 9px; color: var(--god-text-muted); margin-top: 4px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          max-width: 100%;
        }
      </style>

      <div class="page-header">
        <h1>Real-time Metrics</h1>
      </div>

      <div class="metrics-refresh-bar">
        <span><span class="refresh-dot"></span> Auto-refreshing every 30s</span>
        <span id="lastUpdate">Last update: ${shortTime(data.timestamp)}</span>
      </div>

      <div class="stats-grid" id="metricsStats">
        <div class="stat-card">
          <div class="stat-label">Active Sessions</div>
          <div class="stat-value" id="activeSessions">${fmtNum(data.activeSessions)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Revenue Today</div>
          <div class="stat-value" id="revenueToday">${fmtMoney(data.revenueToday)}</div>
          <div class="stat-change ${data.revenueToday >= data.revenueYesterday ? 'up' : 'down'}" id="revenueChange">${data.revenueChange} vs yesterday (same hour)</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Revenue Yesterday</div>
          <div class="stat-value" id="revenueYesterday">${fmtMoney(data.revenueYesterday)}</div>
          <div class="stat-change" style="color:var(--god-text-muted)">Up to same hour</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Orders (24h)</div>
          <div class="stat-value" id="totalOrders24h">${fmtNum(data.ordersPerHour.reduce((sum, r) => sum + Number(r.count), 0))}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Orders Per Hour (Last 24h)</div>
        </div>
        <div class="bar-chart" id="ordersChart">
          ${emptyChart || ordersChartBars}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Live Activity Feed</div>
          <span class="badge badge-blue">${data.activityFeed.length} recent</span>
        </div>
        <table class="data-table" id="activityTable">
          <thead>
            <tr>
              <th>Action</th>
              <th>User</th>
              <th>Resource</th>
              <th>IP</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>${activityRows}</tbody>
        </table>
      </div>

      <script>
        setInterval(async () => {
          try {
            const resp = await fetch('/god-admin/api/metrics');
            if (!resp.ok) return;
            const data = await resp.json();

            // Update stats
            document.getElementById('activeSessions').textContent = Number(data.activeSessions).toLocaleString('en-US');
            document.getElementById('revenueToday').textContent = '$' + Number(data.revenueToday).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            document.getElementById('revenueYesterday').textContent = '$' + Number(data.revenueYesterday).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            document.getElementById('revenueChange').textContent = data.revenueChange + ' vs yesterday (same hour)';
            document.getElementById('totalOrders24h').textContent = data.ordersPerHour.reduce((s, r) => s + Number(r.count), 0).toLocaleString('en-US');

            // Update timestamp
            const ts = new Date(data.timestamp);
            document.getElementById('lastUpdate').textContent = 'Last update: ' + ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          } catch (e) {
            console.error('Metrics refresh failed:', e);
          }
        }, 30000);
      </script>
    `

    res.send(godLayout({
      title: 'Real-time Metrics',
      userEmail: user.email,
      activePath: '/god-admin/metrics',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Metrics page error:', err)
    res.status(500).send(godLayout({
      title: 'Real-time Metrics',
      userEmail: user.email,
      activePath: '/god-admin/metrics',
      content: `<div class="card"><p style="color:var(--red)">Error loading metrics: ${esc(String(err))}</p></div>`,
    }))
  }
}
