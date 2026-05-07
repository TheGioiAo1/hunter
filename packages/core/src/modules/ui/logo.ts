/**
 * Gbox Platform — Shared Logo (Phase 2 Step 2.1)
 *
 * Inline SVG logo used by every admin layout (god-admin, store-admin,
 * accounts portal, checkout header). Lives in `@gbox/core` so every
 * surface ships the exact same mark — no one asset file to sync, no
 * one-off copies.
 *
 * Design choices (tạm default do owner chưa quyết logo thật):
 *   - Rounded square container (8px radius) with a blue→violet
 *     gradient (#3b82f6 → #8b5cf6). Same gradient as the store-logo
 *     div in seller-layout so existing store cards still match.
 *   - A stylized "G" mark inside — drawn as a white stroked arc + bar
 *     so it's deterministic (no font dependency, no text rendering
 *     variance across browsers/OS).
 *   - Optional "gbox" wordmark rendered as system-font `<text>`, so
 *     it matches the surrounding UI font without shipping a webfont.
 *
 * Swap later: when owner finalizes a brand logo, replace the `<defs>`
 * gradient + the `<path>` mark — every call site picks up the new
 * version with zero code changes. That's the entire point of keeping
 * the logo in one place.
 *
 * "clone giống hệt Shopify" — Shopify admin has a consistent mark in
 * every surface top-left. We match that. "power-ful hơn Shopify nhờ
 * Claude" — ours is one SVG template fn instead of five PNG assets.
 */

export type GboxLogoVariant =
  /** Rounded square mark only, no text. Best for top-left corners. */
  | 'mark'
  /** `gbox` wordmark only, no mark. Best for narrow footers. */
  | 'wordmark'
  /** Mark + wordmark side by side. Best for login pages, email headers. */
  | 'combined'

export interface GboxLogoOptions {
  /** Rendered pixel size of the mark. Default: 32. */
  size?: number
  /** Which variant to render. Default: `mark`. */
  variant?: GboxLogoVariant
  /**
   * Unique suffix for the gradient `<defs>` id. If two logos are
   * rendered on the same page the browser needs unique ids — pass
   * e.g. `"topbar"`, `"sidebar"`. Default: a deterministic hash of
   * the size + variant.
   */
  idSuffix?: string
  /**
   * Color mode. `gradient` (default) uses the blue→violet gradient.
   * `mono` fills the mark with `currentColor` — useful for tinting the
   * logo via CSS, e.g. inside a dark sidebar header.
   */
  color?: 'gradient' | 'mono'
  /**
   * Extra CSS class to apply to the root `<svg>` for sizing or
   * alignment. Optional.
   */
  className?: string
  /**
   * ARIA label for accessibility. Default: "Gbox".
   */
  ariaLabel?: string
}

/**
 * Deterministic short id derived from the options so two `gboxLogo({
 * size: 32, variant: 'mark' })` calls on the same page reuse the same
 * gradient def and don't explode the DOM.
 */
function defaultIdSuffix(size: number, variant: GboxLogoVariant): string {
  return `${variant}${size}`
}

/**
 * Render the Gbox logo as an inline SVG string.
 *
 * The returned string is safe to embed directly into an HTML template
 * literal — it does not contain any user-controlled input, so there's
 * no XSS concern. If you ever add a caller-provided label, escape it
 * before passing it to `ariaLabel`.
 */
export function gboxLogo(options: GboxLogoOptions = {}): string {
  const size = options.size ?? 32
  const variant = options.variant ?? 'mark'
  const color = options.color ?? 'gradient'
  const idSuffix = options.idSuffix ?? defaultIdSuffix(size, variant)
  const className = options.className ?? ''
  const ariaLabel = options.ariaLabel ?? 'Gbox'

  const gradientId = `gbox-grad-${idSuffix}`

  // ----- The mark (stylized G inside rounded square) -----

  // Colors for the rounded-square background
  const fillAttr =
    color === 'gradient' ? `fill="url(#${gradientId})"` : 'fill="currentColor"'

  // Gradient definition — only emitted if we're in gradient mode
  const defs =
    color === 'gradient'
      ? `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>`
      : ''

  // The G inside — a partial circle (3/4 arc) plus a horizontal bar,
  // all stroked in white so it contrasts with the gradient background.
  //
  // Path breakdown (viewBox is 0 0 32 32):
  //   M 21.5 10.5                  → move to top of opening (angle ~-30°)
  //   A 6 6 0 1 0 21.5 21.5        → large-arc counter-clockwise to bottom of opening
  //   L 21.5 16.5                  → line up to middle
  //   L 16 16.5                    → horizontal bar extending left into the G
  //
  // The `0 1 0` means: no x-axis rotation, large-arc=1 (take the long
  // way around), sweep-flag=0 (counter-clockwise in SVG coordinates,
  // which visually means: start top-right → go up-left → bottom-left →
  // bottom-right). That's exactly the C/G outline.
  const markPath =
    'M21.5 10.5 A6 6 0 1 0 21.5 21.5 L21.5 16.5 L16 16.5'

  const markSvg =
    `<svg width="${size}" height="${size}" viewBox="0 0 32 32" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" ` +
    `aria-label="${ariaLabel}"` +
    (className ? ` class="${className}"` : '') +
    '>' +
    defs +
    `<rect width="32" height="32" rx="8" ${fillAttr}/>` +
    `<path d="${markPath}" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    '</svg>'

  // ----- Wordmark variant (`gbox` text only) -----

  if (variant === 'wordmark') {
    // System-font wordmark — renders crisply at any size without
    // shipping a webfont. `currentColor` so the caller can tint via CSS.
    const fontSize = Math.round(size * 0.62)
    return (
      `<span class="gbox-wordmark ${className}" ` +
      `aria-label="${ariaLabel}" ` +
      `style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; ` +
      `font-size: ${fontSize}px; font-weight: 800; letter-spacing: -0.5px; color: currentColor;">` +
      'gbox' +
      '</span>'
    )
  }

  if (variant === 'mark') {
    return markSvg
  }

  // variant === 'combined'
  const fontSize = Math.round(size * 0.6)
  return (
    `<span class="gbox-logo-combined ${className}" ` +
    `style="display: inline-flex; align-items: center; gap: ${Math.round(size * 0.25)}px;" ` +
    `aria-label="${ariaLabel}">` +
    markSvg +
    `<span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; ` +
    `font-size: ${fontSize}px; font-weight: 800; letter-spacing: -0.5px; color: currentColor;">` +
    'gbox' +
    '</span>' +
    '</span>'
  )
}
