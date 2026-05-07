/**
 * JobTableRow — one row in the compact history table on the index
 * page. Columns: job id (short) | source host | status pill | grade
 * badge (sm) or em-dash | pages | cost | age | View link.
 *
 * Reuses GradeBadge (B1) in size=sm for the grade cell.
 */

import type { DashboardJobRow } from '../../clone-pro/dashboard-queries.js'
import { esc } from './esc.js'
import { renderGradeBadge, type Grade } from './grade-badge.js'

export interface JobTableRowProps {
  job: DashboardJobRow
  baseUrl: string
}

const KNOWN_STATUSES: Record<string, string> = {
  queued: 'var(--status-queued)',
  running: 'var(--status-running)',
  paused: 'var(--status-paused)',
  failed: 'var(--status-failed)',
  succeeded: 'var(--status-succeeded)',
  published: 'var(--status-published)',
  cancelled: 'var(--text-muted)',
  discarded: 'var(--text-muted)',
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function age(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d).getTime() : d.getTime()
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function fmtCost(cents: number): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`
}

export function renderJobTableRow(p: JobTableRowProps): string {
  const j = p.job
  const statusColor = KNOWN_STATUSES[j.status] ?? 'var(--text-muted)'
  const short = j.id.slice(0, 8)
  const detail = `${p.baseUrl}/clone-pro/${encodeURIComponent(j.id)}`
  const gradeCell = j.grade
    ? renderGradeBadge({ grade: j.grade as Grade, score: j.score ?? undefined, size: 'sm' })
    : '<span class="gbx-row-empty">—</span>'
  return `  <tr class="gbx-job-row">
    <td><code class="gbx-job-id">${esc(short)}</code></td>
    <td class="gbx-job-host">${esc(safeHost(j.source_url))}</td>
    <td><span class="gbx-status-pill" style="color:${statusColor};border-color:${statusColor}">${esc(j.status)}</span></td>
    <td>${gradeCell}</td>
    <td>${j.page_count ?? '—'}</td>
    <td>${fmtCost(j.cost_cents)}</td>
    <td class="gbx-job-age">${age(j.created_at)}</td>
    <td><a class="gbx-row-link" href="${detail}">View →</a></td>
  </tr>`
}

export const jobTableRowCss = `
.gbx-job-row { border-top:1px solid var(--border) }
.gbx-job-row td { padding:10px 8px;font-size:12px;color:var(--text);vertical-align:middle }
.gbx-job-id { font-family:ui-monospace,monospace;font-size:11px;color:var(--text-muted) }
.gbx-job-host { color:var(--text);font-weight:500 }
.gbx-status-pill { display:inline-block;padding:2px 8px;border:1px solid;border-radius:999px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;font-weight:600 }
.gbx-row-empty { color:var(--text-muted) }
.gbx-job-age { color:var(--text-muted) }
.gbx-row-link { color:var(--text-muted);text-decoration:none }
.gbx-row-link:hover { color:var(--text) }
`
