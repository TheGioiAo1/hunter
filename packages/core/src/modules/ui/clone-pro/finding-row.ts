/**
 * FindingRow — a single verification finding in the breakdown list
 * below the check grid. Severity drives both the icon and the
 * accent color, with optional inline action links (e.g. "Fix", "Ignore").
 *
 * `data-severity` attribute lets the client-side filter tabs
 * (critical / warning / all) hide rows without a re-render.
 */

import { esc } from './esc.js'

export type FindingSeverity = 'critical' | 'warning' | 'info'

export interface FindingAction {
  label: string
  href: string
}

export interface Finding {
  severity: FindingSeverity
  title: string
  body: string
  actions?: FindingAction[]
}

export interface FindingRowProps {
  finding: Finding
}

const COLOR: Record<FindingSeverity, string> = {
  critical: 'var(--status-failed)',
  warning: 'var(--status-paused)',
  info: 'var(--status-running)',
}

const ICON: Record<FindingSeverity, string> = {
  critical: '!',
  warning: '⚠',
  info: 'ℹ',
}

export function renderFindingRow(p: FindingRowProps): string {
  const { severity, title, body, actions } = p.finding
  const color = COLOR[severity]
  const icon = ICON[severity]
  const actionsBlock =
    actions && actions.length > 0
      ? `<div class="gbx-finding-actions">${actions
          .map((a) => `<a href="${esc(a.href)}" class="gbx-finding-action">${esc(a.label)}</a>`)
          .join('')}</div>`
      : ''
  return `
<div class="gbx-finding" data-severity="${esc(severity)}" style="--finding-color:${color}">
  <div class="gbx-finding-icon" style="background:${color}" aria-hidden="true">${icon}</div>
  <div class="gbx-finding-body">
    <div class="gbx-finding-title">${esc(title)}</div>
    <div class="gbx-finding-text">${esc(body)}</div>
    ${actionsBlock}
  </div>
</div>`
}

export const findingRowCss = `
.gbx-finding { display:grid;grid-template-columns:24px 1fr;gap:10px;padding:10px;border:1px solid var(--border);border-left:3px solid var(--finding-color);border-radius:6px;background:var(--surface-2);margin-bottom:8px }
.gbx-finding-icon { width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:11px }
.gbx-finding-title { color:var(--text);font-weight:600;font-size:13px }
.gbx-finding-text { color:var(--text-muted);font-size:12px;margin-top:2px;line-height:1.5 }
.gbx-finding-actions { margin-top:6px;display:flex;gap:8px }
.gbx-finding-action { color:var(--finding-color);font-size:11px;text-decoration:none;font-weight:600 }
.gbx-finding-action:hover { text-decoration:underline }
`
