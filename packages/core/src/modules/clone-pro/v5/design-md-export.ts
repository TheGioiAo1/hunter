/**
 * Clone Pro v5 — DESIGN.md exporter (D11)
 *
 * Outputs awesome-claude-design-compatible markdown from ThemeTokens.
 * Format: https://getdesign.md/what-is-design-md
 *
 * Iron Rule 5: never leak source_host or scraper internals in the MD —
 * only brand-derived tokens.
 */

import type { ThemeTokens } from './types.js'

export interface ExportDesignMdInput {
  readonly shopName: string
  readonly tokens: ThemeTokens
  readonly sourceHost?: string   // accepted but never written out
  readonly brandVoice?: string
}

export function exportDesignMd(input: ExportDesignMdInput): string {
  const { shopName, tokens, brandVoice } = input
  const colorLines = [
    tokens.colors.primary ? `- primary: ${tokens.colors.primary}` : null,
    tokens.colors.secondary ? `- secondary: ${tokens.colors.secondary}` : null,
    tokens.colors.background ? `- background: ${tokens.colors.background}` : null,
    tokens.colors.text ? `- text: ${tokens.colors.text}` : null,
  ].filter(Boolean).join('\n')

  const typographyLines = [
    tokens.typography.heading_family ? `- heading: ${tokens.typography.heading_family}` : null,
    tokens.typography.body_family ? `- body: ${tokens.typography.body_family}` : null,
    tokens.typography.base_size_px ? `- base size: ${tokens.typography.base_size_px}px` : null,
  ].filter(Boolean).join('\n')

  const radius = tokens.radius_px ?? 0
  const spacing = tokens.spacing.base_px ?? 0

  return `# ${shopName} Design System

## Brand voice
${brandVoice ?? 'Inferred from source — sellers refine in Claude Design.'}

## Tokens
### Color
${colorLines || '- (no color tokens extracted)'}

### Typography
${typographyLines || '- (no typography tokens extracted)'}

### Spacing
base: ${spacing}  (scale: ${scaleLine(spacing)})

## Components
### Button
- radius: ${radius}
- height: ${Math.max(spacing * 5, 40)}
- padding: ${spacing * 2} ${spacing * 3}

### Card
- radius: ${radius}
- padding: ${spacing * 3}
- shadow: 0 2px 8px rgba(0,0,0,0.08)
`
}

function scaleLine(base: number): string {
  if (base === 0) return '—'
  return `${base / 2}/${base}/${base * 2}/${base * 3}/${base * 6}/${base * 10}`
}
