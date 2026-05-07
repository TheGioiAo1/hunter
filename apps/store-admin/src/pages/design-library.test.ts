/**
 * Store-admin — Design Library smoke tests (Phase D4)
 *
 * Two surfaces worth locking:
 *
 *   1. `renderMarkdown` — the inline MD → HTML renderer is security-
 *      sensitive (we accept DESIGN.md body from seed mirror + clone
 *      pipeline and inject it into the page as `innerHTML`). Tests
 *      cover happy-path shape AND a handful of XSS vectors so a
 *      future refactor can't regress the escape pass.
 *
 *   2. `postDeleteDesignLibraryEntry` — owner-role gate, 404 on stale
 *      card, 302 on happy path. The delete is a permanent write so
 *      these branches matter more than the read surface.
 *
 * The main GET page handler is NOT covered here — it calls
 * `sellerLayout` (heavy: nav, CSS, assets) and would need a large
 * amount of stubbing for marginal value. It's exercised by manual QA +
 * existing integration layer. The bug-prone bits (markdown escape,
 * delete authz) are isolated and tested below.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// renderMarkdown — pure function, no mocks needed
// ---------------------------------------------------------------------------

import { renderMarkdown } from './design-library.js'

describe('renderMarkdown', () => {
  it('renders H1 / H2 / H3 with the expected dl-h* classes', () => {
    const html = renderMarkdown('# Title\n\n## Section\n\n### Sub')
    expect(html).toContain('<h1 class="dl-h1">Title</h1>')
    expect(html).toContain('<h2 class="dl-h2">Section</h2>')
    expect(html).toContain('<h3 class="dl-h3">Sub</h3>')
  })

  it('renders a dash-bullet list as <ul class="dl-list">', () => {
    const html = renderMarkdown('- Apples\n- Oranges\n- Pears')
    expect(html).toContain('<ul class="dl-list">')
    expect(html).toContain('<li>Apples</li>')
    expect(html).toContain('<li>Oranges</li>')
    expect(html).toContain('<li>Pears</li>')
  })

  it('wraps inline code in <code class="dl-inline-code">', () => {
    const html = renderMarkdown('Use `npm install` to start.')
    expect(html).toContain('<code class="dl-inline-code">npm install</code>')
  })

  it('renders fenced code blocks as <pre class="dl-code">', () => {
    const md = '```js\nconst x = 1\n```'
    const html = renderMarkdown(md)
    expect(html).toContain('<pre class="dl-code">')
    expect(html).toContain('const x = 1')
  })

  it('renders **bold** as <strong>', () => {
    const html = renderMarkdown('This is **important** text.')
    expect(html).toContain('<strong>important</strong>')
  })

  it('allows http(s) links but strips javascript: URIs', () => {
    const safe = renderMarkdown('See [docs](https://example.com).')
    expect(safe).toContain('<a href="https://example.com"')
    expect(safe).toContain('target="_blank"')
    expect(safe).toContain('rel="noopener noreferrer"')

    const xss = renderMarkdown('Click [me](javascript:alert(1)) now.')
    expect(xss).not.toContain('javascript:')
    expect(xss).not.toContain('<a href')
    // The visible text survives so the paragraph still reads.
    expect(xss).toContain('me')
  })

  it('escapes raw HTML in the input (no injection)', () => {
    const html = renderMarkdown('Hello <script>alert("x")</script> world')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes HTML inside fenced code blocks', () => {
    const html = renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('prepends a colour swatch span before hex codes in <code>', () => {
    // This is the palette prettifier — #FF5A5F inside a code tag gets
    // a coloured dot so the palette section reads as chips, not text.
    const html = renderMarkdown('Primary: `#FF5A5F`')
    expect(html).toContain('<span class="dl-swatch" style="background:#FF5A5F"></span>')
    expect(html).toContain('#FF5A5F</code>')
  })

  it('wraps plain text in <p class="dl-p">', () => {
    const html = renderMarkdown('Just a sentence.')
    expect(html).toContain('<p class="dl-p">Just a sentence.</p>')
  })

  it('preserves paragraph breaks on blank lines', () => {
    const html = renderMarkdown('First para.\n\nSecond para.')
    expect(html).toContain('<p class="dl-p">First para.</p>')
    expect(html).toContain('<p class="dl-p">Second para.</p>')
  })

  it('renders a full DESIGN.md spec without throwing', () => {
    // Snapshot-ish: a realistic seed body from our serializer. Just
    // assert the rendering completes and the major sections survive.
    const md = `# Airbnb

A modern design cloned from airbnb.com.

## 1. Visual Theme

- Primary: \`#FF5A5F\`
- Secondary: \`#00A699\`

## 2. Typography

\`\`\`
Heading: Circular
Body: Inter
\`\`\`

## 5. Sections Detected

- header
- hero
`
    const html = renderMarkdown(md)
    expect(html).toContain('<h1 class="dl-h1">Airbnb</h1>')
    expect(html).toContain('<h2 class="dl-h2">1. Visual Theme</h2>')
    expect(html).toContain('<h2 class="dl-h2">5. Sections Detected</h2>')
    expect(html).toContain('<ul class="dl-list">')
    expect(html).toContain('<pre class="dl-code">')
    expect(html).toContain('dl-swatch')
  })
})

// ---------------------------------------------------------------------------
// postDeleteDesignLibraryEntry — action handler
// ---------------------------------------------------------------------------
//
// The handler imports `deleteCloneEntry` from the design-library module.
// We mock that boundary so the test is a pure unit — no DB, no module
// internals.

vi.mock('@gbox/core/modules/design-library/index.js', () => ({
  deleteCloneEntry: vi.fn(),
}))
const { deleteCloneEntry } = await import('@gbox/core/modules/design-library/index.js')
const { postDeleteDesignLibraryEntry } = await import('./design-library/actions.js')

function makeReq(opts: { entrySlug?: string; storeRole?: string } = {}) {
  return {
    store: { id: 'shop-42', slug: 'acme', name: 'Acme' },
    storeUser: {
      id: 'user-1',
      name: 'Thai',
      email: 'thai@example.com',
      role: 'store_owner',
      storeRole: opts.storeRole ?? 'owner',
    },
    params: { entrySlug: opts.entrySlug ?? 'airbnb-com-abcd1234' },
    body: {},
    headers: {},
  } as any
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined, redirectLocation: null }
  res.status = vi.fn().mockImplementation((n: number) => {
    res.statusCode = n
    return res
  })
  res.redirect = vi.fn().mockImplementation((code: number | string, loc?: string) => {
    if (typeof code === 'number') {
      res.statusCode = code
      res.redirectLocation = loc
    } else {
      res.statusCode = 302
      res.redirectLocation = code
    }
    return res
  })
  res.json = vi.fn().mockImplementation((o: unknown) => {
    res.body = o
    return res
  })
  res.send = vi.fn().mockImplementation((o: unknown) => {
    res.body = o
    return res
  })
  return res
}

beforeEach(() => {
  vi.mocked(deleteCloneEntry).mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('postDeleteDesignLibraryEntry', () => {
  it('400s when entrySlug is empty', async () => {
    const req = makeReq({ entrySlug: '' })
    const res = makeRes()
    await postDeleteDesignLibraryEntry(req, res, {} as any)
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(deleteCloneEntry)).not.toHaveBeenCalled()
  })

  it('403s when caller is not the store owner (admin/staff)', async () => {
    const req = makeReq({ storeRole: 'admin' })
    const res = makeRes()
    await postDeleteDesignLibraryEntry(req, res, {} as any)
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ error: 'owner_required' })
    expect(vi.mocked(deleteCloneEntry)).not.toHaveBeenCalled()
  })

  it('404s when deleteCloneEntry reports no row matched', async () => {
    vi.mocked(deleteCloneEntry).mockResolvedValue(false)
    const req = makeReq()
    const res = makeRes()
    await postDeleteDesignLibraryEntry(req, res, {} as any)
    expect(res.statusCode).toBe(404)
    expect(vi.mocked(deleteCloneEntry)).toHaveBeenCalledWith(expect.anything(), {
      shopId: 'shop-42',
      slug: 'airbnb-com-abcd1234',
    })
  })

  it('302 redirects to /design-library?tab=my-clones on success', async () => {
    vi.mocked(deleteCloneEntry).mockResolvedValue(true)
    const req = makeReq()
    const res = makeRes()
    await postDeleteDesignLibraryEntry(req, res, {} as any)
    expect(res.statusCode).toBe(302)
    expect(String(res.redirectLocation)).toContain('/admin/store/acme/design-library?tab=my-clones')
    expect(String(res.redirectLocation)).toContain('toast=deleted')
  })

  it('scopes the delete to the current shop (defence in depth)', async () => {
    // A stale card pointing at a slug from a DIFFERENT shop would
    // still reach this handler because the URL slug is attacker-
    // controlled. The handler must scope the delete to req.store.id
    // so a malicious form can't wipe another shop's row.
    vi.mocked(deleteCloneEntry).mockResolvedValue(false)
    const req = makeReq({ entrySlug: 'other-shop-slug' })
    req.store.id = 'shop-42'
    const res = makeRes()
    await postDeleteDesignLibraryEntry(req, res, {} as any)
    // The delete helper was passed THIS shop's id — not something
    // pulled from the body. A future refactor that accepts a shopId
    // from the request would trip this test.
    const firstCall = vi.mocked(deleteCloneEntry).mock.calls[0]
    expect(firstCall?.[1]).toMatchObject({ shopId: 'shop-42', slug: 'other-shop-slug' })
  })

  it('500s when deleteCloneEntry throws unexpectedly', async () => {
    vi.mocked(deleteCloneEntry).mockRejectedValue(new Error('db exploded'))
    const req = makeReq()
    const res = makeRes()
    await postDeleteDesignLibraryEntry(req, res, {} as any)
    expect(res.statusCode).toBe(500)
  })
})
