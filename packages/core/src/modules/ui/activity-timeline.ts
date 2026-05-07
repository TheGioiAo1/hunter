/**
 * Gbox Platform — Activity Timeline UI (Phase 2 Step 2.7)
 *
 * Shared renderer for the per-entity activity timeline. Callers
 * pass in a list of `ActivityRecord` from
 * `@gbox/core/modules/activity` and this module returns HTML + CSS
 * that matches the god-admin + seller-admin design tokens.
 *
 * Two render modes:
 *
 *   1. `activityTimeline()` — the full-page list used by the
 *      `/god-admin/activity` feed and the generic "Activity" tab on
 *      any entity detail page. Includes a dot-and-rail vertical
 *      timeline, action badge, actor, IP, relative time tooltip.
 *
 *   2. `activityTimelineCompact()` — a dense sidebar variant for
 *      the "Recent activity" panel on entity detail pages. Single
 *      line per event: badge + action + actor + time.
 *
 * Both variants escape all user-supplied text; `details` JSON is
 * rendered as a collapsed <details> block (tooltipped only).
 *
 * Triết lý: "clone giống hệt Shopify" (left rail + dot markers like
 * Shopify order timeline) + "power-ful hơn Shopify nhờ Claude"
 * (single typed categorizer maps any action name to a color,
 * zero per-page styling).
 */

import type { ActivityCategory, ActivityRecord } from '../activity/types.js'
import { categorizeAction, humanizeAction } from '../activity/types.js'
import { emptyState } from './empty-state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (!s) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Best-effort "2 minutes ago" style relative time string. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diffMs = now.getTime() - t
  if (diffMs < 0) return 'in the future'
  const s = Math.floor(diffMs / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s} seconds ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w} week${w === 1 ? '' : 's'} ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`
  const y = Math.floor(d / 365)
  return `${y} year${y === 1 ? '' : 's'} ago`
}

function absoluteTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function categoryClass(cat: ActivityCategory): string {
  switch (cat) {
    case 'success':
      return 'gbox-at-success'
    case 'danger':
      return 'gbox-at-danger'
    case 'warning':
      return 'gbox-at-warning'
    case 'info':
    default:
      return 'gbox-at-info'
  }
}

function resourceLabel(record: ActivityRecord): string {
  if (!record.resourceType) return ''
  if (!record.resourceId) return record.resourceType
  // Show only the last 8 chars of a uuid so the row stays readable.
  const id = record.resourceId
  const short = id.length > 12 ? id.slice(0, 8) : id
  return `${record.resourceType}:${short}`
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ActivityTimelineOptions {
  events: ActivityRecord[]
  /** Override "No activity yet." */
  emptyMessage?: string
  /**
   * Hide the resource column (e.g. when the timeline is already
   * scoped to a single entity, so every row would be the same).
   */
  hideResource?: boolean
  /**
   * Hide the actor column (e.g. when scoped to a single user's
   * activity).
   */
  hideActor?: boolean
  /**
   * Optional current date for relative-time rendering. Exposed so
   * tests can pass a fixed date; production callers omit this.
   */
  now?: Date
}

// ---------------------------------------------------------------------------
// Full-page timeline
// ---------------------------------------------------------------------------

/**
 * Render a vertical dot-rail timeline. One row per event, grouped
 * visually by a vertical rail on the left. Matches the look of the
 * Shopify order timeline.
 */
export function activityTimeline(opts: ActivityTimelineOptions): string {
  if (opts.events.length === 0) {
    return emptyState({
      variant: 'no-results',
      title: opts.emptyMessage ?? 'No activity yet',
      description:
        'Actions performed on this resource will appear here in real time.',
    })
  }

  const rowsHtml = opts.events
    .map((ev) => renderRow(ev, opts))
    .join('')

  return `<div class="gbox-at">${rowsHtml}</div>`
}

function renderRow(
  ev: ActivityRecord,
  opts: ActivityTimelineOptions,
): string {
  const category = categorizeAction(String(ev.action))
  const catClass = categoryClass(category)
  const actionLabel = humanizeAction(String(ev.action))
  const resLabel = opts.hideResource ? '' : resourceLabel(ev)
  const actorHtml = opts.hideActor
    ? ''
    : `<span class="gbox-at-actor">${esc(ev.actorLabel)}</span>`
  const resourceHtml = resLabel
    ? `<span class="gbox-at-resource" title="${esc(ev.resourceId ?? '')}">${esc(resLabel)}</span>`
    : ''
  const ipHtml = ev.ipAddress
    ? `<span class="gbox-at-ip" title="IP address">${esc(ev.ipAddress)}</span>`
    : ''
  const relTime = relativeTime(ev.createdAt, opts.now)
  const absTime = absoluteTime(ev.createdAt)
  const timeHtml = `<span class="gbox-at-time" title="${esc(absTime)}">${esc(relTime)}</span>`

  // Optional details tree — renders as a collapsed <details> block.
  let detailsHtml = ''
  if (ev.details && Object.keys(ev.details).length > 0) {
    let json = ''
    try {
      json = JSON.stringify(ev.details, null, 2)
    } catch {
      json = '[unserializable]'
    }
    detailsHtml = `<details class="gbox-at-details"><summary>Details</summary><pre>${esc(json)}</pre></details>`
  }

  return (
    `<div class="gbox-at-row ${catClass}">` +
    `<div class="gbox-at-rail"><div class="gbox-at-dot"></div></div>` +
    `<div class="gbox-at-body">` +
    `<div class="gbox-at-head">` +
    `<span class="gbox-at-badge">${esc(actionLabel)}</span>` +
    actorHtml +
    resourceHtml +
    `</div>` +
    `<div class="gbox-at-meta">` +
    ipHtml +
    timeHtml +
    `</div>` +
    detailsHtml +
    `</div>` +
    `</div>`
  )
}

// ---------------------------------------------------------------------------
// Compact sidebar timeline
// ---------------------------------------------------------------------------

/**
 * Dense single-line variant for "Recent activity" sidebars on
 * entity detail pages. No left rail, no details block — just a
 * colored dot + action label + actor + relative time.
 */
export function activityTimelineCompact(
  opts: ActivityTimelineOptions,
): string {
  if (opts.events.length === 0) {
    return `<p class="gbox-at-empty">${esc(opts.emptyMessage ?? 'No activity yet.')}</p>`
  }
  const rowsHtml = opts.events
    .map((ev) => {
      const cat = categoryClass(categorizeAction(String(ev.action)))
      const action = humanizeAction(String(ev.action))
      const actor = opts.hideActor
        ? ''
        : ` <span class="gbox-atc-actor">${esc(ev.actorLabel)}</span>`
      const rel = relativeTime(ev.createdAt, opts.now)
      const abs = absoluteTime(ev.createdAt)
      return (
        `<li class="gbox-atc-row ${cat}">` +
        `<span class="gbox-atc-dot"></span>` +
        `<span class="gbox-atc-action">${esc(action)}</span>` +
        actor +
        `<span class="gbox-atc-time" title="${esc(abs)}">${esc(rel)}</span>` +
        `</li>`
      )
    })
    .join('')
  return `<ul class="gbox-atc">${rowsHtml}</ul>`
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

export function activityTimelineCss(): string {
  return `
    /* Full timeline */
    .gbox-at {
      display: flex;
      flex-direction: column;
      gap: 0;
      position: relative;
    }
    .gbox-at-row {
      display: flex;
      gap: 14px;
      padding: 12px 0;
      position: relative;
    }
    .gbox-at-row + .gbox-at-row .gbox-at-rail::before {
      content: '';
      position: absolute;
      left: 5px;
      top: -12px;
      bottom: 50%;
      width: 2px;
      background: var(--god-border, rgba(255,255,255,0.1));
    }
    .gbox-at-row:not(:last-child) .gbox-at-rail::after {
      content: '';
      position: absolute;
      left: 5px;
      top: 50%;
      bottom: -12px;
      width: 2px;
      background: var(--god-border, rgba(255,255,255,0.1));
    }
    .gbox-at-rail {
      position: relative;
      width: 12px;
      flex-shrink: 0;
      padding-top: 6px;
    }
    .gbox-at-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--god-text-secondary, #9ca3af);
      position: relative;
      z-index: 1;
      box-shadow: 0 0 0 3px var(--god-surface, #1f2937);
    }
    .gbox-at-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .gbox-at-head {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .gbox-at-badge {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 9px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      background: var(--god-border-light, rgba(255,255,255,0.06));
      color: var(--god-text, #f3f4f6);
      border: 1px solid var(--god-border, rgba(255,255,255,0.08));
    }
    .gbox-at-actor {
      font-size: 13px;
      font-weight: 600;
      color: var(--god-accent, #3b82f6);
    }
    .gbox-at-resource {
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--god-text-secondary, #9ca3af);
    }
    .gbox-at-meta {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
    }
    .gbox-at-ip {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .gbox-at-time { cursor: help; }
    .gbox-at-details {
      margin-top: 6px;
      font-size: 12px;
      color: var(--god-text-secondary, #9ca3af);
    }
    .gbox-at-details summary {
      cursor: pointer;
      user-select: none;
    }
    .gbox-at-details pre {
      margin-top: 6px;
      padding: 10px 12px;
      background: var(--god-bg, #0f172a);
      border: 1px solid var(--god-border, rgba(255,255,255,0.08));
      border-radius: 6px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: var(--god-text, #f3f4f6);
    }

    /* Dot + badge color per category */
    .gbox-at-success .gbox-at-dot { background: #22c55e; }
    .gbox-at-success .gbox-at-badge {
      background: rgba(34,197,94,0.12);
      border-color: rgba(34,197,94,0.35);
      color: #4ade80;
    }
    .gbox-at-danger .gbox-at-dot { background: #ef4444; }
    .gbox-at-danger .gbox-at-badge {
      background: rgba(239,68,68,0.12);
      border-color: rgba(239,68,68,0.35);
      color: #f87171;
    }
    .gbox-at-warning .gbox-at-dot { background: #f59e0b; }
    .gbox-at-warning .gbox-at-badge {
      background: rgba(245,158,11,0.12);
      border-color: rgba(245,158,11,0.35);
      color: #fbbf24;
    }
    .gbox-at-info .gbox-at-dot { background: #3b82f6; }
    .gbox-at-info .gbox-at-badge {
      background: rgba(59,130,246,0.12);
      border-color: rgba(59,130,246,0.35);
      color: #60a5fa;
    }

    /* Compact variant */
    .gbox-atc {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .gbox-atc-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      font-size: 13px;
      color: var(--god-text, #f3f4f6);
      border-bottom: 1px solid var(--god-border, rgba(255,255,255,0.05));
    }
    .gbox-atc-row:last-child { border-bottom: none; }
    .gbox-atc-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--god-text-secondary, #9ca3af);
    }
    .gbox-atc-action { font-weight: 600; }
    .gbox-atc-actor { color: var(--god-accent, #3b82f6); font-weight: 600; }
    .gbox-atc-time {
      margin-left: auto;
      color: var(--god-text-secondary, #9ca3af);
      font-size: 11px;
      cursor: help;
    }
    .gbox-atc .gbox-at-success .gbox-atc-dot,
    .gbox-atc-row.gbox-at-success .gbox-atc-dot { background: #22c55e; }
    .gbox-atc-row.gbox-at-danger .gbox-atc-dot { background: #ef4444; }
    .gbox-atc-row.gbox-at-warning .gbox-atc-dot { background: #f59e0b; }
    .gbox-atc-row.gbox-at-info .gbox-atc-dot { background: #3b82f6; }
    .gbox-at-empty {
      font-size: 13px;
      color: var(--god-text-secondary, #9ca3af);
      margin: 0;
    }
  `
}
