/**
 * ReadyBanner — the green gradient "ready to publish" banner shown
 * at the top of the clone-pro index page when a job has finished
 * verification (`status=succeeded`, not yet published/discarded).
 *
 * Two CTAs: Preview (GET → detail page) and Publish now (POST →
 * /publish with CSRF token).
 */

import type { DashboardJobRow } from '../../clone-pro/dashboard-queries.js'
import { esc } from './esc.js'

export interface ReadyBannerProps {
  job: DashboardJobRow
  baseUrl: string
  csrfToken: string
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function renderReadyBanner(p: ReadyBannerProps): string {
  const { job, baseUrl, csrfToken } = p
  const detail = `${baseUrl}/clone-pro/${encodeURIComponent(job.id)}`
  const scoreStr = job.score != null ? `${job.score}/100` : ''
  return `
<section class="gbx-ready-banner" role="region" aria-label="Clone ready to publish" style="background:var(--clone-accent-gradient)">
  <div class="gbx-ready-content">
    <div class="gbx-ready-title">Clone ready to publish</div>
    <div class="gbx-ready-sub">${esc(safeHost(job.source_url))} · Grade ${esc(job.grade ?? '—')} ${esc(scoreStr)}</div>
  </div>
  <div class="gbx-ready-actions">
    <a href="${detail}" class="gbx-btn-ghost">Preview</a>
    <form method="post" action="${detail}/publish" class="gbx-inline-form">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <button type="submit" class="gbx-btn-publish">Publish now</button>
    </form>
  </div>
</section>`
}

export const readyBannerCss = `
.gbx-ready-banner { background:var(--clone-accent-gradient);border-radius:10px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;color:#fff;margin-bottom:16px }
.gbx-ready-title { font-weight:800;font-size:16px }
.gbx-ready-sub { font-size:12px;opacity:.9;margin-top:2px }
.gbx-ready-actions { display:flex;gap:8px;align-items:center }
.gbx-btn-publish { background:#fff;color:var(--surface-0);border:none;border-radius:6px;padding:8px 14px;font-weight:700;cursor:pointer }
.gbx-btn-publish:hover { transform:translateY(-1px) }
`
