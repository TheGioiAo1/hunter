/**
 * God Admin — Alert Center Page (Category A4: Alert Center)
 *
 * GET /god-admin/alerts
 *
 * Aggregates alerts from DB queries:
 * - Low stock products (inventory_quantity < 5)
 * - Payment failures in last 24h
 * - Security: failed logins > 10/hour from same IP
 * - Inactive stores (0 orders in 7 days)
 * - System: memory > 80%
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

interface Alert {
  severity: 'critical' | 'warning' | 'info'
  category: string
  title: string
  description: string
  count: number
  timestamp: string
}

function severityBadge(severity: string): string {
  const map: Record<string, string> = {
    critical: 'badge-red',
    warning: 'badge-yellow',
    info: 'badge-blue',
  }
  return `<span class="badge ${map[severity] || 'badge-gray'}">${severity.toUpperCase()}</span>`
}

function severityIcon(severity: string): string {
  if (severity === 'critical') {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
  }
  if (severity === 'warning') {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--yellow)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  }
  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function getAlerts(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const now = new Date()
  const nowIso = now.toISOString()
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()

  try {
    const alerts: Alert[] = []

    // 1. Low stock products
    try {
      const lowStockResult = await db.selectFrom('products')
        .where('inventory_quantity', '<', 5)
        .where('status', '=', 'active')
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst()

      const lowStockCount = Number(lowStockResult?.count ?? 0)
      if (lowStockCount > 0) {
        alerts.push({
          severity: lowStockCount > 20 ? 'critical' : 'warning',
          category: 'Inventory',
          title: 'Low Stock Products',
          description: `${lowStockCount} active product(s) have inventory below 5 units.`,
          count: lowStockCount,
          timestamp: nowIso,
        })
      }
    } catch {
      // products table may not have inventory_quantity column yet
    }

    // 2. Payment failures in last 24h
    try {
      const paymentFailResult = await db.selectFrom('transactions')
        .where('status', '=', 'failure')
        .where('created_at', '>=', twentyFourHoursAgo)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst()

      const failCount = Number(paymentFailResult?.count ?? 0)
      if (failCount > 0) {
        alerts.push({
          severity: failCount > 10 ? 'critical' : 'warning',
          category: 'Payments',
          title: 'Payment Failures (24h)',
          description: `${failCount} transaction(s) failed in the last 24 hours.`,
          count: failCount,
          timestamp: nowIso,
        })
      }
    } catch {
      // transactions table may not exist yet
    }

    // 3. Security: failed logins > 10/hour from same IP
    try {
      const bruteForceResult = await sql<{ ip_address: string; fail_count: string }>`
        SELECT ip_address, count(*) as fail_count
        FROM audit_logs
        WHERE action = 'login_failed'
          AND created_at >= ${oneHourAgo}
        GROUP BY ip_address
        HAVING count(*) > 10
        ORDER BY count(*) DESC
      `.execute(db)

      const suspiciousIps = bruteForceResult.rows.length
      if (suspiciousIps > 0) {
        const totalAttempts = bruteForceResult.rows.reduce((sum, r) => sum + Number(r.fail_count), 0)
        alerts.push({
          severity: 'critical',
          category: 'Security',
          title: 'Brute Force Detected',
          description: `${suspiciousIps} IP(s) with >10 failed login attempts in the last hour (${totalAttempts} total attempts).`,
          count: suspiciousIps,
          timestamp: nowIso,
        })
      }
    } catch {
      // audit_logs may not have the expected columns
    }

    // 4. Inactive stores (0 orders in 7 days)
    try {
      const inactiveResult = await sql<{ count: string }>`
        SELECT count(*) as count
        FROM shops s
        WHERE s.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM orders o
            WHERE o.shop_id = s.id
              AND o.created_at >= ${sevenDaysAgo}
          )
      `.execute(db)

      const inactiveCount = Number(inactiveResult.rows[0]?.count ?? 0)
      if (inactiveCount > 0) {
        alerts.push({
          severity: 'info',
          category: 'Stores',
          title: 'Inactive Stores (7 days)',
          description: `${inactiveCount} active store(s) have received zero orders in the past 7 days.`,
          count: inactiveCount,
          timestamp: nowIso,
        })
      }
    } catch {
      // shops/orders tables may differ
    }

    // 5. System: memory > 80%
    const mem = process.memoryUsage()
    const memPct = mem.heapTotal > 0 ? (mem.heapUsed / mem.heapTotal) * 100 : 0
    if (memPct > 80) {
      alerts.push({
        severity: memPct > 95 ? 'critical' : 'warning',
        category: 'System',
        title: 'High Memory Usage',
        description: `Heap memory usage is at ${memPct.toFixed(1)}% (${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB / ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB).`,
        count: 1,
        timestamp: nowIso,
      })
    }

    // Sort: critical first, then warning, then info
    const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 }
    alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

    // Summary counts
    const criticalCount = alerts.filter(a => a.severity === 'critical').length
    const warningCount = alerts.filter(a => a.severity === 'warning').length
    const infoCount = alerts.filter(a => a.severity === 'info').length

    const alertListHtml = alerts.length > 0
      ? alerts.map(a => `
          <div class="alert-item alert-${a.severity}">
            <div class="alert-icon">${severityIcon(a.severity)}</div>
            <div class="alert-body">
              <div class="alert-top">
                <div class="alert-title">${esc(a.title)}</div>
                <div class="alert-meta">
                  ${severityBadge(a.severity)}
                  <span class="badge badge-gray">${esc(a.category)}</span>
                  <span class="alert-count">${a.count}</span>
                </div>
              </div>
              <div class="alert-desc">${esc(a.description)}</div>
            </div>
          </div>`).join('')
      : `<div class="empty-state">
           <div class="empty-state-icon">&#10003;</div>
           <div class="empty-state-text">All clear! No active alerts.</div>
         </div>`

    const content = `
      <style>
        .alert-summary {
          display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap;
        }
        .alert-summary-item {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 16px; border-radius: 10px;
          background: var(--god-bg-elevated); border: 1px solid var(--god-border);
          font-size: 14px; font-weight: 600;
        }
        .alert-summary-count { font-size: 22px; font-weight: 700; }
        .alert-summary-label { font-size: 12px; color: var(--god-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

        .alert-item {
          display: flex; gap: 14px; padding: 16px 20px;
          border-radius: 10px; margin-bottom: 12px;
          background: var(--god-bg-elevated); border: 1px solid var(--god-border);
          transition: border-color 0.15s;
        }
        .alert-item:hover { border-color: var(--god-border-light); }
        .alert-critical { border-left: 3px solid var(--red); }
        .alert-warning { border-left: 3px solid var(--yellow); }
        .alert-info { border-left: 3px solid var(--blue); }

        .alert-icon { flex-shrink: 0; padding-top: 2px; }
        .alert-body { flex: 1; min-width: 0; }
        .alert-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
        .alert-title { font-size: 15px; font-weight: 600; color: var(--god-text); }
        .alert-meta { display: flex; align-items: center; gap: 8px; }
        .alert-desc { font-size: 13px; color: var(--god-text-secondary); line-height: 1.5; }
        .alert-count {
          background: var(--god-bg-hover); color: var(--god-text);
          font-size: 12px; font-weight: 700; padding: 2px 8px;
          border-radius: 10px; min-width: 24px; text-align: center;
        }
      </style>

      <div class="page-header">
        <h1>Alert Center</h1>
      </div>

      <div class="alert-summary">
        <div class="alert-summary-item">
          <div>
            <div class="alert-summary-count" style="color:var(--red)">${criticalCount}</div>
            <div class="alert-summary-label">Critical</div>
          </div>
        </div>
        <div class="alert-summary-item">
          <div>
            <div class="alert-summary-count" style="color:var(--yellow)">${warningCount}</div>
            <div class="alert-summary-label">Warning</div>
          </div>
        </div>
        <div class="alert-summary-item">
          <div>
            <div class="alert-summary-count" style="color:var(--blue)">${infoCount}</div>
            <div class="alert-summary-label">Info</div>
          </div>
        </div>
        <div class="alert-summary-item">
          <div>
            <div class="alert-summary-count" style="color:var(--god-text)">${alerts.length}</div>
            <div class="alert-summary-label">Total</div>
          </div>
        </div>
      </div>

      <div class="alerts-list">
        ${alertListHtml}
      </div>
    `

    res.send(godLayout({
      title: 'Alert Center',
      userEmail: user.email,
      activePath: '/god-admin/alerts',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Alerts error:', err)
    res.status(500).send(godLayout({
      title: 'Alert Center',
      userEmail: user.email,
      activePath: '/god-admin/alerts',
      content: `<div class="card"><p style="color:var(--red)">Error loading alerts: ${esc(String(err))}</p></div>`,
    }))
  }
}
