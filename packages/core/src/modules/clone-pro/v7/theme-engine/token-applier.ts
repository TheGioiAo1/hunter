/**
 * Clone Pro v7 — Token applier
 *
 * Pure function: DesignTokens → { css: string, liquid_vars: Record<string,string> }.
 *
 * Why two outputs:
 *   - `css` is a `:root { … }` declaration that goes at the TOP of the
 *     generated `assets/theme.css`. Sections refer to these CSS variables
 *     so a token swap doesn't require re-rendering Liquid.
 *   - `liquid_vars` is a context object passed to LiquidJS at render time.
 *     Section templates use `{{ component_header_variant }}` to choose
 *     which `sections/header-{variant}.liquid` to include — those choices
 *     are decided by component-builder (Task 4.4) but flow through here
 *     so the renderer (Task 4.5) only needs one merged context.
 *
 * Coverage of DesignTokensSchema (12 sections from spec):
 *   1. fonts.primary           → --font-primary  + Google Fonts URL
 *   2. fonts.secondary         → --font-secondary + URL (optional)
 *   3. colors.primary          → --color-primary
 *   4. colors.secondary        → --color-secondary
 *   5. colors.accent           → --color-accent (or 'transparent' if null)
 *   6. colors.background       → --color-background
 *   7. colors.foreground       → --color-foreground
 *   8. colors.muted            → --color-muted (or 'currentColor' if null)
 *   9. spacing.base_unit       → --space-base + scale series --space-N
 *  10. breakpoints.{m,t,d,w}   → --bp-{mobile,tablet,desktop,wide}
 *  11. components.{h,pc,b,n}   → --header-height/--card-radius/--button-*
 *                                + liquid_vars.component_*_variant
 *  12. layout.{cmw,gc,hp}      → --container-max + liquid_vars.layout_grid_columns
 *                                + liquid_vars.component_hero_variant
 *
 * NOT applied via this function:
 *   - style_keywords  (informational only — not a renderable property)
 *   - aesthetic_score (consumed by Stage 16 / theme report, not the CSS)
 */

import type { DesignTokens } from './token-schema.js'

export interface ApplyTokensResult {
  /** :root { … } CSS block to prepend to assets/theme.css. */
  css: string
  /** Liquid context object — passed to renderer.parseAndRender. */
  liquid_vars: Record<string, string>
}

/**
 * Default footer variant — DesignTokens schema has no footer field
 * (footer rarely shows in design analysis), so we default to 'classic'
 * unless the caller overrides via component-builder.
 */
const DEFAULT_FOOTER_VARIANT = 'classic'

/**
 * Build a Google Fonts CSS2 import URL from the resolved font descriptors.
 * Returns '' when neither primary nor secondary use a Google Font.
 */
function buildGoogleFontsUrl(tokens: DesignTokens): string {
  const families: string[] = []
  const primary = tokens.fonts.primary
  if (primary.google_font) {
    const family = primary.google_font.replace(/\s+/g, '+')
    const weights = primary.weights.length > 0 ? primary.weights.join(';') : '400'
    families.push(`family=${family}:wght@${weights}`)
  }
  const secondary = tokens.fonts.secondary
  if (secondary && secondary.google_font) {
    const family = secondary.google_font.replace(/\s+/g, '+')
    const weights = secondary.weights.length > 0 ? secondary.weights.join(';') : '400'
    families.push(`family=${family}:wght@${weights}`)
  }
  if (families.length === 0) return ''
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`
}

/**
 * Quote a font family name for CSS. We always single-quote so multi-word
 * families (e.g. 'Cormorant Garamond') don't break the CSS parser.
 */
function quoteFamily(family: string): string {
  return `'${family.replace(/'/g, "\\'")}'`
}

export function applyTokens(tokens: DesignTokens): ApplyTokensResult {
  const fontPrimary = tokens.fonts.primary.google_font ?? tokens.fonts.primary.family
  const fontSecondary = tokens.fonts.secondary?.google_font ?? tokens.fonts.secondary?.family ?? ''

  // Optional colors get sensible CSS-defined fallbacks instead of leaking
  // 'null' / 'undefined' strings. 'transparent' for accent because that's
  // the safest "no pop color" default; 'currentColor' for muted because
  // muted text is usually a tinted version of the foreground.
  const colorAccent = tokens.colors.accent ?? 'transparent'
  const colorMuted = tokens.colors.muted ?? 'currentColor'

  // Spacing scale → series of CSS variables --space-1, --space-2, ...
  const scaleVars = tokens.spacing.scale
    .map((value, idx) => `  --space-${idx + 1}: ${value}px;`)
    .join('\n')

  const css = `:root {
  /* Fonts */
  --font-primary: ${quoteFamily(fontPrimary)}, system-ui, -apple-system, sans-serif;
  --font-secondary: ${fontSecondary ? quoteFamily(fontSecondary) : 'inherit'};

  /* Colors */
  --color-primary: ${tokens.colors.primary};
  --color-secondary: ${tokens.colors.secondary};
  --color-accent: ${colorAccent};
  --color-background: ${tokens.colors.background};
  --color-foreground: ${tokens.colors.foreground};
  --color-muted: ${colorMuted};

  /* Spacing */
  --space-base: ${tokens.spacing.base_unit}px;
${scaleVars}

  /* Breakpoints (consumed via container queries / JS) */
  --bp-mobile: ${tokens.breakpoints.mobile}px;
  --bp-tablet: ${tokens.breakpoints.tablet}px;
  --bp-desktop: ${tokens.breakpoints.desktop}px;
  --bp-wide: ${tokens.breakpoints.wide}px;

  /* Layout */
  --container-max: ${tokens.layout.container_max_width}px;

  /* Components */
  --header-height: ${tokens.components.header.height}px;
  --header-bg: ${tokens.components.header.background};
  --card-radius: ${tokens.components.product_card.border_radius};
  --button-radius: ${tokens.components.button.border_radius}px;
  --button-padding-x: ${tokens.components.button.padding_x}px;
  --button-padding-y: ${tokens.components.button.padding_y}px;
}
`

  const liquid_vars: Record<string, string> = {
    // fonts
    font_primary: tokens.fonts.primary.family,
    font_primary_google: tokens.fonts.primary.google_font ?? '',
    font_primary_url: buildGoogleFontsUrl(tokens),
    font_secondary: tokens.fonts.secondary?.family ?? '',
    // colors
    color_primary: tokens.colors.primary,
    color_secondary: tokens.colors.secondary,
    color_accent: tokens.colors.accent ?? '',
    color_background: tokens.colors.background,
    color_foreground: tokens.colors.foreground,
    color_muted: tokens.colors.muted ?? '',
    // layout
    layout_container_max_width: String(tokens.layout.container_max_width),
    layout_grid_columns: String(tokens.layout.grid_columns),
    // component variants — keys consumed by section files via {% include %}
    component_hero_variant: tokens.layout.hero_pattern,
    component_header_variant: tokens.components.header.variant,
    component_product_card_variant: tokens.components.product_card.variant,
    component_nav_variant: tokens.components.navigation.variant,
    component_footer_variant: DEFAULT_FOOTER_VARIANT,
    // metadata for theme report / debug
    aesthetic_score: String(tokens.aesthetic_score),
  }

  return { css, liquid_vars }
}
