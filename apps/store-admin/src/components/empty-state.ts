/**
 * empty-state.ts
 * Centered empty-state illustration block — pure HTML string render.
 */

import { esc } from '../layouts/seller-layout.js'

export interface EmptyStateOptions {
  /** caller phải esc */
  title: string
  /** caller phải esc */
  description?: string
  ctaHref?: string
  /** caller phải esc */
  ctaLabel?: string
  /** Raw SVG or emoji — caller phải esc nếu dynamic */
  icon?: string
}

/**
 * Returns an HTML string for a centered empty state.
 * @param opts.title — caller phải esc
 * @param opts.description — caller phải esc
 * @param opts.ctaLabel — caller phải esc
 * @param opts.icon — caller phải esc nếu nội dung động
 */
export function emptyState(opts: EmptyStateOptions): string {
  const iconHtml = opts.icon
    ? `<div class="gx-empty__icon" aria-hidden="true">${opts.icon}</div>`
    : ''

  const descHtml = opts.description
    ? `<p class="gx-empty__desc">${esc(opts.description)}</p>`
    : ''

  const ctaHtml =
    opts.ctaHref && opts.ctaLabel
      ? `<a class="gx-empty__cta" href="${esc(opts.ctaHref)}">${esc(opts.ctaLabel)}</a>`
      : ''

  return `<div class="gx-empty" role="status">
  ${iconHtml}
  <p class="gx-empty__title">${esc(opts.title)}</p>
  ${descHtml}
  ${ctaHtml}
</div>`
}
