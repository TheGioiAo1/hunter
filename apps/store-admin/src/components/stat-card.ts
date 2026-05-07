/**
 * stat-card.ts
 * KPI tile with optional trend indicator — pure HTML string render.
 */

import { esc } from '../layouts/seller-layout.js'

export type TrendDir = 'up' | 'down' | 'flat'

export interface StatCardOptions {
  /** caller phải esc */
  label: string
  /** caller phải esc */
  value: string
  /** caller phải esc */
  hint?: string
  trend?: TrendDir
}

const TREND_ICON: Record<TrendDir, string> = {
  up:   '↑',
  down: '↓',
  flat: '→',
}

const TREND_LABEL: Record<TrendDir, string> = {
  up:   'Trending up',
  down: 'Trending down',
  flat: 'No change',
}

/**
 * Returns an HTML string for a KPI stat card.
 * @param opts.label — caller phải esc
 * @param opts.value — caller phải esc
 * @param opts.hint  — caller phải esc
 */
export function statCard(opts: StatCardOptions): string {
  const { label, value, hint, trend } = opts

  const trendHtml = trend
    ? `<div class="gx-stat__trend gx-stat__trend--${esc(trend)}" aria-label="${TREND_LABEL[trend]}">
    ${TREND_ICON[trend]} ${TREND_LABEL[trend]}
  </div>`
    : ''

  const hintHtml = hint
    ? `<div class="gx-stat__hint">${esc(hint)}</div>`
    : ''

  return `<div class="gx-stat">
  <div class="gx-stat__label">${esc(label)}</div>
  <div class="gx-stat__value">${esc(value)}</div>
  ${hintHtml}
  ${trendHtml}
</div>`
}
