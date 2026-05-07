/**
 * Gbox Platform — AI theme-spec enhancer tests
 * (Landing Page System Phase 2.2)
 *
 * AiSender is stubbed — tests feed canned Opus responses and
 * assert the parser + fallback logic. No network calls.
 */

import { describe, expect, it, vi } from 'vitest'
import { buildCloneReport } from '../themes/cloner.js'
import {
  enhanceThemeSpec,
  parseThemeSpecResponse,
  type AiSender,
} from './theme-spec.js'

// ---------------------------------------------------------------------------
// Sender factory — returns canned text
// ---------------------------------------------------------------------------

function cannedSender(text: string): AiSender {
  return vi.fn(async () => ({ text }))
}

const SAMPLE_HTML = `
  <html><head>
    <style>:root{--color-primary:#ff6600;--color-bg:#fff}body{color:#222}</style>
  </head><body>
    <header><nav>Home</nav></header>
    <section class="hero"><h1>Run faster</h1></section>
    <section class="featured-products"></section>
    <footer>2026</footer>
  </body></html>
`

const SAMPLE_CSS = `:root{--color-primary:#ff6600;--color-bg:#fff;--color-text:#222}
  body{font-family:'Inter',sans-serif;font-size:16px;color:#222}
  h1{font-family:'Playfair',serif;font-weight:800}`

const SAMPLE_REPORT = buildCloneReport(SAMPLE_HTML, SAMPLE_CSS)

// ---------------------------------------------------------------------------
// enhanceThemeSpec — happy path
// ---------------------------------------------------------------------------

describe('enhanceThemeSpec', () => {
  it('parses a well-formed Opus response into a ThemeSpec', async () => {
    const cannedJson = {
      brand: {
        name: 'Velocity Running',
        tagline: 'Go farther, faster.',
        voice: 'Bold, motivational, athletic.',
      },
      palette: {
        primary: '#ff6600',
        secondary: '#0ea5e9',
        background: '#ffffff',
        surface: '#f4f4f5',
        text: '#111111',
        text_muted: '#6b7280',
        border: '#e5e7eb',
        success: '#16a34a',
        error: '#dc2626',
      },
      fonts: {
        heading_family: "'Playfair Display', serif",
        body_family: "'Inter', system-ui, sans-serif",
        heading_weight: '800',
        body_weight: '400',
        base_size: '16px',
        line_height: '1.5',
      },
      sections: [
        { type: 'header', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
        {
          type: 'hero',
          heading: 'Run faster. Go farther.',
          subheading: 'Race-tested footwear.',
          ctaLabel: 'Shop the collection',
          imageHint: 'Wide-angle studio shot of a running shoe',
        },
        {
          type: 'featured-products',
          heading: 'Best sellers',
          subheading: 'The picks our athletes reach for first.',
          ctaLabel: 'View all',
          imageHint: '',
        },
        { type: 'footer', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
      ],
      tags: ['athletic', 'running', 'minimal', 'bold'],
      description: 'A confident, athletic storefront with strong typography.',
    }
    const sender = cannedSender(JSON.stringify(cannedJson))
    const res = await enhanceThemeSpec(
      {
        entryUrl: 'https://velocity.example/',
        report: SAMPLE_REPORT,
        html: SAMPLE_HTML,
        css: SAMPLE_CSS,
      },
      { sender },
    )

    expect(res.warnings).toEqual([])
    expect(res.spec.brand.name).toBe('Velocity Running')
    expect(res.spec.palette.primary).toBe('#ff6600')
    expect(res.spec.sections).toHaveLength(4)
    expect(res.spec.sections[1]!.type).toBe('hero')
    expect(res.spec.sections[1]!.heading).toBe('Run faster. Go farther.')
    expect(res.spec.tags).toEqual(['athletic', 'running', 'minimal', 'bold'])
  })

  it('strips markdown code fences before parsing', async () => {
    const fenced =
      '```json\n' +
      JSON.stringify({
        brand: { name: 'Fenced Co', tagline: '', voice: '' },
        palette: {},
        fonts: {},
        sections: [
          { type: 'header', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
          { type: 'hero', heading: 'Hi', subheading: '', ctaLabel: '', imageHint: '' },
          { type: 'footer', heading: '', subheading: '', ctaLabel: '', imageHint: '' },
        ],
        tags: [],
        description: '',
      }) +
      '\n```'
    const res = await enhanceThemeSpec(
      {
        entryUrl: 'https://fenced.example/',
        report: SAMPLE_REPORT,
        html: '',
        css: '',
      },
      { sender: cannedSender(fenced) },
    )
    expect(res.spec.brand.name).toBe('Fenced Co')
    expect(res.spec.sections.length).toBe(3)
  })

  it('forwards sender options (model, maxTokens, temperature)', async () => {
    const sender = vi.fn(async () => ({ text: '{}' }))
    await enhanceThemeSpec(
      {
        entryUrl: 'https://x.io/',
        report: SAMPLE_REPORT,
        html: '',
        css: '',
      },
      {
        sender: sender as AiSender,
        model: 'claude-opus-4-6',
        maxTokens: 1234,
        temperature: 0.05,
      },
    )
    expect(sender).toHaveBeenCalledTimes(1)
    const call = (sender as any).mock.calls[0][0]
    expect(call.model).toBe('claude-opus-4-6')
    expect(call.maxTokens).toBe(1234)
    expect(call.temperature).toBe(0.05)
    expect(call.systemPrompt).toContain('Gbox Theme Cloner')
  })

  it('passes merchant hint verbatim in the user message', async () => {
    const sender = vi.fn(async () => ({ text: '{}' }))
    await enhanceThemeSpec(
      {
        entryUrl: 'https://x.io/',
        report: SAMPLE_REPORT,
        html: '',
        css: '',
        merchantHint: 'Make it more playful and target Gen Z',
      },
      { sender: sender as AiSender },
    )
    const msg = (sender as any).mock.calls[0][0].messages[0].content as string
    expect(msg).toContain('Make it more playful and target Gen Z')
  })

  it('trims HTML and CSS over the configured cap', async () => {
    const sender = vi.fn(async () => ({ text: '{}' }))
    const bigHtml = 'x'.repeat(50_000)
    const bigCss = 'y'.repeat(50_000)
    await enhanceThemeSpec(
      {
        entryUrl: 'https://x.io/',
        report: SAMPLE_REPORT,
        html: bigHtml,
        css: bigCss,
      },
      { sender: sender as AiSender, maxHtmlBytes: 500, maxCssBytes: 300 },
    )
    const msg = (sender as any).mock.calls[0][0].messages[0].content as string
    // Count the x's and y's inside the user message
    const xCount = (msg.match(/x/g) ?? []).length
    const yCount = (msg.match(/y/g) ?? []).length
    // A few xs and ys appear in surrounding prompt text; tolerance is generous
    expect(xCount).toBeLessThan(600)
    expect(yCount).toBeLessThan(400)
  })
})

// ---------------------------------------------------------------------------
// parseThemeSpecResponse — direct parser tests
// ---------------------------------------------------------------------------

describe('parseThemeSpecResponse', () => {
  const entryUrl = 'https://test.example/'

  it('falls back to defaults when the blob is garbage', () => {
    const res = parseThemeSpecResponse('not a json', SAMPLE_REPORT, entryUrl)
    expect(res.warnings).toContain('ai_no_json: response contained no JSON object')
    expect(res.spec.palette.primary).toBe(SAMPLE_REPORT.palette.primary)
  })

  it('falls back when the blob has a {} but parse fails later', () => {
    const broken = '{ this is not : valid json }'
    const res = parseThemeSpecResponse(broken, SAMPLE_REPORT, entryUrl)
    expect(res.warnings.some((w) => w.startsWith('ai_json_parse_failed'))).toBe(true)
  })

  it('drops sections with unknown types', () => {
    const raw = JSON.stringify({
      sections: [
        { type: 'header' },
        { type: 'made-up-type' },
        { type: 'hero' },
      ],
    })
    const res = parseThemeSpecResponse(raw, SAMPLE_REPORT, entryUrl)
    expect(res.spec.sections.map((s) => s.type)).toEqual([
      'header',
      'hero',
      'footer',
    ])
  })

  it('autoprepends header and autoappends footer when missing', () => {
    const raw = JSON.stringify({
      sections: [
        { type: 'hero', heading: 'x' },
        { type: 'featured-products' },
      ],
    })
    const res = parseThemeSpecResponse(raw, SAMPLE_REPORT, entryUrl)
    expect(res.spec.sections[0]!.type).toBe('header')
    expect(res.spec.sections[res.spec.sections.length - 1]!.type).toBe('footer')
  })

  it('normalises #rgb palette entries to #rrggbb', () => {
    const raw = JSON.stringify({
      palette: { primary: '#f60', text: '#000' },
    })
    const res = parseThemeSpecResponse(raw, SAMPLE_REPORT, entryUrl)
    expect(res.spec.palette.primary).toBe('#ff6600')
    expect(res.spec.palette.text).toBe('#000000')
  })

  it('drops invalid palette entries back to CloneReport defaults', () => {
    const raw = JSON.stringify({
      palette: { primary: 'not-a-color', secondary: '#abc' },
    })
    const res = parseThemeSpecResponse(raw, SAMPLE_REPORT, entryUrl)
    expect(res.spec.palette.primary).toBe(SAMPLE_REPORT.palette.primary)
    expect(res.spec.palette.secondary).toBe('#aabbcc')
  })

  it('dedupes and lowercases tags', () => {
    const raw = JSON.stringify({
      tags: ['Athletic', 'athletic', 'BOLD', '  bold  ', 'new'],
    })
    const res = parseThemeSpecResponse(raw, SAMPLE_REPORT, entryUrl)
    expect(res.spec.tags).toEqual(['athletic', 'bold', 'new'])
  })

  it('fills brand.name from the entry URL when missing', () => {
    const res = parseThemeSpecResponse(
      '{}',
      SAMPLE_REPORT,
      'https://www.velocity.example/page',
    )
    expect(res.spec.brand.name).toBe('velocity.example')
  })

  it('falls back to the default section list when sections is empty', () => {
    const res = parseThemeSpecResponse('{"sections":[]}', SAMPLE_REPORT, entryUrl)
    expect(res.warnings).toContain('ai_sections_missing_or_empty')
    expect(res.spec.sections.length).toBeGreaterThan(0)
    expect(res.spec.sections[0]!.type).toBe('header')
  })

  it('extracts JSON even when Opus emits leading prose', () => {
    const messy =
      "Sure! Here's your theme spec:\n\n" +
      JSON.stringify({ brand: { name: 'From Messy' } }) +
      '\n\nLet me know if you want any tweaks.'
    const res = parseThemeSpecResponse(messy, SAMPLE_REPORT, entryUrl)
    expect(res.spec.brand.name).toBe('From Messy')
  })
})
