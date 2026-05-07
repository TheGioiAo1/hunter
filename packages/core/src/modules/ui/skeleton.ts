/**
 * Gbox Platform — Shared Skeleton Loader (Phase 2 Step 2.2)
 *
 * Animated placeholder blocks shown while data is loading. In a pure
 * SSR architecture like ours we don't actually "load" data client-
 * side — Express renders the full page with real rows. So why ship a
 * skeleton at all?
 *
 * Two reasons:
 *   1. HTMX-swapped partials. Some pages (dashboards, inbox, search
 *      results) use htmx to replace a <section> without a full page
 *      reload. During the network round-trip we swap in a skeleton
 *      so the UI doesn't collapse.
 *   2. Route transitions. When the user clicks "Products" from the
 *      sidebar the browser shows a blank page until Express responds.
 *      A persistent shell + skeleton feels 2-3x faster even when the
 *      actual latency is unchanged. This is the #1 trick Shopify uses
 *      to feel snappy.
 *
 * Variants
 * --------
 * - `line`       — a single text-row placeholder (like a table cell).
 * - `rect`       — a rectangular block (thumbnail, card body, button).
 * - `circle`     — a circular avatar/icon placeholder.
 * - `table`      — a full N-row list-page skeleton with columns.
 * - `card-grid`  — a responsive grid of rectangular cards.
 * - `form`       — label + input pairs for edit pages.
 *
 * All variants animate via a single `@keyframes gbox-skel-shimmer`
 * CSS rule included in `skeletonCss()`. The animation is GPU-composited
 * (background-position + opacity) so it stays smooth on low-end
 * mobile devices.
 *
 * Triết lý: "clone giống hệt Shopify" (identical shimmer on every
 * surface) + "power-ful hơn Shopify nhờ Claude" (type-safe variants
 * instead of 12 bespoke loading spinners).
 */

export type SkeletonVariant =
  | 'line'
  | 'rect'
  | 'circle'
  | 'table'
  | 'card-grid'
  | 'form'

export interface SkeletonLineOptions {
  /** CSS width. Default: 100%. */
  width?: string
  /** CSS height. Default: 12px. */
  height?: string
  /** Extra class name. */
  className?: string
}

export interface SkeletonRectOptions {
  width?: string
  height?: string
  /** Border radius. Default: 6px. */
  radius?: string
  className?: string
}

export interface SkeletonCircleOptions {
  /** Diameter. Default: 32px. */
  size?: string
  className?: string
}

export interface SkeletonTableOptions {
  /** Number of rows. Default: 6. */
  rows?: number
  /** Number of columns. Default: 5. */
  columns?: number
  /** Include a header row. Default: true. */
  withHeader?: boolean
  className?: string
}

export interface SkeletonCardGridOptions {
  /** Number of cards. Default: 6. */
  count?: number
  /** Card height. Default: 160px. */
  cardHeight?: string
  className?: string
}

export interface SkeletonFormOptions {
  /** Number of field pairs. Default: 4. */
  fields?: number
  /** Include a button row at the bottom. Default: true. */
  withButtons?: boolean
  className?: string
}

// ──────────────────────────────────────────────────────────────
// Atom skeletons
// ──────────────────────────────────────────────────────────────

export function skeletonLine(options: SkeletonLineOptions = {}): string {
  const width = options.width ?? '100%'
  const height = options.height ?? '12px'
  const className = options.className ?? ''
  return (
    `<span class="gbox-skel gbox-skel-line ${className}" aria-hidden="true" ` +
    `style="width:${width};height:${height};"></span>`
  )
}

export function skeletonRect(options: SkeletonRectOptions = {}): string {
  const width = options.width ?? '100%'
  const height = options.height ?? '80px'
  const radius = options.radius ?? '6px'
  const className = options.className ?? ''
  return (
    `<span class="gbox-skel gbox-skel-rect ${className}" aria-hidden="true" ` +
    `style="width:${width};height:${height};border-radius:${radius};"></span>`
  )
}

export function skeletonCircle(options: SkeletonCircleOptions = {}): string {
  const size = options.size ?? '32px'
  const className = options.className ?? ''
  return (
    `<span class="gbox-skel gbox-skel-circle ${className}" aria-hidden="true" ` +
    `style="width:${size};height:${size};"></span>`
  )
}

// ──────────────────────────────────────────────────────────────
// Composite skeletons
// ──────────────────────────────────────────────────────────────

export function skeletonTable(options: SkeletonTableOptions = {}): string {
  const rows = options.rows ?? 6
  const columns = options.columns ?? 5
  const withHeader = options.withHeader ?? true
  const className = options.className ?? ''

  const headerCells = Array.from({ length: columns })
    .map(
      () =>
        `<div class="gbox-skel-th">${skeletonLine({ width: '60%', height: '10px' })}</div>`,
    )
    .join('')
  const header = withHeader
    ? `<div class="gbox-skel-tr gbox-skel-thead">${headerCells}</div>`
    : ''

  // Per-column widths cycle through a few sizes so the table looks
  // natural instead of uniform gray bars.
  const widths = ['70%', '90%', '50%', '80%', '40%', '60%']
  const bodyRows = Array.from({ length: rows })
    .map(() => {
      const cells = Array.from({ length: columns })
        .map(
          (_, idx) =>
            `<div class="gbox-skel-td">${skeletonLine({ width: widths[idx % widths.length] })}</div>`,
        )
        .join('')
      return `<div class="gbox-skel-tr">${cells}</div>`
    })
    .join('')

  return (
    `<div class="gbox-skel-table ${className}" role="status" aria-label="Loading">` +
    header +
    bodyRows +
    '</div>'
  )
}

export function skeletonCardGrid(options: SkeletonCardGridOptions = {}): string {
  const count = options.count ?? 6
  const cardHeight = options.cardHeight ?? '160px'
  const className = options.className ?? ''

  const cards = Array.from({ length: count })
    .map(
      () =>
        `<div class="gbox-skel-card">` +
        skeletonRect({ height: cardHeight, radius: '8px' }) +
        `<div class="gbox-skel-card-body">` +
        skeletonLine({ width: '70%' }) +
        skeletonLine({ width: '40%', height: '10px' }) +
        `</div>` +
        `</div>`,
    )
    .join('')

  return (
    `<div class="gbox-skel-grid ${className}" role="status" aria-label="Loading">` +
    cards +
    '</div>'
  )
}

export function skeletonForm(options: SkeletonFormOptions = {}): string {
  const fields = options.fields ?? 4
  const withButtons = options.withButtons ?? true
  const className = options.className ?? ''

  const fieldBlocks = Array.from({ length: fields })
    .map(
      () =>
        `<div class="gbox-skel-field">` +
        skeletonLine({ width: '30%', height: '10px', className: 'gbox-skel-label' }) +
        skeletonRect({ height: '36px', radius: '6px' }) +
        `</div>`,
    )
    .join('')

  const buttons = withButtons
    ? `<div class="gbox-skel-buttons">` +
      skeletonRect({ width: '100px', height: '36px', radius: '6px' }) +
      skeletonRect({ width: '80px', height: '36px', radius: '6px' }) +
      `</div>`
    : ''

  return (
    `<div class="gbox-skel-form ${className}" role="status" aria-label="Loading form">` +
    fieldBlocks +
    buttons +
    '</div>'
  )
}

/**
 * Single CSS block covering every skeleton variant + the shimmer
 * keyframes. Include once per layout's <style> tag. Uses CSS vars so
 * it adapts to the shared dark/light theme tokens automatically.
 */
export function skeletonCss(): string {
  return `
    @keyframes gbox-skel-shimmer {
      0%   { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .gbox-skel {
      display: inline-block;
      background: linear-gradient(
        90deg,
        var(--god-border-light, rgba(255,255,255,0.04)) 0%,
        var(--god-border, rgba(255,255,255,0.1)) 50%,
        var(--god-border-light, rgba(255,255,255,0.04)) 100%
      );
      background-size: 200% 100%;
      animation: gbox-skel-shimmer 1.4s ease-in-out infinite;
      border-radius: 4px;
    }
    .gbox-skel-line { display: block; border-radius: 3px; }
    .gbox-skel-rect { display: block; }
    .gbox-skel-circle { border-radius: 50%; }

    /* Table skeleton */
    .gbox-skel-table {
      width: 100%;
      border: 1px solid var(--god-border, rgba(255,255,255,0.08));
      border-radius: 8px;
      overflow: hidden;
      background: var(--god-surface, #111827);
    }
    .gbox-skel-tr {
      display: grid;
      grid-template-columns: repeat(var(--gbox-skel-cols, 5), 1fr);
      gap: 16px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--god-border, rgba(255,255,255,0.05));
    }
    .gbox-skel-tr:last-child { border-bottom: none; }
    .gbox-skel-thead {
      background: var(--god-surface-alt, rgba(255,255,255,0.02));
    }
    .gbox-skel-th, .gbox-skel-td {
      display: flex;
      align-items: center;
      min-width: 0;
    }

    /* Card grid skeleton */
    .gbox-skel-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 16px;
    }
    .gbox-skel-card {
      padding: 12px;
      border: 1px solid var(--god-border, rgba(255,255,255,0.08));
      border-radius: 8px;
      background: var(--god-surface, #111827);
    }
    .gbox-skel-card-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 12px;
    }

    /* Form skeleton */
    .gbox-skel-form {
      display: flex;
      flex-direction: column;
      gap: 20px;
      max-width: 560px;
    }
    .gbox-skel-field {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .gbox-skel-buttons {
      display: flex;
      gap: 12px;
      margin-top: 8px;
    }

    /* Respect reduced-motion preference */
    @media (prefers-reduced-motion: reduce) {
      .gbox-skel {
        animation: none;
        opacity: 0.6;
      }
    }
  `
}
