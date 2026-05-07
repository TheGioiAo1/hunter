/**
 * Store-admin — SEO settings handlers (Phase 8 PR3d)
 *
 * Covers the HTTP surface of:
 *   • getSeoSettings renders form with current values (GA ID + twitter handle)
 *   • getSeoSettings empty-state scan card when no report stored
 *   • getSeoSettings full report card (score + issue groups by severity)
 *   • postSeoSettings parses form → setShopSettings → redirect ok
 *   • postSeoSettings noindex checkbox parsed correctly (on + off)
 *   • postSeoSettings empty-string inputs → null in persisted settings
 *   • postSeoSettings exception → iron rule 5 message, no internals leaked
 *   • postSeoScan no primary domain → "Please set a primary domain first"
 *     (iron rule 5 — no path, no feature name, no god-admin)
 *   • postSeoScan happy: scanShop + recordScanReport both called, redirect
 *     includes score + issue count
 *   • postSeoScan exception → iron rule 5 "contact Gbox support" with zero
 *     leak of internal error/module names
 *   • Iron rule 5 audit regex across every response body
 *
 * Service layers (@gbox/core/modules/seo/seo-settings.js and
 * @gbox/core/modules/seo/scan.js) are fully mocked so we test ONLY the
 * handler's behaviour, not the services (those have their own unit tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks (MUST come before SUT import) -----------------------------------

vi.mock('@gbox/core/modules/seo/seo-settings.js', async () => {
  const actual = await vi.importActual<
    typeof import('@gbox/core/modules/seo/seo-settings.js')
  >('@gbox/core/modules/seo/seo-settings.js')
  return {
    // Keep the real defaults so the page renders against the canonical
    // SeoSettings shape — tests don't need to duplicate the constant.
    DEFAULT_SEO_SETTINGS: actual.DEFAULT_SEO_SETTINGS,
    resolveSettings: vi.fn(),
    setShopSettings: vi.fn(),
    recordScanReport: vi.fn(),
  }
})

vi.mock('@gbox/core/modules/seo/scan.js', () => ({
  scanShop: vi.fn(),
  defaultSeoFetcher: vi.fn(),
}))

vi.mock('@gbox/core/modules/auth/csrf.js', () => ({
  csrfHiddenField: vi.fn(() => '<input type="hidden" name="_csrf" value="mock" />'),
}))

vi.mock('../middleware/store-auth.js', () => ({
  logSellerAction: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: (u: any) => (u?.name ? `By ${u.name}` : ''),
}))

vi.mock('../layouts/seller-layout.js', () => ({
  sellerLayout: vi.fn((opts: any) => `<html><title>${opts.title}</title>${opts.content}</html>`),
  esc: (s: unknown) => String(s ?? ''),
}))

import type { Request, Response } from 'express'
import {
  recordScanReport,
  resolveSettings,
  setShopSettings,
  DEFAULT_SEO_SETTINGS,
  type SeoScanReport,
  type SeoSettings,
} from '@gbox/core/modules/seo/seo-settings.js'
import { scanShop } from '@gbox/core/modules/seo/scan.js'
import {
  getSeoSettings,
  postSeoSettings,
  postSeoScan,
} from './seo-settings.js'

// --- Fixtures --------------------------------------------------------------

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_SLUG = 'test-shop'
const USER_ID = '66666666-6666-6666-6666-666666666666'

function makeReq(
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): Request {
  return {
    body,
    query,
    params: { slug: SHOP_SLUG },
    store: { id: SHOP_ID, slug: SHOP_SLUG, name: 'Test Shop' },
    storeUser: {
      id: USER_ID,
      name: 'Thai Admin',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    csrfToken: 'mock-token',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request
}

function makeRes() {
  const redirect = vi.fn()
  const status = vi.fn().mockReturnThis()
  const send = vi.fn()
  return { redirect, status, send } as unknown as Response & {
    redirect: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
  }
}

/**
 * Minimal DB harness — scripts by the first table name in the SELECT.
 * buildScanUrls reads shops, products, collections; everything else
 * resolves to null / [].
 */
function makeDb(scripts: Record<string, any> = {}) {
  const chainable = (result: any): any => {
    const h: any = {}
    const methods = [
      'selectFrom',
      'select',
      'selectAll',
      'where',
      'leftJoin',
      'innerJoin',
      'limit',
      'orderBy',
      'groupBy',
      'offset',
    ]
    for (const m of methods) h[m] = vi.fn().mockReturnValue(h)
    h.execute = vi.fn().mockResolvedValue(Array.isArray(result) ? result : [result])
    h.executeTakeFirst = vi
      .fn()
      .mockResolvedValue(Array.isArray(result) ? (result[0] ?? null) : result)
    h.executeTakeFirstOrThrow = vi.fn().mockResolvedValue(
      Array.isArray(result) ? (result[0] ?? {}) : (result ?? {}),
    )
    return h
  }
  return {
    selectFrom: vi.fn((name: string) => {
      const base = String(name).split(' ')[0]!
      return chainable(scripts[base] ?? null)
    }),
    updateTable: vi.fn().mockReturnValue(chainable(null)),
    insertInto: vi.fn().mockReturnValue(chainable(null)),
    deleteFrom: vi.fn().mockReturnValue(chainable(null)),
    fn: { count: () => ({ as: () => ({}) }) },
  } as any
}

function populatedSettings(overrides: Partial<SeoSettings> = {}): SeoSettings {
  return {
    ...DEFAULT_SEO_SETTINGS,
    default_title_template: '{page_title} – {shop_name}',
    default_description: 'A store that sells quality products.',
    twitter_handle: '@ourshop',
    google_analytics_id: 'G-ABCDEFGHIJ',
    ...overrides,
  }
}

function sampleReport(): SeoScanReport {
  return {
    pages_scanned: 5,
    score: 72,
    issues: [
      {
        url: 'https://shop.test/products/missing-title',
        severity: 'error',
        code: 'missing_title',
        message: 'Page has no <title> tag.',
      },
      {
        url: 'https://shop.test/',
        severity: 'warning',
        code: 'missing_canonical',
        message: 'Page has no canonical link tag.',
      },
      {
        url: 'https://shop.test/collections/all',
        severity: 'info',
        code: 'missing_image_alt',
        message: '3 images without alt text.',
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// GET /marketing/seo/settings
// ---------------------------------------------------------------------------

describe('getSeoSettings', () => {
  it('renders the form with current field values', async () => {
    vi.mocked(resolveSettings).mockResolvedValue(populatedSettings())

    const req = makeReq()
    const res = makeRes()
    await getSeoSettings(req, res, makeDb())

    expect(res.send).toHaveBeenCalledTimes(1)
    const html = String(res.send.mock.calls[0]![0])
    expect(html).toContain('SEO settings')
    expect(html).toContain('value="G-ABCDEFGHIJ"')
    expect(html).toContain('value="@ourshop"')
    // textarea content, not an attribute
    expect(html).toContain('A store that sells quality products.')
  })

  it('renders the noindex toggle as checked when robots_noindex is true', async () => {
    vi.mocked(resolveSettings).mockResolvedValue(
      populatedSettings({ robots_noindex: true }),
    )
    const req = makeReq()
    const res = makeRes()
    await getSeoSettings(req, res, makeDb())
    const html = String(res.send.mock.calls[0]![0])
    expect(html).toContain('name="robots_noindex" value="1" checked')
  })

  it('renders the empty-state scan card when no report is stored', async () => {
    vi.mocked(resolveSettings).mockResolvedValue(DEFAULT_SEO_SETTINGS)
    const req = makeReq()
    const res = makeRes()
    await getSeoSettings(req, res, makeDb())
    const html = String(res.send.mock.calls[0]![0])
    expect(html).toContain('No scan has been run yet')
  })

  it('renders a full report card with score + issues grouped by severity', async () => {
    vi.mocked(resolveSettings).mockResolvedValue(
      populatedSettings({
        last_scan_at: '2026-04-21T12:00:00Z',
        last_scan_report: sampleReport(),
      }),
    )
    const req = makeReq()
    const res = makeRes()
    await getSeoSettings(req, res, makeDb())
    const html = String(res.send.mock.calls[0]![0])
    expect(html).toContain('SEO score')
    expect(html).toContain('>72<')
    expect(html).toContain('Errors (1)')
    expect(html).toContain('Warnings (1)')
    expect(html).toContain('Info (1)')
    // NOTE: the `esc` layout helper is mocked to a pass-through in this
    // test file, so the rendered message arrives unescaped. Production
    // renders `&lt;title&gt;` — the real esc is covered elsewhere.
    expect(html).toContain('Page has no <title> tag.')
  })

  it('surfaces ?ok= and ?err= flash messages', async () => {
    vi.mocked(resolveSettings).mockResolvedValue(DEFAULT_SEO_SETTINGS)
    const req = makeReq({}, { ok: encodeURIComponent('Saved.') })
    const res = makeRes()
    await getSeoSettings(req, res, makeDb())
    expect(String(res.send.mock.calls[0]![0])).toContain('Saved.')
  })
})

// ---------------------------------------------------------------------------
// POST /marketing/seo/settings
// ---------------------------------------------------------------------------

describe('postSeoSettings', () => {
  it('parses the form, calls setShopSettings, and redirects with ok', async () => {
    vi.mocked(setShopSettings).mockResolvedValue(populatedSettings())
    const req = makeReq({
      default_title_template: '{page_title} – {shop_name}',
      default_description: 'Quality goods.',
      default_og_image_url: 'https://cdn.example.com/og.jpg',
      twitter_handle: '@ourshop',
      facebook_url: 'https://facebook.com/ourshop',
      google_analytics_id: 'G-ABCDEFGHIJ',
      google_tag_manager_id: 'GTM-AABBCC',
      google_site_verification: 'verify-token-123_xyz',
      robots_noindex: '1',
    })
    const res = makeRes()
    await postSeoSettings(req, res, makeDb())

    expect(setShopSettings).toHaveBeenCalledTimes(1)
    const written = vi.mocked(setShopSettings).mock.calls[0]![2]
    expect(written.robots_noindex).toBe(true)
    expect(written.google_analytics_id).toBe('G-ABCDEFGHIJ')
    expect(written.google_tag_manager_id).toBe('GTM-AABBCC')
    expect(written.twitter_handle).toBe('@ourshop')
    // last_scan_* passed as null so service preserves current stored values.
    expect(written.last_scan_at).toBeNull()
    expect(written.last_scan_report).toBeNull()
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('/marketing/seo/settings?ok='),
    )
  })

  it('converts empty-string inputs to null', async () => {
    vi.mocked(setShopSettings).mockResolvedValue(DEFAULT_SEO_SETTINGS)
    const req = makeReq({
      default_title_template: '',
      default_description: '   ',
      twitter_handle: '',
      google_analytics_id: '',
      google_tag_manager_id: '',
      google_site_verification: '',
    })
    const res = makeRes()
    await postSeoSettings(req, res, makeDb())
    const written = vi.mocked(setShopSettings).mock.calls[0]![2]
    expect(written.default_title_template).toBeNull()
    expect(written.default_description).toBeNull()
    expect(written.twitter_handle).toBeNull()
    expect(written.google_analytics_id).toBeNull()
    expect(written.google_tag_manager_id).toBeNull()
    expect(written.google_site_verification).toBeNull()
  })

  it('robots_noindex defaults to false when the checkbox is unchecked', async () => {
    vi.mocked(setShopSettings).mockResolvedValue(DEFAULT_SEO_SETTINGS)
    const req = makeReq({
      // no robots_noindex key — HTML checkboxes omit the key when unchecked
      default_title_template: 'x',
    })
    const res = makeRes()
    await postSeoSettings(req, res, makeDb())
    const written = vi.mocked(setShopSettings).mock.calls[0]![2]
    expect(written.robots_noindex).toBe(false)
  })

  it('on exception: iron rule 5 message (contact Gbox support), no internal leak', async () => {
    vi.mocked(setShopSettings).mockRejectedValue(new Error('schema gone'))
    const req = makeReq({ default_title_template: 'x' })
    const res = makeRes()
    await postSeoSettings(req, res, makeDb())
    const redirectUrl = String(vi.mocked(res.redirect).mock.calls[0]![0])
    expect(redirectUrl).toContain('err=')
    expect(redirectUrl).toContain('contact%20Gbox%20support')
    // Must NOT leak the underlying error or module internals.
    expect(redirectUrl).not.toContain('schema')
    expect(redirectUrl).not.toContain('setShopSettings')
    expect(redirectUrl.toLowerCase()).not.toContain('god-admin')
    expect(redirectUrl.toLowerCase()).not.toContain('god_admin')
  })
})

// ---------------------------------------------------------------------------
// POST /marketing/seo/scan
// ---------------------------------------------------------------------------

describe('postSeoScan', () => {
  it('no primary domain → friendly message (iron rule 5)', async () => {
    // db returns a shop row with primary_domain=null.
    const db = makeDb({ shops: { primary_domain: null } })
    const req = makeReq()
    const res = makeRes()
    await postSeoScan(req, res, db)

    expect(scanShop).not.toHaveBeenCalled()
    expect(recordScanReport).not.toHaveBeenCalled()
    const redirectUrl = String(vi.mocked(res.redirect).mock.calls[0]![0])
    expect(redirectUrl).toContain('err=')
    expect(redirectUrl).toContain('primary%20domain')
    // Iron rule 5 — no internal paths, feature names, or god-admin ref.
    expect(redirectUrl.toLowerCase()).not.toContain('god-admin')
    expect(redirectUrl.toLowerCase()).not.toContain('god_admin')
    expect(redirectUrl).not.toContain('domains.ts')
  })

  it('happy path: calls scanShop + recordScanReport, redirects with score', async () => {
    const db = makeDb({
      shops: { primary_domain: 'example.com' },
      products: [{ slug: 'alpha' }, { slug: 'beta' }],
      collections: [{ slug: 'featured' }],
    })
    const report = sampleReport()
    vi.mocked(scanShop).mockResolvedValue(report)
    vi.mocked(recordScanReport).mockResolvedValue(populatedSettings())

    const req = makeReq()
    const res = makeRes()
    await postSeoScan(req, res, db)

    expect(scanShop).toHaveBeenCalledTimes(1)
    const scanCall = vi.mocked(scanShop).mock.calls[0]![0]
    expect(scanCall.urls).toContain('https://example.com/')
    expect(scanCall.urls.some((u) => u.includes('/products/alpha'))).toBe(true)
    expect(scanCall.urls.some((u) => u.includes('/collections/featured'))).toBe(true)
    expect(scanCall.maxUrls).toBe(30)

    expect(recordScanReport).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordScanReport).mock.calls[0]![2]).toBe(report)

    const redirectUrl = String(vi.mocked(res.redirect).mock.calls[0]![0])
    expect(redirectUrl).toContain('ok=')
    expect(redirectUrl).toContain('72') // score in message
  })

  it('on exception: iron rule 5 contact-support message', async () => {
    const db = makeDb({
      shops: { primary_domain: 'example.com' },
      products: [],
      collections: [],
    })
    vi.mocked(scanShop).mockRejectedValue(new Error('timed out'))

    const req = makeReq()
    const res = makeRes()
    await postSeoScan(req, res, db)

    expect(recordScanReport).not.toHaveBeenCalled()
    const redirectUrl = String(vi.mocked(res.redirect).mock.calls[0]![0])
    expect(redirectUrl).toContain('err=')
    expect(redirectUrl).toContain('contact%20Gbox%20support')
    expect(redirectUrl).not.toContain('timed')
    expect(redirectUrl.toLowerCase()).not.toContain('god-admin')
    expect(redirectUrl.toLowerCase()).not.toContain('god_admin')
  })
})

// ---------------------------------------------------------------------------
// Iron rule 5 blanket audit — scan every rendered response for leaks.
// ---------------------------------------------------------------------------

describe('iron rule 5 — seller-facing surfaces contain no god-admin refs', () => {
  const forbidden = /god[\s_-]?admin|\/god-admin\/|god_admin_/i

  it('getSeoSettings full-dress render contains zero forbidden strings', async () => {
    vi.mocked(resolveSettings).mockResolvedValue(
      populatedSettings({
        last_scan_at: '2026-04-21T12:00:00Z',
        last_scan_report: sampleReport(),
      }),
    )
    const req = makeReq()
    const res = makeRes()
    await getSeoSettings(req, res, makeDb())
    const html = String(res.send.mock.calls[0]![0])
    expect(forbidden.test(html)).toBe(false)
  })

  it('postSeoSettings error redirect contains zero forbidden strings', async () => {
    vi.mocked(setShopSettings).mockRejectedValue(new Error('kaboom'))
    const req = makeReq({ default_title_template: 'x' })
    const res = makeRes()
    await postSeoSettings(req, res, makeDb())
    const redirectUrl = String(vi.mocked(res.redirect).mock.calls[0]![0])
    expect(forbidden.test(redirectUrl)).toBe(false)
  })

  it('postSeoScan missing-domain redirect contains zero forbidden strings', async () => {
    const db = makeDb({ shops: { primary_domain: null } })
    const req = makeReq()
    const res = makeRes()
    await postSeoScan(req, res, db)
    const redirectUrl = String(vi.mocked(res.redirect).mock.calls[0]![0])
    expect(forbidden.test(redirectUrl)).toBe(false)
  })
})
