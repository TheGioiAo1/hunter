/**
 * Gbox Platform — AI Clone bundle generator
 * (Landing Page System Phase 2.3)
 *
 * Turns a `ThemeSpec` (from theme-spec.ts) into a Liquid theme bundle
 * ready to save through `themes/service.ts`. The output shape is
 * exactly what `themes/bundle.ts` + `themes/seed/install.ts` already
 * understand: a `ThemeBundleFiles` map of `path → contents` strings,
 * plus a `ThemeBundleMeta` record. That way the orchestrator in
 * Phase 2.4 can drop the result straight into the existing theme
 * pipeline without a single new schema column.
 *
 * Strategy: clone-and-patch, not generate-from-scratch.
 * ---------------------------------------------------
 * Writing Liquid by hand from an AI spec is risky — one typo breaks
 * the storefront and the merchant blames the AI. Instead we start
 * with the hand-written, extensively tested `GBOX_DAWN_BUNDLE` seed
 * theme and apply THREE surgical transforms:
 *
 *   1. **CSS palette override** — prepend a `:root { --color-bg: …; }`
 *      block to `assets/theme.css` so the cloned palette overrides
 *      the seed without touching a single rule.
 *
 *   2. **settings_data.json patch** — rewrite `current` with the new
 *      colour + font tokens. Merchants can still edit from the
 *      theme editor because the schema is unchanged.
 *
 *   3. **templates/index.json rewrite** — emit a new `sections`
 *      object from the ThemeSpec section order, carrying heading /
 *      subheading / CTA copy from Opus. Unknown section types are
 *      dropped in theme-spec.ts so this transform can trust its
 *      input.
 *
 * Anything else (layout/theme.liquid, product templates, footer
 * snippet, locales, …) is copied verbatim from the seed. That
 * gives the cloned theme a correct, accessible, known-good
 * skeleton with the merchant's branding painted on top.
 *
 * Why no extra Liquid templates?
 *   The AI pass produces copy + colour decisions. Liquid layout
 *   decisions (product grid columns, cart layout, checkout button
 *   placement) are intentionally seed-level — the seed is the
 *   opinion we trust. Cloner quality = good seed + good overrides.
 *
 * Testing:
 *   The generator is pure — same ThemeSpec + same seed bundle →
 *   same output. Tests hand it synthetic specs and assert the
 *   three transforms without touching R2, the database, or the
 *   Anthropic API.
 */

import {
  GBOX_DAWN_BUNDLE,
  GBOX_DAWN_BUNDLE_VERSION,
} from '../themes/seed/gbox-dawn-bundle.js'
import type { ThemeBundleFiles, ThemeBundleMeta } from '../themes/bundle.js'
import type { ThemeSpec, ThemeSectionType } from './theme-spec.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateBundleInput {
  /** The AI-enhanced theme specification. */
  spec: ThemeSpec
  /**
   * Original URL the spec was cloned from, stored in the theme's
   * description metadata so the merchant can trace provenance.
   */
  sourceUrl: string
  /**
   * Version for the generated bundle. Defaults to
   * `GBOX_DAWN_BUNDLE_VERSION-clone.1`.
   */
  version?: string
  /** Author line stamped in the manifest. */
  author?: string
}

export interface GenerateBundleResult {
  /** Ready-to-save file tree. */
  files: ThemeBundleFiles
  /** Manifest metadata for the themes service. */
  meta: ThemeBundleMeta
  /** Non-fatal notes for the caller to log / surface. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// generateBundleFromSpec — public entry point
// ---------------------------------------------------------------------------

const DEFAULT_AUTHOR = 'Gbox Theme Cloner'

export function generateBundleFromSpec(
  input: GenerateBundleInput,
): GenerateBundleResult {
  const warnings: string[] = []

  // 1. Clone the seed map into a mutable record.
  const files: ThemeBundleFiles = {}
  for (const [key, asset] of GBOX_DAWN_BUNDLE) {
    files[key] = asset.source
  }

  // 2. Apply CSS variable override.
  const originalCss = files['assets/theme.css'] ?? ''
  files['assets/theme.css'] = applyCssPaletteOverride(
    originalCss,
    input.spec,
    warnings,
  )

  // 3. Patch settings_data.json.
  const originalSettings = files['config/settings_data.json'] ?? '{}'
  files['config/settings_data.json'] = patchSettingsData(
    originalSettings,
    input.spec,
    warnings,
  )

  // 4. Rewrite templates/index.json from the section list.
  files['templates/index.json'] = rewriteIndexTemplate(input.spec)

  // 5. Build manifest metadata.
  const meta: ThemeBundleMeta = {
    name: buildThemeName(input.spec),
    version: input.version ?? `${GBOX_DAWN_BUNDLE_VERSION}-clone.1`,
    author: input.author ?? DEFAULT_AUTHOR,
    description: buildThemeDescription(input.spec, input.sourceUrl),
    license: 'MIT',
  }

  return { files, meta, warnings }
}

// ---------------------------------------------------------------------------
// Transform 1 — CSS palette override
// ---------------------------------------------------------------------------

/**
 * Prepend a `:root { … }` block to the seed stylesheet with the
 * tokens mapped from the ThemeSpec. The seed rules (layout,
 * spacing, typography) keep working because they reference
 * `var(--color-bg)` etc. — we just override the variable values.
 *
 * We intentionally DO NOT rewrite or delete the seed `:root` block.
 * CSS cascades: the later, prepended-at-top-of-file block wins
 * because we place it AFTER the existing `:root` (yes, really —
 * same specificity + later source order = later wins). That keeps
 * the seed's own defaults as a fallback if we ever miss a token.
 */
function applyCssPaletteOverride(
  originalCss: string,
  spec: ThemeSpec,
  warnings: string[],
): string {
  const tokens = buildCssTokens(spec)

  if (Object.keys(tokens).length === 0) {
    warnings.push('css_override_empty: no palette tokens to override')
    return originalCss
  }

  const overrideLines = [
    '/* Gbox Theme Cloner override — DO NOT EDIT BY HAND */',
    ':root {',
    ...Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`),
    '}',
    '',
  ]

  // Append AFTER the seed CSS so our :root wins on source-order tie.
  return `${originalCss}\n\n${overrideLines.join('\n')}`
}

function buildCssTokens(spec: ThemeSpec): Record<string, string> {
  const p = spec.palette
  const f = spec.fonts
  // Map ThemeSpec tokens to the CSS custom properties the seed uses.
  // The seed uses --color-bg / --color-fg / --color-accent / --font-body
  // so we override those AND also emit a generic --color-primary etc.
  // for any future sections that reference the richer palette.
  return {
    '--color-bg': p.background,
    '--color-fg': p.text,
    '--color-muted': p.text_muted,
    '--color-border': p.border,
    '--color-accent': p.primary,
    '--color-accent-fg': p.background,
    '--color-surface': p.surface,
    '--color-primary': p.primary,
    '--color-secondary': p.secondary,
    '--color-success': p.success,
    '--color-error': p.error,
    '--color-text-muted': p.text_muted,
    '--font-body': f.body_family,
    '--font-heading': f.heading_family,
    '--font-body-weight': f.body_weight,
    '--font-heading-weight': f.heading_weight,
    '--font-base-size': f.base_size,
    '--line-height-base': f.line_height,
  }
}

// ---------------------------------------------------------------------------
// Transform 2 — settings_data.json patch
// ---------------------------------------------------------------------------

/**
 * Parse the seed `settings_data.json`, overwrite the three colour
 * tokens + the body font key, and re-serialise with pretty
 * indentation so diff review stays readable.
 */
function patchSettingsData(
  originalJson: string,
  spec: ThemeSpec,
  warnings: string[],
): string {
  let parsed: any
  try {
    parsed = JSON.parse(originalJson)
  } catch {
    warnings.push('settings_data_parse_failed: emitting fresh scaffold')
    parsed = { current: {}, presets: { Default: {} } }
  }

  const current = (parsed.current && typeof parsed.current === 'object') ? parsed.current : {}
  parsed.current = {
    ...current,
    color_background: spec.palette.background,
    color_foreground: spec.palette.text,
    color_accent: spec.palette.primary,
    type_body_family: inferTypeFamilyKey(spec.fonts.body_family),
  }

  // Add a `Cloned` preset so the merchant can flip back to the
  // originally-scraped look after experimenting.
  if (!parsed.presets || typeof parsed.presets !== 'object') {
    parsed.presets = {}
  }
  parsed.presets.Cloned = {
    color_background: spec.palette.background,
    color_foreground: spec.palette.text,
    color_accent: spec.palette.primary,
    type_body_family: inferTypeFamilyKey(spec.fonts.body_family),
    page_width: 1200,
  }

  return JSON.stringify(parsed, null, 2) + '\n'
}

/**
 * The seed settings schema only knows `type_body_family: 'system'`
 * as a valid key. For any custom family we fall back to `'system'`
 * so the schema validator doesn't throw at save-time; the actual
 * font lands in the CSS override (`--font-body`) regardless.
 */
function inferTypeFamilyKey(cssFamily: string): string {
  if (!cssFamily || /system-?ui|-apple-system/i.test(cssFamily)) return 'system'
  return 'system'
}

// ---------------------------------------------------------------------------
// Transform 3 — templates/index.json rewrite
// ---------------------------------------------------------------------------

/**
 * Emit a fresh `templates/index.json` from the spec's section list.
 * Section ids are slugified + index-suffixed so multiples of the
 * same type (e.g. two `image-with-text`) don't collide. The
 * `order` array preserves the spec's order.
 */
function rewriteIndexTemplate(spec: ThemeSpec): string {
  const sectionsOut: Record<string, unknown> = {}
  const order: string[] = []
  const typeCounts = new Map<ThemeSectionType, number>()

  for (const section of spec.sections) {
    const count = (typeCounts.get(section.type) ?? 0) + 1
    typeCounts.set(section.type, count)
    const id = count === 1 ? section.type : `${section.type}-${count}`

    sectionsOut[id] = {
      type: section.type,
      settings: buildSectionSettings(section),
    }
    order.push(id)
  }

  const doc = { sections: sectionsOut, order }
  return JSON.stringify(doc, null, 2) + '\n'
}

function buildSectionSettings(section: {
  heading: string
  subheading: string
  ctaLabel: string
  imageHint: string
}): Record<string, unknown> {
  // The seed schemas expect Shopify-ish keys (`heading`, `subheading`,
  // `cta_label`, `cta_link`). We emit all four plus `image_hint` for
  // merchant reference in the editor UI.
  return {
    heading: section.heading,
    subheading: section.subheading,
    cta_label: section.ctaLabel,
    cta_link: '/collections/all',
    image_hint: section.imageHint,
  }
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function buildThemeName(spec: ThemeSpec): string {
  const brand = spec.brand.name?.trim() || 'Cloned Store'
  return `${brand} — Cloned by Gbox AI`
}

function buildThemeDescription(spec: ThemeSpec, sourceUrl: string): string {
  const baseDesc = spec.description?.trim() || 'AI-cloned landing page theme.'
  return `${baseDesc} Source: ${sourceUrl}`
}

// ---------------------------------------------------------------------------
// Re-exports for orchestrator convenience
// ---------------------------------------------------------------------------

export {
  applyCssPaletteOverride as __testApplyCssPaletteOverride,
  patchSettingsData as __testPatchSettingsData,
  rewriteIndexTemplate as __testRewriteIndexTemplate,
  buildCssTokens as __testBuildCssTokens,
}
