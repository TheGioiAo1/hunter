/**
 * Unit tests for `getThemeEditorSearch` — the theme-editor file-finder
 * endpoint (Ctrl+Shift+F). The service-layer behaviour of
 * `searchThemeAssets` is exercised in
 * `packages/core/src/modules/themes/service.test.ts`; here we only
 * verify the handler's tenancy guard and its end-to-end wiring to the
 * service (query-string parsing, error mapping, JSON shape).
 *
 * The tenancy guard is the one piece that MUST have coverage — without
 * it a seller could poke another shop's theme id and the search would
 * cheerfully return that shop's file keys. Everything else is plumbing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@gbox/core/modules/themes/service.js', () => ({
  getTheme: vi.fn(),
  listThemeAssets: vi.fn(),
  getThemeAsset: vi.fn(),
  updateThemeAsset: vi.fn(),
  deleteThemeAsset: vi.fn(),
  setActiveTheme: vi.fn(),
  duplicateTheme: vi.fn(),
  searchThemeAssets: vi.fn(),
}))
vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: vi.fn(() => 'By test'),
}))
vi.mock('../layouts/seller-layout.js', () => ({
  sellerLayout: vi.fn((opts: any) => `<layout>${opts.content}</layout>`),
  esc: (s: string) => String(s ?? ''),
}))

import {
  getTheme,
  searchThemeAssets,
} from '@gbox/core/modules/themes/service.js'
import { getThemeEditorSearch } from './theme-editor.js'

// ---------------------------------------------------------------------
// Request / Response test doubles
// ---------------------------------------------------------------------

function makeReq(opts: {
  shopId?: string
  themeId?: string
  q?: string
  mode?: string
  ext?: string | null
  limit?: string
} = {}) {
  return {
    store: {
      id: opts.shopId ?? 'shop-1',
      slug: 'my-store',
      name: 'My Store',
    },
    storeUser: {
      id: 'user-1',
      name: 'Thai',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    params: { themeId: opts.themeId ?? 'theme-1' },
    query: {
      ...(opts.q !== undefined ? { q: opts.q } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(opts.ext !== undefined && opts.ext !== null ? { ext: opts.ext } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    },
    body: {},
    headers: {},
  } as any
}

function makeRes() {
  const res: any = { _body: null, _statusCode: 200 }
  res.status = vi.fn().mockImplementation((n: number) => {
    res._statusCode = n
    return res
  })
  res.json = vi.fn().mockImplementation((b: any) => {
    res._body = b
    return res
  })
  res.send = vi.fn().mockImplementation((b: any) => {
    res._body = b
    return res
  })
  return res
}

const db = {} as any

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------
// Tenancy guard — the whole point of the handler
// ---------------------------------------------------------------------

describe('getThemeEditorSearch — tenancy guard', () => {
  it('returns 404 when the theme id does not exist', async () => {
    ;(getTheme as any).mockResolvedValue(null)
    const req = makeReq({ q: 'product' })
    const res = makeRes()

    await getThemeEditorSearch(req, res, db)

    expect(res._statusCode).toBe(404)
    expect(res._body).toEqual({ error: 'theme_not_found' })
    // Service must NOT be invoked — the guard fires first.
    expect(searchThemeAssets).not.toHaveBeenCalled()
  })

  it('returns 404 when the theme belongs to a different shop', async () => {
    ;(getTheme as any).mockResolvedValue({
      id: 'theme-1',
      shop_id: 'someone-elses-shop',
      name: 'Other',
      role: 'main',
    })
    const req = makeReq({ shopId: 'shop-1', q: 'product' })
    const res = makeRes()

    await getThemeEditorSearch(req, res, db)

    // Cross-tenant defense: the seller could have guessed the theme id
    // but they still can't see the file keys.
    expect(res._statusCode).toBe(404)
    expect(res._body).toEqual({ error: 'theme_not_found' })
    expect(searchThemeAssets).not.toHaveBeenCalled()
  })

  it('delegates to searchThemeAssets when the theme belongs to this shop', async () => {
    ;(getTheme as any).mockResolvedValue({
      id: 'theme-1',
      shop_id: 'shop-1',
      name: 'Main',
      role: 'main',
    })
    ;(searchThemeAssets as any).mockResolvedValue([
      {
        key: 'templates/product.liquid',
        snippet: '<h1>Product</h1>',
        lineNumber: 1,
        matchType: 'both',
      },
    ])
    const req = makeReq({ shopId: 'shop-1', q: 'product' })
    const res = makeRes()

    await getThemeEditorSearch(req, res, db)

    expect(res._statusCode).toBe(200)
    expect(res._body.hits).toHaveLength(1)
    expect(res._body.hits[0].key).toBe('templates/product.liquid')
  })
})

// ---------------------------------------------------------------------
// Query-string parsing
// ---------------------------------------------------------------------

describe('getThemeEditorSearch — query parsing', () => {
  beforeEach(() => {
    ;(getTheme as any).mockResolvedValue({
      id: 'theme-1',
      shop_id: 'shop-1',
      name: 'Main',
      role: 'main',
    })
    ;(searchThemeAssets as any).mockResolvedValue([])
  })

  it('defaults mode to "both" when absent or invalid', async () => {
    const req = makeReq({ q: 'foo' }) // no mode
    await getThemeEditorSearch(req, makeRes(), db)
    expect(searchThemeAssets).toHaveBeenLastCalledWith(
      db,
      'theme-1',
      'foo',
      expect.objectContaining({ mode: 'both' }),
    )

    vi.clearAllMocks()
    ;(getTheme as any).mockResolvedValue({
      id: 'theme-1',
      shop_id: 'shop-1',
      name: 'Main',
      role: 'main',
    })
    ;(searchThemeAssets as any).mockResolvedValue([])

    const req2 = makeReq({ q: 'foo', mode: 'garbage' })
    await getThemeEditorSearch(req2, makeRes(), db)
    expect(searchThemeAssets).toHaveBeenLastCalledWith(
      db,
      'theme-1',
      'foo',
      expect.objectContaining({ mode: 'both' }),
    )
  })

  it('respects mode=filename and mode=content', async () => {
    const req = makeReq({ q: 'foo', mode: 'filename' })
    await getThemeEditorSearch(req, makeRes(), db)
    expect(searchThemeAssets).toHaveBeenLastCalledWith(
      db,
      'theme-1',
      'foo',
      expect.objectContaining({ mode: 'filename' }),
    )

    const req2 = makeReq({ q: 'foo', mode: 'content' })
    await getThemeEditorSearch(req2, makeRes(), db)
    expect(searchThemeAssets).toHaveBeenLastCalledWith(
      db,
      'theme-1',
      'foo',
      expect.objectContaining({ mode: 'content' }),
    )
  })

  it('passes ext and limit through', async () => {
    const req = makeReq({
      q: 'foo',
      ext: '.liquid',
      limit: '25',
    })
    await getThemeEditorSearch(req, makeRes(), db)
    expect(searchThemeAssets).toHaveBeenLastCalledWith(
      db,
      'theme-1',
      'foo',
      expect.objectContaining({ ext: '.liquid', limit: 25 }),
    )
  })

  it('falls back to limit=50 when the client sends a non-numeric limit', async () => {
    const req = makeReq({ q: 'foo', limit: 'not-a-number' })
    await getThemeEditorSearch(req, makeRes(), db)
    expect(searchThemeAssets).toHaveBeenLastCalledWith(
      db,
      'theme-1',
      'foo',
      expect.objectContaining({ limit: 50 }),
    )
  })
})

// ---------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------

describe('getThemeEditorSearch — error mapping', () => {
  it('returns 500 when the service throws', async () => {
    ;(getTheme as any).mockResolvedValue({
      id: 'theme-1',
      shop_id: 'shop-1',
      name: 'Main',
      role: 'main',
    })
    ;(searchThemeAssets as any).mockRejectedValue(new Error('boom'))

    const req = makeReq({ q: 'foo' })
    const res = makeRes()
    await getThemeEditorSearch(req, res, db)

    expect(res._statusCode).toBe(500)
    expect(res._body.error).toBe('boom')
  })

  it('returns 500 with a generic message when the error has no message', async () => {
    ;(getTheme as any).mockRejectedValue({ notAnError: true })

    const req = makeReq({ q: 'foo' })
    const res = makeRes()
    await getThemeEditorSearch(req, res, db)

    expect(res._statusCode).toBe(500)
    expect(res._body.error).toBe('search_failed')
  })
})
