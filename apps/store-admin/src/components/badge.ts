/**
 * badge.ts
 * Status pill component — pure HTML string render.
 */

import { esc } from '../layouts/seller-layout.js'

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

export interface BadgeOptions {
  /** caller phải esc */
  label: string
  variant: BadgeVariant
}

/**
 * Returns an HTML string for a status badge.
 * @param opts.label — caller phải esc nếu nội dung động
 */
export function badge(opts: BadgeOptions): string {
  return `<span class="gx-badge gx-badge--${esc(opts.variant)}">${esc(opts.label)}</span>`
}
