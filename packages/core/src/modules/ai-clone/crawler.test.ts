/**
 * Gbox Platform — AI Clone crawler tests
 * (Landing Page System Phase 2.1)
 *
 * All tests use an in-memory `fetchImpl` mock so nothing touches
 * the network. The mock is a `Map<url, { status, body }>` wrapped
 * in a function matching the WHATWG Fetch signature.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  crawl,
  extractInlineStyles,
  extractLinkedStylesheets,
  normalizeEntryUrl,
} from './crawler.js'

// ---------------------------------------------------------------------------
// Fetch mock factory
// ---------------------------------------------------------------------------

interface MockEntry {
  status?: number
  body: string
  contentType?: string
  delayMs?: number
  throwError?: Error
}

function makeFetchMock(routes: Record<string, MockEntry>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const entry = routes[url]
    if (!entry) {
      return {
        ok: false,
        status: 404,
        text: async () => 'not found',
      } as unknown as Response
    }
    if (entry.throwError) throw entry.throwError
    if (entry.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, entry.delayMs)
        init?.signal?.addEventListener?.('abort', () => {
          clearTimeout(t)
          const e = new Error('aborted')
          ;(e as any).name = 'AbortError'
          reject(e)
        })
      })
    }
    const status = entry.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => entry.body,
    } as unknown as Response
  }) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// normalizeEntryUrl
// ---------------------------------------------------------------------------

describe('normalizeEntryUrl', () => {
  it('adds https:// when scheme missing', () => {
    expect(normalizeEntryUrl('nike.com')).toBe('https://nike.com/')
  })
  it('preserves explicit https', () => {
    expect(normalizeEntryUrl('https://nike.com/shoes')).toBe(
      'https://nike.com/shoes',
    )
  })
  it('strips fragment', () => {
    expect(normalizeEntryUrl('https://nike.com/shoes#hero')).toBe(
      'https://nike.com/shoes',
    )
  })
  it('rejects empty', () => {
    expect(() => normalizeEntryUrl('')).toThrow()
  })
  it('rejects malformed', () => {
    expect(() => normalizeEntryUrl('not a url')).toThrow()
  })
  it('rejects non-http scheme', () => {
    expect(() => normalizeEntryUrl('ftp://nike.com')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// extractInlineStyles
// ---------------------------------------------------------------------------

describe('extractInlineStyles', () => {
  it('finds body of every style block in document order', () => {
    const html = `
      <style>body{color:red}</style>
      <p>text</p>
      <style type="text/css">h1{font-size:32px}</style>
    `
    const res = extractInlineStyles(html)
    expect(res).toEqual(['body{color:red}', 'h1{font-size:32px}'])
  })
  it('returns empty array when no style blocks', () => {
    expect(extractInlineStyles('<div>hi</div>')).toEqual([])
  })
  it('tolerates unbalanced attributes', () => {
    const html = `<style nonce='abc'>body{--p:#123}</style>`
    expect(extractInlineStyles(html)).toEqual(['body{--p:#123}'])
  })
})

// ---------------------------------------------------------------------------
// extractLinkedStylesheets
// ---------------------------------------------------------------------------

describe('extractLinkedStylesheets', () => {
  it('matches rel="stylesheet" href="…"', () => {
    const html = `<link rel="stylesheet" href="/a.css">`
    expect(extractLinkedStylesheets(html)).toEqual(['/a.css'])
  })
  it('matches href before rel', () => {
    const html = `<link href="/b.css" rel="stylesheet">`
    expect(extractLinkedStylesheets(html)).toEqual(['/b.css'])
  })
  it('matches single-quoted and unquoted href', () => {
    const html = `<link rel='stylesheet' href='/c.css'><link rel=stylesheet href=/d.css>`
    expect(extractLinkedStylesheets(html)).toEqual(['/c.css', '/d.css'])
  })
  it('ignores links without rel=stylesheet', () => {
    const html = `
      <link rel="icon" href="/fav.ico">
      <link rel="preload" href="/font.woff">
      <link rel="stylesheet" href="/main.css">
    `
    expect(extractLinkedStylesheets(html)).toEqual(['/main.css'])
  })
  it('matches rel="alternate stylesheet"', () => {
    const html = `<link rel="alternate stylesheet" href="/alt.css">`
    expect(extractLinkedStylesheets(html)).toEqual(['/alt.css'])
  })
})

// ---------------------------------------------------------------------------
// crawl — happy path
// ---------------------------------------------------------------------------

describe('crawl', () => {
  it('fetches the entry HTML and every linked stylesheet', async () => {
    const fetchImpl = makeFetchMock({
      'https://nike.com/': {
        body: `
          <html><head>
            <link rel="stylesheet" href="/style.css">
            <link rel="stylesheet" href="https://nike.com/theme.css">
            <style>:root{--p:#fff}</style>
          </head><body><h1>hi</h1></body></html>
        `,
      },
      'https://nike.com/style.css': { body: 'body{color:#111}' },
      'https://nike.com/theme.css': { body: 'h1{font-weight:700}' },
    })

    const res = await crawl('nike.com', { fetchImpl })
    expect(res.entryUrl).toBe('https://nike.com/')
    expect(res.warnings).toEqual([])
    // Inline block + 2 linked = 3 stylesheets
    expect(res.stylesheets).toHaveLength(3)
    expect(res.stylesheets[0]!.url).toBeNull()
    expect(res.stylesheets[0]!.body).toContain(':root{--p:#fff}')
    expect(res.stylesheets[1]!.url).toBe('https://nike.com/style.css')
    expect(res.stylesheets[2]!.url).toBe('https://nike.com/theme.css')
    expect(res.combinedCss).toContain('body{color:#111}')
    expect(res.combinedCss).toContain('h1{font-weight:700}')
    expect(res.resources).toHaveLength(3) // html + 2 css
  })

  it('resolves relative hrefs against the entry URL', async () => {
    const fetchImpl = makeFetchMock({
      'https://nike.com/path/page': {
        body: `<link rel="stylesheet" href="../shared.css">`,
      },
      'https://nike.com/shared.css': { body: '.x{}' },
    })
    const res = await crawl('https://nike.com/path/page', { fetchImpl })
    expect(res.warnings).toEqual([])
    expect(res.stylesheets).toHaveLength(1)
    expect(res.stylesheets[0]!.url).toBe('https://nike.com/shared.css')
  })

  it('allows subdomain stylesheets under the same registrable host', async () => {
    const fetchImpl = makeFetchMock({
      'https://nike.com/': {
        body: `<link rel="stylesheet" href="https://cdn.nike.com/theme.css">`,
      },
      'https://cdn.nike.com/theme.css': { body: '.x{}' },
    })
    const res = await crawl('https://nike.com/', { fetchImpl })
    expect(res.warnings).toEqual([])
    expect(res.stylesheets).toHaveLength(1)
  })

  it('refuses off-host stylesheets with an off_host warning', async () => {
    const fetchImpl = makeFetchMock({
      'https://nike.com/': {
        body: `
          <link rel="stylesheet" href="/local.css">
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
        `,
      },
      'https://nike.com/local.css': { body: 'body{}' },
    })
    const res = await crawl('https://nike.com/', { fetchImpl })
    expect(res.stylesheets.some((s) => s.url === 'https://nike.com/local.css')).toBe(true)
    expect(
      res.warnings.some(
        (w) => w.code === 'off_host' && w.url.includes('fonts.googleapis.com'),
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// crawl — limits + failure modes
// ---------------------------------------------------------------------------

describe('crawl — limits and failure modes', () => {
  it('drops stylesheets beyond maxStylesheets', async () => {
    const routes: Record<string, MockEntry> = {
      'https://acme.io/': {
        body: Array.from({ length: 5 }, (_, i) => `<link rel="stylesheet" href="/s${i}.css">`).join(''),
      },
    }
    for (let i = 0; i < 5; i++) {
      routes[`https://acme.io/s${i}.css`] = { body: 'x{}' }
    }
    const res = await crawl('https://acme.io/', {
      fetchImpl: makeFetchMock(routes),
      maxStylesheets: 2,
    })
    expect(res.stylesheets).toHaveLength(2)
    expect(
      res.warnings.some(
        (w) => w.code === 'too_many_stylesheets' && w.dropped === 3,
      ),
    ).toBe(true)
  })

  it('drops resources over maxResourceBytes', async () => {
    const huge = 'x'.repeat(200)
    const fetchImpl = makeFetchMock({
      'https://acme.io/': {
        body: `<link rel="stylesheet" href="/big.css">`,
      },
      'https://acme.io/big.css': { body: huge },
    })
    const res = await crawl('https://acme.io/', {
      fetchImpl,
      maxResourceBytes: 100,
    })
    expect(res.stylesheets).toHaveLength(0)
    expect(
      res.warnings.some(
        (w) => w.code === 'resource_too_large' && w.url.endsWith('/big.css'),
      ),
    ).toBe(true)
  })

  it('stops adding resources when maxTotalBytes is exhausted', async () => {
    const fetchImpl = makeFetchMock({
      'https://acme.io/': {
        body: `
          <link rel="stylesheet" href="/a.css">
          <link rel="stylesheet" href="/b.css">
        `,
      },
      'https://acme.io/a.css': { body: 'x'.repeat(60) },
      'https://acme.io/b.css': { body: 'x'.repeat(60) },
    })
    const res = await crawl('https://acme.io/', {
      fetchImpl,
      maxTotalBytes: 150, // html ~60 + a.css 60 = 120; b.css would push over
      maxResourceBytes: 100,
    })
    // a.css fetched, b.css dropped (total_budget_exceeded OR resource_too_large
    // because remaining budget < 60). Either way stylesheets < 2.
    expect(res.stylesheets.length).toBeLessThan(2)
  })

  it('returns empty html when the entry URL fails', async () => {
    const fetchImpl = makeFetchMock({
      'https://dead.io/': { status: 500, body: 'oops' },
    })
    const res = await crawl('https://dead.io/', { fetchImpl })
    expect(res.html).toBe('')
    expect(res.stylesheets).toEqual([])
    expect(
      res.warnings.some(
        (w) => w.code === 'non_ok_status' && w.url === 'https://dead.io/',
      ),
    ).toBe(true)
  })

  it('records fetch_failed when the underlying fetch throws', async () => {
    const fetchImpl = makeFetchMock({
      'https://boom.io/': { throwError: new Error('network boom'), body: '' },
    })
    const res = await crawl('https://boom.io/', { fetchImpl })
    expect(
      res.warnings.some(
        (w) => w.code === 'fetch_failed' && w.url === 'https://boom.io/',
      ),
    ).toBe(true)
  })

  it('warns non_ok_status for failing stylesheets but keeps the HTML', async () => {
    const fetchImpl = makeFetchMock({
      'https://acme.io/': {
        body: `<link rel="stylesheet" href="/missing.css">`,
      },
      'https://acme.io/missing.css': { status: 404, body: '' },
    })
    const res = await crawl('https://acme.io/', { fetchImpl })
    expect(res.html).toContain('missing.css')
    expect(
      res.warnings.some(
        (w) => w.code === 'non_ok_status' && w.url.endsWith('/missing.css'),
      ),
    ).toBe(true)
  })

  it('handles a page with zero stylesheets', async () => {
    const fetchImpl = makeFetchMock({
      'https://empty.io/': { body: '<html><body>just text</body></html>' },
    })
    const res = await crawl('https://empty.io/', { fetchImpl })
    expect(res.warnings).toEqual([])
    expect(res.stylesheets).toEqual([])
    expect(res.combinedCss).toBe('')
  })

  it('sends the user-agent header on every fetch', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html></html>',
    })) as unknown as typeof fetch
    await crawl('https://acme.io/', { fetchImpl: spy, userAgent: 'TestAgent/9.9' })
    const calls = (spy as any).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const init = calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('TestAgent/9.9')
  })
})
