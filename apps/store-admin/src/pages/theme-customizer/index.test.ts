/**
 * Theme Customizer route handlers — unit tests
 *
 * Coverage:
 *   1. sanitizeTemplate whitelist
 *   2. getThemeCustomizer redirects when theme cross-shop
 *   3. getThemeCustomizer renders shell HTML when authorized
 *   4. getSectionsJson returns 404 when cross-shop
 *   5. getSectionsJson returns sections array on success
 *   6. getPreviewUrl returns 404 when cross-shop
 *   7. getPreviewUrl returns URL with theme query param
 *   8. getPreviewUrl falls back to <slug>.gbox.co when no domain
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getThemeCustomizer,
  getSectionsJson,
  getPreviewUrl,
  __test,
} from './index.js'

const { sanitizeTemplate } = __test

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@gbox/core/modules/themes/service.js', () => ({
  getTheme: vi.fn(),
}))
vi.mock('@gbox/core/modules/themes/customizer/sections-tree.js', () => ({
  loadSectionsTree: vi.fn(),
}))
vi.mock('@gbox/core/modules/support/safe-message.js', () => ({
  safeMessage: (e: Error) => ({ safe: 'Please contact Gbox support.' }),
}))

import { getTheme } from '@gbox/core/modules/themes/service.js'
import { loadSectionsTree } from '@gbox/core/modules/themes/customizer/sections-tree.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: any = {}) {
  return {
    store: { id: 'shop-A', slug: 'best-store', name: 'Best Store', domain: null },
    storeUser: {
      id: 'user-1',
      name: 'Lam Diep',
      email: 'lamdiepanh1903@gmail.com',
      role: 'staff',
      storeRole: 'owner',
    },
    params: { slug: 'best-store', themeId: 'theme-1', ...overrides.params },
    query: overrides.query ?? {},
    headers: overrides.headers ?? {},
    csrfToken: 'csrf-tok',
    ...overrides,
  } as any
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    redirected: undefined as string | undefined,
    status(code: number) { this.statusCode = code; return this },
    json(payload: any) { this.body = payload; return this },
    send(payload: any) { this.body = payload; return this },
    setHeader(k: string, v: string) { this.headers[k] = v; return this },
    redirect(url: string) { this.redirected = url; return this },
  }
  return res
}

beforeEach(() => {
  vi.mocked(getTheme).mockReset()
  vi.mocked(loadSectionsTree).mockReset()
})

// ---------------------------------------------------------------------------
// sanitizeTemplate
// ---------------------------------------------------------------------------

describe('sanitizeTemplate', () => {
  it('passes through canonical template names', () => {
    expect(sanitizeTemplate('index')).toBe('index')
    expect(sanitizeTemplate('product')).toBe('product')
    expect(sanitizeTemplate('customers/login')).toBe('customers/login')
  })

  it('rejects path-traversal attempts', () => {
    expect(sanitizeTemplate('../../etc/passwd')).toBe('index')
    expect(sanitizeTemplate('index.json')).toBe('index') // dot rejected
  })

  it('rejects non-strings + empty', () => {
    expect(sanitizeTemplate(null)).toBe('index')
    expect(sanitizeTemplate(123)).toBe('index')
    expect(sanitizeTemplate('')).toBe('index')
  })

  it('rejects overly long values', () => {
    expect(sanitizeTemplate('x'.repeat(100))).toBe('index')
  })
})

// ---------------------------------------------------------------------------
// getThemeCustomizer
// ---------------------------------------------------------------------------

describe('getThemeCustomizer', () => {
  it('redirects when theme is missing', async () => {
    vi.mocked(getTheme).mockResolvedValue(null as any)
    const req = makeReq()
    const res = makeRes()
    await getThemeCustomizer(req, res, {} as any)
    expect(res.redirected).toBe('/admin/store/best-store/online-store/themes')
  })

  it('redirects when theme belongs to another shop', async () => {
    vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-B', name: 'Other', role: 'main' } as any)
    const req = makeReq()
    const res = makeRes()
    await getThemeCustomizer(req, res, {} as any)
    expect(res.redirected).toBe('/admin/store/best-store/online-store/themes')
  })

  it('renders HTML shell when authorized', async () => {
    vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-A', name: 'Dawn', role: 'main' } as any)
    const req = makeReq()
    const res = makeRes()
    await getThemeCustomizer(req, res, {} as any)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toContain('text/html')
    expect(typeof res.body).toBe('string')
    expect(res.body).toContain('class="tc-app"')
    expect(res.body).toContain('data-theme-id="theme-1"')
    expect(res.body).toContain('Dawn')
  })

  it('wraps DB errors via safeMessage', async () => {
    vi.mocked(getTheme).mockRejectedValue(new Error('postgres exploded — secret leaked: foo'))
    const req = makeReq()
    const res = makeRes()
    await getThemeCustomizer(req, res, {} as any)
    expect(res.statusCode).toBe(500)
    expect(res.body).toBe('Please contact Gbox support.')
    expect(res.body).not.toContain('postgres')
    expect(res.body).not.toContain('secret')
  })
})

// ---------------------------------------------------------------------------
// getSectionsJson
// ---------------------------------------------------------------------------

describe('getSectionsJson', () => {
  it('returns 404 on cross-shop probe', async () => {
    vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-B', name: 'X', role: 'main' } as any)
    const req = makeReq()
    const res = makeRes()
    await getSectionsJson(req, res, {} as any)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('returns sections + template on success', async () => {
    vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-A', name: 'X', role: 'main' } as any)
    vi.mocked(loadSectionsTree).mockResolvedValue([
      { id: 's1', key: 'hero', type: 'hero', name: 'Hero', icon: 'box', position: 0, enabled: true, hasBlocks: false, blockCount: 0 },
    ])
    const req = makeReq({ query: { template: 'index' } })
    const res = makeRes()
    await getSectionsJson(req, res, {} as any)
    expect(res.body.template).toBe('index')
    expect(res.body.sections).toHaveLength(1)
    expect(res.body.sections[0].name).toBe('Hero')
  })

  it('sanitizes malicious template query', async () => {
    vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-A', name: 'X', role: 'main' } as any)
    vi.mocked(loadSectionsTree).mockResolvedValue([])
    const req = makeReq({ query: { template: '../../etc/passwd' } })
    const res = makeRes()
    await getSectionsJson(req, res, {} as any)
    expect(res.body.template).toBe('index') // sanitized
    expect(loadSectionsTree).toHaveBeenCalledWith({}, 'theme-1', 'index')
  })
})

// ---------------------------------------------------------------------------
// getPreviewUrl
// ---------------------------------------------------------------------------

describe('getPreviewUrl', () => {
  it('returns 404 on cross-shop probe', async () => {
    vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-B', name: 'X', role: 'main' } as any)
    const req = makeReq()
    const res = makeRes()
    await getPreviewUrl(req, res, {} as any)
    expect(res.statusCode).toBe(404)
  })

  it('returns URL with theme_id query for index template', async () => {
    vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-A', name: 'X', role: 'main' } as any)
    const req = makeReq()
    const res = makeRes()
    await getPreviewUrl(req, res, {} as any)
    expect(res.body.url).toBe('https://best-store.gbox.co/?_gbox_preview_theme=theme-1')
    expect(res.body.template).toBe('index')
  })

  it('uses shop.domain when present', async () => {
    vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-A', name: 'X', role: 'main' } as any)
    const req = makeReq({ store: { id: 'shop-A', slug: 'best-store', name: 'Best', domain: 'shop.example.com' } })
    const res = makeRes()
    await getPreviewUrl(req, res, {} as any)
    expect(res.body.url).toBe('https://shop.example.com/?_gbox_preview_theme=theme-1')
  })

  it('respects non-index templates in URL path', async () => {
    vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-A', name: 'X', role: 'main' } as any)
    const req = makeReq({ query: { template: 'product' } })
    const res = makeRes()
    await getPreviewUrl(req, res, {} as any)
    expect(res.body.url).toContain('/product?_gbox_preview_theme=theme-1')
  })

  it('mints signed HMAC token when THEME_PREVIEW_SECRET is set', async () => {
    const prev = process.env.THEME_PREVIEW_SECRET
    process.env.THEME_PREVIEW_SECRET = 'test-secret-32chars-min-aaaaaaaa'
    try {
      vi.mocked(getTheme).mockResolvedValue({ id: 'theme-1', shop_id: 'shop-A', name: 'X', role: 'main' } as any)
      const req = makeReq()
      const res = makeRes()
      await getPreviewUrl(req, res, {} as any)
      expect(res.body.url).toMatch(/preview_theme_id=theme-1/)
      expect(res.body.url).toMatch(/preview_token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
      expect(res.body.url).not.toContain('_gbox_preview_theme=')
    } finally {
      if (prev === undefined) delete process.env.THEME_PREVIEW_SECRET
      else process.env.THEME_PREVIEW_SECRET = prev
    }
  })
})
