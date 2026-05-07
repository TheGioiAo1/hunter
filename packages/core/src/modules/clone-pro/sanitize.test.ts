/**
 * Phase 7 Step 7.4 — content sanitization unit tests.
 *
 * The runner writes cloned HTML + CSS into our own DB, and our
 * storefront renders it. Without sanitization, a malicious source
 * site could plant `<script>`, `<iframe>`, `onclick=`, `javascript:`
 * hrefs, or `@import url(evil.com)` — and our theme would dutifully
 * serve all of it back to end-shoppers.
 *
 * What this suite pins (per spec §3.4 + §6):
 *   - `sanitizeClonedHtml` strips: <script>, <iframe>, <object>,
 *     <embed>, <form>, event handlers (onclick/onload/onerror/…),
 *     `javascript:` hrefs, `data:` image srcs.
 *   - `sanitizeClonedHtml` keeps: structural (h1-h6, p, ul, ol, li,
 *     table, div, span), inline formatting (strong/em/b/i/u/s),
 *     anchors with safe schemes, images with http(s) srcs.
 *   - `sanitizeClonedCss` drops `@import` from non-allowlisted hosts
 *     and keeps allowlisted (fonts.googleapis.com, fonts.gstatic.com,
 *     cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com).
 *   - `isSafeImageUrl` returns false for data:/javascript:/file:/
 *     anything non-http(s).
 *
 * These tests exercise the public API only — internals of
 * sanitize-html are not mocked.
 */

import { describe, it, expect } from 'vitest'

import {
  sanitizeClonedHtml,
  sanitizeClonedCss,
  isSafeImageUrl,
  ALLOWED_CSS_IMPORT_HOSTS,
} from './sanitize.js'

describe('Phase 7.4 — sanitizeClonedHtml', () => {
  it('strips <script> tags entirely (content + tag)', () => {
    const out = sanitizeClonedHtml(
      '<p>Safe</p><script>alert("xss")</script><p>Also safe</p>',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert("xss")')
    expect(out).toContain('<p>Safe</p>')
    expect(out).toContain('<p>Also safe</p>')
  })

  it('strips <iframe> tags', () => {
    const out = sanitizeClonedHtml(
      '<p>hi</p><iframe src="https://evil.com"></iframe>',
    )
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('evil.com')
  })

  it('strips <object>, <embed>, and <form> tags', () => {
    const out = sanitizeClonedHtml(
      '<object data="x.swf"></object><embed src="y.swf"/><form action="/p"><input/></form>',
    )
    expect(out).not.toContain('<object')
    expect(out).not.toContain('<embed')
    expect(out).not.toContain('<form')
  })

  it('strips inline event handlers (onclick, onload, onerror, onmouseover, …)', () => {
    const out = sanitizeClonedHtml(
      '<div onclick="hack()" onload="hack2()">text</div><img src="https://x.com/a.png" onerror="hack3()"/><button onmouseover="hack4()">go</button>',
    )
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onload')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('onmouseover')
    expect(out).not.toContain('hack')
  })

  it('strips javascript: URLs on anchors', () => {
    const out = sanitizeClonedHtml(
      '<a href="javascript:alert(1)">click</a><a href="https://ok.com">ok</a>',
    )
    expect(out).not.toContain('javascript:')
    // The safe anchor survives.
    expect(out).toContain('https://ok.com')
  })

  it('strips data: URLs on <img> src (only http(s) allowed for images)', () => {
    const out = sanitizeClonedHtml(
      '<img src="data:image/png;base64,iVBORw0KGgoA"/>' +
        '<img src="https://cdn.example.com/p.jpg"/>',
    )
    expect(out).not.toContain('data:image')
    expect(out).toContain('https://cdn.example.com/p.jpg')
  })

  it('strips file: scheme across every element', () => {
    const out = sanitizeClonedHtml(
      '<a href="file:///etc/passwd">leak</a><img src="file:///etc/passwd"/>',
    )
    expect(out).not.toContain('file:')
  })

  it('keeps mailto: links (allowed scheme for anchors)', () => {
    const out = sanitizeClonedHtml('<a href="mailto:hello@example.com">email</a>')
    expect(out).toContain('mailto:hello@example.com')
  })

  it('keeps structural tags (h1-h6, p, ul/ol/li, table, div, span)', () => {
    const input =
      '<h1>a</h1><h2>b</h2><p>c</p><ul><li>d</li></ul><ol><li>e</li></ol><table><tr><td>f</td></tr></table><div><span>g</span></div>'
    const out = sanitizeClonedHtml(input)
    // Every structural tag should still be present.
    for (const tag of ['h1', 'h2', 'p', 'ul', 'li', 'ol', 'table', 'tr', 'td', 'div', 'span']) {
      expect(out).toMatch(new RegExp(`<${tag}[ >]`))
    }
  })

  it('keeps inline formatting (strong/em/b/i/u/s) and code blocks', () => {
    const out = sanitizeClonedHtml(
      '<p><strong>bold</strong> <em>em</em> <b>b</b> <i>i</i> <u>u</u> <s>s</s> <code>c</code> <pre>p</pre></p>',
    )
    for (const tag of ['strong', 'em', 'b', 'i', 'u', 's', 'code', 'pre']) {
      expect(out).toMatch(new RegExp(`<${tag}[ >]`))
    }
  })

  it('keeps allowed image attributes (alt, title, width, height, loading)', () => {
    const out = sanitizeClonedHtml(
      '<img src="https://c.com/a.png" alt="hi" title="t" width="100" height="50" loading="lazy"/>',
    )
    expect(out).toContain('alt="hi"')
    expect(out).toContain('width="100"')
    expect(out).toContain('loading="lazy"')
  })

  it('keeps class/id/style on all elements (theme hooks)', () => {
    const out = sanitizeClonedHtml(
      '<div class="hero" id="top" style="color:red">x</div>',
    )
    expect(out).toContain('class="hero"')
    expect(out).toContain('id="top"')
    // sanitize-html normalises style values; just assert presence.
    expect(out).toMatch(/style="[^"]*red/)
  })

  it('returns empty string for null/undefined-ish input without throwing', () => {
    // The runner may pass scraper output that turned out blank; we
    // don't want a TypeError to abort a stage.
    expect(sanitizeClonedHtml('')).toBe('')
    expect(sanitizeClonedHtml(null as unknown as string)).toBe('')
    expect(sanitizeClonedHtml(undefined as unknown as string)).toBe('')
  })
})

describe('Phase 7.4 — sanitizeClonedCss', () => {
  it('drops @import from hosts not on the allowlist', () => {
    const css = `
      @import url("https://malicious.example.com/x.css");
      @import url('https://another-bad.com/y.css');
      body { color: red; }
    `
    const out = sanitizeClonedCss(css)
    expect(out).not.toContain('malicious.example.com')
    expect(out).not.toContain('another-bad.com')
    // Non-import content survives.
    expect(out).toContain('body')
    expect(out).toContain('color: red')
  })

  it('keeps @import from fonts.googleapis.com', () => {
    const css = `@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");`
    const out = sanitizeClonedCss(css)
    expect(out).toContain('fonts.googleapis.com')
  })

  it('keeps @import from every ALLOWED_CSS_IMPORT_HOSTS entry', () => {
    // Drift alarm: if someone removes a host from the allowlist,
    // corresponding @import fixtures should stop being preserved.
    for (const host of ALLOWED_CSS_IMPORT_HOSTS) {
      const css = `@import url("https://${host}/pkg.css");`
      const out = sanitizeClonedCss(css)
      expect(out, `expected ${host} to be allowlisted`).toContain(host)
    }
  })

  it('handles @import url(...) without quotes and with single quotes', () => {
    const css = `
      @import url(https://cdn.jsdelivr.net/a.css);
      @import url('https://fonts.gstatic.com/b.css');
      @import url("https://malicious.example.com/c.css");
    `
    const out = sanitizeClonedCss(css)
    expect(out).toContain('cdn.jsdelivr.net')
    expect(out).toContain('fonts.gstatic.com')
    expect(out).not.toContain('malicious.example.com')
  })

  it('drops @import url("data:...") entirely (no scheme smuggling)', () => {
    const css = `@import url("data:text/css;base64,Ym9keXtjb2xvcjpyZWR9");`
    const out = sanitizeClonedCss(css)
    expect(out).not.toContain('data:text/css')
  })

  it('drops @import url("javascript:...") entirely', () => {
    const css = `@import url("javascript:alert(1)");`
    const out = sanitizeClonedCss(css)
    expect(out).not.toContain('javascript:')
  })

  it('strips `expression(...)` (legacy IE CSS JS injection)', () => {
    // IE-only XSS vector that some scrapers inadvertently preserve.
    // We strip it defensively.
    const css = `body { width: expression(alert(1)); color: red; }`
    const out = sanitizeClonedCss(css)
    expect(out.toLowerCase()).not.toContain('expression(')
  })

  it('returns empty string for null/undefined/empty input', () => {
    expect(sanitizeClonedCss('')).toBe('')
    expect(sanitizeClonedCss(null as unknown as string)).toBe('')
    expect(sanitizeClonedCss(undefined as unknown as string)).toBe('')
  })
})

describe('Phase 7.4 — isSafeImageUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isSafeImageUrl('http://example.com/a.png')).toBe(true)
    expect(isSafeImageUrl('https://example.com/a.png')).toBe(true)
  })

  it('rejects data: URLs', () => {
    expect(
      isSafeImageUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg'),
    ).toBe(false)
  })

  it('rejects javascript: URLs', () => {
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects file: URLs', () => {
    expect(isSafeImageUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects non-URL garbage', () => {
    expect(isSafeImageUrl('not a url')).toBe(false)
    expect(isSafeImageUrl('')).toBe(false)
    expect(isSafeImageUrl(null as unknown as string)).toBe(false)
    expect(isSafeImageUrl(undefined as unknown as string)).toBe(false)
  })

  it('accepts protocol-relative URLs and scheme-less paths as "unknown" (rejects)', () => {
    // `//cdn.com/a.png` is ambiguous without a base. We reject —
    // the crawler knows the base URL and should resolve before
    // calling us.
    expect(isSafeImageUrl('//cdn.com/a.png')).toBe(false)
    expect(isSafeImageUrl('/relative/path.png')).toBe(false)
  })
})
