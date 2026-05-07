/**
 * God Admin — Clone Jobs Dashboard
 *
 * Overview and management of all Website Clone Pro jobs across all stores.
 * Provides: job listing, filtering, detail view, and job cancellation.
 *
 * Routes:
 *   GET  /god-admin/clone-jobs      — List all clone jobs
 *   GET  /god-admin/clone-jobs/:id  — Single job detail
 *   POST /god-admin/clone-jobs/:id/cancel — Cancel a running job
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Helper: escape HTML
// ---------------------------------------------------------------------------

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

function statusBadge(status: string): string {
  const map: Record<string, { color: string; bg: string }> = {
    queued: { color: '#6b7280', bg: '#f3f4f6' },
    running: { color: '#2563eb', bg: '#dbeafe' },
    succeeded: { color: '#16a34a', bg: '#dcfce7' },
    failed: { color: '#dc2626', bg: '#fee2e2' },
    cancelled: { color: '#9333ea', bg: '#f3e8ff' },
  }
  const style = map[status] || map.queued
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;color:${style.color};background:${style.bg}">${esc(status)}</span>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/clone-jobs — List all clone jobs
// ---------------------------------------------------------------------------

export async function getCloneJobs(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = (req as any).godAdmin!.user

  // Query params
  const statusFilter = (req.query.status as string) || 'all'
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1)
  const perPage = 25

  // Build query
  let query = db
    .selectFrom('clone_jobs' as any)
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(perPage)
    .offset((page - 1) * perPage)

  if (statusFilter !== 'all') {
    query = query.where('status', '=', statusFilter)
  }

  let jobs: any[] = []
  let totalJobs = 0
  let runningCount = 0
  let succeededCount = 0
  let failedCount = 0

  try {
    jobs = await query.execute()

    // Stats
    const stats = await db
      .selectFrom('clone_jobs' as any)
      .select(db.fn.count('id').as('total'))
      .executeTakeFirst()
    totalJobs = Number(stats?.total || 0)

    const runningStats = await db
      .selectFrom('clone_jobs' as any)
      .select(db.fn.count('id').as('count'))
      .where('status', '=', 'running')
      .executeTakeFirst()
    runningCount = Number(runningStats?.count || 0)

    const succeededStats = await db
      .selectFrom('clone_jobs' as any)
      .select(db.fn.count('id').as('count'))
      .where('status', '=', 'succeeded')
      .executeTakeFirst()
    succeededCount = Number(succeededStats?.count || 0)

    const failedStats = await db
      .selectFrom('clone_jobs' as any)
      .select(db.fn.count('id').as('count'))
      .where('status', '=', 'failed')
      .executeTakeFirst()
    failedCount = Number(failedStats?.count || 0)
  } catch {
    // clone_jobs table may not exist yet — show empty state
  }

  const content = `
    <style>
      .clone-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
      .stat-card { background: var(--god-surface); border: 1px solid var(--god-border); border-radius: 8px; padding: 1.25rem; }
      .stat-card .stat-value { font-size: 2rem; font-weight: 700; }
      .stat-card .stat-label { font-size: 0.8rem; color: var(--god-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
      .stat-card.running .stat-value { color: #2563eb; }
      .stat-card.success .stat-value { color: #16a34a; }
      .stat-card.failed .stat-value { color: #dc2626; }
      .filter-bar { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
      .filter-btn { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--god-border); background: transparent; color: var(--god-text); font-size: 0.8rem; cursor: pointer; text-decoration: none; }
      .filter-btn.active { background: var(--god-primary); color: #fff; border-color: var(--god-primary); }
      .jobs-table { width: 100%; border-collapse: collapse; }
      .jobs-table th { text-align: left; padding: 0.75rem; font-size: 0.75rem; color: var(--god-text-muted); text-transform: uppercase; border-bottom: 2px solid var(--god-border); }
      .jobs-table td { padding: 0.75rem; border-bottom: 1px solid var(--god-border); font-size: 0.85rem; }
      .jobs-table tr:hover { background: var(--god-surface); }
      .job-url { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .job-link { color: var(--god-primary); text-decoration: none; }
      .job-link:hover { text-decoration: underline; }
      .empty-state { text-align: center; padding: 4rem 2rem; color: var(--god-text-muted); }
      .progress-bar { width: 100px; height: 6px; background: var(--god-border); border-radius: 3px; overflow: hidden; display: inline-block; vertical-align: middle; }
      .progress-fill { height: 100%; background: #2563eb; border-radius: 3px; transition: width 0.3s; }
      @media (max-width: 768px) { .clone-stats { grid-template-columns: repeat(2, 1fr); } }
    </style>

    <h1 style="font-size:1.5rem;font-weight:700;margin-bottom:1.5rem">Clone Jobs</h1>

    <div class="clone-stats">
      <div class="stat-card">
        <div class="stat-value">${totalJobs}</div>
        <div class="stat-label">Total Jobs</div>
      </div>
      <div class="stat-card running">
        <div class="stat-value">${runningCount}</div>
        <div class="stat-label">Running Now</div>
      </div>
      <div class="stat-card success">
        <div class="stat-value">${succeededCount}</div>
        <div class="stat-label">Succeeded</div>
      </div>
      <div class="stat-card failed">
        <div class="stat-value">${failedCount}</div>
        <div class="stat-label">Failed</div>
      </div>
    </div>

    <div class="filter-bar">
      <a href="/god-admin/clone-jobs" class="filter-btn${statusFilter === 'all' ? ' active' : ''}">All</a>
      <a href="/god-admin/clone-jobs?status=running" class="filter-btn${statusFilter === 'running' ? ' active' : ''}">Running</a>
      <a href="/god-admin/clone-jobs?status=succeeded" class="filter-btn${statusFilter === 'succeeded' ? ' active' : ''}">Succeeded</a>
      <a href="/god-admin/clone-jobs?status=failed" class="filter-btn${statusFilter === 'failed' ? ' active' : ''}">Failed</a>
      <a href="/god-admin/clone-jobs?status=queued" class="filter-btn${statusFilter === 'queued' ? ' active' : ''}">Queued</a>
    </div>

    ${jobs.length > 0 ? `
      <table class="jobs-table">
        <thead>
          <tr>
            <th>Job ID</th>
            <th>Source URL</th>
            <th>Store</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Duration</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          ${jobs.map((job: any) => {
            const progress = job.progress_pct || 0
            const duration = job.finished_at && job.started_at
              ? Math.round((new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000) + 's'
              : job.started_at
                ? 'running...'
                : '-'
            const created = new Date(job.created_at).toLocaleString('en-US', {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })
            return `
              <tr>
                <td><a href="/god-admin/clone-jobs/${job.id}" class="job-link">${esc(String(job.id).slice(0, 8))}...</a></td>
                <td class="job-url" title="${esc(job.source_url || '')}">${esc(job.source_url || '-')}</td>
                <td>${esc(job.shop_id?.slice(0, 8) || '-')}...</td>
                <td>${statusBadge(job.status || 'queued')}</td>
                <td>
                  <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
                  <span style="font-size:0.75rem;margin-left:4px">${progress}%</span>
                </td>
                <td>${duration}</td>
                <td>${created}</td>
              </tr>
            `
          }).join('')}
        </tbody>
      </table>
    ` : `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 1rem">
          <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/><path d="M9 10h.01M15 10h.01M8 14s1.5 2 4 2 4-2 4-2"/>
        </svg>
        <h3 style="margin-bottom:0.5rem">No clone jobs yet</h3>
        <p>Website clone jobs will appear here when merchants use the Clone Pro tool.</p>
      </div>
    `}
  `

  res.send(godLayout({
    title: 'Clone Jobs — God Admin',
    userEmail: user.email,
    userName: user.name,
    isDefaultAdmin: user.role === 'owner',
    activePath: '/god-admin/clone-jobs',
    content,
  }))
}

// ---------------------------------------------------------------------------
// GET /god-admin/clone-jobs/:id — Single job detail
// ---------------------------------------------------------------------------

export async function getCloneJobDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = (req as any).godAdmin!.user
  const jobId = req.params.id

  let job: any = null
  try {
    job = await db
      .selectFrom('clone_jobs' as any)
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirst()
  } catch {
    // Table may not exist
  }

  if (!job) {
    res.status(404).send(godLayout({
      title: 'Clone Job Not Found',
      userEmail: user.email,
      userName: user.name,
      isDefaultAdmin: user.role === 'owner',
      activePath: '/god-admin/clone-jobs',
      content: `
        <div style="text-align:center;padding:4rem 2rem">
          <h2>Job Not Found</h2>
          <p style="color:var(--god-text-muted);margin:1rem 0">Clone job "${esc(jobId)}" does not exist.</p>
          <a href="/god-admin/clone-jobs" style="color:var(--god-primary)">← Back to Clone Jobs</a>
        </div>
      `,
    }))
    return
  }

  // Parse stages JSON
  let stages: any[] = []
  try {
    stages = typeof job.stages_json === 'string'
      ? JSON.parse(job.stages_json)
      : (job.stages_json || [])
  } catch { /* ignore */ }

  // Parse result JSON
  let result: any = null
  try {
    result = typeof job.result_json === 'string'
      ? JSON.parse(job.result_json)
      : job.result_json
  } catch { /* ignore */ }

  const duration = job.finished_at && job.started_at
    ? Math.round((new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000)
    : null

  const content = `
    <style>
      .detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
      .back-link { color: var(--god-text-muted); text-decoration: none; font-size: 0.85rem; }
      .back-link:hover { color: var(--god-primary); }
      .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 2rem; }
      .detail-card { background: var(--god-surface); border: 1px solid var(--god-border); border-radius: 8px; padding: 1rem; }
      .detail-label { font-size: 0.75rem; color: var(--god-text-muted); text-transform: uppercase; margin-bottom: 0.25rem; }
      .detail-value { font-size: 0.9rem; word-break: break-all; }
      .stages-list { list-style: none; padding: 0; }
      .stage-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid var(--god-border); }
      .stage-icon { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 0.75rem; }
      .stage-icon.succeeded { background: #dcfce7; color: #16a34a; }
      .stage-icon.failed { background: #fee2e2; color: #dc2626; }
      .stage-icon.running { background: #dbeafe; color: #2563eb; }
      .stage-icon.skipped { background: #f3f4f6; color: #6b7280; }
      .stage-icon.pending { background: #f3f4f6; color: #6b7280; }
      .stage-name { font-weight: 500; font-size: 0.85rem; }
      .stage-msg { font-size: 0.8rem; color: var(--god-text-muted); }
      .result-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
      .result-table td { padding: 0.4rem 0.75rem; font-size: 0.85rem; border-bottom: 1px solid var(--god-border); }
      .result-table td:first-child { font-weight: 500; width: 180px; }
    </style>

    <div class="detail-header">
      <div>
        <a href="/god-admin/clone-jobs" class="back-link">← Back to Clone Jobs</a>
        <h1 style="font-size:1.5rem;font-weight:700;margin-top:0.5rem">Clone Job Detail</h1>
      </div>
      ${statusBadge(job.status || 'queued')}
    </div>

    <div class="detail-grid">
      <div class="detail-card">
        <div class="detail-label">Source URL</div>
        <div class="detail-value"><a href="${esc(job.source_url || '')}" target="_blank" rel="noopener">${esc(job.source_url || '-')}</a></div>
      </div>
      <div class="detail-card">
        <div class="detail-label">Shop ID</div>
        <div class="detail-value">${esc(job.shop_id || '-')}</div>
      </div>
      <div class="detail-card">
        <div class="detail-label">Platform</div>
        <div class="detail-value">${esc(job.platform || 'detecting...')}</div>
      </div>
      <div class="detail-card">
        <div class="detail-label">Duration</div>
        <div class="detail-value">${duration !== null ? `${duration}s` : 'In progress...'}</div>
      </div>
      <div class="detail-card">
        <div class="detail-label">Created</div>
        <div class="detail-value">${job.created_at ? new Date(job.created_at).toLocaleString() : '-'}</div>
      </div>
      <div class="detail-card">
        <div class="detail-label">Progress</div>
        <div class="detail-value">${job.progress_pct || 0}%</div>
      </div>
    </div>

    <h2 style="font-size:1.1rem;font-weight:600;margin-bottom:1rem">Pipeline Stages</h2>
    ${stages.length > 0 ? `
      <ul class="stages-list">
        ${stages.map((s: any) => {
          const icon = s.status === 'succeeded' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'running' ? '⟳' : s.status === 'skipped' ? '−' : '○'
          return `
            <li class="stage-item">
              <div class="stage-icon ${s.status}">${icon}</div>
              <div>
                <div class="stage-name">${esc(s.stage)}</div>
                ${s.message ? `<div class="stage-msg">${esc(s.message)}</div>` : ''}
              </div>
            </li>
          `
        }).join('')}
      </ul>
    ` : '<p style="color:var(--god-text-muted)">No stage data available.</p>'}

    ${result ? `
      <h2 style="font-size:1.1rem;font-weight:600;margin:2rem 0 1rem">Result Summary</h2>
      <table class="result-table">
        ${result.productsImported !== undefined ? `<tr><td>Products Imported</td><td>${result.productsImported}</td></tr>` : ''}
        ${result.pagesImported !== undefined ? `<tr><td>Pages Imported</td><td>${result.pagesImported}</td></tr>` : ''}
        ${result.collectionsImported !== undefined ? `<tr><td>Collections Imported</td><td>${result.collectionsImported}</td></tr>` : ''}
        ${result.imagesIngested !== undefined ? `<tr><td>Images Ingested</td><td>${result.imagesIngested}</td></tr>` : ''}
        ${result.themeGenerated !== undefined ? `<tr><td>Theme Generated</td><td>${result.themeGenerated ? 'Yes' : 'No'}</td></tr>` : ''}
        ${result.duration_ms !== undefined ? `<tr><td>Pipeline Duration</td><td>${(result.duration_ms / 1000).toFixed(1)}s</td></tr>` : ''}
      </table>
    ` : ''}

    ${job.error_message ? `
      <h2 style="font-size:1.1rem;font-weight:600;margin:2rem 0 1rem;color:#dc2626">Error</h2>
      <pre style="background:var(--god-surface);border:1px solid var(--god-border);border-radius:8px;padding:1rem;font-size:0.8rem;overflow-x:auto">${esc(job.error_message)}</pre>
    ` : ''}
  `

  res.send(godLayout({
    title: `Clone Job ${jobId.slice(0, 8)} — God Admin`,
    userEmail: user.email,
    userName: user.name,
    isDefaultAdmin: user.role === 'owner',
    activePath: '/god-admin/clone-jobs',
    content,
  }))
}
