/**
 * PhaseTimeline — vertical rail with a dot per phase, rendered in
 * the left column of the detail page. Color + icon encode status
 * (done/active/pending/failed). Nodes are keyboard-focusable so
 * merchants can tab through and Enter to jump the main content to
 * that phase's anchor (runtime script lives on the page).
 */

import { esc } from './esc.js'

export type PhaseStatus = 'done' | 'active' | 'pending' | 'failed'

export interface Phase {
  id: string
  label: string
  status: PhaseStatus
  meta?: string
  substeps?: string[]
}

const COLOR: Record<PhaseStatus, string> = {
  done: 'var(--status-succeeded)',
  active: 'var(--status-running)',
  pending: 'var(--border)',
  failed: 'var(--status-failed)',
}

const ICON: Record<PhaseStatus, string> = {
  done: '✓',
  active: '◐',
  pending: '○',
  failed: '!',
}

export function renderPhaseTimeline(props: { phases: Phase[] }): string {
  const nodes = props.phases
    .map((p) => {
      const color = COLOR[p.status]
      const icon = ICON[p.status]
      const substeps = p.substeps
        ? `<ul class="gbx-phase-subs">${p.substeps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
        : ''
      return `
      <div class="gbx-phase-node" tabindex="0" data-phase-id="${esc(p.id)}" aria-label="${esc(p.label)}: ${p.status}">
        <div class="gbx-phase-dot" style="background:${color}">${icon}</div>
        <div class="gbx-phase-label" style="color:${color}">${esc(p.label)}</div>
        ${p.meta ? `<div class="gbx-phase-meta">${esc(p.meta)}</div>` : ''}
        ${substeps}
      </div>`
    })
    .join('')
  return `<div class="gbx-phase-timeline">${nodes}</div>`
}

export const phaseTimelineCss = `
.gbx-phase-timeline { position:relative;padding-left:4px }
.gbx-phase-node { position:relative;padding-left:32px;margin-bottom:18px;outline:none;cursor:pointer }
.gbx-phase-node:focus-visible .gbx-phase-dot { box-shadow:0 0 0 3px color-mix(in srgb,var(--status-running) 35%,transparent) }
.gbx-phase-dot { position:absolute;left:0;top:0;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700 }
.gbx-phase-label { font-size:12px;font-weight:600 }
.gbx-phase-meta { color:var(--text-muted);font-size:10px;margin-top:2px }
.gbx-phase-subs { list-style:none;padding-left:0;margin:8px 0 0;font-size:10px;color:var(--text-muted);line-height:1.7 }
`
