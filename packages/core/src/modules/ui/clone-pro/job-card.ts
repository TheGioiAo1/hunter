/**
 * JobCard — the "Active job" card on the clone-pro index page.
 * Three variants map to the three non-terminal states:
 *   - running — progress bar + current substep + Cancel button
 *   - paused  — amber accent + Resume button
 *   - failed  — red accent + error message + Resume-from-phase button
 *
 * Uses DashboardJobRow from dashboard-queries (the canonical read
 * projection) so there is no re-mapping layer above.
 */

import type { DashboardJobRow } from '../../clone-pro/dashboard-queries.js'
import { esc } from './esc.js'

export type JobCardVariant = 'running' | 'failed' | 'paused'

export interface JobCardProps {
  job: DashboardJobRow
  variant: JobCardVariant
  baseUrl: string
}

const ACCENT: Record<JobCardVariant, string> = {
  running: 'var(--status-running)',
  failed: 'var(--status-failed)',
  paused: 'var(--status-paused)',
}

function age(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d).getTime() : d.getTime()
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function renderJobCard(p: JobCardProps): string {
  const accent = ACCENT[p.variant]
  const pct = p.job.phase_progress_pct ?? 0
  const detail = `${p.baseUrl}/clone-pro/${encodeURIComponent(p.job.id)}`
  const errorBlock =
    p.variant === 'failed' && p.job.error_message
      ? `<div class="gbx-job-err"><code>${esc(p.job.error_message)}</code></div>`
      : ''
  const primary =
    p.variant === 'failed'
      ? `<a href="${detail}" class="gbx-btn-amber">Resume from Phase ${p.job.current_phase}</a>`
      : p.variant === 'paused'
        ? `<a href="${detail}" class="gbx-btn-amber">Resume</a>`
        : `<a href="${detail}" class="gbx-btn-ghost">View timeline</a>`
  const secondary =
    p.variant === 'running'
      ? `<form method="post" action="${detail}/cancel" class="gbx-inline-form"><button class="gbx-btn-danger" aria-label="Cancel job">Cancel</button></form>`
      : `<form method="post" action="${detail}/discard" class="gbx-inline-form"><button class="gbx-btn-ghost" aria-label="Discard job">Discard</button></form>`
  const progress =
    p.variant === 'running'
      ? `
  <div class="gbx-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Clone progress">
    <div class="gbx-progress-fill" style="width:${pct}%;background:var(--phase-gradient)"></div>
  </div>
  <div class="gbx-job-substep">⚙️ ${esc(p.job.substep ?? 'Working…')}</div>`
      : ''
  return `
<article class="gbx-job-card" style="border-left-color:${accent}">
  <header>
    <div class="gbx-job-title">${esc(safeHost(p.job.source_url))}</div>
    <div class="gbx-job-sub">Started ${age(p.job.created_at)} · Phase ${p.job.current_phase} of 3</div>
  </header>${progress}
  ${errorBlock}
  <footer class="gbx-job-footer">${primary}${secondary}</footer>
</article>`
}

export const jobCardCss = `
.gbx-job-card { background:var(--surface-1);border:1px solid var(--border);border-left:3px solid;border-radius:8px;padding:14px 16px;margin-bottom:12px }
.gbx-job-card header { margin-bottom:10px }
.gbx-job-title { color:var(--text);font-weight:700;font-size:14px }
.gbx-job-sub { color:var(--text-muted);font-size:11px;margin-top:2px }
.gbx-progress { height:6px;background:var(--surface-0);border-radius:3px;overflow:hidden;margin:8px 0 }
.gbx-progress-fill { height:100%;transition:width .4s ease }
.gbx-job-substep { color:var(--text-muted);font-size:11px }
.gbx-job-err { background:var(--surface-0);border-radius:4px;padding:6px 8px;margin:8px 0;font-size:11px;color:var(--status-failed);font-family:ui-monospace,monospace }
.gbx-job-footer { display:flex;gap:8px;margin-top:10px }
.gbx-inline-form { margin:0;display:inline }
`
