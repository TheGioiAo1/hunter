/**
 * SEO Scan Service — unit coverage (Phase 8 PR3c).
 *
 * Covers:
 *   • HTML extractors (title, meta description, H1 count, canonical, img alt)
 *     — happy paths + edge cases (missing, empty, multi-line, attribute order
 *     flipped, case mixing)
 *   • analyseScan — every issue code exercised (missing_title, short_title,
 *     long_title, missing_meta_description, short_meta_description,
 *     long_meta_description, missing_h1, multiple_h1, missing_canonical,
 *     missing_image_alt, duplicate_title, http_4xx, http_5xx, fetch_failed)
 *   • Duplicate-title detection flags every offender
 *   • scanShop — cap respected, serial fetch, fetcher rejection normalised
 *   • Score heuristic — weighting (error=8, warning=3, info=1) + 0-floor
 */

import { describe, it, expect, vi } from 'vitest'
import {
  analyseScan,
  countH1,
  countImagesWithoutAlt,
  extractCanonical,
  extractMetaDescription,
  extractTitle,
  scanShop,
  type ScanPageInput,
  type SeoFetcher,
} from './scan.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fully SEO-correct page so tests can vary one field at a time.
 * Default title is 17 chars (in [10, 70]). Default meta desc is ~109 chars
 * (in [50, 160]). Canonical + H1 + alt text all present.
 */
function goodPage(url: string, title = 'A Fine Page Title'): ScanPageInput {
  return {
    url,
    status: 200,
    body: `<html>
<head>
<title>${title}</title>
<meta name="description" content="This is a reasonably long meta description that meets the 50-character minimum required by the scanner rules.">
<link rel="canonical" href="${url}">
</head>
<body>
<h1>Heading</h1>
<img src="x.png" alt="good alt">
</body>
</html>`,
  }
}

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

describe('extractTitle', () => {
  it('extracts a simple title', () => {
    expect(extractTitle('<title>Hello</title>')).toBe('Hello')
  })

  it('trims surrounding whitespace', () => {
    expect(extractTitle('<title>  Hello  </title>')).toBe('Hello')
  })

  it('returns null when the tag is missing', () => {
    expect(extractTitle('<html><body>No head</body></html>')).toBe(null)
  })

  it('returns null for an empty title', () => {
    expect(extractTitle('<title></title>')).toBe(null)
  })

  it('returns null for whitespace-only title', () => {
    expect(extractTitle('<title>   </title>')).toBe(null)
  })

  it('matches titles with attributes', () => {
    expect(extractTitle('<title lang="en">Hello</title>')).toBe('Hello')
  })

  it('is case-insensitive', () => {
    expect(extractTitle('<TITLE>Hello</TITLE>')).toBe('Hello')
  })

  it('returns the first title when multiple exist', () => {
    expect(extractTitle('<title>First</title><title>Second</title>')).toBe('First')
  })

  it('handles multi-line inner content', () => {
    expect(extractTitle('<title>Line 1\nLine 2</title>')).toBe('Line 1\nLine 2')
  })
})

// ---------------------------------------------------------------------------
// extractMetaDescription
// ---------------------------------------------------------------------------

describe('extractMetaDescription', () => {
  it('extracts with name-then-content attribute order', () => {
    const html = '<meta name="description" content="My description">'
    expect(extractMetaDescription(html)).toBe('My description')
  })

  it('extracts with content-then-name attribute order', () => {
    const html = '<meta content="My description" name="description">'
    expect(extractMetaDescription(html)).toBe('My description')
  })

  it('returns null when absent', () => {
    expect(extractMetaDescription('<html></html>')).toBe(null)
  })

  it('returns null for empty content', () => {
    expect(extractMetaDescription('<meta name="description" content="">')).toBe(null)
  })

  it('ignores non-description meta tags', () => {
    expect(extractMetaDescription('<meta name="keywords" content="seo">')).toBe(null)
  })

  it('is case-insensitive on attribute names', () => {
    const html = '<meta NAME="description" CONTENT="Hello">'
    expect(extractMetaDescription(html)).toBe('Hello')
  })

  it('handles single-quoted attributes', () => {
    const html = "<meta name='description' content='Hello'>"
    expect(extractMetaDescription(html)).toBe('Hello')
  })
})

// ---------------------------------------------------------------------------
// countH1
// ---------------------------------------------------------------------------

describe('countH1', () => {
  it('returns 0 when there is no H1', () => {
    expect(countH1('<html><body></body></html>')).toBe(0)
  })

  it('counts a single H1', () => {
    expect(countH1('<h1>Hello</h1>')).toBe(1)
  })

  it('counts multiple separate H1s', () => {
    expect(countH1('<h1>A</h1><h1>B</h1><h1>C</h1>')).toBe(3)
  })

  it('is case-insensitive', () => {
    expect(countH1('<H1>Hello</H1>')).toBe(1)
  })

  it('matches H1 with attributes', () => {
    expect(countH1('<h1 class="hero">Hello</h1>')).toBe(1)
  })

  it('does not count H11 or H2', () => {
    expect(countH1('<h11>Not a heading</h11>')).toBe(0)
    expect(countH1('<h2>Heading 2</h2>')).toBe(0)
  })

  it('handles multi-line H1 content', () => {
    expect(countH1('<h1>Line 1\nLine 2</h1>')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// extractCanonical
// ---------------------------------------------------------------------------

describe('extractCanonical', () => {
  it('extracts canonical with rel-then-href order', () => {
    const html = '<link rel="canonical" href="https://example.com">'
    expect(extractCanonical(html)).toBe('https://example.com')
  })

  it('extracts with href-then-rel order', () => {
    const html = '<link href="https://example.com" rel="canonical">'
    expect(extractCanonical(html)).toBe('https://example.com')
  })

  it('returns null when absent', () => {
    expect(extractCanonical('<html></html>')).toBe(null)
  })

  it('ignores non-canonical link rels', () => {
    expect(extractCanonical('<link rel="stylesheet" href="/s.css">')).toBe(null)
  })

  it('returns null for empty href', () => {
    expect(extractCanonical('<link rel="canonical" href="">')).toBe(null)
  })

  it('is case-insensitive', () => {
    const html = '<LINK REL="canonical" HREF="https://example.com">'
    expect(extractCanonical(html)).toBe('https://example.com')
  })
})

// ---------------------------------------------------------------------------
// countImagesWithoutAlt
// ---------------------------------------------------------------------------

describe('countImagesWithoutAlt', () => {
  it('returns 0 when every image has non-empty alt', () => {
    const html = '<img src="a.png" alt="one"><img src="b.png" alt="two">'
    expect(countImagesWithoutAlt(html)).toBe(0)
  })

  it('counts an image without an alt attribute', () => {
    expect(countImagesWithoutAlt('<img src="a.png">')).toBe(1)
  })

  it('counts an image with empty alt=""', () => {
    expect(countImagesWithoutAlt('<img src="a.png" alt="">')).toBe(1)
  })

  it('counts alt with only whitespace as empty', () => {
    expect(countImagesWithoutAlt('<img src="a.png" alt="   ">')).toBe(1)
  })

  it('mixed: only counts the missing/empty ones', () => {
    const html =
      '<img src="a.png" alt="good">' +
      '<img src="b.png">' +
      '<img src="c.png" alt="">' +
      '<img src="d.png" alt="also good">'
    expect(countImagesWithoutAlt(html)).toBe(2)
  })

  it('is case-insensitive on the tag name', () => {
    expect(countImagesWithoutAlt('<IMG SRC="a.png">')).toBe(1)
  })

  it('returns 0 for HTML with no images at all', () => {
    expect(countImagesWithoutAlt('<html><body><p>Hi</p></body></html>')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// analyseScan — happy path
// ---------------------------------------------------------------------------

describe('analyseScan — happy path', () => {
  it('no issues for a single well-formed page', () => {
    const report = analyseScan([goodPage('https://shop.test/a')])
    expect(report.pages_scanned).toBe(1)
    expect(report.issues).toEqual([])
    expect(report.score).toBe(100)
  })

  it('no issues across multiple well-formed pages with distinct titles', () => {
    const pages = [
      goodPage('https://shop.test/a', 'Page Alpha Title'),
      goodPage('https://shop.test/b', 'Page Beta Title'),
    ]
    const report = analyseScan(pages)
    expect(report.issues).toEqual([])
    expect(report.score).toBe(100)
    expect(report.pages_scanned).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// analyseScan — HTTP + transport failures
// ---------------------------------------------------------------------------

describe('analyseScan — HTTP failures', () => {
  it('status 404 → http_4xx error and no further analysis', () => {
    const report = analyseScan([
      { url: 'https://shop.test/404', status: 404, body: 'Not found' },
    ])
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]?.code).toBe('http_4xx')
    expect(report.issues[0]?.severity).toBe('error')
  })

  it('status 503 → http_5xx error', () => {
    const report = analyseScan([
      { url: 'https://shop.test/503', status: 503, body: 'Unavailable' },
    ])
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]?.code).toBe('http_5xx')
    expect(report.issues[0]?.severity).toBe('error')
  })

  it('null body → fetch_failed error', () => {
    const report = analyseScan([
      { url: 'https://shop.test/x', status: 200, body: null },
    ])
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]?.code).toBe('fetch_failed')
    expect(report.issues[0]?.severity).toBe('error')
  })

  it('status 0 → fetch_failed error (overrides any body)', () => {
    const report = analyseScan([
      { url: 'https://shop.test/x', status: 0, body: '' },
    ])
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]?.code).toBe('fetch_failed')
  })

  it('skips HTML analysis for failed pages', () => {
    // Empty HTML would ordinarily emit missing_title etc; 4xx short-circuits.
    const report = analyseScan([
      { url: 'https://shop.test/404', status: 404, body: '<html></html>' },
    ])
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]?.code).toBe('http_4xx')
  })
})

// ---------------------------------------------------------------------------
// analyseScan — title issues
// ---------------------------------------------------------------------------

describe('analyseScan — title', () => {
  it('missing title → error', () => {
    const body = `<meta name="description" content="This description is long enough to satisfy the scanner rules and cross 50 chars.">
<link rel="canonical" href="https://shop.test/a"><h1>Hi</h1>`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    const codes = report.issues.map((i) => i.code)
    expect(codes).toContain('missing_title')
  })

  it('title shorter than 10 chars → short_title warning', () => {
    const page = goodPage('https://shop.test/a', 'Short')
    const report = analyseScan([page])
    const short = report.issues.find((i) => i.code === 'short_title')
    expect(short).toBeDefined()
    expect(short?.severity).toBe('warning')
  })

  it('title longer than 70 chars → long_title warning', () => {
    const longTitle = 'x'.repeat(100)
    const page = goodPage('https://shop.test/a', longTitle)
    const report = analyseScan([page])
    const long = report.issues.find((i) => i.code === 'long_title')
    expect(long).toBeDefined()
    expect(long?.severity).toBe('warning')
  })

  it('title exactly at the TITLE_MIN boundary (10 chars) → no issue', () => {
    const page = goodPage('https://shop.test/a', 'A'.repeat(10))
    const report = analyseScan([page])
    expect(report.issues.find((i) => i.code === 'short_title')).toBeUndefined()
  })

  it('title exactly at TITLE_MAX boundary (70 chars) → no issue', () => {
    const page = goodPage('https://shop.test/a', 'A'.repeat(70))
    const report = analyseScan([page])
    expect(report.issues.find((i) => i.code === 'long_title')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// analyseScan — meta description issues
// ---------------------------------------------------------------------------

describe('analyseScan — meta description', () => {
  it('missing meta description → warning', () => {
    const body = `<title>Decent Page Title</title>
<link rel="canonical" href="https://shop.test/a"><h1>Hi</h1>`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    const missing = report.issues.find(
      (i) => i.code === 'missing_meta_description',
    )
    expect(missing).toBeDefined()
    expect(missing?.severity).toBe('warning')
  })

  it('short meta description → info', () => {
    const body = `<title>Decent Page Title</title>
<meta name="description" content="Too short">
<link rel="canonical" href="https://shop.test/a"><h1>Hi</h1>`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    const short = report.issues.find(
      (i) => i.code === 'short_meta_description',
    )
    expect(short).toBeDefined()
    expect(short?.severity).toBe('info')
  })

  it('long meta description → info', () => {
    const desc = 'x'.repeat(200)
    const body = `<title>Decent Page Title</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="https://shop.test/a"><h1>Hi</h1>`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    const long = report.issues.find(
      (i) => i.code === 'long_meta_description',
    )
    expect(long).toBeDefined()
    expect(long?.severity).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// analyseScan — H1 issues
// ---------------------------------------------------------------------------

describe('analyseScan — H1', () => {
  it('missing H1 → warning', () => {
    const body = `<title>Decent Page Title</title>
<meta name="description" content="This description is long enough to satisfy the scanner rules and cross 50 chars.">
<link rel="canonical" href="https://shop.test/a">`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    const missing = report.issues.find((i) => i.code === 'missing_h1')
    expect(missing).toBeDefined()
    expect(missing?.severity).toBe('warning')
  })

  it('multiple H1 → info', () => {
    const body = `<title>Decent Page Title</title>
<meta name="description" content="This description is long enough to satisfy the scanner rules and cross 50 chars.">
<link rel="canonical" href="https://shop.test/a">
<h1>First</h1><h1>Second</h1>`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    const multi = report.issues.find((i) => i.code === 'multiple_h1')
    expect(multi).toBeDefined()
    expect(multi?.severity).toBe('info')
    expect(multi?.message).toContain('2')
  })
})

// ---------------------------------------------------------------------------
// analyseScan — canonical & image alt
// ---------------------------------------------------------------------------

describe('analyseScan — canonical and image alt', () => {
  it('missing canonical → warning', () => {
    const body = `<title>Decent Page Title</title>
<meta name="description" content="This description is long enough to satisfy the scanner rules and cross 50 chars.">
<h1>Hi</h1>`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    const missing = report.issues.find((i) => i.code === 'missing_canonical')
    expect(missing).toBeDefined()
    expect(missing?.severity).toBe('warning')
  })

  it('images without alt → info, count in message (plural)', () => {
    const body = `<title>Decent Page Title</title>
<meta name="description" content="This description is long enough to satisfy the scanner rules and cross 50 chars.">
<link rel="canonical" href="https://shop.test/a">
<h1>Hi</h1>
<img src="x.png">
<img src="y.png" alt="">`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    const issue = report.issues.find((i) => i.code === 'missing_image_alt')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('info')
    expect(issue?.message).toContain('2 images')
  })

  it('images without alt (single) → singular message', () => {
    const body = `<title>Decent Page Title</title>
<meta name="description" content="This description is long enough to satisfy the scanner rules and cross 50 chars.">
<link rel="canonical" href="https://shop.test/a">
<h1>Hi</h1>
<img src="x.png">`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    const issue = report.issues.find((i) => i.code === 'missing_image_alt')
    expect(issue?.message).toContain('1 image ')
  })
})

// ---------------------------------------------------------------------------
// analyseScan — duplicate titles
// ---------------------------------------------------------------------------

describe('analyseScan — duplicate titles', () => {
  it('flags every offender when two pages share a title', () => {
    const pages = [
      goodPage('https://shop.test/a', 'Same Title Here'),
      goodPage('https://shop.test/b', 'Same Title Here'),
    ]
    const report = analyseScan(pages)
    const dupes = report.issues.filter((i) => i.code === 'duplicate_title')
    expect(dupes).toHaveLength(2)
    expect(dupes.map((d) => d.url).sort()).toEqual([
      'https://shop.test/a',
      'https://shop.test/b',
    ])
    expect(dupes[0]?.severity).toBe('warning')
  })

  it('does not flag unique titles', () => {
    const pages = [
      goodPage('https://shop.test/a', 'Alpha Title Text'),
      goodPage('https://shop.test/b', 'Beta Title Text'),
    ]
    const report = analyseScan(pages)
    expect(
      report.issues.filter((i) => i.code === 'duplicate_title'),
    ).toHaveLength(0)
  })

  it('reports the correct "other N pages" count for triplicates', () => {
    const pages = [
      goodPage('https://shop.test/a', 'Triplicate Title'),
      goodPage('https://shop.test/b', 'Triplicate Title'),
      goodPage('https://shop.test/c', 'Triplicate Title'),
    ]
    const report = analyseScan(pages)
    const dupes = report.issues.filter((i) => i.code === 'duplicate_title')
    expect(dupes).toHaveLength(3)
    expect(dupes[0]?.message).toContain('2 other pages')
  })
})

// ---------------------------------------------------------------------------
// Score heuristic
// ---------------------------------------------------------------------------

describe('analyseScan — score', () => {
  it('100 for a clean scan', () => {
    const report = analyseScan([goodPage('https://shop.test/a')])
    expect(report.score).toBe(100)
  })

  it('subtracts 8 per error (two 404s → 84)', () => {
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 404, body: 'x' },
      { url: 'https://shop.test/b', status: 404, body: 'x' },
    ])
    expect(report.score).toBe(84)
  })

  it('subtracts 3 per warning (single missing_canonical → 97)', () => {
    const body = `<title>Decent Page Title</title>
<meta name="description" content="This description is long enough to satisfy the scanner rules and cross 50 chars.">
<h1>Hi</h1>
<img src="x.png" alt="good">`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 200, body },
    ])
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]?.severity).toBe('warning')
    expect(report.score).toBe(97)
  })

  it('floors at 0 for many errors', () => {
    const pages: ScanPageInput[] = []
    for (let i = 0; i < 20; i++) {
      pages.push({
        url: `https://shop.test/${i}`,
        status: 500,
        body: 'err',
      })
    }
    const report = analyseScan(pages)
    expect(report.score).toBe(0)
  })

  it('combines severities correctly (1 error + 1 warning + 1 info = 100 - 12 = 88)', () => {
    // Page 1: 404 → 1 error (-8)
    // Page 2: missing canonical → 1 warning (-3)
    //         missing image alt → 1 info (-1)
    const cleanishBody = `<title>Decent Page Title</title>
<meta name="description" content="This description is long enough to satisfy the scanner rules and cross 50 chars.">
<h1>Hi</h1>
<img src="x.png">`
    const report = analyseScan([
      { url: 'https://shop.test/a', status: 404, body: 'x' },
      { url: 'https://shop.test/b', status: 200, body: cleanishBody },
    ])
    expect(report.score).toBe(88)
  })
})

// ---------------------------------------------------------------------------
// scanShop — IO boundary
// ---------------------------------------------------------------------------

describe('scanShop', () => {
  it('caps URL fetches at maxUrls', async () => {
    const fetcher: SeoFetcher = vi.fn(async (url) => ({
      status: 200,
      body: goodPage(url).body,
    }))
    const urls: string[] = []
    for (let i = 0; i < 10; i++) urls.push(`https://shop.test/${i}`)
    await scanShop({ urls, fetcher, maxUrls: 3 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('defaults cap to 50 when maxUrls is unset', async () => {
    const fetcher: SeoFetcher = vi.fn(async (url) => ({
      status: 200,
      body: goodPage(url).body,
    }))
    const urls: string[] = []
    for (let i = 0; i < 80; i++) urls.push(`https://shop.test/${i}`)
    await scanShop({ urls, fetcher })
    expect(fetcher).toHaveBeenCalledTimes(50)
  })

  it('calls the fetcher serially in URL order', async () => {
    const seen: string[] = []
    const fetcher: SeoFetcher = async (url) => {
      seen.push(url)
      return { status: 200, body: goodPage(url).body }
    }
    await scanShop({
      urls: ['https://shop.test/a', 'https://shop.test/b', 'https://shop.test/c'],
      fetcher,
    })
    expect(seen).toEqual([
      'https://shop.test/a',
      'https://shop.test/b',
      'https://shop.test/c',
    ])
  })

  it('converts a fetcher rejection into a fetch_failed issue', async () => {
    const fetcher: SeoFetcher = async (url) => {
      if (url.endsWith('/bad')) throw new Error('boom')
      return { status: 200, body: goodPage(url).body }
    }
    const report = await scanShop({
      urls: ['https://shop.test/good', 'https://shop.test/bad'],
      fetcher,
    })
    const bad = report.issues.find((i) => i.url === 'https://shop.test/bad')
    expect(bad?.code).toBe('fetch_failed')
  })

  it('returns a complete report even when every fetch fails', async () => {
    const fetcher: SeoFetcher = async () => {
      throw new Error('network down')
    }
    const report = await scanShop({
      urls: ['https://shop.test/a', 'https://shop.test/b'],
      fetcher,
    })
    expect(report.pages_scanned).toBe(2)
    expect(report.issues).toHaveLength(2)
    expect(report.issues.every((i) => i.code === 'fetch_failed')).toBe(true)
  })

  it('propagates the fetcher FetchResult into the analyser verbatim', async () => {
    const fetcher: SeoFetcher = async () => ({ status: 500, body: 'ise' })
    const report = await scanShop({
      urls: ['https://shop.test/a'],
      fetcher,
    })
    expect(report.issues[0]?.code).toBe('http_5xx')
  })
})
