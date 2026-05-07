import type { BucketScraper, ThemeTokensDTO } from './types.js'

export function extractTokensFromCss(css: string): ThemeTokensDTO {
  const colors: Record<string, string> = {}
  const spacing: Record<string, string> = {}
  const radii: Record<string, string> = {}
  const shadows: Record<string, string> = {}
  let headingFont = ''
  let bodyFont = ''

  const rootMatch = css.match(/:root\s*\{([^}]*)\}/i)
  if (rootMatch) {
    const decls = rootMatch[1]
    for (const m of decls.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      const name = m[1].trim()
      const val = m[2].trim()
      if (name.startsWith('color')) colors[name] = val
      else if (name.startsWith('space') || name.startsWith('spacing')) spacing[name] = val
      else if (name.includes('radius')) radii[name] = val
      else if (name.includes('shadow')) shadows[name] = val
      else if (name.includes('font-heading') || name.includes('font-display')) headingFont = val
      else if (name.includes('font-body') || name.includes('font-base') || name === 'font') bodyFont = val
    }
  }

  if (!bodyFont) {
    const fontFamMatch = css.match(/body\s*\{[^}]*font-family\s*:\s*([^;}]+)/i)
    if (fontFamMatch) bodyFont = fontFamMatch[1].trim()
  }
  if (!headingFont) headingFont = bodyFont

  return {
    colors,
    fonts: { heading: headingFont, body: bodyFont, alt: null },
    spacing,
    radii,
    shadows,
    raw: { computedStyles: {} },
  }
}

export const themeTokenScraper: BucketScraper<ThemeTokensDTO> = {
  classification: 'page',
  async scrape(page, _ctx) {
    if (new URL(page.sourceUrl).pathname !== '/') return null
    const styles = Array.from(page.html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
      .map((m) => m[1])
      .join('\n')
    if (!styles.trim()) return null
    return extractTokensFromCss(styles)
  },
}
