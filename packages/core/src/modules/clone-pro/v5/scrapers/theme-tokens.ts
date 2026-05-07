/**
 * Clone Pro v5 — theme token extractor
 *
 * Parses inline <style> blocks for :root custom properties.
 * Maps common naming conventions (--color-primary, --font-heading) to
 * canonical token slots. Preserves every var in raw_css_vars for later
 * DESIGN.md export (D11).
 */

import * as cheerio from 'cheerio'
import type { ThemeTokens } from '../types.js'

export function extractThemeTokens(html: string): ThemeTokens {
  const $ = cheerio.load(html)
  const raw: Record<string, string> = {}
  $('style').each((_, el) => {
    const css = $(el).html() || ''
    const rootMatch = css.match(/:root\s*\{([^}]*)\}/s)
    if (!rootMatch) return
    const body = rootMatch[1]
    const varRe = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi
    let m: RegExpExecArray | null
    while ((m = varRe.exec(body)) !== null) {
      raw[m[1].trim()] = m[2].trim()
    }
  })

  return {
    colors: {
      primary: pickVar(raw, ['--color-primary', '--primary', '--brand-primary']),
      secondary: pickVar(raw, ['--color-secondary', '--secondary', '--brand-secondary', '--accent']),
      background: pickVar(raw, ['--color-background', '--background', '--bg']),
      text: pickVar(raw, ['--color-text', '--text', '--color-foreground']),
    },
    typography: {
      heading_family: pickVar(raw, ['--font-heading', '--heading-font', '--font-family-heading']),
      body_family: pickVar(raw, ['--font-body', '--body-font', '--font-family-body']),
      base_size_px: parsePx(pickVar(raw, ['--font-size-base', '--base-font-size'])),
    },
    spacing: {
      base_px: parsePx(pickVar(raw, ['--spacing-base', '--space-base', '--base-spacing'])),
    },
    radius_px: parsePx(pickVar(raw, ['--radius-base', '--radius', '--border-radius'])),
    raw_css_vars: raw,
  }
}

function pickVar(raw: Record<string, string>, candidates: string[]): string | null {
  for (const k of candidates) {
    if (raw[k]) return raw[k]
  }
  return null
}

function parsePx(v: string | null): number | null {
  if (!v) return null
  const m = v.match(/^(\d+(?:\.\d+)?)px$/)
  return m ? parseFloat(m[1]) : null
}
