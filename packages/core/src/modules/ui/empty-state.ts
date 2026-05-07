/**
 * Gbox Platform — Shared Empty State (Phase 2 Step 2.2)
 *
 * A consistent "no data yet" block that every list/table page reaches
 * for when the result set is empty. Without this, each page invents
 * its own markup — "No users yet." plain text here, a centered div
 * with an icon there, a completely blank table on a third page.
 * That's the #1 reason Shopify feels polished: every surface uses
 * the exact same empty state pattern.
 *
 * Design intent
 * -------------
 * A great empty state does three things:
 *   1. Tells the user *why* the list is empty (e.g. "You haven't
 *      created any products yet" vs "No products match your filter").
 *   2. Shows a single clear next action (e.g. "Create product").
 *   3. Hints at a secondary learn-more path (docs/tutorial) without
 *      cluttering the main CTA.
 *
 * Variants
 * --------
 * - `no-data`     — user has never created this kind of entity.
 *                   Big illustration, friendly copy, primary CTA.
 * - `no-results`  — user has filters applied and zero rows match.
 *                   Smaller illustration, "Clear filters" CTA.
 * - `no-access`   — permission gate. Lock icon, no CTA.
 * - `error`       — fetch/query crashed. Red accent, "Retry" CTA.
 *
 * The CSS lives inline (returned by `emptyStateCss()`) so layouts
 * can drop it into their <style> block alongside the theme CSS.
 *
 * Triết lý: "clone giống hệt Shopify" (consistent empty state across
 * every list page) + "power-ful hơn Shopify nhờ Claude" (one template
 * fn with typed variants instead of 40 copy-pasted divs).
 */

export type EmptyStateVariant = 'no-data' | 'no-results' | 'no-access' | 'error'

export interface EmptyStateAction {
  /** Visible label, e.g. "Create product". */
  label: string
  /**
   * Either an `href` (renders `<a>`) or an `onclick` JS snippet
   * (renders `<button>`). Exactly one must be set.
   */
  href?: string
  onclick?: string
  /** Primary (filled) or secondary (outlined). Default: primary. */
  kind?: 'primary' | 'secondary'
}

export interface EmptyStateOptions {
  /** Which visual treatment. Default: 'no-data'. */
  variant?: EmptyStateVariant
  /** Big bold line. Default: a sensible variant-specific string. */
  title?: string
  /** One-liner description below the title. Optional. */
  description?: string
  /** Up to 2 actions. The first is primary, the second is secondary. */
  actions?: EmptyStateAction[]
  /**
   * Override the icon (inline SVG string). If not passed, a default
   * icon for the variant is used.
   */
  icon?: string
  /** Extra class name on the root container. */
  className?: string
}

const DEFAULT_TITLES: Record<EmptyStateVariant, string> = {
  'no-data': 'Nothing here yet',
  'no-results': 'No results found',
  'no-access': "You don't have access",
  error: 'Something went wrong',
}

/**
 * Built-in SVG icons — deliberately simple line-art so they tint via
 * `currentColor` and scale cleanly at any size. Drawn on a 64x64
 * viewBox so callers can restyle with `width`/`height` CSS.
 */
const DEFAULT_ICONS: Record<EmptyStateVariant, string> = {
  'no-data':
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="10" y="14" width="44" height="36" rx="4"/><path d="M10 24h44"/><circle cx="18" cy="19" r="1.5" fill="currentColor"/><circle cx="24" cy="19" r="1.5" fill="currentColor"/><path d="M22 36h20M22 42h14"/></svg>',
  'no-results':
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="28" cy="28" r="16"/><path d="M40 40l12 12"/><path d="M22 28h12"/></svg>',
  'no-access':
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="28" width="36" height="24" rx="3"/><path d="M22 28v-6a10 10 0 0 1 20 0v6"/><circle cx="32" cy="40" r="2" fill="currentColor"/></svg>',
  error:
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M32 8l26 46H6z"/><path d="M32 26v12"/><circle cx="32" cy="46" r="1.5" fill="currentColor"/></svg>',
}

/**
 * HTML-escape user-provided strings. We don't want a malicious title
 * or description to break out of the template. Keep this tiny and
 * dependency-free so it works in every runtime.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render the empty state block. Safe to embed directly in an HTML
 * template literal — the title/description are HTML-escaped, so a
 * user-provided string can't break out. If a caller passes raw HTML
 * in `icon`, that's on them (the icon is the escape hatch for custom
 * artwork).
 */
export function emptyState(options: EmptyStateOptions = {}): string {
  const variant = options.variant ?? 'no-data'
  const title = options.title ?? DEFAULT_TITLES[variant]
  const description = options.description ?? ''
  const actions = options.actions ?? []
  const icon = options.icon ?? DEFAULT_ICONS[variant]
  const className = options.className ?? ''

  const actionsHtml = actions
    .map((action, idx) => {
      const kind = action.kind ?? (idx === 0 ? 'primary' : 'secondary')
      const classes = `gbox-empty-action gbox-empty-action-${kind}`
      if (action.href) {
        return `<a href="${esc(action.href)}" class="${classes}">${esc(action.label)}</a>`
      }
      if (action.onclick) {
        // onclick is an intentional JS snippet from the caller — the
        // caller must ensure it's safe. We still escape the label.
        return `<button type="button" class="${classes}" onclick="${esc(action.onclick)}">${esc(action.label)}</button>`
      }
      // No target at all — render as a plain disabled span so the
      // markup stays well-formed.
      return `<span class="${classes} gbox-empty-action-disabled">${esc(action.label)}</span>`
    })
    .join('')

  const rootClasses = [
    'gbox-empty',
    `gbox-empty-${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    `<div class="${rootClasses}" role="status">` +
    `<div class="gbox-empty-icon" aria-hidden="true">${icon}</div>` +
    `<div class="gbox-empty-title">${esc(title)}</div>` +
    (description
      ? `<div class="gbox-empty-desc">${esc(description)}</div>`
      : '') +
    (actionsHtml ? `<div class="gbox-empty-actions">${actionsHtml}</div>` : '') +
    '</div>'
  )
}

/**
 * CSS for the empty state block. Uses the shared CSS variables from
 * the layout theme (`--god-bg`, `--god-text`, etc) so it tints
 * correctly in both dark and light mode without any duplication.
 * Layouts should inline this once in their `<style>` block.
 */
export function emptyStateCss(): string {
  return `
    .gbox-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 48px 24px;
      min-height: 280px;
      color: var(--god-text-secondary, #9ca3af);
    }
    .gbox-empty-icon {
      width: 64px;
      height: 64px;
      margin-bottom: 16px;
      color: var(--god-text-tertiary, #6b7280);
      opacity: 0.7;
    }
    .gbox-empty-icon svg {
      width: 100%;
      height: 100%;
    }
    .gbox-empty-error .gbox-empty-icon {
      color: var(--god-danger, #ef4444);
      opacity: 1;
    }
    .gbox-empty-no-access .gbox-empty-icon {
      color: var(--god-warning, #f59e0b);
      opacity: 0.9;
    }
    .gbox-empty-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--god-text, #f3f4f6);
      margin-bottom: 4px;
    }
    .gbox-empty-desc {
      font-size: 13px;
      line-height: 1.5;
      color: var(--god-text-secondary, #9ca3af);
      max-width: 360px;
      margin: 0 auto 20px;
    }
    .gbox-empty-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
      margin-top: 4px;
    }
    .gbox-empty-action {
      display: inline-flex;
      align-items: center;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 6px;
      text-decoration: none;
      border: 1px solid transparent;
      cursor: pointer;
      transition: transform 0.1s ease, box-shadow 0.1s ease, background 0.1s ease;
      font-family: inherit;
    }
    .gbox-empty-action-primary {
      background: var(--god-accent, #3b82f6);
      color: #ffffff;
    }
    .gbox-empty-action-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(59, 130, 246, 0.25);
    }
    .gbox-empty-action-secondary {
      background: transparent;
      color: var(--god-text, #f3f4f6);
      border-color: var(--god-border, rgba(255,255,255,0.1));
    }
    .gbox-empty-action-secondary:hover {
      background: var(--god-border-light, rgba(255,255,255,0.04));
    }
    .gbox-empty-action-disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .gbox-empty-action:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }
  `
}
