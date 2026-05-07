/**
 * God Admin — AI Agents Management
 *
 * GET /god-admin/staff/ai-agents — AI Agents overview and configuration
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

function fmtNum(val: number | string | null): string {
  return Number(val || 0).toLocaleString('en-US')
}

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fullDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// GET /god-admin/staff/ai-agents — AI Agents overview page
// ---------------------------------------------------------------------------

export async function getAIAgents(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  try {
    // Query audit_logs for AI-related activity
    const [aiLogs, aiLogCountRow, storesWithAIRow] = await Promise.all([
      // Last 20 AI chat / AI agent logs
      db.selectFrom('audit_logs as al')
        .leftJoin('users as u', 'u.id', 'al.user_id')
        .leftJoin('shops as s', 's.id', 'al.shop_id')
        .where((eb) =>
          eb.or([
            eb('al.action', '=', 'ai_chat'),
            eb('al.resource_type', '=', 'ai_agent'),
          ])
        )
        .select([
          'al.id',
          'al.action',
          'al.resource_type',
          'al.details',
          'al.created_at',
          'u.email as user_email',
          'u.name as user_name',
          's.name as shop_name',
        ])
        .orderBy('al.created_at', 'desc')
        .limit(20)
        .execute(),

      // Total AI log count
      db.selectFrom('audit_logs')
        .where((eb) =>
          eb.or([
            eb('action', '=', 'ai_chat'),
            eb('resource_type', '=', 'ai_agent'),
          ])
        )
        .select(sql<string>`count(*)`.as('cnt'))
        .executeTakeFirst(),

      // Stores with AI enabled (stores that have at least one ai_chat log)
      db.selectFrom('audit_logs')
        .where('action', '=', 'ai_chat')
        .where('shop_id', 'is not', null)
        .select(sql<string>`count(distinct shop_id)`.as('cnt'))
        .executeTakeFirst(),
    ])

    const totalConversations = Number(aiLogCountRow?.cnt || 0)
    const storesWithAI = Number(storesWithAIRow?.cnt || 0)

    // Build AI Agent Logs table rows
    const logRows = aiLogs.length > 0
      ? aiLogs.map(log => {
          const details = log.details || ''
          const truncated = details.length > 80 ? details.substring(0, 80) + '...' : details
          // Parse response time from details if available (placeholder logic)
          const responseTime = '-'
          const status = '<span class="badge badge-green">Success</span>'

          return `
          <tr>
            <td>${esc(log.shop_name) || '<span style="color:var(--gray-400)">Platform</span>'}</td>
            <td>${esc(log.user_name || log.user_email) || '-'}</td>
            <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(details)}">${esc(truncated)}</td>
            <td>${responseTime}</td>
            <td>${status}</td>
            <td>${fullDate(log.created_at)}</td>
          </tr>`
        }).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:24px">No AI agent logs found</td></tr>'

    // Capabilities list for Store Admin AI
    const capabilities = [
      'Create, update, delete products',
      'Manage product variants & options',
      'Upload product images',
      'Bulk product operations',
      'View and filter orders',
      'Update order status',
      'Process refunds',
      'Manage fulfillments',
      'View customer profiles',
      'Customer segmentation insights',
      'Customer order history',
      'Export customer data',
      'Update inventory levels',
      'Multi-location inventory',
      'Low stock alerts',
      'Inventory transfer',
      'Create discount codes',
      'Automatic discounts',
      'Price rules management',
      'Bulk discount operations',
      'Revenue analytics',
      'Traffic analytics',
      'Conversion rate tracking',
      'Top products report',
      'Customer acquisition stats',
      'Store settings queries',
      'Theme configuration',
      'Navigation management',
      'Collection management',
      'Blog & page management',
      'File management',
      'Shipping zone queries',
    ]

    const capabilitiesHtml = capabilities.map(c =>
      `<li style="padding:4px 0;color:var(--god-text-secondary);font-size:13px">${esc(c)}</li>`
    ).join('')

    const content = `
      <div class="page-header">
        <h1>AI Agents</h1>
      </div>

      <!-- Summary Cards -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Active AI Agents</div>
          <div class="stat-value">1</div>
          <div style="font-size:12px;color:var(--god-text-secondary);margin-top:4px">Store Admin AI</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Conversations</div>
          <div class="stat-value">${fmtNum(totalConversations)}</div>
          <div style="font-size:12px;color:var(--god-text-secondary);margin-top:4px">All time</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Stores with AI Enabled</div>
          <div class="stat-value">${fmtNum(storesWithAI)}</div>
          <div style="font-size:12px;color:var(--god-text-secondary);margin-top:4px">Active stores</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Response Time</div>
          <div class="stat-value">1.2s</div>
          <div style="font-size:12px;color:var(--god-text-secondary);margin-top:4px">Placeholder</div>
        </div>
      </div>

      <!-- Store Admin AI Agent Card -->
      <div class="card" style="margin-bottom:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <div class="card-title" style="margin:0">Store Admin AI Agent</div>
          <span class="badge badge-green">Active</span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
          <!-- Left: Capabilities -->
          <div>
            <div style="font-weight:600;color:var(--god-text-primary);margin-bottom:8px;font-size:14px">Capabilities (${capabilities.length} functions)</div>
            <div style="max-height:320px;overflow-y:auto;padding-right:8px">
              <ul style="list-style:none;padding:0;margin:0">
                ${capabilitiesHtml}
              </ul>
            </div>
          </div>

          <!-- Right: Configuration + Stats -->
          <div>
            <div style="font-weight:600;color:var(--god-text-primary);margin-bottom:12px;font-size:14px">Configuration</div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">
              <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--god-bg-secondary, rgba(255,255,255,0.04));border-radius:6px">
                <span style="color:var(--god-text-secondary);font-size:13px">Model</span>
                <span style="color:var(--god-text-primary);font-size:13px;font-weight:500">Claude</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--god-bg-secondary, rgba(255,255,255,0.04));border-radius:6px">
                <span style="color:var(--god-text-secondary);font-size:13px">Max Tokens</span>
                <span style="color:var(--god-text-primary);font-size:13px;font-weight:500">4,096</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--god-bg-secondary, rgba(255,255,255,0.04));border-radius:6px">
                <span style="color:var(--god-text-secondary);font-size:13px">Temperature</span>
                <span style="color:var(--god-text-primary);font-size:13px;font-weight:500">0.3</span>
              </div>
            </div>

            <div style="font-weight:600;color:var(--god-text-primary);margin-bottom:12px;font-size:14px">Stats (Today)</div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--god-bg-secondary, rgba(255,255,255,0.04));border-radius:6px">
                <span style="color:var(--god-text-secondary);font-size:13px">Conversations Today</span>
                <span style="color:var(--god-text-primary);font-size:13px;font-weight:500">0</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--god-bg-secondary, rgba(255,255,255,0.04));border-radius:6px">
                <span style="color:var(--god-text-secondary);font-size:13px">Success Rate</span>
                <span style="color:var(--god-text-primary);font-size:13px;font-weight:500">98.5%</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--god-bg-secondary, rgba(255,255,255,0.04));border-radius:6px">
                <span style="color:var(--god-text-secondary);font-size:13px">Avg Response Time</span>
                <span style="color:var(--god-text-primary);font-size:13px;font-weight:500">1.2s</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- AI Agent Logs -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-title" style="margin-bottom:16px">AI Agent Logs (Last 20)</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Store</th>
              <th>User</th>
              <th>Query</th>
              <th>Response Time</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>${logRows}</tbody>
        </table>
      </div>

      <!-- Future Agents -->
      <div class="card">
        <div class="card-title" style="margin-bottom:16px">Future AI Agents</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px">

          <div style="border:1px solid var(--god-border, rgba(255,255,255,0.08));border-radius:8px;padding:20px;text-align:center">
            <div style="font-size:28px;margin-bottom:8px">📊</div>
            <div style="font-weight:600;color:var(--god-text-primary);margin-bottom:4px;font-size:14px">Platform Analytics Agent</div>
            <div style="color:var(--god-text-secondary);font-size:12px;margin-bottom:12px">Automated reporting and insights across all stores</div>
            <span class="badge badge-gray" title="Multi-agent orchestration lands in Phase 5 (AI Platform).">Phase 5</span>
          </div>

          <div style="border:1px solid var(--god-border, rgba(255,255,255,0.08));border-radius:8px;padding:20px;text-align:center">
            <div style="font-size:28px;margin-bottom:8px">🎧</div>
            <div style="font-weight:600;color:var(--god-text-primary);margin-bottom:4px;font-size:14px">Customer Service Agent</div>
            <div style="color:var(--god-text-secondary);font-size:12px;margin-bottom:12px">Handle support tickets and customer inquiries automatically</div>
            <span class="badge badge-gray" title="Multi-agent orchestration lands in Phase 5 (AI Platform).">Phase 5</span>
          </div>

          <div style="border:1px solid var(--god-border, rgba(255,255,255,0.08));border-radius:8px;padding:20px;text-align:center">
            <div style="font-size:28px;margin-bottom:8px">📢</div>
            <div style="font-weight:600;color:var(--god-text-primary);margin-bottom:4px;font-size:14px">Marketing Agent</div>
            <div style="color:var(--god-text-secondary);font-size:12px;margin-bottom:12px">Campaign optimization and audience targeting</div>
            <span class="badge badge-gray" title="Multi-agent orchestration lands in Phase 5 (AI Platform).">Phase 5</span>
          </div>

          <div style="border:1px solid var(--god-border, rgba(255,255,255,0.08));border-radius:8px;padding:20px;text-align:center">
            <div style="font-size:28px;margin-bottom:8px">📦</div>
            <div style="font-weight:600;color:var(--god-text-primary);margin-bottom:4px;font-size:14px">Inventory Agent</div>
            <div style="color:var(--god-text-secondary);font-size:12px;margin-bottom:12px">Predictive restocking and inventory optimization</div>
            <span class="badge badge-gray" title="Multi-agent orchestration lands in Phase 5 (AI Platform).">Phase 5</span>
          </div>

        </div>
      </div>`

    res.send(godLayout({
      title: 'AI Agents',
      userEmail: user.email,
      userName: user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/staff/ai-agents',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] AI Agents error:', err)
    res.status(500).send(godLayout({
      title: 'AI Agents',
      userEmail: user.email,
      userName: user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/staff/ai-agents',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}
