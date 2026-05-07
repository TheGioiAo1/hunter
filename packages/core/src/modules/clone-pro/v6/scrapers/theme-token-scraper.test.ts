import { describe, it, expect } from 'vitest'
import { themeTokenScraper, extractTokensFromCss } from './theme-token-scraper.js'

describe('theme-token-scraper', () => {
  it('extracts CSS variables from :root', () => {
    const css = `:root { --color-primary: #FF0000; --font-heading: "Inter", sans-serif; --space-md: 16px; }`
    const tokens = extractTokensFromCss(css)
    expect(tokens.colors['color-primary']).toBe('#FF0000')
    expect(tokens.fonts.heading).toContain('Inter')
    expect(tokens.spacing['space-md']).toBe('16px')
  })

  it('falls back to inline style if no :root variables', async () => {
    const html = `<html><head><style>body { background: #fefefe; font-family: "Roboto"; }</style></head><body></body></html>`
    const r = await themeTokenScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://example.com/', html, screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: false },
    )
    expect(r).not.toBeNull()
    expect(r!.fonts.body).toContain('Roboto')
  })
})
