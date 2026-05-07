/**
 * CheckScore — one of the five verification score tiles used on the
 * detail page after a clone succeeds. Shows the check name, score,
 * and a left-border color reflecting pass/warn/fail.
 */

import { esc } from './esc.js'

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckScoreProps {
  name: string
  score: number
  status: CheckStatus
  weight?: number
  sub?: string
}

const STATUS_VAR: Record<CheckStatus, string> = {
  pass: 'var(--status-succeeded)',
  warn: 'var(--status-paused)',
  fail: 'var(--status-failed)',
}

export function renderCheckScore(p: CheckScoreProps): string {
  const color = STATUS_VAR[p.status]
  const meta =
    p.weight != null || p.sub
      ? `${p.weight != null ? `weight ${p.weight}×` : ''}${p.sub ? ` · ${esc(p.sub)}` : ''}`
      : ''
  return `
<div class="gbx-check" style="border-left-color:${color}">
  <div class="gbx-check-name">${esc(p.name)}</div>
  <div class="gbx-check-score" style="color:${color}">${p.score}</div>
  <div class="gbx-check-meta">${meta}</div>
</div>`
}

export const checkScoreCss = `
.gbx-check { background:var(--surface-2);border:1px solid var(--border);border-left:3px solid;border-radius:6px;padding:10px }
.gbx-check-name { color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em }
.gbx-check-score { font-size:22px;font-weight:800;margin:2px 0 }
.gbx-check-meta { color:var(--text-muted);font-size:10px;min-height:12px }
`
